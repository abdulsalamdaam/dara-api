/**
 * Who Dara is on a subscription invoice, and what kind of document that
 * invoice is allowed to call itself.
 *
 * Everywhere else in this codebase the seller is the landlord and the details
 * come from `zatca_credentials` / `owners`. A subscription invoice runs the
 * other way round — we are the seller — and nothing in the API knew who "we"
 * are. Registration details change without a release, so they live in the
 * environment rather than in a literal.
 */

const SITE_DOMAIN = process.env.SITE_DOMAIN || "dara-sa.net";

export interface DaraSellerIdentity {
  /**
   * Legal name and registration numbers.
   *
   * `vatNumber` is the switch the whole document hangs off — see
   * `isTaxInvoice()`. When it is set the document is a tax invoice and both
   * the printed seller block and the ZATCA Phase-1 QR (tags 1 and 2) carry
   * it. When it is null there is no tax invoice, no VAT line and no QR: a QR
   * that scans to an empty VAT number is worse than no QR, because it looks
   * official and certifies nothing.
   *
   * `crNumber` is the commercial registration. Optional even on a tax invoice
   * — it is printed when configured and simply absent otherwise.
   */
  name: string;
  vatNumber: string | null;
  crNumber: string | null;
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
    crNumber: process.env.DARA_SELLER_CRN || null,
    addressLines: addr.length ? addr : ["الرياض، المملكة العربية السعودية"],
    email: process.env.DARA_BILLING_EMAIL || process.env.SUPPORT_EMAIL || `hello@${SITE_DOMAIN}`,
    phone: process.env.DARA_SELLER_PHONE || null,
    website: process.env.SITE_URL?.replace(/^https?:\/\//, "") || SITE_DOMAIN,
  };
}

/* ── What the document is allowed to call itself ───────────────────────────
 *
 * THE RULE, IN ONE PLACE. A document is a tax invoice when — and only when —
 * a seller VAT registration number is configured. Everything downstream reads
 * this one predicate: the heading, the seller block, the VAT row and the QR.
 *
 * Why it is a rule and not a heading: a KSA tax invoice must identify a
 * VAT-REGISTERED seller and state that registration. A document headed
 * «فاتورة ضريبية» that charges 15% while naming no seller, no VAT number and
 * no CR is not a tax invoice — it is a receipt claiming to be one, emailed to
 * paying customers, and the claim is ours to answer for whether or not the
 * company is registered at all. So when we cannot back the claim we do not
 * make it: the heading drops to «فاتورة», the VAT line is omitted ENTIRELY
 * (not shown as 0% — we are not charging VAT at a rate of zero, we are not
 * charging VAT), and the total is simply the amount charged.
 *
 * Do not "restore" the heading. Set `DARA_SELLER_VAT` and the heading, the
 * seller block, the VAT line and the QR all come back together, which is the
 * only combination that is true. */

/** Whether the subscription document may be headed and priced as a TAX invoice. */
export function isTaxInvoice(seller: Pick<DaraSellerIdentity, "vatNumber">): boolean {
  return Boolean(seller.vatNumber && seller.vatNumber.trim());
}

/**
 * The Arabic heading for each mode, and the only place either word is written.
 * Takes the decision rather than the seller so the renderer — which never sees
 * the environment — cannot print a heading that disagrees with the document.
 */
export function subscriptionDocumentHeading(taxInvoice: boolean): string {
  return taxInvoice ? "فاتورة ضريبية" : "فاتورة";
}

/**
 * Whether the VAT line may state the rate as a percentage.
 *
 * The charged amount is VAT-inclusive, so the split is an extraction and the
 * printed figures do not always reproduce the configured rate. At the 1.00 SAR
 * test charge the split is 0.87 + 0.13, and 0.13 / 0.87 is 14.94% — printing
 * «(15%)» next to those two numbers gives an auditor a line they can disprove
 * with a calculator. So the percentage is printed only when the rate recovered
 * from the two amounts AS PRINTED (two decimals, which is the rounding the
 * document uses everywhere) is the rate we claim; otherwise the label appears
 * without a percentage and the amounts — which are exactly what was charged —
 * stand on their own.
 *
 * The tolerance is half of the last decimal place a reader would keep when
 * recomputing: 14.9998% rounds to 15.00% and prints, 14.9425% rounds to 14.94%
 * and does not.
 */
export function vatRateMatchesAmounts(subtotal: number, vatAmount: number, rate: number): boolean {
  if (!Number.isFinite(subtotal) || !Number.isFinite(vatAmount) || !Number.isFinite(rate)) return false;
  if (subtotal <= 0) return false;
  return Math.abs((vatAmount / subtotal) * 100 - rate) < 0.005;
}
