import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isCustomerAccount, STAFF_ROLE_KEYS } from "./permissions";

/**
 * This predicate decides who appears in the admin portal's companies list and
 * — critically — its registrations list, which is the only place an account
 * gets approved. The old test was `roleKey === "user"`, which broke the moment
 * a company account's owner started holding the General Manager role: such a
 * signup would have been invisible to the admin and impossible to approve.
 */
describe("isCustomerAccount", () => {
  it("counts a company owner holding the General Manager role", () => {
    // The regression the old roleKey === "user" test would have caused.
    assert.equal(isCustomerAccount({ ownerUserId: null, roleKey: "general" }), true);
  });

  it("still counts a plain owner and a demo account", () => {
    assert.equal(isCustomerAccount({ ownerUserId: null, roleKey: "user" }), true);
    assert.equal(isCustomerAccount({ ownerUserId: null, roleKey: "demo" }), true);
  });

  it("excludes Dara's own staff", () => {
    for (const key of STAFF_ROLE_KEYS) {
      assert.equal(isCustomerAccount({ ownerUserId: null, roleKey: key }), false, key);
    }
  });

  it("excludes employees, whatever role they hold", () => {
    for (const key of ["general", "propertyManager", "accountant", "user"]) {
      assert.equal(isCustomerAccount({ ownerUserId: 42, roleKey: key }), false, key);
    }
  });

  it("counts an owner with no role row rather than dropping them", () => {
    // A missing/!unseeded role must not make an account vanish from the
    // admin's list — being unapprovable is worse than being miscategorised.
    assert.equal(isCustomerAccount({ ownerUserId: null, roleKey: null }), true);
    assert.equal(isCustomerAccount({ ownerUserId: null }), true);
  });
});
