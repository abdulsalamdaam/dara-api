import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scopedIdNumber, assertScopeSafeParams, resolveEjarScope, NO_CR_MESSAGE } from "./ejar.scope";

/** Minimal stand-in for the drizzle chain resolveEjarScope walks. */
const dbReturning = (row: any) => ({
  select: () => ({ from: () => ({ leftJoin: () => ({ where: async () => (row ? [row] : []) }) }) }),
});

describe("resolveEjarScope", () => {
  it("locks a tenant-package account to its own CR", async () => {
    const scope = await resolveEjarScope(dbReturning({ packagePlan: "tenant", commercialReg: "7030955236" }), 1);
    assert.deepEqual(scope, { locked: true, idNumber: "7030955236" });
  });

  it("leaves landlord packages unscoped", async () => {
    for (const plan of ["basic", "professional", "enterprise", "advanced"]) {
      const scope = await resolveEjarScope(dbReturning({ packagePlan: plan, commercialReg: "7030955236" }), 1);
      assert.equal(scope.locked, false, plan);
    }
  });

  it("fails closed when a tenant account has no CR on file", async () => {
    // The dangerous alternative is degrading to an unscoped search.
    for (const cr of [null, "", "   "]) {
      await assert.rejects(
        () => resolveEjarScope(dbReturning({ packagePlan: "tenant", commercialReg: cr }), 1),
        (e: any) => String(e.message ?? e.response?.message).includes(NO_CR_MESSAGE.slice(0, 20)),
      );
    }
  });
});

describe("scopedIdNumber", () => {
  it("ignores whatever the client asked for when locked", () => {
    const scope = { locked: true, idNumber: "7030955236" };
    assert.equal(scopedIdNumber(scope, "1051133120"), "7030955236");
    assert.equal(scopedIdNumber(scope, undefined), "7030955236");
    assert.equal(scopedIdNumber(scope, ""), "7030955236");
  });

  it("passes the client's value through when unlocked", () => {
    const scope = { locked: false, idNumber: null };
    assert.equal(scopedIdNumber(scope, "1051133120"), "1051133120");
    assert.equal(scopedIdNumber(scope, "  1051133120  "), "1051133120");
    assert.equal(scopedIdNumber(scope, ""), undefined);
  });
});

describe("assertScopeSafeParams", () => {
  it("blocks the flag that disables Ejar's own id filter", () => {
    // Verified against UAT: with this flag and no id filter, GetRentalContracts
    // returns the entire 12,460-contract dataset.
    const scope = { locked: true, idNumber: "7030955236" };
    for (const v of ["true", "false", true, ""]) {
      assert.throws(() => assertScopeSafeParams(scope, { skip_filter_id_number: v }));
    }
  });

  it("allows ordinary params", () => {
    const scope = { locked: true, idNumber: "7030955236" };
    assert.doesNotThrow(() => assertScopeSafeParams(scope, { "page[size]": 10, contract_number: "1096" }));
  });

  it("does not restrict unlocked accounts", () => {
    assert.doesNotThrow(() => assertScopeSafeParams({ locked: false, idNumber: null }, { skip_filter_id_number: "true" }));
  });
});
