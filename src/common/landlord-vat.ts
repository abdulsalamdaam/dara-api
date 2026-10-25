/**
 * Rent VAT (R1, Oct 2026): rent carries 15% only when BOTH
 *   - the property/unit usage is taxable (common/usage-vat.ts), AND
 *   - the LANDLORD (the seller of the rent) is VAT-registered.
 *
 * A landlord with no VAT number charges no VAT even on commercial rent, and
 * issues no tax invoice — a rent receipt instead (finance-v2 `rent_receipt`).
 *
 * The landlord's registration is read from ONE place: `owners.tax_number` of
 * the property's owner (`properties.owner_id`) — the same row the invoice
 * readiness gate (invoice-readiness.ts) treats as the seller.
 *
 *   - empty / null                        → not registered
 *   - 15 digits starting and ending with 3 → registered
 *   - anything else non-empty             → treated as registered. A malformed
 *     number is still a claim of registration, and the readiness gate and the
 *     rent-receipt routing both read "non-empty" as registered — under-charging
 *     VAT is the liability, so this errs on the side they already take.
 *   - no owner linked to the property     → unknown (null): usage decides alone,
 *     as before this rule; the readiness gate refuses a tax invoice with no
 *     landlord anyway.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { lookupsTable, ownersTable, propertiesTable, unitsTable } from "@dara/database";
import { rentVatFromUsage } from "./usage-vat";

export const VAT_NUMBER_RE = /^3\d{13}3$/;

/** Is this stored tax number a VAT registration? See the module comment for the malformed case. */
export function isVatRegisteredNumber(v: string | null | undefined): boolean {
  // A well-formed number (VAT_NUMBER_RE) and a malformed non-empty one both count.
  return (v ?? "").toString().trim().length > 0;
}

export type RentVatReason = "residential" | "taxable_usage" | "landlord_not_registered" | "undecided";

export interface RentVatVerdict {
  /** The VAT flag the contract must carry. */
  vatEnabled: boolean;
  /** True when the server decides (the client's choice is ignored); false only for `undecided`. */
  locked: boolean;
  reason: RentVatReason;
  /** null when no unit has a linked landlord. */
  landlordVatRegistered: boolean | null;
  /** The usage verdict across the units: taxable if ANY unit is taxable. */
  usage: "residential" | "taxable" | "undecided";
}

/** One unit's facts: its usage verdict (rentVatFromUsage) and its landlord's registration. */
export interface UnitVatFacts {
  usageTaxable: boolean | null;
  landlordRegistered: boolean | null;
}

/**
 * The pure decision over a contract's units.
 *
 * A contract carries ONE VAT flag but may span several units. It is taxable if
 * ANY unit is taxable (taxable usage and a landlord who is not known to be
 * unregistered): VAT on the whole rent is the safe direction — under-charging is
 * a liability, over-charging is visible and gets corrected — and a contract
 * mixing a taxable shop with an exempt flat should be split anyway.
 */
export function decideRentVat(units: UnitVatFacts[], requested: boolean): RentVatVerdict {
  const anyTaxableUsage = units.some((u) => u.usageTaxable === true);
  const anyUndecidedUsage = units.some((u) => u.usageTaxable === null);
  const usage: RentVatVerdict["usage"] = anyTaxableUsage ? "taxable" : anyUndecidedUsage ? "undecided" : "residential";
  const known = units.filter((u) => u.landlordRegistered !== null);
  const landlordVatRegistered = known.length === 0 ? null : known.some((u) => u.landlordRegistered === true);
  const out = (vatEnabled: boolean, locked: boolean, reason: RentVatReason): RentVatVerdict =>
    ({ vatEnabled, locked, reason, landlordVatRegistered, usage });

  if (units.length === 0) return out(requested, false, "undecided");
  // Units whose landlord may charge VAT (registered, or unknown).
  const eligible = units.filter((u) => u.landlordRegistered !== false);
  if (eligible.some((u) => u.usageTaxable === true)) return out(true, true, "taxable_usage");
  if (eligible.some((u) => u.usageTaxable === null)) return out(requested, false, "undecided");
  if (eligible.length === 0) return out(false, true, "landlord_not_registered");
  // Every eligible unit is residential; a taxable unit (if any) belongs to an unregistered landlord.
  return out(false, true, anyTaxableUsage ? "landlord_not_registered" : "residential");
}

type Db = { select: (...a: any[]) => any };

/**
 * The verdict for a set of units, read from the database. `scope` (the account
 * id) restricts the units to the caller's own; units outside it are ignored.
 * No resolvable unit → `undecided` with the caller's choice.
 */
export async function rentVatForUnits(db: Db, unitIds: number[], requested: boolean, scope?: number): Promise<RentVatVerdict> {
  const ids = [...new Set(unitIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return decideRentVat([], requested);
  const conds = [inArray(unitsTable.id, ids)];
  if (scope != null) conds.push(eq(propertiesTable.userId, scope), isNull(unitsTable.deletedAt), isNull(propertiesTable.deletedAt));
  const rows: Array<{ propertyUsageId: number | null; unitUsageId: number | null; ownerId: number | null; taxNumber: string | null }> = await db
    .select({
      propertyUsageId: propertiesTable.usageLookupId,
      unitUsageId: unitsTable.usageLookupId,
      ownerId: ownersTable.id,
      taxNumber: ownersTable.taxNumber,
    })
    .from(unitsTable)
    .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
    .leftJoin(ownersTable, and(eq(ownersTable.id, propertiesTable.ownerId), isNull(ownersTable.deletedAt)))
    .where(and(...conds));
  if (!rows.length) return decideRentVat([], requested);

  const lookupIds = [...new Set(rows.flatMap((r) => [r.propertyUsageId, r.unitUsageId]).filter((v): v is number => v != null))];
  const keyById = new Map<number, string>();
  if (lookupIds.length) {
    const ks: Array<{ id: number; key: string }> = await db
      .select({ id: lookupsTable.id, key: lookupsTable.key })
      .from(lookupsTable)
      .where(inArray(lookupsTable.id, lookupIds));
    for (const k of ks) keyById.set(k.id, k.key);
  }
  const keyOf = (id: number | null) => (id != null ? keyById.get(id) ?? null : null);
  return decideRentVat(
    rows.map((r) => ({
      usageTaxable: rentVatFromUsage(keyOf(r.propertyUsageId), keyOf(r.unitUsageId)),
      landlordRegistered: r.ownerId == null ? null : isVatRegisteredNumber(r.taxNumber),
    })),
    requested,
  );
}

/** The unit ids a contract body names (`unitIds`, else the legacy single `unitId`). */
export function bodyUnitIds(body: any): number[] {
  const raw = Array.isArray(body?.unitIds) && body.unitIds.length > 0 ? body.unitIds : body?.unitId != null ? [body.unitId] : [];
  return raw.map((n: unknown) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0);
}

/** `?unitIds=1,2` (or repeated `unitIds`) → ids. */
export function parseUnitIdsQuery(q: unknown): number[] {
  const parts = Array.isArray(q) ? q.flatMap((x) => String(x).split(",")) : typeof q === "string" ? q.split(",") : [];
  return [...new Set(parts.map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n <= 2147483647))];
}
