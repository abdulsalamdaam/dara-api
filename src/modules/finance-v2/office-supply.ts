/**
 * The OFFICE's own supplies (commission to a landlord, the brokerage/agency fee
 * to a tenant) as ZATCA documents — the decision rules (VAT rules Oct 2026,
 * DARA-NOTES §4 "VAT decision rules"). Pure: no DB, no Nest, so the legacy
 * billing module, the v2 overrides and the specs can all use it.
 *
 * R2/R4 — VAT: the office's fee carries 15% iff the OFFICE is VAT-registered,
 *   whatever the property's usage and whatever the buyer's VAT status.
 * R3 — standard (clearance) vs simplified (reporting) follows the BUYER's
 *   nature: a business (owners/tenants `type = 'company'`) gets a STANDARD
 *   invoice even without a VAT number — identified instead by its CR
 *   (`PartyIdentification schemeID="CRN"`, or "700" for a unified number) with
 *   no buyer VAT — and an individual gets a simplified one. A VAT-registered
 *   individual (a sole trader) is still a taxable person, so a buyer VAT number
 *   also makes it standard.
 */

/** Marker the v2 transforms put on a document handed to the ZATCA path. Never persisted. */
export interface OfficeSupplyMarker {
  /** The buyer's party type as recorded (owners.type / tenants.type). */
  buyerType: string | null;
}

export type ZatcaProfile = "standard" | "simplified";

/** Party types that are a business (owners/tenants carry `company`; contract snapshots may say `establishment`). */
const BUSINESS_TYPES = new Set(["company", "establishment"]);

/** R3 for a party: business (company) or VAT-registered → standard; otherwise simplified. */
export function buyerProfileByType(buyerType: string | null | undefined, buyerVat: string | null | undefined): ZatcaProfile {
  if (BUSINESS_TYPES.has((buyerType ?? "").trim().toLowerCase())) return "standard";
  if ((buyerVat ?? "").toString().trim()) return "standard";
  return "simplified";
}

/**
 * The profile for a document the ZATCA path is about to build: R3 when the
 * document is an office supply (carries the marker), null otherwise (the
 * caller keeps its own rule).
 */
export function officeSupplyProfile(marker: OfficeSupplyMarker | null | undefined, buyer: { vat?: string | null } | null | undefined): ZatcaProfile | null {
  if (!marker) return null;
  return buyerProfileByType(marker.buyerType, buyer?.vat ?? null);
}

/**
 * R4: the brokerage (agency) fee document's VAT and approval routing, from the
 * office's state. One verdict, so the draft creation and the approve guard
 * cannot disagree.
 *  - not registered → O, no VAT, approvable, never sent to ZATCA;
 *  - registered, not linked → S 15%, HELD (approve refused, OFFICE_NOT_LINKED);
 *  - registered and linked → S 15%, approvable, reported to ZATCA under the office.
 */
export function agencyFeeRouting(office: { vatRegistered: boolean; zatcaLinked: boolean }): {
  carriesVat: boolean;
  approve: "ok" | "hold_not_linked";
  sendToZatca: boolean;
} {
  if (!office.vatRegistered) return { carriesVat: false, approve: "ok", sendToZatca: false };
  if (!office.zatcaLinked) return { carriesVat: true, approve: "hold_not_linked", sendToZatca: false };
  return { carriesVat: true, approve: "ok", sendToZatca: true };
}
