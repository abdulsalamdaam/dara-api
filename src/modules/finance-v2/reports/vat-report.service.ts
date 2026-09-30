import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { FV2_POOL, type Fv2Client, type Fv2Pool } from "../db";
import { fromHalalas, mulDivRound } from "../money";
import { lastDayOfMonth, riyadhToday } from "../dates";
import { addDays, fyStartOf, riyadhNow } from "./core-math";
import { h, langOf, scopedId, settingsOf, type Lang } from "./common";
import { apportion, netBoxes, vatBoxes, type VatAgg, type VatCat } from "./sub-math";

/**
 * VAT return summary in the ZATCA VAT return layout (DESIGN §7.5), with the
 * §8.2(b) input-VAT apportionment on overheads.
 *
 * Source: `journal_lines` with `tax_role` set, `seller_key = :seller`, and
 * `entry_date` in the return period (late lines posted into the period are in
 * the boxes, and are also listed with their original dates).
 *
 * The same computation feeds the VAT return lock (VatReturnsService), so the
 * settlement entry E37 always equals boxes 6, 12 and 13 of this report.
 */

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

export interface VatPeriod { key: string; from: string; to: string }

const pad = (n: number) => String(n).padStart(2, "0");

/** '2026-Q1' (calendar quarter) or '2026-03' (month). */
export function parseVatPeriod(key: string): VatPeriod {
  const q = /^(\d{4})-Q([1-4])$/.exec(key);
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  if (q) {
    const y = Number(q[1]);
    const first = (Number(q[2]) - 1) * 3 + 1;
    return { key, from: `${y}-${pad(first)}-01`, to: `${y}-${pad(first + 2)}-${pad(lastDayOfMonth(y, first + 2))}` };
  }
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    return { key, from: `${y}-${pad(mo)}-01`, to: `${y}-${pad(mo)}-${pad(lastDayOfMonth(y, mo))}` };
  }
  throw new BadRequestException({ error: "BAD_PERIOD", message: "period must be YYYY-Qn or YYYY-MM" });
}

/** The period of the same kind immediately before. */
export function previousVatPeriod(p: VatPeriod): VatPeriod {
  const q = /^(\d{4})-Q([1-4])$/.exec(p.key);
  if (q) {
    const y = Number(q[1]);
    const n = Number(q[2]);
    return parseVatPeriod(n === 1 ? `${y - 1}-Q4` : `${y}-Q${n - 1}`);
  }
  const [y, m] = p.key.split("-").map(Number);
  return parseVatPeriod(m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`);
}

export function parseSeller(v: unknown): string {
  if (v == null || v === "" || v === "account") return "account";
  if (typeof v === "string" && /^owner:[1-9][0-9]*$/.test(v)) return v;
  throw new BadRequestException({ error: "BAD_SELLER", message: "seller must be 'account' or 'owner:<id>'" });
}

export const BOX_LABELS: Record<number, { ar: string; en: string }> = {
  1: { ar: "المبيعات الخاضعة للنسبة الأساسية", en: "Standard rated sales" },
  2: { ar: "المبيعات للمواطنين (الخدمات الصحية الخاصة والتعليم الأهلي الخاص)", en: "Sales to citizens (private healthcare / private education)" },
  3: { ar: "المبيعات المحلية الخاضعة للنسبة الصفرية", en: "Zero rated domestic sales" },
  4: { ar: "الصادرات", en: "Exports" },
  5: { ar: "المبيعات المعفاة", en: "Exempt sales" },
  6: { ar: "إجمالي المبيعات", en: "Total sales" },
  7: { ar: "المشتريات الخاضعة للنسبة الأساسية", en: "Standard rated domestic purchases" },
  8: { ar: "الاستيرادات الخاضعة للضريبة بالنسبة الأساسية والتي تُدفع في الجمارك", en: "Imports subject to VAT paid at customs" },
  9: { ar: "الاستيرادات الخاضعة للضريبة التي تُطبق عليها آلية الاحتساب العكسي", en: "Imports subject to VAT accounted for through reverse charge" },
  10: { ar: "المشتريات الخاضعة للنسبة الصفرية", en: "Zero rated purchases" },
  11: { ar: "المشتريات المعفاة", en: "Exempt purchases" },
  12: { ar: "إجمالي المشتريات", en: "Total purchases" },
  13: { ar: "إجمالي ضريبة القيمة المضافة المستحقة عن الفترة الحالية", en: "Total VAT due for current period" },
  14: { ar: "تصحيحات من الفترات السابقة (بين ±5,000 ريال)", en: "Corrections from previous period (between SAR ±5,000)" },
  15: { ar: "ضريبة القيمة المضافة المرحّلة من الفترات السابقة", en: "VAT credit carried forward from previous period(s)" },
  16: { ar: "صافي الضريبة المستحقة (أو المطالب بها)", en: "Net VAT due (or claimed)" },
};

/** Everything the lock needs, in halalas. */
export interface VatComputation {
  period: VatPeriod;
  seller: string;
  rows: VatAgg[];
  outputVat: number;
  inputVatBooked: number;
  apportionment: ReturnType<typeof apportion> & {
    method: "direct_plus_ratio" | "direct_only";
    basis: { from: string; to: string; source: "previous_year" | "year_to_date"; taxable: number; exempt: number } | null;
    overheadVat: number;
    overheadBookedRecoverable: number;
  };
  inputVatClaimed: number;
  box14: number;
  box15: number;
  box13: number;
  box16: number;
  draft: { id: number; lockedAt: Date | null; lockedBy: number | null } | null;
}

@Injectable()
export class VatReportService {
  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool) {}

  /** Aggregates of VAT-attributed lines for a seller and date range. */
  async aggregates(q: Q, scope: number, seller: string, from: string, to: string): Promise<VatAgg[]> {
    const r = await q.query(
      `select l.tax_role, l.vat_category, l.doc_class, (e.origin = 'reversal') as rev,
              coalesce(sum(l.vat_base), 0)::text as base,
              coalesce(sum(case when l.tax_role = 'output' then l.credit - l.debit else l.debit - l.credit end), 0)::text as amount
         from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
        where l.user_id = $1 and coalesce(l.seller_key, 'account') = $2 and l.entry_date between $3::date and $4::date
          and l.tax_role is not null and l.vat_category is not null
        group by 1, 2, 3, 4`, [scope, seller, from, to]);
    return r.rows.map((x: any) => ({
      taxRole: x.tax_role, category: x.vat_category as VatCat, docClass: x.doc_class, reversal: x.rev === true, base: h(x.base), amount: h(x.amount),
    }));
  }

  /** Taxable (S + Z) and exempt (E) supply bases of the account's own sales, for the ratio. */
  private async supplies(q: Q, scope: number, from: string, to: string) {
    const r = await q.query(
      `select coalesce(sum(l.vat_base) filter (where l.vat_category in ('S','Z')), 0)::text as taxable,
              coalesce(sum(l.vat_base) filter (where l.vat_category = 'E'), 0)::text as exempt
         from journal_lines l
        where l.user_id = $1 and coalesce(l.seller_key, 'account') = 'account' and l.tax_role = 'output'
          and l.entry_date between $2::date and $3::date`, [scope, from, to]);
    return { taxable: Math.max(0, h(r.rows[0].taxable)), exempt: Math.max(0, h(r.rows[0].exempt)) };
  }

  /** Input VAT on overheads (S purchases with no property) of the account itself. */
  private async overheads(q: Q, scope: number, from: string, to: string) {
    const r = await q.query(
      `select coalesce(sum(l.debit - l.credit), 0)::text as vat,
              coalesce(sum(l.debit - l.credit) filter (where l.tax_role = 'input'), 0)::text as rec
         from journal_lines l
        where l.user_id = $1 and coalesce(l.seller_key, 'account') = 'account' and l.vat_category = 'S'
          and l.tax_role in ('input','input_nonrecoverable') and l.property_id is null
          and l.entry_date between $2::date and $3::date`, [scope, from, to]);
    return { vat: h(r.rows[0].vat), rec: h(r.rows[0].rec) };
  }

  /** The §8.2(b) ratio basis: the previous fiscal year, or the year to date when it made no supplies. */
  private async basis(q: Q, scope: number, p: VatPeriod, sm: number) {
    const fy = fyStartOf(p.from, sm);
    const prevFy = fyStartOf(addDays(fy, -1), sm);
    const prev = await this.supplies(q, scope, prevFy, addDays(fy, -1));
    if (prev.taxable + prev.exempt > 0) return { from: prevFy, to: addDays(fy, -1), source: "previous_year" as const, ...prev };
    return { from: fy, to: p.to, source: "year_to_date" as const, ...(await this.supplies(q, scope, fy, p.to)) };
  }

  /** The whole return in halalas; `q` may be a transaction client (the lock). */
  async compute(q: Q, scope: number, p: VatPeriod, seller: string): Promise<VatComputation> {
    const s = await settingsOf(this.pool, scope);
    const rows = await this.aggregates(q, scope, seller, p.from, p.to);
    const base = vatBoxes(rows);
    let appo: VatComputation["apportionment"];
    if (seller === "account") {
      const b = await this.basis(q, scope, p, s.startMonth);
      const o = await this.overheads(q, scope, p.from, p.to);
      appo = {
        ...apportion({ method: s.inputVatMethod, taxable: b.taxable, exempt: b.exempt, overheadVat: o.vat, overheadBookedRecoverable: o.rec }),
        method: s.inputVatMethod, basis: b, overheadVat: o.vat, overheadBookedRecoverable: o.rec,
      };
    } else {
      appo = {
        applies: false, reason: "landlord_return", ratioPercent: null, recoverableAtRatio: 0, adjustment: 0,
        method: s.inputVatMethod, basis: null, overheadVat: 0, overheadBookedRecoverable: 0,
      };
    }
    const d = (await q.query(
      `select id, box14::text as box14, box15::text as box15, locked_at, locked_by
         from finance_vat_return_drafts where user_id = $1 and seller_key = $2 and period_start = $3`, [scope, seller, p.from])).rows[0];
    const box14 = h(d?.box14 ?? "0");
    const box15 = h(d?.box15 ?? "0");
    const inputVatClaimed = base.inputVatBooked + appo.adjustment;
    const { box13, box16 } = netBoxes(base.outputVat, inputVatClaimed, box14, box15);
    return {
      period: p, seller, rows, outputVat: base.outputVat, inputVatBooked: base.inputVatBooked, apportionment: appo, inputVatClaimed,
      box14, box15, box13, box16,
      draft: d ? { id: Number(d.id), lockedAt: d.locked_at ?? null, lockedBy: d.locked_by ?? null } : null,
    };
  }

  private periodOf(q: Record<string, any>, freq: "monthly" | "quarterly"): VatPeriod {
    if (q.period) return parseVatPeriod(String(q.period));
    const today = riyadhToday();
    const y = q.year != null && q.year !== "" ? Number(q.year) : Number(today.slice(0, 4));
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new BadRequestException({ error: "BAD_PERIOD", message: "year must be a 4-digit year" });
    if (q.month != null && q.month !== "") {
      const m = Number(q.month);
      if (!Number.isInteger(m) || m < 1 || m > 12) throw new BadRequestException({ error: "BAD_PERIOD", message: "month must be 1..12" });
      return parseVatPeriod(`${y}-${pad(m)}`);
    }
    if (q.quarter != null && q.quarter !== "") {
      const n = Number(q.quarter);
      if (!Number.isInteger(n) || n < 1 || n > 4) throw new BadRequestException({ error: "BAD_PERIOD", message: "quarter must be 1..4" });
      return parseVatPeriod(`${y}-Q${n}`);
    }
    const m = Number(today.slice(5, 7));
    return freq === "monthly" ? parseVatPeriod(`${today.slice(0, 7)}`) : parseVatPeriod(`${y}-Q${Math.ceil(m / 3)}`);
  }

  /** GET /finance/v2/reports/vat-return */
  async vatReturn(scope: number, q: Record<string, any> = {}) {
    const lang: Lang = langOf(q.lang);
    const s = await settingsOf(this.pool, scope);
    const p = this.periodOf(q, s.frequency);
    const seller = parseSeller(q.seller);
    if (seller !== "account") await scopedId(this.pool, scope, "ownerId", Number(seller.slice(6)));
    const c = await this.compute(this.pool, scope, p, seller);
    const b = vatBoxes(c.rows, c.apportionment.adjustment);
    const label = (n: number) => (lang === "en" ? BOX_LABELS[n].en : BOX_LABELS[n].ar);
    const money = (x: number | null) => (x == null ? null : fromHalalas(x));

    // Box 15 suggestion: the previous return's net claim (a negative box 16).
    const prev = await this.compute(this.pool, scope, previousVatPeriod(p), seller);
    const box15Suggested = prev.box16 < 0 ? -prev.box16 : 0;

    const [late, gaps, docs, unposted, settlement, trueUp] = await Promise.all([
      this.lateItems(scope, p, seller), this.taxInvoiceGaps(scope, p, seller), this.documentCheck(scope, p, seller),
      this.unpostedDocuments(scope, p), c.draft ? this.settlementOf(scope, c.draft.id) : Promise.resolve(null),
      seller === "account" ? this.trueUp(scope, p, s.startMonth, c) : Promise.resolve(null),
    ]);

    const a = c.apportionment;
    return {
      report: "vat-return",
      lang,
      mode: s.mode,
      generatedAt: riyadhNow(),
      params: { period: p.key, from: p.from, to: p.to, seller, frequency: s.frequency },
      boxes: b.boxes.map((x) => ({ box: x.box, key: x.key, label: label(x.box), amount: fromHalalas(x.amount), adjustment: fromHalalas(x.adjustment), vat: money(x.vat) })),
      box13: { box: 13, label: label(13), vat: fromHalalas(c.box13) },
      box14: { box: 14, label: label(14), vat: fromHalalas(c.box14) },
      box15: { box: 15, label: label(15), vat: fromHalalas(c.box15), suggested: fromHalalas(box15Suggested) },
      box16: { box: 16, label: label(16), vat: fromHalalas(c.box16) },
      memo: {
        outOfScopeSales: { amount: fromHalalas(b.outOfScopeSales.amount), adjustment: fromHalalas(b.outOfScopeSales.adjustment) },
        outOfScopePurchases: { amount: fromHalalas(b.outOfScopePurchases.amount), adjustment: fromHalalas(b.outOfScopePurchases.adjustment) },
        nonRecoverableInput: { base: fromHalalas(b.nonRecoverable.base), vat: fromHalalas(b.nonRecoverable.vat) },
        inputVatBooked: fromHalalas(c.inputVatBooked),
      },
      apportionment: {
        method: a.method, applies: a.applies, reason: a.reason, ratioPercent: a.ratioPercent,
        basis: a.basis ? { from: a.basis.from, to: a.basis.to, source: a.basis.source, taxable: fromHalalas(a.basis.taxable), exempt: fromHalalas(a.basis.exempt) } : null,
        overheadVat: fromHalalas(a.overheadVat), overheadBookedRecoverable: fromHalalas(a.overheadBookedRecoverable),
        recoverableAtRatio: fromHalalas(a.recoverableAtRatio), adjustment: fromHalalas(a.adjustment),
        trueUp,
      },
      draft: c.draft ? { id: c.draft.id, locked: !!c.draft.lockedAt, lockedAt: c.draft.lockedAt, lockedBy: c.draft.lockedBy } : { id: null, locked: false, lockedAt: null, lockedBy: null },
      settlement,
      priorPeriodItems: late,
      taxInvoiceGaps: gaps,
      documentCheck: { rows: docs, unposted },
    };
  }

  /** Late VAT lines posted into this period, with their original dates (§4.7). */
  private async lateItems(scope: number, p: VatPeriod, seller: string) {
    const r = await this.pool.query(
      `select e.id::int as "entryId", e.entry_no as "entryNo", to_char(e.entry_date, 'YYYY-MM-DD') as "entryDate",
              to_char(e.original_date, 'YYYY-MM-DD') as "originalDate", e.source_type as "sourceType", e.source_id::int as "sourceId", e.event,
              coalesce(sum(l.credit - l.debit) filter (where l.tax_role = 'output' and l.vat_category = 'S'), 0)::text as "outputVat",
              coalesce(sum(l.debit - l.credit) filter (where l.tax_role = 'input' and l.vat_category = 'S'), 0)::text as "inputVat"
         from journal_entries e join journal_lines l on l.entry_id = e.id and l.user_id = e.user_id
        where e.user_id = $1 and e.is_late and e.original_date < $3::date and e.entry_date between $3::date and $4::date
          and coalesce(l.seller_key, 'account') = $2 and l.tax_role is not null
        group by e.id order by e.entry_date, e.id`, [scope, seller, p.from, p.to]);
    return r.rows.map((x: any) => ({ ...x, includedInBoxes: true }));
  }

  /** VAT booked with no tax invoice (due-date charges, advance VAT): issue the invoice before filing. */
  private async taxInvoiceGaps(scope: number, p: VatPeriod, seller: string) {
    const r = await this.pool.query(
      `select e.id::int as "entryId", e.entry_no as "entryNo", to_char(e.entry_date, 'YYYY-MM-DD') as "entryDate",
              e.source_type as "sourceType", e.source_id::int as "sourceId", e.event,
              min(l.payment_id) as "paymentId", min(l.contract_id) as "contractId", min(l.tenant_id) as "tenantId",
              coalesce(sum(l.credit - l.debit) filter (where l.tax_role = 'output' and l.vat_category = 'S'), 0)::text as vat
         from journal_entries e join journal_lines l on l.entry_id = e.id and l.user_id = e.user_id
        where e.user_id = $1 and 'vat_without_tax_invoice' = any(e.warnings) and e.status = 'posted'
          and e.entry_date between $3::date and $4::date and coalesce(l.seller_key, 'account') = $2
        group by e.id order by e.entry_date, e.id`, [scope, seller, p.from, p.to]);
    return r.rows;
  }

  /**
   * Confirmed documents' own VAT against the VAT their ledger entry carries for this seller.
   *
   * On the ACCOUNT's return it also lists every document whose entry booked
   * VAT under a seller no return reads (`owner:unresolved`: an agent landlord
   * that could not be resolved, or a free invoice posted before it was
   * recognised as the account's own sale). That VAT went to ZATCA under
   * someone, yet no VAT return carries it: it shows here with the account's
   * ledger VAT (0) and explanation `seller_unresolved`, never silently.
   */
  private async documentCheck(scope: number, p: VatPeriod, seller: string) {
    const r = await this.pool.query(
      `select d.id as "documentId", d.number, d.type::text as type, d.kind, to_char(d.issue_date, 'YYYY-MM-DD') as "issueDate",
              ((d.total - d.subtotal) * case when d.type = 'credit' then -1 else 1 end)::text as "documentVat",
              x.vat as "ledgerVat", x.entry_id as "entryId", x.adv as "advanceVatOnCovered", x.unresolved
         from journal_entries e
         join simple_invoices d on d.id = e.source_id and d.user_id = e.user_id
         join lateral (
           select coalesce(sum(l.credit - l.debit) filter (where l.tax_role = 'output' and l.vat_category = 'S'
                                                               and coalesce(l.seller_key, 'account') = $2), 0)::text as vat,
                  e.id::int as entry_id,
                  exists (select 1 from finance_installment_vat_points v where v.user_id = e.user_id
                           and v.payment_id in (select l2.payment_id from journal_lines l2 where l2.entry_id = e.id and l2.payment_id is not null)) as adv,
                  count(*) filter (where l.tax_role is not null and l.seller_key = 'owner:unresolved') > 0 as unresolved
             from journal_lines l where l.entry_id = e.id and l.user_id = e.user_id
           having count(*) filter (where l.tax_role is not null and coalesce(l.seller_key, 'account') = $2) > 0
               or ($2 = 'account' and count(*) filter (where l.tax_role = 'output' and l.seller_key = 'owner:unresolved') > 0)) x on true
        where e.user_id = $1 and e.source_type = 'simple_invoice' and e.event = 'confirmed' and e.origin <> 'reversal'
          and e.entry_date between $3::date and $4::date
        order by d.issue_date, d.id`, [scope, seller, p.from, p.to]);
    return r.rows.map(({ unresolved, ...x }: any) => {
      const diff = h(x.documentVat) - h(x.ledgerVat);
      const explanation = diff === 0 ? null
        : seller === "account" && unresolved ? "seller_unresolved"
        : x.advanceVatOnCovered ? "advance_vat_netted" : "unexplained";
      return { ...x, difference: fromHalalas(diff), explanation };
    });
  }

  /** Confirmed documents issued in the period with no ledger entry (not posted, or skipped by rule). */
  private async unpostedDocuments(scope: number, p: VatPeriod) {
    const r = await this.pool.query(
      `select d.id as "documentId", d.number, d.type::text as type, d.kind, to_char(d.issue_date, 'YYYY-MM-DD') as "issueDate",
              ((d.total - d.subtotal) * case when d.type = 'credit' then -1 else 1 end)::text as "documentVat",
              o.status as "outboxStatus", o.skip_reason as "skipReason"
         from simple_invoices d
         left join ledger_outbox o on o.user_id = d.user_id and o.source_type = 'simple_invoice' and o.source_id = d.id and o.event = 'confirmed'
        where d.user_id = $1 and d.status = 'confirmed' and d.deleted_at is null and coalesce(d.kind, 'invoice') not in ('deposit','receipt')
          and d.issue_date between $2::date and $3::date and d.total <> d.subtotal
          and not exists (select 1 from journal_entries e where e.user_id = d.user_id and e.source_type = 'simple_invoice'
                           and e.source_id = d.id and e.event = 'confirmed')
        order by d.issue_date, d.id`, [scope, p.from, p.to]);
    return r.rows;
  }

  private async settlementOf(scope: number, draftId: number) {
    const r = await this.pool.query(
      `select id::int as "entryId", entry_no as "entryNo", to_char(entry_date, 'YYYY-MM-DD') as "entryDate", status
         from journal_entries where user_id = $1 and source_type = 'vat_return' and source_id = $2 and event = 'settled'`, [scope, draftId]);
    return r.rows[0] ?? null;
  }

  /**
   * The annual true-up (§8.2(b)), proposed on the last return of the fiscal
   * year and never posted automatically: the year's overhead input VAT at the
   * year's actual ratio, less the same VAT at the provisional ratio the
   * returns used. The proposal is a manual journal (Dr 1151 / Cr 5500, or the
   * reverse) for the accountant; the recovered difference goes in box 14.
   */
  private async trueUp(scope: number, p: VatPeriod, sm: number, c: VatComputation) {
    const fy = fyStartOf(p.from, sm);
    const fyEnd = addDays(fyStartOf(addDays(fy, 366), sm), -1);
    if (p.to !== fyEnd || c.apportionment.method === "direct_only") return null;
    const actual = await this.supplies(this.pool, scope, fy, fyEnd);
    const o = await this.overheads(this.pool, scope, fy, fyEnd);
    const b = c.apportionment.basis;
    const at = (t: number, e: number) => (t > 0 && e > 0 ? mulDivRound(o.vat, t, t + e) : o.rec);
    const provisional = b ? at(b.taxable, b.exempt) : o.rec;
    const actualRec = at(actual.taxable, actual.exempt);
    const amount = actualRec - provisional;
    const abs = fromHalalas(Math.abs(amount));
    return {
      fiscalYearFrom: fy, to: fyEnd,
      actualRatioPercent: actual.taxable + actual.exempt > 0 ? fromHalalas(mulDivRound(actual.taxable, 10_000, actual.taxable + actual.exempt)) : null,
      overheadVat: fromHalalas(o.vat), provisionalRecoverable: fromHalalas(provisional), actualRecoverable: fromHalalas(actualRec),
      amount: fromHalalas(amount),
      proposedJournal: amount === 0 ? [] : amount > 0
        ? [{ accountCode: "1151", debit: abs, credit: "0.00" }, { accountCode: "5500", debit: "0.00", credit: abs }]
        : [{ accountCode: "5500", debit: abs, credit: "0.00" }, { accountCode: "1151", debit: "0.00", credit: abs }],
    };
  }
}
