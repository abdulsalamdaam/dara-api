import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planAllowedForUserType, planRequiredUserType, PACKAGES } from "./packages";

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
