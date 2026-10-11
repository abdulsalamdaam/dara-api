import { eq, inArray } from "drizzle-orm";
import { lookupsTable, propertiesTable, unitsTable } from "@dara/database";
import { rentVatFromUsage } from "../../common/usage-vat";
import type { Drizzle } from "../../database/database.module";

/**
 * Rent VAT for an imported Ejar contract, decided by usage exactly as the
 * manual wizard's server-side derivation (contracts.module.ts
 * `resolveRentVat`, DARA-NOTES §4): residential is exempt, everything else is
 * taxable. A mixed-use property takes its first unit's usage; when usage does
 * not decide (no usage, or mixed with no unit usage) the import stays at its
 * previous default, no VAT.
 *
 * The import used to write every contract with `vat_enabled = false`, so a
 * commercial Ejar contract carried no output VAT at all (issue 11g).
 *
 * Ejar's invoice amounts are what the tenant is billed through Ejar, so they
 * are kept as they are: a VAT-enabled Ejar installment is VAT-inclusive (the
 * same meaning `vat_enabled` has on a manual installment, whose amount is the
 * gross), never grossed up a second time.
 */
export async function ejarRentVat(db: Drizzle, propertyId: number | null, unitIds: number[]): Promise<boolean> {
  return (await ejarRentVatVerdict(db, propertyId, unitIds)) === true;
}

/**
 * The same usage rule, but `null` when usage does not decide (no property, no
 * usage, or mixed-use with no unit usage) — so the Ejar import can fall back
 * to Ejar's own contract type instead of silently defaulting.
 */
export async function ejarRentVatVerdict(db: Drizzle, propertyId: number | null, unitIds: number[]): Promise<boolean | null> {
  if (propertyId == null) return null;
  const [prop] = await db.select({ usage: propertiesTable.usageLookupId }).from(propertiesTable).where(eq(propertiesTable.id, propertyId));
  if (!prop) return null;
  let unitUsage: number | null = null;
  if (unitIds.length) {
    const units = await db.select({ id: unitsTable.id, usage: unitsTable.usageLookupId }).from(unitsTable).where(inArray(unitsTable.id, unitIds));
    unitUsage = units.find((u) => u.id === unitIds[0])?.usage ?? units.find((u) => u.usage != null)?.usage ?? null;
  }
  const ids = [prop.usage, unitUsage].filter((v): v is number => v != null);
  const keyById = new Map<number, string>();
  if (ids.length) {
    for (const r of await db.select({ id: lookupsTable.id, key: lookupsTable.key }).from(lookupsTable).where(inArray(lookupsTable.id, ids))) {
      keyById.set(r.id, r.key);
    }
  }
  const verdict = rentVatFromUsage(
    prop.usage != null ? keyById.get(prop.usage) ?? null : null,
    unitUsage != null ? keyById.get(unitUsage) ?? null : null,
  );
  return verdict;
}

/**
 * Rent VAT from Ejar's contract type when usage cannot decide: commercial
 * rent is standard-rated (15%), residential is exempt — the same split the
 * manual wizard makes. An unknown type stays at the import's old default, no VAT.
 */
export function vatFromContractType(contractType: string | null | undefined): boolean {
  return String(contractType ?? "").trim().toLowerCase() === "commercial";
}
