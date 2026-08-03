import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rentVatFromUsage, isResidentialUsage } from "./usage-vat";

/**
 * The rule these lock in: residential rent is exempt, everything else is
 * taxable. The "some_future_usage" case is the important one — a usage added
 * to the lookups table later must default to TAXABLE, because under-charging
 * VAT is a liability while over-charging is visible and gets corrected.
 */
describe("rentVatFromUsage", () => {
  it("exempts every residential usage", () => {
    for (const k of ["families", "individuals", "group_housing", "residential_investment"]) {
      assert.equal(rentVatFromUsage(k, null), false, k);
      assert.equal(isResidentialUsage(k), true, k);
    }
  });

  it("taxes every non-residential usage", () => {
    for (const k of ["commercial", "industrial", "agricultural"]) {
      assert.equal(rentVatFromUsage(k, null), true, k);
    }
  });

  it("defaults an unknown/future usage to taxable", () => {
    assert.equal(rentVatFromUsage("some_future_usage", null), true);
  });

  it("leaves mixed-use undecided when the unit has no usage of its own", () => {
    assert.equal(rentVatFromUsage("mixed", null), null);
  });

  it("resolves mixed-use from the unit's usage", () => {
    assert.equal(rentVatFromUsage("mixed", "commercial"), true);
    assert.equal(rentVatFromUsage("mixed", "families"), false);
  });

  it("is undecided when no usage is set", () => {
    assert.equal(rentVatFromUsage(null, null), null);
    assert.equal(rentVatFromUsage(undefined, undefined), null);
  });

  it("ignores a unit usage when the property is not mixed-use", () => {
    // A unit only carries its own usage on a mixed-use property; if stale data
    // has one elsewhere, the property still decides.
    assert.equal(rentVatFromUsage("individuals", "commercial"), false);
  });
});
