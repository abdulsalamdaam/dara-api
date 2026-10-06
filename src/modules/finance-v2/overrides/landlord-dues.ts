import { ConflictException } from "@nestjs/common";
import { fromHalalas, toHalalas } from "../money";
import { loadSettings } from "../hooks/facts-loader";
import type { Sql } from "../hooks/sql";

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
 */
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => Number(fromHalalas(toHalalas(String(v ?? "0"))));

export interface LandlordCharges {
  /** ownerId → Σ approved supplier bills charged to the landlord (gross). */
  bills: Map<number, number>;
  /** ownerId → Σ confirmed contract-less commission invoices − credit notes (gross). */
  commission: Map<number, number>;
  names: Map<number, string>;
}

export async function landlordChargesV2(q: Sql, scope: number): Promise<LandlordCharges> {
  const s = await loadSettings(q, scope);
  const out: LandlordCharges = { bills: new Map(), commission: new Map(), names: new Map() };
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
  return out;
}

/** The legacy accounting result with its landlord rows carrying the v2 landlord charges. */
export async function landlordDuesV2(q: Sql, scope: number, legacy: any): Promise<any> {
  const ch = await landlordChargesV2(q, scope);
  const statement: any[] = (legacy.landlordStatement ?? []).map((r: any) => ({ ...r, vendorBills: 0 }));
  const byOwner = new Map<number, any>(statement.filter((r) => r.ownerId != null).map((r) => [Number(r.ownerId), r]));
  const ensure = (ownerId: number) => {
    let r = byOwner.get(ownerId);
    if (!r) {
      r = { key: `o:${ownerId}`, ownerId, landlord: ch.names.get(ownerId) ?? "—", rentCollected: 0, commission: 0, maintenance: 0, expenses: 0, vendorBills: 0, net: 0 };
      byOwner.set(ownerId, r);
      statement.push(r);
    }
    return r;
  };
  for (const [o, amt] of ch.bills) { const r = ensure(o); r.vendorBills = r2(r.vendorBills + amt); }
  for (const [o, amt] of ch.commission) { const r = ensure(o); r.commission = r2(r.commission + amt); }
  for (const r of statement) r.net = r2(r.rentCollected - r.commission - r.maintenance - r.expenses - r.vendorBills);
  statement.sort((a, b) => b.net - a.net);

  const paid = new Map<number, number>((await q.rows(
    `select owner_id, sum(amount)::text as amt from landlord_payouts where user_id = $1 and deleted_at is null and owner_id is not null group by 1`, [scope]))
    .map((x: any) => [Number(x.owner_id), num(x.amt)]));
  const landlordDues = statement.map((r) => {
    const transferred = r.ownerId != null ? (paid.get(Number(r.ownerId)) ?? 0) : 0;
    return { landlord: r.landlord, ownerId: r.ownerId, net: r.net, transferred, remaining: r2(r.net - transferred) };
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
 * PAYOUT_EXCEEDS_DUE unless the caller sends `allowAdvance: true` (an advance
 * on future rent is a real thing; it then shows as a negative remaining).
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
  if (toHalalas(amount.toFixed(2)) <= due) return;
  const netDue = fromHalalas(Math.max(0, due));
  throw new ConflictException({
    error: "PAYOUT_EXCEEDS_DUE",
    message: `المبلغ يتجاوز صافي المستحق للمؤجر (${netDue} ر.س) بعد خصم العمولة وفواتير الموردين المحمّلة عليه والتحويلات السابقة · `
      + `The amount exceeds the landlord's net due (SAR ${netDue}) after commission, supplier bills charged to him and earlier transfers`,
    netDue,
    amount: fromHalalas(toHalalas(amount.toFixed(2))),
  });
}
