import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  candidateCutoff, cleanupDue, DAY_MS, HOUR_MS, minSeenRetentionDays, purgeKind, RETENTION_DEFAULTS,
  type PurgeCandidate, type RetentionSettings,
} from "./news.cleaner";
import { checkRetention, NewsValidationError, parseCleanupBody, parseSettingsPatch } from "./news.validation";
import { NewsAdminController } from "./news-admin.controller";
import { NewsController, newsListQuery } from "./news.controller";
import { NewsRunnerService } from "./news.runner.service";

const NOW = new Date("2026-09-26T12:00:00Z");
const S: RetentionSettings = { ...RETENTION_DEFAULTS };

function item(over: Partial<PurgeCandidate> & { hoursOld: number }): PurgeCandidate {
  const { hoursOld, ...rest } = over;
  return {
    status: "rejected", aiReason: "keyword 10: matched: –", aiRelevant: false, aiAttempts: 0,
    moderatedAt: null, pinned: false, createdAt: new Date(NOW.getTime() - hoursOld * HOUR_MS), judgedAt: null, ...rest,
  };
}

describe("purgeKind — the retention rules", () => {
  it("rejected: kept for rejectedRetentionHours, then deleted", () => {
    assert.equal(purgeKind(item({ hoursOld: 23 }), S, NOW), null);
    assert.equal(purgeKind(item({ hoursOld: 25 }), S, NOW), "rejected");
    assert.equal(purgeKind(item({ hoursOld: 3 }), { ...S, rejectedRetentionHours: 2 }, NOW), "rejected");
  });

  it("windows count from the verdict (judged_at), not from when the item was stored", () => {
    const judged = (h: number) => new Date(NOW.getTime() - h * HOUR_MS);
    assert.equal(purgeKind(item({ hoursOld: 5 * 24, judgedAt: judged(1) }), S, NOW), null, "stored 5 d ago, rejected 1 h ago: kept");
    assert.equal(purgeKind(item({ hoursOld: 5 * 24, judgedAt: judged(25) }), S, NOW), "rejected", "rejected 25 h ago: purged");
    const dup = { status: "hidden", aiReason: "duplicate of 1" };
    assert.equal(purgeKind(item({ ...dup, hoursOld: 5 * 24, judgedAt: judged(1) }), S, NOW), null);
    assert.equal(purgeKind(item({ ...dup, hoursOld: 5 * 24, judgedAt: judged(25) }), S, NOW), "duplicates");
    const gaveUp = { status: "hidden", aiRelevant: null, aiAttempts: 3, aiReason: "AI gave up after 3 attempts" };
    assert.equal(purgeKind(item({ ...gaveUp, hoursOld: 20 * 24, judgedAt: judged(24) }), S, NOW), null, "gave up 1 d ago: hidden window from then");
    assert.equal(purgeKind(item({ ...gaveUp, hoursOld: 20 * 24, judgedAt: judged(15 * 24) }), S, NOW), "hidden");
    // The AI-retry window stays on created_at.
    const waiting = { status: "hidden", aiRelevant: null, aiAttempts: 1, aiReason: "AI failed (will retry next run)" };
    assert.equal(purgeKind(item({ ...waiting, hoursOld: 3 * 24 }), { ...S, hiddenRetentionDays: 1 }, NOW), null);
  });

  it("never an item an admin moderated, whatever its status or age", () => {
    for (const status of ["rejected", "hidden", "published"]) {
      assert.equal(purgeKind(item({ status, hoursOld: 5000, moderatedAt: new Date() }), S, NOW), null, status);
    }
    assert.equal(purgeKind(item({ status: "hidden", aiReason: "duplicate of 1", hoursOld: 500, moderatedAt: new Date() }), S, NOW), null);
  });

  it("never a pinned item", () => {
    assert.equal(purgeKind(item({ hoursOld: 5000, pinned: true }), S, NOW), null);
    assert.equal(purgeKind(item({ status: "hidden", hoursOld: 5000, pinned: true }), S, NOW), null);
  });

  it("never a published item", () => {
    assert.equal(purgeKind(item({ status: "published", aiRelevant: true, hoursOld: 50_000 }), S, NOW), null);
  });

  it("stored near-duplicates: the rejected window when purgeDuplicates, else the hidden window", () => {
    const dup = (h: number) => item({ status: "hidden", aiReason: "duplicate of 2101997268081484168", hoursOld: h });
    assert.equal(purgeKind(dup(23), S, NOW), null);
    assert.equal(purgeKind(dup(25), S, NOW), "duplicates");
    const off = { ...S, purgeDuplicates: false };
    assert.equal(purgeKind(dup(25), off, NOW), null);
    assert.equal(purgeKind(dup(14 * 24 + 1), off, NOW), "hidden");
  });

  it("guard-held items are kept for hiddenRetentionDays", () => {
    const held = (h: number) => item({ status: "hidden", aiRelevant: false, aiReason: "held for admin review: post text …", hoursOld: h });
    assert.equal(purgeKind(held(25), S, NOW), null);
    assert.equal(purgeKind(held(13 * 24), S, NOW), null);
    assert.equal(purgeKind(held(14 * 24 + 1), S, NOW), "hidden");
  });

  it("AI give-up items are kept for hiddenRetentionDays", () => {
    const gaveUp = (h: number) => item({ status: "hidden", aiRelevant: null, aiAttempts: 3, aiReason: "AI gave up after 3 attempts", hoursOld: h });
    assert.equal(purgeKind(gaveUp(10 * 24), S, NOW), null);
    assert.equal(purgeKind(gaveUp(15 * 24), S, NOW), "hidden");
  });

  it("an item still waiting for an AI retry is never cut short, even with a 1-day hidden window", () => {
    const s1 = { ...S, hiddenRetentionDays: 1 };
    const waiting = (h: number, attempts = 1) => item({ status: "hidden", aiRelevant: null, aiAttempts: attempts, aiReason: "AI failed (will retry next run)", hoursOld: h });
    assert.equal(purgeKind(waiting(3 * 24), s1, NOW), null, "inside the 7-day retry window");
    assert.equal(purgeKind(waiting(8 * 24), s1, NOW), "hidden", "past the retry window");
    assert.equal(purgeKind(waiting(3 * 24, 3), s1, NOW), "hidden", "given up: no retry pending");
  });

  it("the candidate scan starts at the shortest window", () => {
    assert.equal(candidateCutoff(S, NOW).getTime(), NOW.getTime() - 24 * HOUR_MS);
    assert.equal(candidateCutoff({ ...S, rejectedRetentionHours: 72, hiddenRetentionDays: 1 }, NOW).getTime(), NOW.getTime() - DAY_MS);
  });

  it("the hourly tick is due once an hour", () => {
    assert.equal(cleanupDue(null, NOW), true);
    assert.equal(cleanupDue(new Date(NOW.getTime() - 59 * 60_000), NOW), false);
    assert.equal(cleanupDue(new Date(NOW.getTime() - HOUR_MS), NOW), true);
  });
});

describe("retention settings validation", () => {
  it("accepts each setting at its bounds, camelCase or snake_case", () => {
    assert.deepEqual(parseSettingsPatch({ rejectedRetentionHours: 1, purgeDuplicates: false, hiddenRetentionDays: 90, runsRetentionDays: 7, seenRetentionDays: 180 }),
      { rejectedRetentionHours: 1, purgeDuplicates: false, hiddenRetentionDays: 90, runsRetentionDays: 7, seenRetentionDays: 180 });
    assert.deepEqual(parseSettingsPatch({ rejected_retention_hours: "168", purge_duplicates: "true", hidden_retention_days: 1, runs_retention_days: 365, seen_retention_days: 7 }),
      { rejectedRetentionHours: 168, purgeDuplicates: true, hiddenRetentionDays: 1, runsRetentionDays: 365, seenRetentionDays: 7 });
  });

  it("rejects out-of-range and malformed values", () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ rejectedRetentionHours: 0 }, /rejectedRetentionHours must be a whole number from 1 to 168/],
      [{ rejectedRetentionHours: 169 }, /1 to 168/],
      [{ rejectedRetentionHours: 1.5 }, /1 to 168/],
      [{ hiddenRetentionDays: 91 }, /hiddenRetentionDays must be a whole number from 1 to 90/],
      [{ runsRetentionDays: 6 }, /runsRetentionDays must be a whole number from 7 to 365/],
      [{ seenRetentionDays: 181 }, /seenRetentionDays must be a whole number from 7 to 180/],
      [{ seenRetentionDays: "x" }, /7 to 180/],
      [{ purgeDuplicates: "yes" }, /purgeDuplicates must be true or false/],
    ];
    for (const [body, re] of bad) assert.throws(() => parseSettingsPatch(body), (e: any) => e instanceof NewsValidationError && re.test(e.message), JSON.stringify(body));
  });

  it("the seen window must outlast the lookback by 2 days", () => {
    assert.equal(minSeenRetentionDays(36), 7);
    assert.equal(minSeenRetentionDays(120), 7);
    assert.equal(minSeenRetentionDays(121), 8);
    assert.equal(minSeenRetentionDays(168), 9);
    assert.doesNotThrow(() => checkRetention({ lookbackHours: 36, seenRetentionDays: 7 }));
    assert.doesNotThrow(() => checkRetention({ lookbackHours: 168, seenRetentionDays: 9 }));
    assert.throws(() => checkRetention({ lookbackHours: 168, seenRetentionDays: 8 }), /at least 9/);
  });

  it("PATCH /settings checks the merged row (a lookback change against the stored seen window too)", async () => {
    let written: any = null;
    const current = { id: 1, runTime: "07:00", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], lookbackHours: 36, seenRetentionDays: 7 };
    const runner = { loadSettings: async () => current } as any;
    const db: any = { update: () => ({ set: (v: any) => { written = v; return { where: () => ({ returning: async () => [v] }) }; } }) };
    const c = new NewsAdminController(db, runner, { record() {} } as any);
    await assert.rejects(c.updateSettings({ lookbackHours: 168 }, { id: 1 } as any), /seenRetentionDays must cover the lookback window/);
    assert.equal(written, null);
    await c.updateSettings({ lookbackHours: 168, seenRetentionDays: 9 }, { id: 1 } as any);
    assert.equal(written.seenRetentionDays, 9);
  });

  it("cleanup body: dryRun boolean, default false", () => {
    assert.deepEqual(parseCleanupBody(undefined), { dryRun: false });
    assert.deepEqual(parseCleanupBody({ dryRun: true }), { dryRun: true });
    assert.deepEqual(parseCleanupBody({ dry_run: "false" }), { dryRun: false });
    assert.throws(() => parseCleanupBody({ dryRun: 1 }), /dryRun must be true or false/);
  });
});

describe("pagination", () => {
  it("pageSize is clamped to 100; junk is a 400", () => {
    assert.equal(newsListQuery({ pageSize: "150" }).pageSize, 100);
    assert.equal(newsListQuery({ pageSize: "1000" }).pageSize, 100, "above the shared 200 cap too");
    assert.equal(newsListQuery({}).pageSize, 25);
    assert.equal(newsListQuery({ page: "3", pageSize: "20" }).page, 3);
    assert.throws(() => newsListQuery({ page: "0" }), /invalid page or pageSize/);
    assert.throws(() => newsListQuery({ pageSize: "abc" }), /invalid page or pageSize/);
  });

  /** A db stand-in that records every ORDER BY and answers []. */
  function orderRecorder() {
    const orders: string[] = [];
    const dialect = new PgDialect();
    const chain: any = new Proxy({}, {
      get(_t, p) {
        if (p === "then") return (res: (v: unknown) => void) => res([]);
        if (p === "orderBy") {
          return (...args: any[]) => {
            orders.push(dialect.sqlToQuery(sql.join(args, sql`, `)).sql);
            return chain;
          };
        }
        return () => chain;
      },
    });
    return { db: chain, orders };
  }

  it("every list ends its ORDER BY with the id tiebreaker", async () => {
    const { db, orders } = orderRecorder();
    const admin = new NewsAdminController(db, new NewsRunnerService(db, {} as any), {} as any);
    await admin.items({ page: "1", pageSize: "20" });
    await admin.runs({ page: "1", pageSize: "20" });
    await admin.runs({ limit: "5" });
    await admin.sources({ page: "1", pageSize: "20" });
    await new NewsController(db).list({ page: "1" });
    assert.equal(orders.length, 5);
    assert.match(orders[0], /"posted_at" desc nulls last, "news_items"\."id" desc$/);
    assert.match(orders[1], /"started_at" desc, "news_job_runs"\."id" desc$/);
    assert.match(orders[2], /"started_at" desc, "news_job_runs"\."id" desc$/);
    assert.match(orders[3], /"news_sources"\."id" asc$/);
    assert.match(orders[4], /^"news_items"\."pinned" desc, "news_items"\."posted_at" desc nulls last, "news_items"\."id" desc$/);
  });
});
