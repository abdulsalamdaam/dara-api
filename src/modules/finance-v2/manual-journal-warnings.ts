import type { Fv2Client, Fv2Pool } from "./db";

/**
 * Manual journals (القيود اليدوية) touching client money (accountant, 15 Oct 2026). An accountant may post a
 * trust (أمانات) correction by hand, so nothing is refused; but a journal that sets a trust account against an
 * OFFICE account — an office expense or revenue, VAT, a supplier, equity — is how office costs end up paid with
 * clients' money, so it carries a warning (TRUST_WITH_OFFICE_ACCOUNT) on create / update / submit / approve,
 * in the posted entry's `warnings`, and in the audit row.
 *
 * Not office: the client-money accounts — every trust account, landlord payable (2121, 2122), deposits held
 * (2141), managed tenant receivables (1122), due from landlords (1123) — and the money boxes (every bank / cash
 * box, 1111–1116 including cash in transit and cheques under collection): moving money between boxes is a
 * transfer (e.g. trust → office bank for earned commission, or client money found in the cash box moved into
 * trust), not an office cost. The opening entry is never warned (its counterpart is 3900 by design).
 *
 * The transfer between accounts (POST /bank-accounts/transfer) writes its manual journal directly and never
 * passes through here, so it carries no such warning.
 */
export const TRUST_WITH_OFFICE_ACCOUNT = "TRUST_WITH_OFFICE_ACCOUNT";

export interface ManualJournalWarning {
  code: typeof TRUST_WITH_OFFICE_ACCOUNT;
  message: string;
  trustAccounts: string[];
  officeAccounts: string[];
}

/** System keys that are client money or a money box (never "office" against trust). */
export const CLIENT_OR_BOX_KEYS = [
  "trust_bank", "landlord_payable", "landlord_payable_uncollected", "deposits_held", "tenant_receivable_agency", "landlord_receivable",
  "cash", "petty_cash", "bank_default", "cash_in_transit", "cheques_under_collection",
] as const;

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

export async function manualJournalWarnings(q: Q, scope: number, lines: Array<{ accountId: number }>, kind: string): Promise<ManualJournalWarning[]> {
  if (kind === "opening") return [];
  const ids = [...new Set(lines.map((l) => Number(l.accountId)).filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (ids.length < 2) return [];
  const rows = (await q.query(
    `select a.id, a.code,
            exists (select 1 from bank_accounts b where b.user_id = a.user_id and b.gl_account_id = a.id and b.is_trust) or a.system_key = 'trust_bank' as trust,
            exists (select 1 from bank_accounts b where b.user_id = a.user_id and b.gl_account_id = a.id) or a.system_key = any($3::text[]) as client_or_box
       from accounts a where a.user_id = $1 and a.id = any($2::int[]) order by a.code`,
    [scope, ids, CLIENT_OR_BOX_KEYS])).rows;
  const trust = rows.filter((r: any) => r.trust === true).map((r: any) => String(r.code));
  if (!trust.length) return [];
  const office = rows.filter((r: any) => r.trust !== true && r.client_or_box !== true).map((r: any) => String(r.code));
  if (!office.length) return [];
  return [{
    code: TRUST_WITH_OFFICE_ACCOUNT,
    trustAccounts: trust,
    officeAccounts: office,
    message: `القيد يستخدم حساب الأمانات (${trust.join("، ")}) مقابل حساب للمكتب (${office.join("، ")}): تأكد أنه لا يصرف مصروفات المكتب من أموال العملاء`
      + ` · The entry sets the trust account (${trust.join(", ")}) against an office account (${office.join(", ")}): make sure office costs are not paid with client money`,
  }];
}

/** `?warnings=A,B` appended to an audit row's path (audit_logs has no details column). */
export const withWarnings = (path: string, w: Array<{ code: string }>) => (w.length ? `${path}?warnings=${w.map((x) => x.code).join(",")}` : path);
