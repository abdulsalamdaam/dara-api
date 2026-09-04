/**
 * How Dara appears in the FOOTER of a subscription invoice.
 *
 * Everywhere else in this codebase the seller is the landlord and the details
 * come from `zatca_credentials` / `owners`. A subscription invoice runs the
 * other way round — we are the seller — and nothing in the API knew who "we"
 * are. Contact details change without a release, so they live in the
 * environment rather than in a literal.
 *
 * No registration numbers here on purpose: the document states none, for
 * either party. See the note at the top of `subscription-invoice-template.ts`.
 */

const SITE_DOMAIN = process.env.SITE_DOMAIN || "dara-sa.net";

export interface DaraSellerIdentity {
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
    addressLines: addr.length ? addr : ["الرياض، المملكة العربية السعودية"],
    email: process.env.DARA_BILLING_EMAIL || process.env.SUPPORT_EMAIL || `hello@${SITE_DOMAIN}`,
    phone: process.env.DARA_SELLER_PHONE || null,
    website: process.env.SITE_URL?.replace(/^https?:\/\//, "") || SITE_DOMAIN,
  };
}
