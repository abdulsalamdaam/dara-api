import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedupeTweets, isNearDuplicate, normaliseForCompare, tokenSet } from "./news.dedupe";
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
