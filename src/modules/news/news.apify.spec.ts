import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ApifyProvider, DEFAULT_APIFY_BUDGET_USD, DEFAULT_APIFY_MAX_ITEMS_PER_RUN, evaluateBudget, normaliseApify,
  readApifyBudget, readApifyMaxItems, snowflakeTime, targetSince,
} from "./providers/apify.provider";
import { buildProvider, readNewsConfig } from "./news.config";
import { ProviderError } from "./news.types";

/** Real rows from xquik~x-tweet-scraper (profileTweets), trimmed; one synthetic reply. */
const rows = () => JSON.parse(readFileSync(join(__dirname, "__fixtures__", "apify-xquik-profile-tweets.json"), "utf8"));
const TOKEN = "test-token-not-real";

type Call = { method: string; url: string; body: any; auth: string | null };

/** A fake Apify API: start → one poll → dataset → final run read; limits for the budget. */
function fakeApify(opts: { spent?: number; limit?: number; dataset?: any[]; status?: string[]; startStatus?: number } = {}) {
  const calls: Call[] = [];
  const statuses = [...(opts.status ?? ["RUNNING", "SUCCEEDED"])];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const h = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", url: u, body: init?.body ? JSON.parse(String(init.body)) : null, auth: h.get("authorization") });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/users/me/limits")) {
      return json(200, { data: {
        monthlyUsageCycle: { startAt: "2026-09-26T00:00:00.000Z", endAt: "2026-10-25T23:59:59.999Z" },
        limits: { maxMonthlyUsageUsd: opts.limit ?? 5 }, current: { monthlyUsageUsd: opts.spent ?? 0.01 },
      } });
    }
    if (/\/acts\/xquik~x-tweet-scraper\/runs\?/.test(u)) {
      if (opts.startStatus) return json(opts.startStatus, { error: { type: "auth", message: "bad token" } });
      return json(201, { data: { id: "run1", status: statuses.shift(), defaultDatasetId: "ds1" } });
    }
    if (/\/actor-runs\/run1\?waitForFinish/.test(u)) return json(200, { data: { id: "run1", status: statuses.shift() ?? "SUCCEEDED", defaultDatasetId: "ds1" } });
    if (/\/actor-runs\/run1$/.test(u)) return json(200, { data: { id: "run1", status: "SUCCEEDED", usageTotalUsd: 0.00063, chargedEventCounts: { "apify-default-dataset-item": 3 } } });
    if (/\/datasets\/ds1\/items/.test(u)) return json(200, opts.dataset ?? rows());
    throw new Error(`unexpected ${u}`);
  }) as typeof fetch;
  return { impl, calls };
}

describe("Apify normalisation (xquik rows)", () => {
  it("groups by handle, drops retweets / replies to others, expands t.co, keeps media", () => {
    const { groups } = normaliseApify(rows());
    assert.deepEqual([...groups.keys()].sort(), ["ejar_sa", "raga_ksa", "rega_ksa"]);
    const ejar = groups.get("ejar_sa")!;
    assert.deepEqual(ejar.tweets.map((t) => t.id), ["2102457992247390397", "2101654884990788058"]);
    assert.equal(ejar.skipped, 1); // the reply to another account
    assert.equal(groups.get("raga_ksa")!.tweets.length, 0);
    assert.equal(groups.get("raga_ksa")!.skipped, 1); // the retweet
    const rega = groups.get("rega_ksa")!;
    const t = rega.tweets.find((x) => x.id === "2101997268081484168")!;
    assert.match(t.text, /https:\/\/s\.rega\.gov\.sa\/xT5/);
    assert.doesNotMatch(t.text, /t\.co\//);
    assert.equal(t.authorHandle, "rega_ksa");
    assert.equal(t.url, "https://x.com/REGA_KSA/status/2101997268081484168");
    assert.equal(t.postedAt, "2026-09-21T11:29:36.000Z");
    assert.equal(t.lang, "ar");
    assert.match(t.authorAvatarUrl ?? "", /_400x400\./);
    assert.equal(rega.profile.userId, "959094521010294784");
    const withPhoto = ejar.tweets[0];
    assert.equal(withPhoto.media[0].type, "photo");
    assert.match(withPhoto.media[0].url ?? "", /^https:\/\/pbs\.twimg\.com\/media\//);
    assert.doesNotMatch(withPhoto.text, /https:\/\/t\.co\//); // the media t.co link is stripped
    assert.equal(typeof withPhoto.metrics?.views, "number");
  });

  it("ignores diagnostic / malformed rows", () => {
    const { groups, ignored } = normaliseApify([{ type: "diagnostic", message: "nothing found" }, { id: "x", author: { username: "a" } }]);
    assert.equal(groups.size, 0);
    assert.equal(ignored, 2);
  });
});

describe("Apify windows", () => {
  it("snowflake ids decode to their post time", () => {
    const d = snowflakeTime("2101997268081484168")!;
    assert.ok(Math.abs(d.getTime() - Date.parse("2026-09-21T11:29:36Z")) < 1000);
    assert.equal(snowflakeTime("nope"), null);
  });

  it("a target needs only what is newer than lookback, last seen post and last fetch − 1 h", () => {
    const lookback = new Date("2026-09-24T00:00:00Z");
    assert.equal(targetSince({ since: lookback, sinceId: null, lastFetchedAt: null })?.toISOString(), lookback.toISOString());
    assert.equal(targetSince({ since: lookback, sinceId: null, lastFetchedAt: new Date("2026-09-25T10:00:00Z") })?.toISOString(), "2026-09-25T09:00:00.000Z");
    assert.ok(targetSince({ since: lookback, sinceId: "2102457992247390397", lastFetchedAt: null })! > new Date("2026-09-22T17:59:00Z"));
  });
});

describe("Apify provider (fake API)", () => {
  it("one run for every handle; token only in the Authorization header; results mapped back per source", async () => {
    const f = fakeApify();
    const p = new ApifyProvider(TOKEN, { maxItemsPerRun: 300 }, f.impl, 5_000);
    const since = new Date("2026-09-19T00:00:00Z");
    const res = await p.fetchMany([
      { handle: "ejar_sa", since, sinceId: "2101654884990788058", lastFetchedAt: null },
      { handle: "REGA_KSA", since, sinceId: null, lastFetchedAt: null },
      { handle: "raga_ksa", since, sinceId: null, lastFetchedAt: null },
      { handle: "quiet_one", since, sinceId: null, lastFetchedAt: null },
    ], { maxPerTarget: 20, maxChargeUsd: 1.23 });

    const starts = f.calls.filter((c) => c.method === "POST" && /\/runs\?/.test(c.url));
    assert.equal(starts.length, 1);
    for (const c of f.calls) {
      assert.equal(c.auth, `Bearer ${TOKEN}`);
      assert.ok(!c.url.includes(TOKEN), "token must never be in a URL");
    }
    const input = starts[0].body;
    assert.equal(input.mode, "profileTweets");
    assert.deepEqual(input.twitterHandles, ["ejar_sa", "rega_ksa", "raga_ksa", "quiet_one"]);
    assert.equal(input.maxItemsPerTarget, 20);
    assert.equal(input.maxItems, 80);
    assert.deepEqual(input.tweetTypes, { excludeReplies: true, excludeRetweets: true });
    assert.equal(input.time.sinceTime, String(since.getTime() / 1000));
    assert.match(starts[0].url, /maxTotalChargeUsd=1\.2300/);

    // ejar_sa: only the post newer than its last seen id
    assert.deepEqual((res.results.get("ejar_sa") as any).tweets.map((t: any) => t.id), ["2102457992247390397"]);
    // rega_ksa: the 18 Sep post is older than the lookback and is trimmed
    assert.deepEqual((res.results.get("rega_ksa") as any).tweets.map((t: any) => t.id), ["2101997268081484168"]);
    assert.equal((res.results.get("raga_ksa") as any).tweets.length, 0);
    assert.deepEqual((res.results.get("quiet_one") as any).tweets, []);
    assert.deepEqual(res.run, { runId: "run1", status: "SUCCEEDED", costUsd: 0.00063, chargedItems: 3, items: 6 });
  });

  it("caps the run at NEWS_APIFY_MAX_ITEMS_PER_RUN", async () => {
    const f = fakeApify({ dataset: [] });
    const p = new ApifyProvider(TOKEN, { maxItemsPerRun: 30 }, f.impl, 5_000);
    const targets = Array.from({ length: 20 }, (_, i) => ({ handle: `acct${i}`, since: new Date(), sinceId: null }));
    await p.fetchMany(targets, { maxPerTarget: 20 });
    const start = f.calls.find((c) => c.method === "POST")!;
    assert.equal(start.body.maxItems, 30);
    assert.match(start.url, /maxItems=30/);
  });

  it("an auth failure is a ProviderError('auth')", async () => {
    const f = fakeApify({ startStatus: 401 });
    const p = new ApifyProvider(TOKEN, {}, f.impl, 5_000);
    await assert.rejects(p.fetchMany([{ handle: "a", since: null, sinceId: null }], { maxPerTarget: 5 }),
      (e: unknown) => e instanceof ProviderError && e.kind === "auth" && !e.message.includes(TOKEN));
  });

  it("the test endpoint path (fetchLatest) runs one handle, no window", async () => {
    const f = fakeApify();
    const p = new ApifyProvider(TOKEN, {}, f.impl, 5_000);
    const r = await p.fetchLatest("rega_ksa", { max: 5 });
    assert.equal(r.tweets.length, 2);
    const start = f.calls.find((c) => c.method === "POST")!;
    assert.deepEqual(start.body.twitterHandles, ["rega_ksa"]);
    assert.equal(start.body.time, undefined);
    assert.equal(start.body.maxItemsPerTarget, 5);
  });
});

describe("Apify budget guard", () => {
  it("evaluates spend against the budget, capped by Apify's own limit", () => {
    const u = (spent: number, limit: number | null = 5) => ({ spentUsd: spent, limitUsd: limit, cycleStartAt: null, cycleEndAt: null });
    assert.equal(evaluateBudget(4.5, u(1)).overBudget, false);
    assert.equal(evaluateBudget(4.5, u(1)).remainingUsd, 3.5);
    assert.equal(evaluateBudget(4.5, u(4.5)).overBudget, true);
    assert.equal(evaluateBudget(10, u(5)).overBudget, true); // Apify's $5 wins
    assert.equal(evaluateBudget(10, u(4.9)).effectiveBudgetUsd, 5);
    const unknown = evaluateBudget(4.5, null, "timeout");
    assert.equal(unknown.overBudget, false);
    assert.equal(unknown.remainingUsd, null);
  });

  it("reads usage from /users/me/limits; over budget, the test fetch refuses to spend (quota)", async () => {
    const f = fakeApify({ spent: 4.6 });
    const p = new ApifyProvider(TOKEN, { budgetUsd: 4.5 }, f.impl, 5_000);
    const b = await p.budget();
    assert.equal(b.overBudget, true);
    assert.equal(b.usage?.cycleEndAt, "2026-10-25T23:59:59.999Z");
    await assert.rejects(p.fetchLatest("rega_ksa", { max: 5 }), (e: unknown) => e instanceof ProviderError && e.kind === "quota" && /budget reached/.test(e.message));
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
  });

  it("env parsing", () => {
    assert.equal(readApifyBudget(undefined), DEFAULT_APIFY_BUDGET_USD);
    assert.equal(readApifyBudget("2"), 2);
    assert.equal(readApifyBudget("-1"), DEFAULT_APIFY_BUDGET_USD);
    assert.equal(readApifyBudget("abc"), DEFAULT_APIFY_BUDGET_USD);
    assert.equal(readApifyMaxItems(undefined), DEFAULT_APIFY_MAX_ITEMS_PER_RUN);
    assert.equal(readApifyMaxItems("50"), 50);
    assert.equal(readApifyMaxItems("0"), DEFAULT_APIFY_MAX_ITEMS_PER_RUN);
    assert.equal(readApifyMaxItems("999999"), 5000);
  });
});

describe("provider selection with Apify", () => {
  it("APIFY_TOKEN alone → apify", () => {
    const cfg = readNewsConfig({ APIFY_TOKEN: "t" } as any);
    assert.equal(cfg.provider, "apify");
    assert.equal(cfg.xConfigured, true);
    assert.equal(cfg.configured.source, true);
    assert.equal(buildProvider(cfg, { APIFY_TOKEN: "t" } as any)?.name, "apify");
    assert.equal(cfg.apify.budgetUsd, 4.5);
    assert.equal(cfg.apify.maxItemsPerRun, 300);
  });

  it("a paid X key set on purpose wins in auto; an explicit setting wins over everything", () => {
    assert.equal(readNewsConfig({ APIFY_TOKEN: "t", X_BEARER_TOKEN: "x" } as any).provider, "x");
    assert.equal(readNewsConfig({ APIFY_TOKEN: "t", TWITTERAPI_IO_KEY: "i" } as any).provider, "twitterapiio");
    assert.equal(readNewsConfig({ APIFY_TOKEN: "t", X_BEARER_TOKEN: "x", NEWS_SOURCE_PROVIDER: "apify" } as any).provider, "apify");
  });

  it("NEWS_SOURCE_PROVIDER=apify without the token: X skipped with a warning, RSS runs", () => {
    const cfg = readNewsConfig({ NEWS_SOURCE_PROVIDER: "apify" } as any, { rssEnabled: 3 });
    assert.equal(cfg.provider, null);
    assert.equal(cfg.configured.source, true);
    assert.deepEqual(cfg.warnings, ["X sources are skipped — APIFY_TOKEN"]);
  });

  it("the budget env reaches the config", () => {
    const cfg = readNewsConfig({ APIFY_TOKEN: "t", NEWS_APIFY_MONTHLY_BUDGET_USD: "1.5", NEWS_APIFY_MAX_ITEMS_PER_RUN: "100" } as any);
    assert.deepEqual(cfg.apify, { budgetUsd: 1.5, maxItemsPerRun: 100 });
  });
});
