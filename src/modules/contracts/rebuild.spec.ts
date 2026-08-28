import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  rebuildBlockReason, isSubmittedToZatca, classifyContractDocs, factsDiff,
  ADVANCE_NOTE, RECEIPT_KIND, DEPOSIT_KIND,
  type ContractDocRow, type RebuildFacts, type ContractMoneyFacts,
} from "./rebuild";

/**
 * The eligibility gate decides whether a contract's schedule may be destroyed
 * and rebuilt. Every case here is a case where getting it wrong destroys money
 * or a document someone else is holding, so the gate is tested for what it
 * REFUSES rather than for what it allows.
 */

const doc = (over: Partial<ContractDocRow> = {}): ContractDocRow => ({
  id: 1, kind: null, status: "confirmed", total: "1000",
  notes: null, zatcaStatus: null, zatcaQr: null, zatcaInvoiceId: null, ...over,
});

const facts = (over: Partial<RebuildFacts> = {}): RebuildFacts => ({
  isDraft: false, status: "active", zatcaInvoiceCount: 0,
  docs: classifyContractDocs([]), foreignCollections: [],
  depositVoucherTotal: 0, nextDepositAmount: 0, wantsDraft: false, ...over,
});

describe("rebuild eligibility", () => {
  it("allows a plain active contract with nothing attached", () => {
    assert.equal(rebuildBlockReason(facts()), null);
  });

  it("refuses a draft — the ordinary save already does the whole job", () => {
    assert.equal(rebuildBlockReason(facts({ isDraft: true }))?.code, "draft");
  });

  it("refuses a terminated or cancelled contract", () => {
    for (const status of ["terminated", "cancelled"]) {
      assert.ok(rebuildBlockReason(facts({ status })), `${status} must refuse`);
    }
  });

  it("refuses when a ZATCA tax invoice exists, whatever its status", () => {
    assert.ok(rebuildBlockReason(facts({ zatcaInvoiceCount: 1 })));
  });

  it("refuses when a billing document reached ZATCA", () => {
    for (const zatcaStatus of ["cleared", "reported", "failed"]) {
      const docs = classifyContractDocs([doc({ zatcaStatus })]);
      assert.ok(rebuildBlockReason(facts({ docs })), `${zatcaStatus} must refuse`);
    }
  });

  it("treats a QR or a linked invoice id as submitted, even with no status", () => {
    // The status column is written best-effort, so it cannot be the only signal.
    assert.ok(isSubmittedToZatca(doc({ zatcaQr: "AQ..." })));
    assert.ok(isSubmittedToZatca(doc({ zatcaInvoiceId: 7 })));
    assert.ok(!isSubmittedToZatca(doc()));
  });

  it("does not treat a skipped or pending document as submitted", () => {
    // `skipped` is an exempt supply — residential rent — and never travelled.
    assert.ok(!isSubmittedToZatca(doc({ zatcaStatus: "skipped" })));
    assert.ok(!isSubmittedToZatca(doc({ zatcaStatus: "pending" })));
  });

  it("refuses when another live billing document points at the schedule", () => {
    const docs = classifyContractDocs([doc({ status: "confirmed" })]);
    assert.ok(rebuildBlockReason(facts({ docs })));
  });

  it("ignores a cancelled document — it holds nothing", () => {
    const docs = classifyContractDocs([doc({ status: "cancelled" })]);
    assert.equal(rebuildBlockReason(facts({ docs })), null);
  });

  it("lets the create path's own advance voucher through", () => {
    // The rebuild reissues this one itself; it must not block on it.
    const docs = classifyContractDocs([
      doc({ kind: RECEIPT_KIND, notes: ADVANCE_NOTE }),
    ]);
    assert.equal(rebuildBlockReason(facts({ docs })), null);
  });

  it("refuses a collection that is not the advance", () => {
    const f = facts({
      foreignCollections: [{ id: 9, amount: "500", notes: "دفعة" }],
    });
    assert.ok(rebuildBlockReason(f));
  });

  it("refuses when the deposit already receipted would move", () => {
    const docs = classifyContractDocs([doc({ kind: DEPOSIT_KIND, total: "5000" })]);
    const f = facts({ docs, depositVoucherTotal: 5000, nextDepositAmount: 7000 });
    assert.ok(rebuildBlockReason(f), "a moved deposit must refuse");
    const same = facts({ docs, depositVoucherTotal: 5000, nextDepositAmount: 5000 });
    assert.equal(rebuildBlockReason(same), null, "an unchanged deposit is fine");
  });

  it("refuses turning a live contract back into a draft", () => {
    assert.ok(rebuildBlockReason(facts({ wantsDraft: true })));
  });
});

describe("rebuild audit diff", () => {
  const base: ContractMoneyFacts = {
    rent: "5000", start: "2026-01-01", end: "2026-12-31", frequency: "monthly",
    vat: false, escalationType: "percent", escalationRate: "0", deposit: "0",
    prepaid: "0", agencyFee: "0", fees: [], units: [1, 2], rentTerms: [],
  };

  it("records only what actually moved", () => {
    const d = factsDiff(base, { ...base, rent: "6000" });
    assert.deepEqual(Object.keys(d), ["rent"]);
    assert.deepEqual(d.rent, { from: "5000", to: "6000" });
  });

  it("is empty when nothing moved", () => {
    assert.deepEqual(factsDiff(base, { ...base }), {});
  });

  it("notices a changed unit set", () => {
    const d = factsDiff(base, { ...base, units: [1, 3] });
    assert.ok("units" in d);
  });
});
