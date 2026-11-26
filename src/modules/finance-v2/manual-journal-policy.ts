import type { Fv2Client, Fv2Pool } from "./db";
import { toHalalas } from "./money";

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

/**
 * Second-person approval for large manual journals (accountant notes, 27 Nov 2026, note 18; migration 0102).
 *
 * The account's finance settings carry a switch and an amount. When the switch is on, a MANUAL journal (not the
 * opening entry) whose total is at or above the amount is approved by someone other than every user who created,
 * edited or submitted it — the account holder included, with no one-person exception (the trust maker-checker's
 * written-reason self-approval does not apply to it either). Off, or below the amount: approval is unchanged.
 * Turning it on needs at least two users who can approve (settings.service.ts refuses it otherwise).
 */
export interface SecondApprovalPolicy {
  on: boolean;
  minHalalas: number;
}

export async function secondApprovalPolicy(q: Q, scope: number): Promise<SecondApprovalPolicy> {
  const [r] = (await q.query(
    `select manual_journal_second_approval as enabled, manual_journal_second_approval_min::text as min
       from finance_settings where account_user_id = $1`, [scope])).rows;
  if (!r) return { on: false, minHalalas: 0 };
  return { on: r.enabled === true, minHalalas: r.min == null ? 0 : toHalalas(String(r.min)) };
}

/** Whether `totalHalalas` of a `kind` journal needs a second person under the policy. */
export function needsSecondApprover(p: SecondApprovalPolicy, kind: string, totalHalalas: number): boolean {
  return p.on && kind === "manual" && totalHalalas >= p.minHalalas;
}

/**
 * Active users of the account who can approve a manual journal: the account holder, plus active employees whose
 * role grants `approve` (expenses.approve + invoices.write — the same test as anotherApprover in
 * manual-journal-warnings.ts).
 */
export async function manualJournalApprovers(q: Q, scope: number): Promise<number> {
  const [r] = (await q.query(
    `select (select count(*) from users u where u.id = $1 and u.deleted_at is null and u.is_active)::int
          + (select count(*) from users u join roles r on r.id = u.role_id
              where u.owner_user_id = $1 and u.deleted_at is null and u.is_active and r.deleted_at is null
                and r.permissions ? 'expenses.approve' and r.permissions ? 'invoices.write')::int as n`, [scope])).rows;
  return Number(r?.n ?? 0);
}

export const SECOND_APPROVAL_MESSAGE =
  "هذا القيد اليدوي يتجاوز حدّ الاعتماد من شخص ثانٍ في إعدادات المحاسبة، فيعتمده مستخدم آخر غير من أنشأه أو عدّله أو أرسله"
  + " · This manual journal is at or above the second-person approval amount in the accounting settings, so it must be approved by a user other than the one who created, edited or submitted it";
