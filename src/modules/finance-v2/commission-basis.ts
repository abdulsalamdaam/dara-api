/**
 * The commission basis per PROPERTY (accountant's test, 5 Oct 2026, finding
 * 9; DESIGN §9 E1-D; migration 0075).
 *
 * The account keeps its basis (`finance_settings.commission_basis`): "billed"
 * (a COM document per approved rent document, E1) or "collected" (the monthly
 * run on rent collected, E1-C). A property may override it in
 * `finance_property_commission`; a missing row or a null basis follows the
 * account, so with no row anywhere every property behaves exactly as before.
 *
 *   effective basis of a property = its own basis, else the account's
 *   (a line or contract with no property follows the account)
 *
 * Both engines read it: `planCommission` (billed) creates nothing for a
 * property on "collected", and `collectedLines` (the run) counts only lines of
 * properties on "collected", from the property's own cutover. A rent
 * installment is never charged twice when a property switches: the run skips
 * installments with a live billed COM document (as for the account switch),
 * and the billed path skips installments a live run already counted.
 *
 * No Nest here (the service, the run and the hooks share it).
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Sql } from "./hooks/sql";
import { riyadhToday } from "./dates";

/** The first day of the month holding `date` (as commission-run.ts; repeated here to keep the import graph acyclic). */
const monthStartOf = (date: string): string => `${date.slice(0, 7)}-01`;

export type CommissionBasis = "billed" | "collected";

const asBasis = (v: unknown): CommissionBasis | null => (v === "billed" || v === "collected" ? v : null);

/** Is 0075 applied? (A failed migration reads as "no overrides": the account basis everywhere.) */
export async function hasPropertyBasisTable(q: Sql): Promise<boolean> {
  const [r] = await q.rows(`select to_regclass('finance_property_commission') is not null as ok`);
  return r?.ok === true;
}

/** The account's basis (a missing settings row reads as the legacy default, "billed"). */
export async function accountBasis(q: Sql, scope: number): Promise<CommissionBasis> {
  const [r] = await q.rows(`select commission_basis from finance_settings where account_user_id = $1`, [scope]);
  return r?.commission_basis === "collected" ? "collected" : "billed";
}

export interface PropertyBasis {
  propertyId: number | null;
  /** What applies to the property. */
  basis: CommissionBasis;
  /** The property's own choice; null = it follows the account. */
  override: CommissionBasis | null;
  accountBasis: CommissionBasis;
  /** The property's collected-basis cutover (YYYY-MM-DD), when it overrides to "collected". */
  collectedFrom: string | null;
}

/** The effective basis of a property (null property → the account's). */
export async function propertyBasis(q: Sql, scope: number, propertyId: number | null): Promise<PropertyBasis> {
  const acct = await accountBasis(q, scope);
  if (propertyId == null || !(await hasPropertyBasisTable(q))) {
    return { propertyId, basis: acct, override: null, accountBasis: acct, collectedFrom: null };
  }
  const [r] = await q.rows(
    `select basis, to_char(collected_from,'YYYY-MM-DD') as cf from finance_property_commission where user_id = $1 and property_id = $2`,
    [scope, propertyId],
  );
  const override = asBasis(r?.basis);
  return { propertyId, basis: override ?? acct, override, accountBasis: acct, collectedFrom: override === "collected" ? r?.cf ?? null : null };
}

/** Does any property of the account override to "collected"? (Then the monthly run applies to it even on a billed account.) */
export async function anyCollectedProperty(q: Sql, scope: number): Promise<boolean> {
  if (!(await hasPropertyBasisTable(q))) return false;
  const [r] = await q.rows(
    `select exists (select 1 from finance_property_commission pc join properties p on p.id = pc.property_id and p.user_id = pc.user_id
                     where pc.user_id = $1 and pc.basis = 'collected') as any`,
    [scope],
  );
  return r?.any === true;
}

/**
 * The SQL condition (over a journal line aliased `l`) "this line's property is
 * on the collected basis, and the line is on or after the property's own
 * cutover". `$acct` is the placeholder holding the account basis.
 */
export function collectedBasisSql(hasTable: boolean, acct: string): string {
  if (!hasTable) return `${acct}::text = 'collected'`;
  return `coalesce((select pc.basis from finance_property_commission pc where pc.user_id = l.user_id and pc.property_id = l.property_id), ${acct}::text) = 'collected'
          and not exists (select 1 from finance_property_commission pc where pc.user_id = l.user_id and pc.property_id = l.property_id
                           and pc.basis = 'collected' and pc.collected_from is not null and l.entry_date < pc.collected_from)`;
}

type Q = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/**
 * Set (or clear, with null) a property's basis inside the caller's
 * transaction. Switching to "collected" records the property's cutover: the
 * first day of the current Riyadh month. Returns the previous override.
 */
export async function setPropertyBasis(c: Q, scope: number, propertyId: number, basis: unknown, actorId: number | null): Promise<CommissionBasis | null> {
  if (basis !== null && asBasis(basis) == null) {
    throw new BadRequestException({ error: "BAD_VALUE", message: "الأساس يجب أن يكون billed أو collected أو null · basis must be 'billed', 'collected' or null" });
  }
  const p = await c.query(`select id from properties where id = $1 and user_id = $2`, [propertyId, scope]);
  if (!p.rowCount) throw new NotFoundException("Property not found");
  const cur = (await c.query(`select basis, collected_from from finance_property_commission where user_id = $1 and property_id = $2 for update`, [scope, propertyId])).rows[0];
  const prev = asBasis(cur?.basis);
  const next = asBasis(basis);
  // Keep an existing cutover when the property stays on "collected"; a new switch starts this month.
  const collectedFrom = next === "collected" ? (prev === "collected" && cur?.collected_from ? cur.collected_from : monthStartOf(riyadhToday())) : null;
  await c.query(
    `insert into finance_property_commission (user_id, property_id, basis, collected_from, updated_by) values ($1, $2, $3, $4::date, $5)
     on conflict (user_id, property_id) do update set basis = excluded.basis, collected_from = excluded.collected_from,
       updated_by = excluded.updated_by, updated_at = now()`,
    [scope, propertyId, next, collectedFrom, actorId],
  );
  return prev;
}
