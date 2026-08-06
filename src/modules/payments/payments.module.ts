import { Body, Controller, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, ne, isNull, isNotNull, or, ilike, count, asc, desc, sum, inArray, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { paymentsTable, paymentCollectionsTable, contractsTable, tenantsTable, simpleInvoicesTable } from "@dara/database";

const DEPOSIT_DESC = "تأمين (وديعة)";
const ADVANCE_NOTE = "إيجار مدفوع مقدماً";
import { listQuerySchema } from "../../common/pagination";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { liveStatus, liveStatusSql } from "../../common/payment-status";

const PAYMENT_STATUSES = ["paid", "pending", "overdue", "cancelled", "partially_paid", "settled_external"];

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

@ApiTags("payments")
@ApiBearerAuth("user-jwt")
@Controller("payments")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class PaymentsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PAYMENTS_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const status: string | undefined =
      typeof rawQuery?.status === "string" && PAYMENT_STATUSES.includes(rawQuery.status)
        ? rawQuery.status
        : undefined;
    // `statusIn` — a comma-separated set of statuses (e.g. "paid,partially_paid").
    // Lets a view ask for several statuses in one page (the Payments and
    // Invoices tabs only ever want collected installments).
    const statusIn: string[] | undefined =
      typeof rawQuery?.statusIn === "string"
        ? rawQuery.statusIn.split(",").map((s: string) => s.trim()).filter((s: string) => PAYMENT_STATUSES.includes(s))
        : undefined;
    // `contractIds` — comma-separated contract ids; the Installments tab's
    // property / tenant / landlord filters resolve to a set of contracts.
    const contractIds: number[] | undefined =
      typeof rawQuery?.contractIds === "string" && rawQuery.contractIds.trim()
        ? rawQuery.contractIds.split(",").map((s: string) => parseInt(s, 10)).filter((n: number) => Number.isFinite(n))
        : undefined;
    const usePaginated = rawQuery && (rawQuery.page != null || rawQuery.pageSize != null || rawQuery.search != null || status != null || statusIn != null || contractIds != null);
    const q = listQuerySchema.parse(rawQuery ?? {});
    const baseWhere = and(eq(paymentsTable.userId, scopeId(user)), isNull(paymentsTable.deletedAt));
    const conds = [baseWhere];
    if (q.search) {
      conds.push(or(
        ilike(paymentsTable.receiptNumber, `%${q.search}%`),
        ilike(contractsTable.tenantName, `%${q.search}%`),
        ilike(contractsTable.contractNumber, `%${q.search}%`),
      ));
    }
    // Filter on the DERIVED status, not the stored column. Nothing is ever
    // stored as 'overdue', so filtering on the column left the "متأخرة" tab
    // permanently empty and dumped its rows into "قادمة" — while the summary
    // card above, which already derived correctly, counted them as overdue.
    if (status) conds.push(eq(liveStatusSql, status));
    else if (statusIn && statusIn.length > 0) conds.push(inArray(liveStatusSql, statusIn));
    if (contractIds && contractIds.length > 0) conds.push(inArray(paymentsTable.contractId, contractIds));
    // Deposits are not installments — they live on the contract as a receipt
    // voucher, so never surface them in the financial schedule (covers legacy
    // deposit rows created before the deposit-as-voucher change).
    conds.push(or(isNull(paymentsTable.description), ne(paymentsTable.description, DEPOSIT_DESC)));
    const where = and(...conds);

    let rowsQ = this.db
      .select({
        id: paymentsTable.id,
        contractId: paymentsTable.contractId,
        amount: paymentsTable.amount,
        dueDate: paymentsTable.dueDate,
        paidDate: paymentsTable.paidDate,
        status: paymentsTable.status,
        receiptNumber: paymentsTable.receiptNumber,
        attachmentKey: paymentsTable.attachmentKey,
        description: paymentsTable.description,
        notes: paymentsTable.notes,
        createdAt: paymentsTable.createdAt,
        contractNumber: contractsTable.contractNumber,
        tenantName: contractsTable.tenantName,
        tenantShortName: tenantsTable.shortName,
        vatEnabled: paymentsTable.vatEnabled,
        contractVatEnabled: contractsTable.vatEnabled,
      })
      .from(paymentsTable)
      .leftJoin(contractsTable, eq(paymentsTable.contractId, contractsTable.id))
      .leftJoin(tenantsTable, eq(contractsTable.tenantId, tenantsTable.id))
      .where(where)
      // Default: due date (soonest upcoming / oldest overdue first). The
      // Payments tab passes sort=createdAt to show the most recent first.
      .orderBy(
        ...(rawQuery?.sort === "createdAt"
          ? [desc(paymentsTable.createdAt), desc(paymentsTable.id)]
          : [(q.order === "asc" ? asc : desc)(paymentsTable.dueDate), (q.order === "asc" ? asc : desc)(paymentsTable.id)]),
      )
      .$dynamic();
    if (usePaginated) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow, statsRows, collectedRow] = await Promise.all([
      rowsQ,
      usePaginated ? this.db.select({ total: count() }).from(paymentsTable)
        .leftJoin(contractsTable, eq(paymentsTable.contractId, contractsTable.id))
        .where(where) : Promise.resolve([{ total: 0 }]),
      // Status totals across ALL the user's payments (ignores search/status
      // filter) so the summary cards stay consistent while the table pages.
      // Same derivation as the rows, done in SQL so the summary cards cannot
      // disagree with the table: an unsettled installment past its due date
      // counts as overdue regardless of the stored value.
      usePaginated ? this.db.select({
        status: liveStatusSql,
        cnt: count(),
        amount: sum(paymentsTable.amount),
      }).from(paymentsTable).where(baseWhere).groupBy(sql`1`) : Promise.resolve([]),
      // Actual money collected across all collections (covers partial ones).
      usePaginated ? this.db.select({ amount: sum(paymentCollectionsTable.amount) })
        .from(paymentCollectionsTable).where(eq(paymentCollectionsTable.userId, scopeId(user)))
        : Promise.resolve([{ amount: null }]),
    ]);

    // Per-payment collected amount for the rows on this page.
    const ids = (rows as Array<{ id: number }>).map((r) => r.id);
    const collAgg = ids.length
      ? await this.db.select({ paymentId: paymentCollectionsTable.paymentId, total: sum(paymentCollectionsTable.amount) })
          .from(paymentCollectionsTable).where(inArray(paymentCollectionsTable.paymentId, ids))
          .groupBy(paymentCollectionsTable.paymentId)
      : [];
    const collMap = new Map((collAgg as Array<{ paymentId: number; total: string | null }>).map((c) => [c.paymentId, Number(c.total ?? 0)]));

    const data = rows.map((r) => {
      // VAT is per-installment (set at generation): rent rows follow the
      // contract flag, fee rows follow their own fee's vat flag.
      const rowVat = !!(r as any).vatEnabled;
      const contractVat = !!(r as any).contractVatEnabled;
      return {
        id: r.id,
        contractId: r.contractId,
        amount: r.amount,
        collectedAmount: round2(collMap.get(r.id) ?? 0),
        dueDate: r.dueDate,
        paidDate: r.paidDate,
        status: liveStatus(r.status as string, r.dueDate as unknown as string),
        receiptNumber: r.receiptNumber,
        attachmentKey: r.attachmentKey,
        description: r.description,
        notes: r.notes,
        createdAt: r.createdAt,
        vatEnabled: rowVat,
        contract: r.contractNumber ? { contractNumber: r.contractNumber, tenantName: r.tenantName, tenantShortName: r.tenantShortName, vatEnabled: contractVat } : null,
      };
    });
    if (!usePaginated) return data;

    const stats = { paid: 0, pending: 0, overdue: 0, cancelled: 0, partiallyPaid: 0,
      collected: round2(Number((collectedRow as Array<{ amount: string | null }>)[0]?.amount ?? 0)),
      paidCount: 0, pendingCount: 0, overdueCount: 0, cancelledCount: 0, partiallyPaidCount: 0 };
    for (const s of statsRows as Array<{ status: string; cnt: number; amount: string | null }>) {
      const amt = Number(s.amount ?? 0);
      if (s.status === "paid")           { stats.paid = amt;          stats.paidCount = Number(s.cnt); }
      else if (s.status === "pending")   { stats.pending = amt;       stats.pendingCount = Number(s.cnt); }
      else if (s.status === "overdue")   { stats.overdue = amt;       stats.overdueCount = Number(s.cnt); }
      else if (s.status === "cancelled") { stats.cancelled = amt;     stats.cancelledCount = Number(s.cnt); }
      else if (s.status === "partially_paid") { stats.partiallyPaid = amt; stats.partiallyPaidCount = Number(s.cnt); }
    }
    return { data, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0), stats };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PAYMENTS_WRITE)
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    const { contractId, amount, dueDate } = body;
    if (!contractId || !amount || !dueDate) throw new BadRequestException("رقم العقد والمبلغ وتاريخ الاستحقاق مطلوبة");

    const [payment] = await this.db.insert(paymentsTable).values({
      userId: scopeId(user),
      contractId,
      amount: String(amount),
      dueDate,
      paidDate: body.paidDate ?? null,
      status: body.status ?? "pending",
      receiptNumber: body.receiptNumber ?? null,
      notes: body.notes ?? null,
      isDemo: false,
    }).returning();
    return payment;
  }

  @Patch(":paymentId")
  @RequirePermissions(PERMISSIONS.PAYMENTS_WRITE)
  async update(@CurrentUser() user: AuthUser, @Param("paymentId") paymentId: string, @Body() body: any) {
    const id = parseInt(paymentId, 10);
    const fields = ["amount", "dueDate", "paidDate", "status", "receiptNumber", "attachmentKey", "notes"];
    const updateData: Record<string, unknown> = {};
    for (const f of fields) if (body[f] !== undefined) updateData[f] = body[f];
    const [payment] = await this.db.update(paymentsTable).set(updateData)
      .where(and(eq(paymentsTable.id, id), eq(paymentsTable.userId, scopeId(user)), isNull(paymentsTable.deletedAt)))
      .returning();
    if (!payment) throw new NotFoundException("Payment not found");
    return payment;
  }

  /**
   * Mark a single PENDING installment as settled outside the portal
   * (historical). No collection is recorded, so it stays out of all revenue /
   * overdue reporting. Refuses if money was already collected against it.
   */
  @Post(":paymentId/settle-external")
  @RequirePermissions(PERMISSIONS.PAYMENTS_WRITE)
  async settleExternal(@CurrentUser() user: AuthUser, @Param("paymentId") paymentId: string) {
    const id = parseInt(paymentId, 10);
    const [p] = await this.db.select().from(paymentsTable)
      .where(and(eq(paymentsTable.id, id), eq(paymentsTable.userId, scopeId(user)), isNull(paymentsTable.deletedAt)));
    if (!p) throw new NotFoundException("Payment not found");
    if (p.status === "paid" || p.status === "partially_paid") throw new BadRequestException("لا يمكن — تم تحصيل دفعات على هذا القسط");
    const [row] = await this.db.update(paymentsTable)
      .set({ status: "settled_external", paidDate: p.dueDate } as any)
      .where(eq(paymentsTable.id, id)).returning();
    return row;
  }

  /** Revert a settled_external installment back to a live pending due. */
  @Post(":paymentId/revert-external")
  @RequirePermissions(PERMISSIONS.PAYMENTS_WRITE)
  async revertExternal(@CurrentUser() user: AuthUser, @Param("paymentId") paymentId: string) {
    const id = parseInt(paymentId, 10);
    const [row] = await this.db.update(paymentsTable)
      .set({ status: "pending", paidDate: null } as any)
      .where(and(eq(paymentsTable.id, id), eq(paymentsTable.userId, scopeId(user)),
        eq(paymentsTable.status, "settled_external"), isNull(paymentsTable.deletedAt)))
      .returning();
    if (!row) throw new NotFoundException("Settled-external installment not found");
    return row;
  }

  /** Collection history for one installment. */
  @Get(":paymentId/collections")
  @RequirePermissions(PERMISSIONS.PAYMENTS_VIEW)
  async listCollections(@CurrentUser() user: AuthUser, @Param("paymentId") paymentId: string) {
    const id = parseInt(paymentId, 10);
    const [payment] = await this.db.select({ id: paymentsTable.id }).from(paymentsTable)
      .where(and(eq(paymentsTable.id, id), eq(paymentsTable.userId, scopeId(user)), isNull(paymentsTable.deletedAt)));
    if (!payment) throw new NotFoundException("Payment not found");
    return this.db.select().from(paymentCollectionsTable)
      .where(eq(paymentCollectionsTable.paymentId, id))
      .orderBy(asc(paymentCollectionsTable.collectedDate), asc(paymentCollectionsTable.id));
  }

  /**
   * All collections (money actually received) across the account — powers the
   * Collections (التحصيل) tab. Paged, searchable by receipt/tenant/contract.
   */
  @Get("collections-all")
  @RequirePermissions(PERMISSIONS.PAYMENTS_VIEW)
  async listAllCollections(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const q = listQuerySchema.parse(rawQuery ?? {});
    const uid = scopeId(user);
    const s = q.search ? `%${q.search}%` : null;
    // Optional landlord/property/unit filter — resolved to contract ids by the
    // frontend and passed through here.
    const contractIds: number[] | undefined =
      typeof rawQuery?.contractIds === "string" && rawQuery.contractIds.trim()
        ? rawQuery.contractIds.split(",").map((x: string) => parseInt(x, 10)).filter((n: number) => Number.isFinite(n))
        : undefined;

    // 1. Real collections (money received against installments — this also
    //    covers invoices that were linked to an installment).
    const collConds: any[] = [eq(paymentCollectionsTable.userId, uid)];
    if (s) collConds.push(or(ilike(paymentCollectionsTable.receiptNumber, s), ilike(contractsTable.tenantName, s), ilike(contractsTable.contractNumber, s), ilike(simpleInvoicesTable.number, s)));
    // Match the payment's contract OR the invoice's contract, so invoice-only
    // collections (e.g. a collected commission invoice, paymentId = null) aren't
    // dropped when filtering Collections by landlord/property/unit.
    if (contractIds && contractIds.length > 0) collConds.push(or(inArray(paymentsTable.contractId, contractIds), inArray(simpleInvoicesTable.contractId, contractIds)));
    // Legacy deposit collections (on a deposit payment row) are not revenue —
    // exclude them; the deposit shows once, as its receipt voucher (section 2).
    collConds.push(or(isNull(paymentsTable.description), ne(paymentsTable.description, DEPOSIT_DESC)));
    // Advance/prepaid rent IS real money received — show it as its own collection
    // row (it carries its own receipt-voucher number). When the rent invoice is
    // later collected, the remaining balance produces a second voucher, so an
    // advance-paid rent shows two receipt vouchers (advance + remainder).
    // For invoice-only collections (no installment, e.g. a collected commission
    // invoice) the contract/tenant come from the invoice, not the payment.
    const invContract = alias(contractsTable, "inv_contract");
    const collections = await this.db
      .select({
        id: paymentCollectionsTable.id,
        paymentId: paymentCollectionsTable.paymentId,
        amount: paymentCollectionsTable.amount,
        collectedDate: paymentCollectionsTable.collectedDate,
        method: paymentCollectionsTable.method,
        receiptNumber: paymentCollectionsTable.receiptNumber,
        attachmentKey: paymentCollectionsTable.attachmentKey,
        notes: paymentCollectionsTable.notes,
        createdAt: paymentCollectionsTable.createdAt,
        contractId: paymentsTable.contractId,
        contractNumber: contractsTable.contractNumber,
        tenantName: contractsTable.tenantName,
        invoiceId: paymentCollectionsTable.invoiceId,
        invoiceNumber: simpleInvoicesTable.number,
        invContractId: simpleInvoicesTable.contractId,
        invContractNumber: invContract.contractNumber,
        invTenantName: simpleInvoicesTable.tenantName,
      })
      .from(paymentCollectionsTable)
      .leftJoin(paymentsTable, eq(paymentCollectionsTable.paymentId, paymentsTable.id))
      .leftJoin(contractsTable, eq(paymentsTable.contractId, contractsTable.id))
      .leftJoin(simpleInvoicesTable, eq(paymentCollectionsTable.invoiceId, simpleInvoicesTable.id))
      .leftJoin(invContract, eq(simpleInvoicesTable.contractId, invContract.id))
      .where(and(...collConds));

    // 2. Confirmed invoices NOT linked to an installment (free invoices) —
    //    surfaced as collection entries so every confirmed invoice's money
    //    shows in the Collections tab with its chosen method.
    const invConds: any[] = [
      eq(simpleInvoicesTable.userId, uid),
      eq(simpleInvoicesTable.status, "confirmed"),
      eq(simpleInvoicesTable.type, "invoice"),
      isNull(simpleInvoicesTable.paymentId),
      isNull(simpleInvoicesTable.deletedAt),
      // Only invoices that were actually collected (paidDate set) belong in the
      // Collections list. A confirmed-but-uncollected invoice (e.g. an approved
      // commission invoice) has no paidDate and must NOT show here as collected
      // — it stays in the "awaiting collection" list until it's collected.
      isNotNull(simpleInvoicesTable.paidDate),
    ];
    if (s) invConds.push(or(ilike(simpleInvoicesTable.receiptNumber, s), ilike(simpleInvoicesTable.tenantName, s), ilike(simpleInvoicesTable.number, s), ilike(contractsTable.contractNumber, s)));
    if (contractIds && contractIds.length > 0) invConds.push(inArray(simpleInvoicesTable.contractId, contractIds));
    // Vouchers (deposit / receipt) are evidence, not collections — keep them out
    // of the Collections tab; they live under Receipt Vouchers.
    invConds.push(or(isNull(simpleInvoicesTable.kind), and(ne(simpleInvoicesTable.kind, "deposit"), ne(simpleInvoicesTable.kind, "receipt"))));
    // Skip invoices that already have a recorded collection — they're shown by
    // section 1 (the collection row). Without this, a collected commission/free
    // invoice appears twice (once as its collection, once as a "free invoice").
    invConds.push(notExists(
      this.db.select({ id: paymentCollectionsTable.id }).from(paymentCollectionsTable)
        .where(eq(paymentCollectionsTable.invoiceId, simpleInvoicesTable.id)),
    ));
    const freeInvoices = await this.db
      .select({
        id: simpleInvoicesTable.id,
        amount: simpleInvoicesTable.total,
        collectedDate: simpleInvoicesTable.paidDate,
        method: simpleInvoicesTable.paymentMethod,
        receiptNumber: simpleInvoicesTable.receiptNumber,
        attachmentKey: simpleInvoicesTable.attachmentKey,
        number: simpleInvoicesTable.number,
        tenantName: simpleInvoicesTable.tenantName,
        createdAt: simpleInvoicesTable.confirmedAt,
        contractId: simpleInvoicesTable.contractId,
        contractNumber: contractsTable.contractNumber,
        invoiceId: simpleInvoicesTable.id,
      })
      .from(simpleInvoicesTable)
      .leftJoin(contractsTable, eq(simpleInvoicesTable.contractId, contractsTable.id))
      .where(and(...invConds));

    // Unify both sources into one collection shape.
    const merged = [
      ...collections.map((c) => ({
        ...c,
        // Fall back to the invoice's contract/tenant for invoice-only collections.
        contractId: c.contractId ?? c.invContractId ?? null,
        contractNumber: c.contractNumber ?? c.invContractNumber ?? null,
        tenantName: c.tenantName ?? c.invTenantName ?? null,
      })),
      ...freeInvoices.map((iv) => ({
        id: -iv.id, // negative id-space avoids collision with collection ids
        paymentId: null as number | null,
        amount: iv.amount,
        collectedDate: iv.collectedDate,
        method: iv.method,
        receiptNumber: iv.receiptNumber,
        attachmentKey: iv.attachmentKey,
        notes: iv.number,
        createdAt: iv.createdAt as any,
        contractId: iv.contractId,
        contractNumber: iv.contractNumber,
        tenantName: iv.tenantName,
        invoiceId: iv.invoiceId,
        invoiceNumber: iv.number,
      })),
    ];
    // Collapse multi-installment collections: an invoice with rent + fees is
    // collected across one payment_collection per installment, all sharing the
    // same invoice and receipt voucher. Since the user issued ONE invoice (and
    // ONE voucher), show ONE collection row with the combined amount. Rows
    // without both an invoice and a receipt number stay individual.
    const groups = new Map<string, typeof merged[number]>();
    for (const r of merged) {
      const key = r.invoiceId != null && r.receiptNumber ? `inv:${r.invoiceId}|rv:${r.receiptNumber}` : `row:${r.id}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, { ...r });
      } else {
        existing.amount = round2(Number(existing.amount ?? 0) + Number(r.amount ?? 0)).toFixed(2) as any;
        if (!existing.attachmentKey && r.attachmentKey) existing.attachmentKey = r.attachmentKey;
      }
    }
    const grouped = Array.from(groups.values());

    // Newest first by creation time.
    grouped.sort((a, b) => {
      const da = new Date(a.createdAt || a.collectedDate || 0).getTime();
      const db = new Date(b.createdAt || b.collectedDate || 0).getTime();
      return q.order === "asc" ? da - db : db - da;
    });

    const total = grouped.length;
    const totalCollected = round2(grouped.reduce((acc, r) => acc + Number(r.amount ?? 0), 0));
    const pageRows = grouped.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    return {
      data: pageRows, page: q.page, pageSize: q.pageSize, total,
      stats: { totalCollected, count: total },
    };
  }

  /**
   * Record a collection against an installment. Supports partial amounts —
   * the installment becomes `partially_paid` until its collections cover the
   * full amount, then flips to `paid`.
   */
  @Post(":paymentId/collections")
  @RequirePermissions(PERMISSIONS.PAYMENTS_WRITE)
  async addCollection(@CurrentUser() user: AuthUser, @Param("paymentId") paymentId: string, @Body() body: any) {
    const id = parseInt(paymentId, 10);
    const [payment] = await this.db.select().from(paymentsTable)
      .where(and(eq(paymentsTable.id, id), eq(paymentsTable.userId, scopeId(user)), isNull(paymentsTable.deletedAt)));
    if (!payment) throw new NotFoundException("Payment not found");
    if (payment.status === "paid") throw new BadRequestException("هذا القسط محصّل بالكامل");
    if (payment.status === "cancelled") throw new BadRequestException("هذا القسط ملغى");

    const amount = round2(Number(body?.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException("مبلغ التحصيل غير صالح");

    const prior = await this.db.select({ total: sum(paymentCollectionsTable.amount) })
      .from(paymentCollectionsTable).where(eq(paymentCollectionsTable.paymentId, id));
    const collectedBefore = round2(Number(prior[0]?.total ?? 0));
    const total = round2(Number(payment.amount));
    const remaining = round2(total - collectedBefore);
    if (amount > remaining + 0.01) throw new BadRequestException(`مبلغ التحصيل يتجاوز المتبقي (${remaining.toFixed(2)})`);

    const collectedDate = body?.collectedDate || new Date().toISOString().slice(0, 10);
    const [collection] = await this.db.insert(paymentCollectionsTable).values({
      paymentId: id,
      userId: scopeId(user),
      amount: amount.toFixed(2),
      collectedDate,
      method: body?.method ?? null,
      receiptNumber: body?.receiptNumber ?? null,
      attachmentKey: body?.attachmentKey ?? null,
      notes: body?.notes ?? null,
    }).returning();

    const collectedAfter = round2(collectedBefore + amount);
    const fullyPaid = collectedAfter >= total - 0.01;
    const [updated] = await this.db.update(paymentsTable).set({
      status: fullyPaid ? "paid" : "partially_paid",
      paidDate: fullyPaid ? collectedDate : payment.paidDate,
      // Surface the latest evidence/receipt on the installment itself so the
      // Installments/Invoices tables keep showing one when fully collected.
      receiptNumber: body?.receiptNumber ?? payment.receiptNumber,
      attachmentKey: body?.attachmentKey ?? payment.attachmentKey,
    }).where(and(eq(paymentsTable.id, id), eq(paymentsTable.userId, scopeId(user))))
      .returning();

    return { collection, payment: updated, collectedAmount: collectedAfter, remaining: round2(total - collectedAfter) };
  }
}

@Module({ controllers: [PaymentsController] })
export class PaymentsModule {}
