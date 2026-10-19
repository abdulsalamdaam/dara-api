import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertDeedNumberFormat, assertDeedUpdateFormat, deedNumberFormatError, toLatinDigits } from "./deed-number";

describe("deed number format", () => {
  it("electronic deeds are exactly 12 digits; paper deeds only capped", () => {
    assert.equal(deedNumberFormatError("123456789012", "electronic"), null);
    assert.ok(deedNumberFormatError("12345678", "electronic"));
    assert.equal(deedNumberFormatError("12345678", "paper"), null);
    assert.equal(deedNumberFormatError("1".repeat(30), "paper"), null); // no length rule for paper deeds
    assert.ok(deedNumberFormatError("12a45678", "paper"));
    assert.throws(() => assertDeedNumberFormat("123", null)); // null type = electronic
  });

  it("normalises Arabic-Indic and Persian digits", () => {
    assert.equal(toLatinDigits("١٢٣٤٥٦٧٨٩٠١٢"), "123456789012");
    assert.equal(toLatinDigits("۱۲۳"), "123");
  });
});

describe("assertDeedUpdateFormat", () => {
  const paper8 = { deedNumber: "12345678", deedType: "paper" };

  it("refuses a type-only change that leaves an invalid pair", () => {
    assert.throws(() => assertDeedUpdateFormat(paper8, { deedType: "electronic" }));
  });

  it("refuses a number-only change that is invalid for the current type", () => {
    assert.throws(() => assertDeedUpdateFormat({ deedNumber: "123456789012", deedType: "electronic" }, { deedNumber: "1234" }));
  });

  it("accepts a valid resulting pair", () => {
    assert.doesNotThrow(() => assertDeedUpdateFormat(paper8, { deedType: "electronic", deedNumber: "123456789012" }));
    assert.doesNotThrow(() => assertDeedUpdateFormat({ deedNumber: "123456789012", deedType: "electronic" }, { deedType: "paper" }));
  });

  it("leaves a legacy row editable when neither number nor type changes", () => {
    const legacy = { deedNumber: "12-34/ab", deedType: "electronic" };
    assert.doesNotThrow(() => assertDeedUpdateFormat(legacy, {}));
    assert.doesNotThrow(() => assertDeedUpdateFormat(legacy, { deedNumber: "12-34/ab", deedType: "electronic" }));
    assert.doesNotThrow(() => assertDeedUpdateFormat({ deedNumber: "5", deedType: null }, { deedType: "electronic" }));
  });
});
