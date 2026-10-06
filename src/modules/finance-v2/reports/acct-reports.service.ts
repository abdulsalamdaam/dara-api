import { Inject, Injectable } from "@nestjs/common";
import { FV2_POOL, type Fv2Pool } from "../db";
import { fromHalalas } from "../money";
import { riyadhToday } from "../dates";
import { isoDate } from "../audit";
import { fyStartOf, riyadhNow } from "./core-math";
import { bad, h, langOf, scopedFilters, settingsOf, type Lang } from "./common";
import {
  arColumn, CASH_LINES, daysFrom, depositAmount, depositColumn, depositState, lineOfCounter, lineOfRule, pct,
  type CashActivity, type CashLine, type Counter, type DepositColumn,
} from "./acct-math";

/**
 * The accountant's reports (workbook sheets "التدفقات النقدية", "سجل الإيجارات",
 * "التأمينات", "ربحية العقارات"), all read from the v2 journal so that no
 * figure differs from the trial balance, the balance sheet or the income
 * statement:
 *
 *  - cash flow (direct method): movements of the cash and bank accounts
 *    (the 1110 group), classified by posting rule or counter-account, with the
 *    trust (client-money) accounts shown apart from the office's own cash;
 *  - rent roll: every unit as of a date with its lease and the receivable
 *    (1121 + 1122) movements of its contract;
 *  - deposits register: 2141 per contract, received / deducted / refunded;
 *  - property profitability: revenue, expenses and NOI per property, and for
 *    agent (managed) landlords the landlord's rent, the office's commission and
 *    the landlord's net, following the per-landlord Manager/Owner treatment.
 *
 * Read-only; every query is `where user_id = :scope`; every id in the query
 * string is loaded with the scope (a miss is 404). Amounts leave as
 * two-decimal strings; the web renders the Excel and PDF exports (§7.12).
 */

interface Acct { id: number; code: string; nameAr: string; nameEn: string; type: string; systemKey: string | null; parentId: number | null; isGroup: boolean }
type Filt = { ownerId?: number; propertyId?: number };

const RENT_KEYS = ["rent_revenue_residential", "rent_revenue_commercial", "service_charge_revenue", "other_tenant_revenue"];
const LANDLORD_RENT_RULES = ["E01", "E02", "E05", "E06", "E07", "E08"];
const RULE_SQL = `coalesce(e.payload->>'rule', r.payload->>'rule')`;
const JOIN_E = `join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
  left join journal_entries r on r.id = e.reversal_of and r.user_id = e.user_id`;

const nameOf = (lang: Lang, x: { nameAr: string; nameEn?: string | null }) => (lang === "en" ? x.nameEn || x.nameAr : x.nameAr);

/** Append the landlord / property filters on journal-line dimensions. */
function dimSql(f: Filt, p: unknown[], alias = "l"): string {
  let s = "";
  if (f.ownerId != null) { p.push(f.ownerId); s += ` and ${alias}.owner_id = $${p.length}`; }
  if (f.propertyId != null) { p.push(f.propertyId); s += ` and ${alias}.property_id = $${p.length}`; }
  return s;
}

interface Triple { amount: number; restricted: number; own: number }
const zero = (): Triple => ({ amount: 0, restricted: 0, own: 0 });
const add = (a: Triple, b: Partial<Triple>) => { a.amount += b.amount ?? 0; a.restricted += b.restricted ?? 0; a.own += b.own ?? 0; };
const str = (t: Triple) => ({ amount: fromHalalas(t.amount), restricted: fromHalalas(t.restricted), own: fromHalalas(t.own) });

@Injectable()
export class AcctReportsService {
  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool) {}

  private async accounts(scope: number): Promise<Acct[]> {
    const r = await this.pool.query(
      `select id, code, name_ar as "nameAr", name_en as "nameEn", type, system_key as "systemKey", parent_id as "parentId", is_group as "isGroup"
         from accounts where user_id = $1 order by code`, [scope]);
    return r.rows;
  }

  private async idsOf(scope: number, keys: string[]): Promise<number[]> {
    const r = await this.pool.query(`select id from accounts where user_id = $1 and system_key = any($2::text[])`, [scope, keys]);
    return r.rows.map((x: any) => x.id);
  }

  private static range(q: Record<string, any>, startMonth: number, toKey = "to") {
    const to = q[toKey] ? isoDate(q[toKey], toKey) : riyadhToday();
    const from = q.from ? isoDate(q.from, "from") : fyStartOf(to, startMonth);
    if (from > to) throw bad("BAD_RANGE", `from must not be after ${toKey}`);
    return { from, to };
  }

  /**
   * Units with the lease that covers `asOf`: not deleted or draft, not
   * cancelled, started on or before the date and not yet ended (the v2 early
   * end `finance_contract_dims.ended_on` wins over the contract end date; a
   * legacy termination with no recorded end date no longer counts as leased).
   */
  private async unitsAsOf(scope: number, asOf: string, f: Filt, lang: Lang) {
    const p: unknown[] = [scope, asOf];
    let w = "";
    if (f.ownerId != null) { p.push(f.ownerId); w += ` and p.owner_id = $${p.length}`; }
    if (f.propertyId != null) { p.push(f.propertyId); w += ` and p.id = $${p.length}`; }
    const r = await this.pool.query(
      `select u.id as unit_id, u.unit_number, p.id as property_id, p.name as property_name, p.owner_id, o.name as owner_name,
              o.is_account_holder as holder, o.tax_number as owner_tax, cur.contract_id,
              coalesce(case when pu.key = 'mixed' then uu.label_ar end, pu.label_ar) as usage_ar,
              coalesce(case when pu.key = 'mixed' then uu.label_en end, pu.label_en) as usage_en
         from units u
         join properties p on p.id = u.property_id and p.user_id = $1
         left join owners o on o.id = p.owner_id and o.user_id = $1
         left join lookups pu on pu.id = p.usage_lookup_id
         left join lookups uu on uu.id = u.usage_lookup_id
         left join lateral (
           select c.id as contract_id from contract_units cu
             join contracts c on c.id = cu.contract_id and c.user_id = $1
             left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
            where cu.unit_id = u.id and c.deleted_at is null and c.is_draft = false and c.status <> 'cancelled'
              and (c.status <> 'terminated' or d.ended_on is not null)
              and c.start_date <= $2::date and coalesce(d.ended_on, c.end_date) >= $2::date
            order by c.start_date desc, c.id desc limit 1) cur on true
        where u.deleted_at is null and p.deleted_at is null and u.is_draft = false and p.is_draft = false${w}
        order by p.name, p.id, u.unit_number, u.id`, p);
    return r.rows.map((x: any) => ({
      unitId: x.unit_id as number, unitNumber: x.unit_number as string, propertyId: x.property_id as number, propertyName: x.property_name as string,
      ownerId: x.owner_id as number | null, ownerName: x.owner_name as string | null, holder: x.holder === true, ownerTax: x.owner_tax as string | null,
      contractId: x.contract_id as number | null, usage: (lang === "en" ? x.usage_en : x.usage_ar) as string | null,
    }));
  }

  private async contracts(scope: number, ids: number[]) {
    if (!ids.length) return new Map<number, any>();
    const r = await this.pool.query(
      `select c.id, c.contract_number, c.ejar_contract_number, c.tenant_id, coalesce(t.name, c.tenant_name) as tenant_name, c.status::text as status,
              c.deleted_at is not null as deleted, to_char(c.start_date, 'YYYY-MM-DD') as start_date, to_char(c.end_date, 'YYYY-MM-DD') as end_date,
              to_char(d.ended_on, 'YYYY-MM-DD') as ended_on, round(c.monthly_rent * 12, 2)::text as annual_rent, c.deposit_amount::text as deposit_amount,
              coalesce(d.property_id, pu.property_id) as property_id, pr.name as property_name, coalesce(d.owner_id, pu.owner_id) as owner_id,
              (select array_agg(u.unit_number order by cu.id) from contract_units cu join units u on u.id = cu.unit_id where cu.contract_id = c.id) as units,
              (select array_agg(cu.unit_id order by cu.id) from contract_units cu where cu.contract_id = c.id) as unit_ids
         from contracts c
         left join tenants t on t.id = c.tenant_id and t.user_id = c.user_id
         left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
         left join lateral (
           select p.id as property_id, p.owner_id from contract_units cu join units u on u.id = cu.unit_id
             join properties p on p.id = u.property_id and p.user_id = c.user_id where cu.contract_id = c.id order by cu.id limit 1) pu on true
         left join properties pr on pr.id = coalesce(d.property_id, pu.property_id) and pr.user_id = c.user_id
        where c.user_id = $1 and c.id = any($2::int[])`, [scope, ids]);
    return new Map<number, any>(r.rows.map((x: any) => [x.id, x]));
  }

  // ───────────────────────────── cash flow (direct method) ─────────────────────────────

  /** GET /finance/v2/reports/cash-flow?from&to&lang */
  async cashFlow(scope: number, q: Record<string, any> = {}) {
    const lang = langOf(q.lang);
    const s = await settingsOf(this.pool, scope);
    const { from, to } = AcctReportsService.range(q, s.startMonth);
    const accts = await this.accounts(scope);
    const byId = new Map(accts.map((a) => [a.id, a]));
    const banks = (await this.pool.query(
      `select id, gl_account_id, is_trust, kind from bank_accounts where user_id = $1`, [scope])).rows;

    // Cash and cash equivalents: every leaf under the group holding the default cash / bank accounts (1110), plus any bank account's GL.
    const grp = accts.find((a) => a.systemKey === "bank_default")?.parentId ?? accts.find((a) => a.code === "1110")?.id ?? null;
    const under = (a: Acct) => { let p = a.parentId; for (let i = 0; p != null && i < 32; i++) { if (p === grp) return true; p = byId.get(p)?.parentId ?? null; } return false; };
    const cash = new Set<number>(accts.filter((a) => !a.isGroup && grp != null && under(a)).map((a) => a.id));
    for (const b of banks) if (byId.has(b.gl_account_id)) cash.add(b.gl_account_id);
    const trust = new Set<number>([
      ...banks.filter((b: any) => b.is_trust).map((b: any) => b.gl_account_id),
      ...accts.filter((a) => a.systemKey === "trust_bank").map((a) => a.id),
    ].filter((id) => cash.has(id)));
    const cashIds = [...cash];

    // Opening and closing per cash account.
    const bal = (await this.pool.query(
      `select account_id, coalesce(sum(debit - credit) filter (where entry_date < $3::date), 0)::text as opening, coalesce(sum(debit - credit), 0)::text as closing
         from journal_lines where user_id = $1 and account_id = any($2::int[]) and entry_date <= $4::date group by account_id`,
      [scope, cashIds, from, to])).rows;
    const opening = zero();
    const ledgerClosing = zero();
    const accountRows = bal.map((x: any) => {
      const a = byId.get(x.account_id)!;
      const isTrust = trust.has(a.id);
      const o = h(x.opening);
      const c = h(x.closing);
      add(opening, { amount: o, restricted: isTrust ? o : 0, own: isTrust ? 0 : o });
      add(ledgerClosing, { amount: c, restricted: isTrust ? c : 0, own: isTrust ? 0 : c });
      return { accountId: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, name: nameOf(lang, a), isTrust,
        opening: fromHalalas(o), closing: fromHalalas(c), drill: { accountId: a.id, from, to } };
    }).sort((a: any, b: any) => (a.code < b.code ? -1 : 1));

    // Every line of every entry in the period that touches a cash account.
    const rows = (await this.pool.query(
      `select l.entry_id::text as eid, l.account_id, l.debit::text as debit, l.credit::text as credit, e.origin, ${RULE_SQL} as rule
         from journal_lines l ${JOIN_E}
        where l.user_id = $1 and l.entry_id in (
          select distinct entry_id from journal_lines where user_id = $1 and account_id = any($2::int[]) and entry_date between $3::date and $4::date)
        order by l.entry_id, l.line_no`, [scope, cashIds, from, to])).rows;
    const entries = new Map<string, { origin: string; rule: string | null; lines: Array<{ acct: Acct; net: number }> }>();
    for (const x of rows) {
      const e = entries.get(x.eid) ?? (entries.set(x.eid, { origin: x.origin, rule: x.rule, lines: [] }), entries.get(x.eid)!);
      e.lines.push({ acct: byId.get(x.account_id)!, net: h(x.debit) - h(x.credit) });
    }

    const lines = new Map<CashLine, Triple & { entries: number }>();
    const put = (k: CashLine, t: Partial<Triple>) => {
      const v = lines.get(k) ?? (lines.set(k, { ...zero(), entries: 0 }), lines.get(k)!);
      add(v, t);
    };
    const touched = new Map<CashLine, number>();
    let transferGross = 0;
    for (const e of entries.values()) {
      let trustNet = 0;
      let ownNet = 0;
      const counters: Counter[] = [];
      for (const l of e.lines) {
        if (cash.has(l.acct.id)) {
          if (trust.has(l.acct.id)) trustNet += l.net; else ownNet += l.net;
          if (l.net > 0 && e.lines.every((m) => cash.has(m.acct.id))) transferGross += l.net;
        } else {
          counters.push({ systemKey: l.acct.systemKey, type: l.acct.type, code: l.acct.code, net: -l.net });
        }
      }
      const cashNet = trustNet + ownNet;
      const hit = (k: CashLine) => touched.set(k, (touched.get(k) ?? 0) + 1);
      if (!counters.length) { put("internal_transfer", { amount: 0, restricted: trustNet, own: ownNet }); hit("internal_transfer"); continue; }
      const byRule = e.origin === "opening" ? "opening_balances" : lineOfRule(e.rule, counters, cashNet, e.origin === "reversal");
      if (byRule) { put(byRule, { amount: cashNet, restricted: trustNet, own: ownNet }); hit(byRule); continue; }
      // Split over the counter-accounts (exact: the entry balances). A mixed trust/own entry routes the trust part through internal transfers.
      const mixed = trustNet !== 0 && ownNet !== 0;
      const seen = new Set<CashLine>();
      for (const c of counters) {
        const k = lineOfCounter(c);
        seen.add(k);
        put(k, { amount: c.net, restricted: !mixed && trustNet !== 0 ? c.net : 0, own: mixed || trustNet === 0 ? c.net : 0 });
      }
      if (mixed) put("internal_transfer", { amount: 0, restricted: trustNet, own: -trustNet });
      for (const k of seen) hit(k);
    }
    for (const [k, n] of touched) lines.get(k)!.entries = n;

    const net = zero();
    const sections = (Object.keys(CASH_LINES) as CashActivity[]).map((act) => {
      const tot = zero();
      const ls = (CASH_LINES[act] as readonly CashLine[]).filter((k) => lines.has(k)).map((k) => {
        const v = lines.get(k)!;
        add(tot, v);
        return { key: k, ...str(v), entries: v.entries };
      });
      add(net, tot);
      return { key: act, lines: ls, total: str(tot) };
    });
    const it = lines.get("internal_transfer") ?? { ...zero(), entries: 0 };
    add(net, it);
    const closing = zero();
    add(closing, opening);
    add(closing, net);

    // Client money held: tenant deposits (2141) and collected rent owed to landlords (2121).
    const held = (await this.pool.query(
      `select a.system_key, coalesce(sum(l.credit - l.debit), 0)::text as bal from journal_lines l
         join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and a.system_key in ('deposits_held','landlord_payable') and l.entry_date <= $2::date group by a.system_key`,
      [scope, to])).rows;
    const heldOf = (k: string) => h(held.find((x: any) => x.system_key === k)?.bal ?? "0");
    const deposits = heldOf("deposits_held");
    const landlords = heldOf("landlord_payable");
    const clientMoney = deposits + landlords;
    const useTrust = trust.size > 0;
    const restricted = useTrust ? closing.restricted : clientMoney;

    return {
      report: "cash-flow",
      lang,
      mode: s.mode,
      generatedAt: riyadhNow(),
      params: { from, to },
      opening: str(opening),
      sections,
      internalTransfers: { ...str(it), gross: fromHalalas(transferGross), entries: it.entries },
      netChange: str(net),
      closing: str(closing),
      accounts: accountRows,
      restrictedCash: {
        /** `trust_accounts`: the trust (client-money) bank accounts; `obligations`: no trust account, so client money held is ringfenced from the one pool. */
        basis: useTrust ? "trust_accounts" : "obligations",
        trustAccounts: fromHalalas(closing.restricted),
        depositsHeld: fromHalalas(deposits),
        landlordPayable: fromHalalas(landlords),
        clientMoneyHeld: fromHalalas(clientMoney),
        restricted: fromHalalas(restricted),
        unrestricted: fromHalalas(closing.amount - restricted),
        /** trust accounts − client money held: negative is a shortfall in the trust account. */
        trustDifference: useTrust ? fromHalalas(closing.restricted - clientMoney) : null,
      },
      check: {
        ledgerClosing: fromHalalas(ledgerClosing.amount),
        difference: fromHalalas(closing.amount - ledgerClosing.amount),
        balanced: closing.amount === ledgerClosing.amount && closing.restricted === ledgerClosing.restricted,
      },
    };
  }

  // ───────────────────────────── receivable movements per contract (rent roll, profitability) ─────────────────────────────

  /** 1121 + 1122 per `group` column: opening (< from), billed, collected and adjustments (from..to), closing. */
  private async arMovements(scope: number, from: string, to: string, f: Filt, group: "contract_id" | "property_id") {
    const ar = await this.idsOf(scope, ["tenant_receivable", "tenant_receivable_agency"]);
    const p: unknown[] = [scope, ar, to, from];
    const extra = dimSql(f, p);
    const r = await this.pool.query(
      `select l.${group} as k, ${RULE_SQL} as rule,
              coalesce(sum(l.debit - l.credit) filter (where l.entry_date < $4::date), 0)::text as opening,
              coalesce(sum(l.debit - l.credit) filter (where l.entry_date >= $4::date), 0)::text as period
         from journal_lines l ${JOIN_E}
        where l.user_id = $1 and l.account_id = any($2::int[]) and l.entry_date <= $3::date${extra}
        group by 1, 2`, p);
    const out = new Map<number | null, { opening: number; billed: number; collected: number; adjustments: number; closing: number }>();
    for (const x of r.rows) {
      const v = out.get(x.k) ?? (out.set(x.k, { opening: 0, billed: 0, collected: 0, adjustments: 0, closing: 0 }), out.get(x.k)!);
      const o = h(x.opening);
      const n = h(x.period);
      v.opening += o;
      const col = arColumn(x.rule);
      if (col === "billed") v.billed += n; else if (col === "collected") v.collected -= n; else v.adjustments += n;
      v.closing += o + n;
    }
    return out;
  }

  private async ledgerBalance(scope: number, keys: string[], to: string, f: Filt, sign: 1 | -1): Promise<number> {
    const ids = await this.idsOf(scope, keys);
    const p: unknown[] = [scope, ids, to];
    const extra = dimSql(f, p);
    const r = await this.pool.query(
      `select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l
        where l.user_id = $1 and l.account_id = any($2::int[]) and l.entry_date <= $3::date${extra}`, p);
    return sign * h(r.rows[0].b);
  }

  // ───────────────────────────── rent roll ─────────────────────────────

  /** GET /finance/v2/reports/rent-roll?asOf&from&ownerId&propertyId&lang */
  async rentRoll(scope: number, q: Record<string, any> = {}) {
    const lang = langOf(q.lang);
    const s = await settingsOf(this.pool, scope);
    const { from, to: asOf } = AcctReportsService.range(q, s.startMonth, "asOf");
    const f = await scopedFilters(this.pool, scope, q, ["ownerId", "propertyId"]) as Filt;
    const units = await this.unitsAsOf(scope, asOf, f, lang);
    const mv = await this.arMovements(scope, from, asOf, f, "contract_id");
    const cids = [...new Set([...units.map((u) => u.contractId).filter((x): x is number => x != null), ...[...mv.keys()].filter((x): x is number => x != null)])];
    const cs = await this.contracts(scope, cids);
    const unitById = new Map(units.map((u) => [u.unitId, u]));

    const money = (v?: { opening: number; billed: number; collected: number; adjustments: number; closing: number }) => ({
      opening: fromHalalas(v?.opening ?? 0), billed: fromHalalas(v?.billed ?? 0), collected: fromHalalas(v?.collected ?? 0),
      adjustments: fromHalalas(v?.adjustments ?? 0), outstanding: fromHalalas(v?.closing ?? 0),
    });
    const shown = new Set<number>();
    const tot = { opening: 0, billed: 0, collected: 0, adjustments: 0, closing: 0, annualRent: 0 };
    const addTot = (v: any, annual: number) => {
      if (v) { tot.opening += v.opening; tot.billed += v.billed; tot.collected += v.collected; tot.adjustments += v.adjustments; tot.closing += v.closing; }
      tot.annualRent += annual;
    };
    const contractPart = (c: any, status: string) => {
      const end = c.ended_on ?? c.end_date;
      return {
        contractId: c.id, contractNumber: c.contract_number, ejarContractNumber: c.ejar_contract_number ?? null,
        tenantId: c.tenant_id, tenantName: c.tenant_name, startDate: c.start_date, endDate: end,
        annualRent: c.annual_rent, daysRemaining: status === "leased" ? daysFrom(asOf, end) : null,
      };
    };
    const rows: any[] = [];
    let leased = 0;
    let annualLeased = 0;
    const byProperty = new Map<number, { propertyId: number; propertyName: string; units: number; leased: number }>();
    for (const u of units) {
      const bp = byProperty.get(u.propertyId) ?? (byProperty.set(u.propertyId, { propertyId: u.propertyId, propertyName: u.propertyName, units: 0, leased: 0 }), byProperty.get(u.propertyId)!);
      bp.units += 1;
      const base = { unitId: u.unitId, unitNumber: u.unitNumber, propertyId: u.propertyId, propertyName: u.propertyName, ownerId: u.ownerId, ownerName: u.ownerName, usage: u.usage };
      const c = u.contractId != null ? cs.get(u.contractId) : null;
      if (!c) {
        rows.push({ ...base, status: "vacant", contractId: null, contractNumber: null, ejarContractNumber: null, tenantId: null, tenantName: null,
          startDate: null, endDate: null, annualRent: null, daysRemaining: null, sharedContract: false, ...money() });
        continue;
      }
      leased += 1;
      bp.leased += 1;
      const first = !shown.has(c.id);
      shown.add(c.id);
      const v = mv.get(c.id);
      const annual = first ? h(c.annual_rent) : 0;
      if (first) { addTot(v, annual); annualLeased += annual; }
      rows.push({ ...base, status: "leased", ...contractPart(c, "leased"), annualRent: first ? c.annual_rent : null, sharedContract: !first,
        ...(first ? money(v) : { opening: null, billed: null, collected: null, adjustments: null, outstanding: null }) });
    }
    // Contracts with receivable movements that do not lease a listed unit today: ended, future or elsewhere.
    const extras = [...mv.keys()].filter((cid): cid is number => cid != null && !shown.has(cid) && cs.has(cid)).map((cid) => cs.get(cid))
      .sort((a: any, b: any) => String(a.property_name ?? "").localeCompare(String(b.property_name ?? ""), "ar") || (a.start_date < b.start_date ? -1 : 1) || a.id - b.id);
    for (const c of extras) {
      const v = mv.get(c.id)!;
      const u = (c.unit_ids ?? []).map((id: number) => unitById.get(id)).find(Boolean);
      const end = c.ended_on ?? c.end_date;
      const status = c.deleted ? "deleted" : c.start_date > asOf ? "future" : end < asOf || ["terminated", "expired", "cancelled"].includes(c.status) ? "ended" : "other";
      addTot(v, 0);
      rows.push({
        unitId: u?.unitId ?? null, unitNumber: u?.unitNumber ?? (c.units ?? []).join("، ") ?? null, propertyId: u?.propertyId ?? c.property_id ?? null,
        propertyName: u?.propertyName ?? c.property_name ?? null, ownerId: u?.ownerId ?? c.owner_id ?? null, ownerName: u?.ownerName ?? null, usage: u?.usage ?? null,
        status, ...contractPart(c, status), sharedContract: false, ...money(v),
      });
    }
    const un = mv.get(null);
    if (un) {
      addTot(un, 0);
      rows.push({ unitId: null, unitNumber: null, propertyId: null, propertyName: null, ownerId: null, ownerName: null, usage: null, status: "unallocated",
        contractId: null, contractNumber: null, ejarContractNumber: null, tenantId: null, tenantName: null, startDate: null, endDate: null,
        annualRent: null, daysRemaining: null, sharedContract: false, ...money(un) });
    }
    const ledger = await this.ledgerBalance(scope, ["tenant_receivable", "tenant_receivable_agency"], asOf, f, 1);
    return {
      report: "rent-roll",
      lang,
      mode: s.mode,
      generatedAt: riyadhNow(),
      params: { asOf, from, ...(f.ownerId != null ? { ownerId: f.ownerId } : {}), ...(f.propertyId != null ? { propertyId: f.propertyId } : {}) },
      rows,
      totals: {
        opening: fromHalalas(tot.opening), billed: fromHalalas(tot.billed), collected: fromHalalas(tot.collected),
        adjustments: fromHalalas(tot.adjustments), outstanding: fromHalalas(tot.closing), annualRent: fromHalalas(tot.annualRent),
      },
      occupancy: {
        units: units.length, leased, vacant: units.length - leased, occupancyPct: pct(leased, units.length), annualRentLeased: fromHalalas(annualLeased),
        collectionPct: pct(tot.collected, tot.billed),
        byProperty: [...byProperty.values()].map((b) => ({ ...b, vacant: b.units - b.leased, occupancyPct: pct(b.leased, b.units) })),
      },
      check: { ledgerAr: fromHalalas(ledger), difference: fromHalalas(tot.closing - ledger), balanced: tot.closing === ledger },
    };
  }

  // ───────────────────────────── deposits register ─────────────────────────────

  /** GET /finance/v2/reports/deposits-register?from&to&ownerId&propertyId&lang */
  async depositsRegister(scope: number, q: Record<string, any> = {}) {
    const lang = langOf(q.lang);
    const s = await settingsOf(this.pool, scope);
    const { from, to } = AcctReportsService.range(q, s.startMonth);
    const f = await scopedFilters(this.pool, scope, q, ["ownerId", "propertyId"]) as Filt;
    const dep = await this.idsOf(scope, ["deposits_held"]);
    const p: unknown[] = [scope, dep, to, from];
    const extra = dimSql(f, p);
    const r = await this.pool.query(
      `select l.contract_id as k, ${RULE_SQL} as rule, e.origin = 'reversal' as rev, l.credit > 0 as cr, l.entry_date >= $4::date as inp,
              sum(l.debit)::text as d, sum(l.credit)::text as c
         from journal_lines l ${JOIN_E}
        where l.user_id = $1 and l.account_id = any($2::int[]) and l.entry_date <= $3::date${extra}
        group by 1, 2, 3, 4, 5`, p);
    type Acc = Record<DepositColumn, number> & { opening: number; balance: number; receivedToDate: number };
    const blank = (): Acc => ({ received: 0, refunded: 0, forfeited: 0, converted: 0, applied: 0, other: 0, opening: 0, balance: 0, receivedToDate: 0 });
    const by = new Map<number | null, Acc>();
    for (const x of r.rows) {
      const v = by.get(x.k) ?? (by.set(x.k, blank()), by.get(x.k)!);
      const d = h(x.d);
      const c = h(x.c);
      const col = depositColumn(x.rule, x.cr, x.rev);
      v.balance += c - d;
      if (col === "received") v.receivedToDate += c - d;
      if (!x.inp) v.opening += c - d;
      else v[col] += depositAmount(col, d, c);
    }
    // Contracts that require a deposit, even when none has been received yet (the "غير محصّل" column).
    const pr: unknown[] = [scope, to];
    let w = "";
    if (f.ownerId != null) { pr.push(f.ownerId); w += ` and coalesce(d.owner_id, pu.owner_id) = $${pr.length}`; }
    if (f.propertyId != null) { pr.push(f.propertyId); w += ` and coalesce(d.property_id, pu.property_id) = $${pr.length}`; }
    const req = (await this.pool.query(
      `select c.id from contracts c
         left join finance_contract_dims d on d.contract_id = c.id and d.user_id = c.user_id
         left join lateral (select p.id as property_id, p.owner_id from contract_units cu join units u on u.id = cu.unit_id
           join properties p on p.id = u.property_id and p.user_id = c.user_id where cu.contract_id = c.id order by cu.id limit 1) pu on true
        where c.user_id = $1 and c.deleted_at is null and c.is_draft = false and c.status <> 'cancelled'
          and coalesce(c.deposit_amount, 0) > 0 and c.start_date <= $2::date${w}`, pr)).rows.map((x: any) => x.id as number);
    const ids = [...new Set([...req, ...[...by.keys()].filter((x): x is number => x != null)])];
    const cs = await this.contracts(scope, ids);
    const T = blank();
    let tRequired = 0;
    let tUncollected = 0;
    const rowOf = (c: any | null, v: Acc) => {
      const required = c ? h(c.deposit_amount) : 0;
      const deducted = v.forfeited + v.converted + v.applied;
      const uncollected = Math.max(0, required - v.receivedToDate);
      for (const k of Object.keys(T) as Array<keyof Acc>) T[k] += v[k];
      tRequired += required;
      tUncollected += uncollected;
      const end = c ? c.ended_on ?? c.end_date : null;
      return {
        contractId: c?.id ?? null, contractNumber: c?.contract_number ?? null, tenantId: c?.tenant_id ?? null, tenantName: c?.tenant_name ?? null,
        propertyId: c?.property_id ?? null, propertyName: c?.property_name ?? null, units: c?.units ?? [], endDate: end,
        contractStatus: c ? (c.deleted ? "deleted" : c.ended_on && c.ended_on <= to ? "ended" : c.status) : null,
        required: fromHalalas(required), opening: fromHalalas(v.opening), received: fromHalalas(v.received),
        forfeited: fromHalalas(v.forfeited), converted: fromHalalas(v.converted), applied: fromHalalas(v.applied), deducted: fromHalalas(deducted),
        refunded: fromHalalas(v.refunded), other: fromHalalas(v.other), balance: fromHalalas(v.balance), uncollected: fromHalalas(uncollected),
        state: c ? depositState({ required, received: v.receivedToDate, refunded: v.refunded, deducted, balance: v.balance }) : "unallocated",
      };
    };
    const rows = ids.map((id) => cs.get(id)).filter(Boolean)
      .sort((a: any, b: any) => String(a.property_name ?? "").localeCompare(String(b.property_name ?? ""), "ar") || String(a.contract_number).localeCompare(String(b.contract_number)))
      .map((c: any) => rowOf(c, by.get(c.id) ?? blank()));
    if (by.has(null)) rows.push(rowOf(null, by.get(null)!));
    const ledger = await this.ledgerBalance(scope, ["deposits_held"], to, f, -1);
    return {
      report: "deposits-register",
      lang,
      mode: s.mode,
      generatedAt: riyadhNow(),
      params: { from, to, ...(f.ownerId != null ? { ownerId: f.ownerId } : {}), ...(f.propertyId != null ? { propertyId: f.propertyId } : {}) },
      rows,
      totals: {
        required: fromHalalas(tRequired), opening: fromHalalas(T.opening), received: fromHalalas(T.received),
        forfeited: fromHalalas(T.forfeited), converted: fromHalalas(T.converted), applied: fromHalalas(T.applied),
        deducted: fromHalalas(T.forfeited + T.converted + T.applied), refunded: fromHalalas(T.refunded), other: fromHalalas(T.other),
        balance: fromHalalas(T.balance), uncollected: fromHalalas(tUncollected),
      },
      check: { ledgerDeposits: fromHalalas(ledger), difference: fromHalalas(T.balance - ledger), balanced: T.balance === ledger },
    };
  }

  // ───────────────────────────── property profitability ─────────────────────────────

  /**
   * Commission (4210) and its VAT (2151) on the landlord commission documents of the monthly run (0070), which carry
   * the landlord but no property, spread over the run's properties in proportion to each property's commission
   * (finance_commission_runs.detail; deferred properties take none). Integer halalas; the remainder goes to the
   * largest share so the parts add up to the line.
   */
  private async commissionRunAllocation(scope: number, from: string, to: string, f: Filt): Promise<Map<number, { com: number; cvat: number }>> {
    const out = new Map<number, { com: number; cvat: number }>();
    const p: unknown[] = [scope, from, to];
    let x = "";
    if (f.ownerId != null) { p.push(f.ownerId); x = ` and r.owner_id = $${p.length}`; }
    let rows: any[];
    try {
      rows = (await this.pool.query(
        `select a.system_key as sk, (l.credit - l.debit)::text as amt, r.detail
           from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
           join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
           join finance_commission_runs r on r.user_id = e.user_id and e.source_type = 'simple_invoice'
                                         and e.source_id in (r.document_id, coalesce(r.credit_document_id, -1))
          where l.user_id = $1 and l.entry_date between $2::date and $3::date and e.origin <> 'closing' and l.property_id is null
            and a.system_key in ('commission_revenue', 'output_vat')${x}`, p)).rows;
    } catch (err: any) {
      if (err?.code === "42P01") return out; // 0070 not applied
      throw err;
    }
    for (const row of rows) {
      const parts = (Array.isArray(row.detail) ? row.detail : [])
        .filter((d: any) => d && d.propertyId != null && !d.deferred && h(String(d.commission ?? "0")) > 0)
        .map((d: any) => ({ k: Number(d.propertyId), w: h(String(d.commission)) }));
      const W = parts.reduce((t: number, d: any) => t + d.w, 0);
      if (!W) continue;
      const amt = h(row.amt);
      let left = amt;
      const shares = parts.map((d: any) => { const s = Math.trunc((amt * d.w) / W); left -= s; return { k: d.k, s, w: d.w }; });
      shares.sort((a: any, b: any) => b.w - a.w)[0].s += left;
      for (const sh of shares) {
        const v = out.get(sh.k) ?? { com: 0, cvat: 0 };
        if (row.sk === "commission_revenue") v.com += sh.s; else v.cvat += sh.s;
        out.set(sh.k, v);
      }
    }
    return out;
  }

  /** GET /finance/v2/reports/property-profitability?from&to&ownerId&propertyId&lang */
  async propertyProfitability(scope: number, q: Record<string, any> = {}) {
    const lang = langOf(q.lang);
    const s = await settingsOf(this.pool, scope);
    const { from, to } = AcctReportsService.range(q, s.startMonth);
    const f = await scopedFilters(this.pool, scope, q, ["ownerId", "propertyId"]) as Filt;
    const units = await this.unitsAsOf(scope, to, f, lang);

    // The office's P&L by property (the closing entry excluded, as in the income statement).
    const p1: unknown[] = [scope, from, to, RENT_KEYS];
    const x1 = dimSql(f, p1);
    const pl = (await this.pool.query(
      `select l.property_id as k,
              coalesce(sum(l.credit - l.debit) filter (where a.type = 'revenue'), 0)::text as rev,
              coalesce(sum(l.credit - l.debit) filter (where a.type = 'revenue' and a.system_key = any($4::text[])), 0)::text as rent,
              coalesce(sum(l.credit - l.debit) filter (where a.system_key = 'commission_revenue'), 0)::text as com,
              coalesce(sum(l.debit - l.credit) filter (where a.type = 'expense'), 0)::text as exp
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
         join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
        where l.user_id = $1 and l.entry_date between $2::date and $3::date and a.type in ('revenue','expense') and e.origin <> 'closing'${x1}
        group by 1`, p1)).rows;

    // Agent (managed) landlords: the landlord's rent billed (2122, net of VAT), expenses charged to them (2121), and commission VAT.
    const p2: unknown[] = [scope, from, to, LANDLORD_RENT_RULES];
    const x2 = dimSql(f, p2);
    const ag = (await this.pool.query(
      `select l.property_id as k,
              coalesce(sum(l.credit - l.debit) filter (where a.system_key = 'landlord_payable_uncollected' and ${RULE_SQL} = any($4::text[])
                and not (coalesce(l.vat_category, '') = 'S' and coalesce(l.tax_role, '') = 'output')), 0)::text as lrent,
              coalesce(sum(l.debit - l.credit) filter (where a.system_key = 'landlord_payable' and ${RULE_SQL} in ('E18','E38')), 0)::text as lexp_gross,
              coalesce(sum(l.debit - l.credit) filter (where a.system_key = 'landlord_payable' and ${RULE_SQL} in ('E18','E38')
                and l.vat_category = 'S' and l.tax_role = 'input'), 0)::text as lexp_vat,
              coalesce(sum(l.credit - l.debit) filter (where a.system_key = 'output_vat' and ${RULE_SQL} in ('E15','E36')), 0)::text as cvat
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id ${JOIN_E}
        where l.user_id = $1 and l.entry_date between $2::date and $3::date
          and a.system_key in ('landlord_payable_uncollected','landlord_payable','output_vat')${x2}
        group by 1`, p2)).rows;

    const arMv = await this.arMovements(scope, from, to, f, "property_id");
    const props = new Map<number | null, any>();
    const ensure = (k: number | null) => props.get(k) ?? (props.set(k, { k, units: 0, leased: 0 }), props.get(k)!);
    for (const u of units) {
      const v = ensure(u.propertyId);
      Object.assign(v, { name: u.propertyName, ownerId: u.ownerId, ownerName: u.ownerName, holder: u.holder, ownerTax: u.ownerTax });
      v.units += 1;
      if (u.contractId != null) v.leased += 1;
    }
    for (const x of pl) Object.assign(ensure(x.k), { rev: h(x.rev), rent: h(x.rent), com: h(x.com), exp: h(x.exp) });
    for (const x of ag) Object.assign(ensure(x.k), { lrent: h(x.lrent), lexpGross: h(x.lexp_gross), lexpVat: h(x.lexp_vat), cvat: h(x.cvat) });
    // The monthly landlord commission invoice (collected basis, 0070) posts with the landlord but no property:
    // spread it over the properties of its run, so an agent landlord's commission lands on each property.
    let allocatedOutsideFilter = 0;
    for (const [k, v] of await this.commissionRunAllocation(scope, from, to, f)) {
      if (f.propertyId == null) {
        const n = ensure(null);
        n.rev = (n.rev ?? 0) - v.com; n.com = (n.com ?? 0) - v.com; n.cvat = (n.cvat ?? 0) - v.cvat;
      } else if (k !== f.propertyId) continue;
      else allocatedOutsideFilter += v.com; // the income statement for one property never saw these (no property on the line)
      const p = ensure(k);
      p.rev = (p.rev ?? 0) + v.com; p.com = (p.com ?? 0) + v.com; p.cvat = (p.cvat ?? 0) + v.cvat;
    }
    if (f.propertyId == null) {
      const n = props.get(null);
      if (n && !n.rev && !n.com && !n.cvat && !n.exp && !n.lrent && !n.lexpGross && !n.billed && !n.collected && !n.units) props.delete(null);
    }
    for (const [k, v] of arMv) Object.assign(ensure(k), { billed: v.billed, collected: v.collected });
    // Properties that only appear through the ledger (no current unit listed): load their landlord.
    const missing = [...props.values()].filter((v) => v.k != null && v.name === undefined).map((v) => v.k);
    if (missing.length) {
      const m = await this.pool.query(
        `select p.id, p.name, p.owner_id, o.name as owner_name, o.is_account_holder, o.tax_number from properties p
           left join owners o on o.id = p.owner_id and o.user_id = p.user_id where p.user_id = $1 and p.id = any($2::int[])`, [scope, missing]);
      for (const x of m.rows) Object.assign(props.get(x.id), { name: x.name, ownerId: x.owner_id, ownerName: x.owner_name, holder: x.is_account_holder === true, ownerTax: x.tax_number });
    }

    const T = { units: 0, leased: 0, billed: 0, collected: 0, revenue: 0, rent: 0, commission: 0, other: 0, expenses: 0, noi: 0,
      landlordRent: 0, commissionCost: 0, landlordExpenses: 0, landlordNet: 0 };
    const rows = [...props.values()]
      .sort((a, b) => (a.k == null ? 1 : b.k == null ? -1 : String(a.name ?? "").localeCompare(String(b.name ?? ""), "ar") || a.k - b.k))
      .map((v) => {
        const rev = v.rev ?? 0, rent = v.rent ?? 0, com = v.com ?? 0, exp = v.exp ?? 0;
        const unallocated = v.k == null;
        const agent = !unallocated && !(v.holder === true || s.mode === "owner");
        const billed = v.billed ?? 0, collected = v.collected ?? 0;
        T.units += v.units; T.leased += v.leased; T.billed += billed; T.collected += collected;
        T.revenue += rev; T.rent += rent; T.commission += com; T.other += rev - rent - com; T.expenses += exp; T.noi += rev - exp;
        let landlord: any = null;
        if (agent) {
          // An unregistered landlord cannot recover VAT, so their costs count gross (the workbook's note under ربحية العقارات).
          const registered = !!(v.ownerTax && String(v.ownerTax).trim());
          const lrent = v.lrent ?? 0;
          const commissionCost = com + (registered ? 0 : v.cvat ?? 0);
          const lexp = (v.lexpGross ?? 0) - (registered ? v.lexpVat ?? 0 : 0);
          const lnet = lrent - commissionCost - lexp;
          T.landlordRent += lrent; T.commissionCost += commissionCost; T.landlordExpenses += lexp; T.landlordNet += lnet;
          landlord = {
            vatRegistered: registered, rent: fromHalalas(lrent), commission: fromHalalas(commissionCost), expenses: fromHalalas(lexp),
            net: fromHalalas(lnet), marginPct: pct(lnet, lrent),
          };
        }
        return {
          propertyId: v.k, propertyName: unallocated ? null : v.name ?? null, ownerId: v.ownerId ?? null, ownerName: v.ownerName ?? null,
          treatment: unallocated ? "unallocated" : agent ? "agent" : "principal",
          units: v.units, leased: v.leased, occupancyPct: pct(v.leased, v.units),
          billed: fromHalalas(billed), collected: fromHalalas(collected), collectionPct: pct(collected, billed),
          revenue: fromHalalas(rev), rentRevenue: fromHalalas(rent), commission: fromHalalas(com), otherRevenue: fromHalalas(rev - rent - com),
          expenses: fromHalalas(exp), noi: fromHalalas(rev - exp), marginPct: pct(rev - exp, rev),
          landlord,
        };
      });

    // Tie to the income statement over the same range and filters.
    const p3: unknown[] = [scope, from, to];
    const x3 = dimSql(f, p3);
    const is = (await this.pool.query(
      `select coalesce(sum(l.credit - l.debit) filter (where a.type = 'revenue'), 0)::text as rev,
              coalesce(sum(l.debit - l.credit) filter (where a.type = 'expense'), 0)::text as exp
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
         join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
        where l.user_id = $1 and l.entry_date between $2::date and $3::date and e.origin <> 'closing'${x3}`, p3)).rows[0];
    const isRev = h(is.rev) + allocatedOutsideFilter;
    const isExp = h(is.exp);
    const f2 = (n: number) => fromHalalas(n);
    return {
      report: "property-profitability",
      lang,
      mode: s.mode,
      generatedAt: riyadhNow(),
      params: { from, to, ...(f.ownerId != null ? { ownerId: f.ownerId } : {}), ...(f.propertyId != null ? { propertyId: f.propertyId } : {}) },
      rows,
      totals: {
        units: T.units, leased: T.leased, occupancyPct: pct(T.leased, T.units),
        billed: f2(T.billed), collected: f2(T.collected), collectionPct: pct(T.collected, T.billed),
        revenue: f2(T.revenue), rentRevenue: f2(T.rent), commission: f2(T.commission), otherRevenue: f2(T.other),
        expenses: f2(T.expenses), noi: f2(T.noi), marginPct: pct(T.noi, T.revenue),
        landlord: { rent: f2(T.landlordRent), commission: f2(T.commissionCost), expenses: f2(T.landlordExpenses), net: f2(T.landlordNet), marginPct: pct(T.landlordNet, T.landlordRent) },
      },
      check: {
        incomeStatementRevenue: f2(isRev), incomeStatementExpenses: f2(isExp),
        difference: f2(T.revenue - isRev - (T.expenses - isExp)),
        balanced: T.revenue === isRev && T.expenses === isExp,
      },
    };
  }
}
