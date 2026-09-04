import {
  Body, Controller, Delete, Get, Header, Inject, Module, NotFoundException, Param, Patch, Post, Query,
  BadRequestException, ConflictException, StreamableFile, UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, ne, isNull, or, ilike, count, asc, desc, sum, inArray, getTableColumns, sql, isNotNull} from "drizzle-orm";
import {
  simpleInvoicesTable, paymentsTable, paymentCollectionsTable, contractsTable,
  contractUnitsTable, unitsTable, propertiesTable, companiesTable, usersTable,
  tenantsTable, ownersTable, invoicesTable,
  type BuyerSnapshot,
} from "@dara/database";
import type { InvoiceLineInput } from "../invoice/services/invoice-builder.service";
import { PdfA3Service } from "../invoice/services/pdfa3.service";
import { UploadsService } from "../uploads/uploads.service";
import { UploadsModule } from "../uploads/uploads.module";
import { listQuerySchema, wantsPagination, pageBounds, parseIdList} from "../../common/pagination";
import { nextReceiptVoucherNumber } from "../../common/receipt-number";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { checkInvoiceReadiness, isOnboarded, readinessMessage, resolveStandaloneSellerId, type InvoiceReadiness } from "../../common/invoice-readiness";
import { AppLogService } from "../../common/logging/app-log.service";
import { foreignKeyId, requiredForeignKeyId } from "../../common/validation";
import { Logger } from "@nestjs/common";
import { InvoiceModule } from "../invoice/invoice.module";
import { InvoiceService, type CreateInvoiceDto } from "../invoice/services/invoice.service";
import { CHAIN_BUSY } from "../invoice/services/chain-lock";
import { ZatcaOnboardingService } from "../invoice/services/zatca-onboarding.service";
import { clearedInvoiceQr } from "../../common/zatca-qr";

const DOC_TYPES = ["invoice", "credit", "debit"] as const;
const DOC_STATUSES = ["draft", "confirmed", "cancelled"] as const;
const DEPOSIT_DESC = "تأمين (وديعة)";
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

type LineItem = { description: string; quantity: number; unitPrice: number; amount: number; vat?: boolean };

/** Result of the best-effort ZATCA mirror on approval — surfaced to the UI. */
type ZatcaSubmitOutcome =
  | { submitted: true; status: string; profile: string; environment: string; httpStatus: number; invoiceId: number; qr: string | null; warnings: number }
  | {
      submitted: false;
      /**
       * `link_invalid` is not a flavour of `error`. ZATCA refused the
       * CREDENTIALS, so nothing was filed, no ICV was spent, and no amount of
       * correcting the document will help — the seller has to link again.
       */
      code: "not_linked" | "not_onboarded" | "link_invalid" | "chain_busy" | "no_items" | "skipped" | "not_required" | "error";
      reason: string;
    };


function normalizeItems(raw: any): LineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((it) => {
      const quantity = round2(Number(it?.quantity ?? 1)) || 0;
      const unitPrice = round2(Number(it?.unitPrice ?? 0)) || 0;
      const amount = it?.amount != null ? round2(Number(it.amount)) : round2(quantity * unitPrice);
      // Per-line VAT flag — default true when omitted (legacy behaviour).
      const vat = it?.vat == null ? true : !!it.vat;
      return { description: String(it?.description ?? "").trim(), quantity, unitPrice, amount, vat };
    })
    .filter((it) => it.description || it.amount);
}

/**
 * Refuse a document whose figures are negative.
 *
 * A negative invoice is a credit note wearing an invoice's number: it would
 * subtract from revenue, from the installment it collects against and from the
 * ZATCA submission, all while being typed as an invoice. Credit and debit notes
 * carry their own positive amounts and are netted by TYPE, so the rule is the
 * same for all three. Enforced here as well as in the UI because the UI is only
 * one caller.
 */
function assertNonNegative(items: LineItem[], total: number): void {
  const bad = items.find((it) =>
    !Number.isFinite(it.quantity) || !Number.isFinite(it.unitPrice) || !Number.isFinite(it.amount) ||
    it.quantity < 0 || it.unitPrice < 0 || it.amount < 0);
  if (bad) {
    throw new BadRequestException(
      `لا تُقبل القيم السالبة في بنود المستند${bad.description ? ` — «${bad.description}»` : ""}`,
    );
  }
  if (!Number.isFinite(total) || total < 0) {
    throw new BadRequestException("لا يمكن أن يكون إجمالي المستند سالباً");
  }
}

/** The VAT rate a taxable line carries. Mirrors the wizard's `VAT_RATE`. */
const VAT_RATE = 0.15;
/** One halala — money is compared at the precision it is stored in. */
const HALALA = 0.01;

/**
 * Refuse a document whose total does not follow from its own line items.
 *
 * `subtotal` is derived (Σ of the line amounts) but `total` was taken from the
 * request verbatim, and VAT is implied everywhere downstream as
 * `total − subtotal` — so `{"items":[{…,"amount":100}],"total":999999}` stored
 * `subtotal 100.00, total 999999.00` and minted 999,899 of VAT out of nothing,
 * on a document that goes to ZATCA.
 *
 * The expected total is the subtotal plus 15% on the lines that are flagged
 * VAT-able, which covers every shape the wizard produces: a mixed document
 * (some lines taxed, some not), zero-rated/exempt lines (`vat: false`) and a
 * VAT-disabled document (every line `vat: false`, so total === subtotal).
 * Two roundings are accepted — the whole VAT rounded once, which is what the
 * web computes, and each line's VAT rounded on its own — because both are a
 * correct reading of the same figures and they can differ by a halala.
 */
function assertTotalMatchesItems(items: LineItem[], total: number): void {
  const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));
  const taxable = items.reduce((s, it) => s + (it.vat ? it.amount : 0), 0);
  // Σ VAT rounded once (the wizard's arithmetic) …
  const roundedOnce = round2(subtotal + round2(taxable * VAT_RATE));
  // … and VAT rounded per line (what a line-by-line reading gives).
  const roundedPerLine = round2(items.reduce((s, it) => s + it.amount + (it.vat ? round2(it.amount * VAT_RATE) : 0), 0));
  if (Math.abs(total - roundedOnce) <= HALALA || Math.abs(total - roundedPerLine) <= HALALA) return;
  if (items.length === 0) {
    throw new BadRequestException("لا يمكن إصدار مستند بإجمالي بدون بنود · A document total needs line items behind it");
  }
  throw new BadRequestException(
    `إجمالي المستند (${total.toFixed(2)}) لا يطابق بنوده — المجموع ${subtotal.toFixed(2)} ` +
    `والإجمالي المتوقع ${roundedOnce.toFixed(2)} · Document total does not match its line items and their VAT flags`,
  );
}

/**
 * Sub-kinds that are not tax invoices and so are exempt from the invoice
 * readiness gate. Anything outside this set — including an unrecognised value —
 * is treated as a tax invoice.
 */
const TAX_EXEMPT_KINDS = new Set(["receipt", "deposit", "commission"]);
function isTaxExemptKind(kind: unknown): boolean {
  return typeof kind === "string" && TAX_EXEMPT_KINDS.has(kind.trim());
}

/** Every sub-kind the product actually issues; anything else is refused. */
const KNOWN_DOC_KINDS = new Set([...TAX_EXEMPT_KINDS, "invoice", "manual"]);

@ApiTags("simple-invoices")
@ApiBearerAuth("user-jwt")
@Controller("simple-invoices")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class SimpleInvoicesController {
  private readonly logger = new Logger("BillingZatca");
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly invoices: InvoiceService,
    private readonly zatcaOnboarding: ZatcaOnboardingService,
    private readonly pdfa3: PdfA3Service,
    private readonly uploads: UploadsService,
    private readonly appLog: AppLogService,
  ) {}

  /**
   * GET /simple-invoices/:id/pdfa3
   *
   * The buyer's copy of a cleared invoice as PDF/A-3: the rendered page with
   * ZATCA's cleared XML embedded inside it. ZATCA accepts the e-invoice being
   * shared as XML or as PDF/A-3 carrying that XML, and this is the second form.
   *
   * Deliberately refuses rather than improvising when either half is missing —
   * a PDF/A-3 without the cleared XML would claim to be an e-invoice while
   * carrying nothing verifiable.
   */
  @Get(":id/pdfa3")
  @RequirePermissions(PERMISSIONS.INVOICES_VIEW)
  @Header("Content-Type", "application/pdf")
  async pdfA3(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const uid = scopeId(user);
    const [doc] = await this.db.select().from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.id, requiredForeignKeyId(id, "رقم المستند")), eq(simpleInvoicesTable.userId, uid), isNull(simpleInvoicesTable.deletedAt)));
    if (!doc) throw new NotFoundException("Document not found");

    // The cleared XML: by the stored link, falling back to a match on the
    // invoice number for documents submitted before that link existed.
    const linkId = (doc as any).zatcaInvoiceId as number | null;
    const [einv] = linkId
      ? await this.db.select({ clearedXml: invoicesTable.clearedXml, signedXml: invoicesTable.signedXml })
          .from(invoicesTable).where(and(eq(invoicesTable.id, linkId), eq(invoicesTable.userId, uid)))
      : await this.db.select({ clearedXml: invoicesTable.clearedXml, signedXml: invoicesTable.signedXml })
          .from(invoicesTable)
          .where(and(eq(invoicesTable.userId, uid), eq(invoicesTable.invoiceNumber, doc.number), isNull(invoicesTable.deletedAt)));

    const xml = einv?.clearedXml ?? null;
    if (!xml) {
      throw new ConflictException(
        "لا توجد نسخة معتمدة من هيئة الزكاة لهذا المستند بعد — لا يمكن إنشاء نسخة PDF/A-3.",
      );
    }
    const pdfKey = (doc as any).pdfKey as string | null;
    if (!pdfKey) {
      throw new ConflictException(
        "لم يتم إنشاء ملف PDF لهذا المستند بعد. افتح المستند مرة واحدة ثم أعد المحاولة.",
      );
    }

    const pdf = await this.uploads.getObject(pdfKey);
    const out = await this.pdfa3.build({
      pdf, xml: Buffer.from(xml, "utf8"),
      number: doc.number,
      issuedAt: doc.issueDate ? new Date(doc.issueDate) : null,
    });
    return new StreamableFile(out, {
      type: "application/pdf",
      disposition: `attachment; filename="${doc.number.replace(/[^A-Za-z0-9._-]/g, "_")}-pdfa3.pdf"`,
    });
  }

  /**
   * Next document number for a type, e.g. INV-000123 / CRN-000005 / DBN-000002.
   *
   * Uses MAX(sequence)+1 for THIS prefix (not COUNT): isolates INV- from the
   * RV-/COM- docs that also live in this table as type=invoice, and stays unique
   * even after a draft in the middle is deleted. MUST be called inside the
   * advisory-locked transaction in `create` so concurrent creations (e.g. a rent
   * + a fee invoice fired together) can't read the same max and collide.
   */
  private async nextNumber(tx: any, userId: number, type: string): Promise<string> {
    const prefix = type === "credit" ? "CRN" : type === "debit" ? "DBN" : "INV";
    const res: any = await tx.execute(sql`
      select coalesce(max(cast(substring(${simpleInvoicesTable.number} from '[0-9]+$') as integer)), 0) as m
      from ${simpleInvoicesTable}
      where ${simpleInvoicesTable.userId} = ${userId} and ${simpleInvoicesTable.number} like ${prefix + "-%"}
    `);
    const rows = Array.isArray(res) ? res : (res?.rows ?? []);
    const max = Number(rows?.[0]?.m ?? 0);
    return `${prefix}-${String(max + 1).padStart(6, "0")}`;
  }

  @Get()
  @RequirePermissions(PERMISSIONS.INVOICES_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const q = listQuerySchema.parse(rawQuery ?? {});
    // `type` may be a single value or a comma list (e.g. "credit,debit" for the
    // combined Settlement page).
    const types: string[] | undefined = typeof rawQuery?.type === "string" && rawQuery.type.includes(",")
      ? rawQuery.type.split(",").map((s: string) => s.trim()).filter((t: string) => DOC_TYPES.includes(t as any))
      : undefined;
    const type = !types && DOC_TYPES.includes(rawQuery?.type) ? rawQuery.type : undefined;
    const status = DOC_STATUSES.includes(rawQuery?.status) ? rawQuery.status : undefined;
    // Optional landlord/property/unit filter — resolved to contract ids by the
    // frontend and passed through here.
    const contractIds: number[] | undefined =
      typeof rawQuery?.contractIds === "string" && rawQuery.contractIds.trim()
        // parseIdList bounds each id to int4; the local parse here let a value
        // past 2^31 reach the driver, which answers a 500 rather than a miss.
        ? (parseIdList(rawQuery.contractIds) ?? [])
        : undefined;
    const base = and(eq(simpleInvoicesTable.userId, scopeId(user)), isNull(simpleInvoicesTable.deletedAt));
    const conds = [base];
    if (types) conds.push(inArray(simpleInvoicesTable.type, types as any) as any);
    else if (type) conds.push(eq(simpleInvoicesTable.type, type as any));
    if (status) conds.push(eq(simpleInvoicesTable.status, status as any));
    if (contractIds && contractIds.length > 0) conds.push(inArray(simpleInvoicesTable.contractId, contractIds) as any);
    // Hide vouchers (deposit + receipt) from the Invoices / Collections views —
    // they're evidence documents shown under Receipt Vouchers, never tax
    // invoices and never collectible.
    const excludeVouchers = rawQuery?.excludeVouchers === "true" || rawQuery?.excludeVouchers === true;
    // Deposit-only exclusion: deposits live solely on the contract detail and
    // must not appear even in the global Receipt Vouchers list.
    const excludeDeposit = rawQuery?.excludeDeposit === "true" || rawQuery?.excludeDeposit === true;
    const notVoucherCond = or(
      isNull(simpleInvoicesTable.kind),
      and(ne(simpleInvoicesTable.kind, "deposit"), ne(simpleInvoicesTable.kind, "receipt")),
    );
    const notDepositCond = or(isNull(simpleInvoicesTable.kind), ne(simpleInvoicesTable.kind, "deposit"));
    if (excludeVouchers) conds.push(notVoucherCond as any);
    else if (excludeDeposit) conds.push(notDepositCond as any);

    // Filters the portal's finance tabs need. Each of these used to be decided
    // in the browser over a fixed page of rows, so the list and its badge were
    // both wrong past that page — "awaiting collection" in particular was a ten
    // page walk that still showed "N+".
    const flag = (v: unknown) => v === true || v === "true";
    // Approved but no money against it yet.
    if (flag(rawQuery?.awaitingCollection)) {
      conds.push(eq(simpleInvoicesTable.status, "confirmed") as any);
      conds.push(isNull(simpleInvoicesTable.paidDate) as any);
      conds.push(isNull(simpleInvoicesTable.receiptNumber) as any);
    }
    // Money actually received against it.
    if (flag(rawQuery?.collected)) conds.push(isNotNull(simpleInvoicesTable.paidDate) as any);
    // Documents with no installment behind them — a commission or a one-off.
    if (flag(rawQuery?.withoutInstallment)) conds.push(isNull(simpleInvoicesTable.paymentId) as any);
    // Carries a receipt voucher number.
    if (flag(rawQuery?.hasReceipt)) conds.push(isNotNull(simpleInvoicesTable.receiptNumber) as any);
    if (q.search) {
      conds.push(or(
        ilike(simpleInvoicesTable.number, `%${q.search}%`),
        ilike(simpleInvoicesTable.tenantName, `%${q.search}%`),
        ilike(simpleInvoicesTable.receiptNumber, `%${q.search}%`),
        ilike(contractsTable.contractNumber, `%${q.search}%`),
      ) as any);
    }
    const where = and(...conds);
    const statsConds: any[] = [base];
    if (types) statsConds.push(inArray(simpleInvoicesTable.type, types as any));
    else if (type) statsConds.push(eq(simpleInvoicesTable.type, type as any));
    if (contractIds && contractIds.length > 0) statsConds.push(inArray(simpleInvoicesTable.contractId, contractIds));
    if (excludeVouchers) statsConds.push(notVoucherCond as any);
    else if (excludeDeposit) statsConds.push(notDepositCond as any);
    const statsWhere = and(...statsConds);

    const [rows, totalRow, statsRows] = await Promise.all([
      this.db.select({ ...getTableColumns(simpleInvoicesTable), contractNumber: contractsTable.contractNumber })
        .from(simpleInvoicesTable)
        .leftJoin(contractsTable, eq(simpleInvoicesTable.contractId, contractsTable.id))
        .where(where)
        .orderBy((q.order === "asc" ? asc : desc)(simpleInvoicesTable.createdAt), desc(simpleInvoicesTable.id))
        .limit(q.pageSize).offset((q.page - 1) * q.pageSize),
      this.db.select({ total: count() }).from(simpleInvoicesTable)
        .leftJoin(contractsTable, eq(simpleInvoicesTable.contractId, contractsTable.id)).where(where),
      this.db.select({ status: simpleInvoicesTable.status, cnt: count(), amount: sum(simpleInvoicesTable.total) })
        .from(simpleInvoicesTable).where(statsWhere).groupBy(simpleInvoicesTable.status),
    ]);
    const stats: Record<string, number> = { draftCount: 0, draftAmount: 0, confirmedCount: 0, confirmedAmount: 0 };
    for (const s of statsRows as any[]) {
      if (s.status === "draft") { stats.draftCount = Number(s.cnt); stats.draftAmount = round2(Number(s.amount ?? 0)); }
      else if (s.status === "confirmed") { stats.confirmedCount = Number(s.cnt); stats.confirmedAmount = round2(Number(s.amount ?? 0)); }
    }
    const total = Number(totalRow[0]?.total ?? 0);
    // Per-invoice collected amount (sum of collections recorded against it).
    const ids = (rows as Array<{ id: number }>).map((r) => r.id);
    const collAgg = ids.length
      ? await this.db.select({ invoiceId: paymentCollectionsTable.invoiceId, total: sum(paymentCollectionsTable.amount) })
          .from(paymentCollectionsTable).where(inArray(paymentCollectionsTable.invoiceId, ids))
          .groupBy(paymentCollectionsTable.invoiceId)
      : [];
    const collMap = new Map((collAgg as Array<{ invoiceId: number | null; total: string | null }>).map((c) => [c.invoiceId, Number(c.total ?? 0)]));
    // Amount collected under each invoice's OWN receipt-voucher number — used by
    // the Receipt Vouchers page so a voucher reflects THAT collection (e.g. the
    // remaining balance after an advance), not the full invoice total. A
    // standalone voucher doc (kind receipt/deposit) IS its own amount (total).
    const voucherAgg = ids.length
      ? await this.db.select({ invoiceId: paymentCollectionsTable.invoiceId, receiptNumber: paymentCollectionsTable.receiptNumber, total: sum(paymentCollectionsTable.amount) })
          .from(paymentCollectionsTable).where(inArray(paymentCollectionsTable.invoiceId, ids))
          .groupBy(paymentCollectionsTable.invoiceId, paymentCollectionsTable.receiptNumber)
      : [];
    const voucherMap = new Map<string, number>();
    for (const v of voucherAgg as Array<{ invoiceId: number | null; receiptNumber: string | null; total: string | null }>) {
      if (v.invoiceId != null && v.receiptNumber) voucherMap.set(`${v.invoiceId}|${v.receiptNumber}`, Number(v.total ?? 0));
    }

    // Per-invoice net of confirmed credit/debit notes that REFERENCE it (by
    // number). The original tax invoice is immutable (ZATCA) — so its `total`
    // stays the gross issued amount, and the NET obligation is computed here:
    //   netTotal = total − Σ credit notes + Σ debit notes
    // This is how the value is "reflected" without ever rewriting the invoice.
    const invNumbers = (rows as any[]).filter((r) => r.type === "invoice").map((r) => r.number as string);
    const noteAgg = invNumbers.length
      ? await this.db.select({ ref: simpleInvoicesTable.billingReference, type: simpleInvoicesTable.type, total: sum(simpleInvoicesTable.total) })
          .from(simpleInvoicesTable)
          .where(and(base, inArray(simpleInvoicesTable.type, ["credit", "debit"] as any),
            eq(simpleInvoicesTable.status, "confirmed"), inArray(simpleInvoicesTable.billingReference, invNumbers)))
          .groupBy(simpleInvoicesTable.billingReference, simpleInvoicesTable.type)
      : [];
    const noteMap = new Map<string, number>();
    for (const n of noteAgg as Array<{ ref: string | null; type: string; total: string | null }>) {
      if (!n.ref) continue;
      const signed = (n.type === "credit" ? -1 : 1) * Number(n.total ?? 0);
      noteMap.set(n.ref, round2((noteMap.get(n.ref) ?? 0) + signed));
    }
    // The note NUMBERS per invoice — for the plain "this invoice has note X" line
    // shown at the bottom of the invoice document (the modal renders this list
    // row, so relatedNotes must be attached here, not only on the single GET).
    const noteRows = invNumbers.length
      ? await this.db.select({ number: simpleInvoicesTable.number, ref: simpleInvoicesTable.billingReference, type: simpleInvoicesTable.type })
          .from(simpleInvoicesTable)
          .where(and(base, inArray(simpleInvoicesTable.type, ["credit", "debit"] as any),
            eq(simpleInvoicesTable.status, "confirmed"), inArray(simpleInvoicesTable.billingReference, invNumbers)))
      : [];
    const notesByInvoice = new Map<string, { number: string; type: string }[]>();
    for (const n of noteRows as Array<{ number: string; ref: string | null; type: string }>) {
      if (!n.ref) continue;
      const arr = notesByInvoice.get(n.ref) ?? [];
      arr.push({ number: n.number, type: n.type });
      notesByInvoice.set(n.ref, arr);
    }

    // Link deposit/advance vouchers to the rent invoice that covers the same
    // installment. A voucher is collected against a payment (r.paymentId); once
    // the first installment invoice is approved, its paymentIds cover that
    // payment — so the Receipt Vouchers page can show the invoice number on the
    // advance voucher (instead of "—").
    const voucherPayIds = (rows as any[])
      .filter((r) => (r.kind === "receipt" || r.kind === "deposit") && r.paymentId != null)
      .map((r) => Number(r.paymentId));
    const payToInvoice = new Map<number, string>();
    if (voucherPayIds.length) {
      const rentInvs = await this.db
        .select({ number: simpleInvoicesTable.number, paymentId: simpleInvoicesTable.paymentId, paymentIds: simpleInvoicesTable.paymentIds })
        .from(simpleInvoicesTable)
        .where(and(base, eq(simpleInvoicesTable.type, "invoice"), isNull(simpleInvoicesTable.kind), eq(simpleInvoicesTable.status, "confirmed")));
      for (const inv of rentInvs as any[]) {
        const pids: number[] = Array.isArray(inv.paymentIds) && inv.paymentIds.length
          ? inv.paymentIds.map((n: any) => Number(n))
          : inv.paymentId != null ? [Number(inv.paymentId)] : [];
        for (const pid of pids) if (!payToInvoice.has(pid)) payToInvoice.set(pid, inv.number);
      }
    }

    const data = (rows as any[]).map((r) => {
      const collected = round2(collMap.get(r.id) ?? 0);
      const isVoucherDoc = r.kind === "receipt" || r.kind === "deposit";
      const linkedInvoiceNumber = isVoucherDoc && r.paymentId != null ? payToInvoice.get(Number(r.paymentId)) ?? null : null;
      const voucherAmount = isVoucherDoc
        ? round2(Number(r.total))
        : (r.receiptNumber ? round2(voucherMap.get(`${r.id}|${r.receiptNumber}`) ?? collected) : collected);
      const notesAdjustment = r.type === "invoice" ? round2(noteMap.get(r.number) ?? 0) : 0;
      const netTotal = round2(Number(r.total) + notesAdjustment);
      const balanceDue = Math.max(0, round2(netTotal - collected));
      const relatedNotes = r.type === "invoice" ? notesByInvoice.get(r.number) ?? [] : [];
      return { ...r, collectedAmount: collected, voucherAmount, notesAdjustment, netTotal, balanceDue, linkedInvoiceNumber, relatedNotes };
    });
    return { data, page: q.page, pageSize: q.pageSize, total, stats };
  }

  /**
   * Everyone this account has billed, derived from the invoices themselves —
   * there is no customers table, and there deliberately isn't one: an invoice
   * already carries the party it was raised against, so a separate list could
   * only drift from it. Raising an invoice for someone new is what adds them.
   *
   * Grouped by the strongest identifier present (VAT number, then phone, then
   * email, then the normalised name), so the same person entered twice with a
   * typo'd name still lands on one card if they share a VAT number or phone.
   */
  @Get("customers")
  @RequirePermissions(PERMISSIONS.INVOICES_VIEW)
  async customers(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const rows = await this.db
      .select({
        id: simpleInvoicesTable.id,
        number: simpleInvoicesTable.number,
        type: simpleInvoicesTable.type,
        status: simpleInvoicesTable.status,
        kind: simpleInvoicesTable.kind,
        tenantId: simpleInvoicesTable.tenantId,
        tenantName: simpleInvoicesTable.tenantName,
        client: simpleInvoicesTable.client,
        total: simpleInvoicesTable.total,
        issueDate: simpleInvoicesTable.issueDate,
      })
      .from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.userId, scopeId(user)), isNull(simpleInvoicesTable.deletedAt)))
      .orderBy(desc(simpleInvoicesTable.issueDate), desc(simpleInvoicesTable.id));

    type Customer = {
      key: string; name: string; kind: string;
      phone: string | null; email: string | null; address: string | null; vatNumber: string | null;
      // Structured national address. Only an external (non-tenant, non-landlord)
      // buyer carries it on the invoice — for everyone else it lives on their
      // own record, and re-serving a stale copy from here would fight it.
      region: string | null; city: string | null; district: string | null; street: string | null;
      buildingNumber: string | null; additionalNumber: string | null; postalCode: string | null;
      tenantId: number | null;
      invoiceCount: number; totalAmount: number; lastIssueDate: string | null;
      invoices: Array<{ id: number; number: string; type: string; status: string; total: number; issueDate: string | null }>;
    };
    const byKey = new Map<string, Customer>();
    const blankStr = (v: unknown) => { const x = (v ?? "").toString().trim(); return x || null; };

    for (const r of rows) {
      const c = (r.client ?? {}) as Record<string, any>;
      const name = String(r.tenantName ?? c.name ?? "").trim();
      const vat = String(c.vatNumber ?? "").trim();
      const phone = String(c.phone ?? "").trim();
      const email = String(c.email ?? "").trim().toLowerCase();
      // An invoice with nothing identifying the buyer can't be attributed.
      if (!name && !vat && !phone && !email) continue;
      const key = vat ? `v:${vat}` : phone ? `p:${phone}` : email ? `e:${email}` : `n:${name.toLowerCase()}`;

      let cur = byKey.get(key);
      if (!cur) {
        cur = {
          key,
          name: name || vat || phone || email,
          // `kind` is stamped on new documents; older rows only tell us whether
          // a tenant was linked, so fall back to that rather than guessing.
          kind: String(c.kind ?? (r.tenantId ? "tenant" : r.kind === "commission" ? "landlord" : "other")),
          phone: phone || null, email: email || null,
          address: (c.address ? String(c.address) : null), vatNumber: vat || null,
          region: blankStr(c.region), city: blankStr(c.city), district: blankStr(c.district),
          street: blankStr(c.street), buildingNumber: blankStr(c.buildingNumber),
          additionalNumber: blankStr(c.additionalNumber), postalCode: blankStr(c.postalCode),
          tenantId: r.tenantId ?? null,
          invoiceCount: 0, totalAmount: 0, lastIssueDate: null, invoices: [],
        };
        byKey.set(key, cur);
      }
      // Rows arrive newest-first, so the first sighting holds the freshest
      // contact details; only fill what is still missing.
      cur.phone ??= phone || null;
      cur.email ??= email || null;
      cur.address ??= c.address ? String(c.address) : null;
      cur.vatNumber ??= vat || null;
      cur.region ??= blankStr(c.region);
      cur.city ??= blankStr(c.city);
      cur.district ??= blankStr(c.district);
      cur.street ??= blankStr(c.street);
      cur.buildingNumber ??= blankStr(c.buildingNumber);
      cur.additionalNumber ??= blankStr(c.additionalNumber);
      cur.postalCode ??= blankStr(c.postalCode);
      cur.tenantId ??= r.tenantId ?? null;
      cur.invoiceCount += 1;
      // Credit notes reduce what the customer was billed.
      cur.totalAmount += (r.type === "credit" ? -1 : 1) * (Number(r.total) || 0);
      if (!cur.lastIssueDate && r.issueDate) cur.lastIssueDate = r.issueDate;
      cur.invoices.push({
        id: r.id, number: r.number, type: r.type, status: r.status,
        total: Number(r.total) || 0, issueDate: r.issueDate,
      });
    }

    let list = [...byKey.values()]
      .map((c) => ({ ...c, totalAmount: Math.round((c.totalAmount + Number.EPSILON) * 100) / 100 }))
      .sort((a, b) => (b.lastIssueDate ?? "").localeCompare(a.lastIssueDate ?? "") || b.invoiceCount - a.invoiceCount);

    // Search and paging happen after the grouping, not before it: a customer is
    // only a customer once their invoices have been folded together by the
    // identifier precedence above, so there is nothing to page until then.
    // The account's invoices are still all read to build that — the same cost
    // as before this endpoint took any parameters.
    const search = typeof rawQuery?.search === "string" ? rawQuery.search.trim().toLowerCase() : "";
    if (search) {
      list = list.filter((c) =>
        [c.name, c.vatNumber, c.phone, c.email, c.city]
          .some((v) => v != null && String(v).toLowerCase().includes(search)));
    }
    if (!wantsPagination(rawQuery)) return list;
    const q = listQuerySchema.parse(rawQuery ?? {});
    const { limit, offset } = pageBounds(q);
    return {
      data: list.slice(offset, offset + limit),
      page: q.page, pageSize: q.pageSize, total: list.length,
    };
  }

  /**
   * GET /simple-invoices/readiness — "could this contract's invoice be saved,
   * and could it be approved?", answered without creating anything. The reply
   * carries both verdicts: `draftOk` (the parties' own data, which create()
   * refuses on) and `ok` (that plus the landlord's ZATCA link, which approve()
   * refuses on). So the user learns BEFORE filling the form both that a field
   * is missing and that the document will not be approvable until ZATCA is
   * linked. The create response repeats the same object as an advisory.
   *
   * NOTE: every STATIC path under this controller must be declared ABOVE
   * `@Get(":id")` — Nest matches routes in declaration order, so ":id" claims
   * anything that reaches it first. `readiness` sat below it and every call
   * 500'd (parseInt("readiness") → NaN), which silently disabled the invoice
   * readiness gate in the UI.
   */
  @Get("readiness")
  @RequirePermissions(PERMISSIONS.INVOICES_VIEW)
  async readiness(
    @CurrentUser() user: AuthUser,
    @Query("contractId") contractId?: string,
    @Query("paymentId") paymentId?: string,
    @Query("tenantId") buyerTenantId?: string,
    @Query("ownerId") buyerOwnerId?: string,
  ) {
    const uid = scopeId(user);
    let id = foreignKeyId(contractId, "رقم العقد");
    // "Create invoice from installment" only knows the payment — resolve its
    // contract here so the UI can pre-check from that entry point too, instead
    // of discovering the problem when the user hits save.
    const payId = foreignKeyId(paymentId, "رقم القسط");
    if (id == null && payId != null) {
      const [pay] = await this.db
        .select({ contractId: paymentsTable.contractId })
        .from(paymentsTable)
        .where(and(eq(paymentsTable.id, payId), eq(paymentsTable.userId, uid)))
        .limit(1);
      id = pay?.contractId ?? null;
    }
    // A free invoice has no contract, so the buyer has to be named in the query
    // for the pre-check to have anything to look at. The external customer typed
    // into the form cannot be pre-checked at all — the create call refuses that
    // one and returns the same payload.
    return checkInvoiceReadiness(this.db, uid, Number.isFinite(id as number) ? id : null, {
      tenantId: foreignKeyId(buyerTenantId, "رقم المستأجر"),
      ownerId: foreignKeyId(buyerOwnerId, "رقم المؤجر"),
      client: buyerOwnerId ? { kind: "landlord" } : null,
    });
  }

  /**
   * Net effect of the confirmed credit/debit notes that reference an invoice:
   * −Σ credit +Σ debit. The original document is immutable (ZATCA), so what is
   * actually owed on it is `total` plus this figure — and every path that
   * reasons about that obligation (the read handlers, the collection cap) has
   * to agree on one number, which is why it lives here rather than being
   * rebuilt per handler.
   */
  private async notesAdjustmentFor(uid: number, doc: { type: string; number: string }): Promise<number> {
    if (doc.type !== "invoice") return 0;
    const [c] = await this.db.select({ total: sum(simpleInvoicesTable.total) }).from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.userId, uid), eq(simpleInvoicesTable.type, "credit"),
        eq(simpleInvoicesTable.billingReference, doc.number), eq(simpleInvoicesTable.status, "confirmed"), isNull(simpleInvoicesTable.deletedAt)));
    const [d] = await this.db.select({ total: sum(simpleInvoicesTable.total) }).from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.userId, uid), eq(simpleInvoicesTable.type, "debit"),
        eq(simpleInvoicesTable.billingReference, doc.number), eq(simpleInvoicesTable.status, "confirmed"), isNull(simpleInvoicesTable.deletedAt)));
    return round2(-Number(c?.total ?? 0) + Number(d?.total ?? 0));
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.INVOICES_VIEW)
  async get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const [doc] = await this.db.select().from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.id, requiredForeignKeyId(id, "رقم المستند")), eq(simpleInvoicesTable.userId, scopeId(user)), isNull(simpleInvoicesTable.deletedAt)));
    if (!doc) throw new NotFoundException("Document not found");
    const uid = scopeId(user);
    const [agg] = await this.db.select({ total: sum(paymentCollectionsTable.amount) })
      .from(paymentCollectionsTable).where(eq(paymentCollectionsTable.invoiceId, doc.id));
    const collected = round2(Number(agg?.total ?? 0));
    // Net of confirmed credit/debit notes referencing this invoice (immutable).
    const notesAdjustment = await this.notesAdjustmentFor(uid, doc);
    const netTotal = round2(Number(doc.total) + notesAdjustment);
    const balanceDue = Math.max(0, round2(netTotal - collected));
    // Numbers of the confirmed credit/debit notes referencing this invoice — a
    // plain "this invoice has note X" hint (no amount) shown on the invoice.
    let relatedNotes: { number: string; type: string }[] = [];
    if (doc.type === "invoice") {
      relatedNotes = await this.db.select({ number: simpleInvoicesTable.number, type: simpleInvoicesTable.type })
        .from(simpleInvoicesTable)
        .where(and(eq(simpleInvoicesTable.userId, uid),
          inArray(simpleInvoicesTable.type, ["credit", "debit"]),
          eq(simpleInvoicesTable.billingReference, doc.number),
          eq(simpleInvoicesTable.status, "confirmed"), isNull(simpleInvoicesTable.deletedAt)));
    }
    return { ...doc, collectedAmount: collected, notesAdjustment, netTotal, balanceDue, relatedNotes };
  }

  /**
   * Create a billing document. It is always saved as a DRAFT, and it refuses on
   * HALF the invoice-readiness verdict: the parties' own data (`draftBlockers`)
   * is required here, while the landlord's ZATCA link is left to approve() —
   * see the note further down for why the line is drawn there. Everything else
   * the request has to satisfy (line-item totals, non-negative figures, a
   * resolvable credit/debit reference, a known `kind`) is unchanged and still
   * enforced here.
   */
  @Post()
  @RequirePermissions(PERMISSIONS.INVOICES_WRITE)
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    const type = DOC_TYPES.includes(body?.type) ? body.type : "invoice";
    const items = normalizeItems(body?.items);
    const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));
    const total = body?.total != null ? round2(Number(body.total)) : subtotal;
    assertNonNegative(items, total);
    assertTotalMatchesItems(items, total);
    // An explicit number wins; otherwise it's generated atomically below.
    const explicitNumber = (body?.number && String(body.number).trim()) || null;

    // If linked to an installment, snapshot tenant/contract from it. Every id
    // off the body is range-checked before it is used as a key — these columns
    // are int4, so an oversized id was a driver error rather than a miss.
    let contractId = foreignKeyId(body?.contractId, "رقم العقد");
    let tenantId = foreignKeyId(body?.tenantId, "رقم المستأجر");
    let tenantName = body?.tenantName ?? null;
    let client = body?.client ?? null;
    const bodyPaymentId = foreignKeyId(body?.paymentId, "رقم القسط");
    // An invoice covering several same-day installments arrives as `paymentIds`
    // with no single `paymentId`. Only the singular was read here, so such a
    // document ended up with contractId null — and a null contract makes the
    // readiness check vacuous, which silently switched the whole ZATCA gate
    // off for that document. Fall back to the first of the list.
    const snapshotPaymentId = bodyPaymentId
      ?? (Array.isArray(body?.paymentIds)
        ? (body.paymentIds.map((n: any) => foreignKeyId(n, "رقم القسط"))
            .find((n: number | null) => n != null) ?? null)
        : null);
    if (snapshotPaymentId != null) {
      const [pay] = await this.db.select({ contractId: paymentsTable.contractId, tenantName: contractsTable.tenantName, tenantId: contractsTable.tenantId })
        .from(paymentsTable).leftJoin(contractsTable, eq(paymentsTable.contractId, contractsTable.id))
        .where(and(eq(paymentsTable.id, snapshotPaymentId), eq(paymentsTable.userId, scopeId(user))));
      if (pay) { contractId = contractId ?? pay.contractId; tenantId = tenantId ?? pay.tenantId; tenantName = tenantName ?? pay.tenantName; }
    }
    // Credit/debit note: snapshot client + contract from the referenced invoice
    // (the note's parties come from the invoice, not entered manually).
    //
    // The reference is what gives the note its meaning, so it is required and
    // must resolve. A note that references nothing — or a number that doesn't
    // exist, or a draft that was never issued — is a standalone amount the
    // reports still net into revenue: it subtracts from money that was never
    // billed and, having no buyer to snapshot, files itself under a nameless
    // customer. A credit note is likewise bounded by the invoice it corrects:
    // you cannot refund more than was charged.
    if (type === "credit" || type === "debit") {
      const ref = body?.billingReference != null ? String(body.billingReference).trim() : "";
      if (!ref) throw new BadRequestException("يجب ربط الإشعار برقم الفاتورة الأصلية");
      const [refInv] = await this.db.select({
        contractId: simpleInvoicesTable.contractId, tenantId: simpleInvoicesTable.tenantId,
        tenantName: simpleInvoicesTable.tenantName, client: simpleInvoicesTable.client,
        total: simpleInvoicesTable.total, status: simpleInvoicesTable.status,
      }).from(simpleInvoicesTable).where(and(
        eq(simpleInvoicesTable.userId, scopeId(user)), eq(simpleInvoicesTable.type, "invoice"),
        eq(simpleInvoicesTable.number, ref), isNull(simpleInvoicesTable.deletedAt),
      ));
      if (!refInv) throw new BadRequestException(`لا توجد فاتورة بالرقم ${ref}`);
      if (refInv.status !== "confirmed") throw new BadRequestException(`الفاتورة ${ref} غير معتمدة — لا يمكن إصدار إشعار عليها`);
      contractId = contractId ?? refInv.contractId;
      tenantId = tenantId ?? refInv.tenantId;
      tenantName = refInv.tenantName ?? tenantName;
      client = refInv.client ?? client;
      if (type === "credit") {
        const [prior] = await this.db.select({ total: sum(simpleInvoicesTable.total) }).from(simpleInvoicesTable)
          .where(and(eq(simpleInvoicesTable.userId, scopeId(user)), eq(simpleInvoicesTable.type, "credit"),
            eq(simpleInvoicesTable.billingReference, ref), eq(simpleInvoicesTable.status, "confirmed"),
            isNull(simpleInvoicesTable.deletedAt)));
        const creditable = round2(round2(Number(refInv.total)) - round2(Number(prior?.total ?? 0)));
        if (creditable <= 0.01) throw new BadRequestException(`تم إصدار إشعارات دائنة بكامل قيمة الفاتورة ${ref}`);
        if (total > creditable + 0.01) {
          throw new BadRequestException(`قيمة الإشعار الدائن تتجاوز المتبقي من الفاتورة ${ref} (${creditable.toFixed(2)})`);
        }
      }
    }

    const paymentIds: number[] = Array.isArray(body?.paymentIds)
      ? body.paymentIds.map((n: any) => foreignKeyId(n, "رقم القسط")).filter((n: number | null): n is number => n != null)
      : (bodyPaymentId != null ? [bodyPaymentId] : []);

    // Only these sub-kinds are genuinely not tax invoices: a voucher is evidence
  // of money received, and a commission bill is the managing account invoicing
  // the landlord. Everything else — including a `kind` nobody recognises — is a
  // tax invoice and must face the readiness gate.
  //
  // The gates below used to read `!body?.kind`, so ANY value at all skipped
  // them. Staging holds 6 documents with kind "invoice" and 6 with "manual"
  // that were issued without the check ever running.
  // A security deposit (الوديعة/الضمان) is held trust money (amanat), never
    // revenue — collecting it must produce a receipt voucher (سند قبض), not a
    // tax invoice. If a linked installment is a deposit and the caller hasn't
    // explicitly opted to bill it (billDeposit), divert to a receipt voucher
    // (which also records the collection against the deposit installment).
    // An unrecognised `kind` used to be stored verbatim AND to skip the gates
    // below, so an arbitrary string bought an exemption. Refuse it instead.
    const docKind = body?.kind == null || String(body.kind).trim() === ""
      ? null
      : String(body.kind).trim();
    if (docKind != null && !KNOWN_DOC_KINDS.has(docKind)) {
      throw new BadRequestException(`نوع المستند غير معروف: ${docKind} · Unknown document kind`);
    }

    if (type === "invoice" && !isTaxExemptKind(docKind) && paymentIds.length && !body?.billDeposit) {
      const linked = await this.db.select({ description: paymentsTable.description })
        .from(paymentsTable)
        .where(and(inArray(paymentsTable.id, paymentIds), eq(paymentsTable.userId, scopeId(user))));
      if (linked.some((p) => p.description === DEPOSIT_DESC)) {
        return this.createReceiptVoucher(user, {
          amount: total, contractId, tenantId, tenantName, client,
          paidDate: body?.issueDate, method: body?.method, paymentIds,
          description: items[0]?.description || DEPOSIT_DESC,
          notes: body?.notes,
        });
      }
    }

    // Readiness at create time, in two halves — the split is the whole point.
    //
    //  · The PARTIES' data (name, e-mail, phone, ID/CR, VAT number, national
    //    address on both sides) is checked and REFUSED here. A draft written on
    //    top of a tenant with no ID or a landlord with no address is simply
    //    wrong data, and the moment to catch that is while the user is still on
    //    the form with the record one click away — not weeks later at approval.
    //  · The ZATCA LINK is NOT checked here. Linking is an account errand: a
    //    certificate and an OTP the taxpayer generates in the Fatoora portal,
    //    nothing the person drafting this invoice can do from this form. It
    //    would refuse to even write the document down for a reason unrelated to
    //    the document, so it stays on approve() — the action that actually
    //    signs and mirrors it to ZATCA.
    //
    // Both halves come from ONE checkInvoiceReadiness call; `draftBlockers` is
    // the first, `blockers` the second. The refusal below therefore names only
    // what the user can fix from here, while the full payload rides along so
    // the UI can also say "…and the landlord still needs to link ZATCA before
    // this can be approved".
    //
    // A failure to COMPUTE readiness is still non-fatal: a broken lookup must
    // not become an unexplained 500 on save. But it is no longer silent —
    // now that the verdict is normative, a null means the gate did not run,
    // and that has to be visible in the log rather than inferred from a
    // document nobody can approve later.
    let readiness: InvoiceReadiness | null = null;
    if (type === "invoice" && !isTaxExemptKind(docKind)) {
      try {
        readiness = await checkInvoiceReadiness(this.db, scopeId(user), contractId, {
          tenantId, ownerId: (client as any)?.ownerId ?? null, tenantName, client,
        });
      } catch (e) {
        // Never fail the save on a lookup error — but do not let it disappear
        // either. A null here now means the gate did not run at all, so a
        // recurring warning is the only way anyone finds out that the check has
        // quietly stopped protecting anything.
        readiness = null;
        this.logger.warn(
          `readiness check failed for contract ${contractId ?? "—"} — document saved UNGATED: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (readiness && !readiness.draftOk) {
        throw new BadRequestException({
          error: "invoice_not_ready",
          message: `لا يمكن حفظ الفاتورة — بيانات ناقصة: ${readinessMessage(readiness, "draft")}`,
          readiness,
        });
      }
    }

    // The `confirmations` acknowledgement (a tax invoice for an individual
    // tenant with no VAT number) is deliberately NOT collected here. It is a
    // statement about issuing the document, so it is taken at approve(); at
    // create it only rides along in the advisory payload below.

    // Generate the number + insert inside ONE transaction guarded by a per
    // (account, doc-type) advisory lock, so two invoices created at the same
    // moment (e.g. a rent invoice and a fee invoice for the same installment)
    // can't read the same MAX and end up with the same number. The lock is
    // released automatically when the transaction commits.
    const uid = scopeId(user);
    const typeKey = type === "credit" ? 2 : type === "debit" ? 3 : 1;
    const [doc] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${uid}, ${typeKey})`);
      const number = explicitNumber || (await this.nextNumber(tx, uid, type));
      return tx.insert(simpleInvoicesTable).values({
        userId: uid,
        number,
        type,
        status: "draft",
        contractId: contractId ?? null,
        paymentId: bodyPaymentId ?? (paymentIds[0] ?? null),
        paymentIds: paymentIds.length ? paymentIds : null,
        tenantId: tenantId ?? null,
        tenantName: tenantName ?? null,
        client: client ?? null,
        items,
        subtotal: subtotal.toFixed(2),
        total: total.toFixed(2),
        kind: docKind,
        issueDate: body?.issueDate || today(),
        dueDate: body?.dueDate || null,
        billingReference: body?.billingReference ?? null,
        notes: body?.notes ?? null,
      } as any).returning();
    });

    // NB: the paired commission invoice is NOT created here — it's spawned only
    // when this rent invoice is APPROVED (see approve()), so a commission never
    // sits next to a still-draft rent invoice.

    // Advance rent: the invoice is billed at the full payment face value, and
    // any prior collection on these installments (e.g. advance collected at
    // contract start) is brought onto the invoice so its remaining balance
    // reflects the advance instead of shrinking the invoice itself.
    if (type === "invoice" && !body?.kind && paymentIds.length) {
      await this.db.update(paymentCollectionsTable).set({ invoiceId: doc.id })
        .where(and(
          inArray(paymentCollectionsTable.paymentId, paymentIds),
          isNull(paymentCollectionsTable.invoiceId),
          eq(paymentCollectionsTable.userId, scopeId(user)),
        ));
    }
    // Reaching here means `draftOk` — so what rides along is the leftover: null
    // for a document the gate does not apply to, `{ ok: true, … }` for one that
    // is ready to approve outright, and, for one whose landlord has not linked
    // ZATCA yet, the same payload with that single blocker still standing. Same
    // shape GET /simple-invoices/readiness returns, so the UI renders it with
    // the same panel — as a heads-up about approval, not a failure to save.
    return { ...doc, readiness };
  }

  /**
   * Next commission-invoice number for an account: COM-000001, …
   *
   * MAX(sequence)+1 over the COM- prefix, for the same reason as `nextNumber`:
   * counting the rows that are still there hands the next document a number a
   * deleted one already spent, so two commissions end up sharing it.
   */
  private async nextCommissionNumber(userId: number): Promise<string> {
    const res: any = await this.db.execute(sql`
      select coalesce(max(cast(substring(${simpleInvoicesTable.number} from '[0-9]+$') as integer)), 0) as m
      from ${simpleInvoicesTable}
      where ${simpleInvoicesTable.userId} = ${userId} and ${simpleInvoicesTable.number} like ${"COM-%"}
    `);
    const rows = Array.isArray(res) ? res : (res?.rows ?? []);
    const max = Number(rows?.[0]?.m ?? 0);
    return `COM-${String(max + 1).padStart(6, "0")}`;
  }

  /**
   * When a rent invoice is issued for a contract whose property has a
   * management-fee %, create a paired commission invoice (فاتورة عمولة):
   * seller = the managing account, buyer = the property's landlord, amount =
   * the **pre-VAT rent** × the property's fee %. The commission base is the
   * rent only — service fees (gas, cleaning, …) are excluded — and VAT is
   * never part of the base. VAT is then applied on top of the commission when
   * the account is VAT-registered (its company carries a VAT number).
   */
  private async maybeCreateCommissionInvoice(uid: number, rentDoc: any, contractId: number) {
    const [propRow] = await this.db.select({ pct: propertiesTable.managementFeePercent })
      .from(contractUnitsTable)
      .innerJoin(unitsTable, eq(contractUnitsTable.unitId, unitsTable.id))
      .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
      .where(eq(contractUnitsTable.contractId, contractId)).limit(1);
    const pct = round2(Number(propRow?.pct ?? 0));
    if (!(pct > 0)) return null;

    const [c] = await this.db.select({
      landlordName: contractsTable.landlordName, landlordPhone: contractsTable.landlordPhone,
      landlordEmail: contractsTable.landlordEmail, landlordAddress: contractsTable.landlordAddress,
      landlordTaxNumber: contractsTable.landlordTaxNumber,
    }).from(contractsTable).where(eq(contractsTable.id, contractId));
    if (!c) return null;

    const [u] = await this.db.select({ companyId: usersTable.companyId })
      .from(usersTable).where(eq(usersTable.id, uid)).limit(1);
    // The commission seller (the management account) charges VAT when it is
    // VAT-registered — either via its company record OR, for an individual
    // account with no company, via its default landlord owner's tax number.
    let vatReg = false;
    if (u?.companyId) {
      const [comp] = await this.db.select({ vat: companiesTable.vatNumber })
        .from(companiesTable).where(eq(companiesTable.id, u.companyId)).limit(1);
      vatReg = !!(comp?.vat && String(comp.vat).trim());
    }
    if (!vatReg) {
      const [defOwner] = await this.db.select({ tax: ownersTable.taxNumber })
        .from(ownersTable)
        .where(and(eq(ownersTable.userId, uid), eq(ownersTable.isDefault, true), isNull(ownersTable.deletedAt)))
        .limit(1);
      vatReg = !!(defOwner?.tax && String(defOwner.tax).trim());
    }
    // Business rule: a property-management commission invoice ALWAYS carries
    // 15% VAT, regardless of the seller's VAT-registration status.
    vatReg = true;

    // Commission base = pre-VAT RENT only. Rent installments have a null
    // description; service-fee installments carry a name and are excluded.
    // Installment amounts are VAT-inclusive when the contract has VAT, so we
    // strip the 15% back off to land on the net rent.
    const payIds: number[] = (rentDoc.paymentIds && rentDoc.paymentIds.length)
      ? rentDoc.paymentIds.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
      : (rentDoc.paymentId ? [Number(rentDoc.paymentId)] : []);
    let base = 0;
    if (payIds.length) {
      const pays = await this.db.select().from(paymentsTable)
        .where(and(inArray(paymentsTable.id, payIds), eq(paymentsTable.userId, uid)));
      for (const p of pays) {
        if (p.description) continue;                    // rent rows only (no description)
        const amt = round2(Number(p.amount));
        base = round2(base + (p.vatEnabled ? round2(amt / 1.15) : amt));
      }
    }
    if (!(base > 0)) return null;
    const commissionNet = round2((base * pct) / 100);
    if (commissionNet <= 0) return null;
    const total = vatReg ? round2(commissionNet * 1.15) : commissionNet;
    const number = await this.nextCommissionNumber(uid);

    const [comm] = await this.db.insert(simpleInvoicesTable).values({
      userId: uid, number, type: "invoice", kind: "commission", status: "draft",
      contractId,
      tenantId: null, tenantName: c.landlordName ?? null,
      client: {
        phone: c.landlordPhone ?? undefined, email: c.landlordEmail ?? undefined,
        address: c.landlordAddress ?? undefined, vatNumber: c.landlordTaxNumber ?? undefined,
      },
      items: [{ description: "عمولة إدارة الأملاك", quantity: 1, unitPrice: commissionNet, amount: commissionNet, vat: vatReg }],
      subtotal: commissionNet.toFixed(2), total: total.toFixed(2),
      issueDate: today(), dueDate: rentDoc.dueDate ?? null,
      billingReference: rentDoc.number,
      notes: `عمولة إدارة بنسبة ${pct}% على الفاتورة ${rentDoc.number}`,
    } as any).returning();
    return comm ?? null;
  }

  /**
   * Create a standalone receipt voucher (سند قبض) — a confirmed + collected
   * invoice issued directly (money already received), optionally linked to a
   * contract. Produces an RV number immediately.
   */
  @Post("receipt-voucher")
  @RequirePermissions(PERMISSIONS.INVOICES_WRITE)
  async createReceiptVoucher(@CurrentUser() user: AuthUser, @Body() body: any) {
    const uid = scopeId(user);
    const amount = round2(Number(body?.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException("المبلغ غير صالح");
    const paidDate = body?.paidDate || today();
    const method = body?.method || "bank_transfer";
    const attachmentKey = body?.attachmentKey ?? null;

    // Optional installment link(s) — the voucher also records a collection
    // against each, so a deposit/fee/rent collected this way reflects its real
    // collected/remaining figures (no orphaned "paid but collected = 0").
    const singlePayId = foreignKeyId(body?.paymentId, "رقم القسط");
    const payIds: number[] = Array.isArray(body?.paymentIds)
      ? body.paymentIds.map((n: any) => foreignKeyId(n, "رقم القسط")).filter((n: number | null): n is number => n != null)
      : (singlePayId != null ? [singlePayId] : []);

    // Optional contract link — snapshot its number/tenant. Fall back to the
    // contract of the first linked installment when not given explicitly.
    let contractId: number | null = foreignKeyId(body?.contractId, "رقم العقد");
    let tenantName: string | null = body?.tenantName ?? null;
    let tenantId: number | null = foreignKeyId(body?.tenantId, "رقم المستأجر");
    if (contractId) {
      const [c] = await this.db.select({ id: contractsTable.id, tenantName: contractsTable.tenantName, tenantId: contractsTable.tenantId })
        .from(contractsTable).where(and(eq(contractsTable.id, contractId), eq(contractsTable.userId, uid)));
      if (!c) { contractId = null; } else { tenantName = tenantName || c.tenantName; tenantId = tenantId ?? c.tenantId; }
    } else if (payIds.length) {
      const [pay] = await this.db.select({ contractId: paymentsTable.contractId, tenantName: contractsTable.tenantName, tenantId: contractsTable.tenantId })
        .from(paymentsTable).leftJoin(contractsTable, eq(paymentsTable.contractId, contractsTable.id))
        .where(and(eq(paymentsTable.id, payIds[0]!), eq(paymentsTable.userId, uid)));
      if (pay) { contractId = pay.contractId; tenantName = tenantName || pay.tenantName; tenantId = tenantId ?? pay.tenantId; }
    }
    // A receipt voucher must belong to a contract.
    if (!contractId) throw new BadRequestException("العقد مطلوب لإصدار سند القبض");

    const items = Array.isArray(body?.items) && body.items.length
      ? normalizeItems(body.items)
      : [{ description: String(body?.description || "سند قبض").trim(), quantity: 1, unitPrice: amount, amount, vat: false }];
    const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));
    const voucher = await nextReceiptVoucherNumber(this.db, uid);
    // A receipt voucher is NOT an invoice — its document number IS the RV number;
    // it never consumes an INV-#### sequence.
    const number = voucher;

    // A voucher document is always kind = "receipt" (evidence). Whether it also
    // counts as a collection is decided by recording an actual payment-collection
    // below, NOT by the kind — so it never leaks into the Invoices list.
    const voucherKind = body?.kind ?? "receipt";
    const [doc] = await this.db.insert(simpleInvoicesTable).values({
      userId: uid, number, type: "invoice", kind: voucherKind, status: "confirmed",
      contractId: contractId ?? null, tenantId: tenantId ?? null, tenantName: tenantName ?? null,
      client: body?.client ?? null, items,
      subtotal: subtotal.toFixed(2), total: amount.toFixed(2),
      issueDate: paidDate, paidDate, confirmedAt: new Date(),
      receiptNumber: voucher, paymentMethod: method, notes: body?.notes ?? null,
      attachmentKey,
    } as any).returning();

    // Record the collection against the linked installment(s), distributing the
    // amount across their remaining balances and updating their paid status.
    if (payIds.length) {
      let left = amount;
      for (const pid of payIds) {
        if (left <= 0.01) break;
        const [payment] = await this.db.select().from(paymentsTable)
          .where(and(eq(paymentsTable.id, pid), eq(paymentsTable.userId, uid), isNull(paymentsTable.deletedAt)));
        if (!payment || payment.status === "cancelled") continue;
        const prior = await this.db.select({ total: sum(paymentCollectionsTable.amount) })
          .from(paymentCollectionsTable).where(eq(paymentCollectionsTable.paymentId, pid));
        const collectedBefore = round2(Number(prior[0]?.total ?? 0));
        const totalDue = round2(Number(payment.amount));
        const remaining = round2(totalDue - collectedBefore);
        if (remaining <= 0.01) continue;
        const amt = round2(Math.min(remaining, left));
        await this.db.insert(paymentCollectionsTable).values({
          paymentId: pid, userId: uid, amount: amt.toFixed(2), collectedDate: paidDate,
          method, receiptNumber: voucher, invoiceId: doc.id, attachmentKey,
          notes: body?.notes ?? `سند قبض ${voucher}`,
        } as any);
        const after = round2(collectedBefore + amt);
        const status = after >= totalDue - 0.01 ? "paid" : "partially_paid";
        await this.db.update(paymentsTable).set({
          status, paidDate: status === "paid" ? paidDate : payment.paidDate, receiptNumber: voucher,
        }).where(eq(paymentsTable.id, pid));
        left = round2(left - amt);
      }
    } else if (body?.countAsCollection) {
      // "Add collection" (not tied to a specific installment): apply the amount
      // to the contract's UNPAID installments — fees first, then rent, oldest
      // first — so a collected fee/rent installment flips to paid/partial and no
      // longer shows as "pending" (the bug this fixes). Any remainder that the
      // schedule can't absorb is recorded as a standalone collection so the
      // money is still counted in the Collections tab.
      let left = amount;
      const unpaid = await this.db.select().from(paymentsTable)
        .where(and(
          eq(paymentsTable.contractId, contractId),
          eq(paymentsTable.userId, uid),
          isNull(paymentsTable.deletedAt),
          inArray(paymentsTable.status, ["pending", "overdue", "partially_paid"] as any),
        ))
        // Fee rows carry a non-null description; rent rows are null → DESC puts
        // fees first, then rent. Within each, oldest due date first.
        .orderBy(desc(paymentsTable.description), asc(paymentsTable.dueDate));
      for (const payment of unpaid) {
        if (left <= 0.01) break;
        const prior = await this.db.select({ total: sum(paymentCollectionsTable.amount) })
          .from(paymentCollectionsTable).where(eq(paymentCollectionsTable.paymentId, payment.id));
        const collectedBefore = round2(Number(prior[0]?.total ?? 0));
        const totalDue = round2(Number(payment.amount));
        const remaining = round2(totalDue - collectedBefore);
        if (remaining <= 0.01) continue;
        const amt = round2(Math.min(remaining, left));
        await this.db.insert(paymentCollectionsTable).values({
          paymentId: payment.id, userId: uid, amount: amt.toFixed(2), collectedDate: paidDate,
          method, receiptNumber: voucher, invoiceId: doc.id, attachmentKey,
          notes: body?.notes ?? `سند قبض ${voucher}`,
        } as any);
        const after = round2(collectedBefore + amt);
        const status = after >= totalDue - 0.01 ? "paid" : "partially_paid";
        await this.db.update(paymentsTable).set({
          status, paidDate: status === "paid" ? paidDate : payment.paidDate, receiptNumber: voucher,
        }).where(eq(paymentsTable.id, payment.id));
        left = round2(left - amt);
      }
      // Remainder the installments couldn't absorb → standalone collection.
      if (left > 0.01) {
        await this.db.insert(paymentCollectionsTable).values({
          paymentId: null, userId: uid, amount: left.toFixed(2), collectedDate: paidDate,
          method, receiptNumber: voucher, invoiceId: doc.id, attachmentKey,
          notes: body?.notes ?? `سند قبض ${voucher}`,
        } as any);
      }
    }
    return doc;
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.INVOICES_WRITE)
  async update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    const [doc] = await this.db.select().from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.id, requiredForeignKeyId(id, "رقم المستند")), eq(simpleInvoicesTable.userId, scopeId(user)), isNull(simpleInvoicesTable.deletedAt)));
    if (!doc) throw new NotFoundException("Document not found");
    if (doc.status === "confirmed") throw new BadRequestException("لا يمكن تعديل مستند مؤكَّد");
    const patch: any = {};
    if (body?.items != null) {
      const items = normalizeItems(body.items);
      const total = body?.total != null ? round2(Number(body.total)) : round2(items.reduce((s, it) => s + it.amount, 0));
      assertNonNegative(items, total);
      assertTotalMatchesItems(items, total);
      patch.items = items;
      patch.subtotal = round2(items.reduce((s, it) => s + it.amount, 0)).toFixed(2);
      patch.total = total.toFixed(2);
    } else if (body?.total != null) {
      const total = round2(Number(body.total));
      assertNonNegative([], total);
      // A total sent on its own is still a total for THESE line items — the
      // stored ones. Without the merge this branch was the shortest route to a
      // document whose VAT is whatever the caller asked for.
      assertTotalMatchesItems(normalizeItems(doc.items), total);
      patch.total = total.toFixed(2);
    }
    for (const k of ["tenantName", "client", "issueDate", "dueDate", "notes", "billingReference"]) {
      if (body?.[k] !== undefined) patch[k] = body[k];
    }
    // The id fields on the same allowlist were copied through untouched — the
    // one place a PATCH could still put an out-of-range value into an int4
    // column. `null` still clears the link.
    for (const [k, label] of [["contractId", "رقم العقد"], ["tenantId", "رقم المستأجر"], ["paymentId", "رقم القسط"]] as const) {
      if (body?.[k] !== undefined) patch[k] = foreignKeyId(body[k], label);
    }
    if (body?.paymentIds !== undefined) {
      patch.paymentIds = Array.isArray(body.paymentIds)
        ? body.paymentIds.map((n: any) => foreignKeyId(n, "رقم القسط")).filter((n: number | null): n is number => n != null)
        : null;
    }
    const [updated] = await this.db.update(simpleInvoicesTable).set(patch)
      .where(and(eq(simpleInvoicesTable.id, doc.id), eq(simpleInvoicesTable.userId, scopeId(user)))).returning();
    return updated;
  }

  /**
   * Approve a document (اعتماد). An invoice is simply marked confirmed and
   * then awaits collection on the Collections page (no money moves here). A
   * credit/debit note immediately adjusts the invoice it references — and
   * that invoice's installment — so the original invoice becomes the
   * corrected one (مُعدَّلة وليست جديدة).
   */
  /** Persist the storage key of the PDF the web rendered for this document so
   *  the mobile app can download the exact same file. The web uploads the PDF
   *  via /api/uploads (→ key) then calls this on approve / voucher creation. */
  @Post(":id/pdf-key")
  @RequirePermissions(PERMISSIONS.INVOICES_WRITE)
  async setPdfKey(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    const uid = scopeId(user);
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    if (!key) throw new BadRequestException("key is required");
    const [updated] = await this.db.update(simpleInvoicesTable).set({ pdfKey: key } as any)
      .where(and(eq(simpleInvoicesTable.id, requiredForeignKeyId(id, "رقم المستند")), eq(simpleInvoicesTable.userId, uid), isNull(simpleInvoicesTable.deletedAt)))
      .returning({ id: simpleInvoicesTable.id });
    if (!updated) throw new NotFoundException("Document not found");
    return { ok: true };
  }

  @Post(":id/approve")
  @RequirePermissions(PERMISSIONS.INVOICES_WRITE)
  async approve(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    void body;
    const uid = scopeId(user);
    const [doc] = await this.db.select().from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.id, requiredForeignKeyId(id, "رقم المستند")), eq(simpleInvoicesTable.userId, uid), isNull(simpleInvoicesTable.deletedAt)));
    if (!doc) throw new NotFoundException("Document not found");
    if (doc.status === "confirmed") throw new BadRequestException("المستند معتمد مسبقاً");

    // Approval is where a draft becomes a real, issued document — the copy the
    // buyer keeps and the one mirrored to ZATCA. Everything the create path
    // refuses has to hold HERE too, against the row as it now stands: a draft
    // can be edited after it is created (and PATCH used to accept a bare
    // `total`), so a figure that create would never have taken could still walk
    // in through the edit and go live at approval.
    {
      const items = normalizeItems(doc.items);
      const total = round2(Number(doc.total));
      assertNonNegative(items, total);
      assertTotalMatchesItems(items, total);
    }

    // THE FULL invoice-readiness gate — the parties' data (which create() has
    // already refused on) AND the landlord's ZATCA link, which only this side
    // demands. Approval is the action that actually issues the document and
    // mirrors it to ZATCA, so it is the first point at which not being linked
    // matters; refusing to even save a draft over it would have blocked
    // bookkeeping on an errand that has nothing to do with the invoice.
    //
    // Re-running the party checks here is not redundant. Consequences of the
    // gate living on the action rather than on the row:
    //
    //  · a document created BEFORE this moved — while the landlord was still
    //    unlinked — is checked exactly like one created after it, because the
    //    check reads the records as they stand now, not as they stood then;
    //  · fixing the VAT number / national address / ZATCA onboarding unblocks
    //    every draft already sitting in the list, with nothing to re-create;
    //  · a document with no contract has no parties to validate against and
    //    checkInvoiceReadiness returns ok for it — approval is unaffected.
    //
    // Scope matches what create refused: tax invoices only. Receipt vouchers,
    // deposits and commission invoices are not tax invoices (isTaxExemptKind),
    // and a credit/debit note corrects an invoice that was already issued — it
    // must stay issuable, and its ZATCA mirror is best-effort either way.
    //
    // The refusal names EVERY blocker (readinessMessage joins them all), and
    // carries the full readiness payload under the same `invoice_not_ready`
    // code the create path used, so the client renders the same panel with the
    // same deep links — only now on approve.
    if (doc.type === "invoice" && !isTaxExemptKind(doc.kind)) {
      const readiness = await checkInvoiceReadiness(this.db, uid, doc.contractId ?? null, {
        tenantId: doc.tenantId ?? null,
        ownerId: (doc.client as any)?.ownerId ?? null,
        tenantName: doc.tenantName ?? null,
        client: (doc.client as any) ?? null,
      });
      if (!readiness.ok) {
        // A refused approval used to leave NO trace anywhere. From the
        // database it was indistinguishable from the landlord never having
        // tried — which is exactly the ambiguity that cost a day on owner 264:
        // we could not tell "he never pressed the button" from "he pressed it
        // and the gate refused him". `TODO.md` §3.3.
        //
        // Logged as a first-class event rather than left to the exception
        // filter's generic 400 row, because the interesting part is WHICH
        // blockers fired, and because 400s are otherwise not persisted at all.
        this.appLog.record({
          level: "warn",
          event: "invoice_approval_refused",
          status: 400,
          message: `approval refused for document ${doc.id}: ${readinessMessage(readiness)}`,
          context: "BillingZatca",
          meta: {
            documentId: doc.id,
            docType: doc.type,
            kind: doc.kind,
            contractId: doc.contractId ?? null,
            ownerId: (doc.client as any)?.ownerId ?? null,
            tenantId: doc.tenantId ?? null,
            blockers: readiness.blockers,
          },
        });
        throw new BadRequestException({
          error: "invoice_not_ready",
          message: `لا يمكن اعتماد الفاتورة — بيانات ناقصة: ${readinessMessage(readiness)}`,
          readiness,
        });
      }
      // Some situations are not blockers but must be acknowledged out loud —
      // a tax invoice for an individual tenant who has no VAT number. That
      // acknowledgement used to be collected when the document was created; it
      // lives here now because it is a statement about ISSUING the document,
      // not about writing it down. The client ticks the box and sends it in
      // the approve body under the same `confirmations` key the create path
      // accepted, so there is one contract rather than two.
      const acked = (body as any)?.confirmations ?? {};
      const unacknowledged = readiness.confirmations.filter((c) => acked[c.key] !== true);
      if (unacknowledged.length > 0) {
        // Same reasoning as the blocker refusal above: an unacknowledged
        // confirmation is still a refused approval, and it looks identical
        // from the database to a landlord who never tried.
        this.appLog.record({
          level: "warn",
          event: "invoice_approval_refused",
          status: 400,
          message: `approval refused for document ${doc.id}: unacknowledged confirmations`,
          context: "BillingZatca",
          meta: {
            documentId: doc.id,
            reason: "needs_confirmation",
            confirmations: unacknowledged.map((c) => c.key),
          },
        });
        throw new BadRequestException({
          error: "invoice_needs_confirmation",
          message: "يلزم تأكيد إصدار الفاتورة قبل الاعتماد",
          readiness,
          confirmations: unacknowledged,
        });
      }
    }

    const isNote = doc.type === "credit" || doc.type === "debit";
    if (isNote) {
      // A credit/debit note is a STANDALONE legal document. The original invoice
      // is immutable and is NOT touched at all (no figures, no paid flag, no
      // installment, no audit text) — approving the note simply confirms it and
      // mirrors it to ZATCA. Its financial effect is computed purely in the
      // Reports tab, which nets confirmed notes against the invoice
      // (invoiced = Σ invoices − Σ credit + Σ debit). The note keeps its own
      // CRN-/DBN- number and references the original via billingReference.
      const [updated] = await this.db.update(simpleInvoicesTable).set({
        status: "confirmed", confirmedAt: new Date(),
      }).where(and(eq(simpleInvoicesTable.id, doc.id), eq(simpleInvoicesTable.userId, uid))).returning();
      // Mirror the note to ZATCA under the landlord's seller (best-effort).
      const zatcaNote = await this.submitApprovedDocToZatca(uid, updated);
      return { ...updated, zatca: zatcaNote };
    }

    // Invoice — just approve; collection happens later on the Collections page.
    const [updated] = await this.db.update(simpleInvoicesTable).set({
      status: "confirmed", confirmedAt: new Date(),
    }).where(and(eq(simpleInvoicesTable.id, doc.id), eq(simpleInvoicesTable.userId, uid))).returning();

    // When the landlord (the seller) is linked to ZATCA, mirror this invoice to
    // ZATCA on approval — clearance for B2B, reporting for B2C. Best-effort:
    // never blocks the approval (see submitApprovedDocToZatca).
    const zatca = await this.submitApprovedDocToZatca(uid, updated);

    // A rent invoice spawns its paired commission invoice (فاتورة عمولة) only
    // once APPROVED — not at draft — so the commission surfaces alongside an
    // actually-issued rent invoice and is linked to it via billingReference.
    // Best-effort: never block the approval if the commission step fails.
    let commission: any = null;
    if (doc.kind !== "commission" && doc.contractId && ((doc.paymentIds && doc.paymentIds.length) || doc.paymentId)) {
      try { commission = await this.maybeCreateCommissionInvoice(uid, doc, Number(doc.contractId)); }
      catch { /* ignore — rent invoice already approved */ }
    }
    return { ...updated, commission, zatca };
  }

  /**
   * POST /simple-invoices/:id/submit-zatca
   * Manually (re)submit an already-approved document to ZATCA. For invoices that
   * were approved before the landlord was onboarded (or before auto-submit), or
   * whose earlier attempt failed. Idempotent: if it's already in ZATCA, returns
   * that instead of duplicating.
   */
  @Post(":id/submit-zatca")
  @RequirePermissions(PERMISSIONS.INVOICES_WRITE)
  async submitZatca(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const uid = scopeId(user);
    const [doc] = await this.db.select().from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.id, requiredForeignKeyId(id, "رقم المستند")), eq(simpleInvoicesTable.userId, uid), isNull(simpleInvoicesTable.deletedAt)));
    if (!doc) throw new NotFoundException("Document not found");
    if (doc.status !== "confirmed") throw new BadRequestException("اعتمد المستند قبل إرساله لهيئة الزكاة");
    // Already mirrored? Don't duplicate — report its current ZATCA status.
    const [existing] = await this.db.select({ status: invoicesTable.status, profile: invoicesTable.profile })
      .from(invoicesTable).where(and(eq(invoicesTable.userId, uid), eq(invoicesTable.invoiceNumber, doc.number), isNull(invoicesTable.deletedAt)));
    if (existing) {
      return { zatca: { submitted: true, status: existing.status, profile: existing.profile, environment: "", httpStatus: 0, invoiceId: 0, warnings: 0, alreadyExists: true } };
    }
    const zatca = await this.submitApprovedDocToZatca(uid, doc);
    return { zatca };
  }

  /** Run the ZATCA submission, then persist a concise outcome (status + error)
   *  on the document so clearance / reporting / skip / failure is visible in
   *  the app instead of vanishing. */
  private async submitApprovedDocToZatca(uid: number, doc: any): Promise<ZatcaSubmitOutcome> {
    const outcome = await this.runZatcaSubmission(uid, doc);
    try {
      const o = outcome as any;
      let status: string;
      let error: string | null = null;
      let qr: string | null = null;
      let zatcaInvoiceId: number | null = null;
      if (o.submitted) {
        // `submitted: true` means the CALL completed, not that ZATCA accepted
        // the document. This used to derive the status from the PROFILE alone —
        // "standard ⇒ cleared, otherwise reported" — so an invoice ZATCA
        // rejected, or answered 401 to, was stamped `cleared` with no error
        // recorded at all; `isSubmittedToZatca` then read that as proof it had
        // been filed and permanently blocked the contract rebuild over a
        // document ZATCA never accepted. Read what ZATCA actually said
        // (`invoices.status`, from deriveStatus) and claim success only for the
        // two values that mean it.
        // `submitted` is ZATCA accepting the document without a clearance or
        // reporting verdict — which is exactly what the compliance endpoint
        // returns, and sandbox AND simulation both submit there. Collapsing it
        // into `failed` would have stamped every accepted rehearsal as an
        // error. It travelled and it spent an ICV, so it counts as submitted;
        // it just is not a verdict.
        status = o.status === "cleared" ? "cleared"
          : o.status === "reported" ? "reported"
          : o.status === "submitted" ? "submitted"
          : "failed";
        if (status === "failed") {
          error = `ZATCA: ${o.status}${o.httpStatus ? ` (HTTP ${o.httpStatus})` : ""}`;
        }
        qr = typeof o.qr === "string" && o.qr.trim() ? o.qr : null;
        // Remember WHICH e-invoice this document became, so the PDF/A-3 copy
        // can find the cleared XML later.
        zatcaInvoiceId = Number.isFinite(o.invoiceId) ? Number(o.invoiceId) : null;
      } else {
        // `link_invalid` groups with the other "nothing was sent" codes on
        // purpose: no ICV was consumed and ZATCA holds no record of the
        // document, so it must stay re-submittable and must NOT block a
        // contract rebuild.
        status = o.code === "error" ? "failed"
          : (o.code === "not_linked" || o.code === "not_onboarded" || o.code === "link_invalid" || o.code === "chain_busy") ? "pending"
          : "skipped";
        error = o.reason ?? null;
      }
      await this.db.update(simpleInvoicesTable)
        // Only ever WRITE the QR — never blank an existing one. A later
        // re-submission that fails must not strip the signed QR off a document
        // that was already cleared.
        .set({
          zatcaStatus: status, zatcaError: error,
          ...(qr ? { zatcaQr: qr } : {}),
          ...(zatcaInvoiceId ? { zatcaInvoiceId } : {}),
        } as any)
        .where(and(eq(simpleInvoicesTable.id, Number(doc.id)), eq(simpleInvoicesTable.userId, uid)));
    } catch { /* status persistence is best-effort — never block approval */ }
    return outcome;
  }

  /**
   * Best-effort: mirror an approved billing document to ZATCA under the
   * property's landlord (the per-landlord seller), IF that landlord is onboarded
   * for the active environment. NEVER throws — a ZATCA failure (not onboarded,
   * duplicate number, validation, outage) must not block the approval. The
   * landlord's seller gets a real signed, submitted invoice on their side.
   */
  private async runZatcaSubmission(uid: number, doc: any): Promise<ZatcaSubmitOutcome> {
    try {
      // Commission invoices (فاتورة عمولة) are intentionally NOT sent to ZATCA.
      if (doc.kind === "commission") {
        return { submitted: false, code: "skipped", reason: "Commission invoices are not sent to ZATCA" };
      }
      // Resolve the landlord (owner) that is the ZATCA seller.
      const ownerId = await this.resolveOwnerId(uid, doc.contractId);

      // Only proceed if that seller is configured AND onboarded for its active env.
      const creds = await this.zatcaOnboarding.getCredentials(uid, ownerId);
      if (!creds) { this.logger.debug(`ZATCA: ${doc.number} skipped — seller not configured (ownerId=${ownerId})`); return { submitted: false, code: "not_linked", reason: "Landlord is not linked to ZATCA" }; }
      const env = creds.activeEnvironment;
      // The SAME definition the gate uses, not a looser local one. This tested
      // the certificate alone, so it disagreed with `isOnboarded` about a row
      // holding a cert but no key, and about a link ZATCA has revoked — and the
      // documents that skip the gate (credit/debit notes, tax-exempt kinds)
      // reach here directly, so the difference was reachable: a note under a
      // revoked link was submitted, 401'd, and recorded as a failure rather
      // than as the dead link it was.
      if (!isOnboarded(creds)) { this.logger.debug(`ZATCA: ${doc.number} skipped — landlord not onboarded for ${env}`); return { submitted: false, code: "not_onboarded", reason: `Landlord not onboarded for ${env}` }; }

      const contract = doc.contractId
        ? (await this.db.select().from(contractsTable)
            .where(and(eq(contractsTable.id, Number(doc.contractId)), eq(contractsTable.userId, uid))))[0] ?? null
        : null;

      const lines = this.zatcaLinesFromDoc(doc);
      if (!lines.length) { this.logger.debug(`ZATCA: ${doc.number} skipped — no line items`); return { submitted: false, code: "no_items", reason: "No line items to invoice" }; }
      // ZATCA e-invoicing is only required for TAXABLE supplies (standard 15% or
      // zero-rated). A document whose lines are all Exempt (e.g. residential rent)
      // or Out-of-scope is not required to be e-invoiced — skip cleanly instead of
      // submitting an invalid 0-VAT document that ZATCA would reject.
      const hasTaxable = lines.some((l) => l.vatCategory === "S" || l.vatCategory === "Z");
      if (!hasTaxable) {
        this.logger.debug(`ZATCA: ${doc.number} skipped — exempt/out-of-scope supply (no e-invoice required)`);
        return { submitted: false, code: "not_required", reason: "Exempt or out-of-scope supply — ZATCA e-invoice not required" };
      }

      // Buyer's full structured address comes from the tenant record (rent) or
      // the landlord/owner record (commission) — both store a national address —
      // so B2B invoices carry the city/district/street ZATCA requires (BR-KSA-63).
      let buyer: BuyerSnapshot;
      if (doc.kind === "commission") {
        const owner = ownerId ? (await this.db.select().from(ownersTable)
          .where(and(eq(ownersTable.id, ownerId), eq(ownersTable.userId, uid))))[0] ?? null : null;
        buyer = this.buyerFromParty(doc, {
          name: doc.tenantName || contract?.landlordName || owner?.name,
          vat: owner?.taxNumber || contract?.landlordTaxNumber,
          id: owner?.idNumber, type: owner?.type,
          street: owner?.nationalAddressStreet || contract?.landlordAddress,
          buildingNo: owner?.buildingNumber || contract?.landlordBuildingNumber,
          district: owner?.nationalAddressDistrict || null,
          city: owner?.nationalAddressCity || null,
          postalZone: owner?.postalCode || contract?.landlordPostalCode,
          additionalNo: owner?.additionalNumber || contract?.landlordAdditionalNumber,
        });
      } else if ((doc.client as any)?.kind === "landlord" && (doc.client as any)?.ownerId) {
        // A free invoice billed TO one of the account's landlords. Without this
        // branch it fell through to the tenant branch below, where `tenantId` is
        // null by construction (the web clears it for a landlord pick) so every
        // address field collapsed to the one-line `client.address` — and a
        // VAT-registered landlord buyer then failed `assertAddressComplete` on
        // every single attempt. The readiness gate reads the owner row; so must
        // this, or the two disagree about a document the gate has passed.
        const buyerOwner = (await this.db.select().from(ownersTable)
          .where(and(
            eq(ownersTable.id, Number((doc.client as any).ownerId)),
            eq(ownersTable.userId, uid),
            isNull(ownersTable.deletedAt),
          )))[0] ?? null;
        const cl = (doc.client ?? {}) as Record<string, any>;
        buyer = this.buyerFromParty(doc, {
          name: buyerOwner?.name || doc.tenantName || cl.name,
          vat: buyerOwner?.taxNumber || cl.vatNumber,
          id: buyerOwner?.idNumber || cl.idNumber,
          type: buyerOwner?.type || cl.type,
          street: buyerOwner?.nationalAddressStreet || cl.street,
          buildingNo: buyerOwner?.buildingNumber || cl.buildingNumber,
          district: buyerOwner?.nationalAddressDistrict || cl.district || null,
          city: buyerOwner?.nationalAddressCity || cl.city || null,
          postalZone: buyerOwner?.postalCode || cl.postalCode,
          additionalNo: buyerOwner?.additionalNumber || cl.additionalNumber,
        });
      } else {
        const tenant = doc.tenantId ? (await this.db.select().from(tenantsTable)
          .where(and(eq(tenantsTable.id, Number(doc.tenantId)), eq(tenantsTable.userId, uid))))[0] ?? null : null;
        // An invoice raised for an external buyer (neither tenant nor landlord)
        // has no party record to read an address from — the document itself is
        // the record, so the client block is the last fallback for every field.
        // Without it a standard tax invoice to such a buyer would go out with a
        // null city/district/street and fail BR-KSA-63.
        const cl = (doc.client ?? {}) as Record<string, any>;
        buyer = this.buyerFromParty(doc, {
          name: doc.tenantName || tenant?.name || contract?.tenantName || cl.name,
          vat: doc.client?.vatNumber || tenant?.taxNumber || contract?.tenantTaxNumber,
          id: tenant?.nationalId || cl.idNumber,
          type: tenant?.type || cl.type,
          street: tenant?.nationalAddressStreet || contract?.tenantAddress || tenant?.address || cl.street,
          buildingNo: tenant?.buildingNumber || contract?.tenantBuildingNumber || cl.buildingNumber,
          district: tenant?.nationalAddressDistrict || cl.district || null,
          city: tenant?.nationalAddressCity || cl.city || null,
          postalZone: tenant?.postalCode || contract?.tenantPostalCode || cl.postalCode,
          additionalNo: tenant?.additionalNumber || contract?.tenantAdditionalNumber || cl.additionalNumber,
        });
      }
      // Which document this becomes, and therefore where it goes: a buyer with a
      // VAT number is a registered business, so the invoice is STANDARD (B2B)
      // and must be CLEARED by ZATCA before it is valid; a buyer without one is
      // a consumer, so it is SIMPLIFIED (B2C) and merely REPORTED within 24h.
      //
      // The VAT number is the deciding fact — registration is what makes a
      // buyer B2B, and an individual can be registered too. The buyer's TYPE
      // does not override it; it decides the identification scheme above, and
      // the readiness gate uses it to insist a company actually carries the VAT
      // number and address this branch would otherwise silently do without.
      const profile: "standard" | "simplified" = buyer?.vat ? "standard" : "simplified";

      const dto: CreateInvoiceDto = {
        invoiceNumber: doc.number,
        ownerId,
        profile,
        docType: (doc.type as "invoice" | "credit" | "debit") ?? "invoice",
        language: "ar",
        currency: "SAR",
        contractId: doc.contractId ?? null,
        buyer,
        lines,
        billingReferenceId: doc.type !== "invoice" ? (doc.billingReference ?? null) : null,
        instructionNote: doc.type !== "invoice" ? (doc.notes ?? undefined) : undefined,
        notes: doc.notes ?? null,
      };
      const result = await this.invoices.issue(uid, dto);
      this.logger.log(`ZATCA: ${doc.number} → ${result.invoice.status} (${result.invoice.submittedTo}, ${profile}) ownerId=${ownerId}`);
      const warnings = ((result.invoice.zatcaResponse as any)?.validationResults?.warningMessages ?? []).length;
      // The QR to print for this document. A cleared standard invoice must show
      // the QR ZATCA stamped and returned, not the Phase-1 one we signed with —
      // the signer only produces a verifiable 9-tag QR for simplified invoices.
      // Falls back to the signed QR (simplified: the real Phase-2 one; standard
      // before clearance: Phase-1) so there is always something to show.
      const printableQr = clearedInvoiceQr((result.invoice as any).clearedXml) ?? result.invoice.qrBase64 ?? null;
      return { submitted: true, status: result.invoice.status, profile, environment: env, httpStatus: result.invoice.httpStatus ?? 0, invoiceId: result.invoice.id, qr: printableQr, warnings };
    } catch (e: any) {
      // `issue()` refuses with this the moment ZATCA answers 401/403, BEFORE it
      // writes an invoices row or advances the ICV — so this document has not
      // travelled and must not be recorded as though it had.
      const body = e?.response ?? (typeof e?.getResponse === "function" ? e.getResponse() : null);
      // The seller's chain was busy for longer than we were willing to queue.
      // Nothing was sent and no ICV moved, so this belongs with the other
      // "not sent" outcomes and must stay retryable — calling it a failure
      // would also let it block a contract rebuild.
      if (body && typeof body === "object" && (body as any).error === CHAIN_BUSY) {
        this.logger.warn(`ZATCA: ${doc?.number} not sent — the seller's chain was busy`);
        return { submitted: false, code: "chain_busy", reason: String((body as any).message ?? "Seller chain busy") };
      }
      if (body && typeof body === "object" && (body as any).error === "zatca_link_invalid") {
        const b = body as any;
        this.logger.warn(`ZATCA: ${doc?.number} not sent — ZATCA refused the credentials (HTTP ${b.httpStatus ?? "?"})`);
        return { submitted: false, code: "link_invalid", reason: String(b.message ?? "ZATCA refused the credentials") };
      }
      this.logger.warn(`ZATCA submit failed for ${doc?.number}: ${e?.message ?? e}`);
      return { submitted: false, code: "error", reason: e?.message ? String(e.message).slice(0, 300) : "ZATCA submission failed" };
    }
  }

  /**
   * Which landlord is the SELLER of this document.
   *
   * For a contract-linked invoice it is the landlord who owns the property:
   * contract → unit → property → owner. For a free invoice there is no contract
   * to walk, so it falls to `resolveStandaloneSellerId` — the account-level
   * seller if one exists, otherwise the account's own landlord record. That
   * fallback is what makes a free invoice submittable at all: nothing in the
   * product can create the account-level credentials row, so before it the
   * answer was always "not linked", about a link the user had no way to make.
   *
   * The readiness gate calls the same resolver, so the seller it checks is
   * always the seller this path submits under.
   */
  private async resolveOwnerId(uid: number, contractId: number | null): Promise<number | null> {
    if (!contractId) return resolveStandaloneSellerId(this.db, uid);
    const [row] = await this.db
      .select({ ownerId: propertiesTable.ownerId })
      .from(contractUnitsTable)
      .innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
      .innerJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
      .where(eq(contractUnitsTable.contractId, Number(contractId)))
      .limit(1);
    void uid;
    return row?.ownerId ?? null;
  }

  /** ZATCA invoice lines from a billing doc's items. Each item may carry an
   *  explicit ZATCA VAT category (S = standard 15%, Z = zero-rated, E = exempt,
   *  O = out-of-scope). Legacy items only have a `vat` boolean: true → S; false
   *  → E (exempt), the correct default for non-VAT property rent. */
  private zatcaLinesFromDoc(doc: any): InvoiceLineInput[] {
    const VALID = ["S", "Z", "E", "O"] as const;
    return normalizeItems(doc.items).map((it, i) => {
      const quantity = it.quantity || 1;
      const unitPrice = it.unitPrice || (quantity ? round2(it.amount / quantity) : it.amount);
      const raw = (it as any).vatCategory as string | undefined;
      const category = (raw && (VALID as readonly string[]).includes(raw) ? raw : (it.vat ? "S" : "E")) as "S" | "Z" | "E" | "O";
      return {
        id: String(i + 1),
        name: it.description || "بند",
        quantity,
        unitPrice,
        vatPercent: category === "S" ? 15 : 0,
        vatCategory: category,
      } as InvoiceLineInput;
    });
  }

  /** Normalize a resolved party into a ZATCA BuyerSnapshot (blanks → null). */
  private buyerFromParty(
    doc: any,
    p: { name?: string | null; vat?: string | null; id?: string | null; type?: string | null;
         street?: string | null; buildingNo?: string | null;
         district?: string | null; city?: string | null; postalZone?: string | null; additionalNo?: string | null },
  ): BuyerSnapshot {
    const blank = (v: string | null | undefined) => { const s = (v ?? "").toString().trim(); return s || null; };
    const cl = (doc.client ?? {}) as Record<string, any>;
    const type = blank(p.type) || blank(cl.type);
    return {
      name: blank(p.name) || cl.name || (doc.kind === "commission" ? "المؤجر" : "العميل"),
      vat: blank(p.vat),
      // BT-46: the buyer's own identifier. A company states its commercial
      // registration; an individual states a national ID or iqama, for which
      // ZATCA's only valid scheme is OTH — NAT and IQA are not accepted values
      // (see DARA-NOTES §2b-i, verified against ZATCA's validator).
      id: blank(p.id) || blank(cl.idNumber),
      idScheme: type === "company" ? "CRN" : type === "individual" ? "OTH" : null,
      street: blank(p.street) || cl.address || null,
      buildingNo: blank(p.buildingNo),
      district: blank(p.district),
      city: blank(p.city),
      postalZone: blank(p.postalZone),
      additionalNo: blank(p.additionalNo),
    };
  }

  /**
   * Record a collection against an approved invoice (from the Collections
   * page). Distributes the amount across the invoice's installment(s), marks
   * them paid/partially-paid and stamps the receipt-voucher on the invoice so
   * it surfaces under Receipt Vouchers.
   */
  @Post(":id/collect")
  @RequirePermissions(PERMISSIONS.PAYMENTS_WRITE)
  async collect(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    const uid = scopeId(user);
    const docId = requiredForeignKeyId(id, "رقم المستند");
    if (!Number.isInteger(docId)) throw new BadRequestException("رقم المستند غير صالح");
    // Everything below reads what has been collected so far and then writes.
    // With no lock, parallel requests all read "nothing yet", all pass the cap,
    // and the same money lands several times — a 1,000 invoice was measured
    // recording 4,000 across four rows, sharing one receipt-voucher number.
    // The installment path was given this lock; its invoice-level twin was not.
    return this.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${uid}, ${docId})`);
    const [doc] = await tx.select().from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.id, docId), eq(simpleInvoicesTable.userId, uid), isNull(simpleInvoicesTable.deletedAt)));
    if (!doc) throw new NotFoundException("Document not found");
    if (doc.type !== "invoice") throw new BadRequestException("التحصيل يتم على الفواتير فقط");
    if (doc.status !== "confirmed") throw new BadRequestException("يجب اعتماد الفاتورة قبل التحصيل");
    // NB: a fully-collected invoice carries a paidDate/receiptNumber, but a
    // debit note can later raise its total — so "already collected" is decided
    // by the remaining-balance check below (doc.total − collected), NOT by the
    // presence of a paid stamp.

    const paidDate = body?.paidDate || today();
    // Per-account sequential receipt-voucher number (RV-000001…), unique across
    // both invoice docs and collections (e.g. the advance-rent voucher).
    const voucher = await nextReceiptVoucherNumber(tx as any, uid);
    const method = body?.method ?? "bank_transfer";
    const receipt = (body?.receiptNumber && String(body.receiptNumber).trim()) || voucher;
    const ids = (doc.paymentIds && doc.paymentIds.length) ? doc.paymentIds : (doc.paymentId ? [doc.paymentId] : []);
    // Cap at what's still uncollected on this invoice (supports partial).
    // Against the NET total — the same figure every read path reports as the
    // balance due — not the gross one printed on the immutable document. A
    // credit note has to actually stop the money coming in, and a debit note
    // has to let the amount it added be collected.
    const [priorAgg] = await tx.select({ total: sum(paymentCollectionsTable.amount) })
      .from(paymentCollectionsTable).where(eq(paymentCollectionsTable.invoiceId, doc.id));
    const alreadyCollected = round2(Number(priorAgg?.total ?? 0));
    const netTotal = round2(Number(doc.total) + (await this.notesAdjustmentFor(uid, doc)));
    const invoiceRemaining = round2(netTotal - alreadyCollected);
    if (invoiceRemaining <= 0.01) throw new BadRequestException("تم تحصيل هذه الفاتورة بالكامل");
    let toCollect = body?.amount != null ? round2(Number(body.amount)) : invoiceRemaining;
    if (toCollect > invoiceRemaining + 0.01) throw new BadRequestException(`مبلغ التحصيل يتجاوز المتبقي (${invoiceRemaining.toFixed(2)})`);

    // What the loop below could actually write. The requested amount is only an
    // intention: an installment that is cancelled, deleted or already settled
    // absorbs none of it.
    let applied = 0;

    for (const pid of ids) {
      if (toCollect <= 0.01) break;
      const [payment] = await tx.select().from(paymentsTable)
        .where(and(eq(paymentsTable.id, pid), eq(paymentsTable.userId, uid), isNull(paymentsTable.deletedAt)));
      if (!payment || payment.status === "cancelled") continue;
      const prior = await tx.select({ total: sum(paymentCollectionsTable.amount) })
        .from(paymentCollectionsTable).where(eq(paymentCollectionsTable.paymentId, pid));
      const collectedBefore = round2(Number(prior[0]?.total ?? 0));
      const totalDue = round2(Number(payment.amount));
      const remaining = round2(totalDue - collectedBefore);
      if (remaining <= 0.01) continue;
      const amt = round2(Math.min(remaining, toCollect));
      await tx.insert(paymentCollectionsTable).values({
        paymentId: pid,
        userId: uid,
        amount: amt.toFixed(2),
        collectedDate: paidDate,
        method,
        receiptNumber: receipt,
        attachmentKey: body?.attachmentKey ?? null,
        invoiceId: doc.id,
        notes: body?.notes ?? `فاتورة ${doc.number}`,
      });
      const collectedAfter = round2(collectedBefore + amt);
      const status = collectedAfter >= totalDue - 0.01 ? "paid" : "partially_paid";
      await tx.update(paymentsTable).set({
        status,
        paidDate: status === "paid" ? paidDate : payment.paidDate,
        receiptNumber: receipt,
        attachmentKey: body?.attachmentKey ?? payment.attachmentKey,
      }).where(eq(paymentsTable.id, pid));
      applied = round2(applied + amt);
      toCollect = round2(toCollect - amt);
    }

    // Invoices not backed by an installment (commission / free invoices) still
    // record a collection — against the invoice only — so their collected
    // amount is consistent with the "paid" stamp (no "paid but collected = 0").
    if (!ids.length && toCollect > 0.01) {
      await tx.insert(paymentCollectionsTable).values({
        paymentId: null, userId: uid, amount: toCollect.toFixed(2), collectedDate: paidDate,
        method, receiptNumber: receipt, invoiceId: doc.id,
        notes: body?.notes ?? `فاتورة ${doc.number}`,
      } as any);
      applied = toCollect;
      toCollect = 0;
    }

    // Nothing landed anywhere — every linked installment was cancelled, deleted
    // or already settled. Carrying on would stamp the invoice paid and burn a
    // receipt-voucher number over money that has no collection row behind it,
    // which the Collections tab then reports as received.
    if (applied <= 0.01) throw new BadRequestException("لا يوجد قسط مستحق لتحصيل هذا المبلغ عليه");

    // Only mark the invoice fully collected when prior + this collection cover
    // the net total; a partial collection keeps it confirmed (collectible again).
    const fullyCollected = round2(alreadyCollected + applied) >= netTotal - 0.01;
    const [updated] = await tx.update(simpleInvoicesTable).set({
      ...(fullyCollected ? { paidDate, receiptNumber: voucher } : {}),
      paymentMethod: method,
      attachmentKey: body?.attachmentKey ?? doc.attachmentKey,
    }).where(and(eq(simpleInvoicesTable.id, doc.id), eq(simpleInvoicesTable.userId, uid))).returning();
    return updated;
    });
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.INVOICES_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const [doc] = await this.db.select().from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.id, requiredForeignKeyId(id, "رقم المستند")), eq(simpleInvoicesTable.userId, scopeId(user)), isNull(simpleInvoicesTable.deletedAt)));
    if (!doc) throw new NotFoundException("Document not found");
    // An approved document has been issued — to the buyer, and to ZATCA. It is
    // corrected by a credit note, never withdrawn. And a soft delete only hides
    // the document: its collections live in payment_collections, which has no
    // deleted_at, so the money would keep counting in every total with nothing
    // left on screen to explain it.
    if (doc.status === "confirmed") {
      throw new BadRequestException("لا يمكن حذف مستند معتمد — أصدر إشعاراً دائناً لإلغاء أثره");
    }
    const [collAgg] = await this.db.select({ c: count() })
      .from(paymentCollectionsTable).where(eq(paymentCollectionsTable.invoiceId, doc.id));
    if (Number(collAgg?.c ?? 0) > 0) {
      throw new BadRequestException("لا يمكن حذف مستند له تحصيلات مسجَّلة — أصدر إشعاراً دائناً بدلاً من ذلك");
    }
    await this.db.update(simpleInvoicesTable).set({ deletedAt: new Date() })
      .where(and(eq(simpleInvoicesTable.id, doc.id), eq(simpleInvoicesTable.userId, scopeId(user))));
    return { ok: true };
  }
}

@Module({ imports: [InvoiceModule, UploadsModule], controllers: [SimpleInvoicesController] })
export class BillingModule {}
