import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normaliseXTimeline, XApiProvider } from "./providers/x-api.provider";
import { normaliseTwitterApiIo, TwitterApiIoProvider } from "./providers/twitterapiio.provider";
import { NO_SOURCE_MISSING, readNewsConfig, readNewsFilter } from "./news.config";
import { ProviderError } from "./news.types";

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "__fixtures__", name), "utf8"));

function fakeFetch(routes: Array<[RegExp, number, unknown, Record<string, string>?]>): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    const hit = routes.find(([re]) => re.test(u));
    if (!hit) throw new Error(`unexpected fetch ${u}`);
    const [, status, body, headers] = hit;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...(headers ?? {}) } });
  }) as typeof fetch;
}

describe("X API v2 normalisation", () => {
  it("skips retweets and replies, expands t.co, strips media links, reads note_tweet", () => {
    const r = normaliseXTimeline(fixture("x-timeline.json"), "rega_ksa");
    assert.equal(r.skipped, 2);
    assert.deepEqual(r.tweets.map((t) => t.id), ["1838000000000000003", "1837000000000000000"]);
    const t = r.tweets[0];
    assert.equal(t.text, "الهيئة العامة للعقار تعلن تمديد إيقاف زيادة الإيجارات في الرياض لمدة 5 سنوات & التفاصيل https://rega.gov.sa/news/123");
    assert.equal(t.url, "https://x.com/REGA_KSA/status/1838000000000000003");
    assert.equal(t.authorHandle, "rega_ksa");
    assert.equal(t.authorAvatarUrl, "https://pbs.twimg.com/profile_images/1/a_400x400.jpg");
    assert.deepEqual(t.media, [{ type: "photo", url: "https://pbs.twimg.com/media/abc.jpg", preview_url: "https://pbs.twimg.com/media/abc.jpg" }]);
    assert.deepEqual(t.metrics, { likes: 300, retweets: 45, replies: 12, views: 25000 });
    assert.equal(t.postedAt, "2026-09-25T18:30:00.000Z");
    assert.equal(r.tweets[1].text, "Old post, but long form https://example.com/x");
  });

  it("applies sinceId, since and max", () => {
    const body = fixture("x-timeline.json");
    assert.equal(normaliseXTimeline(body, "rega_ksa", { sinceId: "1837000000000000000", max: 10 }).tweets.length, 1);
    assert.equal(normaliseXTimeline(body, "rega_ksa", { since: new Date("2026-09-24T00:00:00Z"), max: 10 }).tweets.length, 1);
    assert.equal(normaliseXTimeline(body, "rega_ksa", { max: 1 }).tweets.length, 1);
  });

  it("looks the user up, then fetches the timeline", async () => {
    const p = new XApiProvider("token", fakeFetch([
      [/users\/by\/username\/rega_ksa/, 200, { data: { id: "111", name: "REGA", profile_image_url: "https://p/x_normal.png" } }],
      [/users\/111\/tweets\?/, 200, fixture("x-timeline.json")],
    ]));
    const res = await p.fetchLatest("rega_ksa", { max: 20 });
    assert.equal(res.profile.userId, "111");
    assert.equal(res.tweets.length, 2);
  });

  it("maps 429 to rate_limit with retry-after, and a missing user to not_found", async () => {
    const limited = new XApiProvider("t", fakeFetch([[/tweets/, 429, { title: "Too Many Requests" }, { "retry-after": "900" }]]));
    await assert.rejects(limited.fetchLatest("x", { max: 5, userId: "1" }), (e: unknown) =>
      e instanceof ProviderError && e.kind === "rate_limit" && e.retryAfterSec === 900);
    const missing = new XApiProvider("t", fakeFetch([[/username/, 200, { errors: [{ title: "Not Found Error", detail: "Could not find user" }] }]]));
    await assert.rejects(missing.fetchLatest("nobody", { max: 5 }), (e: unknown) => e instanceof ProviderError && e.kind === "not_found");
  });
});

describe("twitterapi.io normalisation", () => {
  it("reads the data.tweets envelope, skips replies/retweets, stops at sinceId", () => {
    const r = normaliseTwitterApiIo(fixture("twitterapiio-last-tweets.json"), "ejar_sa", { sinceId: "1838100000000000002", max: 20 });
    assert.equal(r.skipped, 2);
    assert.equal(r.reachedEnd, true);
    assert.equal(r.tweets.length, 1);
    const t = r.tweets[0];
    assert.equal(t.text, "إيجار: إلزامية توثيق العقود التجارية اعتبارًا من 1 يناير https://ejar.sa/ar/news/1");
    assert.equal(t.url, "https://x.com/Ejar_sa/status/1838100000000000005");
    assert.equal(t.authorHandle, "ejar_sa");
    assert.equal(t.postedAt, "2026-09-25T16:00:30.000Z");
    assert.deepEqual(t.media, [{ type: "video", url: "https://video.twimg.com/high.mp4", preview_url: "https://pbs.twimg.com/thumb.jpg" }]);
    assert.deepEqual(t.metrics, { likes: 90, retweets: 11, replies: 2, views: 8000 });
    assert.equal(r.author?.userId, "555");
  });

  it("pages until it reaches the end", async () => {
    let calls = 0;
    const page1 = fixture("twitterapiio-last-tweets.json");
    const f = (async (url: string | URL) => {
      calls++;
      const body = String(url).includes("cursor=CURSOR2")
        ? { tweets: [{ id: "1838000000000000009", text: "page two post", createdAt: "Thu Sep 25 09:00:00 +0000 2026", author: { userName: "Ejar_sa", id: "555" } }], has_next_page: false, next_cursor: "" }
        : page1;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const res = await new TwitterApiIoProvider("k", f).fetchLatest("ejar_sa", { max: 20 });
    assert.equal(calls, 2);
    assert.deepEqual(res.tweets.map((t) => t.id), ["1838100000000000005", "1838100000000000001", "1838000000000000009"]);
  });

  it("maps 402 to quota and an error envelope to not_found", async () => {
    await assert.rejects(new TwitterApiIoProvider("k", fakeFetch([[/last_tweets/, 402, { message: "Credits exhausted" }]])).fetchLatest("a", { max: 5 }),
      (e: unknown) => e instanceof ProviderError && e.kind === "quota");
    await assert.rejects(new TwitterApiIoProvider("k", fakeFetch([[/last_tweets/, 200, { status: "error", message: "User not found" }]])).fetchLatest("a", { max: 5 }),
      (e: unknown) => e instanceof ProviderError && e.kind === "not_found");
  });
});

describe("readNewsConfig", () => {
  it("with no key and no RSS source, only the missing source blocks (keyword filter needs nothing)", () => {
    const c = readNewsConfig({});
    assert.equal(c.provider, null);
    assert.equal(c.filter, "keyword");
    assert.deepEqual(c.configured, { source: false, ai: true, missing: [NO_SOURCE_MISSING] });
  });
  it("picks the provider from whichever key is present", () => {
    const c = readNewsConfig({ TWITTERAPI_IO_KEY: "k", ANTHROPIC_API_KEY: "a" });
    assert.equal(c.provider, "twitterapiio");
    assert.equal(c.filter, "ai");
    assert.deepEqual(c.configured, { source: true, ai: true, missing: [] });
    assert.equal(c.model, "claude-sonnet-5");
  });
  it("an explicit provider without its key blocks only when there is no RSS source", () => {
    const env = { NEWS_SOURCE_PROVIDER: "x", TWITTERAPI_IO_KEY: "k", ANTHROPIC_API_KEY: "a", NEWS_AI_MODEL: "claude-sonnet-5" };
    const c = readNewsConfig(env);
    assert.equal(c.provider, null);
    assert.deepEqual(c.configured.missing, ["X_BEARER_TOKEN, or an enabled RSS source"]);
    const withRss = readNewsConfig(env, { rssEnabled: 2 });
    assert.deepEqual(withRss.configured, { source: true, ai: true, missing: [] });
    assert.deepEqual(withRss.warnings, ["X sources are skipped — X_BEARER_TOKEN"]);
  });
  it("RSS alone is a configured source", () => {
    const c = readNewsConfig({}, { rssEnabled: 1 });
    assert.equal(c.xConfigured, false);
    assert.deepEqual(c.configured, { source: true, ai: true, missing: [] });
    assert.deepEqual(c.warnings, []);
  });
});

describe("NEWS_FILTER mode selection", () => {
  const rss = { rssEnabled: 1 };
  it("auto = Claude when ANTHROPIC_API_KEY is set, else keyword", () => {
    assert.equal(readNewsConfig({}, rss).filter, "keyword");
    assert.equal(readNewsConfig({ ANTHROPIC_API_KEY: "a" }, rss).filter, "ai");
    assert.equal(readNewsConfig({ NEWS_FILTER: "auto", ANTHROPIC_API_KEY: " " }, rss).filter, "keyword");
    assert.equal(readNewsConfig({ NEWS_FILTER: " AUTO " }, rss).filterSetting, "auto");
  });
  it("keyword is forced even with a key", () => {
    const c = readNewsConfig({ NEWS_FILTER: "keyword", ANTHROPIC_API_KEY: "a" }, rss);
    assert.equal(c.filter, "keyword");
    assert.equal(c.configured.ai, true);
  });
  it("ai without a key blocks the run", () => {
    const c = readNewsConfig({ NEWS_FILTER: "ai" }, rss);
    assert.equal(c.filter, "ai");
    assert.deepEqual(c.configured, { source: true, ai: false, missing: ["ANTHROPIC_API_KEY"] });
  });
  it("an unknown value falls back to auto with a warning", () => {
    const c = readNewsConfig({ NEWS_FILTER: "claude", ANTHROPIC_API_KEY: "a" }, rss);
    assert.equal(c.filterSetting, "auto");
    assert.equal(c.filter, "ai");
    assert.ok(c.warnings.some((w) => w.includes("NEWS_FILTER")));
    assert.equal(readNewsFilter("nope"), null);
  });
});
