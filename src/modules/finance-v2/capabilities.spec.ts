import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capabilities, isAccountHolder } from "./capabilities";

describe("fv2 capabilities (derived, DESIGN §10.1)", () => {
  const all = ["reports.view", "payments.view", "invoices.view", "invoices.write", "invoices.delete", "expenses.write", "expenses.approve", "payments.write"];
  it("account holder with a full preset gets everything", () => {
    assert.deepEqual(capabilities({ ownerUserId: null, ownerScopeId: null, role: "user", permissions: all }),
      ["view", "draft", "approve", "settings", "money", "expenses"]);
  });
  it("the account holder gets settings even without the three keys", () => {
    assert.ok(capabilities({ ownerUserId: null, ownerScopeId: null, role: "user", permissions: [] }).includes("settings"));
  });
  it("an employee needs the keys; view needs reports.view and payments or invoices view", () => {
    assert.deepEqual(capabilities({ ownerUserId: 7, role: "collector", permissions: ["reports.view", "payments.view", "payments.write"] }), ["view", "money"]);
    assert.deepEqual(capabilities({ ownerUserId: 7, role: "x", permissions: ["reports.view"] }), []);
  });
  it("owner-mobile tokens get nothing and are never the account holder", () => {
    assert.deepEqual(capabilities({ ownerUserId: null, ownerScopeId: 3, role: "owner", permissions: all }), []);
    assert.equal(isAccountHolder({ ownerUserId: null, ownerScopeId: 3, role: "owner" }), false);
    assert.equal(isAccountHolder({ ownerUserId: null, ownerScopeId: null, role: "owner" }), false);
  });
});
