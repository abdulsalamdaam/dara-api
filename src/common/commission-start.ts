/**
 * When commission starts for an account (plan transitions, D1).
 *
 * An account that moves from a plan without accounting (عقاري) to one with it
 * (المكاتب / الشركات) starts charging commission on the day it upgraded:
 * `account_plan_changes.commission_from` of the latest change that GAINED the
 * `accounting` feature. Rent DUE before that date never generates a COM-,
 * whatever date its invoice is issued (billed basis), and the collected-basis
 * run counts nothing before the month of that date.
 *
 * Null = no restriction: the account was always on a plan with accounting (its
 * baseline row from 0090 is `initial`), or 0090 is not applied yet.
 *
 * The account holder's own landlord is never billed commission either: a
 * property owned by the `is_account_holder` landlord is the office's own, so a
 * fee on it would be the office billing itself (B5).
 */
import type { Sql } from "../modules/finance-v2/hooks/sql";

async function hasPlanChanges(q: Sql): Promise<boolean> {
  const [r] = await q.rows(`select to_regclass('account_plan_changes') is not null as ok`);
  return r?.ok === true;
}

/** The commission start date (YYYY-MM-DD) of the account (`scope` = scopeId), or null when unrestricted. */
export async function commissionFrom(q: Sql, scope: number): Promise<string | null> {
  if (!(await hasPlanChanges(q))) return null;
  const [r] = await q.rows(
    `select to_char(commission_from, 'YYYY-MM-DD') as d from account_plan_changes
      where account_user_id = $1 and direction = 'upgrade'
        and to_features ? 'accounting' and not (from_features ? 'accounting')
      order by created_at desc, id desc limit 1`,
    [scope],
  );
  return r?.d ?? null;
}

/** Whether an installment due on `dueDate` falls before the commission start `from` (null `from` = never). */
export function installmentBeforeCommissionStart(dueDate: string | Date | null | undefined, from: string | null): boolean {
  if (!from || dueDate == null) return false;
  const d = dueDate instanceof Date ? dueDate.toISOString().slice(0, 10) : String(dueDate).slice(0, 10);
  return d < from;
}

/**
 * The installments of `paymentIds` that may carry commission: those due on or
 * after the commission start. All of them when there is no start date.
 */
export async function keepFromCommissionStart(q: Sql, scope: number, paymentIds: number[]): Promise<number[]> {
  const ids = paymentIds.filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return ids;
  const from = await commissionFrom(q, scope);
  if (!from) return ids;
  const rows = await q.rows(
    `select id, to_char(due_date, 'YYYY-MM-DD') as due from payments where user_id = $1 and id = any($2::int[])`,
    [scope, ids],
  );
  const due = new Map<number, string | null>(rows.map((r: any) => [Number(r.id), r.due ?? null]));
  return ids.filter((id) => !installmentBeforeCommissionStart(due.get(id) ?? null, from));
}

/** Whether a landlord row is the account holder's own (`owners.is_account_holder`). */
export async function ownerIsAccountHolder(q: Sql, scope: number, ownerId: number | null | undefined): Promise<boolean> {
  if (ownerId == null || !Number.isInteger(Number(ownerId))) return false;
  const [r] = await q.rows(`select is_account_holder from owners where id = $1 and user_id = $2`, [Number(ownerId), scope]);
  return r?.is_account_holder === true;
}

/** Whether any property of the contract's units belongs to the account holder's own landlord row. */
export async function contractOnHolderProperty(q: Sql, scope: number, contractId: number): Promise<boolean> {
  const [r] = await q.rows(
    `select exists (
       select 1 from contract_units cu
         join units u on u.id = cu.unit_id
         join properties p on p.id = u.property_id
         join owners o on o.id = p.owner_id
        where cu.contract_id = $1 and p.user_id = $2 and o.is_account_holder
     ) as holder`,
    [contractId, scope],
  );
  return r?.holder === true;
}
