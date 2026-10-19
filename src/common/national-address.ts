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
 * Tenant variant (business-owner note #7). The full address is required only
 * where ZATCA needs a buyer address — a company tenant or a VAT-registered one
 * (`taxNumber` set): their invoices are STANDARD (B2B). An individual without
 * VAT gets a simplified invoice that carries no buyer address, so the address
 * is optional there: empty or partial is accepted, but a postal code that is
 * given must still be 5 digits. Mirrors the web's `validateNationalAddress`
 * with `required: company || vatRegistered`. Landlords keep the full rule.
 */
export function assertTenantNationalAddress(body: any): void {
  if (body?.isDraft) return;
  const hasVat = body?.taxNumber != null && String(body.taxNumber).trim() !== "";
  if (body?.type === "company" || hasVat) {
    assertNationalAddress(body);
    return;
  }
  const pc = body?.postalCode == null ? "" : String(body.postalCode).trim();
  if (pc && !/^\d{5}$/.test(pc)) {
    throw new BadRequestException("الرمز البريدي يجب أن يكون 5 أرقام · Postal code must be 5 digits");
  }
}
