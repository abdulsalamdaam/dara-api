import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanTitle, clip, KeywordFilter, keywordVerdict, scoreKeywords, splitTitle } from "./news.keyword-filter";
import { compilePyRegex, compileTerm, normaliseForMatch } from "./news.text";
import { decideStatus } from "./news.ai";
import type { NormalisedTweet } from "./news.types";

/** lexicon.md §6 — real headlines (26 Sep 2026) + synthetic ads, scored by the reference kw.py. */
const EXAMPLES: Array<{ n: string; title: string; source: string | null; desc: string; score: number; category: string; tags: string[]; publish: boolean }> =
  JSON.parse(readFileSync(join(__dirname, "__fixtures__", "lexicon-examples.json"), "utf8"));

describe("Arabic / English normalisation", () => {
  it("strips tashkeel and tatweel, unifies alef / ta marbuta / ya / hamza seats", () => {
    assert.equal(normaliseForMatch("العَقَارِيَّة"), "العقاريه");
    assert.equal(normaliseForMatch("الإيـــجار"), "الايجار");
    assert.equal(normaliseForMatch("أإآٱ"), "اااا");
    assert.equal(normaliseForMatch("مستشفى المؤجر الجزائر"), "مستشفي الموجر الجزاير");
    assert.equal(normaliseForMatch("ڤيلا گراج"), "فيلا كراج");
  });
  it("converts Arabic-Indic digits, lowercases, keeps % and _, turns punctuation into spaces", () => {
    assert.equal(normaliseForMatch("٥٫٨٧ مليار — ۱۲٪"), "5 87 مليار 12");
    assert.equal(normaliseForMatch("REGA: Rent-Freeze (2.3%)"), "rega rent freeze 2 3%");
    assert.equal(normaliseForMatch("«منصة إيجار»، snake_case"), "منصه ايجار snake_case");
  });
});

describe("term matching", () => {
  const m = (term: string, text: string) => compileTerm(term).test(normaliseForMatch(text));
  it("matches whole words only", () => {
    assert.ok(m("ريت", "صندوق ريت الرياض"));
    assert.ok(!m("ريت", "بريطانيا"), "ريت inside بريطانيا");
    assert.ok(!m("rent", "parent company"));
    assert.ok(!m("us", "bonus"));
  });
  it("allows one Arabic proclitic on the first word, none in English", () => {
    assert.ok(m("ايجار*", "وبالإيجارات") === false, "two proclitics (و+بال) are not one");
    assert.ok(m("ايجار*", "بالإيجارات"));
    assert.ok(m("منصه ايجار", "عبر لمنصة إيجار"));
    assert.ok(m("الهيئه العامه للعقار", "والهيئة العامة للعقار"));
    assert.ok(!m("rent", "xrent"));
  });
  it("a trailing * matches any word suffix; phrases allow any spacing", () => {
    assert.ok(m("عقار*", "العقارية"));
    assert.ok(m("mortgage*", "Mortgages rise"));
    assert.ok(!m("mortgage", "mortgages"));
    assert.ok(m("real estate", "real   estate"));
  });
  it("Python \\b is made Unicode-aware for the block patterns", () => {
    const re = compilePyRegex(String.raw`(?:للبيع|للايجار|for sale|for rent)\b.*\b\d{3,}`);
    assert.ok(re.test(normaliseForMatch("فيلا للبيع السعر 2,500,000")));
    assert.ok(!re.test(normaliseForMatch("للبيعات 12")));
  });
});

describe("keyword scoring — lexicon.md §6 worked examples", () => {
  for (const e of EXAMPLES) {
    it(`#${e.n} ${e.title.slice(0, 60)} → ${e.score} ${e.category}`, () => {
      const k = scoreKeywords(e.title, e.desc, e.source);
      assert.equal(k.score, e.score, k.reason);
      assert.equal(k.category, e.category);
      assert.deepEqual(k.tags, e.tags);
      assert.equal(k.score >= 60, e.publish);
    });
  }

  it("is deterministic", () => {
    const e = EXAMPLES[0];
    assert.deepEqual(scoreKeywords(e.title, e.desc, e.source), scoreKeywords(e.title, e.desc, e.source));
  });

  it("the Google News suffix is stripped before scoring (Argaam's name says «السعودي»)", () => {
    const t = "14 مليار درهم تصرفات عقارات دبي في أسبوع - ارقام : اخبار ومعلومات سوق الأسهم السعودي - تاسي";
    assert.equal(scoreKeywords(t, "", "ارقام : اخبار ومعلومات سوق الأسهم السعودي - تاسي").score, 0);
    assert.ok(scoreKeywords(t, "", null).score > 0, "without the strip, «السعودي» reads as Saudi context");
    assert.equal(cleanTitle("عام / نائب أمير الشرقية يستقبل"), "نائب أمير الشرقية يستقبل");
  });

  it("reason lists matches, negatives and a foreign marker", () => {
    assert.match(scoreKeywords("ضريبة التصرفات العقارية في مصر.. كيف تستفيد من الإعفاءات المتاحة؟").reason,
      /^matched: ضريبه التصرفات العقاريه.*\| foreign: مصر$/);
    assert.match(scoreKeywords("هل تعلم أنه يمكنك توثيق عقدك عبر منصة إيجار؟").reason, /neg: هل تعلم/);
  });
});

describe("keywordVerdict / KeywordFilter", () => {
  const item = (over: Partial<NormalisedTweet>): NormalisedTweet => ({
    id: "x1", url: "https://example.com/a", text: "", lang: null, postedAt: null, authorHandle: "example.com",
    authorName: "Example", authorAvatarUrl: null, media: [], metrics: null, ...over,
  });

  it("an Arabic item gets an Arabic title + summary only, and publishes at min_score 60", () => {
    const body = "أعلنت الهيئة العامة للعقار اليوم عن تمديد العمل بقرار تثبيت الإيجارات في مدينة الرياض لمدة خمس سنوات إضافية، في خطوة تهدف إلى تحقيق التوازن في السوق العقاري وحماية المستأجرين من الزيادات المتتالية التي شهدتها الأحياء خلال الفترة الماضية. ".repeat(2);
    const v = keywordVerdict(item({ title: "عام / الهيئة العامة للعقار تمدد تثبيت الإيجارات في الرياض", summary: body }));
    assert.equal(v.titleAr, "الهيئة العامة للعقار تمدد تثبيت الإيجارات في الرياض");
    assert.equal(v.titleEn, "");
    assert.equal(v.summaryEn, "");
    assert.ok(v.summaryAr.length <= 220 && v.summaryAr.endsWith("…"));
    assert.equal(v.category, "rental");
    assert.ok(v.relevant && v.score >= 60);
    assert.match(v.reason, /^keyword \d+: matched: /);
    assert.equal(decideStatus(v, 60), "published");
  });

  it("an English item fills the English side; an ad is rejected", async () => {
    const f = new KeywordFilter();
    const out = await f.classify([
      item({ id: "a", title: "Saudi real estate transactions fall 15% to SAR 24.4B in August", summary: null }),
      item({ id: "b", title: "فيلا للبيع في حي النرجس بالرياض 3 أدوار السعر 2,500,000 للتواصل 0551234567", summary: null }),
    ]);
    const a = out.verdicts.get("a")!;
    assert.equal(a.titleEn, "Saudi real estate transactions fall 15% to SAR 24.4B in August");
    assert.equal(a.titleAr, "");
    assert.equal(a.category, "market");
    const b = out.verdicts.get("b")!;
    assert.equal(b.score, 0);
    assert.equal(decideStatus(b, 60), "rejected");
    assert.deepEqual(out.missing, []);
    assert.deepEqual(out.usage, { input: 0, output: 0 });
  });

  it("stored rows (no title field) split at the first blank line", () => {
    assert.deepEqual(splitTitle({ text: "Head line\n\nBody text", title: undefined, summary: undefined }), { title: "Head line", body: "Body text" });
    assert.deepEqual(splitTitle({ text: "Just one line" }), { title: "Just one line", body: "" });
  });

  it("clip cuts at a word and marks it", () => {
    assert.equal(clip("one two three four five six", 20), "one two three four…");
    assert.equal(clip("short", 12), "short");
  });
});
