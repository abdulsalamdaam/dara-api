import { ConflictException } from "@nestjs/common";

/**
 * The two document kinds only Finance v2 issues (DESIGN §9 E8, E9): the
 * non-tax rent receipt and the brokerage (agency) fee. Neither is a ZATCA
 * document in the beta. EX-4 keeps them away from ZATCA and from the legacy
 * tax-invoice approve path in EVERY flag state (a no-op for accounts that
 * never had v2, because these kinds do not exist there). Pure: no DB, no DI,
 * so the legacy files can call it even when no finance-v2 provider is wired.
 */
export const V2_DOC_KINDS = ["rent_receipt", "agency_fee"] as const;
export type V2DocKind = (typeof V2_DOC_KINDS)[number];

export function isV2DocKind(kind: unknown): kind is V2DocKind {
  return typeof kind === "string" && (V2_DOC_KINDS as readonly string[]).includes(kind.trim());
}

/** EX-4 (1): the ZATCA submission outcome for a v2 kind — skipped, never submitted. */
export const V2_KIND_ZATCA_SKIP = {
  submitted: false as const,
  code: "skipped" as const,
  reason: "Finance v2 rent receipts and agency-fee invoices are not sent to ZATCA",
};

/** EX-4 (2): the legacy approve refuses a v2 kind (reached only when the flag is off, e.g. after a flip-back). */
export function refuseV2KindOnLegacyApprove(kind: unknown): void {
  if (!isV2DocKind(kind)) return;
  throw new ConflictException({
    error: "FINANCE_V2_KIND_REQUIRES_V2",
    message: "هذا المستند من المالية v2 ولا يُعتمد إلا عند تفعيلها · This Finance v2 document can only be approved while Finance v2 is on",
  });
}
