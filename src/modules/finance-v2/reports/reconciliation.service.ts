import { Inject, Injectable, Optional } from "@nestjs/common";
import { FV2_POOL, type Fv2Pool } from "../db";
import { fromHalalas, toHalalas } from "../money";
import { riyadhToday } from "../dates";
import { isoDate } from "../audit";
import { riyadhNow } from "./core-math";
import { DEPOSIT_DESC, contractDims, h, langOf, namesOf, settingsOf, type Lang } from "./common";
import { ArAgingService } from "./aging.service";
import { classifyCollection } from "../rules/money-flows";
import { resolveTreatment } from "../rules";
import { CONVERSION_NOTE, parseBusinessDate } from "../hooks/classify";

/**
 * The reconciliation report (DESIGN §7.10): the ledger against the
 * sub-ledgers, as of `asOf`. Every check shows the ledger figure, the
 * sub-ledger figure and the difference; differences are shown, never plugged,
 * with the known explanations beside them.
 *
 *  R1 AR control            1121 + 1122 per tenant  vs  the §7.6 open items (+ advance VAT not yet netted)
 *  R2 Deposits held         2141 per contract       vs  vouchers + deposit-row collections − refunds − conversions − offsets − forfeits
 *  R3 Landlord payable      2121 per landlord       vs  the legacy landlord-dues `remaining` (agency-fee collections excluded)
 *  R4 Bank and cash         each cash/bank account  vs  collections, vouchers, refunds, payouts and expenses, routed like the engine
 *  R5 Output VAT            Σ output VAT lines      vs  documents' VAT + due-date charges' VAT + advance VAT not yet invoiced
 *  R6 Posting completeness  entries                 vs  the source records that should have one
 *  R7 Sub-ledger integrity  —                       lists only
 *  R8 Trial balance         Σ debit = Σ credit, and per entry
 */

/** The legacy `GET /reports/accounting` computation for an account (R3), bound in the module. */
export const LEGACY_ACCOUNTING = Symbol("FV2_LEGACY_ACCOUNTING");
export type LegacyAccounting = (scope: number) => Promise<{ landlordDues: Array<{ ownerId: number | null; landlord: string; remaining: number }>; landlordStatement: Array<{ ownerId: number | null; maintenance: number }> }>;

const LIST_LIMIT = 200;

const LABELS: Record<string, { ar: string; en: string }> = {
  R1: { ar: "ذمم المستأجرين (الحساب الرقابي) مقابل الأرصدة المفتوحة", en: "AR control vs open items" },
  R2: { ar: "التأمينات المحتفظ بها مقابل سندات التأمين", en: "Deposits held vs deposit vouchers" },
  R3: { ar: "مستحقات الملاك مقابل تقرير مستحقات الملاك", en: "Landlord payable vs landlord-dues report" },
  R4: { ar: "النقد والبنوك مقابل الحركات المصدرية", en: "Bank and cash vs source movements" },
  R5: { ar: "ضريبة المخرجات مقابل المستندات", en: "Output VAT vs documents" },
  R6: { ar: "اكتمال الترحيل", en: "Posting completeness" },
  R7: { ar: "سلامة السجلات الفرعية", en: "Sub-ledger integrity" },
  R8: { ar: "ميزان المراجعة", en: "Trial balance" },
};

interface Check {
  id: string;
  key: string;
  label: string;
  status: "ok" | "difference" | "not_applicable" | "unavailable" | "attention";
  ledger: string | null;
  subLedger: string | null;
  difference: string | null;
  rows: any[];
  explanations: Array<{ code: string; count: number; amount: string | null; items?: any[] }>;
  notes: string[];
}

const money = (n: number) => fromHalalas(n);
const add = (m: Map<any, number>, k: any, v: number) => m.set(k, (m.get(k) ?? 0) + v);

function compare(ledger: Map<any, number>, sub: Map<any, number>, label: (k: any) => Record<string, unknown>) {
  const keys = new Set([...ledger.keys(), ...sub.keys()]);
  const rows: any[] = [];
  let l = 0;
  let s = 0;
  for (const k of keys) {
    const a = ledger.get(k) ?? 0;
    const b = sub.get(k) ?? 0;
    l += a;
    s += b;
    if (a !== b) rows.push({ ...label(k), ledger: money(a), subLedger: money(b), difference: money(a - b) });
  }
  return { rows, l, s };
}

@Injectable()
export class ReconciliationService {
  private readonly aging: ArAgingService;

  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    @Optional() @Inject(LEGACY_ACCOUNTING) private readonly legacy?: LegacyAccounting,
  ) {
    this.aging = new ArAgingService(pool);
  }

  /** GET /finance/v2/reports/reconciliation?asOf&lang */
  async reconciliation(scope: number, q: Record<string, any> = {}) {
    const lang: Lang = langOf(q.lang);
    const asOf = q.asOf ? isoDate(q.asOf, "asOf") : riyadhToday();
    const s = await settingsOf(this.pool, scope);
    const mk = (id: string, key: string, body: Omit<Check, "id" | "key" | "label">): Check =>
      ({ id, key, label: lang === "en" ? LABELS[id].en : LABELS[id].ar, ...body });
    const checks: Check[] = [
      await this.r1(scope, asOf, mk),
      await this.r2(scope, asOf, mk),
      await this.r3(scope, asOf, s.mode, mk),
      await this.r4(scope, asOf, s.mode, mk),
      await this.r5(scope, asOf, mk),
      await this.r6(scope, asOf, s.goLive, mk),
      await this.r7(scope, asOf, mk),
      await this.r8(scope, asOf, mk),
    ];
    return {
      report: "reconciliation",
      lang,
      mode: s.mode,
      generatedAt: riyadhNow(),
      params: { asOf },
      ledgerGoLiveDate: s.goLive,
      checks,
      summary: {
        ok: checks.filter((c) => c.status === "ok").length,
        withDifferences: checks.filter((c) => c.status === "difference" || c.status === "attention").map((c) => c.id),
      },
    };
  }

  private async ledgerBy(scope: number, asOf: string, keys: string[], col: "tenant_id" | "contract_id" | "owner_id" | "account_id", sign: 1 | -1) {
    const r = await this.pool.query(
      `select l.${col} as k, sum(l.debit - l.credit)::text as bal
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and l.entry_date <= $2::date and a.system_key = any($3::text[]) group by 1`, [scope, asOf, keys]);
    return new Map<any, number>(r.rows.map((x: any) => [x.k, sign * h(x.bal)]));
  }

  private async outboxOpen(scope: number, asOf: string) {
    const r = await this.pool.query(
      `select status, count(*)::int as n from ledger_outbox where user_id = $1 and occurred_on <= $2::date and status in ('pending','failed') group by status`,
      [scope, asOf]);
    return r.rows.reduce((t: number, x: any) => t + x.n, 0);
  }

  // ─── R1 ───
  private async r1(scope: number, asOf: string, mk: any): Promise<Check> {
    // The recognizer charges an installment the day AFTER it falls due (§5.6: due_date < today), so on today's
    // reconciliation an installment due today is not a receivable yet on either side.
    const today = riyadhToday();
    const data = await this.aging.openItems(scope, asOf, "tenant", asOf >= today ? { installmentsDueBefore: today } : {});
    const sub = new Map<any, number>();
    for (const it of data.items) add(sub, it.tenantId, it.remaining);
    for (const c of data.credit.values()) add(sub, c.tenantId, c.amount);
    for (const a of await this.aging.openAdvanceVat(scope, asOf, data.dims, "tenant")) add(sub, a.tenantId, a.vat);
    const ledger = await this.ledgerBy(scope, asOf, ["tenant_receivable", "tenant_receivable_agency"], "tenant_id", 1);
    for (const [k, v] of [...sub]) if (v === 0 && !ledger.has(k)) sub.delete(k);
    const names = await namesOf(this.pool, scope, "tenants", [...new Set([...ledger.keys(), ...sub.keys()])].filter((x) => x != null));
    const cmp = compare(ledger, sub, (k) => ({ tenantId: k, tenantName: k != null ? names.get(k) ?? null : null }));
    const unverified = await this.pool.query(
      `select p.id, p.amount::text as amount, coalesce(sum(c.amount), 0)::text as collected
         from payments p left join payment_collections c on c.payment_id = p.id and c.user_id = p.user_id
        where p.user_id = $1 and p.status = 'paid' and p.deleted_at is null and coalesce(p.description, '') <> $2
        group by p.id having coalesce(sum(c.amount), 0) < p.amount order by p.id`, [scope, DEPOSIT_DESC]);
    const uncharged = data.items.filter((it) => it.type === "installment" && it.remaining > 0);
    const charged = uncharged.length
      ? new Set((await this.pool.query(
        `select payment_id from finance_installment_charges where user_id = $1 and reversed_at is null and charged_on <= $2::date and payment_id = any($3::int[])`,
        [scope, asOf, uncharged.map((x) => x.id)])).rows.map((x: any) => x.payment_id))
      : new Set<number>();
    const notCharged = uncharged.filter((x) => !charged.has(x.id));
    const pending = await this.outboxOpen(scope, asOf);
    return mk("R1", "ar_control", {
      status: cmp.l === cmp.s && !cmp.rows.length ? "ok" : "difference",
      ledger: money(cmp.l), subLedger: money(cmp.s), difference: money(cmp.l - cmp.s), rows: cmp.rows,
      explanations: [
        { code: "outbox_pending_or_failed", count: pending, amount: null },
        {
          code: "paid_unverified", count: unverified.rowCount ?? 0,
          amount: money(unverified.rows.reduce((t: number, x: any) => t + h(x.amount) - h(x.collected), 0)),
          items: unverified.rows.slice(0, LIST_LIMIT).map((x: any) => ({ paymentId: x.id, amount: x.amount, collected: x.collected })),
        },
        {
          code: "due_not_yet_charged", count: notCharged.length, amount: money(notCharged.reduce((t, x) => t + x.remaining, 0)),
          items: notCharged.slice(0, LIST_LIMIT).map((x) => ({ paymentId: x.id, dueDate: x.dueDate, remaining: money(x.remaining) })),
        },
      ],
      notes: [],
    });
  }

  // ─── R2 ───
  private async r2(scope: number, asOf: string, mk: any): Promise<Check> {
    const ledger = await this.ledgerBy(scope, asOf, ["deposits_held"], "contract_id", -1);
    const sub = new Map<any, number>();
    const parts = { received: 0, depositRows: 0, refunded: 0, legacyReturned: 0, converted: 0, applied: 0, forfeited: 0 };
    const vouchers = await this.pool.query(
      `select v.id, v.contract_id, v.status::text as status, v.total::text as total, c.deposit_status,
              to_char(coalesce(v.paid_date, v.issue_date, (v.confirmed_at at time zone 'Asia/Riyadh')::date), 'YYYY-MM-DD') as d,
              to_char((v.updated_at at time zone 'Asia/Riyadh')::date, 'YYYY-MM-DD') as upd,
              (select coalesce(sum(pc.amount), 0) from payment_collections pc where pc.user_id = v.user_id and pc.invoice_id = v.id and pc.payment_id is not null)::text as linked,
              exists (select 1 from finance_deposit_refunds r where r.user_id = v.user_id and v.id = any(r.voucher_ids)) as v2_refund
         from simple_invoices v left join contracts c on c.id = v.contract_id and c.user_id = v.user_id
        where v.user_id = $1 and v.kind = 'deposit' and v.deleted_at is null
          and (v.status = 'confirmed' or (v.status = 'cancelled' and c.deposit_status = 'returned'))`, [scope]);
    for (const v of vouchers.rows) {
      const unlinked = Math.max(0, h(v.total) - h(v.linked));
      if (v.d && v.d <= asOf) { add(sub, v.contract_id, unlinked); parts.received += unlinked; }
      if (v.status === "cancelled" && !v.v2_refund && v.upd <= asOf) { add(sub, v.contract_id, -unlinked); parts.legacyReturned += unlinked; }
    }
    const cols = await this.collections(scope, asOf);
    for (const c of cols) {
      if (c.rule === "E09C") { add(sub, c.contractId, c.amount); parts.depositRows += c.amount; }
      else if (c.rule === "E12") { add(sub, c.contractId, -c.amount); parts.converted += c.amount; }
      else if (c.rule === "E12B") { add(sub, c.contractId, -c.amount); parts.applied += c.amount; }
    }
    const refunds = await this.pool.query(
      `select contract_id, amount::text as amount from finance_deposit_refunds where user_id = $1 and refunded_on <= $2::date`, [scope, asOf]);
    for (const r of refunds.rows) { add(sub, r.contract_id, -h(r.amount)); parts.refunded += h(r.amount); }
    // A forfeit without a money row has no sub-ledger record but the E11 entry itself.
    const forf = await this.pool.query(
      `select l.contract_id, sum(l.debit - l.credit)::text as amt from journal_lines l
         join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and l.entry_date <= $2::date and e.source_type = 'contract' and e.event like '%deposit_forfeited' and a.system_key = 'deposits_held'
        group by l.contract_id`, [scope, asOf]);
    for (const f of forf.rows) { add(sub, f.contract_id, -h(f.amt)); parts.forfeited += h(f.amt); }
    const cmp = compare(ledger, sub, (k) => ({ contractId: k }));
    return mk("R2", "deposits_held", {
      status: cmp.rows.length ? "difference" : "ok",
      ledger: money(cmp.l), subLedger: money(cmp.s), difference: money(cmp.l - cmp.s), rows: cmp.rows,
      explanations: [
        { code: "components", count: 0, amount: null, items: [Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, money(v)]))] },
        { code: "inferred_refund_dates", count: vouchers.rows.filter((v: any) => v.status === "cancelled" && !v.v2_refund).length, amount: money(parts.legacyReturned) },
        { code: "forfeits_from_ledger", count: forf.rowCount ?? 0, amount: money(parts.forfeited) },
      ],
      notes: [],
    });
  }

  /** Every collection ≤ asOf, classified by the engine's own §4.4.1 function. */
  private async collections(scope: number, asOf: string) {
    const r = await this.pool.query(
      `select pc.id, pc.payment_id, pc.amount::text as amount, pc.method, pc.notes, to_char(pc.collected_date, 'YYYY-MM-DD') as d,
              p.contract_id as p_contract, p.description as p_desc, si.kind as doc_kind, si.contract_id as doc_contract,
              to_char(si.issue_date, 'YYYY-MM-DD') as doc_issue, m.classification, m.bank_account_id
         from payment_collections pc
         left join payments p on p.id = pc.payment_id and p.user_id = pc.user_id
         left join simple_invoices si on si.id = pc.invoice_id and si.user_id = pc.user_id
         left join finance_collection_meta m on m.collection_id = pc.id and m.user_id = pc.user_id
        where pc.user_id = $1 and pc.collected_date <= $2::date order by pc.id`, [scope, asOf]);
    return r.rows.map((x: any) => {
      const amount = toHalalas(x.amount);
      const cls = classifyCollection({
        amount, metaClassification: x.classification ?? null, documentKind: x.doc_kind ?? null, paymentId: x.payment_id ?? null,
        paymentIsDeposit: x.payment_id != null && x.p_desc === DEPOSIT_DESC,
        looksLikeTerminateConversion: x.doc_kind === "deposit" && !x.payment_id && x.notes === CONVERSION_NOTE && !!x.doc_issue && x.d > x.doc_issue,
      });
      return { id: x.id as number, amount, rule: cls.rule, cls: cls.cls, principal: cls.treatment === "principal", contractId: (x.p_contract ?? x.doc_contract ?? null) as number | null, method: x.method as string | null, bankAccountId: x.bank_account_id as number | null };
    });
  }

  // ─── R3 ───
  private async r3(scope: number, asOf: string, mode: string | null, mk: any): Promise<Check> {
    if (mode === "owner") {
      return mk("R3", "landlord_payable", { status: "not_applicable", ledger: null, subLedger: null, difference: null, rows: [], explanations: [], notes: ["owner_mode: payouts are drawings; 2121 is not used"] });
    }
    if (!this.legacy) {
      return mk("R3", "landlord_payable", { status: "unavailable", ledger: null, subLedger: null, difference: null, rows: [], explanations: [], notes: ["legacy_dues_unavailable"] });
    }
    const holders = new Set((await this.pool.query(`select id from owners where user_id = $1 and is_account_holder`, [scope])).rows.map((x: any) => x.id));
    const ledger = await this.ledgerBy(scope, asOf, ["landlord_payable"], "owner_id", -1);
    const legacy = await this.legacy(scope);
    const sub = new Map<any, number>();
    const unresolved: any[] = [];
    for (const d of legacy.landlordDues) {
      if (d.ownerId == null) { unresolved.push({ landlord: d.landlord, remaining: money(toHalalas(Number(d.remaining).toFixed(2))) }); continue; }
      if (holders.has(d.ownerId)) continue;
      add(sub, d.ownerId, toHalalas(Number(d.remaining).toFixed(2)));
    }
    // The dues report counts payment-less collections on agency-fee documents as landlord rent; v2 books them as the account's fee.
    const agf = await this.pool.query(
      `select coalesce(fd.owner_id, pu.owner_id) as owner_id, sum(pc.amount)::text as amt
         from payment_collections pc join simple_invoices si on si.id = pc.invoice_id and si.user_id = pc.user_id
         left join finance_contract_dims fd on fd.contract_id = si.contract_id and fd.user_id = si.user_id
         left join lateral (select pr.owner_id from contract_units cu join units u on u.id = cu.unit_id join properties pr on pr.id = u.property_id
                             where cu.contract_id = si.contract_id order by cu.id limit 1) pu on true
        where pc.user_id = $1 and pc.payment_id is null and si.kind = 'agency_fee' group by 1`, [scope]);
    for (const a of agf.rows) if (a.owner_id != null && sub.has(a.owner_id)) add(sub, a.owner_id, -h(a.amt));
    // The dues report has a row only for landlords with a contract or an expense; a payout to any other landlord
    // (an advance before the first contract, say) is missing from it. Its `remaining` would be 0 − transferred.
    const listed = new Set(legacy.landlordDues.map((d) => d.ownerId).filter((x) => x != null));
    const orphanPayouts = (await this.pool.query(
      `select owner_id, sum(amount)::text as amt from landlord_payouts where user_id = $1 and deleted_at is null and owner_id is not null group by 1`, [scope]))
      .rows.filter((x: any) => !listed.has(x.owner_id) && !holders.has(x.owner_id));
    for (const x of orphanPayouts) add(sub, x.owner_id, -h(x.amt));
    for (const k of holders) ledger.delete(k);
    const byRule = async (rules: string[]) => {
      const r = await this.pool.query(
        `select l.owner_id, sum(l.credit - l.debit)::text as amt from journal_lines l
           join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id join accounts a on a.id = l.account_id and a.user_id = l.user_id
          where l.user_id = $1 and l.entry_date <= $2::date and a.system_key = 'landlord_payable' and e.payload->>'rule' = any($3::text[])
          group by 1`, [scope, asOf, rules]);
      return r.rows.filter((x: any) => h(x.amt) !== 0).map((x: any) => ({ ownerId: x.owner_id, amount: fromHalalas(h(x.amt)) }));
    };
    const companyExp = await this.pool.query(
      `select coalesce(e.owner_id, p.owner_id) as owner_id, sum(e.amount)::text as amt
         from expenses e join finance_expense_details d on d.expense_id = e.id and d.user_id = e.user_id
         left join properties p on p.id = e.property_id and p.user_id = e.user_id
        where e.user_id = $1 and e.deleted_at is null and d.charge_to = 'company' and coalesce(e.owner_id, p.owner_id) is not null group by 1`, [scope]);
    const maint = legacy.landlordStatement.filter((x) => x.ownerId != null && Number(x.maintenance) !== 0)
      .map((x) => ({ ownerId: x.ownerId, amount: money(toHalalas(Number(x.maintenance).toFixed(2))) }));
    const names = await namesOf(this.pool, scope, "owners", [...new Set([...ledger.keys(), ...sub.keys()])].filter((x) => x != null));
    const cmp = compare(ledger, sub, (k) => ({ ownerId: k, landlordName: k != null ? names.get(k) ?? null : null }));
    const expl = (code: string, items: any[]) => ({ code, count: items.length, amount: null, items });
    return mk("R3", "landlord_payable", {
      status: cmp.rows.length ? "difference" : "ok",
      ledger: money(cmp.l), subLedger: money(cmp.s), difference: money(cmp.l - cmp.s), rows: cmp.rows,
      explanations: [
        expl("maintenance_estimates_deducted_by_dues_report", maint),
        expl("commission_cash_E16", await byRule(["E16"])),
        expl("commission_credit_notes_E36", await byRule(["E36"])),
        expl("forfeited_deposits_kept_for_landlord_E11", await byRule(["E11"])),
        expl("owner_expenses_charged_to_company", companyExp.rows.map((x: any) => ({ ownerId: x.owner_id, amount: fromHalalas(h(x.amt)) }))),
        expl("agency_fee_collections_excluded", agf.rows.map((x: any) => ({ ownerId: x.owner_id, amount: fromHalalas(h(x.amt)) }))),
        expl("unresolved_landlords_in_dues_report", unresolved),
        expl("payouts_missing_from_dues_report", orphanPayouts.map((x: any) => ({ ownerId: x.owner_id, amount: fromHalalas(h(x.amt)) }))),
      ],
      notes: asOf === riyadhToday() ? [] : ["dues_report_is_current_not_as_of"],
    });
  }

  // ─── R4 ───
  private async r4(scope: number, asOf: string, mode: "owner" | "manager" | null, mk: any): Promise<Check> {
    const accts = (await this.pool.query(
      `select a.id, a.code, a.name_ar, a.name_en, a.system_key from accounts a join accounts g on g.id = a.parent_id and g.user_id = a.user_id
        where a.user_id = $1 and g.code = '1110' and not a.is_group order by a.code`, [scope])).rows;
    const ids = new Set<number>(accts.map((a: any) => a.id));
    const ledgerR = await this.pool.query(
      `select l.account_id, sum(l.debit - l.credit)::text as bal,
              coalesce(sum(l.debit - l.credit) filter (where e.origin in ('manual','opening','closing') or e.payload->>'rule' = 'E33'
                or (e.origin = 'reversal' and (o.origin in ('manual','opening','closing') or o.payload->>'rule' = 'E33'))), 0)::text as own
         from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
         left join journal_entries o on o.id = e.reversal_of and o.user_id = e.user_id
        where l.user_id = $1 and l.entry_date <= $2::date and l.account_id = any($3::int[]) group by 1`, [scope, asOf, [...ids]]);
    const ledger = new Map<number, number>();
    const sub = new Map<number, number>();
    for (const x of ledgerR.rows) {
      ledger.set(x.account_id, h(x.bal));
      add(sub, x.account_id, h(x.own)); // manual, opening and Ejar cash-in-transit lines have no other record
    }

    const st = (await this.pool.query(
      `select default_cash_account_id as dc, default_bank_account_id as db, agency_collections_to_trust as trust from finance_settings where account_user_id = $1`,
      [scope])).rows[0] ?? {};
    const banks = new Map<number, any>((await this.pool.query(
      `select id, gl_account_id, is_active, is_trust, is_default, kind from bank_accounts where user_id = $1`, [scope])).rows.map((b: any) => [b.id, b]));
    const sys = new Map<string, number>(accts.filter((a: any) => a.system_key).map((a: any) => [a.system_key, a.id]));
    let defaulted = 0;
    const resolve = (ref: { bankAccountId?: number | null; method?: string | null; agency?: boolean }): number | null => {
      const b = ref.bankAccountId != null ? banks.get(ref.bankAccountId) : null;
      if (b?.is_active) return b.gl_account_id;
      defaulted++;
      if (ref.agency && st.trust) {
        const t = [...banks.values()].filter((x) => x.is_trust && x.is_default && x.is_active && x.kind === "bank").sort((a, c) => a.id - c.id)[0];
        if (t) return t.gl_account_id;
      }
      const cash = String(ref.method ?? "").toLowerCase() === "cash";
      const d = banks.get(cash ? st.dc : st.db);
      if (d?.is_active) return d.gl_account_id;
      return sys.get(cash ? "cash" : "bank_default") ?? null;
    };
    const holders = new Set((await this.pool.query(`select id from owners where user_id = $1 and is_account_holder`, [scope])).rows.map((x: any) => x.id));
    const dims = await contractDims(this.pool, scope);
    const agent = (contractId: number | null) => {
      const ownerId = contractId != null ? dims.get(contractId)?.ownerId ?? null : null;
      return resolveTreatment(mode ?? "manager", ownerId != null ? { id: ownerId, isAccountHolder: holders.has(ownerId) } : null).treatment === "agent";
    };
    const agentOwner = (ownerId: number | null) =>
      resolveTreatment(mode ?? "manager", ownerId != null ? { id: ownerId, isAccountHolder: holders.has(ownerId) } : null).treatment === "agent";
    const put = (ref: Parameters<typeof resolve>[0], amt: number) => {
      const acc = resolve(ref);
      if (acc != null) add(sub, acc, amt);
    };

    for (const c of await this.collections(scope, asOf)) {
      if (c.rule === "E03" || c.rule === "E04") put({ bankAccountId: c.bankAccountId, method: c.method, agency: !c.principal && agent(c.contractId) }, c.amount);
      else if (c.rule === "E09C") put({ bankAccountId: c.bankAccountId, method: c.method, agency: agent(c.contractId) }, c.amount);
      else if (c.rule === "E16" && c.cls === "commission_cash" && agent(c.contractId)) put({ bankAccountId: c.bankAccountId, method: c.method }, c.amount);
    }
    const vouchers = await this.pool.query(
      `select v.id, v.status::text as status, v.total::text as total, v.payment_method, c.deposit_status, v.contract_id, v.client->>'ownerId' as client_owner,
              to_char(coalesce(v.paid_date, v.issue_date, (v.confirmed_at at time zone 'Asia/Riyadh')::date), 'YYYY-MM-DD') as d,
              to_char((v.updated_at at time zone 'Asia/Riyadh')::date, 'YYYY-MM-DD') as upd,
              (select coalesce(sum(pc.amount), 0) from payment_collections pc where pc.user_id = v.user_id and pc.invoice_id = v.id and pc.payment_id is not null)::text as linked,
              exists (select 1 from finance_deposit_refunds r where r.user_id = v.user_id and v.id = any(r.voucher_ids)) as v2_refund,
              dm.bank_account_id
         from simple_invoices v left join contracts c on c.id = v.contract_id and c.user_id = v.user_id
         left join finance_document_meta dm on dm.document_id = v.id and dm.user_id = v.user_id
        where v.user_id = $1 and v.kind = 'deposit' and v.deleted_at is null
          and (v.status = 'confirmed' or (v.status = 'cancelled' and c.deposit_status = 'returned'))`, [scope]);
    for (const v of vouchers.rows) {
      const unlinked = Math.max(0, h(v.total) - h(v.linked));
      const co = Number(v.client_owner);
      const agency = v.contract_id != null ? agent(v.contract_id) : agentOwner(Number.isInteger(co) && co > 0 ? co : null);
      // E09 books the voucher into the account it was received into (finance_document_meta), as the engine does.
      if (v.d && v.d <= asOf) put({ bankAccountId: v.bank_account_id, method: v.payment_method, agency }, unlinked);
      if (v.status === "cancelled" && !v.v2_refund && v.upd <= asOf) put({ method: v.payment_method, agency: v.contract_id != null && agent(v.contract_id) }, -unlinked);
    }
    for (const r of (await this.pool.query(
      `select amount::text as amount, bank_account_id, method, contract_id from finance_deposit_refunds where user_id = $1 and refunded_on <= $2::date`, [scope, asOf])).rows) {
      put({ bankAccountId: r.bank_account_id, method: r.method, agency: agent(r.contract_id) }, -h(r.amount));
    }
    for (const r of (await this.pool.query(
      `select amount::text as amount, bank_account_id, method, contract_id from tenant_credit_actions where user_id = $1 and kind = 'refund' and status = 'posted' and action_on <= $2::date`,
      [scope, asOf])).rows) {
      put({ bankAccountId: r.bank_account_id, method: r.method, agency: r.contract_id != null && agent(r.contract_id) }, -h(r.amount));
    }
    for (const p of (await this.pool.query(
      `select lp.amount::text as amount, lp.method, lp.transfer_date, lp.owner_id, to_char((lp.created_at at time zone 'Asia/Riyadh')::date, 'YYYY-MM-DD') as created,
              to_char(m.paid_on, 'YYYY-MM-DD') as paid_on, m.bank_account_id
         from landlord_payouts lp left join finance_payout_meta m on m.payout_id = lp.id and m.user_id = lp.user_id
        where lp.user_id = $1 and lp.deleted_at is null`, [scope])).rows) {
      const d = p.paid_on ?? parseBusinessDate(p.transfer_date) ?? p.created;
      if (d <= asOf) put({ bankAccountId: p.bank_account_id, method: p.method, agency: agentOwner(p.owner_id ?? null) }, -h(p.amount));
    }
    for (const e of (await this.pool.query(
      `select e.amount::text as amount, e.expense_date, to_char((e.created_at at time zone 'Asia/Riyadh')::date, 'YYYY-MM-DD') as created,
              d.gross_amount::text as gross, to_char(d.expense_on, 'YYYY-MM-DD') as expense_on, d.bank_account_id
         from expenses e left join finance_expense_details d on d.expense_id = e.id and d.user_id = e.user_id
        where e.user_id = $1 and e.deleted_at is null`, [scope])).rows) {
      const d = e.expense_on ?? parseBusinessDate(e.expense_date) ?? e.created;
      if (d <= asOf) put({ bankAccountId: e.bank_account_id }, -h(e.gross ?? e.amount));
    }

    for (const k of [...sub.keys()]) if (!ids.has(k)) sub.delete(k);
    const byId = new Map(accts.map((a: any) => [a.id, a]));
    const cmp = compare(ledger, sub, (k) => ({ accountId: k, code: byId.get(k)?.code ?? null, name: byId.get(k)?.name_ar ?? null, nameEn: byId.get(k)?.name_en ?? null }));
    const balances = accts.map((a: any) => ({ accountId: a.id, code: a.code, nameAr: a.name_ar, nameEn: a.name_en, ledger: money(ledger.get(a.id) ?? 0), subLedger: money(sub.get(a.id) ?? 0) }))
      .filter((x: any) => x.ledger !== "0.00" || x.subLedger !== "0.00");
    return mk("R4", "bank_and_cash", {
      status: cmp.rows.length ? "difference" : "ok",
      ledger: money(cmp.l), subLedger: money(cmp.s), difference: money(cmp.l - cmp.s), rows: cmp.rows,
      explanations: [
        { code: "no_account_chosen_defaulted", count: defaulted, amount: null },
        { code: "balances", count: balances.length, amount: null, items: balances },
      ],
      notes: ["manual, opening and cash-in-transit (E33) lines count on both sides: they have no other record"],
    });
  }

  // ─── R5 ───
  private async r5(scope: number, asOf: string, mk: any): Promise<Check> {
    const led = await this.pool.query(
      `select coalesce(l.seller_key, 'account') as seller, sum(l.credit - l.debit)::text as vat from journal_lines l
        where l.user_id = $1 and l.entry_date <= $2::date and l.tax_role = 'output' and l.vat_category = 'S' group by 1 order by 1`, [scope, asOf]);
    const ledger = led.rows.reduce((t: number, x: any) => t + h(x.vat), 0);
    const docs = await this.pool.query(
      `select coalesce(sum((total - subtotal) * case when type = 'credit' then -1 else 1 end), 0)::text as vat,
              coalesce(sum((total - subtotal) * case when type = 'credit' then -1 else 1 end) filter (where
                exists (select 1 from ledger_outbox o where o.user_id = si.user_id and o.source_type = 'simple_invoice' and o.source_id = si.id
                         and o.event = 'confirmed' and o.status = 'skipped' and o.skip_reason = 'self_commission')), 0)::text as self_comm
         from simple_invoices si
        where si.user_id = $1 and si.status = 'confirmed' and si.deleted_at is null and coalesce(si.kind, 'invoice') not in ('deposit','receipt')
          and coalesce(si.issue_date, (si.confirmed_at at time zone 'Asia/Riyadh')::date) <= $2::date`, [scope, asOf]);
    const due = await this.pool.query(
      `select coalesce(sum(vat_amount), 0)::text as vat, count(*) filter (where vat_amount > 0)::int as n from finance_installment_charges
        where user_id = $1 and charged_by = 'due' and reversed_at is null and charged_on <= $2::date`, [scope, asOf]);
    const adv = await this.pool.query(
      `select coalesce(sum(v.vat_booked), 0)::text as vat, count(*)::int as n from finance_installment_vat_points v
        where v.user_id = $1 and v.booked_on <= $2::date
          and not exists (select 1 from finance_installment_charges c where c.user_id = v.user_id and c.payment_id = v.payment_id
                           and c.reversed_at is null and c.charged_by = 'document' and c.charged_on <= $2::date)`, [scope, asOf]);
    const forf = await this.pool.query(
      `select coalesce(sum(l.credit - l.debit), 0)::text as vat from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
        where l.user_id = $1 and l.entry_date <= $2::date and l.tax_role = 'output' and l.vat_category = 'S' and e.payload->>'rule' in ('E11','E12')`, [scope, asOf]);
    const selfComm = h(docs.rows[0].self_comm);
    const sub = h(docs.rows[0].vat) - selfComm + h(due.rows[0].vat) + h(adv.rows[0].vat) + h(forf.rows[0].vat);
    return mk("R5", "output_vat", {
      status: ledger === sub ? "ok" : "difference",
      ledger: money(ledger), subLedger: money(sub), difference: money(ledger - sub),
      rows: led.rows.map((x: any) => ({ seller: x.seller, ledger: fromHalalas(h(x.vat)) })),
      explanations: [
        { code: "documents_vat", count: 0, amount: money(h(docs.rows[0].vat)) },
        { code: "self_commission_not_posted", count: 0, amount: money(selfComm) },
        { code: "vat_without_tax_invoice_due_charges", count: due.rows[0].n, amount: money(h(due.rows[0].vat)) },
        { code: "vat_without_tax_invoice_advances", count: adv.rows[0].n, amount: money(h(adv.rows[0].vat)) },
        { code: "forfeited_deposit_vat_from_ledger", count: 0, amount: money(h(forf.rows[0].vat)) },
      ],
      notes: [],
    });
  }

  // ─── R6 ───
  private async r6(scope: number, asOf: string, goLive: string | null, mk: any): Promise<Check> {
    const since = goLive ?? "0001-01-01";
    const counts = await this.pool.query(
      `select status, count(*)::int as n from ledger_outbox where user_id = $1 and occurred_on <= $2::date group by status`, [scope, asOf]);
    const byStatus = Object.fromEntries(counts.rows.map((x: any) => [x.status, x.n]));
    const has = (st: string, ev: string) => `(exists (select 1 from ledger_outbox o where o.user_id = x.user_id and o.source_type = '${st}' and o.source_id = x.id and o.event like '${ev}')
      or exists (select 1 from journal_entries e where e.user_id = x.user_id and e.source_type = '${st}' and e.source_id = x.id and e.event like '${ev}'))`;
    const missing = await this.pool.query(
      `select 'simple_invoice' as "sourceType", x.id as "sourceId", x.number as ref, x.d as date from (
         select si.*, to_char(coalesce(si.issue_date, (si.confirmed_at at time zone 'Asia/Riyadh')::date), 'YYYY-MM-DD') as d from simple_invoices si
          where si.user_id = $1 and si.status = 'confirmed' and si.deleted_at is null and coalesce(si.kind, 'invoice') <> 'receipt') x
        where x.d between $3 and $2 and not ${has("simple_invoice", "%")}
       union all
       select 'payment_collection', x.id, x.receipt_number, to_char(x.collected_date, 'YYYY-MM-DD') from payment_collections x
        where x.user_id = $1 and x.collected_date between $3::date and $2::date and not ${has("payment_collection", "%")}
          and not exists (select 1 from simple_invoices si where si.id = x.invoice_id and si.user_id = x.user_id and si.kind = 'deposit' and x.payment_id is null)
       union all
       select 'expense', x.id, x.category, coalesce(substring(x.expense_date from 1 for 10), to_char((x.created_at at time zone 'Asia/Riyadh')::date, 'YYYY-MM-DD'))
         from expenses x where x.user_id = $1 and x.deleted_at is null and not ${has("expense", "rev:%")}
          and coalesce(substring(x.expense_date from 1 for 10), to_char((x.created_at at time zone 'Asia/Riyadh')::date, 'YYYY-MM-DD')) between $3 and $2
       union all
       select 'landlord_payout', x.id, x.reference, coalesce(substring(x.transfer_date from 1 for 10), to_char((x.created_at at time zone 'Asia/Riyadh')::date, 'YYYY-MM-DD'))
         from landlord_payouts x where x.user_id = $1 and x.deleted_at is null and not ${has("landlord_payout", "created")}
          and coalesce(substring(x.transfer_date from 1 for 10), to_char((x.created_at at time zone 'Asia/Riyadh')::date, 'YYYY-MM-DD')) between $3 and $2
       union all
       select 'payment', x.id, null, to_char(x.due_date, 'YYYY-MM-DD') from payments x
         join contracts c on c.id = x.contract_id and c.user_id = x.user_id and c.deleted_at is null
        where x.user_id = $1 and x.deleted_at is null and x.status::text not in ('cancelled') and coalesce(x.description, '') <> $4
          and x.due_date >= $3::date and x.due_date < least($2::date, (now() at time zone 'Asia/Riyadh')::date) and not ${has("payment", "charge%")}
          and not exists (select 1 from finance_installment_charges ch where ch.user_id = x.user_id and ch.payment_id = x.id and ch.reversed_at is null)
       order by 1, 4, 2`, [scope, asOf, since, DEPOSIT_DESC]);
    const entries = await this.pool.query(`select count(*)::int as n from journal_entries where user_id = $1 and entry_date <= $2::date`, [scope, asOf]);
    const failed = (byStatus.failed ?? 0) + (byStatus.pending ?? 0);
    return mk("R6", "posting_completeness", {
      status: missing.rowCount || failed ? "attention" : "ok",
      ledger: String(entries.rows[0].n), subLedger: null, difference: String(missing.rowCount ?? 0),
      rows: missing.rows.slice(0, LIST_LIMIT),
      explanations: ["pending", "failed", "dismissed", "skipped"].map((k) => ({ code: `outbox_${k}`, count: byStatus[k] ?? 0, amount: null })),
      notes: goLive ? [`cutover: sources before ${goLive} are in the opening balance`] : [],
    });
  }

  // ─── R7 ───
  private async r7(scope: number, asOf: string, mk: any): Promise<Check> {
    const list = async (code: string, sql: string, params: unknown[]) => {
      const r = await this.pool.query(sql, params);
      return { code, count: r.rowCount ?? 0, amount: null, items: r.rows.slice(0, LIST_LIMIT) };
    };
    const ex = [
      await list("paid_without_full_collections",
        `select p.id as "paymentId", p.contract_id as "contractId", p.amount::text as amount, coalesce(sum(c.amount), 0)::text as collected
           from payments p left join payment_collections c on c.payment_id = p.id and c.user_id = p.user_id
          where p.user_id = $1 and p.status = 'paid' and p.deleted_at is null and coalesce(p.description, '') <> $2
          group by p.id having coalesce(sum(c.amount), 0) < p.amount order by p.id`, [scope, DEPOSIT_DESC]),
      await list("cancelled_but_invoiced",
        `select p.id as "paymentId", p.contract_id as "contractId", si.id as "documentId", si.number
           from payments p join simple_invoices si on si.user_id = p.user_id and si.status = 'confirmed' and si.deleted_at is null and si.type = 'invoice'
            and (si.payment_id = p.id or coalesce(si.payment_ids, '[]'::jsonb) @> to_jsonb(p.id))
          where p.user_id = $1 and p.status = 'cancelled' and p.deleted_at is null order by p.id`, [scope]),
      await list("collections_on_deleted_installments",
        `select c.id as "collectionId", c.payment_id as "paymentId", c.amount::text as amount
           from payment_collections c join payments p on p.id = c.payment_id and p.user_id = c.user_id
          where c.user_id = $1 and p.deleted_at is not null order by c.id`, [scope]),
      await list("open_installments_after_contract_end",
        `select p.id as "paymentId", p.contract_id as "contractId", to_char(p.due_date, 'YYYY-MM-DD') as "dueDate", p.status::text as status,
                to_char(d.ended_on, 'YYYY-MM-DD') as "endedOn"
           from payments p join contracts c on c.id = p.contract_id and c.user_id = p.user_id
           join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
          where p.user_id = $1 and p.deleted_at is null and c.status in ('terminated','cancelled') and d.ended_on is not null
            and p.due_date > d.ended_on and p.status::text in ('pending','overdue','partially_paid') order by p.id`, [scope]),
      await list("unreleased_rent_after_contract_end",
        `select l.payment_id as "paymentId", l.contract_id as "contractId", sum(l.credit - l.debit)::text as unreleased
           from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
           join finance_contract_dims d on d.contract_id = l.contract_id and d.user_id = l.user_id
          where l.user_id = $1 and a.system_key = 'unearned_rent' and d.ended_on is not null and l.entry_date <= $2::date
            and exists (select 1 from payments p where p.id = l.payment_id and p.user_id = l.user_id and p.due_date > d.ended_on)
          group by 1, 2 having sum(l.credit - l.debit) <> 0 order by 1`, [scope, asOf]),
      await list("vat_without_tax_invoice",
        `select ch.payment_id as "paymentId", 'due_charge' as kind, ch.vat_amount::text as vat from finance_installment_charges ch
          where ch.user_id = $1 and ch.charged_by = 'due' and ch.reversed_at is null and ch.vat_amount > 0 and ch.charged_on <= $2::date
         union all
         select v.payment_id, 'advance', v.vat_booked::text from finance_installment_vat_points v
          where v.user_id = $1 and v.booked_on <= $2::date and not exists (select 1 from finance_installment_charges c where c.user_id = v.user_id
                and c.payment_id = v.payment_id and c.reversed_at is null and c.charged_by = 'document')
         order by 1`, [scope, asOf]),
    ];
    const n = ex.reduce((t, e) => t + e.count, 0);
    return mk("R7", "subledger_integrity", {
      status: n ? "attention" : "ok", ledger: null, subLedger: null, difference: null, rows: [], explanations: ex, notes: [],
    });
  }

  // ─── R8 ───
  private async r8(scope: number, asOf: string, mk: any): Promise<Check> {
    const t = await this.pool.query(
      `select coalesce(sum(debit), 0)::text as d, coalesce(sum(credit), 0)::text as c from journal_lines where user_id = $1 and entry_date <= $2::date`, [scope, asOf]);
    const bad = await this.pool.query(
      `select entry_id::int as "entryId", sum(debit)::text as debit, sum(credit)::text as credit from journal_lines
        where user_id = $1 and entry_date <= $2::date group by entry_id having sum(debit) <> sum(credit) order by 1 limit ${LIST_LIMIT}`, [scope, asOf]);
    const d = h(t.rows[0].d);
    const c = h(t.rows[0].c);
    return mk("R8", "trial_balance", {
      status: d === c && !bad.rowCount ? "ok" : "difference",
      ledger: money(d), subLedger: money(c), difference: money(d - c), rows: bad.rows,
      explanations: [], notes: ["ledger = Σ debit, subLedger = Σ credit; the database refuses an unbalanced entry"],
    });
  }
}
