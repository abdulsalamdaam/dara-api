import type { Fv2Client } from "./db";
import { LOCK_KEYS } from "./lock-keys";

/**
 * The account's ONE payment-voucher series, PV-###### (DESIGN §8.2 c, §8.4):
 * tenant credit refunds, v2 deposit refunds and supplier payments share it, so
 * a number is never issued twice across the three. MAX+1 under the account's
 * PV advisory lock, inside the caller's transaction. A table that does not
 * exist yet (its migration failed at boot) is simply left out.
 */
const SOURCES = ["tenant_credit_actions", "finance_deposit_refunds", "supplier_payments"] as const;

export async function nextPvNumber(c: Pick<Fv2Client, "query">, scope: number): Promise<string> {
  await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.PV]);
  const present = (await c.query(`select t from unnest($1::text[]) t where to_regclass(t) is not null`, [SOURCES as unknown as string[]])).rows
    .map((r: any) => r.t as string).filter((t) => (SOURCES as readonly string[]).includes(t));
  if (!present.length) return "PV-000001";
  const union = present
    .map((t) => `select cast(substring(number from '^PV-([0-9]+)$') as integer) as n from ${t} where user_id = $1 and number ~ '^PV-[0-9]+$'`)
    .join(" union all ");
  const [r] = (await c.query(`select coalesce(max(n), 0) as m from (${union}) x`, [scope])).rows;
  return `PV-${String(Number(r?.m ?? 0) + 1).padStart(6, "0")}`;
}
