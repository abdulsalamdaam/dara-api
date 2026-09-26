import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalisedTweet } from "./news.types";

/**
 * Retention against a real Postgres: the seen-check in the insert path (RSS,
 * Apify and X), the cleaner's SQL, and stable pagination.
 *
 * Opt-in: set NEWS_TEST_DATABASE_URL to a THROWAWAY local database (it is
 * truncated). Refuses anything but localhost, so a production URL in .env can
 * never be hit by `pnpm test`.
 *
 *   NEWS_TEST_DATABASE_URL=postgres://localhost:55432/news_test pnpm test
 */
const URL_ = process.env.NEWS_TEST_DATABASE_URL ?? "";
const LOCAL = /^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_);
const skip = !URL_ ? "NEWS_TEST_DATABASE_URL not set" : !LOCAL ? "NEWS_TEST_DATABASE_URL must point at localhost" : false;

const MIGRATIONS = ["0061_re_news.sql", "0062_re_news_rss.sql", "0063_re_news_moderation.sql", "0064_re_news_retention.sql"];
const HOUR = 3_600_000;

describe("news retention (real Postgres)", { skip }, () => {
  let dbm: typeof import("@dara/database");
  let db: any;
  let Runner: typeof import("./news.runner.service").NewsRunnerService;
  let Cleaner: typeof import("./news.cleaner.service").NewsCleanerService;
  let lockMod: typeof import("./news.lock");
  const appLog = { record() {} } as any;

  before(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.NEWS_SCHEDULER_DISABLED = "1";
    dbm = await import("@dara/database");
    db = dbm.db;
    Runner = (await import("./news.runner.service")).NewsRunnerService;
    Cleaner = (await import("./news.cleaner.service")).NewsCleanerService;
    lockMod = await import("./news.lock");
    for (const f of MIGRATIONS) {
      await dbm.pool.query(readFileSync(join(__dirname, "../../../db/drizzle", f), "utf8"));
    }
    // Idempotent: a second pass changes nothing and does not throw.
    for (const f of MIGRATIONS) await dbm.pool.query(readFileSync(join(__dirname, "../../../db/drizzle", f), "utf8"));
  });

  after(async () => {
    await lockMod?.closeNewsLockPool();
    // getPool(), not the `pool` proxy: end() through the proxy never resolves.
    await dbm?.getPool().end();
  });

  beforeEach(async () => {
    await dbm.pool.query("truncate news_items, news_seen, news_job_runs, news_sources cascade");
    await dbm.pool.query(`update news_job_settings set lookback_hours = 168, min_score = 60, rejected_retention_hours = 24,
      purge_duplicates = true, hidden_retention_days = 14, runs_retention_days = 90, seen_retention_days = 30,
      last_cleanup_at = null, last_cleanup_stats = null where id = 1`);
  });

  // ── helpers ──────────────────────────────────────────────────────────
  function tweet(id: string, handle: string, text: string): NormalisedTweet {
    return {
      id, url: `https://x.com/${handle}/status/${id}`, text, lang: "ar", postedAt: new Date().toISOString(),
      authorHandle: handle, authorName: handle, authorAvatarUrl: null, media: [], metrics: null,
    };
  }

  /** A filter that rejects everything and records every id it was asked about. */
  function rejectingAi() {
    const judged: string[] = [];
    return {
      judged,
      classify: async (batch: NormalisedTweet[]) => {
        judged.push(...batch.map((t) => t.id));
        return {
          verdicts: new Map(batch.map((t) => [t.id, {
            relevant: false, score: 5, category: "other" as const, titleAr: "", titleEn: "t", summaryAr: "", summaryEn: "",
            tags: [], reason: "not real estate", duplicateOf: null, titleFallback: false,
          }])),
          missing: [], problems: [], usage: { input: 0, output: 0 },
        };
      },
    };
  }

  async function runOnce(runner: InstanceType<typeof Runner>): Promise<any> {
    let res: any;
    for (let i = 0; i < 100; i++) {
      res = await runner.startRun("manual", null);
      if (res.kind !== "busy") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(res.kind, "started", JSON.stringify(res));
    for (let i = 0; i < 400; i++) {
      const { rows } = await dbm.pool.query("select * from news_job_runs where id = $1", [res.runId]);
      if (rows[0].status !== "running") return rows[0];
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("run did not finish");
  }

  async function itemIds(): Promise<string[]> {
    const { rows } = await dbm.pool.query("select external_id from news_items order by external_id");
    return rows.map((r: any) => r.external_id);
  }

  /** The seen-check proof, for any provider: run → purge → run again. */
  async function provePurgedStaysGone(runner: InstanceType<typeof Runner>, ai: ReturnType<typeof rejectingAi>, expectedIds: string[]) {
    const r1 = await runOnce(runner);
    assert.deepEqual(await itemIds(), [...expectedIds].sort(), `first run stores them (log: ${JSON.stringify(r1.log)})`);
    assert.deepEqual([...ai.judged].sort(), [...expectedIds].sort(), "first run judges them");
    const { rows: st } = await dbm.pool.query("select distinct status from news_items");
    assert.deepEqual(st.map((r: any) => r.status), ["rejected"]);

    // Two days later the cleaner deletes them — and remembers them.
    await dbm.pool.query("update news_items set created_at = now() - interval '2 days'");
    const cleaner = new Cleaner(db, appLog);
    const res = await cleaner.cleanNow(false);
    assert.equal(res.kind, "done");
    assert.equal((res as any).deleted.rejected, expectedIds.length);
    assert.deepEqual(await itemIds(), []);
    const { rows: seen } = await dbm.pool.query("select external_id, verdict, purged_at from news_seen order by external_id");
    assert.deepEqual(seen.map((s: any) => [s.external_id, s.verdict]), [...expectedIds].sort().map((id) => [id, "rejected"]));
    assert.ok(seen.every((s: any) => s.purged_at));

    // The provider returns the same posts again (an overlapping window): not
    // stored, not judged, not counted as new or duplicate.
    await dbm.pool.query("update news_sources set last_seen_tweet_id = null, last_fetched_at = null, http_etag = null");
    ai.judged.length = 0;
    const r2 = await runOnce(runner);
    assert.deepEqual(await itemIds(), [], "a purged item is never re-inserted");
    assert.deepEqual(ai.judged, [], "a purged item is never re-judged");
    assert.equal(r2.new_items, 0);
    assert.equal(r2.duplicates, 0);
    assert.ok(r2.log.some((l: any) => /seen before and removed by the cleaner/.test(l.message)), JSON.stringify(r2.log));
    return r2;
  }

  // ── seen-check, per provider ─────────────────────────────────────────
  it("RSS: a purged rejected item is not re-inserted or re-judged", async () => {
    await dbm.pool.query("insert into news_sources (kind, feed_url, display_name) values ('rss', 'https://example.com/feed', 'Example')");
    const runner = new Runner(db, appLog, new Cleaner(db, appLog));
    const ai = rejectingAi();
    const items = [tweet("rss-a", "example.com", "مباراة كرة القدم اليوم"), tweet("rss-b", "example.com", "سعر الذهب يرتفع")];
    runner.rssOverride = {
      fetchFeed: async () => ({ notModified: false, etag: null, lastModified: null, title: "Example", siteUrl: null, items, skipped: 0 }),
    };
    runner.aiOverride = ai;
    await provePurgedStaysGone(runner, ai, ["rss-a", "rss-b"]);
  });

  it("X (per-account provider): a purged rejected item is not re-inserted or re-judged", async () => {
    await dbm.pool.query("insert into news_sources (kind, handle) values ('x', 'someone')");
    const runner = new Runner(db, appLog, new Cleaner(db, appLog));
    const ai = rejectingAi();
    runner.providerOverride = {
      name: "x",
      fetchLatest: async () => ({
        profile: { userId: "1", name: "Someone", avatarUrl: null },
        tweets: [tweet("1900000000000000001", "someone", "صباح الخير"), tweet("1900000000000000002", "someone", "مباراة اليوم")],
        skipped: 0,
      }),
    };
    runner.aiOverride = ai;
    await provePurgedStaysGone(runner, ai, ["1900000000000000001", "1900000000000000002"]);
  });

  it("Apify (batch provider, the real ApifyProvider on a fake API): a purged rejected item is not re-inserted or re-judged", async () => {
    const { ApifyProvider } = await import("./providers/apify.provider");
    const fixture = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "apify-xquik-profile-tweets.json"), "utf8"));
    // Fresh dates so the lookback keeps them.
    const now = new Date().toUTCString().replace("GMT", "+0000");
    const dataset = fixture.map((r: any) => ({ ...r, createdAt: now }));
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const fakeFetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/users/me/limits")) {
        return json(200, { data: { monthlyUsageCycle: { startAt: "2026-09-26T00:00:00.000Z", endAt: "2026-10-25T23:59:59.999Z" },
          limits: { maxMonthlyUsageUsd: 5 }, current: { monthlyUsageUsd: 0.01 } } });
      }
      if (/\/acts\/xquik~x-tweet-scraper\/runs\?/.test(u)) return json(201, { data: { id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1" } });
      if (/\/actor-runs\/run1\?waitForFinish/.test(u)) return json(200, { data: { id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1" } });
      if (/\/actor-runs\/run1$/.test(u)) return json(200, { data: { id: "run1", status: "SUCCEEDED", usageTotalUsd: 0.0006, chargedEventCounts: {} } });
      if (/\/datasets\/ds1\/items/.test(u)) return json(200, dataset);
      throw new Error(`unexpected ${u}`);
    }) as typeof fetch;
    await dbm.pool.query("insert into news_sources (kind, handle) values ('x', 'ejar_sa'), ('x', 'rega_ksa'), ('x', 'raga_ksa')");
    const runner = new Runner(db, appLog, new Cleaner(db, appLog));
    const ai = rejectingAi();
    runner.providerOverride = new ApifyProvider("test-token-not-real", { maxItemsPerRun: 300 }, fakeFetch, 5_000, 0);
    runner.aiOverride = ai;
    // Which ids the real normaliser keeps (retweets / replies dropped).
    const { normaliseApify } = await import("./providers/apify.provider");
    const ids = [...normaliseApify(dataset).groups.values()].flatMap((g) => g.tweets.map((t) => t.id));
    assert.ok(ids.length >= 3);
    await provePurgedStaysGone(runner, ai, ids);
  });

  // ── cleaner rules in SQL ─────────────────────────────────────────────
  it("deletes exactly the purgeable rows; dry run counts the same and writes nothing", async () => {
    const ins = async (ext: string, status: string, hoursOld: number, extra: Record<string, unknown> = {}) => {
      const cols = ["external_id", "text", "status", "created_at", ...Object.keys(extra)];
      const vals = [ext, "t", status, new Date(Date.now() - hoursOld * HOUR), ...Object.values(extra)];
      await dbm.pool.query(`insert into news_items (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})`, vals);
    };
    await ins("rej-old", "rejected", 25, { ai_relevant: false });
    await ins("rej-new", "rejected", 23, { ai_relevant: false });
    await ins("rej-moderated", "rejected", 100, { ai_relevant: false, moderated_at: new Date() });
    await ins("rej-pinned", "rejected", 100, { ai_relevant: false, pinned: true });
    await ins("pub-old", "published", 5000, { ai_relevant: true });
    await ins("dup-old", "hidden", 25, { ai_relevant: false, ai_reason: "duplicate of x" });
    await ins("held-10d", "hidden", 240, { ai_relevant: false, ai_reason: "held for admin review: …" });
    await ins("held-15d", "hidden", 360, { ai_relevant: false, ai_reason: "held for admin review: …" });
    await ins("gaveup-15d", "hidden", 360, { ai_relevant: null, ai_attempts: 3, ai_reason: "AI gave up after 3 attempts" });
    await ins("hidden-moderated", "hidden", 900, { ai_relevant: true, moderated_at: new Date() });
    await dbm.pool.query("insert into news_seen (external_id, first_seen_at, verdict, purged_at) values ('seen-old', now() - interval '40 days', 'rejected', now() - interval '31 days'), ('seen-new', now() - interval '40 days', 'rejected', now() - interval '2 days')");
    await dbm.pool.query("insert into news_job_runs (trigger, status, started_at) values ('manual', 'success', now() - interval '91 days'), ('manual', 'success', now() - interval '10 days'), ('manual', 'running', now() - interval '200 days')");

    const cleaner = new Cleaner(db, appLog);
    const dry = await cleaner.cleanNow(true);
    assert.equal(dry.kind, "done");
    const expected = { rejected: 1, duplicates: 1, hidden: 2, seen: 1, runs: 1 };
    assert.deepEqual((dry as any).deleted, expected);
    assert.equal((await dbm.pool.query("select count(*)::int n from news_items")).rows[0].n, 10, "dry run deletes nothing");
    assert.equal((await dbm.pool.query("select last_cleanup_at from news_job_settings")).rows[0].last_cleanup_at, null, "dry run writes nothing");

    const real = await cleaner.cleanNow(false);
    assert.deepEqual((real as any).deleted, expected);
    assert.deepEqual(await itemIds(), ["held-10d", "hidden-moderated", "pub-old", "rej-moderated", "rej-new", "rej-pinned"]);
    const { rows: seen } = await dbm.pool.query("select external_id, verdict from news_seen order by external_id");
    assert.deepEqual(seen.map((s: any) => `${s.external_id}:${s.verdict}`),
      ["dup-old:duplicate", "gaveup-15d:hidden", "held-15d:hidden", "rej-old:rejected", "seen-new:rejected"]);
    assert.equal((await dbm.pool.query("select count(*)::int n from news_job_runs")).rows[0].n, 2, "the running row is never deleted");
    const s = (await dbm.pool.query("select last_cleanup_at, last_cleanup_stats from news_job_settings")).rows[0];
    assert.ok(s.last_cleanup_at);
    assert.deepEqual(s.last_cleanup_stats.deleted, expected);
    assert.equal(s.last_cleanup_stats.trigger, "manual");
  });

  it("purgeDuplicates=false keeps a duplicate until the hidden window", async () => {
    await dbm.pool.query("update news_job_settings set purge_duplicates = false where id = 1");
    await dbm.pool.query(`insert into news_items (external_id, text, status, ai_relevant, ai_reason, created_at) values
      ('d1', 't', 'hidden', false, 'duplicate of a', now() - interval '2 days'),
      ('d2', 't', 'hidden', false, 'duplicate of a', now() - interval '15 days')`);
    const r = await new Cleaner(db, appLog).cleanNow(false);
    assert.deepEqual((r as any).deleted, { rejected: 0, duplicates: 0, hidden: 1, seen: 0, runs: 0 });
    assert.deepEqual(await itemIds(), ["d1"]);
  });

  it("a real cleanup waits for the run lock (409 path); the hourly tick claims once an hour", async () => {
    const lock = await lockMod.tryAcquireNewsLock();
    assert.ok(lock);
    const cleaner = new Cleaner(db, appLog);
    assert.equal((await cleaner.cleanNow(false)).kind, "busy");
    assert.equal(await cleaner.hourly(), "busy");
    assert.equal((await cleaner.cleanNow(true)).kind, "done", "a dry run needs no lock");
    await lock!.release();
    assert.equal(await cleaner.hourly(), "cleaned");
    assert.equal(await cleaner.hourly(), "idle", "not again within the hour");
    const s = (await dbm.pool.query("select last_cleanup_stats from news_job_settings")).rows[0];
    assert.equal(s.last_cleanup_stats.trigger, "hourly");
  });

  it("the end of every run cleans up, logged in that run's log", async () => {
    await dbm.pool.query("insert into news_items (external_id, text, status, created_at) values ('old-rej', 't', 'rejected', now() - interval '3 days')");
    await dbm.pool.query("insert into news_sources (kind, feed_url) values ('rss', 'https://example.com/feed')");
    const runner = new Runner(db, appLog, new Cleaner(db, appLog));
    runner.rssOverride = { fetchFeed: async () => ({ notModified: true, etag: null, lastModified: null, title: null, siteUrl: null, items: [], skipped: 0 }) };
    runner.aiOverride = rejectingAi();
    const run = await runOnce(runner);
    assert.equal(run.status, "success");
    assert.ok(run.log.some((l: any) => /^cleanup: deleted 1 rejected/.test(l.message)), JSON.stringify(run.log));
    assert.deepEqual(await itemIds(), []);
    const s = (await dbm.pool.query("select last_cleanup_stats from news_job_settings")).rows[0];
    assert.equal(s.last_cleanup_stats.trigger, "run");
    assert.equal(s.last_cleanup_stats.runId, run.id);
  });

  it("a scheduled slot waits out a cleanup holding the lock, but still skips while a real run is going", async () => {
    const { NewsSchedulerService } = await import("./news.scheduler.service");
    await dbm.pool.query("insert into news_sources (kind, feed_url) values ('rss', 'https://example.com/feed')");
    const runner = new Runner(db, appLog, new Cleaner(db, appLog));
    runner.rssOverride = { fetchFeed: async () => ({ notModified: true, etag: null, lastModified: null, title: null, siteUrl: null, items: [], skipped: 0 }) };
    runner.aiOverride = rejectingAi();
    const sched = new NewsSchedulerService(db, runner, new Cleaner(db, appLog));
    sched.busyRetryMs = 50;
    const due = () => dbm.pool.query("update news_job_settings set enabled = true, last_cleanup_at = now(), next_run_at = now() - interval '1 minute' where id = 1");
    const runs = async () => (await dbm.pool.query("select trigger, status, error from news_job_runs order by started_at")).rows;
    const waitIdle = async () => {
      for (let i = 0; i < 200 && (await runs()).some((r: any) => r.status === "running"); i++) await new Promise((r) => setTimeout(r, 25));
    };

    // Another instance's cleanup holds the lock for ~200 ms: the slot runs.
    await due();
    const cleanupLock = await lockMod.tryAcquireNewsLock();
    setTimeout(() => void cleanupLock!.release(), 200);
    assert.equal(await sched.tick(), "claimed");
    await waitIdle();
    assert.deepEqual((await runs()).map((r: any) => `${r.trigger}:${r.status}`), ["schedule:success"]);

    // A real run holds it: skipped at once, as before.
    await dbm.pool.query("delete from news_job_runs");
    await due();
    const runLock = await lockMod.tryAcquireNewsLock();
    try {
      await dbm.pool.query("insert into news_job_runs (trigger, status) values ('manual', 'running')");
      assert.equal(await sched.tick(), "claimed");
      const r = await runs();
      assert.equal(r.find((x: any) => x.trigger === "schedule")?.status, "skipped");
    } finally {
      await runLock!.release();
      await dbm.pool.query("update news_job_settings set enabled = false where id = 1");
    }
  });

  // ── pagination ───────────────────────────────────────────────────────
  it("pages never repeat or skip rows, even when every sort key ties", async () => {
    const { NewsAdminController } = await import("./news-admin.controller");
    const { NewsController } = await import("./news.controller");
    const t = new Date(Date.now() - HOUR).toISOString();
    for (let i = 0; i < 23; i++) {
      await dbm.pool.query(`insert into news_items (external_id, text, status, posted_at, pinned) values ($1, 't', $2, $3, $4)`,
        [`p-${i}`, i % 3 === 0 ? "rejected" : "published", i % 4 === 0 ? null : t, i % 5 === 0]);
      await dbm.pool.query(`insert into news_job_runs (trigger, status, started_at) values ('manual', 'success', $1)`, [t]);
      await dbm.pool.query(`insert into news_sources (kind, handle, display_name) values ('x', $1, 'Same')`, [`h${i}`]);
    }
    const admin = new NewsAdminController(db, new Runner(db, appLog), appLog);
    const feed = new NewsController(db);
    const walk = async (fetchPage: (page: number) => Promise<any>) => {
      const seen: string[] = [];
      let total = 0;
      for (let page = 1; page < 20; page++) {
        const r = await fetchPage(page);
        total = r.total;
        assert.ok(r.pageSize <= 100);
        seen.push(...r.data.map((x: any) => x.id));
        if (page * r.pageSize >= r.total) break;
      }
      assert.equal(new Set(seen).size, seen.length, "no duplicates across pages");
      assert.equal(seen.length, total, "no row skipped");
      return seen;
    };
    await walk((page) => admin.items({ page: String(page), pageSize: "7" }));
    await walk((page) => admin.runs({ page: String(page), pageSize: "7" }) as any);
    await walk((page) => admin.sources({ page: String(page), pageSize: "7" }) as any);
    await walk((page) => feed.list({ page: String(page), pageSize: "7" }));
    const big: any = await admin.items({ page: "1", pageSize: "150" });
    assert.equal(big.pageSize, 100, "pageSize is clamped to 100");

    const counts: any = await admin.itemCounts({ status: "rejected" });
    assert.deepEqual(counts, { published: 15, rejected: 8, hidden: 0, pinned: 5, total: 23 }, "counts ignore status");
    const bare = await admin.runs({ limit: "5" });
    assert.ok(Array.isArray(bare) && bare.length === 5, "runs without page/pageSize stay a bare array");
  });
});
