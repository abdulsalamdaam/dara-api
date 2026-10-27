import { BadRequestException } from "@nestjs/common";

/**
 * Enforce the complete Saudi National Address on a FINALIZED tenant/landlord
 * record (a draft may be incomplete). Every field is mandatory — building
 * number, street, district, city, postal code and additional number — so the
 * data is ZATCA-ready when the record is later billed.
 *
 * Tenant & landlord payloads store the structured address across
 * `buildingNumber`, `nationalAddressStreet`, `nationalAddressDistrict`,
 * `nationalAddressCity`, `postalCode`, `additionalNumber`. Records created
 * outside the forms (bulk import, onboarding auto-seed) insert directly and
 * never reach this controller path.
 */
export function assertNationalAddress(body: any): void {
  if (body?.isDraft) return; // drafts may be incomplete
  const required: Array<[string, string]> = [
    ["buildingNumber", "رقم المبنى · building number"],
    ["nationalAddressStreet", "الشارع · street"],
    ["nationalAddressDistrict", "الحي · district"],
    ["nationalAddressCity", "المدينة · city"],
    ["postalCode", "الرمز البريدي · postal code"],
    ["additionalNumber", "الرقم الإضافي · additional number"],
  ];
  const missing = required.filter(([k]) => body?.[k] == null || String(body[k]).trim() === "").map(([, label]) => label);
  if (missing.length) {
    throw new BadRequestException(`العنوان الوطني غير مكتمل · National address is incomplete — missing: ${missing.join(", ")}`);
  }
  // Postal code must be 5 digits when provided.
  if (body.postalCode && !/^\d{5}$/.test(String(body.postalCode).trim())) {
    throw new BadRequestException("الرمز البريدي يجب أن يكون 5 أرقام · Postal code must be 5 digits");
  }
}

/**
 * The rule the landlord and tenant forms enforce (owner test note, Oct 2026:
 * "address based on VAT"). The full address is required only when the party
 * has a VAT number (`taxNumber`): that is what makes its invoices STANDARD
 * (B2B), and ZATCA needs a full buyer/seller address on those. Without a VAT
 * number the address is optional: empty or partial is accepted, but a postal
 * code that is given must still be 5 digits. Drafts are exempt.
 *
 * This only governs saving the record. Issuing an invoice is still gated by
 * `invoice-readiness.ts`, which asks for whatever that document needs (e.g. a
 * company buyer must carry a VAT number and a full address) at that point.
 * Mirrors the web's `validateNationalAddress` with `required: vatRegistered`.
 */
export function assertPartyNationalAddress(body: any): void {
  if (body?.isDraft) return;
  const hasVat = body?.taxNumber != null && String(body.taxNumber).trim() !== "";
  if (hasVat) {
    assertNationalAddress(body);
    return;
  }
  const pc = body?.postalCode == null ? "" : String(body.postalCode).trim();
  if (pc && !/^\d{5}$/.test(pc)) {
    throw new BadRequestException("الرمز البريدي يجب أن يكون 5 أرقام · Postal code must be 5 digits");
  }
}

/** The keys whose change on a finalized record re-runs `assertPartyNationalAddress`. */
export const PARTY_ADDRESS_KEYS = [
  "taxNumber", "buildingNumber", "nationalAddressStreet", "nationalAddressDistrict",
  "nationalAddressCity", "postalCode", "additionalNumber",
] as const;

/**
 * A PATCH to an already-finalized landlord/tenant that touches the VAT number
 * or the address is checked against the merged row — so adding a VAT number
 * to a record without an address (or clearing the address of a VAT-registered
 * one) is refused, while an unrelated edit (a phone change) on a legacy row is
 * not. Draft rows and draft→final transitions are handled by the callers.
 */
export function assertPartyNationalAddressOnPatch(prior: Record<string, any>, updateData: Record<string, unknown>): void {
  if (!PARTY_ADDRESS_KEYS.some((k) => k in updateData)) return;
  assertPartyNationalAddress({ ...prior, ...updateData, isDraft: false });
}
