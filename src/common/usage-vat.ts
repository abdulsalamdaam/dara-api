/**
 * Whether rent is subject to VAT, from the property/unit usage.
 *
 * Saudi rule: residential rent is exempt, everything else is taxable at 15%.
 * Deliberately expressed as a list of RESIDENTIAL usages, with taxable as the
 * fallback — so a usage added to the lookups table later defaults to taxable.
 * That is the safe direction: under-charging VAT is a liability, over-charging
 * is visible and gets corrected.
 *
 * Mirrors dara-web/src/lib/usage-vat.ts. Kept on the server as well so the
 * rule cannot be bypassed by a stale client, and so contracts created outside
 * the wizard (Ejar import) follow it too.
 */

/** `property_usage` lookup keys that are residential, hence VAT-exempt. */
export const RESIDENTIAL_USAGE_KEYS = [
  "families",
  "individuals",
  "group_housing",
  "residential_investment",
] as const;

export const MIXED_USAGE_KEY = "mixed";

export function isResidentialUsage(key: string | null | undefined): boolean {
  return !!key && (RESIDENTIAL_USAGE_KEYS as readonly string[]).includes(key);
}

/**
 * The rent-VAT verdict for a usage pair.
 *
 * `null` means "usage does not decide" — a mixed-use property whose unit has
 * no usage of its own, or a property with no usage set. The caller keeps
 * whatever the user chose in those cases.
 */
export function rentVatFromUsage(
  propertyUsageKey: string | null | undefined,
  unitUsageKey?: string | null,
): boolean | null {
  // A unit only carries its own usage when the property is mixed-use.
  const usage = propertyUsageKey === MIXED_USAGE_KEY && unitUsageKey ? unitUsageKey : propertyUsageKey;
  if (!usage) return null;
  if (usage === MIXED_USAGE_KEY) return null;
  return !isResidentialUsage(usage);
}
