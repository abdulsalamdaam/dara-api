import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { needsSecondApprover } from "./manual-journal-policy";

describe("needsSecondApprover (note 18)", () => {
  const on = { on: true, minHalalas: 100_000 };
  it("covers manual journals and the opening entry at or above the amount", () => {
    assert.equal(needsSecondApprover(on, "manual", 100_000), true);
    assert.equal(needsSecondApprover(on, "opening", 5_100_000), true);
  });
  it("leaves smaller entries, other kinds and the switch off alone", () => {
    assert.equal(needsSecondApprover(on, "opening", 99_999), false);
    assert.equal(needsSecondApprover(on, "system", 5_100_000), false);
    assert.equal(needsSecondApprover({ on: false, minHalalas: 0 }, "opening", 5_100_000), false);
  });
});
