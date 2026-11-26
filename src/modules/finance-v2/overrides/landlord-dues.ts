import { ConflictException } from "@nestjs/common";
import { fromHalalas, toHalalas } from "../money";
import { loadSettings } from "../hooks/facts-loader";
import type { Sql } from "../hooks/sql";
import { expectedCommission } from "../commission-run";

/**
 * Finding #2 of the accountant's test (5 Oct 2026): the landlord side of
 * `GET /reports/accounting` under v2 — landlord statement, dues, transfers.
 *
 * The legacy computation knows rent collected, contract commission,
 * maintenance estimates and expenses. Two things that reduce what the office
 * owes a landlord live only in v2 tables, so the dues report said 3,000 while
 * 2121 said 2,425 and the payout screen offered the larger figure:
 *
 *  - supplier bills charged to an agent landlord (E38 Dr 2121 net + VAT): the
 *    landlord bears the whole bill, its VAT included (he recovers it on his
 *    own return if he is registered; if he is not, it is simply his cost);
 *  - the monthly commission invoice on the collected basis and its credit
 *    note (E15/E36 on 2121): billed to the landlord on `client.ownerId` with no
 *    contract, so the legacy per-contract commission never saw them.
 *
 * Only approved bills and confirmed commission documents count (drafts never
 * enter the books, voids are reversed), exactly what the engine posts. The
 * account-holder landlord and Owner mode are principal (no 2121): unchanged.
 * Landlord rows are rebuilt with the legacy formulas, so the response keeps
 * its shape; each statement row gains `vendorBills`.
 *
 * Note 13 of the accountant's full cycle (27 Nov 2026): a landlord balance
 * brought in by the opening journal (2121 with the landlord dimension — an
 * office migrating to Dara with what it already owes its landlords) or set by
 * a manual journal lives only in the journal, so the ledger said 7,200 while
 * the dues report, the payout's net due and R3's sub-ledger said 1,200. Those
 * lines now count: each row gains `journals` (Σ credit − debit on 2121 of the
 * landlord's manual and opening entries, their reversals included), added to
 * `net`. One exception keeps it from counting twice: the opening a cutover
 * backfill PROPOSED (finance_backfill_runs.summary.opening) re-derives 2121
 * from the account's own Dara history before the go-live — history the legacy
 * report already counts — so the proposal's own 2121 lines are taken off; only
 * what the accountant added or changed on top of it counts.
 */
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => Number(fromHalalas(toHalalas(String(v ?? "0"))));

export interface LandlordCharges {
  /** ownerId → Σ approved supplier bills charged to the landlord (gross). */
  bills: Map<number, number>;
  /** ownerId → Σ confirmed contract-less commission invoices − credit notes (gross). */
  commission: Map<number, number>;
  /** ownerId → Σ credit − debit on 2121 of his manual / opening journal lines (and their reversals), less a cutover proposal's own lines. */
  journals: Map<number, number>;
  names: Map<number, string>;
}

export async function landlordChargesV2(q: Sql, scope: number): Promise<LandlordCharges> {
  const s = await loadSettings(q, scope);
  const out: LandlordCharges = { bills: new Map(), commission: new Map(), journals: new Map(), names: new Map() };
  if (s?.mode === "owner") return out;
  const bills = await q.rows(
    `select b.owner_id, o.name, sum(b.total)::text as amt
       from supplier_bills b join owners o on o.id = b.owner_id and o.user_id = b.user_id
      where b.user_id = $1 and b.status = 'approved' and b.charge_to = 'landlord' and not coalesce(o.is_account_holder, false)
      group by 1, 2`, [scope]);
  for (const b of bills) {
    out.bills.set(Number(b.owner_id), num(b.amt));
    out.names.set(Number(b.owner_id), b.name ?? "—");
  }
  const com = await q.rows(
    `select o.id as owner_id, o.name, sum(case when si.type = 'credit' then -si.total else si.total end)::text as amt
       from simple_invoices si join owners o on o.user_id = si.user_id and o.id::text = si.client->>'ownerId'
      where si.user_id = $1 and si.kind = 'commission' and si.status = 'confirmed' and si.deleted_at is null and si.contract_id is null
        and not coalesce(o.is_account_holder, false)
      group by 1, 2`, [scope]);
  for (const c of com) {
    out.commission.set(Number(c.owner_id), num(c.amt));
    out.names.set(Number(c.owner_id), c.name ?? "—");
  }
  for (const [id, x] of await landlordJournalBalances(q, scope)) {
    out.journals.set(id, r2(x.amount));
    out.names.set(id, x.name ?? "—");
  }
  return out;
}

/**
 * Per agent landlord, what his manual and opening journal lines put on 2121 (credit − debit, SAR), reversals included —
 * less the 2121 lines of a cutover backfill's proposed opening that is still posted (see the header). Zero rows dropped.
 */
export async function landlordJournalBalances(q: Sql, scope: number): Promise<Map<number, { name: string | null; amount: number }>> {
  const rows = await q.rows(
    `select l.owner_id, ow.name, sum(l.credit - l.debit)::text as amt
       from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
       left join journal_entries o on o.id = e.reversal_of and o.user_id = e.user_id
       join accounts a on a.id = l.account_id and a.user_id = l.user_id
       join owners ow on ow.id = l.owner_id and ow.user_id = l.user_id
      where l.user_id = $1 and a.system_key = 'landlord_payable' and l.owner_id is not null
        and coalesce(o.origin, e.origin) in ('manual', 'opening') and not coalesce(ow.is_account_holder, false)
      group by 1, 2`, [scope]);
  const proposed = await q.rows(
    `select (x->>'ownerId')::int as owner_id, sum(coalesce((x->>'credit')::numeric, 0) - coalesce((x->>'debit')::numeric, 0))::text as amt
       from finance_backfill_runs r
       join manual_journals mj on mj.user_id = r.user_id and mj.status = 'posted' and mj.id::text = r.summary->'opening'->>'manualJournalId'
       cross join lateral jsonb_array_elements(coalesce(r.summary->'opening'->'proposal'->'lines', '[]'::jsonb)) x
       join accounts a on a.user_id = r.user_id and a.id::text = x->>'accountId' and a.system_key = 'landlord_payable'
      where r.user_id = $1 and not r.dry_run and x->>'ownerId' is not null and x->>'ownerId' ~ '^[0-9]+$'
      group by 1`, [scope]);
  const minus = new Map<number, number>(proposed.map((x: any) => [Number(x.owner_id), toHalalas(String(x.amt))]));
  const out = new Map<number, { name: string | null; amount: number }>();
  for (const x of rows) {
    const id = Number(x.owner_id);
    const v = toHalalas(String(x.amt)) - (minus.get(id) ?? 0);
    if (v !== 0) out.set(id, { name: x.name ?? null, amount: Number(fromHalalas(v)) });
  }
  return out;
}

/** The legacy accounting result with its landlord rows carrying the v2 landlord charges. */
export async function landlordDuesV2(q: Sql, scope: number, legacy: any): Promise<any> {
  const s = await loadSettings(q, scope);
  const ch = await landlordChargesV2(q, scope);
  const statement: any[] = (legacy.landlordStatement ?? []).map((r: any) => ({ ...r, vendorBills: 0, journals: 0 }));
  const byOwner = new Map<number, any>(statement.filter((r) => r.ownerId != null).map((r) => [Number(r.ownerId), r]));
  const ensure = (ownerId: number) => {
    let r = byOwner.get(ownerId);
    if (!r) {
      r = { key: `o:${ownerId}`, ownerId, landlord: ch.names.get(ownerId) ?? "—", rentCollected: 0, commission: 0, maintenance: 0, expenses: 0, vendorBills: 0, journals: 0, net: 0 };
      byOwner.set(ownerId, r);
      statement.push(r);
    }
    return r;
  };
  for (const [o, amt] of ch.bills) { const r = ensure(o); r.vendorBills = r2(r.vendorBills + amt); }
  for (const [o, amt] of ch.commission) { const r = ensure(o); r.commission = r2(r.commission + amt); }
  for (const [o, amt] of ch.journals) { const r = ensure(o); r.journals = r2(r.journals + amt); }
  for (const r of statement) r.net = r2(r.rentCollected - r.commission - r.maintenance - r.expenses - r.vendorBills + r.journals);
  statement.sort((a, b) => b.net - a.net);

  const paid = new Map<number, number>((await q.rows(
    `select owner_id, sum(amount)::text as amt from landlord_payouts where user_id = $1 and deleted_at is null and owner_id is not null group by 1`, [scope]))
    .map((x: any) => [Number(x.owner_id), num(x.amt)]));
  // Accountant, 27 Nov 2026 (note 1): the commission the month-end run will take on what is collected so far is
  // not in `remaining` yet; `available` is what may be paid out now without the landlord going negative at the run.
  const expected = s?.mode === "owner" ? new Map() : await expectedCommission(q, scope);
  const landlordDues = statement.map((r) => {
    const transferred = r.ownerId != null ? (paid.get(Number(r.ownerId)) ?? 0) : 0;
    const remaining = r2(r.net - transferred);
    const exp = r.ownerId != null ? Number(fromHalalas(expected.get(Number(r.ownerId))?.total ?? 0)) : 0;
    return { landlord: r.landlord, ownerId: r.ownerId, net: r.net, transferred, remaining, expectedCommission: exp, available: r2(remaining - exp) };
  });
  const landlordTransfers = landlordDues.map((r) => ({
    landlord: r.landlord, ownerId: r.ownerId, net: r.net, transferred: r.transferred,
    status: r.net <= 0.01 ? "none" : r.transferred >= r.net - 0.01 ? "transferred" : r.transferred > 0.01 ? "partial" : "pending",
  }));
  return { ...legacy, landlordStatement: statement, landlordDues, landlordTransfers };
}

/**
 * Never pay an agent landlord more than he is owed: a payout above the dues
 * report's `remaining` (net − already transferred) is refused with 409
 * PAYOUT_EXCEEDS_DUE. Every v2 caller passes `allowAdvance = false` since the
 * accountant's decision (15 Oct 2026: no advance, «مايتعداش رصيد مستحقاته»);
 * the parameter stays for the shape of the call.
 * Nor above `available` (remaining − the commission the next collected-basis run will take on what is
 * collected so far, `expectedCommission` in commission-run.ts): 409 PAYOUT_EXCEEDS_AVAILABLE (27 Nov 2026).
 * The account holder and Owner mode are drawings, not dues: never refused.
 */
export async function assertPayoutWithinDue(q: Sql, scope: number, ownerId: number, amount: number, allowAdvance: boolean, accounting: () => Promise<any>): Promise<void> {
  if (allowAdvance) return;
  const s = await loadSettings(q, scope);
  if (s?.mode === "owner") return;
  const [o] = await q.rows(`select is_account_holder from owners where id = $1 and user_id = $2`, [ownerId, scope]);
  if (!o || o.is_account_holder === true) return;
  const report = await accounting();
  const row = (report?.landlordDues ?? []).find((d: any) => Number(d.ownerId) === ownerId);
  const due = toHalalas(Number(row?.remaining ?? 0).toFixed(2));
  const cents = toHalalas(amount.toFixed(2));
  const netDue = fromHalalas(Math.max(0, due));
  if (cents > due) {
    throw new ConflictException({
      error: "PAYOUT_EXCEEDS_DUE",
      message: `المبلغ يتجاوز صافي المستحق للمؤجر (${netDue} ر.س) بعد خصم العمولة وفواتير الموردين المحمّلة عليه والتحويلات السابقة، مع رصيده الافتتاحي · `
        + `The amount exceeds the landlord's net due (SAR ${netDue}) after commission, supplier bills charged to him and earlier transfers, his opening balance included`,
      netDue,
      amount: fromHalalas(cents),
    });
  }
  // Accountant, 27 Nov 2026 (note 1): nor the commission the month-end run will take on what is collected so far —
  // paid out now, it would leave the landlord negative when the run posts. Same rule as the net due: no advance.
  const exp = toHalalas(Number(row?.expectedCommission ?? 0).toFixed(2));
  if (exp > 0 && cents > due - exp) {
    const available = fromHalalas(Math.max(0, due - exp));
    const expected = fromHalalas(exp);
    throw new ConflictException({
      error: "PAYOUT_EXCEEDS_AVAILABLE",
      message: `المبلغ يتجاوز المتاح للتحويل للمؤجر (${available} ر.س) بعد عمولة متوقعة ${expected} ر.س على المحصّل حتى الآن تُخصم في تشغيل عمولة نهاية الشهر · `
        + `The amount exceeds what is available to transfer to the landlord (SAR ${available}) after an expected commission of SAR ${expected} on rent collected so far, taken by the month-end commission run`,
      netDue, expectedCommission: expected, available,
      amount: fromHalalas(cents),
    });
  }
}
