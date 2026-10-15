import type { Fv2Client, Fv2Pool } from "./db";
import { resolveTreatment } from "./rules";
import { h } from "./reports/common";

/**
 * Client money held in trust (أموال العملاء في حساب الأمانات), computed ONCE for two readers that must never drift:
 *
 *  - R16, the control check "trust balance = landlord and tenant money held" (reports/control-checks.ts), which
 *    formats this position as its report;
 *  - the trust guard (trust-guard.ts), which caps a landlord's payout from trust at THAT landlord's money in trust and
 *    a transfer from trust to an office account at the office's money in trust (accountant, 15 Oct 2026: «عشان ما
 *    يتحول لمالك من فلوس مالك آخر»).
 *
 * The math is R16's (see its comment for the accountant rounds behind each line): the trust bank balance against
 *   2121 landlord payable + 2141 deposits held − agent cash in transit + landlord bills still unpaid   (client money)
 * + office money left in trust (commission, landlord expenses the office paid, deposits kept, less transfers out)
 * + the opening balance difference;
 * with every entry that moves trust and the client liabilities by different amounts listed as "unexplained" (client
 * money collected outside trust, e.g. rent taken into the cash box), each one's residual spread over the landlords
 * whose 2121 / 2141 / transit lines it moves.
 *
 * Per landlord (the guard's part, from the same maps):
 *   outside   = his client money collected outside trust (Σ of his share of the unexplained residuals), ≥ 0;
 *   outsideNet= outside less the office's share of it (commission / expenses recovered from that same money, which
 *               never entered trust either — R16's `attributable`, per landlord);
 *   movedIn   = the money moved into trust from the office's own boxes that covers his outside money: first the
 *               transfers tagged with him (POST /bank-accounts/transfer {ownerId}), then the untagged rest of
 *               R16's `movedIntoTrust`, shared in proportion to what is still outside per landlord;
 *   inTrust   = 2121 + 2141 − transit (his lines) − outsideNet + movedIn;
 *   payable   = inTrust − his 2141, never below 0.
 *
 * `payable` is what a payout to him may take out of trust. His tenants' deposits (2141 on his lines) are in his
 * `inTrust` — they are client money held for his contracts — but they are NOT his: a deposit is the tenant's money
 * until it is forfeited (E11) or applied, so it is never payable to the landlord. They are taken off first: when his
 * money in trust is short, the deposits keep their cover and his payable shrinks.
 *
 * Read on whatever client the caller passes (the guard passes its locked transaction client — never the pool while a
 * lock is held). Only POSTED entries are read; the guard adds the queued outbox rows itself.
 */
export interface OwnerPosition {
  lp: number;
  dep: number;
  transit: number;
  outside: number;
  officeShareOutside: number;
  outsideNet: number;
  movedIn: number;
  inTrust: number;
  payable: number;
}

export interface ClientMoneyPosition {
  applicable: boolean;
  /** Why not applicable: owner_mode | no_trust_account | trust_routing_off. */
  notApplicable: string | null;
  trustBal: number;
  lp: number;
  dep: number;
  transit: number;
  commission: number;
  officePaid: number;
  officeFromBills: number;
  depositsToOffice: number;
  transfers: number;
  officeMoney: number;
  officeOutsideTrust: number;
  unpaidBills: number;
  opening: number;
  clientMoney: number;
  officeInTrust: number;
  movedIntoTrust: number;
  expected: number;
  unexplained: Array<{ entryId: number; entryNo: string; date: string; rule: string | null; sourceType: string; sourceId: number; trust: number; liability: number; difference: number }>;
  bills: any[];
  byOwner: Map<number, OwnerPosition>;
}

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

const EMPTY = (why: string): ClientMoneyPosition => ({
  applicable: false, notApplicable: why, trustBal: 0, lp: 0, dep: 0, transit: 0, commission: 0, officePaid: 0, officeFromBills: 0, depositsToOffice: 0,
  transfers: 0, officeMoney: 0, officeOutsideTrust: 0, unpaidBills: 0, opening: 0, clientMoney: 0, officeInTrust: 0, movedIntoTrust: 0, expected: 0,
  unexplained: [], bills: [], byOwner: new Map(),
});

/** `mode` is finance_settings.accounting_mode as the caller resolved it (R16: the check context); omitted, it is read. `asOf` bounds the entries (inclusive). */
export async function clientMoneyPosition(q: Q, scope: number, asOf: string, mode?: string | null): Promise<ClientMoneyPosition> {
  const st = (await q.query(`select agency_collections_to_trust as trust, accounting_mode as mode from finance_settings where account_user_id = $1`, [scope])).rows[0] ?? {};
  const m = mode === undefined ? (st.mode ?? null) : mode;
  const trustAccts = (await q.query(
    `select distinct gl_account_id as id from bank_accounts where user_id = $1 and is_trust and gl_account_id is not null`, [scope])).rows.map((x: any) => Number(x.id));
  if (m !== "manager" || !trustAccts.length) return EMPTY(m !== "manager" ? "owner_mode" : "no_trust_account");
  if (!st.trust) return EMPTY("trust_routing_off");
  const holders = new Set((await q.query(`select id from owners where user_id = $1 and is_account_holder`, [scope])).rows.map((x: any) => x.id));
  const agent = (ownerId: number | null) => ownerId != null && resolveTreatment("manager", { id: ownerId, isAccountHolder: holders.has(ownerId) }).treatment === "agent";
  const own = (await q.query(
    `with recursive g as (select id from accounts where user_id = $1 and code = '1110'
                           union all select a.id from accounts a join g on a.parent_id = g.id where a.user_id = $1)
     select a.id from accounts a join g on g.id = a.id where not a.is_group`, [scope])).rows.map((x: any) => Number(x.id)).filter((id: number) => !trustAccts.includes(id));
  // Per entry: the trust movement, the client-liability movement, the transit movement and the office-cash movement.
  const lines = (await q.query(
    `select l.entry_id, e.entry_no, to_char(e.entry_date, 'YYYY-MM-DD') as d, e.origin, coalesce(e.payload->>'rule', o.payload->>'rule') as rule,
            coalesce(o.origin, e.origin) as root_origin, e.source_type, e.source_id, e.reversal_of is not null as is_reversal,
            coalesce(e.payload->'transfer'->>'ownerId', o.payload->'transfer'->>'ownerId') as t_owner,
            a.system_key as sk, l.account_id, l.owner_id, (l.debit - l.credit)::text as dc
       from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
       join accounts a on a.id = l.account_id and a.user_id = l.user_id
       left join journal_entries o on o.id = e.reversal_of and o.user_id = e.user_id
      where l.user_id = $1 and l.entry_date <= $2::date
        and (l.account_id = any($3::int[]) or l.account_id = any($4::int[]) or a.system_key in ('landlord_payable','deposits_held','cash_in_transit'))`,
    [scope, asOf, trustAccts, own])).rows;
  type E = { entryId: number; entryNo: string; date: string; rule: string | null; origin: string; sourceType: string; sourceId: number; reversal: boolean; tOwner: number | null; trust: number; liab: number; transit: number; office: number; landlordLp: number; byOwner: Map<number | null, number> };
  const ents = new Map<number, E>();
  const ownerOf = (x: any): number | null => (x.owner_id == null ? null : Number(x.owner_id));
  const addTo = (mp: Map<number | null, number>, k: number | null, v: number) => { if (v) mp.set(k, (mp.get(k) ?? 0) + v); };
  // An entry's residual split over the landlords whose 2121 / 2141 / transit lines it moves (in proportion; the
  // rounding remainder, and an entry with no such line, go to the unattributed bucket `null`).
  const spread = (e: E, r: number, into: Map<number | null, number>) => {
    let left = r;
    const base = e.liab - e.transit;
    if (base !== 0) for (const [o, v] of e.byOwner) { if (o == null) continue; const part = Math.round((r * v) / base); addTo(into, o, part); left -= part; }
    addTo(into, null, left);
  };
  // Per landlord: the office money taken out of their client money, and their client money collected outside trust.
  const officeBy = new Map<number | null, number>(), outsideBy = new Map<number | null, number>();
  // Per landlord balances (the guard's part): 2121, 2141 and agent transit on his lines; transfers into trust tagged with him.
  const lpBy = new Map<number | null, number>(), depBy = new Map<number | null, number>(), transitBy = new Map<number | null, number>(), taggedIn = new Map<number | null, number>();
  let trustBal = 0, lp = 0, dep = 0, transit = 0;
  for (const x of lines) {
    const id = Number(x.entry_id);
    const tOwner = x.t_owner != null && /^\d+$/.test(String(x.t_owner)) ? Number(x.t_owner) : null;
    const e = ents.get(id) ?? { entryId: id, entryNo: x.entry_no, date: x.d, rule: x.rule ?? null, origin: x.root_origin, sourceType: x.source_type, sourceId: Number(x.source_id), reversal: x.is_reversal === true, tOwner, trust: 0, liab: 0, transit: 0, office: 0, landlordLp: 0, byOwner: new Map() };
    ents.set(id, e);
    const v = h(x.dc);
    if (trustAccts.includes(x.account_id)) { e.trust += v; trustBal += v; }
    else if (x.sk === "landlord_payable") { e.liab -= v; e.landlordLp -= v; lp -= v; addTo(e.byOwner, ownerOf(x), -v); addTo(lpBy, ownerOf(x), -v); }
    else if (x.sk === "deposits_held") { e.liab -= v; dep -= v; addTo(e.byOwner, ownerOf(x), -v); addTo(depBy, ownerOf(x), -v); }
    else if (x.sk === "cash_in_transit") { if (agent(x.owner_id)) { e.transit += v; transit += v; addTo(e.byOwner, ownerOf(x), -v); addTo(transitBy, ownerOf(x), v); } }
    else if (own.includes(x.account_id)) e.office += v;
  }
  // Landlord-charged supplier bills still open at asOf (their E38 debited 2121; the cash is still in trust until paid).
  const bills = (await q.query(
    `select b.id, b.number, b.owner_id, (b.total - coalesce((select sum(a.amount) from supplier_payment_allocations a
              join supplier_payments p on p.id = a.payment_id and p.user_id = a.user_id
             where a.bill_id = b.id and a.user_id = b.user_id and p.paid_on <= $2::date and (p.status = 'posted' or p.voided_on > $2::date)), 0))::text as open
       from supplier_bills b
      where b.user_id = $1 and b.charge_to = 'landlord' and b.approved_at is not null and b.bill_date <= $2::date and (b.status = 'approved' or b.voided_on > $2::date)`,
    [scope, asOf])).rows.filter((b: any) => agent(b.owner_id) && h(b.open) !== 0);
  const unpaidBills = bills.reduce((t: number, b: any) => t + h(b.open), 0);

  // Classify each entry's residual (trust movement − liability movement − transit).
  const COMMISSION = new Set(["E15", "E16", "E36"]);
  let commission = 0, officePaid = 0, transfers = 0, billsFlow = 0, opening = 0, depositsToOffice = 0, transfersIn = 0;
  // A principal deposit forfeited, turned into revenue or applied to the office's own arrears (E11 / E12 / E12B) stops
  // being client money while the cash stays in trust: it is the office's money, not yet transferred (round 3).
  const DEPOSIT_TO_OFFICE = new Set(["E11", "E12", "E12B"]);
  const unexplained: ClientMoneyPosition["unexplained"] = [];
  for (const e of ents.values()) {
    const r = e.trust - e.liab + e.transit;
    if (r === 0) continue;
    if (e.rule && COMMISSION.has(e.rule)) { commission += r; spread(e, r, officeBy); continue; }
    if (e.origin === "opening") { opening += r; continue; }
    // The commission transfer (E15T, 0070): trust → the office's operating account, the office money moving out.
    if (e.rule === "E15T") { transfers += r; continue; }
    // A landlord expense (E18) or bill payment (E39) settled from the office's own account: the office's money is owed back from trust.
    if ((e.rule === "E18" || e.rule === "E38") && e.trust === 0) { if (e.rule === "E38") billsFlow += r; else officePaid += r; spread(e, r, officeBy); continue; }
    if (e.rule === "E39") { billsFlow += r; spread(e, r, officeBy); continue; }
    if (e.rule && DEPOSIT_TO_OFFICE.has(e.rule) && e.trust === 0 && e.landlordLp === 0) { depositsToOffice += r; spread(e, r, officeBy); continue; }
    // A transfer between the trust account and the office's own cash/bank accounts (a manual journal, both sides cash).
    // A reversal undoes its original in the original's bucket: reversing a transfer INTO trust takes back money moved in
    // (not office money moved out of trust), and reversing one OUT of trust gives back office money (not client money moved in).
    if (e.liab === 0 && e.trust !== 0 && e.trust + e.office === 0) {
      if (e.reversal ? r < 0 : r > 0) { transfersIn += r; if (e.tOwner != null) addTo(taggedIn, e.tOwner, r); } else transfers += r;
      continue;
    }
    spread(e, -r, outsideBy);
    unexplained.push({ entryId: e.entryId, entryNo: e.entryNo, date: e.date, rule: e.rule, sourceType: e.sourceType, sourceId: e.sourceId, trust: e.trust, liability: e.liab, difference: r });
  }
  // Money moved INTO trust from the office's accounts first covers client money that was collected outside trust
  // (the unexplained entries, e.g. rent and deposits taken into the cash box before trust routing — accountant
  // round 4); only what is left over is the office's own money sitting in trust.
  const shortfall = Math.max(0, -unexplained.reduce((t, x) => t + x.difference, 0));
  const movedIntoTrust = Math.min(transfersIn, shortfall);
  transfers += transfersIn - movedIntoTrust;
  // Supplier payments from trust to landlord bills reduce the unpaid bills; from the office account they move to office money.
  // billsFlow carries the E38 (+) and E39 from trust (−) residuals; what is still open is `unpaidBills`, the rest is office-paid.
  const officeFromBills = billsFlow - unpaidBills;
  const officeMoney = commission + officePaid + officeFromBills + transfers + depositsToOffice;
  // Office money only sits in trust when the client money it came out of did. Commission on rent collected into the
  // cash box, or a landlord expense recovered from such rent, never entered trust: it is the office's share of the
  // money still outside (accountant round 5: "expected should be 5,215 dues + 3,000 deposit = 8,215 — it does not
  // deduct the 575 cleaning and the 210 commission"). So the client money still outside trust (net of transfers
  // in) absorbs the office money first, and only what is left of it is expected in trust.
  // Only a landlord's own money outside trust can hold the office's share of it: commission earned on rent that did
  // reach trust is in trust, even while another landlord's rent sits in the cash box.
  for (const b of bills) addTo(officeBy, Number(b.owner_id), -h(b.open));
  let attributable = 0;
  for (const [o, out] of outsideBy) attributable += Math.min(Math.max(0, officeBy.get(o) ?? 0), Math.max(0, out));
  const stillOutside = shortfall - movedIntoTrust;
  const officeOutsideTrust = Math.max(0, Math.min(officeMoney, stillOutside, attributable));
  // The client money held: the net credit balances of 2121 and 2141 (after commission, landlord expenses, payouts
  // and refunds), less Ejar transit, plus landlord bills still to be paid from it.
  const clientMoney = lp + dep - transit + unpaidBills;
  // Office money is never negative in trust: more taken out of trust than the office earned is client money gone.
  const officeInTrust = Math.max(0, officeMoney - officeOutsideTrust);
  const expected = clientMoney + officeInTrust + opening;

  // ── Per landlord (the guard) ──
  const owners = new Set<number>();
  for (const mp of [lpBy, depBy, transitBy, outsideBy, officeBy, taggedIn]) for (const k of mp.keys()) if (k != null) owners.add(k);
  const byOwner = new Map<number, OwnerPosition>();
  for (const o of owners) {
    const outside = Math.max(0, outsideBy.get(o) ?? 0);
    const officeShareOutside = Math.min(Math.max(0, officeBy.get(o) ?? 0), outside);
    byOwner.set(o, {
      lp: lpBy.get(o) ?? 0, dep: depBy.get(o) ?? 0, transit: transitBy.get(o) ?? 0, outside, officeShareOutside,
      outsideNet: outside - officeShareOutside, movedIn: 0, inTrust: 0, payable: 0,
    });
  }
  // The money moved into trust covers outside money: first what was tagged with a landlord, then the rest in proportion.
  let pool = movedIntoTrust;
  for (const [o, p] of byOwner) {
    const take = Math.max(0, Math.min(taggedIn.get(o) ?? 0, p.outsideNet, pool));
    p.movedIn = take;
    pool -= take;
  }
  const rest = [...byOwner.values()].reduce((t, p) => t + (p.outsideNet - p.movedIn), 0);
  if (pool > 0 && rest > 0) {
    const share = Math.min(pool, rest);
    for (const p of byOwner.values()) p.movedIn += Math.floor((share * (p.outsideNet - p.movedIn)) / rest); // floored: never more than moved in
  }
  for (const p of byOwner.values()) {
    p.inTrust = p.lp + p.dep - p.transit - p.outsideNet + p.movedIn;
    p.payable = Math.max(0, p.inTrust - p.dep);
  }

  unexplained.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.entryId - b.entryId));
  return {
    applicable: true, notApplicable: null, trustBal, lp, dep, transit, commission, officePaid, officeFromBills, depositsToOffice, transfers, officeMoney,
    officeOutsideTrust, unpaidBills, opening, clientMoney, officeInTrust, movedIntoTrust, expected, unexplained, bills, byOwner,
  };
}

/** A landlord's position (zeros when he has no line). */
export function ownerPosition(p: ClientMoneyPosition, ownerId: number): OwnerPosition {
  return p.byOwner.get(ownerId) ?? { lp: 0, dep: 0, transit: 0, outside: 0, officeShareOutside: 0, outsideNet: 0, movedIn: 0, inTrust: 0, payable: 0 };
}
