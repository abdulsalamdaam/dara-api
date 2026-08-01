import { Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, asc, desc, eq, isNull, or, ilike, count } from "drizzle-orm";
import { maintenanceRequestsTable, contractsTable, contractUnitsTable, unitsTable, propertiesTable, tenantsTable } from "@dara/database";
import { listQuerySchema } from "../../common/pagination";
import { notifyTenant } from "../../common/notify";
import { DRIZZLE, type Drizzle } from "../../database/database.module";

const MAINTENANCE_STATUS_AR: Record<string, string> = {
  open: "جديد",
  in_progress: "قيد التنفيذ",
  pending_approval: "قيد التنفيذ",
  completed: "مكتمل",
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

  @Get()
  @RequirePermissions(PERMISSIONS.MAINTENANCE_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const usePaginated = rawQuery && (rawQuery.page != null || rawQuery.pageSize != null || rawQuery.search != null);
    const q = listQuerySchema.parse(rawQuery ?? {});
    const baseWhere = and(eq(maintenanceRequestsTable.userId, scopeId(user)), isNull(maintenanceRequestsTable.deletedAt));
    const where = q.search ? and(baseWhere, or(
      ilike(maintenanceRequestsTable.unitLabel, `%${q.search}%`),
      ilike(maintenanceRequestsTable.description, `%${q.search}%`),
      ilike(maintenanceRequestsTable.supplier, `%${q.search}%`),
    )) : baseWhere;

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
      .orderBy((q.order === "asc" ? asc : desc)(maintenanceRequestsTable.createdAt))
      .$dynamic();
    if (usePaginated) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow] = await Promise.all([
      rowsQ,
      usePaginated
        ? this.db.select({ total: count() }).from(maintenanceRequestsTable).where(where)
        : Promise.resolve([{ total: 0 }]),
    ]);
    if (!usePaginated) return rows;
    return { data: rows, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0) };
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
        const [t] = await this.db.select({ id: tenantsTable.id }).from(tenantsTable).where(eq(tenantsTable.phone, contract.tenantPhone));
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
          .select({ name: tenantsTable.name, phone: tenantsTable.phone, email: tenantsTable.email })
          .from(tenantsTable)
          .where(eq(tenantsTable.id, row.tenantId));
        tenantName = t?.name ?? null;
        tenantPhone = t?.phone ?? null;
        tenantEmail = t?.email ?? null;
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
    for (const f of FIELDS) if (body[f] !== undefined) updateData[f] = body[f];
    const [row] = await this.db.update(maintenanceRequestsTable).set(updateData)
      .where(and(eq(maintenanceRequestsTable.id, rid), eq(maintenanceRequestsTable.userId, scopeId(user)), isNull(maintenanceRequestsTable.deletedAt)))
      .returning();
    if (!row) throw new NotFoundException("الطلب غير موجود");

    if (previous && previous.status !== row.status) {
      void this.notifyTenantOfStatusChange(row, previous.status ?? null);
    }
    return row;
  }

  private async notifyTenantOfStatusChange(row: typeof maintenanceRequestsTable.$inferSelect, previousStatus: string | null) {
    try {
      if (!row.tenantId) return;
      // In-app notification + push to the tenant's device.
      const label = MAINTENANCE_STATUS_AR[row.status] ?? row.status;
      await notifyTenant(this.db, {
        userId: row.userId,
        tenantId: row.tenantId,
        title: "تحديث على طلب الصيانة",
        body: `تم تحديث حالة طلب الصيانة${row.unitLabel ? ` (${row.unitLabel})` : ""} إلى: ${label}`,
        type: "maintenance_status",
        data: { maintenanceId: row.id, status: row.status },
      });
      // Email (best-effort).
      const [tenant] = await this.db
        .select({ name: tenantsTable.name, email: tenantsTable.email })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, row.tenantId));
      if (tenant?.email) {
        await this.email.sendMaintenanceStatusChanged(tenant.email, {
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
