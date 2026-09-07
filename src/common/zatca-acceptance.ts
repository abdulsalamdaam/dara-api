/**
 * "Did ZATCA take this document into its records?"
 *
 * One question, asked in three places that must never disagree:
 *
 *   · `InvoiceService.issue` — whether to advance the seller's ICV/PIH chain;
 *   · `POST /simple-invoices/:id/submit-zatca` — whether an existing `invoices`
 *     row blocks a fresh attempt or is a superseded one;
 *   · `invoices_user_owner_env_icv_uniq` — whether a row holds its ICV slot
 *     (the SQL twin of this list, in `db/src/schema/invoices.ts` and
 *     `src/database/bootstrap.ts`; change one and change all three).
 *
 * The three used to answer it differently, and every one of the answers was
 * wrong in a different direction. See `ZATCA_ACCEPTED_STATUSES` for what is in
 * the set and, more importantly, why.
 */

/** Every value `invoices.status` can hold — mirrors `invoiceStatusEnum`. */
export type InvoiceStatus = "draft" | "submitted" | "cleared" | "reported" | "rejected" | "error";

/**
 * The statuses that mean ZATCA holds the document.
 *
 *   · `cleared`  — clearance returned CLEARED (standard / B2B).
 *   · `reported` — reporting returned REPORTED (simplified / B2C).
 *   · `submitted` — a 2xx with no clearance or reporting verdict. That is
 *     precisely what ZATCA's COMPLIANCE endpoint answers for a document it
 *     validated and was never asked to clear ("NOT_CLEARED, no errors"), and
 *     the compliance endpoint is where every sandbox and simulation submission
 *     goes — so it is the only terminal status those sellers can reach.
 *     Leaving it out would freeze their counter at its current value and make
 *     the very next invoice collide on its own ICV, after signing and sending.
 *     It travelled, ZATCA raised nothing against it, and it spent an ICV.
 *
 * Deliberately OUT of the set:
 *
 *   · `rejected` — ZATCA answered with validation errors. The document does not
 *     exist as far as ZATCA is concerned, so it neither occupies an ICV nor is
 *     a thing the next invoice may chain onto.
 *   · `error`    — a transport failure, or a 4xx with nothing to read. We do
 *     not know whether it arrived; treating "unknown" as "accepted" is the
 *     expensive direction, because it advances the chain past a document that
 *     may not be there and every later invoice inherits the break.
 *   · `draft`    — never sent.
 */
export const ZATCA_ACCEPTED_STATUSES = ["cleared", "reported", "submitted"] as const;

/** True when ZATCA accepted the document — see `ZATCA_ACCEPTED_STATUSES`. */
export function isZatcaAccepted(status: string | null | undefined): boolean {
  return typeof status === "string"
    && (ZATCA_ACCEPTED_STATUSES as readonly string[]).includes(status);
}

/**
 * The SQL fragment for the same rule, for the partial-index predicates. Kept
 * next to the list it is built from so the two cannot drift; the index DDL
 * itself lives in `bootstrap.ts` (existing clusters) and `db/init.sql` (fresh
 * ones).
 */
export const ZATCA_ACCEPTED_SQL_LIST = ZATCA_ACCEPTED_STATUSES.map((s) => `'${s}'`).join(", ");
