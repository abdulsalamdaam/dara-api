import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyUnitIds, decideRentVat, isVatRegisteredNumber, parseUnitIdsQuery, type UnitVatFacts } from "./landlord-vat";

/** R1 (Oct 2026): rent VAT = taxable usage AND a VAT-registered landlord. Pure: no DB. */
const u = (usageTaxable: boolean | null, landlordRegistered: boolean | null): UnitVatFacts => ({ usageTaxable, landlordRegistered });

describe("rent VAT — usage × landlord registration (R1)", () => {
  it("single unit: the full matrix", () => {
    const cases: Array<[boolean | null, boolean | null, boolean, boolean, string]> = [
      // usageTaxable, landlordRegistered, requested → vatEnabled, locked, reason
      [true, true, false, true, "taxable_usage"],
      [true, false, true, false, "landlord_not_registered"],
      [true, null, false, true, "taxable_usage"], // no landlord linked: usage alone, as before R1
      [false, true, true, false, "residential"],
      [false, false, true, false, "residential"], // exempt by usage is the reason shown, whatever the registration
      [false, null, true, false, "residential"],
      [null, true, true, true, "undecided"],
      [null, false, true, false, "landlord_not_registered"],
      [null, null, false, false, "undecided"],
    ];
    for (const [usage, reg, requested, vat, reason] of cases) {
      const v = decideRentVat([u(usage, reg)], requested);
      assert.equal(v.vatEnabled, vat, `usage=${usage} reg=${reg}`);
      assert.equal(v.reason, reason, `usage=${usage} reg=${reg}`);
      assert.equal(v.locked, reason !== "undecided", `usage=${usage} reg=${reg}`);
      assert.equal(v.landlordVatRegistered, reg);
    }
  });

  it("the client's choice is honoured only when usage is undecided", () => {
    assert.equal(decideRentVat([u(null, true)], true).vatEnabled, true);
    assert.equal(decideRentVat([u(null, true)], false).vatEnabled, false);
    assert.equal(decideRentVat([u(true, false)], true).vatEnabled, false, "a client-sent true never puts VAT on an unregistered landlord's rent");
    assert.equal(decideRentVat([u(false, true)], true).vatEnabled, false, "residential stays exempt");
  });

  it("multi-unit: taxable if ANY unit is taxable (with a landlord that may charge VAT)", () => {
    const shopAndFlat = decideRentVat([u(false, true), u(true, true)], false);
    assert.deepEqual([shopAndFlat.vatEnabled, shopAndFlat.reason, shopAndFlat.usage], [true, "taxable_usage", "taxable"]);
    const allResidential = decideRentVat([u(false, true), u(false, true)], true);
    assert.deepEqual([allResidential.vatEnabled, allResidential.reason, allResidential.usage], [false, "residential", "residential"]);
    const taxableButUnregistered = decideRentVat([u(false, true), u(true, false)], true);
    assert.deepEqual([taxableButUnregistered.vatEnabled, taxableButUnregistered.reason], [false, "landlord_not_registered"]);
    assert.equal(decideRentVat([u(true, false), u(true, true)], false).vatEnabled, true, "any registered taxable unit decides");
  });

  it("no unit resolved: undecided, the caller's choice", () => {
    assert.deepEqual(decideRentVat([], true), { vatEnabled: true, locked: false, reason: "undecided", landlordVatRegistered: null, usage: "residential" });
  });

  it("registration = a non-empty owners.tax_number", () => {
    assert.equal(isVatRegisteredNumber("300000000000003"), true);
    assert.equal(isVatRegisteredNumber("  "), false);
    assert.equal(isVatRegisteredNumber(null), false);
    assert.equal(isVatRegisteredNumber(""), false);
    assert.equal(isVatRegisteredNumber("12345"), true, "a malformed claim still counts (readiness gate agrees)");
  });

  it("unit ids from a body and from ?unitIds=", () => {
    assert.deepEqual(bodyUnitIds({ unitIds: [3, "4", "x"] }), [3, 4]);
    assert.deepEqual(bodyUnitIds({ unitId: 9 }), [9]);
    assert.deepEqual(bodyUnitIds({}), []);
    assert.deepEqual(parseUnitIdsQuery("1,2, 2,abc,-1"), [1, 2]);
    assert.deepEqual(parseUnitIdsQuery(["5", "6,7"]), [5, 6, 7]);
    assert.deepEqual(parseUnitIdsQuery(undefined), []);
  });
});
