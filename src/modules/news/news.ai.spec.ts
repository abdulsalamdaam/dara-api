import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, decideStatus, parseAiOutput } from "./news.ai";

const inputs = [
  { id: "100", text: "الهيئة العامة للعقار تمدد إيقاف زيادة الإيجارات في الرياض 5 سنوات" },
  { id: "200", text: "عيد مبارك" },
  { id: "300", text: "Some third post that is fairly long and will be used as a title fallback when the model forgets to write one" },
];

function item(over: Record<string, unknown>) {
  return {
    id: "100", relevant: true, score: 92, category: "rental",
    title_ar: "تمديد إيقاف زيادة الإيجارات في الرياض 5 سنوات", title_en: "REGA extends Riyadh rent freeze by 5 years",
    summary_ar: "ملخص", summary_en: "Summary", tags: ["Rent-Freeze", "riyadh", "rent-freeze"], reason: "Changes rent rules.",
    ...over,
  };
}

describe("parseAiOutput", () => {
  it("parses a well-formed answer and normalises tags", () => {
    const out = parseAiOutput(JSON.stringify({ items: [item({}), item({ id: "200", relevant: false, score: 5, category: "other", title_ar: "", title_en: "", reason: "Greeting." }), item({ id: "300" })] }), inputs);
    assert.equal(out.verdicts.size, 3);
    assert.deepEqual(out.missing, []);
    const v = out.verdicts.get("100")!;
    assert.equal(v.category, "rental");
    assert.deepEqual(v.tags, ["rent-freeze", "riyadh"]);
    assert.equal(v.duplicateOf, null);
  });

  it("accepts a fenced JSON answer", () => {
    const out = parseAiOutput("```json\n" + JSON.stringify({ items: [item({})] }) + "\n```", inputs);
    assert.equal(out.verdicts.size, 1);
  });

  it("maps an unknown category to other, clamps and rounds the score", () => {
    const out = parseAiOutput(JSON.stringify({ items: [item({ category: "politics", score: 140.6 }), item({ id: "200", score: -3 })] }), inputs);
    assert.equal(out.verdicts.get("100")!.category, "other");
    assert.equal(out.verdicts.get("100")!.score, 100);
    assert.equal(out.verdicts.get("200")!.score, 0);
    assert.ok(out.problems.some((p) => p.includes("politics")));
  });

  it("reports ids with no verdict and ignores unknown ids", () => {
    const out = parseAiOutput(JSON.stringify({ items: [item({}), item({ id: "999" })] }), inputs);
    assert.deepEqual(out.missing.sort(), ["200", "300"]);
    assert.ok(out.problems.some((p) => p.includes("999")));
  });

  it("drops a malformed item but keeps the rest", () => {
    const out = parseAiOutput(JSON.stringify({ items: [item({ relevant: "yes" }), item({ id: "200" })] }), inputs);
    assert.equal(out.verdicts.size, 1);
    assert.ok(out.missing.includes("100"));
  });

  it("fills a missing title from the post text and flags it", () => {
    const out = parseAiOutput(JSON.stringify({ items: [item({ id: "300", title_ar: null, title_en: "" })] }), inputs);
    const v = out.verdicts.get("300")!;
    assert.equal(v.titleFallback, true);
    assert.equal(v.titleAr.length, 90);
    assert.equal(decideStatus(v, 60), "rejected");
  });

  it("recognises a duplicate verdict", () => {
    const out = parseAiOutput(JSON.stringify({ items: [item({ reason: "duplicate of 1838000000000000003." })] }), inputs);
    assert.equal(out.verdicts.get("100")!.duplicateOf, "1838000000000000003");
    assert.equal(decideStatus(out.verdicts.get("100")!, 60), "rejected");
  });

  it("throws on non-JSON or a missing items array", () => {
    assert.throws(() => parseAiOutput("Sorry, I cannot", inputs), /not JSON/);
    assert.throws(() => parseAiOutput(JSON.stringify({ results: [] }), inputs), /items/);
  });
});

describe("decideStatus", () => {
  const base = parseAiOutput(JSON.stringify({ items: [item({})] }), inputs).verdicts.get("100")!;
  it("publishes relevant items at or above min score", () => {
    assert.equal(decideStatus({ ...base, score: 60 }, 60), "published");
    assert.equal(decideStatus({ ...base, score: 59 }, 60), "rejected");
    assert.equal(decideStatus({ ...base, relevant: false }, 0), "rejected");
  });
});

describe("buildSystemPrompt", () => {
  it("appends extra instructions as a second block after the cached rubric", () => {
    const blocks = buildSystemPrompt("Treat Jeddah rent rules as ≥ 80");
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0].text.includes("SCORING"));
    assert.ok(blocks[0].cache_control);
    assert.ok(blocks[1].text.includes("Jeddah"));
    assert.equal(buildSystemPrompt("  ").length, 1);
  });
});
