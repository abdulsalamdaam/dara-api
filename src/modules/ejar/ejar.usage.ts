import { sql } from "drizzle-orm";
import type { Drizzle } from "../../database/database.module";
import type { LookupUsage } from "./ejar.budget";
import { LOOKUP_ENDPOINTS } from "./ejar.types";

/**
 * An Invoices call Ejar answered "no such contract". Balady staging answers an
 * unknown number with 200 and an empty result (`data: []`, verified 12 Oct
 * 2026); 400 "رقم العقد غير صحيح" and 404 mean the same. A wrong number is free
 * for the user — left out of the lookup budget — and counted only against the
 * daily wrong-number cap. coalesce: a call with no HTTP status (network
 * failure) or an unreadable body must stay counted — `not (null)` is null.
 */
export const WRONG_NUMBER_SQL = sql`(l.endpoint = 'rentalContractInvoices' and (
  coalesce(l.status, 0) in (400, 404)
  or (l.status = 200 and coalesce(l.response_body #> '{data,result,data}' = '[]'::jsonb, false))))`;

/**
 * Ejar lookup calls actually sent since `since` (null = all time), per
 * endpoint, and this account's share — the count both the lookup budget and
 * the account limits (common/limits.ts) read. `db` may be a transaction.
 */
export async function ejarLookupUsage(db: Drizzle, since: Date | null, accountId: number): Promise<LookupUsage> {
  const res: any = await db.execute(sql`
    select l.endpoint,
           coalesce(sum(l.attempts), 0)::int as total,
           coalesce(sum(l.attempts) filter (where coalesce(u.owner_user_id, u.id) = ${accountId}), 0)::int as account
      from ejar_api_logs l
      left join users u on u.id = l.user_id
     where l.endpoint in (${sql.join(LOOKUP_ENDPOINTS.map((e) => sql`${e}`), sql`, `)})
       and l.env like 'balady%'
       and not ${WRONG_NUMBER_SQL}
       and (${since ? since.toISOString() : null}::timestamptz is null or l.created_at >= ${since ? since.toISOString() : null}::timestamptz)
     group by l.endpoint`);
  const rows: Array<{ endpoint: string; total: number; account: number }> = Array.isArray(res) ? res : res?.rows ?? [];
  const get = (e: string) => rows.find((r) => r.endpoint === e);
  const total = (e: string) => Number(get(e)?.total ?? 0);
  const acct = (e: string) => Number(get(e)?.account ?? 0);
  return {
    invoices: total("rentalContractInvoices"),
    contracts: total("getRentalContracts"),
    details: total("contractDetails"),
    account: { invoices: acct("rentalContractInvoices"), contracts: acct("getRentalContracts"), details: acct("contractDetails") },
  };
}
