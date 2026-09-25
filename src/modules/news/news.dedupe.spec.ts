import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  contentTokens, dedupeTweets, extractFigures, isNearDuplicate, normaliseForCompare, sameFigure, sameStory, storyKey, tokenSet,
} from "./news.dedupe";
import type { NormalisedTweet } from "./news.types";

function tw(id: string, text: string, postedAt: string, handle = "a"): NormalisedTweet {
  return {
    id, url: `https://x.com/${handle}/status/${id}`, text, lang: "ar", postedAt,
    authorHandle: handle, authorName: null, authorAvatarUrl: null, media: [],
    metrics: { likes: 0, retweets: 0, replies: 0, views: null },
  };
}

describe("normaliseForCompare", () => {
  it("folds Arabic letter forms, diacritics, digits, links and mentions", () => {
    assert.equal(
      normaliseForCompare("أعلنت الهيئةُ @rega_ksa عن ٥ سنوات https://t.co/x #الإيجار"),
      "اعلنت الهيئه عن 5 سنوات الايجار",
    );
  });
});

describe("isNearDuplicate", () => {
  it("never flags very short texts", () => {
    assert.equal(isNearDuplicate(tokenSet("عاجل الآن"), tokenSet("عاجل الآن")), false);
  });
});

describe("dedupeTweets", () => {
  const official = tw("1", "الهيئة العامة للعقار تعلن تمديد إيقاف زيادة الإيجارات في الرياض لمدة خمس سنوات للعقارات السكنية والتجارية", "2026-09-25T10:00:00Z", "rega_ksa");
  const repeat = tw("2", "عاجل: الهيئة العامة للعقار تعلن تمديد إيقاف زيادة الإيجارات في الرياض لمدة خمس سنوات للعقارات السكنية والتجارية https://t.co/a", "2026-09-25T11:00:00Z", "argaam");
  const other = tw("3", "البنك المركزي السعودي: التمويل العقاري السكني الجديد للأفراد يرتفع 12% خلال أغسطس", "2026-09-25T12:00:00Z", "sama");

  it("drops an id already stored and an id repeated in the batch", () => {
    const r = dedupeTweets([other, other, official], new Set(["1"]));
    assert.deepEqual(r.kept.map((t) => t.id), ["3"]);
    assert.equal(r.exactDuplicates.length, 2);
  });

  it("keeps the earliest of the same story from two accounts", () => {
    const r = dedupeTweets([repeat, other, official]);
    assert.deepEqual(r.kept.map((t) => t.id).sort(), ["1", "3"]);
    assert.equal(r.nearDuplicates.length, 1);
    assert.equal(r.nearDuplicates[0].tweet.id, "2");
    assert.equal(r.nearDuplicates[0].duplicateOf, "1");
  });

  it("drops a story already published recently", () => {
    const r = dedupeTweets([repeat], new Set(), [{ id: "900", text: official.text }]);
    assert.equal(r.kept.length, 0);
    assert.equal(r.nearDuplicates[0].duplicateOf, "900");
  });

  it("keeps distinct stories that share vocabulary", () => {
    const a = tw("10", "الهيئة العامة للعقار تطلق خدمة جديدة لتوثيق عقود الوساطة العقارية إلكترونيا", "2026-09-25T10:00:00Z");
    const b = tw("11", "الهيئة العامة للعقار تصدر مؤشر أسعار العقارات للربع الثاني ويرتفع 3.2%", "2026-09-25T11:00:00Z");
    assert.equal(dedupeTweets([a, b]).kept.length, 2);
  });
});

describe("story clustering — short headlines", () => {
  const gn = (id: string, title: string, host: string, postedAt: string): NormalisedTweet => ({
    id, url: `https://news.google.com/rss/articles/${id}`, text: title, title, summary: null, lang: "ar", postedAt,
    authorHandle: host, authorName: host, authorAvatarUrl: null, media: [], metrics: null,
  });
  // The REDF deposit as it arrived on 26 Sep 2026 (local e2e run), all via Google News.
  const redf = [
    gn("r1", "الصندوق العقاري السعودي يودع 1.098 مليار ريال لمستفيدي الدعم السكني خلال سبتمبر", "aqarnews.sa", "2026-09-24T08:00:00Z"),
    gn("r2", "\"الصندوق العقاري\" يُودع مليارًا و98 مليون ريال لمستفيدي برنامج الدعم السكني لشهر سبتمبر", "spa.gov.sa", "2026-09-24T09:00:00Z"),
    gn("r3", "الصندوق العقاري يودع 1.098 مليار ريال لدعم مستفيدي الإسكان لشهر سبتمبر", "alsaudi.news", "2026-09-24T07:00:00Z"),
    gn("r4", "1.1 مليار ريال من صندوق التنمية العقارية السعودي لدعم مستفيدي الإسكان لشهر سبتمبر", "aqarnews.sa", "2026-09-24T10:00:00Z"),
    gn("r5", "السعودية تودع 1.098 مليار ريال لمستفيدي الدعم السكني", "arabianbusiness.com", "2026-09-24T11:00:00Z"),
  ];

  it("reads figures: decimals, units, rounding, compound Arabic amounts, and ignores years and small counts", () => {
    const f = (t: string) => extractFigures(t).map((x) => x.value);
    assert.deepEqual(f("يودع 1.098 مليار ريال"), [1.098e9]);
    assert.deepEqual(f("يُودع مليارًا و98 مليون ريال"), [1.098e9]);
    assert.deepEqual(f("بدء التسجيل العيني لـ22,937 قطعة عقارية"), [22937]);
    assert.deepEqual(f("30.64 ألف قطعة في 4 مناطق عام 2026"), [30640]);
    assert.deepEqual(f("Saudi real estate transactions fall 15% to SAR 24.4B"), [15, 24.4]);
    assert.deepEqual(f("١٫٥ مليون وحدة"), [1.5e6]);
    assert.deepEqual(f("اليوم الوطني الـ96 ورؤية 2030 و1 مليار"), []);
    const [a] = extractFigures("1.1 مليار");
    const [b] = extractFigures("1.098 مليار");
    const [c] = extractFigures("1.2 مليار");
    assert.ok(sameFigure(a, b), "1.1 is 1.098 rounded");
    assert.ok(!sameFigure(c, b));
    assert.ok(sameFigure(extractFigures("22.9 ألف قطعة")[0], extractFigures("22,937 قطعة")[0]));
  });

  it("collapses the five REDF headlines into one, keeping the official source", () => {
    const r = dedupeTweets([...redf].reverse());
    assert.deepEqual(r.kept.map((t) => t.id), ["r2"], "SPA (.gov.sa) is canonical over earlier re-listings");
    assert.deepEqual(r.nearDuplicates.map((n) => n.duplicateOf), ["r2", "r2", "r2", "r2"]);
    for (const n of r.nearDuplicates) assert.ok(n.rule, n.tweet.id);
  });

  it("clusters transitively: a wording that only resembles a duplicate joins its story", () => {
    // As on 26 Sep: the canonical copy says «صندوق التنمية العقارية» (redf) and
    // «السعودية تودع … الدعم السكني» (sakani) shares nothing with it directly.
    const r4 = { ...redf[3], postedAt: "2026-09-24T06:00:00Z" }; // earliest → canonical
    const r = dedupeTweets([redf[4], redf[0], r4]);
    assert.deepEqual(r.kept.map((t) => t.id), ["r4"]);
    assert.deepEqual(r.nearDuplicates.map((n) => [n.tweet.id, n.duplicateOf]), [["r1", "r4"], ["r5", "r4"]]);
  });

  it("does NOT merge two stock-price pages that share only generic words", () => {
    const a = gn("s1", "سعر سهم شركة التطوير الزراعي بتبوك اليوم", "argaam.com", "2026-09-24T08:00:00Z");
    const b = gn("s2", "سعر سهم شركة الثروة السمكية السعودية اليوم", "argaam.com", "2026-09-24T09:00:00Z");
    assert.equal(dedupeTweets([a, b]).kept.length, 2);
  });

  it("matches against items stored in the last 72 h", () => {
    const r = dedupeTweets([redf[4]], new Set(), [{ id: "stored-1", text: `${redf[0].text}\n\nالتفاصيل…` }]);
    assert.equal(r.kept.length, 0);
    assert.equal(r.nearDuplicates[0].duplicateOf, "stored-1");
  });

  it("prefers a publisher's own feed over Google News, then the earliest", () => {
    const own = { ...gn("p1", "الصندوق العقاري يودع 1.098 مليار ريال لمستفيدي الدعم السكني", "alyaum.com", "2026-09-24T12:00:00Z"), url: "https://www.alyaum.com/a/1" };
    const r = dedupeTweets([redf[0], own]);
    assert.deepEqual(r.kept.map((t) => t.id), ["p1"]);
  });

  it("does NOT merge two stories that share only one figure", () => {
    const a = gn("n1", "ارتفاع الصفقات العقارية في الرياض 15% خلال الربع الثالث", "argaam.com", "2026-09-24T08:00:00Z");
    const b = gn("n2", "منصة إيجار: نمو عقود الإيجار التجارية 15% في المنطقة الشرقية", "okaz.com.sa", "2026-09-24T09:00:00Z");
    assert.equal(dedupeTweets([a, b]).kept.length, 2);
  });

  it("does NOT merge two stories that share only one entity", () => {
    const a = redf[0];
    const b = gn("n3", "الصندوق العقاري يطلق منتجا تمويليا جديدا للمتقاعدين بالشراكة مع البنوك", "maaal.com", "2026-09-24T09:00:00Z");
    const c = gn("n4", "الناهض: صندوق التنمية العقارية يواصل تطوير الحلول التمويلية وبناء الشراكات الاستراتيجية", "mubasher.info", "2026-09-24T10:00:00Z");
    assert.equal(dedupeTweets([a, b, c]).kept.length, 3);
  });

  it("does NOT merge the same template with a different figure (another month's deposit)", () => {
    const a = gn("m1", "الصندوق العقاري يودع 1.098 مليار ريال لمستفيدي الدعم السكني لشهر سبتمبر", "a.com", "2026-09-24T08:00:00Z");
    const b = gn("m2", "الصندوق العقاري يودع 1.25 مليار ريال لمستفيدي الدعم السكني لشهر أغسطس", "b.com", "2026-09-24T09:00:00Z");
    assert.equal(sameStory(storyKey("m1", a.text), storyKey("m2", b.text)), null);
    assert.equal(dedupeTweets([a, b]).kept.length, 2);
  });

  it("containment on content tokens catches a reworded story without figures", () => {
    const a = gn("c1", "هيئة العقار تطلق خدمة التحقق من الإعلانات العقارية عبر منصة إيجار", "spa.gov.sa", "2026-09-24T08:00:00Z");
    const b = gn("c2", "إطلاق خدمة التحقق من الإعلانات العقارية إلكترونيا", "sabq.org", "2026-09-24T09:00:00Z");
    assert.equal(sameStory(storyKey("c1", a.text), storyKey("c2", b.text)), "containment");
    assert.deepEqual(contentTokens("الصندوق العقاري يودع في سبتمبر"), new Set(["صندوق", "عقاري", "يودع"]));
  });
});
