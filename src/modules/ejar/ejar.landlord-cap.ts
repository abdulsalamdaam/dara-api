import { and, eq, isNull } from "drizzle-orm";
import { ownersTable, usersTable } from "@dara/database";
import type { Drizzle } from "../../database/database.module";
import { resolvePackage, UNLIMITED } from "../../common/packages";
import { landlordCount, PlanLimitLandlordsException } from "../../common/quota";
import type { EjarPartyInfo } from "./ejar.map";

/*
 * The landlord cap on an Ejar import (CONTRACT2 §5 — عقاري holds exactly one
 * landlord, its own).
 *
 * Runs inside the writer's transaction, AFTER its own identity match
 * (ID number, else name) found nothing and BEFORE the landlord insert — which
 * is the first write of the whole import, so a refusal leaves nothing behind.
 *
 *  - Under the cap (or an uncapped plan): returns null; the writer inserts the
 *    new landlord exactly as before.
 *  - At the cap: one looser look at the account's own rows before refusing,
 *    because the alternative is blocking the user's own contract. The account
 *    holder's row is often filled in by hand — a company's CR may sit in
 *    `tax_number`, an individual may never have typed an ID — while Ejar names
 *    the same party by ID, CR or 700 number. A match reuses that row (and
 *    backfills a missing ID number); no match is a genuinely new landlord and
 *    is refused with 403 PLAN_LIMIT_LANDLORDS.
 */

export interface CapIdentity {
  name: string | null;
  /** Every identifier Ejar gave for the lessor (ID, CR, unified 700 number). */
  ids: string[];
}

export interface CapCandidate {
  id: number;
  name: string;
  idNumber: string | null;
  taxNumber: string | null;
  isAccountHolder: boolean;
}

const norm = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();

/** The lessor's identifiers, deduped, blanks dropped. */
export function capIdentity(lessor: EjarPartyInfo | null, name: string | null, idNumber: string | null): CapIdentity {
  const ids = [idNumber, lessor?.idNumber, lessor?.registrationNumber, lessor?.unifiedNumber]
    .map((v) => norm(v == null ? null : String(v)))
    .filter(Boolean);
  return { name: norm(name) || null, ids: [...new Set(ids)] };
}

/**
 * Which existing row (if any) is this lessor, under the looser at-cap rule:
 * an identifier equal to the row's ID or tax number, else the same name on a
 * row that carries no ID number at all (a row WITH a different ID is a
 * different person). The account-holder row wins a tie.
 */
export function matchCapCandidate(rows: CapCandidate[], who: CapIdentity): CapCandidate | null {
  const ordered = [...rows].sort((a, b) => Number(b.isAccountHolder) - Number(a.isAccountHolder) || a.id - b.id);
  if (who.ids.length) {
    const byId = ordered.find((r) => who.ids.includes(norm(r.idNumber)) || who.ids.includes(norm(r.taxNumber)));
    if (byId) return byId;
  }
  if (who.name) {
    const byName = ordered.find((r) => !norm(r.idNumber) && norm(r.name) === who.name);
    if (byName) return byName;
  }
  return null;
}

/**
 * null → go ahead and insert. A number → reuse that landlord. Throws
 * PlanLimitLandlordsException (context "ejar_import") for a new landlord at the cap.
 */
export async function ejarLandlordCapGate(
  db: Drizzle, scope: number, lessor: EjarPartyInfo | null, name: string | null, idNumber: string | null,
): Promise<number | null> {
  const [acct] = await db.select({ packagePlan: usersTable.packagePlan }).from(usersTable).where(eq(usersTable.id, scope));
  const pkg = resolvePackage(acct?.packagePlan);
  if (pkg.maxLandlords >= UNLIMITED) return null;
  if ((await landlordCount(db, scope)) < pkg.maxLandlords) return null;

  const rows = await db
    .select({
      id: ownersTable.id, name: ownersTable.name, idNumber: ownersTable.idNumber,
      taxNumber: ownersTable.taxNumber, isAccountHolder: ownersTable.isAccountHolder,
    })
    .from(ownersTable)
    .where(and(eq(ownersTable.userId, scope), isNull(ownersTable.deletedAt)));
  const hit = matchCapCandidate(rows, capIdentity(lessor, name, idNumber));
  if (!hit) throw new PlanLimitLandlordsException(pkg.maxLandlords, pkg.labelAr, "ejar_import");
  if (!norm(hit.idNumber) && idNumber) {
    await db.update(ownersTable).set({ idNumber }).where(eq(ownersTable.id, hit.id));
  }
  return hit.id;
}
