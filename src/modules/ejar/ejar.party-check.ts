import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { companiesTable, ownersTable, tenantsTable, usersTable } from "@dara/database";
import { ejarPartyRole, type EjarPartyRole } from "../../common/plan-features";
import { normalizeIdentifier } from "./ejar.lookup.map";

/*
 * The identity an Ejar inquiry is pinned to on عقاري and the tenant plan.
 *
 * Never typed by the user: it is the account's own stored record, read here
 * and checked against Ejar's answer by the lookup and the import, so nothing a
 * client sends can widen it.
 *
 *  - landlord (عقاري): the account's landlord — the account-holder owner row,
 *    else the account's only owner row. Its `id_number` (an organization's
 *    CR, an individual's national ID). Several landlords and none flagged as
 *    the account's own → none (the user must complete the record first).
 *  - tenant: the company's commercial registration, else the account-holder
 *    tenant row's `national_id` (an individual tenant).
 */

export interface EjarPartyCheck {
  role: EjarPartyRole | null;
  /** The stored identifier; null when the record is missing or has none. */
  idNumber: string | null;
}

const clean = (v: unknown): string | null => {
  const s = normalizeIdentifier(v);
  return /^\d{5,20}$/.test(s) ? s : null;
};

export async function resolvePartyCheck(db: any, accountId: number): Promise<EjarPartyCheck> {
  const [acct] = await db
    .select({ packagePlan: usersTable.packagePlan, commercialReg: companiesTable.commercialReg })
    .from(usersTable)
    .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
    .where(eq(usersTable.id, accountId));
  const role = ejarPartyRole(acct?.packagePlan);
  if (role === "landlord") {
    const rows: Array<{ idNumber: string | null; isAccountHolder: boolean }> = await db
      .select({ idNumber: ownersTable.idNumber, isAccountHolder: ownersTable.isAccountHolder })
      .from(ownersTable)
      .where(and(eq(ownersTable.userId, accountId), isNull(ownersTable.deletedAt)))
      .orderBy(desc(ownersTable.isAccountHolder), asc(ownersTable.id));
    const own = rows.find((r) => r.isAccountHolder) ?? (rows.length === 1 ? rows[0] : null);
    return { role, idNumber: clean(own?.idNumber) };
  }
  if (role === "tenant") {
    const cr = clean(acct?.commercialReg);
    if (cr) return { role, idNumber: cr };
    const [self] = await db
      .select({ nationalId: tenantsTable.nationalId })
      .from(tenantsTable)
      .where(and(eq(tenantsTable.userId, accountId), eq(tenantsTable.isAccountHolder, true), isNull(tenantsTable.deletedAt)))
      .limit(1);
    return { role, idNumber: clean(self?.nationalId) };
  }
  return { role: null, idNumber: null };
}
