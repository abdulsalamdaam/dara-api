import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planAllowedForUserType, planRequiredUserType, PACKAGES, listPrice, parseCycle, planPriceTable } from "./packages";

/**
 * The tenant plan is sold to corporate tenants only. The check has to fail
 * closed — an absent or unrecognised userType must NOT pass, or the
 * restriction could be skipped by simply omitting the field from the request.
 */
describe("planAllowedForUserType", () => {
  it("keeps the tenant plan closed to individuals", () => {
    assert.equal(planAllowedForUserType("tenant", "individual"), false);
    assert.equal(planAllowedForUserType("tenant", "company"), true);
  });

  it("fails closed on a missing or unrecognised account type", () => {
    for (const ut of [null, undefined, "", "organization", "nonsense"]) {
      assert.equal(planAllowedForUserType("tenant", ut), false, String(ut));
    }
  });

  it("leaves unrestricted plans open to both account types", () => {
    for (const plan of ["basic", "advanced", "professional", "enterprise"]) {
      assert.equal(planAllowedForUserType(plan, "individual"), true, plan);
      assert.equal(planAllowedForUserType(plan, "company"), true, plan);
      assert.equal(planRequiredUserType(plan), null, plan);
    }
  });

  it("resolves an unknown plan through the default, which is unrestricted", () => {
    assert.equal(planAllowedForUserType("no_such_plan", "individual"), true);
  });

  it("restricts exactly one plan today — a new one must be a deliberate change", () => {
    const restricted = Object.values(PACKAGES).filter(p => p.requiresUserType).map(p => p.key);
    assert.deepEqual(restricted, ["tenant"]);
  });
});

describe("billing cycles", () => {
  it("prices a quarter at 3 months less 5%, a year at 12 less 15%", () => {
    assert.equal(listPrice("basic", "monthly"), 250);
    assert.equal(listPrice("basic", "quarterly"), Math.round(250 * 0.95) * 3);
    assert.equal(listPrice("basic", "yearly"), Math.round(250 * 0.85) * 12);
    assert.equal(listPrice("enterprise", "quarterly"), null);
  });
  it("normalises unknown cycles to monthly", () => {
    assert.equal(parseCycle("quarterly"), "quarterly");
    assert.equal(parseCycle("weekly"), "monthly");
    assert.equal(parseCycle(null), "monthly");
  });
  it("lists every payable plan on all three cycles", () => {
    const { list } = planPriceTable();
    assert.deepEqual(Object.keys(list).sort(), ["basic", "professional", "tenant"]);
    assert.equal(list.professional?.quarterly, listPrice("professional", "quarterly"));
  });
});
