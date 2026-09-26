import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildInstallments, feeLineTreatment } from "./installments";

describe("feeLineTreatment", () => {
  const fees = [
    { name: "رسوم خدمات", vatCategory: "E", exemptionReason: "VATEX-SA-30" },
    { name: "Export fee", vatCategory: "Z", exemptionReason: "VATEX-SA-33" },
    { name: "Pass-through", vatCategory: "O" },
    { name: "Wrong ground", vatCategory: "Z", exemptionReason: "VATEX-SA-30" },
    { name: "Legacy", vat: false },
  ];

  it("finds a nameless fee under the name its installments carry", () => {
    assert.deepEqual(feeLineTreatment([{ name: "", vatCategory: "O" }], "رسوم"), { vatCategory: "O", exemptionReason: "VATEX-SA-OOS" });
  });

  it("inherits the treatment the landlord chose for the fee, by name", () => {
    assert.deepEqual(feeLineTreatment(fees, " رسوم خدمات "), { vatCategory: "E", exemptionReason: "VATEX-SA-30" });
    assert.deepEqual(feeLineTreatment(fees, "Export fee"), { vatCategory: "Z", exemptionReason: "VATEX-SA-33" });
  });

  it("states OOS for an out-of-scope fee — the only code O has", () => {
    assert.deepEqual(feeLineTreatment(fees, "Pass-through"), { vatCategory: "O", exemptionReason: "VATEX-SA-OOS" });
  });

  it("carries an out-of-scope fee's own wording — and only an out-of-scope fee's", () => {
    const worded = [
      { name: "Deposit", vatCategory: "O", exemptionReasonText: "  Refundable security\ndeposit  " },
      { name: "Service", vatCategory: "E", exemptionReason: "VATEX-SA-30", exemptionReasonText: "my own words" },
    ];
    assert.deepEqual(feeLineTreatment(worded, "Deposit"), { vatCategory: "O", exemptionReason: "VATEX-SA-OOS", exemptionReasonText: "Refundable security deposit" });
    assert.deepEqual(feeLineTreatment(worded, "Service"), { vatCategory: "E", exemptionReason: "VATEX-SA-30" });
  });

  it("never guesses: a reason from another category, a legacy fee, or rent say nothing", () => {
    assert.deepEqual(feeLineTreatment(fees, "Wrong ground"), {});
    assert.deepEqual(feeLineTreatment(fees, "Legacy"), {});
    assert.deepEqual(feeLineTreatment(fees, null), {});
    assert.deepEqual(feeLineTreatment(null, "رسوم خدمات"), {});
  });
});

describe("appendFees — the treatment decides VAT, not the bare flag", () => {
  const fee = (over: Record<string, unknown>) => ({ id: "f", name: "رسوم خدمات", amount: "1000", recurrence: "one_time", dueDate: "", paymentMethod: "separate", ...over });
  const feeRow = (f: Record<string, unknown>) =>
    buildInstallments(1, 1, "2026-10-01", "2027-09-30", "0", "annual", [fee(f)] as any).find((r) => r.description === "رسوم خدمات")!;

  it("15% adds VAT", () => {
    const r = feeRow({ vat: true, vatCategory: "S" });
    assert.equal(r.amount, "1150.00"); assert.equal(r.vatEnabled, true);
  });
  it("exempt never adds VAT, even beside a stray vat:true", () => {
    const r = feeRow({ vat: true, vatCategory: "E", exemptionReason: "VATEX-SA-30" });
    assert.equal(r.amount, "1000.00"); assert.equal(r.vatEnabled, false);
  });
  it("a legacy fee with only the flag keeps its old behaviour", () => {
    assert.equal(feeRow({ vat: true }).amount, "1150.00");
    assert.equal(feeRow({ vat: false }).amount, "1000.00");
  });
});
