/**
 * Once a seller is linked to ZATCA, its tax identity is frozen (Oct 2026).
 *
 * The CSID was issued for one VAT number, every signed invoice carries it, and
 * the ICV/PIH chain belongs to that registration. Editing the VAT number (or
 * the CR the seller identifies with) on our side afterwards would make new
 * invoices disagree with the certificate and with everything already reported.
 * So while a seller holds live credentials, a request that CHANGES one of these
 * values is refused (409 VAT_LOCKED_ZATCA_LINKED); re-sending the same value or
 * omitting the field passes, so the forms keep saving everything else.
 *
 * What is locked, and by which link:
 *  - companies.vat_number / tax_number / commercial_reg (Settings → Company):
 *    the ACCOUNT is linked — a live credentials row for no landlord or for the
 *    account-holder landlord (the account's own seller, resolveStandaloneSellerId).
 *  - the account-holder landlord row: tax_number and id_number, by the same link
 *    (or a row of its own).
 *  - any other landlord row: tax_number, when THAT landlord has live credentials.
 *
 * "Live" = isOnboarded() (invoice-readiness.ts): not deleted, not revoked by
 * ZATCA (link_invalid_at), holding the CSID material of its active environment.
 * A half-finished onboarding locks nothing. The ZATCA onboarding / unlink flow
 * writes only zatca_credentials, so it is never stopped by this.
 */
import { ConflictException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { ownersTable, zatcaCredentialsTable } from "@dara/database";
import { isOnboarded } from "./invoice-readiness";

export const VAT_LOCK_CODE = "VAT_LOCKED_ZATCA_LINKED";

export const COMPANY_LOCKED_FIELDS = ["vatNumber", "taxNumber", "commercialReg"] as const;
export const ACCOUNT_HOLDER_LOCKED_FIELDS = ["taxNumber", "idNumber"] as const;
export const LANDLORD_LOCKED_FIELDS = ["taxNumber"] as const;

const norm = (v: unknown): string => (v == null ? "" : String(v).trim());

/** The locked fields this request would CHANGE (sent, and different from the stored value; blank ≡ null). Pure. */
export function lockedChanges(prior: Record<string, unknown> | null | undefined, next: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter((f) => next[f] !== undefined && norm(next[f]) !== norm(prior?.[f]));
}

/** 409 when `changed` is not empty. */
export function assertNotLocked(changed: string[]): void {
  if (!changed.length) return;
  throw new ConflictException({
    statusCode: 409,
    code: VAT_LOCK_CODE,
    fields: changed,
    message: "الحساب مرتبط بهيئة الزكاة والضريبة والجمارك، فلا يمكن تعديل الرقم الضريبي أو السجل التجاري؛ افصل الربط مع الهيئة أولاً أو تواصل مع الدعم · "
      + "This account is linked to ZATCA, so its VAT number / commercial registration cannot be changed: unlink from ZATCA first, or contact support",
  });
}

type Db = { select: (...a: any[]) => any };

/**
 * The account's live ZATCA links: `account` (a live row for no landlord or for
 * the account holder) and the set of landlord ids holding a live row.
 */
export async function zatcaLinks(db: Db, scope: number): Promise<{ account: boolean; owners: Set<number> }> {
  const rows: Array<{ creds: typeof zatcaCredentialsTable.$inferSelect; isAccountHolder: boolean | null }> = await db
    .select({ creds: zatcaCredentialsTable, isAccountHolder: ownersTable.isAccountHolder })
    .from(zatcaCredentialsTable)
    .leftJoin(ownersTable, eq(ownersTable.id, zatcaCredentialsTable.ownerId))
    .where(and(eq(zatcaCredentialsTable.userId, scope), isNull(zatcaCredentialsTable.deletedAt)));
  const owners = new Set<number>();
  let account = false;
  for (const r of rows) {
    if (!isOnboarded(r.creds)) continue;
    if (r.creds.ownerId == null || r.isAccountHolder === true) account = true;
    if (r.creds.ownerId != null) owners.add(r.creds.ownerId);
  }
  return { account, owners };
}

/** Is this landlord row's tax identity locked, and which fields? */
export function ownerLockedFields(links: { account: boolean; owners: Set<number> }, owner: { id: number; isAccountHolder?: boolean | null }): readonly string[] {
  if (owner.isAccountHolder && (links.account || links.owners.has(owner.id))) return ACCOUNT_HOLDER_LOCKED_FIELDS;
  if (links.owners.has(owner.id)) return LANDLORD_LOCKED_FIELDS;
  return [];
}
