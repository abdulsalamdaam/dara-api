import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { feeLineTreatment } from "./installments";

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

  it("never guesses: a reason from another category, a legacy fee, or rent say nothing", () => {
    assert.deepEqual(feeLineTreatment(fees, "Wrong ground"), {});
    assert.deepEqual(feeLineTreatment(fees, "Legacy"), {});
    assert.deepEqual(feeLineTreatment(fees, null), {});
    assert.deepEqual(feeLineTreatment(null, "رسوم خدمات"), {});
  });
});
