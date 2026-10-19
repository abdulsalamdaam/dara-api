import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { unitAreaViolates } from "./unit-area";

const base = { wasDraft: false, willBeDraft: false, areaSent: false, nextArea: null as unknown, isEjar: false };

describe("unitAreaViolates", () => {
  it("refuses draft → live with no area on the row", () => {
    assert.equal(unitAreaViolates({ ...base, wasDraft: true, nextArea: null }), true);
    assert.equal(unitAreaViolates({ ...base, wasDraft: true, nextArea: "0" }), true);
  });

  it("allows draft → live when the row (or the edit) has an area", () => {
    assert.equal(unitAreaViolates({ ...base, wasDraft: true, nextArea: "120" }), false);
    assert.equal(unitAreaViolates({ ...base, wasDraft: true, areaSent: true, nextArea: 90 }), false);
  });

  it("exempts an Ejar unit from the finalise check", () => {
    assert.equal(unitAreaViolates({ ...base, wasDraft: true, isEjar: true, nextArea: null }), false);
  });

  it("exempts drafts", () => {
    assert.equal(unitAreaViolates({ ...base, wasDraft: true, willBeDraft: true, areaSent: true, nextArea: null }), false);
  });

  it("refuses clearing a live unit's area but leaves an untouched legacy unit alone", () => {
    assert.equal(unitAreaViolates({ ...base, areaSent: true, nextArea: null }), true);
    assert.equal(unitAreaViolates({ ...base, nextArea: null }), false);
  });
});
