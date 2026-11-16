import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cycleListPrice, extraAccountListPrice, extraAccountYearlyPrice, memberPriceOverride } from "./linked-accounts";
import { listPrice } from "./packages";

describe("linked accounts — shared package pricing", () => {
  it("defaults an extra account to half the plan's yearly price", () => {
    assert.equal(extraAccountYearlyPrice({ extraAccountPriceYearly: null }, "professional"), 2700);
    assert.equal(extraAccountYearlyPrice({ extraAccountPriceYearly: null }, "basic"), 2100);
  });

  it("uses the admin's special price when set", () => {
    assert.equal(extraAccountYearlyPrice({ extraAccountPriceYearly: "1500.00" }, "professional"), 1500);
    assert.equal(extraAccountYearlyPrice({ extraAccountPriceYearly: "0.00" }, "professional"), 0);
  });

  it("prices a cycle with the same formula as the plan (uplift, months)", () => {
    // professional yearly 5400 → quarterly list = 5400 × 1.2 × 3/12 = 1620; half of it = 810.
    assert.equal(listPrice("professional", "quarterly"), 1620);
    assert.equal(extraAccountListPrice({ extraAccountPriceYearly: null }, "professional", "quarterly"), 810);
    assert.equal(extraAccountListPrice({ extraAccountPriceYearly: "1200" }, "professional", "yearly"), 1200);
    assert.equal(extraAccountListPrice({ extraAccountPriceYearly: "1200" }, "professional", "semiannual"), 660);
  });

  it("is on request when the plan is (enterprise) and no special price is set", () => {
    assert.equal(extraAccountListPrice({ extraAccountPriceYearly: null }, "enterprise", "yearly"), null);
    assert.equal(extraAccountListPrice({ extraAccountPriceYearly: "3000" }, "enterprise", "yearly"), 3000);
  });

  it("reads a per-account special price, ignoring missing or junk entries", () => {
    const g = { memberPrices: { "74": 1500, "75": 0, "76": "x" as unknown as number } };
    assert.equal(memberPriceOverride(g, 74), 1500);
    assert.equal(memberPriceOverride(g, 75), 0);
    assert.equal(memberPriceOverride(g, 76), null);
    assert.equal(memberPriceOverride(g, 99), null);
    assert.equal(memberPriceOverride({ memberPrices: {} }, 74), null);
  });

  it("prices a per-account yearly price on any cycle like the plan", () => {
    assert.equal(cycleListPrice(1500, "yearly"), 1500);
    assert.equal(cycleListPrice(1200, "semiannual"), 660);
    assert.equal(cycleListPrice(5400, "quarterly"), 1620);
  });
});
