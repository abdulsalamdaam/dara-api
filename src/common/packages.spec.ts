import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planAllowedForUserType, planRequiredUserType, PACKAGES, UNLIMITED, listPrice, parseCycle, purchasableCycle, planPriceTable, ejarLookupQuota } from "./packages";

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
  it("prices from the yearly list: six months +10%, three months +20% (annualised)", () => {
    const table = { tenant: [1000, 550, 300], basic: [4200, 2310, 1260], professional: [5400, 2970, 1620] } as const;
    for (const [plan, [y, h, q]] of Object.entries(table)) {
      assert.equal(listPrice(plan, "yearly"), y, plan);
      assert.equal(listPrice(plan, "semiannual"), h, plan);
      assert.equal(listPrice(plan, "quarterly"), q, plan);
    }
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

describe("purchasable cycles and quotas", () => {
  it("moves a monthly choice up to quarterly, keeps the others", () => {
    assert.equal(purchasableCycle("monthly"), "quarterly");
    assert.equal(purchasableCycle(undefined), "quarterly");
    assert.equal(purchasableCycle("quarterly"), "quarterly");
    assert.equal(purchasableCycle("semiannual"), "semiannual");
    assert.equal(purchasableCycle("yearly"), "yearly");
  });
  it("prorates the yearly Ejar lookup quota to the paid period", () => {
    assert.equal(ejarLookupQuota("tenant", "yearly"), 30);
    assert.equal(ejarLookupQuota("basic", "yearly"), 90);
    assert.equal(ejarLookupQuota("basic", "quarterly"), 22);
    assert.equal(ejarLookupQuota("basic", "semiannual"), 45);
    assert.equal(ejarLookupQuota("professional", "yearly"), 150);
    assert.equal(ejarLookupQuota("professional", "quarterly"), 37);
    assert.equal(ejarLookupQuota("enterprise", "quarterly"), null);
  });
  it("gives every plan unlimited units and properties", () => {
    for (const def of Object.values(PACKAGES)) {
      assert.equal(def.maxUnits, UNLIMITED, def.key);
      assert.equal(def.maxProperties, UNLIMITED, def.key);
    }
  });
});
