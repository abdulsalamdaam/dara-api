import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isZatcaAccepted, ZATCA_ACCEPTED_STATUSES, type InvoiceStatus } from "./zatca-acceptance";

/**
 * One predicate answers three questions that used to be answered separately and
 * wrongly: whether to advance the seller's ICV/PIH chain, whether an existing
 * `invoices` row blocks a retry, and whether a row holds its ICV slot. These
 * cases are the ones that cost real money or a real customer.
 */
describe("isZatcaAccepted — the chain-advance decision", () => {
  it("advances for a cleared standard invoice", () => {
    // Clearance is ZATCA stamping and returning the document: it exists, it is
    // the seller's last filed invoice, and the next one chains onto it.
    assert.equal(isZatcaAccepted("cleared"), true);
  });

  it("advances for a reported simplified invoice", () => {
    assert.equal(isZatcaAccepted("reported"), true);
  });

  it("advances for a 2xx with no verdict", () => {
    // ZATCA's COMPLIANCE endpoint answers "validated, not asked to clear" —
    // which `deriveStatus` reads as `submitted`, and which is the ONLY terminal
    // status a sandbox or simulation seller can reach, because every
    // non-production submission goes to that endpoint. Excluding it would pin
    // their counter and make the very next invoice collide on its own ICV,
    // after it had been signed and sent.
    assert.equal(isZatcaAccepted("submitted"), true);
  });

  it("does NOT advance for a document ZATCA rejected", () => {
    // The defect this whole rule exists for. The chain used to advance after
    // every completed HTTP call "regardless of ZATCA acceptance", so a refused
    // invoice moved a live landlord's `prod_pih` onto a document ZATCA had
    // never authenticated — and his next invoice would have chained onto
    // something that does not exist. The row had to be corrected by hand.
    assert.equal(isZatcaAccepted("rejected"), false);
  });

  it("does NOT advance when we do not know what happened", () => {
    // A transport failure or a 4xx with nothing readable. Treating "unknown" as
    // "accepted" is the expensive direction: it breaks the chain for every
    // later invoice, whereas treating it as "not accepted" costs at most one
    // retry of a document ZATCA may already hold.
    assert.equal(isZatcaAccepted("error"), false);
  });

  it("does NOT advance for a document that was never sent", () => {
    assert.equal(isZatcaAccepted("draft"), false);
  });

  it("refuses anything that is not one of the six statuses", () => {
    // The predicate is fed `invoices.status` from the database and, on the
    // retry path, a value read back out of a row. An unrecognised string must
    // never read as "ZATCA has it" — that is the direction that files nothing
    // and reports success.
    for (const v of ["CLEARED", "Reported", "accepted", "ok", "", null, undefined, 1 as any]) {
      assert.equal(isZatcaAccepted(v as any), false, String(v));
    }
  });
});

/**
 * `POST /simple-invoices/:id/submit-zatca` short-circuits with "already filed
 * with ZATCA" when it finds an `invoices` row for the document. It used to do
 * that on the row's mere EXISTENCE, so the one landlord whose invoice ZATCA
 * refused was told it had worked, and the button that exists to retry a failed
 * submission refused to — on the grounds that it had failed.
 */
describe("isZatcaAccepted — which rows may block a retry", () => {
  const blocksRetry = (status: InvoiceStatus) => isZatcaAccepted(status);

  it("blocks a retry only for a document ZATCA holds", () => {
    assert.equal(blocksRetry("cleared"), true);
    assert.equal(blocksRetry("reported"), true);
    assert.equal(blocksRetry("submitted"), true);
  });

  it("lets a rejected document be tried again", () => {
    assert.equal(blocksRetry("rejected"), false);
  });

  it("lets a document that never arrived be tried again", () => {
    assert.equal(blocksRetry("error"), false);
  });
});

describe("ZATCA_ACCEPTED_STATUSES", () => {
  it("is the exact set the SQL predicates are written from", () => {
    // `invoices_user_owner_env_icv_uniq` is scoped to these three statuses, in
    // `db/src/schema/invoices.ts`, `src/database/bootstrap.ts` and
    // `db/init.sql`. If this list changes and those do not, a rejected invoice
    // starts holding an ICV slot again and its retry collides on insert —
    // after signing and sending. Locking the list down is what makes the drift
    // visible here instead of there.
    assert.deepEqual([...ZATCA_ACCEPTED_STATUSES], ["cleared", "reported", "submitted"]);
  });
});
