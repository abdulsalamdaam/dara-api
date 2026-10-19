/**
 * Switching a contract's externally-settled installments from COUNT to SKIP
 * (migration 0084) after the ledger has already booked them.
 *
 * Under `count` the recognizer charges a past-due `settled_external` row (E02)
 * and settles it (E33). Skipping it afterwards would need those entries
 * reversed — a charge reversal for a row that is not cancelled is not a rule
 * the engine has (E05 is "cancelled"), and inventing one is exactly the kind
 * of ledger change that must not be improvised. So the switch is REFUSED while
 * any of the contract's `settled_external` rows is in the ledger:
 *
 *  - an active charge marker (`finance_installment_charges`, reversed_at null —
 *    this includes a cutover opening's markers, entry_id null), or
 *  - a charge / settled_external event still queued (pending or failed) in the
 *    outbox, which the worker would post moments later.
 *
 * An account without the v2 tables (42P01) has nothing booked: allowed.
 * Skip → count needs no guard: the next recognizer run (00:10 Riyadh) or the
 * repair sweep charges the rows, as for any past-due installment.
 */
import type { Sql } from "./hooks/sql";

export const EXTERNAL_SKIP_POSTED = (n: number) => ({
  error: "EXTERNAL_SKIP_POSTED",
  count: n,
  message: `لا يمكن التبديل إلى «تجاهل»: ${n} من دفعات هذا العقد المحصّلة خارج المنصة مُقيّدة في الدفاتر المحاسبية. يبقى الخيار «احتساب». · `
    + `Cannot switch to "skip": ${n} of this contract's installments collected outside the platform are already posted to the ledger. It stays on "count".`,
});

/** How many of the contract's `settled_external` installments the ledger has booked (or is about to). */
export async function externalPostedCount(q: Sql, scope: number, contractId: number): Promise<number> {
  try {
    const [r] = await q.rows<{ n: number }>(
      `select count(*)::int as n from payments p
        where p.user_id = $1 and p.contract_id = $2 and p.deleted_at is null and p.status::text = 'settled_external'
          and (exists (select 1 from finance_installment_charges ch where ch.payment_id = p.id and ch.user_id = p.user_id and ch.reversed_at is null)
            or exists (select 1 from ledger_outbox o where o.user_id = p.user_id and o.source_type = 'payment' and o.source_id = p.id
                        and (o.event ~ '^charge(:g[0-9]+)?$' or o.event = 'settled_external') and o.status in ('pending','failed')))`,
      [scope, contractId],
    );
    return Number(r?.n ?? 0);
  } catch (err: any) {
    if (err?.code === "42P01" || err?.cause?.code === "42P01") return 0; // no ledger tables: nothing is booked
    throw err;
  }
}
