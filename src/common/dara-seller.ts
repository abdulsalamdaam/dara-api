/**
 * How Dara appears in the FOOTER of a subscription invoice.
 *
 * Everywhere else in this codebase the seller is the landlord and the details
 * come from `zatca_credentials` / `owners`. A subscription invoice runs the
 * other way round — we are the seller — and nothing in the API knew who "we"
 * are. Contact details change without a release, so they live in the
 * environment rather than in a literal.
 *
 * The document PRINTS none of the registration details — see the note at the
 * top of `subscription-invoice-template.ts` — but the ZATCA Phase-1 QR encodes
 * the seller's name and VAT number, so both live here. Set `DARA_SELLER_VAT`
 * or no QR is produced.
 */

const SITE_DOMAIN = process.env.SITE_DOMAIN || "dara-sa.net";

export interface DaraSellerIdentity {
  /**
   * Legal name and VAT registration number. Neither is PRINTED — the document
   * carries no seller block — but both are mandatory inside the ZATCA Phase-1
   * QR (tags 1 and 2), which is the whole reason they are still here.
   *
   * `vatNumber` null means no QR is emitted at all. A QR that scans to an
   * empty VAT number is worse than no QR: it looks official and certifies
   * nothing.
   */
  name: string;
  vatNumber: string | null;
  addressLines: string[];
  email: string | null;
  phone: string | null;
  website: string | null;
}

/** VAT charged on a subscription. Standard KSA rate; overridable for a change. */
export const SUBSCRIPTION_VAT_RATE = Number(process.env.SUBSCRIPTION_VAT_RATE || 15);

export function daraSeller(): DaraSellerIdentity {
  const addr = [process.env.DARA_SELLER_ADDRESS_1, process.env.DARA_SELLER_ADDRESS_2]
    .map((v) => (v || "").trim())
    .filter(Boolean);
  return {
    name: process.env.DARA_SELLER_NAME || "دارا · Dara",
    vatNumber: process.env.DARA_SELLER_VAT || null,
    addressLines: addr.length ? addr : ["الرياض، المملكة العربية السعودية"],
    email: process.env.DARA_BILLING_EMAIL || process.env.SUPPORT_EMAIL || `hello@${SITE_DOMAIN}`,
    phone: process.env.DARA_SELLER_PHONE || null,
    website: process.env.SITE_URL?.replace(/^https?:\/\//, "") || SITE_DOMAIN,
  };
}
