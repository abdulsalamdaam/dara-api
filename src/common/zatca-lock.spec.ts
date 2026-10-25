import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConflictException } from "@nestjs/common";
import { ACCOUNT_HOLDER_LOCKED_FIELDS, assertNotLocked, COMPANY_LOCKED_FIELDS, LANDLORD_LOCKED_FIELDS, lockedChanges, ownerLockedFields, VAT_LOCK_CODE } from "./zatca-lock";

describe("ZATCA-linked tax identity lock", () => {
  it("only a CHANGE of a sent locked field counts; identical (trimmed / blank≡null) or omitted passes", () => {
    const prior = { vatNumber: "300000000000003", commercialReg: "1010000000", taxNumber: null };
    assert.deepEqual(lockedChanges(prior, { name: "x" }, COMPANY_LOCKED_FIELDS), []);
    assert.deepEqual(lockedChanges(prior, { vatNumber: " 300000000000003 ", taxNumber: "" }, COMPANY_LOCKED_FIELDS), []);
    assert.deepEqual(lockedChanges(prior, { vatNumber: "311111111100003", commercialReg: "1010000000" }, COMPANY_LOCKED_FIELDS), ["vatNumber"]);
    assert.deepEqual(lockedChanges(prior, { vatNumber: null }, COMPANY_LOCKED_FIELDS), ["vatNumber"], "clearing is a change");
  });

  it("409 VAT_LOCKED_ZATCA_LINKED naming the fields", () => {
    assert.doesNotThrow(() => assertNotLocked([]));
    try {
      assertNotLocked(["taxNumber"]);
      assert.fail("expected a 409");
    } catch (e) {
      assert.ok(e instanceof ConflictException);
      const body = (e as ConflictException).getResponse() as any;
      assert.equal(body.code, VAT_LOCK_CODE);
      assert.deepEqual(body.fields, ["taxNumber"]);
      assert.match(body.message, /ZATCA/);
    }
  });

  it("which landlord fields are locked by which link", () => {
    const none = { account: false, owners: new Set<number>() };
    const account = { account: true, owners: new Set<number>() };
    const own = { account: false, owners: new Set<number>([7]) };
    assert.deepEqual(ownerLockedFields(none, { id: 7, isAccountHolder: true }), []);
    assert.deepEqual(ownerLockedFields(account, { id: 7, isAccountHolder: true }), ACCOUNT_HOLDER_LOCKED_FIELDS);
    assert.deepEqual(ownerLockedFields(account, { id: 8, isAccountHolder: false }), [], "the account's link does not lock a third-party landlord");
    assert.deepEqual(ownerLockedFields(own, { id: 7, isAccountHolder: false }), LANDLORD_LOCKED_FIELDS);
    assert.deepEqual(ownerLockedFields(own, { id: 7, isAccountHolder: true }), ACCOUNT_HOLDER_LOCKED_FIELDS);
  });
});
