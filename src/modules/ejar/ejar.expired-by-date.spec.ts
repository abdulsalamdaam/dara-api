/** Ejar's "active" on a contract past its end date that does not auto-renew reads as expired. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { effectiveState } from "./ejar.lookup.map";
import { normalizeStatus } from "./ejar.map";

const TODAY = "2026-10-28";

describe("effectiveState", () => {
  it("past the end date, no auto-renewal → expired", () => {
    assert.equal(effectiveState("active", "2026-05-31", false, TODAY), "expired");
    assert.equal(normalizeStatus(effectiveState("active", "2026-05-31", false, TODAY)), "expired");
  });
  it("keeps Ejar's status while the contract runs, on its last day, or when it renews", () => {
    assert.equal(effectiveState("active", "2027-05-31", false, TODAY), "active");
    assert.equal(effectiveState("active", TODAY, false, TODAY), "active");
    assert.equal(effectiveState("active", "2026-05-31", true, TODAY), "active");
    assert.equal(effectiveState("active", "2026-05-31", null, TODAY), "active");
    assert.equal(effectiveState("active", null, false, TODAY), "active");
  });
  it("never rewrites a status that is already not active", () => {
    assert.equal(effectiveState("terminated", "2026-05-31", false, TODAY), "terminated");
    assert.equal(effectiveState("cancelled", "2026-05-31", false, TODAY), "cancelled");
  });
});
