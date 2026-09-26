import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { FV2_POOL, type Fv2Pool } from "../db";
import { fromHalalas, toHalalas } from "../money";
import { riyadhToday } from "../dates";
import { isoDate } from "../audit";
import { daysBetween, depths, fyStartOf, monthsIn, previousRange, riyadhNow, rollUp, sides, type TreeNode } from "./core-math";

/**
 * The core Finance v2 reports (DESIGN §7.1–7.4, §7.9): trial balance, general
 * ledger, income statement, balance sheet and the cash / bank book.
 *
 *  - Read-only. Every query is `where user_id = :scope` on every table read,
 *    and every id in the query string is loaded with the scope (a miss is 404).
 *  - Dates are inclusive `YYYY-MM-DD` in Asia/Riyadh; the default `to` is today.
 *  - Money is summed in SQL over numeric(14,2) and handled in integer halalas
 *    here; amounts leave as two-decimal strings.
 *  - Reversed entries and their reversals are both included (they net to zero).
 *  - Excel / PDF exports are rendered by the web from these responses (§7.12).
 */

export type Lang = "ar" | "en";
type AcctType = "asset" | "liability" | "equity" | "revenue" | "expense";

interface Acct {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string;
  type: AcctType;
  normalBalance: "debit" | "credit";
  parentId: number | null;
  isGroup: boolean;
  isActive: boolean;
  systemKey: string | null;
  bankAccountId: number | null;
}

export interface DimFilter {
  ownerId?: number;
  propertyId?: number;
  unitId?: number;
  tenantId?: number;
  contractId?: number;
}

const BS_TYPES = new Set<AcctType>(["asset", "liability", "equity"]);
const PL_TYPES = new Set<AcctType>(["revenue", "expense"]);
const DIM_COLS: Array<[keyof DimFilter, string]> = [
  ["ownerId", "owner_id"], ["propertyId", "property_id"], ["unitId", "unit_id"], ["tenantId", "tenant_id"], ["contractId", "contract_id"],
];

/** Labels of the rows the reports compute rather than read from an account. */
export const SYNTHETIC_LABELS: Record<string, { nameAr: string; nameEn: string }> = {
  unclosed_prior_years: { nameAr: "أرباح مبقاة – سنوات سابقة غير مُقفلة", nameEn: "Retained earnings – unclosed prior years" },
  unallocated: { nameAr: "بنود غير مخصّصة (قيود جزء منها خارج التصفية)", nameEn: "Unallocated lines (entries partly outside the filter)" },
  current_year_profit: { nameAr: "صافي ربح السنة الحالية", nameEn: "Current year profit" },
  tenant_credits: { nameAr: "دفعات مقدمة وأرصدة دائنة للمستأجرين", nameEn: "Tenant advances and credit balances" },
  landlord_debits: { nameAr: "مستحق من الملاك (أرصدة مدينة)", nameEn: "Due from landlords (debit balances)" },
  agency_difference: { nameAr: "فرق أرصدة الوكالة (ذمم مُدارة ناقص حصة الملاك)", nameEn: "Agency balance difference (managed receivables less landlord share)" },
};

const bad = (error: string, message: string) => new BadRequestException({ error, message });

function nameOf(lang: Lang, r: { nameAr: string; nameEn: string }) {
  return lang === "en" ? r.nameEn : r.nameAr;
}

function h(v: unknown): number {
  return v == null ? 0 : toHalalas(String(v));
}

function optId(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw bad("BAD_ID", `${name} must be an id`);
  return n;
}

function langOf(v: unknown): Lang {
  return v === "en" ? "en" : "ar";
}

function boolOf(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

@Injectable()
export class CoreReportsService {
  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool) {}

  // ───────────────────────────── shared ─────────────────────────────

  private async accounts(scope: number): Promise<Acct[]> {
    const r = await this.pool.query(
      `select id, code, name_ar as "nameAr", name_en as "nameEn", type, normal_balance as "normalBalance", parent_id as "parentId",
              is_group as "isGroup", is_active as "isActive", system_key as "systemKey", bank_account_id as "bankAccountId"
         from accounts where user_id = $1 order by code`, [scope]);
    return r.rows;
  }

  private async startMonth(scope: number): Promise<number> {
    const r = await this.pool.query(`select fiscal_year_start_month as m from finance_settings where account_user_id = $1`, [scope]);
    return Number(r.rows[0]?.m ?? 1);
  }

  private async mode(scope: number): Promise<string | null> {
    const r = await this.pool.query(`select accounting_mode as m from finance_settings where account_user_id = $1`, [scope]);
    return r.rows[0]?.m ?? null;
  }

  /** Parse and scope-check the dimension filters named in `keys`. A foreign or unknown id is a 404. */
  async filterOf(scope: number, q: Record<string, any>, keys: Array<keyof DimFilter>): Promise<DimFilter> {
    const f: DimFilter = {};
    for (const k of keys) {
      const id = optId(q[k], k);
      if (id === undefined) continue;
      const sql = {
        ownerId: `select 1 from owners where id = $1 and user_id = $2`,
        propertyId: `select 1 from properties where id = $1 and user_id = $2`,
        tenantId: `select 1 from tenants where id = $1 and user_id = $2`,
        contractId: `select 1 from contracts where id = $1 and user_id = $2`,
        unitId: `select 1 from units u join properties p on p.id = u.property_id where u.id = $1 and p.user_id = $2`,
      }[k];
      const r = await this.pool.query(sql, [id, scope]);
      if (!r.rowCount) throw new NotFoundException({ error: "DIMENSION_NOT_FOUND", message: `${k} not found` });
      f[k] = id;
    }
    return f;
  }

  private static hasFilter(f: DimFilter) {
    return DIM_COLS.some(([k]) => f[k] != null);
  }

  /** ` and l.owner_id = $n …` for the active filters, pushing their values onto `p`. */
  private static dimSql(f: DimFilter, p: unknown[], alias = "l"): string {
    let s = "";
    for (const [k, col] of DIM_COLS) {
      if (f[k] == null) continue;
      p.push(f[k]);
      s += ` and ${alias}.${col} = $${p.length}`;
    }
    return s;
  }

  private range(q: Record<string, any>, sm: number, defaultFrom: "fy" | "month" = "fy"): { from: string; to: string } {
    const to = q.to ? isoDate(q.to, "to") : riyadhToday();
    const from = q.from ? isoDate(q.from, "from") : defaultFrom === "fy" ? fyStartOf(to, sm) : `${to.slice(0, 8)}01`;
    if (from > to) throw bad("BAD_RANGE", "from must not be after to");
    return { from, to };
  }

  private static filterParams(f: DimFilter) {
    return Object.fromEntries(DIM_COLS.filter(([k]) => f[k] != null).map(([k]) => [k, f[k]]));
  }

  // ───────────────────────────── §7.1 trial balance ─────────────────────────────

  /**
   * One range of the TB: per account the opening (balance-sheet accounts: every
   * line before `from`; P&L accounts: lines from the fiscal-year start), and the
   * period debits and credits. P&L lines before the fiscal year go to the
   * "unclosed prior years" row. Under a dimension filter, the part of an entry
   * outside the filter goes to the "unallocated" row, so the TB still balances.
   */
  private async tbRange(scope: number, accts: Map<number, Acct>, from: string, to: string, fy: string, f: DimFilter, postClosing: boolean) {
    const p: unknown[] = [scope, from, to, fy];
    const dims = CoreReportsService.dimSql(f, p);
    const inPeriod = postClosing ? "true" : "e.origin <> 'closing'";
    const r = await this.pool.query(
      `select l.account_id as id,
              coalesce(sum(l.debit - l.credit) filter (where l.entry_date < $4::date), 0)::text as pre_fy,
              coalesce(sum(l.debit - l.credit) filter (where l.entry_date >= $4::date and l.entry_date < $2::date), 0)::text as fy_open,
              coalesce(sum(l.debit)  filter (where l.entry_date >= $2::date and ${inPeriod}), 0)::text as pd,
              coalesce(sum(l.credit) filter (where l.entry_date >= $2::date and ${inPeriod}), 0)::text as pc
         from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
        where l.user_id = $1 and l.entry_date <= $3::date${dims}
        group by l.account_id`, p);
    const byAcct = new Map<number, { open: number; pd: number; pc: number }>();
    let unclosed = 0;
    for (const row of r.rows) {
      const a = accts.get(row.id);
      if (!a) continue;
      const pre = h(row.pre_fy);
      const fyOpen = h(row.fy_open);
      let open = fyOpen;
      if (BS_TYPES.has(a.type)) open += pre;
      else unclosed += pre;
      byAcct.set(row.id, { open, pd: h(row.pd), pc: h(row.pc) });
    }
    let unalloc = { open: 0, pd: 0, pc: 0 };
    if (CoreReportsService.hasFilter(f)) {
      const u = await this.pool.query(
        `select coalesce(sum(imb) filter (where d < $2::date), 0)::text as open,
                coalesce(sum(imb) filter (where d >= $2::date and imb > 0), 0)::text as pos,
                coalesce(sum(-imb) filter (where d >= $2::date and imb < 0), 0)::text as neg
           from (select l.entry_id, min(l.entry_date) as d, sum(l.debit - l.credit) as imb
                   from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
                  where l.user_id = $1 and l.entry_date <= $3::date and (l.entry_date < $2::date or ${inPeriod})${dims}
                    and $4::date is not null
                  group by l.entry_id) s`, p);
      const x = u.rows[0];
      unalloc = { open: -h(x.open), pd: h(x.neg), pc: h(x.pos) };
    }
    return { byAcct, unclosed, unalloc };
  }

  async trialBalance(scope: number, q: Record<string, any> = {}) {
    const lang = langOf(q.lang);
    const sm = await this.startMonth(scope);
    const { from, to } = this.range(q, sm);
    let cmp: { from: string; to: string } | null;
    if (q.compare === "none" || q.compare === "false") cmp = null;
    else if (q.cmpFrom || q.cmpTo) {
      if (!q.cmpFrom || !q.cmpTo) throw bad("BAD_RANGE", "cmpFrom and cmpTo go together");
      cmp = { from: isoDate(q.cmpFrom, "cmpFrom"), to: isoDate(q.cmpTo, "cmpTo") };
      if (cmp.from > cmp.to) throw bad("BAD_RANGE", "cmpFrom must not be after cmpTo");
    } else cmp = previousRange(from, to);
    const level = q.level === "group" ? "group" : "leaf";
    if (q.level && !["group", "leaf"].includes(q.level)) throw bad("BAD_LEVEL", "level must be leaf or group");
    const postClosing = boolOf(q.postClosing);
    const includeZero = boolOf(q.includeZero);
    const f = await this.filterOf(scope, q, ["ownerId", "propertyId"]);
    const list = await this.accounts(scope);
    const accts = new Map(list.map((a) => [a.id, a]));
    const fy = fyStartOf(from, sm);
    const cur = await this.tbRange(scope, accts, from, to, fy, f, postClosing);
    const cmpFy = cmp ? fyStartOf(cmp.from, sm) : null;
    const prev = cmp ? await this.tbRange(scope, accts, cmp.from, cmp.to, cmpFy!, f, postClosing) : null;

    // Vectors: [open, pd, pc, close, cmpOpen, cmpPd, cmpPc, cmpClose]
    const vec = new Map<number, number[]>();
    const put = (id: number, i: number, v: { open: number; pd: number; pc: number }) => {
      const cur0 = vec.get(id) ?? new Array(8).fill(0);
      cur0[i] = v.open; cur0[i + 1] = v.pd; cur0[i + 2] = v.pc; cur0[i + 3] = v.open + v.pd - v.pc;
      vec.set(id, cur0);
    };
    for (const [id, v] of cur.byAcct) put(id, 0, v);
    if (prev) for (const [id, v] of prev.byAcct) put(id, 4, v);
    const re = list.find((a) => a.systemKey === "retained_earnings");
    const UNCLOSED = -1;
    const UNALLOC = -2;
    if (cur.unclosed || prev?.unclosed) {
      put(UNCLOSED, 0, { open: cur.unclosed, pd: 0, pc: 0 });
      if (prev) put(UNCLOSED, 4, { open: prev.unclosed, pd: 0, pc: 0 });
    }
    const ua = (x: { open: number; pd: number; pc: number }) => x.open || x.pd || x.pc;
    if (ua(cur.unalloc) || (prev && ua(prev.unalloc))) {
      put(UNALLOC, 0, cur.unalloc);
      if (prev) put(UNALLOC, 4, prev.unalloc);
    }
    const nodes: TreeNode[] = [...list.map((a) => ({ id: a.id, parentId: a.parentId })), { id: UNCLOSED, parentId: re?.parentId ?? null }, { id: UNALLOC, parentId: null }];
    const depth = depths(nodes);
    // A row whose every figure is zero (e.g. only pre-year P&L lines, or only an excluded closing entry) is not shown.
    for (const [id, v] of vec) if (v.every((x) => x === 0)) vec.delete(id);
    let shown: Map<number, number[]>;
    if (level === "group") {
      shown = rollUp(nodes, vec, 8);
      if (includeZero) for (const a of list) if (!shown.has(a.id)) shown.set(a.id, new Array(8).fill(0));
    } else {
      shown = new Map(vec);
      if (includeZero) for (const a of list) if (!a.isGroup && !shown.has(a.id)) shown.set(a.id, new Array(8).fill(0));
    }
    const sortKey = (id: number) => (id === UNCLOSED ? `${re?.code ?? "3300"}~` : id === UNALLOC ? "~~" : accts.get(id)!.code);
    const ids = [...shown.keys()].filter((id) => id < 0 || accts.has(id)).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    const six = (v: number[], i: number) => {
      const o = sides(v[i]);
      const c = sides(v[i + 3]);
      return {
        openingDebit: o.debit, openingCredit: o.credit, periodDebit: fromHalalas(v[i + 1]), periodCredit: fromHalalas(v[i + 2]),
        closingDebit: c.debit, closingCredit: c.credit,
      };
    };
    const rows = ids.map((id) => {
      const v = shown.get(id)!;
      const a = accts.get(id);
      const kind = id === UNCLOSED ? "unclosed_prior_years" : id === UNALLOC ? "unallocated" : "account";
      const label = a ?? SYNTHETIC_LABELS[kind];
      return {
        kind,
        accountId: a?.id ?? null,
        code: a?.code ?? null,
        nameAr: label.nameAr,
        nameEn: label.nameEn,
        name: nameOf(lang, label),
        type: a?.type ?? (kind === "unclosed_prior_years" ? "equity" : null),
        normalBalance: a?.normalBalance ?? null,
        parentId: id === UNCLOSED ? re?.parentId ?? null : a?.parentId ?? null,
        isGroup: a?.isGroup ?? false,
        depth: depth.get(id) ?? 0,
        ...six(v, 0),
        cmp: prev ? six(v, 4) : null,
        drill: a && !a.isGroup ? { accountId: a.id, from, to, ...CoreReportsService.filterParams(f) } : null,
      };
    });
    // Totals over the rows that carry postings (leaves and synthetic rows), never groups.
    const tot = (i: number) => {
      let od = 0, oc = 0, pd = 0, pc = 0, cd = 0, cc = 0;
      for (const [id, v] of vec) {
        if (id > 0 && !accts.has(id)) continue;
        if (v[i] >= 0) od += v[i]; else oc -= v[i];
        pd += v[i + 1]; pc += v[i + 2];
        if (v[i + 3] >= 0) cd += v[i + 3]; else cc -= v[i + 3];
      }
      return {
        openingDebit: fromHalalas(od), openingCredit: fromHalalas(oc), periodDebit: fromHalalas(pd), periodCredit: fromHalalas(pc),
        closingDebit: fromHalalas(cd), closingCredit: fromHalalas(cc),
        balanced: od === oc && pd === pc && cd === cc,
        openingDifference: fromHalalas(od - oc), periodDifference: fromHalalas(pd - pc), closingDifference: fromHalalas(cd - cc),
      };
    };
    return {
      report: "trial-balance",
      lang,
      mode: await this.mode(scope),
      generatedAt: riyadhNow(),
      params: { from, to, fyStart: fy, cmpFrom: cmp?.from ?? null, cmpTo: cmp?.to ?? null, cmpFyStart: cmpFy, level, postClosing, includeZero, ...CoreReportsService.filterParams(f) },
      rows,
      totals: tot(0),
      cmpTotals: prev ? tot(4) : null,
    };
  }

  // ───────────────────────────── §7.2 general ledger ─────────────────────────────

  /**
   * One account's ledger for [from, to]: the opening row (the TB opening rule),
   * each line with its running balance (a window over every line of the range,
   * so it is right on every page), the period totals and the closing balance.
   * Balances are signed in the account's normal direction.
   */
  private async ledgerSection(scope: number, a: Acct, from: string, to: string, fy: string, f: DimFilter, limit: number, offset: number, lang: Lang) {
    const p: unknown[] = [scope, a.id, from, to];
    const dims = CoreReportsService.dimSql(f, p);
    const po: unknown[] = [scope, a.id, from, fy];
    const dimsO = CoreReportsService.dimSql(f, po);
    const op = await this.pool.query(
      `select coalesce(sum(l.debit - l.credit), 0)::text as net from journal_lines l
        where l.user_id = $1 and l.account_id = $2 and l.entry_date < $3::date
          and (${BS_TYPES.has(a.type) ? "true" : "false"} or l.entry_date >= $4::date)${dimsO}`, po);
    const tt = await this.pool.query(
      `select coalesce(sum(l.debit), 0)::text as dr, coalesce(sum(l.credit), 0)::text as cr, count(*)::int as n from journal_lines l
        where l.user_id = $1 and l.account_id = $2 and l.entry_date between $3::date and $4::date${dims}`, p);
    const rows = await this.pool.query(
      `select * from (
         select l.entry_id::int as "entryId", l.line_no as "lineNo", to_char(l.entry_date, 'YYYY-MM-DD') as "entryDate",
                to_char(e.original_date, 'YYYY-MM-DD') as "originalDate", e.is_late as "isLate", e.entry_no as "entryNo",
                e.origin, e.status, e.source_type as "sourceType", e.source_id::int as "sourceId", e.event,
                e.memo as "entryMemo", l.memo, l.debit::text as debit, l.credit::text as credit,
                l.owner_id as "ownerId", l.property_id as "propertyId", l.unit_id as "unitId", l.tenant_id as "tenantId",
                l.contract_id as "contractId", l.payment_id as "paymentId", l.document_id as "documentId", l.bank_account_id as "bankAccountId",
                e.payload->>'tenantName' as "snapTenant", e.payload->>'ownerName' as "snapOwner",
                sum(l.debit - l.credit) over (order by l.entry_date, l.entry_id, l.line_no rows between unbounded preceding and current row)::text as run
           from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
          where l.user_id = $1 and l.account_id = $2 and l.entry_date between $3::date and $4::date${dims}
       ) x order by "entryDate", "entryId", "lineNo" limit ${limit} offset ${offset}`, p);
    const open = h(op.rows[0].net);
    const dr = h(tt.rows[0].dr);
    const cr = h(tt.rows[0].cr);
    const sign = a.normalBalance === "debit" ? 1 : -1;
    const deco = await this.decorate(scope, rows.rows);
    return {
      account: { id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, name: nameOf(lang, a), type: a.type, normalBalance: a.normalBalance, bankAccountId: a.bankAccountId },
      opening: fromHalalas(sign * open),
      periodDebit: fromHalalas(dr),
      periodCredit: fromHalalas(cr),
      closing: fromHalalas(sign * (open + dr - cr)),
      totalLines: tt.rows[0].n as number,
      lines: rows.rows.map((r: any, i: number) => {
        const { run, snapTenant, snapOwner, ...rest } = r;
        return { ...rest, balance: fromHalalas(sign * (open + h(run))), counterparty: deco.counterparty(r), source: deco.source[i], method: deco.method[i] };
      }),
    };
  }

  /** Batch-resolve counterparty names and source links (§7.2 drill-down) for a page of lines. */
  private async decorate(scope: number, rows: any[]) {
    const idsOf = (pred: (r: any) => boolean, pick: (r: any) => number | null) =>
      [...new Set(rows.filter(pred).map(pick).filter((x): x is number => x != null))];
    const fetch = async (ids: number[], sql: string) => (ids.length ? (await this.pool.query(sql, [scope, ids])).rows : []);
    const tenants = new Map((await fetch(idsOf(() => true, (r) => r.tenantId), `select id, name from tenants where user_id = $1 and id = any($2::int[])`)).map((r: any) => [r.id, r.name]));
    const owners = new Map((await fetch(idsOf((r) => r.tenantId == null, (r) => r.ownerId), `select id, name from owners where user_id = $1 and id = any($2::int[])`)).map((r: any) => [r.id, r.name]));
    const src = (t: string) => idsOf((r) => r.sourceType === t, (r) => r.sourceId);
    const docs = new Map((await fetch(src("simple_invoice"), `select id, number, kind from simple_invoices where user_id = $1 and id = any($2::int[])`)).map((r: any) => [r.id, r]));
    const cols = new Map((await fetch(src("payment_collection"),
      `select pc.id, pc.receipt_number, pc.method, p.contract_id from payment_collections pc left join payments p on p.id = pc.payment_id
        where pc.user_id = $1 and pc.id = any($2::int[])`)).map((r: any) => [r.id, r]));
    const pays = new Map((await fetch(src("payment"), `select id, contract_id from payments where user_id = $1 and id = any($2::int[])`)).map((r: any) => [r.id, r]));
    const cons = new Map((await fetch(src("contract"), `select id, contract_number from contracts where user_id = $1 and id = any($2::int[])`)).map((r: any) => [r.id, r]));
    const exps = new Set((await fetch(src("expense"), `select id from expenses where user_id = $1 and id = any($2::int[])`)).map((r: any) => r.id));
    const pos = new Set((await fetch(src("landlord_payout"), `select id from landlord_payouts where user_id = $1 and id = any($2::int[])`)).map((r: any) => r.id));
    const bills = new Map((await fetch(src("supplier_bill"), `select id, number from supplier_bills where user_id = $1 and id = any($2::int[])`)).map((r: any) => [r.id, r]));
    const spays = new Map((await fetch(src("supplier_payment"), `select id, number from supplier_payments where user_id = $1 and id = any($2::int[])`)).map((r: any) => [r.id, r]));
    const source = rows.map((r) => {
      const type = r.sourceType as string;
      const id = r.sourceId as number;
      const miss = { type, id, number: null, route: null, exists: false };
      switch (type) {
        case "simple_invoice": {
          const d = docs.get(id);
          return d ? { type, id, number: d.number, route: `/dashboard/invoices?id=${id}`, exists: true } : miss;
        }
        case "payment_collection": {
          const c = cols.get(id);
          return c ? { type, id, number: c.receipt_number ?? null, route: c.contract_id ? `/dashboard/contracts?id=${c.contract_id}` : null, exists: true } : miss;
        }
        case "payment": {
          const x = pays.get(id);
          return x ? { type, id, number: null, route: `/dashboard/contracts?id=${x.contract_id}`, exists: true } : miss;
        }
        case "contract": {
          const x = cons.get(id);
          return x ? { type, id, number: x.contract_number, route: `/dashboard/contracts?id=${id}`, exists: true } : miss;
        }
        case "expense":
          return exps.has(id) ? { type, id, number: null, route: `/dashboard/reports/expenses?id=${id}`, exists: true } : miss;
        case "landlord_payout":
          return pos.has(id) ? { type, id, number: null, route: `/dashboard/reports/payouts?id=${id}`, exists: true } : miss;
        case "supplier_bill": {
          const x = bills.get(id);
          return x ? { type, id, number: x.number, route: `/dashboard/accounting/bills?id=${id}`, exists: true } : miss;
        }
        case "supplier_payment": {
          const x = spays.get(id);
          return x ? { type, id, number: x.number, route: `/dashboard/accounting/supplier-payments?id=${id}`, exists: true } : miss;
        }
        case "manual_journal":
        case "opening_balance":
          return { type, id, number: null, route: `/dashboard/accounting/manual-journals/${id}`, exists: true };
        default:
          return { type, id, number: null, route: null, exists: true };
      }
    });
    const method = rows.map((r) => (r.sourceType === "payment_collection" ? cols.get(r.sourceId)?.method ?? null : null));
    const counterparty = (r: any) => {
      if (r.tenantId != null) return { type: "tenant", id: r.tenantId, name: tenants.get(r.tenantId) ?? r.snapTenant ?? null };
      if (r.ownerId != null) return { type: "landlord", id: r.ownerId, name: owners.get(r.ownerId) ?? r.snapOwner ?? null };
      return null;
    };
    return { source, method, counterparty };
  }

  async generalLedger(scope: number, q: Record<string, any> = {}) {
    const lang = langOf(q.lang);
    const sm = await this.startMonth(scope);
    const { from, to } = this.range(q, sm);
    const fy = fyStartOf(from, sm);
    const raw = [q.accountId, ...(q.accountIds ? String(q.accountIds).split(",") : [])].filter((x) => x !== undefined && x !== "");
    if (!raw.length) throw bad("ACCOUNT_REQUIRED", "accountId or accountIds is required");
    const list = await this.accounts(scope);
    const accts = new Map(list.map((a) => [a.id, a]));
    const leaves: Acct[] = [];
    const seen = new Set<number>();
    const addLeaves = (a: Acct) => {
      if (!a.isGroup) {
        if (!seen.has(a.id)) { seen.add(a.id); leaves.push(a); }
        return;
      }
      for (const c of list.filter((x) => x.parentId === a.id)) addLeaves(c);
    };
    for (const v of raw) {
      const id = optId(v, "accountId")!;
      const a = accts.get(id);
      if (!a) throw new NotFoundException({ error: "ACCOUNT_NOT_FOUND", message: "Account not found" });
      addLeaves(a);
    }
    if (leaves.length > 60) throw bad("TOO_MANY_ACCOUNTS", "At most 60 accounts per ledger request");
    leaves.sort((a, b) => (a.code < b.code ? -1 : 1));
    const pageSize = Math.min(Math.max(Number(q.pageSize) || 500, 1), 2000);
    const page = Math.max(Number(q.page) || 1, 1);
    const f = await this.filterOf(scope, q, ["ownerId", "propertyId", "unitId", "tenantId", "contractId"]);
    const sections = [];
    for (const a of leaves) {
      const s = await this.ledgerSection(scope, a, from, to, fy, f, pageSize, (page - 1) * pageSize, lang);
      sections.push({ ...s, lines: s.lines.map(({ method: _m, ...l }: any) => l), page, pageSize, pages: Math.max(1, Math.ceil(s.totalLines / pageSize)) });
    }
    return {
      report: "general-ledger",
      lang,
      mode: await this.mode(scope),
      generatedAt: riyadhNow(),
      params: { from, to, fyStart: fy, page, pageSize, ...CoreReportsService.filterParams(f) },
      accounts: sections,
    };
  }

  // ───────────────────────────── §7.3 income statement ─────────────────────────────

  async incomeStatement(scope: number, q: Record<string, any> = {}) {
    const lang = langOf(q.lang);
    const sm = await this.startMonth(scope);
    const { from, to } = this.range(q, sm);
    const columns = (q.columns ?? "total") as string;
    if (!["total", "property", "landlord", "month"].includes(columns)) throw bad("BAD_COLUMNS", "columns must be total, property, landlord or month");
    if (columns === "month" && monthsIn(from, to).length > 36) throw bad("BAD_RANGE", "At most 36 month columns");
    let cmp: { from: string; to: string } | null = null;
    if (q.cmpFrom || q.cmpTo) {
      if (!q.cmpFrom || !q.cmpTo) throw bad("BAD_RANGE", "cmpFrom and cmpTo go together");
      cmp = { from: isoDate(q.cmpFrom, "cmpFrom"), to: isoDate(q.cmpTo, "cmpTo") };
      if (cmp.from > cmp.to) throw bad("BAD_RANGE", "cmpFrom must not be after cmpTo");
    } else if (q.compare === "previous") cmp = previousRange(from, to);
    const f = await this.filterOf(scope, q, ["ownerId", "propertyId"]);
    const list = await this.accounts(scope);
    const accts = new Map(list.map((a) => [a.id, a]));

    const colExpr = { total: `'total'`, property: `coalesce(l.property_id::text, 'unallocated')`, landlord: `coalesce(l.owner_id::text, 'unallocated')`, month: `to_char(l.entry_date, 'YYYY-MM')` }[columns as "total"];
    const pl = async (r: { from: string; to: string }, byCol: boolean) => {
      const p: unknown[] = [scope, r.from, r.to];
      const dims = CoreReportsService.dimSql(f, p);
      const res = await this.pool.query(
        `select l.account_id as id, ${byCol ? colExpr : `'total'`} as col, sum(l.credit - l.debit)::text as net
           from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
           join accounts a on a.id = l.account_id and a.user_id = l.user_id
          where l.user_id = $1 and a.type in ('revenue', 'expense') and e.origin <> 'closing'
            and l.entry_date between $2::date and $3::date${dims}
          group by 1, 2`, p);
      return res.rows.map((x: any) => ({ id: x.id as number, col: String(x.col), amt: accts.get(x.id)?.type === "revenue" ? h(x.net) : -h(x.net) }));
    };
    const curRows = await pl({ from, to }, true);
    const cmpRows = cmp ? await pl(cmp, false) : [];

    // Column definitions, with labels.
    let colKeys: string[];
    if (columns === "total") colKeys = ["total"];
    else if (columns === "month") colKeys = monthsIn(from, to);
    else {
      const ks = [...new Set(curRows.map((r) => r.col))];
      colKeys = ks.filter((k) => k !== "unallocated").sort((a, b) => Number(a) - Number(b));
      if (ks.includes("unallocated")) colKeys.push("unallocated");
    }
    const names = new Map<string, string>();
    if (columns === "property" || columns === "landlord") {
      const ids = colKeys.filter((k) => k !== "unallocated").map(Number);
      if (ids.length) {
        const r = await this.pool.query(`select id, name from ${columns === "property" ? "properties" : "owners"} where user_id = $1 and id = any($2::int[])`, [scope, ids]);
        for (const x of r.rows) names.set(String(x.id), x.name);
      }
    }
    const colDefs = colKeys.map((k) => ({
      key: k,
      id: columns === "property" || columns === "landlord" ? (k === "unallocated" ? null : Number(k)) : null,
      label: k === "unallocated" ? (lang === "en" ? "Unallocated" : "غير مخصّص") : columns === "total" ? (lang === "en" ? "Total" : "الإجمالي") : names.get(k) ?? k,
    }));
    const W = colKeys.length + 2; // columns…, total, cmp
    const idx = new Map(colKeys.map((k, i) => [k, i]));
    const vec = new Map<number, number[]>();
    const at = (id: number) => vec.get(id) ?? (vec.set(id, new Array(W).fill(0)), vec.get(id)!);
    for (const r of curRows) {
      const v = at(r.id);
      const i = idx.get(r.col);
      if (i !== undefined) v[i] += r.amt;
      v[W - 2] += r.amt;
    }
    for (const r of cmpRows) at(r.id)[W - 1] += r.amt;
    const nodes: TreeNode[] = list.map((a) => ({ id: a.id, parentId: a.parentId }));
    const rolled = rollUp(nodes, vec, W);
    const depth = depths(nodes);
    const pack = (v: number[]) => ({
      amounts: Object.fromEntries(colKeys.map((k, i) => [k, fromHalalas(v[i])])),
      total: fromHalalas(v[W - 2]),
      cmpTotal: cmp ? fromHalalas(v[W - 1]) : null,
    });
    const section = (type: AcctType) => {
      const rows = list.filter((a) => a.type === type && rolled.has(a.id)).map((a) => ({
        accountId: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, name: nameOf(lang, a), parentId: a.parentId,
        isGroup: a.isGroup, depth: depth.get(a.id) ?? 0, ...pack(rolled.get(a.id)!),
        drill: a.isGroup ? null : { accountId: a.id, from, to, ...CoreReportsService.filterParams(f) },
      }));
      const sum = new Array(W).fill(0);
      for (const [id, v] of vec) if (accts.get(id)?.type === type) for (let i = 0; i < W; i++) sum[i] += v[i];
      return { rows, total: pack(sum), sum };
    };
    const revenue = section("revenue");
    const expenses = section("expense");
    const net = revenue.sum.map((x, i) => x - expenses.sum[i]);

    // Manager mode: agent rent sits on 2121, never in the P&L; shown as a memo (§7.3).
    const lp = list.find((a) => a.systemKey === "landlord_payable");
    let rentForLandlords = 0;
    if (lp) {
      const p: unknown[] = [scope, lp.id, from, to];
      const dims = CoreReportsService.dimSql(f, p);
      const r = await this.pool.query(
        `select coalesce(sum(l.credit), 0)::text as v from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
          where l.user_id = $1 and l.account_id = $2 and l.entry_date between $3::date and $4::date
            and e.source_type = 'payment_collection' and e.event = 'collected'${dims}`, p);
      rentForLandlords = h(r.rows[0].v);
    }
    const { sum: _r, ...rev } = revenue;
    const { sum: _e, ...exp } = expenses;
    return {
      report: "income-statement",
      lang,
      mode: await this.mode(scope),
      generatedAt: riyadhNow(),
      params: { from, to, columns, cmpFrom: cmp?.from ?? null, cmpTo: cmp?.to ?? null, ...CoreReportsService.filterParams(f) },
      columns: colDefs,
      revenue: rev,
      expenses: exp,
      netProfit: pack(net),
      memo: { rentCollectedForLandlords: fromHalalas(rentForLandlords) },
    };
  }

  // ───────────────────────────── §7.4 balance sheet ─────────────────────────────

  /**
   * Row values (debit − credit, halalas) at `asOf`, keyed `a:<id>` for accounts
   * and by kind for the computed rows, after the §7.4 reclassifications.
   */
  private async bsAt(scope: number, list: Acct[], asOf: string, sm: number, f: DimFilter, presentation: "net" | "gross") {
    const fy = fyStartOf(asOf, sm);
    const accts = new Map(list.map((a) => [a.id, a]));
    const p: unknown[] = [scope, asOf, fy];
    const dims = CoreReportsService.dimSql(f, p);
    const r = await this.pool.query(
      `select l.account_id as id, sum(l.debit - l.credit)::text as bal,
              coalesce(sum(l.debit - l.credit) filter (where l.entry_date < $3::date), 0)::text as pre_fy
         from journal_lines l where l.user_id = $1 and l.entry_date <= $2::date${dims} group by l.account_id`, p);
    const out = new Map<string, number>();
    const add = (k: string, v: number) => { if (v) out.set(k, (out.get(k) ?? 0) + v); };
    let cy = 0;
    let unclosed = 0;
    for (const row of r.rows) {
      const a = accts.get(row.id);
      if (!a) continue;
      const bal = h(row.bal);
      if (BS_TYPES.has(a.type)) add(`a:${a.id}`, bal);
      else if (PL_TYPES.has(a.type)) {
        // Current-year profit includes the year's own closing entry (if posted), which moves it into 3300.
        const pre = h(row.pre_fy);
        unclosed += pre;
        cy += bal - pre;
      }
    }
    add("current_year_profit", cy);
    add("unclosed_prior_years", unclosed);
    if (CoreReportsService.hasFilter(f)) {
      const u = await this.pool.query(
        `select coalesce(sum(imb), 0)::text as v from (
           select l.entry_id, sum(l.debit - l.credit) as imb from journal_lines l
            where l.user_id = $1 and l.entry_date <= $2::date and $3::date is not null${dims} group by l.entry_id) s`, p);
      add("unallocated", -h(u.rows[0].v));
    }

    const byKey = (k: string) => list.find((a) => a.systemKey === k);
    const ar = byKey("tenant_receivable");
    const arAg = byKey("tenant_receivable_agency");
    const lpu = byKey("landlord_payable_uncollected");
    const lp = byKey("landlord_payable");
    const perTenantCredits = async (acct: Acct) => {
      const q2: unknown[] = [scope, asOf, acct.id];
      const d2 = CoreReportsService.dimSql(f, q2);
      const t = await this.pool.query(
        `select coalesce(sum(-bal), 0)::text as v from (
           select l.tenant_id, sum(l.debit - l.credit) as bal from journal_lines l
            where l.user_id = $1 and l.entry_date <= $2::date and l.account_id = $3${d2} group by l.tenant_id) s where bal < 0`, q2);
      return h(t.rows[0].v);
    };
    // 1. Agency balances (net): 1122 and 2122 offset; any difference is shown, not hidden.
    let memo: { managedReceivables: string; heldForLandlords: string; agentTenantCredits: string } | null = null;
    const arAgCredits = arAg ? await perTenantCredits(arAg) : 0;
    if (presentation === "net") {
      const m = arAg ? out.get(`a:${arAg.id}`) ?? 0 : 0;
      const u = lpu ? out.get(`a:${lpu.id}`) ?? 0 : 0;
      if (arAg) out.delete(`a:${arAg.id}`);
      if (lpu) out.delete(`a:${lpu.id}`);
      add("agency_difference", m + u);
      memo = { managedReceivables: fromHalalas(m), heldForLandlords: fromHalalas(-u), agentTenantCredits: fromHalalas(arAgCredits) };
    }
    // 2. Tenant credit balances out of receivables.
    for (const acct of [ar, presentation === "gross" ? arAg : undefined]) {
      if (!acct) continue;
      const c = acct === arAg ? arAgCredits : await perTenantCredits(acct);
      if (!c) continue;
      add(`a:${acct.id}`, c);
      add("tenant_credits", -c);
    }
    // 3. Landlord debit balances on 2121 to "Due from landlords".
    if (lp) {
      const q3: unknown[] = [scope, asOf, lp.id];
      const d3 = CoreReportsService.dimSql(f, q3);
      const t = await this.pool.query(
        `select coalesce(sum(bal), 0)::text as v from (
           select l.owner_id, sum(l.debit - l.credit) as bal from journal_lines l
            where l.user_id = $1 and l.entry_date <= $2::date and l.account_id = $3${d3} group by l.owner_id) s where bal > 0`, q3);
      const d = h(t.rows[0].v);
      if (d) {
        add(`a:${lp.id}`, -d);
        add("landlord_debits", d);
      }
    }
    for (const [k, v] of out) if (!v) out.delete(k);
    return { values: out, fyStart: fy, memo };
  }

  async balanceSheet(scope: number, q: Record<string, any> = {}) {
    const lang = langOf(q.lang);
    const sm = await this.startMonth(scope);
    const asOf = q.asOf ? isoDate(q.asOf, "asOf") : riyadhToday();
    const cmpAsOf = q.cmpAsOf ? isoDate(q.cmpAsOf, "cmpAsOf") : null;
    const presentation = (q.presentation ?? "net") as "net" | "gross";
    if (!["net", "gross"].includes(presentation)) throw bad("BAD_PRESENTATION", "presentation must be net or gross");
    const includeZero = boolOf(q.includeZero);
    const f = await this.filterOf(scope, q, ["ownerId", "propertyId"]);
    const list = await this.accounts(scope);
    const accts = new Map(list.map((a) => [a.id, a]));
    const cur = await this.bsAt(scope, list, asOf, sm, f, presentation);
    const prev = cmpAsOf ? await this.bsAt(scope, list, cmpAsOf, sm, f, presentation) : null;

    const byCode = (c: string) => list.find((a) => a.code === c);
    const parentOfKey = (k: string) => list.find((a) => a.systemKey === k)?.parentId ?? null;
    const SYN: Record<string, { id: number; parentId: number | null; type: AcctType }> = {
      tenant_credits: { id: -1, parentId: byCode("2100")?.id ?? null, type: "liability" },
      landlord_debits: { id: -2, parentId: parentOfKey("landlord_receivable") ?? byCode("1100")?.id ?? null, type: "asset" },
      agency_difference: { id: -3, parentId: parentOfKey("tenant_receivable_agency") ?? byCode("1100")?.id ?? null, type: "asset" },
      current_year_profit: { id: -4, parentId: parentOfKey("retained_earnings"), type: "equity" },
      unclosed_prior_years: { id: -5, parentId: parentOfKey("retained_earnings"), type: "equity" },
      unallocated: { id: -6, parentId: parentOfKey("retained_earnings"), type: "equity" },
    };
    const kindOfId = new Map(Object.entries(SYN).map(([k, s]) => [s.id, k]));
    const idOf = (key: string) => (key.startsWith("a:") ? Number(key.slice(2)) : SYN[key].id);
    const vec = new Map<number, number[]>();
    for (const [k, v] of cur.values) (vec.get(idOf(k)) ?? (vec.set(idOf(k), [0, 0]), vec.get(idOf(k))!))[0] += v;
    if (prev) for (const [k, v] of prev.values) (vec.get(idOf(k)) ?? (vec.set(idOf(k), [0, 0]), vec.get(idOf(k))!))[1] += v;
    const nodes: TreeNode[] = [...list.map((a) => ({ id: a.id, parentId: a.parentId })), ...Object.values(SYN).map((s) => ({ id: s.id, parentId: s.parentId }))];
    const rolled = rollUp(nodes, vec, 2);
    if (includeZero) for (const a of list) if (BS_TYPES.has(a.type) && !rolled.has(a.id)) rolled.set(a.id, [0, 0]);
    const depth = depths(nodes);
    const typeOf = (id: number): AcctType | undefined => (id > 0 ? accts.get(id)?.type : SYN[kindOfId.get(id)!]?.type);
    const sortKey = (id: number) => {
      if (id > 0) return accts.get(id)!.code;
      const s = SYN[kindOfId.get(id)!];
      const pc = s.parentId != null ? accts.get(s.parentId)?.code ?? "" : "";
      return `${pc}~${String(-id)}`;
    };
    const sign = (t: AcctType) => (t === "asset" ? 1 : -1);
    const section = (t: AcctType) => {
      const ids = [...rolled.keys()].filter((id) => typeOf(id) === t).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
      const rows = ids.map((id) => {
        const a = accts.get(id);
        const kind = id > 0 ? "account" : kindOfId.get(id)!;
        const label = a ?? SYNTHETIC_LABELS[kind];
        const v = rolled.get(id)!;
        return {
          kind, accountId: a?.id ?? null, code: a?.code ?? null, nameAr: label.nameAr, nameEn: label.nameEn, name: nameOf(lang, label),
          parentId: a ? a.parentId : SYN[kind].parentId, isGroup: a?.isGroup ?? false, depth: depth.get(id) ?? 0,
          amount: fromHalalas(sign(t) * v[0]), cmpAmount: prev ? fromHalalas(sign(t) * v[1]) : null,
          drill: a && !a.isGroup ? { accountId: a.id, to: asOf, ...CoreReportsService.filterParams(f) } : null,
        };
      });
      const sum = [0, 0];
      for (const [id, v] of vec) if (typeOf(id) === t) { sum[0] += v[0]; sum[1] += v[1]; }
      return { rows, total: fromHalalas(sign(t) * sum[0]), cmpTotal: prev ? fromHalalas(sign(t) * sum[1]) : null, s: sum.map((x) => sign(t) * x) };
    };
    const A = section("asset");
    const L = section("liability");
    const E = section("equity");
    const diff = (i: number) => A.s[i] - (L.s[i] + E.s[i]);
    const strip = ({ s: _s, ...x }: any) => x;
    return {
      report: "balance-sheet",
      lang,
      mode: await this.mode(scope),
      generatedAt: riyadhNow(),
      params: { asOf, cmpAsOf, fyStart: cur.fyStart, presentation, includeZero, ...CoreReportsService.filterParams(f) },
      assets: strip(A),
      liabilities: strip(L),
      equity: strip(E),
      totalLiabilitiesAndEquity: fromHalalas(L.s[0] + E.s[0]),
      cmpTotalLiabilitiesAndEquity: prev ? fromHalalas(L.s[1] + E.s[1]) : null,
      check: { difference: fromHalalas(diff(0)), balanced: diff(0) === 0, cmpDifference: prev ? fromHalalas(diff(1)) : null },
      memo: cur.memo ? { ...cur.memo, cmp: prev?.memo ?? null } : null,
    };
  }

  // ───────────────────────────── §7.9 cash and bank book ─────────────────────────────

  async cashBook(scope: number, q: Record<string, any> = {}) {
    const lang = langOf(q.lang);
    const sm = await this.startMonth(scope);
    const { from, to } = this.range(q, sm, "month");
    const list = await this.accounts(scope);
    const accts = new Map(list.map((a) => [a.id, a]));
    const bankId = optId(q.bankAccountId, "bankAccountId");
    const banks = (await this.pool.query(
      `select id, kind, name_ar as "nameAr", name_en as "nameEn", bank_name as "bankName", iban, is_trust as "isTrust",
              is_default as "isDefault", is_active as "isActive", gl_account_id as "glAccountId"
         from bank_accounts where user_id = $1 ${bankId ? "and id = $2" : ""} order by kind desc, id`, bankId ? [scope, bankId] : [scope])).rows;
    if (bankId && !banks.length) throw new NotFoundException({ error: "BANK_ACCOUNT_NOT_FOUND", message: "Bank account not found" });
    const targets: Array<{ bank: any | null; acct: Acct }> = banks.filter((b: any) => accts.has(b.glAccountId)).map((b: any) => ({ bank: b, acct: accts.get(b.glAccountId)! }));
    if (!bankId) {
      // Cash and bank leaves under the 1110 group that no bank_accounts row points at, when they carry postings.
      const grp = list.find((a) => a.code === "1110");
      const linked = new Set(banks.map((b: any) => b.glAccountId));
      const under = (a: Acct) => { let p = a.parentId; for (let i = 0; p != null && i < 32; i++) { if (p === grp?.id) return true; p = accts.get(p)?.parentId ?? null; } return false; };
      const cands = list.filter((a) => grp && !a.isGroup && !linked.has(a.id) && under(a));
      if (cands.length) {
        const used = await this.pool.query(`select distinct account_id from journal_lines where user_id = $1 and entry_date <= $2::date and account_id = any($3::int[])`,
          [scope, to, cands.map((a) => a.id)]);
        const u = new Set(used.rows.map((x: any) => x.account_id));
        for (const a of cands) if (u.has(a.id)) targets.push({ bank: null, acct: a });
      }
    }
    const fy = fyStartOf(from, sm);
    const LIMIT = 10_000;
    let gr = 0, gp = 0, go = 0, gc = 0;
    const sections = [];
    for (const t of targets) {
      const s = await this.ledgerSection(scope, t.acct, from, to, fy, {}, LIMIT, 0, lang);
      const byMethod = new Map<string, { receipts: number; payments: number }>();
      const lines = s.lines.map((l: any) => {
        const k = l.method ?? "other";
        const m = byMethod.get(k) ?? { receipts: 0, payments: 0 };
        m.receipts += h(l.debit);
        m.payments += h(l.credit);
        byMethod.set(k, m);
        const { debit, credit, ...rest } = l;
        return { ...rest, receipt: debit, payment: credit };
      });
      gr += h(s.periodDebit); gp += h(s.periodCredit); go += h(s.opening); gc += h(s.closing);
      sections.push({
        bankAccount: t.bank ? { ...t.bank, name: nameOf(lang, { nameAr: t.bank.nameAr, nameEn: t.bank.nameEn ?? t.bank.nameAr }) } : null,
        account: s.account,
        opening: s.opening,
        receipts: s.periodDebit,
        payments: s.periodCredit,
        closing: s.closing,
        lines,
        truncated: s.totalLines > LIMIT,
        byMethod: [...byMethod.entries()].sort(([a], [b]) => (a === "other" ? 1 : b === "other" ? -1 : a < b ? -1 : 1))
          .map(([method, v]) => ({ method, receipts: fromHalalas(v.receipts), payments: fromHalalas(v.payments) })),
      });
    }
    return {
      report: "cash-book",
      lang,
      mode: await this.mode(scope),
      generatedAt: riyadhNow(),
      params: { from, to, bankAccountId: bankId ?? null, days: daysBetween(from, to) + 1 },
      sections,
      totals: { opening: fromHalalas(go), receipts: fromHalalas(gr), payments: fromHalalas(gp), closing: fromHalalas(gc) },
    };
  }
}
