/// <reference types="multer" />
import {
  BadRequestException, Body, Controller, Get, Inject, Module, NotFoundException,
  Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags, ApiBearerAuth, ApiConsumes } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { and, desc, eq, inArray, isNull, ne, or, ilike, count } from "drizzle-orm";
import {
  paymentConfirmationsTable, paymentsTable, contractsTable, contractUnitsTable,
  tenantsTable, unitsTable, propertiesTable, notificationsTable, simpleInvoicesTable,
} from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { notifyTenant } from "../../common/notify";
import { TenantAuthGuard, type TenantPayload } from "../../common/guards/tenant-auth.guard";
import { CurrentTenant } from "../../common/decorators/current-tenant.decorator";
import { UploadsService } from "../uploads/uploads.service";

const METHODS = ["bank_transfer", "cash", "cheque", "other"] as const;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Next INV-###### number for an account (mirrors the billing module). */
async function nextInvoiceNumber(db: Drizzle, userId: number): Promise<string> {
  const [row] = await db.select({ c: count() }).from(simpleInvoicesTable)
    .where(and(eq(simpleInvoicesTable.userId, userId), eq(simpleInvoicesTable.type, "invoice")));
  return `INV-${String(Number(row?.c ?? 0) + 1).padStart(6, "0")}`;
}

/* ─────────────── Tenant side — submit & track ─────────────── */

@ApiTags("tenant-portal")
@ApiBearerAuth("tenant-jwt")
@Controller("tenant/me/payment-confirmations")
@UseGuards(TenantAuthGuard)
export class TenantPaymentConfirmationsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly uploads: UploadsService,
  ) {}

  /** Tenant lists their own payment-confirmation requests. */
  @Get()
  async list(@CurrentTenant() tenant: TenantPayload) {
    const rows = await this.db
      .select({
        id: paymentConfirmationsTable.id,
        paymentId: paymentConfirmationsTable.paymentId,
        contractId: paymentConfirmationsTable.contractId,
        amount: paymentConfirmationsTable.amount,
        method: paymentConfirmationsTable.method,
        reference: paymentConfirmationsTable.reference,
        note: paymentConfirmationsTable.note,
        proofName: paymentConfirmationsTable.proofName,
        status: paymentConfirmationsTable.status,
        reviewNote: paymentConfirmationsTable.reviewNote,
        reviewedAt: paymentConfirmationsTable.reviewedAt,
        createdAt: paymentConfirmationsTable.createdAt,
        dueDate: paymentsTable.dueDate,
        contractNumber: contractsTable.contractNumber,
      })
      .from(paymentConfirmationsTable)
      .leftJoin(paymentsTable, eq(paymentConfirmationsTable.paymentId, paymentsTable.id))
      .leftJoin(contractsTable, eq(paymentConfirmationsTable.contractId, contractsTable.id))
      .where(and(
        eq(paymentConfirmationsTable.tenantId, tenant.id),
        isNull(paymentConfirmationsTable.deletedAt),
      ))
      .orderBy(desc(paymentConfirmationsTable.createdAt));
    return rows;
  }

  /** Tenant submits "I paid this installment" with an optional proof file. */
  @Post()
  @Throttle({ default: { limit: 20, ttl: 3600_000 } })
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(FileInterceptor("proof"))
  async create(
    @CurrentTenant() tenant: TenantPayload,
    @Body() body: any,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const paymentId = parseInt(body?.paymentId, 10);
    if (!paymentId) throw new BadRequestException("رقم الدفعة مطلوب");

    const [t] = await this.db.select().from(tenantsTable).where(eq(tenantsTable.id, tenant.id));
    if (!t || !t.phone) throw new BadRequestException("رقم الجوال غير مسجّل");

    // The payment must belong to a contract leased to this tenant (phone match).
    const [payment] = await this.db
      .select({
        id: paymentsTable.id,
        amount: paymentsTable.amount,
        status: paymentsTable.status,
        userId: paymentsTable.userId,
        contractId: paymentsTable.contractId,
      })
      .from(paymentsTable)
      .innerJoin(contractsTable, eq(paymentsTable.contractId, contractsTable.id))
      .where(and(
        eq(paymentsTable.id, paymentId),
        eq(contractsTable.tenantPhone, t.phone),
        isNull(paymentsTable.deletedAt),
      ));
    if (!payment) throw new NotFoundException("الدفعة غير موجودة");
    if (payment.status === "paid") throw new BadRequestException("هذه الدفعة مسددة بالفعل");

    // Block a second request while one is still pending for the same payment.
    const [pending] = await this.db
      .select({ id: paymentConfirmationsTable.id })
      .from(paymentConfirmationsTable)
      .where(and(
        eq(paymentConfirmationsTable.paymentId, paymentId),
        eq(paymentConfirmationsTable.status, "pending"),
        isNull(paymentConfirmationsTable.deletedAt),
      ));
    if (pending) throw new BadRequestException("لديك طلب قيد المراجعة لهذه الدفعة");

    // Optional proof: PDF or image, max 25 MB (enforced by UploadsService).
    let proofKey: string | null = null;
    let proofName: string | null = null;
    if (file) {
      const okType = /^(application\/pdf|image\/(png|jpe?g|webp|heic))$/i.test(file.mimetype);
      if (!okType) throw new BadRequestException("المرفق يجب أن يكون PDF أو صورة");
      const result = await this.uploads.upload(file, { folder: `payment-confirmations/${payment.contractId}` });
      proofKey = result.key;
      proofName = file.originalname;
    }

    const method = METHODS.includes(body?.method) ? body.method : null;

    const [row] = await this.db.insert(paymentConfirmationsTable).values({
      userId: payment.userId,
      tenantId: tenant.id,
      paymentId: payment.id,
      contractId: payment.contractId,
      amount: payment.amount,
      method,
      reference: body?.reference?.toString().trim() || null,
      note: body?.note?.toString().trim() || null,
      proofKey,
      proofName,
      status: "pending",
    }).returning();

    return row;
  }
}

/* ─────────────── Landlord side — review ─────────────── */

@ApiTags("payment-confirmations")
@ApiBearerAuth("user-jwt")
@Controller("payment-confirmations")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PaymentConfirmationsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly uploads: UploadsService,
  ) {}

  /** Landlord lists incoming confirmation requests — paginated + searchable. */
  @Get()
  @RequirePermissions(PERMISSIONS.PAYMENTS_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const status: string | undefined =
      typeof rawQuery?.status === "string" && ["pending", "approved", "rejected"].includes(rawQuery.status)
        ? rawQuery.status : undefined;
    const search = typeof rawQuery?.search === "string" ? rawQuery.search.trim() : "";
    const page = Math.max(1, parseInt(rawQuery?.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(rawQuery?.pageSize, 10) || 10));
    const usePaginated = rawQuery && (rawQuery.page != null || rawQuery.pageSize != null || rawQuery.search != null || status != null);

    const baseWhere = and(
      eq(paymentConfirmationsTable.userId, scopeId(user)),
      isNull(paymentConfirmationsTable.deletedAt),
    );
    const conds = [baseWhere];
    if (status) conds.push(eq(paymentConfirmationsTable.status, status as any));
    if (search) {
      conds.push(or(
        ilike(tenantsTable.name, `%${search}%`),
        ilike(contractsTable.contractNumber, `%${search}%`),
      ));
    }
    const where = and(...conds);

    let rowsQ = this.db
      .select({
        id: paymentConfirmationsTable.id,
        paymentId: paymentConfirmationsTable.paymentId,
        contractId: paymentConfirmationsTable.contractId,
        amount: paymentConfirmationsTable.amount,
        method: paymentConfirmationsTable.method,
        reference: paymentConfirmationsTable.reference,
        note: paymentConfirmationsTable.note,
        proofKey: paymentConfirmationsTable.proofKey,
        proofName: paymentConfirmationsTable.proofName,
        status: paymentConfirmationsTable.status,
        reviewNote: paymentConfirmationsTable.reviewNote,
        reviewedAt: paymentConfirmationsTable.reviewedAt,
        createdAt: paymentConfirmationsTable.createdAt,
        dueDate: paymentsTable.dueDate,
        contractNumber: contractsTable.contractNumber,
        tenantName: tenantsTable.name,
        tenantPhone: tenantsTable.phone,
      })
      .from(paymentConfirmationsTable)
      .leftJoin(paymentsTable, eq(paymentConfirmationsTable.paymentId, paymentsTable.id))
      .leftJoin(contractsTable, eq(paymentConfirmationsTable.contractId, contractsTable.id))
      .leftJoin(tenantsTable, eq(paymentConfirmationsTable.tenantId, tenantsTable.id))
      .where(where)
      .orderBy(desc(paymentConfirmationsTable.createdAt))
      .$dynamic();
    if (usePaginated) rowsQ = rowsQ.limit(pageSize).offset((page - 1) * pageSize);

    const [rows, totalRow, statsRows] = await Promise.all([
      rowsQ,
      usePaginated ? this.db.select({ total: count() })
        .from(paymentConfirmationsTable)
        .leftJoin(contractsTable, eq(paymentConfirmationsTable.contractId, contractsTable.id))
        .leftJoin(tenantsTable, eq(paymentConfirmationsTable.tenantId, tenantsTable.id))
        .where(where) : Promise.resolve([{ total: 0 }]),
      // Per-status counts across all the landlord's requests (for the cards).
      usePaginated ? this.db.select({ status: paymentConfirmationsTable.status, cnt: count() })
        .from(paymentConfirmationsTable)
        .where(baseWhere)
        .groupBy(paymentConfirmationsTable.status) : Promise.resolve([]),
    ]);

    // A contract can span many units — attach them via contract_units
    // without multiplying the confirmation rows, plus a primary
    // unit/property surface for single-unit display.
    const contractIds = Array.from(new Set(rows.map((r) => r.contractId).filter((v): v is number => v != null)));
    const unitsByContract = new Map<number, any[]>();
    if (contractIds.length > 0) {
      const unitRows = await this.db
        .select({
          contractId: contractUnitsTable.contractId,
          unitId: unitsTable.id,
          unitNumber: unitsTable.unitNumber,
          propertyName: propertiesTable.name,
        })
        .from(contractUnitsTable)
        .innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
        .leftJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
        .where(inArray(contractUnitsTable.contractId, contractIds))
        .orderBy(contractUnitsTable.id);
      for (const u of unitRows) {
        const list = unitsByContract.get(u.contractId) ?? [];
        list.push(u);
        unitsByContract.set(u.contractId, list);
      }
    }
    const enriched = rows.map((row) => {
      const units = row.contractId != null ? (unitsByContract.get(row.contractId) ?? []) : [];
      const first: any = units[0] ?? null;
      return {
        ...row,
        units,
        unitId: first?.unitId ?? null,
        unitNumber: first?.unitNumber ?? null,
        propertyName: first?.propertyName ?? null,
      };
    });

    if (!usePaginated) return enriched;

    const stats = { pending: 0, approved: 0, rejected: 0 };
    for (const s of statsRows as Array<{ status: string; cnt: number }>) {
      if (s.status in stats) stats[s.status as keyof typeof stats] = Number(s.cnt);
    }
    return { data: enriched, page, pageSize, total: Number(totalRow[0]?.total ?? 0), stats };
  }

  /** Signed URL to view/download the proof attachment. */
  @Get(":id/proof")
  @RequirePermissions(PERMISSIONS.PAYMENTS_VIEW)
  async proof(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const [row] = await this.db
      .select()
      .from(paymentConfirmationsTable)
      .where(and(
        eq(paymentConfirmationsTable.id, parseInt(id, 10)),
        eq(paymentConfirmationsTable.userId, scopeId(user)),
        isNull(paymentConfirmationsTable.deletedAt),
      ));
    if (!row) throw new NotFoundException("الطلب غير موجود");
    if (!row.proofKey) throw new NotFoundException("لا يوجد مرفق");
    const url = await this.uploads.presignGet(row.proofKey);
    return { url, name: row.proofName };
  }

  /** Approve (marks the payment paid) or reject a confirmation request. */
  @Patch(":id")
  @RequirePermissions(PERMISSIONS.PAYMENTS_WRITE)
  async review(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    if (body?.status !== "approved" && body?.status !== "rejected") {
      throw new BadRequestException("الحالة غير صحيحة");
    }
    const [row] = await this.db
      .select()
      .from(paymentConfirmationsTable)
      .where(and(
        eq(paymentConfirmationsTable.id, parseInt(id, 10)),
        eq(paymentConfirmationsTable.userId, scopeId(user)),
        isNull(paymentConfirmationsTable.deletedAt),
      ));
    if (!row) throw new NotFoundException("الطلب غير موجود");
    if (row.status !== "pending") throw new BadRequestException("تمت مراجعة هذا الطلب مسبقاً");

    const [updated] = await this.db.update(paymentConfirmationsTable)
      .set({
        status: body.status,
        reviewNote: body.reviewNote?.toString().trim() || null,
        reviewedAt: new Date(),
      })
      .where(eq(paymentConfirmationsTable.id, row.id))
      .returning();

    // Approving the request starts the billing cycle: it creates a DRAFT invoice
    // for the installment (carrying the tenant's proof) instead of marking the
    // installment paid directly. The landlord then continues the normal flow —
    // approve the invoice → collect → receipt voucher — which settles it.
    if (body.status === "approved") {
      const uid = scopeId(user);
      const [payment] = await this.db.select().from(paymentsTable)
        .where(and(eq(paymentsTable.id, row.paymentId), eq(paymentsTable.userId, uid), isNull(paymentsTable.deletedAt)));
      // Don't double-invoice: skip if this installment already has a live invoice.
      const [existingInv] = await this.db.select({ id: simpleInvoicesTable.id }).from(simpleInvoicesTable)
        .where(and(
          eq(simpleInvoicesTable.userId, uid),
          eq(simpleInvoicesTable.paymentId, row.paymentId),
          ne(simpleInvoicesTable.status, "cancelled"),
          isNull(simpleInvoicesTable.deletedAt),
        ));
      if (payment && !existingInv) {
        const [contract] = await this.db
          .select({ tenantName: contractsTable.tenantName, tenantId: contractsTable.tenantId })
          .from(contractsTable).where(eq(contractsTable.id, row.contractId));
        const amount = round2(Number(payment.amount));
        const items = [{ description: payment.description || "إيجار", quantity: 1, unitPrice: amount, amount, vat: false }];
        await this.db.insert(simpleInvoicesTable).values({
          userId: uid,
          number: await nextInvoiceNumber(this.db, uid),
          type: "invoice",
          status: "draft",
          contractId: row.contractId,
          paymentId: row.paymentId,
          paymentIds: [row.paymentId],
          tenantId: contract?.tenantId ?? row.tenantId,
          tenantName: contract?.tenantName ?? null,
          items,
          subtotal: amount.toFixed(2),
          total: amount.toFixed(2),
          issueDate: new Date().toISOString().slice(0, 10),
          // Carry the tenant's payment proof onto the invoice so the landlord
          // sees it through to collection.
          attachmentKey: row.proofKey ?? null,
          notes: `من تأكيد دفع${row.reference ? ` · ${row.reference}` : ""}`,
        } as any);
      }
    }

    // Notify the tenant of the landlord's decision — in-app row + push to the
    // device so it surfaces in the mobile app immediately.
    if (row.tenantId) {
      const amount = Number(row.amount || 0).toLocaleString("en-US");
      const approved = body.status === "approved";
      const note = body.reviewNote?.toString().trim();
      await notifyTenant(this.db, {
        userId: row.userId,
        tenantId: row.tenantId,
        type: approved ? "payment_approved" : "payment_rejected",
        title: approved ? "تم اعتماد الدفعة" : "تم رفض طلب الدفع",
        body: approved
          ? `تم اعتماد دفعتك بمبلغ ${amount} ر.س وجارٍ إصدار الفاتورة وتحصيلها.`
          : `تم رفض طلب تأكيد الدفع بمبلغ ${amount} ر.س.${note ? ` السبب: ${note}` : ""}`,
        data: { paymentId: row.paymentId, confirmationId: row.id },
      });
    }

    return updated;
  }
}

@Module({
  controllers: [TenantPaymentConfirmationsController, PaymentConfirmationsController],
})
export class PaymentConfirmationsModule {}
