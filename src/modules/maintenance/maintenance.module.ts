import { Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, asc, desc, eq, gte, isNull, lte, or, ilike, count, inArray, sql } from "drizzle-orm";
import { maintenanceRequestsTable, contractsTable, contractUnitsTable, unitsTable, propertiesTable, tenantsTable } from "@dara/database";
import {
  idListSentEmpty, likeContains, listQuerySchema, parseDateBound, parseEnumList, parseIdList, wantsPagination,
} from "../../common/pagination";
import { notifyTenant } from "../../common/notify";
import { resolveTenantContact } from "../../common/party-contact";
import { TENANT_CONTACT_COLUMNS } from "../../common/party-contact.columns";
import { DRIZZLE, type Drizzle } from "../../database/database.module";

const MAINTENANCE_STATUS_AR: Record<string, string> = {
  open: "جديد",
  in_progress: "قيد التنفيذ",
  pending_approval: "قيد التنفيذ",
  completed: "مكتمل",
  cancelled: "ملغى",
};
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { EmailService } from "../email/email.service";

const FIELDS = ["unitLabel", "description", "priority", "status", "supplier", "estimatedCost", "tenantId", "contractId"] as const;

@ApiTags("maintenance")
@ApiBearerAuth("user-jwt")
@Controller("maintenance")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class MaintenanceController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly email: EmailService,
  ) {}

  /**
   * Maintenance tickets, paginated and filtered by the database.
   *
   * Query parameters, all applied in SQL: `search` (unit label / description /
   * supplier / tenant name), `status` (one or a comma-separated set),
   * `priority`, `tenantId`, `contractId`, and a `from`/`to` window on when the
   * ticket was raised.
   *
   * The board renders one column per status and requests each column with its
   * own `status=` - the column badge is that request's `total`. (A per-status
   * `stats.byStatus` used to ride along on every request; nothing read it, and
   * the board's three column requests paid for three group-bys.)
   */
  @Get()
  @RequirePermissions(PERMISSIONS.MAINTENANCE_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const usePaginated = wantsPagination(rawQuery, ["search"]);
    const q = listQuerySchema.parse(rawQuery ?? {});
    const conds: any[] = [
      eq(maintenanceRequestsTable.userId, scopeId(user)),
      isNull(maintenanceRequestsTable.deletedAt),
    ];
    if (q.search) {
      const like = likeContains(q.search);
      conds.push(or(
        ilike(maintenanceRequestsTable.unitLabel, like),
        ilike(maintenanceRequestsTable.description, like),
        ilike(maintenanceRequestsTable.supplier, like),
        ilike(tenantsTable.name, like),
      ));
    }
    const statuses = parseEnumList(rawQuery?.status, ["open", "in_progress", "pending_approval", "completed"] as const);
    const priorities = parseEnumList(rawQuery?.priority, ["low", "medium", "high"] as const);
    if (priorities) conds.push(inArray(maintenanceRequestsTable.priority, priorities));
    const tenantIds = parseIdList(rawQuery?.tenantId) ?? parseIdList(rawQuery?.tenantIds);
    if (tenantIds) conds.push(inArray(maintenanceRequestsTable.tenantId, tenantIds));
    const contractIds = parseIdList(rawQuery?.contractId) ?? parseIdList(rawQuery?.contractIds);
    if (contractIds) conds.push(inArray(maintenanceRequestsTable.contractId, contractIds));
    // Sent but no usable id (`contractIds=0` — "nothing matches") is no rows, not no filter.
    else if (idListSentEmpty(rawQuery?.contractId) || idListSentEmpty(rawQuery?.contractIds)) conds.push(sql`false`);
    const from = parseDateBound(rawQuery?.from);
    const to = parseDateBound(rawQuery?.to);
    if (from) conds.push(gte(maintenanceRequestsTable.createdAt, new Date(`${from}T00:00:00.000Z`)));
    // `to` is inclusive of the whole day, so a same-day window returns that day.
    if (to) conds.push(lte(maintenanceRequestsTable.createdAt, new Date(`${to}T23:59:59.999Z`)));
    if (statuses) conds.push(inArray(maintenanceRequestsTable.status, statuses));
    const where = and(...conds);

    // Return tickets owned by the landlord, joined with tenant and unit info
    // for richer display in the dashboard.
    let rowsQ = this.db
      .select({
        id: maintenanceRequestsTable.id,
        userId: maintenanceRequestsTable.userId,
        tenantId: maintenanceRequestsTable.tenantId,
        contractId: maintenanceRequestsTable.contractId,
        unitLabel: maintenanceRequestsTable.unitLabel,
        description: maintenanceRequestsTable.description,
        priority: maintenanceRequestsTable.priority,
        status: maintenanceRequestsTable.status,
        supplier: maintenanceRequestsTable.supplier,
        estimatedCost: maintenanceRequestsTable.estimatedCost,
        createdAt: maintenanceRequestsTable.createdAt,
        updatedAt: maintenanceRequestsTable.updatedAt,
        tenantName: tenantsTable.name,
        tenantPhone: tenantsTable.phone,
        contractNumber: contractsTable.contractNumber,
      })
      .from(maintenanceRequestsTable)
      .leftJoin(tenantsTable, eq(maintenanceRequestsTable.tenantId, tenantsTable.id))
      .leftJoin(contractsTable, eq(maintenanceRequestsTable.contractId, contractsTable.id))
      .where(where)
      // `id` tiebreak so a page boundary inside a batch of tickets raised in
      // the same instant cannot repeat one and drop another.
      .orderBy(
        (q.order === "asc" ? asc : desc)(maintenanceRequestsTable.createdAt),
        (q.order === "asc" ? asc : desc)(maintenanceRequestsTable.id),
      )
      .$dynamic();
    if (usePaginated) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow] = await Promise.all([
      rowsQ,
      // The count repeats the tenants join, because `search` reaches the
      // tenant name through it - counting the bare table would report a total
      // the filter never returns.
      usePaginated
        ? this.db.select({ total: count() }).from(maintenanceRequestsTable)
            .leftJoin(tenantsTable, eq(maintenanceRequestsTable.tenantId, tenantsTable.id))
            .where(where)
        : Promise.resolve([{ total: 0 }]),
    ]);
    if (!usePaginated) return rows;
    return {
      data: rows,
      page: q.page,
      pageSize: q.pageSize,
      total: Number(totalRow[0]?.total ?? 0),
    };
  }

  /**
   * Landlord creates a ticket. Either:
   *  • free-form `unitLabel` + `description` (legacy), OR
   *  • `tenantId` and/or `contractId` for proper linking. When `contractId` is
   *    supplied we auto-derive the unit label.
   */
  @Post()
  @RequirePermissions(PERMISSIONS.MAINTENANCE_WRITE)
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    if (!body.description) throw new BadRequestException("الوصف مطلوب");

    let unitLabel: string | null = body.unitLabel ?? null;
    let tenantId: number | null = body.tenantId ? Number(body.tenantId) : null;
    let contractId: number | null = body.contractId ? Number(body.contractId) : null;
    const ownerId = scopeId(user);

    // A tenant id from the body must be one of THIS account's tenants: the
    // row is linked to it, its name/phone are shown on the account's list, and
    // the create/status-change emails and pushes go to it.
    if (tenantId) await this.assertOwnTenant(ownerId, tenantId);

    if (contractId) {
      const [contract] = await this.db
        .select({
          id: contractsTable.id,
          userId: contractsTable.userId,
          tenantPhone: contractsTable.tenantPhone,
        })
        .from(contractsTable)
        .where(and(eq(contractsTable.id, contractId), eq(contractsTable.userId, ownerId)));

      if (!contract) throw new NotFoundException("العقد غير موجود");

      if (!unitLabel) {
        // The contract may cover several units — label with the property
        // name plus every unit number.
        const unitRows = await this.db
          .select({ unitNumber: unitsTable.unitNumber, propertyName: propertiesTable.name })
          .from(contractUnitsTable)
          .innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
          .leftJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
          .where(eq(contractUnitsTable.contractId, contract.id))
          .orderBy(contractUnitsTable.id);
        const unitNumbers = unitRows.map((u) => u.unitNumber).filter(Boolean).join("، ");
        const propertyName = unitRows[0]?.propertyName ?? null;
        unitLabel = propertyName && unitNumbers
          ? `${propertyName} — ${unitNumbers}`
          : (unitNumbers || `Unit (contract ${contract.id})`);
      }

      if (!tenantId && contract.tenantPhone) {
        // Scoped: a phone number is not unique across accounts, and the
        // unscoped lookup could link (and email) another account's tenant.
        const [t] = await this.db.select({ id: tenantsTable.id }).from(tenantsTable)
          .where(and(eq(tenantsTable.phone, contract.tenantPhone), eq(tenantsTable.userId, ownerId), isNull(tenantsTable.deletedAt)));
        if (t) tenantId = t.id;
      }
    }

    if (!unitLabel) throw new BadRequestException("الوحدة مطلوبة");

    const [row] = await this.db.insert(maintenanceRequestsTable).values({
      userId: ownerId,
      tenantId,
      contractId,
      unitLabel,
      description: body.description,
      priority: body.priority || "medium",
      status: body.status || "open",
      supplier: body.supplier ?? null,
      estimatedCost: body.estimatedCost ? String(body.estimatedCost) : null,
    }).returning();

    void this.notifyOnCreate(row!);

    return row;
  }

  /**
   * Fan out two emails after a ticket is created:
   *   - admin/landlord notification (always, to ADMIN_NOTIFY_EMAIL)
   *   - tenant acknowledgment ("we received your request") — only when the
   *     linked tenant has an email on file
   * Both are best-effort; one failing must not block the other.
   */
  private async notifyOnCreate(row: typeof maintenanceRequestsTable.$inferSelect) {
    try {
      let tenantName: string | null = null;
      let tenantPhone: string | null = null;
      let tenantEmail: string | null = null;
      let propertyName: string | null = null;
      if (row.tenantId) {
        const [t] = await this.db
          .select(TENANT_CONTACT_COLUMNS)
          .from(tenantsTable)
          .where(eq(tenantsTable.id, row.tenantId));
        tenantName = t?.name ?? null;
        tenantPhone = t?.phone ?? null;
        // The acknowledgment goes to the representative (وكيل) when there is
        // one with an email (common/party-contact); the admin email keeps the
        // tenant's own name and phone.
        tenantEmail = t ? resolveTenantContact(t).email.to : null;
      }
      if (row.contractId) {
        const [p] = await this.db
          .select({ propertyName: propertiesTable.name })
          .from(contractUnitsTable)
          .innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
          .leftJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
          .where(eq(contractUnitsTable.contractId, row.contractId))
          .orderBy(contractUnitsTable.id)
          .limit(1);
        propertyName = p?.propertyName ?? null;
      }
      const payload = {
        id: row.id,
        unitLabel: row.unitLabel,
        description: row.description,
        priority: row.priority,
        status: row.status,
        tenantName,
        tenantPhone,
        propertyName,
      };
      await Promise.allSettled([
        this.email.sendMaintenanceCreated(payload),
        tenantEmail ? this.email.sendMaintenanceAcknowledgment(tenantEmail, payload) : Promise.resolve(false),
      ]);
    } catch (err) {
      console.error("[maintenance] notifyOnCreate failed:", err);
    }
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.MAINTENANCE_WRITE)
  async update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    const rid = parseInt(id, 10);
    // Capture the prior status so we can detect a transition and only email
    // the tenant when the status actually changed (not on cosmetic edits
    // like description/supplier).
    const [previous] = await this.db
      .select({ status: maintenanceRequestsTable.status, tenantId: maintenanceRequestsTable.tenantId })
      .from(maintenanceRequestsTable)
      .where(and(eq(maintenanceRequestsTable.id, rid), eq(maintenanceRequestsTable.userId, scopeId(user)), isNull(maintenanceRequestsTable.deletedAt)));

    const updateData: Record<string, unknown> = {};
    for (const f of FIELDS) if (body?.[f] !== undefined) updateData[f] = body[f];
    // Nothing to write was a Drizzle "No values to set" — a 500.
    if (Object.keys(updateData).length === 0) throw new BadRequestException("لا توجد بيانات للتحديث · Nothing to update");
    // Re-linking must stay inside the account, exactly as on create.
    if (updateData.tenantId != null) await this.assertOwnTenant(scopeId(user), Number(updateData.tenantId));
    if (updateData.contractId != null) await this.assertOwnContract(scopeId(user), Number(updateData.contractId));
    const [row] = await this.db.update(maintenanceRequestsTable).set(updateData)
      .where(and(eq(maintenanceRequestsTable.id, rid), eq(maintenanceRequestsTable.userId, scopeId(user)), isNull(maintenanceRequestsTable.deletedAt)))
      .returning();
    if (!row) throw new NotFoundException("الطلب غير موجود");

    if (previous && previous.status !== row.status) {
      void this.notifyTenantOfStatusChange(row, previous.status ?? null);
    }
    return row;
  }

  private async assertOwnTenant(ownerId: number, tenantId: number): Promise<void> {
    if (!Number.isInteger(tenantId) || tenantId <= 0) throw new BadRequestException("tenantId غير صالح");
    const [t] = await this.db.select({ id: tenantsTable.id }).from(tenantsTable)
      .where(and(eq(tenantsTable.id, tenantId), eq(tenantsTable.userId, ownerId), isNull(tenantsTable.deletedAt)));
    if (!t) throw new NotFoundException("المستأجر غير موجود");
  }

  private async assertOwnContract(ownerId: number, contractId: number): Promise<void> {
    if (!Number.isInteger(contractId) || contractId <= 0) throw new BadRequestException("contractId غير صالح");
    const [c] = await this.db.select({ id: contractsTable.id }).from(contractsTable)
      .where(and(eq(contractsTable.id, contractId), eq(contractsTable.userId, ownerId), isNull(contractsTable.deletedAt)));
    if (!c) throw new NotFoundException("العقد غير موجود");
  }

  private async notifyTenantOfStatusChange(row: typeof maintenanceRequestsTable.$inferSelect, previousStatus: string | null) {
    try {
      if (!row.tenantId) return;
      // In-app notification + push to the tenant's device.
      const label = MAINTENANCE_STATUS_AR[row.status] ?? row.status;
      await notifyTenant(this.db, {
        userId: row.userId,
        tenantId: row.tenantId,
        title: row.status === "completed" ? "نبشرك، الصيانة اكتملت" : "تحديث على طلب الصيانة",
        body: `طلب الصيانة${row.unitLabel ? ` لـ ${row.unitLabel}` : ""} صار «${label}».`,
        type: "maintenance_status",
        data: { maintenanceId: row.id, status: row.status },
      });
      // Email (best-effort).
      const [tenant] = await this.db
        .select(TENANT_CONTACT_COLUMNS)
        .from(tenantsTable)
        .where(eq(tenantsTable.id, row.tenantId));
      // To the representative (وكيل) when there is one with an email (common/party-contact).
      const to = tenant ? resolveTenantContact(tenant).email.to : null;
      if (tenant && to) {
        await this.email.sendMaintenanceStatusChanged(to, {
          id: row.id,
          unitLabel: row.unitLabel,
          description: row.description,
          priority: row.priority,
          status: row.status,
          tenantName: tenant.name,
          previousStatus,
        });
      }
    } catch (err) {
      console.error("[maintenance] notifyTenantOfStatusChange failed:", err);
    }
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.MAINTENANCE_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const rid = parseInt(id, 10);
    await this.db.update(maintenanceRequestsTable).set({ deletedAt: new Date() } as any)
      .where(and(eq(maintenanceRequestsTable.id, rid), eq(maintenanceRequestsTable.userId, scopeId(user)), isNull(maintenanceRequestsTable.deletedAt)));
    return { ok: true };
  }
}

@Module({ controllers: [MaintenanceController] })
export class MaintenanceModule {}
