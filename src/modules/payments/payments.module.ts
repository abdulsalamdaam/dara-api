import { Body, Controller, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, ne, isNull, isNotNull, or, ilike, count, asc, desc, sum, inArray, notExists, sql } from "drizzle-orm";
import { alias, unionAll } from "drizzle-orm/pg-core";
import { paymentsTable, paymentCollectionsTable, contractsTable, tenantsTable, simpleInvoicesTable } from "@dara/database";

const DEPOSIT_DESC = "تأمين (وديعة)";
const ADVANCE_NOTE = "إيجار مدفوع مقدماً";
import { listQuerySchema, parseIdList } from "../../common/pagination";
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

    // The cards deliberately ignore search and the status tab, so they stay put
    // while the table pages — but they must NOT ignore the contract filter. The
    // by-contract finance view asks for one contract's figures with pageSize 1
    // and got the whole account's totals back, so every card there described
    // somebody else's money.
    const statsConds: any[] = [baseWhere];
    if (contractIds && contractIds.length > 0) statsConds.push(inArray(paymentsTable.contractId, contractIds));
    statsConds.push(or(isNull(paymentsTable.description), ne(paymentsTable.description, DEPOSIT_DESC)));
    const statsWhere = and(...statsConds);

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

    // Money collected on a free invoice — a fee collected against an invoice
    // with no installment behind it. It never produces a payment_collections
    // row, so the sum above cannot see it, and the Payments card used to leave
    // it out entirely: the row appeared in the table and the total did not move.
    // Same conditions the Collections tab uses for these, kept in SQL so the
    // figure covers every invoice rather than the first page of them.
    const freeCollectedWhere = and(
      eq(simpleInvoicesTable.userId, scopeId(user)),
      eq(simpleInvoicesTable.status, "confirmed"),
      eq(simpleInvoicesTable.type, "invoice"),
      isNull(simpleInvoicesTable.paymentId),
      isNull(simpleInvoicesTable.deletedAt),
      isNotNull(simpleInvoicesTable.paidDate),
      // Vouchers are evidence of money already counted elsewhere, not collections.
      or(isNull(simpleInvoicesTable.kind), and(ne(simpleInvoicesTable.kind, "deposit"), ne(simpleInvoicesTable.kind, "receipt"))),
      notExists(
        this.db.select({ id: paymentCollectionsTable.id }).from(paymentCollectionsTable)
          .where(eq(paymentCollectionsTable.invoiceId, simpleInvoicesTable.id)),
      ),
      ...(contractIds && contractIds.length > 0 ? [inArray(simpleInvoicesTable.contractId, contractIds)] : []),
    );

    const [rows, totalRow, statsRows, collectedRow, freeCollectedRow] = await Promise.all([
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
      }).from(paymentsTable).where(statsWhere).groupBy(sql`1`) : Promise.resolve([]),
      // Actual money collected across all collections (covers partial ones).
      usePaginated ? this.db.select({ amount: sum(paymentCollectionsTable.amount) })
        .from(paymentCollectionsTable)
        // An invoice-only collection carries no payment, so its contract comes
        // from the invoice — match either, or a filtered card loses that money.
        .leftJoin(paymentsTable, eq(paymentCollectionsTable.paymentId, paymentsTable.id))
        .leftJoin(simpleInvoicesTable, eq(paymentCollectionsTable.invoiceId, simpleInvoicesTable.id))
        .where(and(
          eq(paymentCollectionsTable.userId, scopeId(user)),
          // A collection whose installment was since deleted stops being
          // counted. Collections with no installment at all — a collected
          // commission invoice, say — are real money and stay.
          or(isNull(paymentCollectionsTable.paymentId), isNull(paymentsTable.deletedAt)),
          ...(contractIds && contractIds.length > 0
            ? [or(inArray(paymentsTable.contractId, contractIds), inArray(simpleInvoicesTable.contractId, contractIds))]
            : []),
        ))
        : Promise.resolve([{ amount: null }]),
      usePaginated ? this.db.select({ amount: sum(simpleInvoicesTable.total), cnt: count() })
        .from(simpleInvoicesTable).where(freeCollectedWhere)
        : Promise.resolve([{ amount: null, cnt: 0 }]),
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

    const freeCollected = round2(Number((freeCollectedRow as Array<{ amount: string | null }>)[0]?.amount ?? 0));
    const freeCollectedCount = Number((freeCollectedRow as Array<{ cnt: number }>)[0]?.cnt ?? 0);
    const stats = { paid: 0, pending: 0, overdue: 0, cancelled: 0, partiallyPaid: 0,
      // `collected` is all the money in, whichever way it came in.
      collected: round2(Number((collectedRow as Array<{ amount: string | null }>)[0]?.amount ?? 0) + freeCollected),
      freeCollected, freeCollectedCount,
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
   *
   * Two sources make up one list:
   *
   *   1. `payment_collections` — money received against an installment. This
   *      also covers invoices that were linked to an installment.
   *   2. Confirmed invoices with NO installment behind them ("free" invoices,
   *      e.g. a collected commission) — real money that produces no collection
   *      row, so section 1 cannot see it. Surfaced with a negative id so it
   *      cannot collide with a collection id.
   *
   * Both are unioned, grouped and paged BY THE DATABASE. They used to be two
   * unbounded SELECTs merged, grouped, sorted and sliced in JavaScript: the
   * filters were already in SQL, but the whole matching set had to be
   * materialised in the API process to produce one page of 25 and a total. On
   * a busy account that is every collection it has ever recorded, fetched to
   * answer a question about the newest twenty-five.
   *
   * The grouping is the reason this cannot be a plain paged query. An invoice
   * covering rent plus fees is collected as one `payment_collections` row per
   * installment, all sharing one invoice and one receipt voucher — but the
   * user issued ONE invoice and ONE voucher, so the tab shows ONE row with the
   * combined amount. That collapse is now `GROUP BY` on the same key the
   * JavaScript used, which is what makes `total` (the count of GROUPS, not of
   * rows) correct.
   */
  @Get("collections-all")
  @RequirePermissions(PERMISSIONS.PAYMENTS_VIEW)
  async listAllCollections(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const q = listQuerySchema.parse(rawQuery ?? {});
    const uid = scopeId(user);
    const s = q.search ? `%${q.search}%` : null;
    // Optional landlord/property/unit filter — resolved to contract ids by the
    // frontend and passed through here.
    const contractIds = parseIdList(rawQuery?.contractIds);

    // ── Source 1: real collections ────────────────────────────────────────
    const collConds: any[] = [eq(paymentCollectionsTable.userId, uid)];
    if (s) collConds.push(or(ilike(paymentCollectionsTable.receiptNumber, s), ilike(contractsTable.tenantName, s), ilike(contractsTable.contractNumber, s), ilike(simpleInvoicesTable.number, s)));
    // Match the payment's contract OR the invoice's contract, so invoice-only
    // collections (e.g. a collected commission invoice, paymentId = null) aren't
    // dropped when filtering Collections by landlord/property/unit.
    if (contractIds && contractIds.length > 0) collConds.push(or(inArray(paymentsTable.contractId, contractIds), inArray(simpleInvoicesTable.contractId, contractIds)));
    // Legacy deposit collections (on a deposit payment row) are not revenue —
    // exclude them; the deposit shows once, as its receipt voucher (section 2).
    collConds.push(or(isNull(paymentsTable.description), ne(paymentsTable.description, DEPOSIT_DESC)));
    // Advance/prepaid rent IS real money received — it keeps its own collection
    // row (it carries its own receipt-voucher number). When the rent invoice is
    // later collected, the remaining balance produces a second voucher, so an
    // advance-paid rent shows two receipt vouchers (advance + remainder).
    // For invoice-only collections the contract/tenant come from the invoice,
    // not the payment.
    const invContract = alias(contractsTable, "inv_contract");
    const collectionsQ = this.db
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
        contractId: sql<number | null>`coalesce(${paymentsTable.contractId}, ${simpleInvoicesTable.contractId})`.as("contract_id"),
        contractNumber: sql<string | null>`coalesce(${contractsTable.contractNumber}, ${invContract.contractNumber})`.as("contract_number"),
        tenantName: sql<string | null>`coalesce(${contractsTable.tenantName}, ${simpleInvoicesTable.tenantName})`.as("tenant_name"),
        invoiceId: paymentCollectionsTable.invoiceId,
        invoiceNumber: simpleInvoicesTable.number,
        // The key the list is ordered by: creation time, falling back to the
        // collection date. Mirrors what the JavaScript sort used to do.
        sortAt: sql<Date | null>`coalesce(${paymentCollectionsTable.createdAt}, ${paymentCollectionsTable.collectedDate}::timestamptz)`.as("sort_at"),
      })
      .from(paymentCollectionsTable)
      .leftJoin(paymentsTable, eq(paymentCollectionsTable.paymentId, paymentsTable.id))
      .leftJoin(contractsTable, eq(paymentsTable.contractId, contractsTable.id))
      .leftJoin(simpleInvoicesTable, eq(paymentCollectionsTable.invoiceId, simpleInvoicesTable.id))
      .leftJoin(invContract, eq(simpleInvoicesTable.contractId, invContract.id))
      .where(and(...collConds));

    // ── Source 2: confirmed invoices with no installment ──────────────────
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
    const freeInvoicesQ = this.db
      .select({
        // Negative id-space avoids collision with collection ids.
        id: sql<number>`-${simpleInvoicesTable.id}`.as("id"),
        paymentId: sql<number | null>`null::integer`.as("payment_id"),
        amount: simpleInvoicesTable.total,
        collectedDate: simpleInvoicesTable.paidDate,
        method: simpleInvoicesTable.paymentMethod,
        receiptNumber: simpleInvoicesTable.receiptNumber,
        attachmentKey: simpleInvoicesTable.attachmentKey,
        notes: simpleInvoicesTable.number,
        createdAt: simpleInvoicesTable.confirmedAt,
        contractId: simpleInvoicesTable.contractId,
        contractNumber: contractsTable.contractNumber,
        tenantName: simpleInvoicesTable.tenantName,
        invoiceId: simpleInvoicesTable.id,
        invoiceNumber: simpleInvoicesTable.number,
        sortAt: sql<Date | null>`coalesce(${simpleInvoicesTable.confirmedAt}, ${simpleInvoicesTable.paidDate}::timestamptz)`.as("sort_at"),
      })
      .from(simpleInvoicesTable)
      .leftJoin(contractsTable, eq(simpleInvoicesTable.contractId, contractsTable.id))
      .where(and(...invConds));

    const merged = unionAll(collectionsQ, freeInvoicesQ).as("collections_union");

    // One row per invoice+voucher pair; anything without both stays on its own.
    // `nullif(..., '')` because an empty receipt number is falsy in JavaScript
    // but not NULL in SQL — without it, every row that has an invoice and a
    // blank voucher number would collapse into a single bogus group.
    const groupKey = sql`case
      when ${merged.invoiceId} is not null and nullif(${merged.receiptNumber}, '') is not null
        then 'inv:' || ${merged.invoiceId} || '|rv:' || ${merged.receiptNumber}
      else 'row:' || ${merged.id}
    end`;
    const dir = q.order === "asc" ? sql`asc` : sql`desc`;

    const [rows, totalRow, sumRow] = await Promise.all([
      this.db
        .select({
          id: sql<number>`min(${merged.id})`,
          paymentId: sql<number | null>`min(${merged.paymentId})`,
          amount: sql<string>`sum(${merged.amount})`,
          collectedDate: sql<string | null>`max(${merged.collectedDate})`,
          method: sql<string | null>`max(${merged.method})`,
          receiptNumber: sql<string | null>`max(${merged.receiptNumber})`,
          // The evidence attachment can sit on any one of the grouped rows;
          // `max` ignores NULLs, which is the "first non-null wins" the
          // JavaScript merge did.
          attachmentKey: sql<string | null>`max(${merged.attachmentKey})`,
          notes: sql<string | null>`max(${merged.notes})`,
          createdAt: sql<Date | null>`max(${merged.createdAt})`,
          contractId: sql<number | null>`max(${merged.contractId})`,
          contractNumber: sql<string | null>`max(${merged.contractNumber})`,
          tenantName: sql<string | null>`max(${merged.tenantName})`,
          invoiceId: sql<number | null>`max(${merged.invoiceId})`,
          invoiceNumber: sql<string | null>`max(${merged.invoiceNumber})`,
        })
        .from(merged)
        .groupBy(groupKey)
        // `min(id)` as the tiebreak — two collections recorded in the same
        // instant would otherwise order arbitrarily and shuffle between pages.
        .orderBy(sql`max(${merged.sortAt}) ${dir} nulls last, min(${merged.id}) ${dir}`)
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),

      // `total` counts GROUPS, not union rows — a three-installment invoice is
      // one line in this list, so counting rows would overstate it.
      this.db.select({ total: count() }).from(
        this.db.select({ k: sql`1`.as("k") }).from(merged).groupBy(groupKey).as("groups"),
      ),

      // Grouping only re-partitions the money, so the collected total is the
      // sum over the whole filtered union.
      this.db.select({ amount: sql<string | null>`sum(${merged.amount})` }).from(merged),
    ]);

    const total = Number(totalRow[0]?.total ?? 0);
    return {
      data: rows,
      page: q.page,
      pageSize: q.pageSize,
      total,
      stats: { totalCollected: round2(Number(sumRow[0]?.amount ?? 0)), count: total },
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
    if (!Number.isInteger(id)) throw new BadRequestException("رقم القسط غير صالح");
    // Read-then-insert with nothing holding the row: eight parallel requests
    // each read "nothing collected yet", each passed the cap, and the same
    // money landed five times. The lock is per installment, held to the end of
    // the transaction, so the reads below see every earlier insert.
    return this.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${scopeId(user)}, ${id})`);
    const [payment] = await tx.select().from(paymentsTable)
      .where(and(eq(paymentsTable.id, id), eq(paymentsTable.userId, scopeId(user)), isNull(paymentsTable.deletedAt)));
    if (!payment) throw new NotFoundException("Payment not found");
    if (payment.status === "paid") throw new BadRequestException("هذا القسط محصّل بالكامل");
    if (payment.status === "cancelled") throw new BadRequestException("هذا القسط ملغى");

    const amount = round2(Number(body?.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException("مبلغ التحصيل غير صالح");

    const prior = await tx.select({ total: sum(paymentCollectionsTable.amount) })
      .from(paymentCollectionsTable).where(eq(paymentCollectionsTable.paymentId, id));
    const collectedBefore = round2(Number(prior[0]?.total ?? 0));
    const total = round2(Number(payment.amount));
    const remaining = round2(total - collectedBefore);
    if (amount > remaining + 0.01) throw new BadRequestException(`مبلغ التحصيل يتجاوز المتبقي (${remaining.toFixed(2)})`);

    const collectedDate = body?.collectedDate || new Date().toISOString().slice(0, 10);
    const [collection] = await tx.insert(paymentCollectionsTable).values({
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
    const [updated] = await tx.update(paymentsTable).set({
      status: fullyPaid ? "paid" : "partially_paid",
      paidDate: fullyPaid ? collectedDate : payment.paidDate,
      // Surface the latest evidence/receipt on the installment itself so the
      // Installments/Invoices tables keep showing one when fully collected.
      receiptNumber: body?.receiptNumber ?? payment.receiptNumber,
      attachmentKey: body?.attachmentKey ?? payment.attachmentKey,
    }).where(and(eq(paymentsTable.id, id), eq(paymentsTable.userId, scopeId(user))))
      .returning();

    return { collection, payment: updated, collectedAmount: collectedAfter, remaining: round2(total - collectedAfter) };
    });
  }
}

@Module({ controllers: [PaymentsController] })
export class PaymentsModule {}
