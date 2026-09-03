/**
 * Dara's own identity as the SELLER on the invoices we issue for subscriptions.
 *
 * Everywhere else in this codebase the seller is the landlord and the details
 * come from `zatca_credentials` / `owners`. A subscription invoice runs the
 * other way round — we are the seller — and until now nothing in the API knew
 * who "we" are. These are the company's registration details, so they belong in
 * the environment rather than a literal: a change of address or a new CR should
 * not need a release.
 *
 * Defaults are the values on file today, so an unconfigured environment still
 * issues a correct document rather than one with blank statutory fields.
 */

const SITE_DOMAIN = process.env.SITE_DOMAIN || "dara-sa.net";

export interface DaraSellerIdentity {
  name: string;
  vatNumber: string | null;
  crn: string | null;
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
    name: process.env.DARA_SELLER_NAME || "شركة دام التقنية",
    vatNumber: process.env.DARA_SELLER_VAT || null,
    crn: process.env.DARA_SELLER_CRN || null,
    addressLines: addr.length ? addr : ["الرياض، المملكة العربية السعودية"],
    email: process.env.DARA_BILLING_EMAIL || process.env.SUPPORT_EMAIL || `hello@${SITE_DOMAIN}`,
    phone: process.env.DARA_SELLER_PHONE || null,
    website: process.env.SITE_URL?.replace(/^https?:\/\//, "") || SITE_DOMAIN,
  };
}
