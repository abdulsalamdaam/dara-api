import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseItemPatch, parseSettingsPatch, parseSourceIds, parseSourcePatch } from "./news.validation";

describe("news body validation", () => {
  it("refuses an empty PATCH", () => {
    assert.throws(() => parseSettingsPatch({}), /nothing to update/);
    assert.throws(() => parseSettingsPatch({ unknownKey: 1 }), /nothing to update/);
    assert.throws(() => parseSourcePatch({}), /nothing to update/);
    assert.throws(() => parseItemPatch(null), /nothing to update/);
  });

  it("accepts camelCase and snake_case settings keys", () => {
    assert.deepEqual(parseSettingsPatch({ runTime: "06:30", min_score: "55", days_of_week: [5, 1] }), { runTime: "06:30", minScore: 55, daysOfWeek: [1, 5] });
  });

  it("validates each settings field", () => {
    assert.throws(() => parseSettingsPatch({ runTime: "6:30" }), /HH:MM/);
    assert.throws(() => parseSettingsPatch({ daysOfWeek: [] }), /at least one day/);
    assert.throws(() => parseSettingsPatch({ lookbackHours: 0 }), /1 to 168/);
    assert.throws(() => parseSettingsPatch({ minScore: 101 }), /0 to 100/);
    assert.throws(() => parseSettingsPatch({ enabled: "yes" }), /true or false/);
    assert.deepEqual(parseSettingsPatch({ extraInstructions: "  " }), { extraInstructions: null });
  });

  it("validates item moderation", () => {
    assert.deepEqual(parseItemPatch({ status: "hidden", pinned: true, ai_category: "market" }), { status: "hidden", pinned: true, aiCategory: "market" });
    assert.throws(() => parseItemPatch({ status: "deleted" }), /status/);
    assert.throws(() => parseItemPatch({ aiCategory: "sports" }), /aiCategory/);
  });

  it("validates run sourceIds", () => {
    assert.equal(parseSourceIds({}), undefined);
    assert.equal(parseSourceIds({ sourceIds: [] }), undefined);
    const id = "0b6f7a4e-9f8e-4c2a-8a55-1f2e3d4c5b6a";
    assert.deepEqual(parseSourceIds({ source_ids: [id, id] }), [id]);
    assert.throws(() => parseSourceIds({ sourceIds: ["1"] }), /account ids/);
  });
});
