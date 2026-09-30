import type { Fv2Pool } from "../db";
import { fromHalalas } from "../money";
import { riyadhToday } from "../dates";
import { resolveTreatment } from "../rules";
import { DEPOSIT_DESC, h } from "./common";
import { fyStartOf } from "./core-math";
import { CoreReportsService } from "./core-reports.service";
import { BankRecService } from "../tier2/bank-rec.service";
import { dueNotInvoicedSql } from "../due-uninvoiced";

/**
 * The accountant's control checks that the reconciliation report (R1–R8) did
 * not already cover (his sheet "فحوصات الرقابة", #2, #3, #7–#9, #13–#21).
 * Each returns the same shape as an R-check: a first value, a second value,
 * their difference, a status and the offending items (never more than
 * LIST_LIMIT). All are read-only and scoped to one account.
 *
 *  R9   TB closing balances     Σ closing debits (TB report)          vs  Σ closing credits
 *  R10  Balance sheet           assets (BS report)                    vs  liabilities + equity
 *  R11  Managed AR mirror       1122 per landlord                     vs  2122 per landlord
 *  R12  Suppliers               2111                                  vs  open supplier bills (AP sub-ledger)
 *  R13  Cash-flow closing cash  opening cash + receipts − payments    vs  the cash / bank book closing balances
 *  R14  Income statement        net profit (IS report)                vs  revenue − expenses in the TB report
 *  R15  Bank reconciliation     adjusted bank balance                 vs  adjusted book balance (latest statement per account)
 *  R16  Client money (trust)    trust bank accounts                   vs  landlord payable + deposits held + … (manager mode, with a trust account)
 *  R17  Duplicate numbers       count of repeated document numbers    vs  0
 *  R18  Rent invoices linked    rent invoices with no installment     vs  0
 *  R19  Due, not invoiced       installments due with no document     vs  0
 *  R20  Closed-period documents documents dated in a closed period    vs  0
 *  R21  Postable accounts       lines on group accounts               vs  0
 */

export const EXTRA_LABELS: Record<string, { ar: string; en: string }> = {
  R9: { ar: "ميزان المراجعة متوازن (الأرصدة الختامية)", en: "Trial balance closing balances balance" },
  R10: { ar: "المركز المالي متوازن (الأصول = الخصوم + حقوق الملكية)", en: "Balance sheet balances (assets = liabilities + equity)" },
  R11: { ar: "ذمم المستأجرين المُدارة (1122) = حصة الملاك من الإيجارات غير المحصّلة (2122)", en: "Managed tenant receivables (1122) = landlord share of uncollected rent (2122)" },
  R12: { ar: "الموردون (2111) = مجموع أرصدة الموردين", en: "Suppliers (2111) = supplier balances" },
  R13: { ar: "النقدية آخر الفترة في التدفقات = أرصدة البنوك والصندوق", en: "Cash-flow closing cash = bank and cash balances" },
  R14: { ar: "قائمة الدخل = حسابات الإيرادات والمصروفات في الميزان", en: "Income statement = revenue and expense accounts in the trial balance" },
  R15: { ar: "تسوية البنك: الرصيد المعدل للبنك = الرصيد المعدل للدفاتر", en: "Bank reconciliation: adjusted bank = adjusted books" },
  R16: { ar: "أموال العملاء: رصيد حساب الأمانات = مستحقات الملاك والتأمينات والمبالغ المحفوظة", en: "Client money: trust account balance = landlord and tenant money held" },
  R17: { ar: "لا يوجد تكرار في أرقام المستندات", en: "No duplicate document numbers" },
  R18: { ar: "كل فاتورة إيجار مرتبطة بقسط من جدول الأقساط", en: "Every rent invoice is linked to an installment" },
  R19: { ar: "لا توجد أقساط مستحقة لم تُفوتر", en: "No installments due but not invoiced" },
  R20: { ar: "لا توجد مستندات بتاريخ داخل فترة مقفلة", en: "No documents dated inside a closed period" },
  R21: { ar: "كل سطور القيود على حسابات تقبل الترحيل", en: "Every journal line is on a postable account" },
};

export const LIST_LIMIT = 200;

export type CheckStatus = "ok" | "difference" | "not_applicable" | "unavailable" | "attention";

export interface CheckBody {
  status: CheckStatus;
  ledger: string | null;
  subLedger: string | null;
  difference: string | null;
  /** How ledger / subLedger / difference read: money (default) or a count of items. */
  unit?: "money" | "count";
  rows: any[];
  explanations: Array<{ code: string; count: number; amount: string | null; items?: any[] }>;
  notes: string[];
}

type Mk<C> = (id: string, key: string, body: CheckBody) => C;

const money = (n: number) => fromHalalas(n);
const add = (m: Map<any, number>, k: any, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/** A count check: value 1 is the number of offending items, value 2 is zero. */
function countCheck(n: number, rows: any[], explanations: CheckBody["explanations"] = [], notes: string[] = []): CheckBody {
  return { status: n ? "difference" : "ok", ledger: String(n), subLedger: "0", difference: String(n), unit: "count", rows: rows.slice(0, LIST_LIMIT), explanations, notes };
}

export class ExtraChecks {
  private readonly core: CoreReportsService;
  private readonly bankRec: BankRecService;

  constructor(private readonly pool: Fv2Pool) {
    this.core = new CoreReportsService(pool);
    // Only the pure `reconciliation(q, …)` computation is used; it needs no manual-journal service.
    this.bankRec = new BankRecService(pool, undefined as any);
  }

  /** Every extra check, in order. `only` restricts to the listed ids. */
  async all<C>(scope: number, asOf: string, ctx: { mode: "owner" | "manager" | null; goLive: string | null; sm: number }, mk: Mk<C>, only?: Set<string>): Promise<C[]> {
    const want = (id: string) => !only || only.has(id);
    const out: C[] = [];
    const fy = fyStartOf(asOf, ctx.sm);
    let tb: any = null;
    const tbOnce = async () => (tb ??= await this.core.trialBalance(scope, { from: fy, to: asOf, compare: "none" }));
    if (want("R9")) out.push(mk("R9", "tb_closing_balances", await this.r9(await tbOnce())));
    if (want("R10")) out.push(mk("R10", "balance_sheet", await this.r10(scope, asOf)));
    if (want("R11")) out.push(mk("R11", "managed_ar_mirror", await this.r11(scope, asOf, ctx.mode)));
    if (want("R12")) out.push(mk("R12", "suppliers_payable", await this.r12(scope, asOf)));
    if (want("R13")) out.push(mk("R13", "cash_flow_cash", await this.r13(scope, fy, asOf)));
    if (want("R14")) out.push(mk("R14", "income_statement", await this.r14(scope, fy, asOf, await tbOnce())));
    if (want("R15")) out.push(mk("R15", "bank_reconciliation", await this.r15(scope, asOf)));
    if (want("R16")) out.push(mk("R16", "trust_coverage", await this.r16(scope, asOf, ctx.mode)));
    if (want("R17")) out.push(mk("R17", "duplicate_numbers", await this.r17(scope, ctx.goLive)));
    if (want("R18")) out.push(mk("R18", "rent_invoices_linked", await this.r18(scope, asOf, ctx.goLive)));
    if (want("R19")) out.push(mk("R19", "due_not_invoiced", await this.r19(scope, asOf, ctx.goLive)));
    if (want("R20")) out.push(mk("R20", "closed_period_documents", await this.r20(scope, asOf)));
    if (want("R21")) out.push(mk("R21", "postable_accounts", await this.r21(scope, asOf)));
    return out;
  }

  // ─── R9 (#2) ───
  async r9(tb: any): Promise<CheckBody> {
    const d = h(tb.totals.closingDebit);
    const c = h(tb.totals.closingCredit);
    return {
      status: d === c ? "ok" : "difference", ledger: money(d), subLedger: money(c), difference: money(d - c), rows: [],
      explanations: [], notes: [`trial balance ${tb.params.from} → ${tb.params.to}: Σ closing debit balances vs Σ closing credit balances`],
    };
  }

  // ─── R10 (#3) ───
  async r10(scope: number, asOf: string): Promise<CheckBody> {
    const bs: any = await this.core.balanceSheet(scope, { asOf });
    const a = h(bs.assets.total);
    const le = h(bs.totalLiabilitiesAndEquity);
    return {
      status: a === le ? "ok" : "difference", ledger: money(a), subLedger: money(le), difference: money(a - le), rows: [],
      explanations: [{ code: "liabilities", count: 0, amount: bs.liabilities.total }, { code: "equity", count: 0, amount: bs.equity.total }], notes: [],
    };
  }

  // ─── R11 (#7, #9) ───
  async r11(scope: number, asOf: string, mode: string | null): Promise<CheckBody> {
    const r = await this.pool.query(
      `select l.owner_id as k, a.system_key as sk, sum(l.debit - l.credit)::text as bal
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and l.entry_date <= $2::date and a.system_key in ('tenant_receivable_agency', 'landlord_payable_uncollected')
        group by 1, 2`, [scope, asOf]);
    const ar = new Map<any, number>();
    const lpu = new Map<any, number>();
    for (const x of r.rows) (x.sk === "tenant_receivable_agency" ? ar : lpu).set(x.k, (x.sk === "tenant_receivable_agency" ? 1 : -1) * h(x.bal));
    if (mode === "owner" && !r.rowCount) {
      return { status: "not_applicable", ledger: null, subLedger: null, difference: null, rows: [], explanations: [], notes: ["owner_mode: no managed receivables"] };
    }
    const names = await this.names(scope, "owners", [...new Set([...ar.keys(), ...lpu.keys()])].filter((x) => x != null));
    const rows: any[] = [];
    let l = 0, s = 0;
    for (const k of new Set([...ar.keys(), ...lpu.keys()])) {
      const a = ar.get(k) ?? 0;
      const b = lpu.get(k) ?? 0;
      l += a; s += b;
      if (a !== b) rows.push({ ownerId: k, landlordName: k != null ? names.get(k) ?? null : null, ledger: money(a), subLedger: money(b), difference: money(a - b) });
    }
    return {
      status: rows.length ? "difference" : "ok", ledger: money(l), subLedger: money(s), difference: money(l - s), rows: rows.slice(0, LIST_LIMIT),
      explanations: [], notes: ["every managed-rent entry moves 1122 and 2122 together, per landlord"],
    };
  }

  // ─── R12 (#8) ───
  async r12(scope: number, asOf: string): Promise<CheckBody> {
    // The AP aging sub-ledger (ap.service.ts apAging): approved bills to asOf, less posted payments to asOf.
    const bills = (await this.pool.query(
      `select b.supplier_id, s.name_ar, s.name_en, sum(b.total - coalesce((select sum(a.amount) from supplier_payment_allocations a
                join supplier_payments p on p.id = a.payment_id and p.user_id = a.user_id
               where a.bill_id = b.id and a.user_id = b.user_id and p.paid_on <= $2::date and (p.status = 'posted' or p.voided_on > $2::date)), 0))::text as open
         from supplier_bills b join suppliers s on s.id = b.supplier_id and s.user_id = b.user_id
        where b.user_id = $1 and b.approved_at is not null and b.bill_date <= $2::date and (b.status = 'approved' or b.voided_on > $2::date)
        group by 1, 2, 3 order by 2`, [scope, asOf])).rows;
    const [led] = (await this.pool.query(
      `select coalesce(sum(l.credit - l.debit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and a.system_key = 'accounts_payable' and l.entry_date <= $2::date`, [scope, asOf])).rows;
    const [pend] = (await this.pool.query(
      `select count(*)::int as n from ledger_outbox where user_id = $1 and source_type in ('supplier_bill','supplier_payment')
          and status in ('pending','failed') and occurred_on <= $2::date`, [scope, asOf])).rows;
    const sub = bills.reduce((t: number, x: any) => t + h(x.open), 0);
    const l = h(led.b);
    return {
      status: l === sub ? "ok" : "difference", ledger: money(l), subLedger: money(sub), difference: money(l - sub),
      rows: bills.filter((x: any) => h(x.open) !== 0).slice(0, LIST_LIMIT)
        .map((x: any) => ({ supplierId: x.supplier_id, supplierName: x.name_ar, subLedger: money(h(x.open)) })),
      explanations: [{ code: "outbox_pending_or_failed", count: pend.n, amount: null }], notes: [],
    };
  }

  // ─── R13 (#13) ───
  async r13(scope: number, from: string, asOf: string): Promise<CheckBody> {
    // Cash flow, from the ledger: opening cash (every line before `from`) plus receipts minus payments in the range,
    // over every leaf of the 1110 "cash and cash equivalents" group. Against the bank / cash book (§7.9) closing balances.
    const cf = (await this.pool.query(
      `with recursive g as (select id from accounts where user_id = $1 and code = '1110'
                             union all select a.id from accounts a join g on a.parent_id = g.id where a.user_id = $1)
       select a.id, a.code, a.name_ar, a.name_en,
              coalesce(sum(l.debit - l.credit) filter (where l.entry_date < $2::date), 0)::text as opening,
              coalesce(sum(l.debit) filter (where l.entry_date between $2::date and $3::date), 0)::text as receipts,
              coalesce(sum(l.credit) filter (where l.entry_date between $2::date and $3::date), 0)::text as payments
         from accounts a join g on g.id = a.id left join journal_lines l on l.account_id = a.id and l.user_id = a.user_id and l.entry_date <= $3::date
        where a.user_id = $1 and not a.is_group group by a.id order by a.code`, [scope, from, asOf])).rows;
    const book: any = await this.core.cashBook(scope, { from, to: asOf });
    const bookBy = new Map<number, number>();
    for (const s of book.sections) add(bookBy, s.account.id ?? s.account.accountId, h(s.closing));
    const rows: any[] = [];
    let v1 = 0, open = 0, rec = 0, pay = 0;
    const seen = new Set<number>();
    for (const x of cf) {
      const c = h(x.opening) + h(x.receipts) - h(x.payments);
      open += h(x.opening); rec += h(x.receipts); pay += h(x.payments); v1 += c;
      seen.add(x.id);
      const b = bookBy.get(x.id) ?? 0;
      if (c !== b) rows.push({ accountId: x.id, code: x.code, name: x.name_ar, nameEn: x.name_en, ledger: money(c), subLedger: money(b), difference: money(c - b) });
    }
    for (const [id, b] of bookBy) if (!seen.has(id) && b !== 0) rows.push({ accountId: id, code: null, name: null, ledger: money(0), subLedger: money(b), difference: money(-b) });
    const v2 = h(book.totals.closing);
    return {
      status: v1 === v2 && !rows.length ? "ok" : "difference", ledger: money(v1), subLedger: money(v2), difference: money(v1 - v2), rows: rows.slice(0, LIST_LIMIT),
      explanations: [
        { code: "cash_flow_components", count: 0, amount: null, items: [{ from, opening: money(open), receipts: money(rec), payments: money(pay), closing: money(v1) }] },
      ],
      notes: [`cash flow ${from} → ${asOf}; restricted (trust) cash is included in both figures`],
    };
  }

  // ─── R14 (#14) ───
  async r14(scope: number, from: string, asOf: string, tb: any): Promise<CheckBody> {
    const is: any = await this.core.incomeStatement(scope, { from, to: asOf });
    const net = h(is.netProfit.total);
    let tbNet = 0;
    for (const r of tb.rows) {
      if (r.kind !== "account" || r.isGroup || (r.type !== "revenue" && r.type !== "expense")) continue;
      tbNet += h(r.closingCredit) - h(r.closingDebit);
    }
    return {
      status: net === tbNet ? "ok" : "difference", ledger: money(net), subLedger: money(tbNet), difference: money(net - tbNet), rows: [],
      explanations: [{ code: "revenue", count: 0, amount: is.revenue.total.total }, { code: "expenses", count: 0, amount: is.expenses.total.total }],
      notes: [`income statement ${from} → ${asOf}`],
    };
  }

  // ─── R15 (#15) ───
  async r15(scope: number, asOf: string): Promise<CheckBody> {
    const sts = (await this.pool.query(
      `select distinct on (s.bank_account_id) s.*, to_char(s.period_to, 'YYYY-MM-DD') as period_to, b.gl_account_id, b.name_ar, b.name_en
         from bank_statements s join bank_accounts b on b.id = s.bank_account_id and b.user_id = s.user_id
        where s.user_id = $1 and s.period_to is not null and s.period_to <= $2::date
        order by s.bank_account_id, s.period_to desc, s.id desc`, [scope, asOf])).rows;
    if (!sts.length) {
      return { status: "not_applicable", ledger: null, subLedger: null, difference: null, rows: [], explanations: [], notes: ["no_bank_statements"] };
    }
    let bank = 0, books = 0;
    const rows: any[] = [];
    const noClosing: any[] = [];
    for (const st of sts) {
      if (st.closing_balance == null || st.gl_account_id == null) { noClosing.push({ statementId: st.id, bankAccountId: st.bank_account_id }); continue; }
      const r = await this.bankRec.reconciliation(this.pool as any, scope, st, st.gl_account_id);
      const adjBank = h(r.bankClosing) + h(r.outstandingReceipts) - h(r.outstandingPayments);
      const adjBooks = h(r.ledgerBalance) + h(r.unrecordedBankItems);
      bank += adjBank; books += adjBooks;
      if (adjBank !== adjBooks) {
        rows.push({
          statementId: st.id, bankAccountId: st.bank_account_id, name: st.name_ar, nameEn: st.name_en, periodTo: st.period_to,
          ledger: money(adjBank), subLedger: money(adjBooks), difference: money(adjBank - adjBooks),
          outstandingReceipts: r.outstandingReceipts, outstandingPayments: r.outstandingPayments, unrecordedBankItems: r.unrecordedBankItems,
        });
      }
    }
    return {
      status: rows.length || noClosing.length ? "difference" : "ok", ledger: money(bank), subLedger: money(books), difference: money(bank - books),
      rows, explanations: [{ code: "statements_without_closing_balance", count: noClosing.length, amount: null, items: noClosing }],
      notes: ["the latest statement of each bank account ending on or before the date"],
    };
  }

  // ─── R16 (#16) ───
  /**
   * The client-money test, in v2's accounts. Trust bank balance (every GL account of a trust bank account) against
   *   2121 landlord payable (agent landlords)
   * + 2141 deposits held on agent landlords' contracts
   * − cash in transit (1116) on agent landlords' lines (Ejar; zero by construction in Manager mode)
   * + commission deducted from landlords and landlord expenses the office paid from its own accounts, less the
   *   transfers between the trust account and the office's own accounts ("office money not yet transferred")
   * + landlord-charged supplier bills not yet paid ("landlord expenses not yet paid")
   * Tenant advances need no line of their own: in v2 an advance on managed rent is credited to 2121 on collection.
   * Every other entry that moves the trust account and the client liabilities by different amounts is the difference,
   * listed entry by entry (e.g. managed rent collected into the office's own account).
   */
  async r16(scope: number, asOf: string, mode: string | null): Promise<CheckBody> {
    const st = (await this.pool.query(`select agency_collections_to_trust as trust from finance_settings where account_user_id = $1`, [scope])).rows[0] ?? {};
    const trustAccts = (await this.pool.query(
      `select distinct gl_account_id as id from bank_accounts where user_id = $1 and is_trust and gl_account_id is not null`, [scope])).rows.map((x: any) => Number(x.id));
    if (mode !== "manager" || !trustAccts.length) {
      return { status: "not_applicable", ledger: null, subLedger: null, difference: null, rows: [], explanations: [], notes: [mode !== "manager" ? "owner_mode" : "no_trust_account"] };
    }
    if (!st.trust) {
      return { status: "not_applicable", ledger: null, subLedger: null, difference: null, rows: [], explanations: [], notes: ["trust_routing_off"] };
    }
    const holders = new Set((await this.pool.query(`select id from owners where user_id = $1 and is_account_holder`, [scope])).rows.map((x: any) => x.id));
    const agent = (ownerId: number | null) => ownerId != null && resolveTreatment("manager", { id: ownerId, isAccountHolder: holders.has(ownerId) }).treatment === "agent";
    const own = (await this.pool.query(
      `with recursive g as (select id from accounts where user_id = $1 and code = '1110'
                             union all select a.id from accounts a join g on a.parent_id = g.id where a.user_id = $1)
       select a.id from accounts a join g on g.id = a.id where not a.is_group`, [scope])).rows.map((x: any) => Number(x.id)).filter((id: number) => !trustAccts.includes(id));
    // Per entry: the trust movement, the client-liability movement, the transit movement and the office-cash movement.
    const lines = (await this.pool.query(
      `select l.entry_id, e.entry_no, to_char(e.entry_date, 'YYYY-MM-DD') as d, e.origin, coalesce(e.payload->>'rule', o.payload->>'rule') as rule,
              coalesce(o.origin, e.origin) as root_origin, e.source_type, e.source_id,
              a.system_key as sk, l.account_id, l.owner_id, (l.debit - l.credit)::text as dc
         from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
         join accounts a on a.id = l.account_id and a.user_id = l.user_id
         left join journal_entries o on o.id = e.reversal_of and o.user_id = e.user_id
        where l.user_id = $1 and l.entry_date <= $2::date
          and (l.account_id = any($3::int[]) or l.account_id = any($4::int[]) or a.system_key in ('landlord_payable','deposits_held','cash_in_transit'))`,
      [scope, asOf, trustAccts, own])).rows;
    type E = { entryId: number; entryNo: string; date: string; rule: string | null; origin: string; sourceType: string; sourceId: number; trust: number; liab: number; transit: number; office: number; landlordLp: number };
    const ents = new Map<number, E>();
    let trustBal = 0, lp = 0, dep = 0, transit = 0;
    for (const x of lines) {
      const id = Number(x.entry_id);
      const e = ents.get(id) ?? { entryId: id, entryNo: x.entry_no, date: x.d, rule: x.rule ?? null, origin: x.root_origin, sourceType: x.source_type, sourceId: Number(x.source_id), trust: 0, liab: 0, transit: 0, office: 0, landlordLp: 0 };
      ents.set(id, e);
      const v = h(x.dc);
      if (trustAccts.includes(x.account_id)) { e.trust += v; trustBal += v; }
      else if (x.sk === "landlord_payable") { e.liab -= v; e.landlordLp -= v; lp -= v; }
      else if (x.sk === "deposits_held") { if (agent(x.owner_id)) { e.liab -= v; dep -= v; } }
      else if (x.sk === "cash_in_transit") { if (agent(x.owner_id)) { e.transit += v; transit += v; } }
      else if (own.includes(x.account_id)) e.office += v;
    }
    // Landlord-charged supplier bills still open at asOf (their E38 debited 2121; the cash is still in trust until paid).
    const bills = (await this.pool.query(
      `select b.id, b.number, b.owner_id, (b.total - coalesce((select sum(a.amount) from supplier_payment_allocations a
                join supplier_payments p on p.id = a.payment_id and p.user_id = a.user_id
               where a.bill_id = b.id and a.user_id = b.user_id and p.paid_on <= $2::date and (p.status = 'posted' or p.voided_on > $2::date)), 0))::text as open
         from supplier_bills b
        where b.user_id = $1 and b.charge_to = 'landlord' and b.approved_at is not null and b.bill_date <= $2::date and (b.status = 'approved' or b.voided_on > $2::date)`,
      [scope, asOf])).rows.filter((b: any) => agent(b.owner_id) && h(b.open) !== 0);
    const unpaidBills = bills.reduce((t: number, b: any) => t + h(b.open), 0);

    // Classify each entry's residual (trust movement − liability movement − transit).
    const COMMISSION = new Set(["E15", "E16", "E36"]);
    let commission = 0, officePaid = 0, transfers = 0, billsFlow = 0, opening = 0;
    const unexplained: any[] = [];
    for (const e of ents.values()) {
      const r = e.trust - e.liab + e.transit;
      if (r === 0) continue;
      if (e.rule && COMMISSION.has(e.rule)) { commission += r; continue; }
      if (e.origin === "opening") { opening += r; continue; }
      // A landlord expense (E18) or bill payment (E39) settled from the office's own account: the office's money is owed back from trust.
      if ((e.rule === "E18" || e.rule === "E38") && e.trust === 0) { if (e.rule === "E38") billsFlow += r; else officePaid += r; continue; }
      if (e.rule === "E39") { billsFlow += r; continue; }
      // A transfer between the trust account and the office's own cash/bank accounts (a manual journal, both sides cash).
      if (e.liab === 0 && e.trust !== 0 && e.trust + e.office === 0) { transfers += r; continue; }
      unexplained.push({ entryId: e.entryId, entryNo: e.entryNo, date: e.date, rule: e.rule, sourceType: e.sourceType, sourceId: e.sourceId,
        trust: money(e.trust), liability: money(e.liab), difference: money(r) });
    }
    // Supplier payments from trust to landlord bills reduce the unpaid bills; from the office account they move to office money.
    // billsFlow carries the E38 (+) and E39 from trust (−) residuals; what is still open is `unpaidBills`, the rest is office-paid.
    const officeFromBills = billsFlow - unpaidBills;
    const officeMoney = commission + officePaid + officeFromBills + transfers;
    const v2 = lp + dep - transit + officeMoney + unpaidBills + opening;
    unexplained.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.entryId - b.entryId));
    return {
      status: trustBal === v2 ? "ok" : "difference", ledger: money(trustBal), subLedger: money(v2), difference: money(trustBal - v2),
      rows: unexplained.slice(0, LIST_LIMIT),
      explanations: [
        {
          code: "trust_components", count: 0, amount: null, items: [{
            landlordPayable: money(lp), depositsHeld: money(dep), cashInTransit: money(0 - transit), commissionDeducted: money(commission),
            landlordExpensesPaidByOffice: money(officePaid + officeFromBills), transfersToOffice: money(transfers), officeMoneyNotTransferred: money(officeMoney),
            landlordBillsUnpaid: money(unpaidBills), openingBalanceDifference: money(opening),
          }],
        },
        { code: "unexplained_entries", count: unexplained.length, amount: money(unexplained.reduce((t, x) => t + h(x.difference), 0)) },
        { code: "landlord_bills_unpaid", count: bills.length, amount: money(unpaidBills), items: bills.slice(0, LIST_LIMIT).map((b: any) => ({ billId: b.id, number: b.number, ownerId: b.owner_id, remaining: money(h(b.open)) })) },
      ],
      notes: ["tenant advances on managed rent are part of 2121 in v2 (credited on collection)"],
    };
  }

  // ─── R17 (#17) ───
  async r17(scope: number, goLive: string | null): Promise<CheckBody> {
    const since = goLive ?? "0001-01-01";
    const r = await this.pool.query(
      `select kind, number, n from (
         select 'document' as kind, number, count(*)::int as n from simple_invoices
          where user_id = $1 and deleted_at is null group by number
         having count(*) > 1 and max(coalesce(issue_date, (created_at at time zone 'Asia/Riyadh')::date)) >= $2::date
         union all
         select 'journal_entry', entry_no, count(*)::int from journal_entries where user_id = $1 group by entry_no having count(*) > 1
         union all
         select 'supplier_bill', number, count(*)::int from supplier_bills where user_id = $1 group by number having count(*) > 1
         union all
         select 'payment_voucher', number, count(*)::int from (
           select number from tenant_credit_actions where user_id = $1 and number is not null
           union all select number from finance_deposit_refunds where user_id = $1
           union all select number from supplier_payments where user_id = $1) pv group by number having count(*) > 1
       ) x order by kind, number`, [scope, since]);
    return countCheck(r.rowCount ?? 0, r.rows.map((x: any) => ({ kind: x.kind, number: x.number, count: x.n })));
  }

  // ─── R18 (#18) ───
  async r18(scope: number, asOf: string, goLive: string | null): Promise<CheckBody> {
    const r = await this.pool.query(
      `select si.id as "documentId", si.number, si.contract_id as "contractId", to_char(si.issue_date, 'YYYY-MM-DD') as "issueDate", si.total::text as total
         from simple_invoices si
        where si.user_id = $1 and si.deleted_at is null and si.status = 'confirmed' and si.type = 'invoice'
          and coalesce(si.kind, 'invoice') in ('invoice', 'rent_receipt') and si.contract_id is not null
          and si.payment_id is null and jsonb_array_length(case when jsonb_typeof(si.payment_ids) = 'array' then si.payment_ids else '[]'::jsonb end) = 0
          and coalesce(si.issue_date, (si.confirmed_at at time zone 'Asia/Riyadh')::date) between $3::date and $2::date
        order by si.issue_date, si.id`, [scope, asOf, goLive ?? "0001-01-01"]);
    return countCheck(r.rowCount ?? 0, r.rows);
  }

  // ─── R19 (#19) ───
  async r19(scope: number, asOf: string, goLive: string | null): Promise<CheckBody> {
    // Which installments count is the auto-invoice list's rule (../due-uninvoiced.ts), so this check and
    // "due, not invoiced" agree. "Due" follows the recognizer (§5.6): on today's check an installment due today is not due yet.
    const today = riyadhToday();
    const cutoffOp = asOf >= today ? "<" : "<=";
    const cutoff = asOf >= today ? today : asOf;
    const r = await this.pool.query(
      `select p.id as "paymentId", p.contract_id as "contractId", to_char(p.due_date, 'YYYY-MM-DD') as "dueDate", p.amount::text as amount, p.status::text as status
         from payments p join contracts c on c.id = p.contract_id and c.user_id = p.user_id
         left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
        where p.user_id = $1 and p.due_date ${cutoffOp} $2::date
          and ${dueNotInvoicedSql({ depositParam: "$4", goLive: "$3::date" })}
        order by p.due_date, p.id`, [scope, cutoff, goLive, DEPOSIT_DESC]);
    const amt = r.rows.reduce((t: number, x: any) => t + h(x.amount), 0);
    return countCheck(r.rowCount ?? 0, r.rows, [{ code: "amount_due_not_invoiced", count: r.rowCount ?? 0, amount: money(amt) }]);
  }

  // ─── R20 (#20) ───
  async r20(scope: number, asOf: string): Promise<CheckBody> {
    // A document dated in a closed period is posted late into the first open period (is_late). Those still in an
    // open period, and events still waiting in the queue with a date in a closed period, are listed.
    const r = await this.pool.query(
      `select 'late_entry' as kind, e.id as "entryId", e.entry_no as "entryNo", e.source_type as "sourceType", e.source_id as "sourceId",
              to_char(e.original_date, 'YYYY-MM-DD') as "documentDate", to_char(e.entry_date, 'YYYY-MM-DD') as "postedOn"
         from journal_entries e join fiscal_periods ep on ep.id = e.period_id and ep.user_id = e.user_id and ep.status = 'open'
        where e.user_id = $1 and e.is_late and e.entry_date <= $2::date and e.origin <> 'reversal'
          and exists (select 1 from fiscal_periods fp where fp.user_id = e.user_id and fp.status <> 'open' and e.original_date between fp.starts_on and fp.ends_on)
       union all
       select 'queued_event', null, null, o.source_type, o.source_id, to_char(o.occurred_on, 'YYYY-MM-DD'), null
         from ledger_outbox o
        where o.user_id = $1 and o.status in ('pending','failed') and o.occurred_on <= $2::date
          and exists (select 1 from fiscal_periods fp where fp.user_id = o.user_id and fp.status <> 'open' and o.occurred_on between fp.starts_on and fp.ends_on)
       order by 6, 2`, [scope, asOf]);
    return countCheck(r.rowCount ?? 0, r.rows);
  }

  // ─── R21 (#21) ───
  async r21(scope: number, asOf: string): Promise<CheckBody> {
    const r = await this.pool.query(
      `select l.id as "lineId", l.entry_id as "entryId", a.code, a.name_ar as name, to_char(l.entry_date, 'YYYY-MM-DD') as date
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and l.entry_date <= $2::date and a.is_group order by l.entry_date, l.id limit ${LIST_LIMIT + 1}`, [scope, asOf]);
    const [n] = (await this.pool.query(
      `select count(*)::int as n from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and l.entry_date <= $2::date and a.is_group`, [scope, asOf])).rows;
    return countCheck(n.n, r.rows.map((x: any) => ({ ...x, lineId: Number(x.lineId), entryId: Number(x.entryId) })), [], ["the database refuses a line on a group account"]);
  }

  private async names(scope: number, table: "owners" | "tenants", ids: number[]) {
    if (!ids.length) return new Map<number, string>();
    const r = await this.pool.query(`select id, name from ${table} where user_id = $1 and id = any($2::int[])`, [scope, ids]);
    return new Map<number, string>(r.rows.map((x: any) => [x.id, x.name]));
  }
}
