import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  newsItemsTable, newsJobSettingsTable, newsSeenTable,
  type NewsCleanupStats, type NewsJobSettings, type NewsRunLogEntry,
} from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { AppLogService } from "../../common/logging/app-log.service";
import { AI_MAX_ATTEMPTS } from "./news.batches";
import { tryAcquireNewsLock } from "./news.lock";
import {
  candidateCutoff, cleanupDue, CLEANUP_BATCH, describeDeleted, emptyDeleted, purgeKind, runsCutoff, seenCutoff,
  type CleanupDeleted, type PurgeKind, type RetentionSettings,
} from "./news.cleaner";

/** Candidate rows read per cleanup; anything past it waits for the next hour. */
const SCAN_CAP = 20_000;
/** DELETE statements per table per cleanup (× CLEANUP_BATCH rows). */
const MAX_BATCHES = 200;

const VERDICT: Record<PurgeKind, string> = { rejected: "rejected", duplicates: "duplicate", hidden: "hidden" };

export type CleanupTrigger = NewsCleanupStats["trigger"];

export interface CleanupResult {
  dryRun: boolean;
  deleted: CleanupDeleted;
  /** The retention settings this cleanup applied (rules: news.cleaner.ts). */
  settings: RetentionSettings;
  at: string;
  ms: number;
}

export type CleanNowResult = { kind: "busy" } | ({ kind: "done" } & CleanupResult);

export function retentionOf(s: Pick<NewsJobSettings, keyof RetentionSettings>): RetentionSettings {
  return {
    rejectedRetentionHours: s.rejectedRetentionHours,
    purgeDuplicates: s.purgeDuplicates,
    hiddenRetentionDays: s.hiddenRetentionDays,
    runsRetentionDays: s.runsRetentionDays,
    seenRetentionDays: s.seenRetentionDays,
  };
}

/**
 * The retention cleaner (rules: `news.cleaner.ts`). Never concurrent with a
 * run: a real cleanup either runs inside a job run (which holds the run lock)
 * or takes that same advisory lock itself. A dry run takes no lock and writes
 * nothing.
 *
 * When: at the end of every job run (logged in that run's log), from the 60 s
 * tick at most once an hour (atomic claim on `last_cleanup_at`), and by hand
 * (POST /admin/news/cleanup).
 */
@Injectable()
export class NewsCleanerService {
  private readonly logger = new Logger("NewsCleaner");

  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    @Optional() private readonly appLog?: AppLogService,
  ) {}

  private async settings(): Promise<NewsJobSettings | null> {
    const [row] = await this.db.select().from(newsJobSettingsTable).where(eq(newsJobSettingsTable.id, 1));
    return row ?? null;
  }

  /**
   * One cleanup. A real one (dryRun false) must only be called while the
   * caller holds the news run lock. `log` receives one summary line.
   */
  async clean(opts: {
    dryRun: boolean; trigger: CleanupTrigger; runId?: string | null;
    log?: (level: NewsRunLogEntry["level"], message: string) => void; now?: Date;
  }): Promise<CleanupResult> {
    const started = Date.now();
    const now = opts.now ?? new Date();
    const row = await this.settings();
    if (!row) throw new Error("news settings row missing");
    const s = retentionOf(row);
    const deleted = emptyDeleted();

    // ── news_items: candidates are old, unmoderated, unpinned, not published.
    // The rules themselves are decided in JS (purgeKind) — one tested source.
    const candidates = await this.db.select({
      id: newsItemsTable.id, status: newsItemsTable.status, aiReason: newsItemsTable.aiReason,
      aiRelevant: newsItemsTable.aiRelevant, aiAttempts: newsItemsTable.aiAttempts,
      moderatedAt: newsItemsTable.moderatedAt, pinned: newsItemsTable.pinned, createdAt: newsItemsTable.createdAt,
    }).from(newsItemsTable).where(and(
      inArray(newsItemsTable.status, ["rejected", "hidden"]),
      isNull(newsItemsTable.moderatedAt),
      eq(newsItemsTable.pinned, false),
      lt(newsItemsTable.createdAt, candidateCutoff(s, now)),
    )).orderBy(asc(newsItemsTable.createdAt), asc(newsItemsTable.id)).limit(SCAN_CAP);

    const byKind: Record<PurgeKind, string[]> = { rejected: [], duplicates: [], hidden: [] };
    for (const c of candidates) {
      const k = purgeKind(c, s, now, AI_MAX_ATTEMPTS);
      if (k) byKind[k].push(c.id);
    }
    for (const kind of Object.keys(byKind) as PurgeKind[]) {
      const ids = byKind[kind];
      if (opts.dryRun) {
        deleted[kind] = ids.length;
        continue;
      }
      for (let i = 0; i < ids.length; i += CLEANUP_BATCH) {
        deleted[kind] += await this.deleteItems(kind, ids.slice(i, i + CLEANUP_BATCH), now);
      }
    }

    // ── news_seen: kept seenRetentionDays after the item is gone.
    const seenWhere = sql`coalesce(s.purged_at, s.first_seen_at) < ${seenCutoff(s, now).toISOString()}::timestamptz
      and not exists (select 1 from news_items i where i.external_id = s.external_id)`;
    deleted.seen = opts.dryRun
      ? await this.countOf(sql`select count(*)::int as n from news_seen s where ${seenWhere}`)
      : await this.deleteLoop(sql`delete from news_seen where external_id in (
          select s.external_id from news_seen s where ${seenWhere} limit ${CLEANUP_BATCH})`);

    // ── news_job_runs (the logs are the heavy part). Never a running row.
    const runsWhere = sql`started_at < ${runsCutoff(s, now).toISOString()}::timestamptz and status <> 'running'`;
    deleted.runs = opts.dryRun
      ? await this.countOf(sql`select count(*)::int as n from news_job_runs where ${runsWhere}`)
      : await this.deleteLoop(sql`delete from news_job_runs where id in (
          select id from news_job_runs where ${runsWhere} limit ${CLEANUP_BATCH})`);

    const ms = Date.now() - started;
    const summary = `${opts.dryRun ? "cleanup preview — would delete" : "cleanup: deleted"} ${describeDeleted(deleted)}`
      + `${candidates.length >= SCAN_CAP ? ` (first ${SCAN_CAP} candidates; the rest next time)` : ""}`;
    opts.log?.("info", summary);

    if (!opts.dryRun) {
      const stats: NewsCleanupStats = { trigger: opts.trigger, deleted, ms, runId: opts.runId ?? null, error: null };
      await this.db.update(newsJobSettingsTable).set({ lastCleanupAt: new Date(), lastCleanupStats: stats })
        .where(eq(newsJobSettingsTable.id, 1));
      const total = deleted.rejected + deleted.duplicates + deleted.hidden + deleted.seen + deleted.runs;
      if (total) {
        this.appLog?.record({ level: "log", event: "news_cleanup", context: "News", message: summary, meta: { trigger: opts.trigger, ...deleted } });
      }
    }
    return { dryRun: opts.dryRun, deleted, settings: s, at: now.toISOString(), ms };
  }

  /**
   * Delete one batch of items of one kind, re-checking at write time that each
   * is still that kind's status and still unmoderated and unpinned (an admin
   * PATCH in the meantime wins), and remember them in news_seen — in one
   * transaction, so a deleted item is never missing from news_seen.
   */
  private async deleteItems(kind: PurgeKind, ids: string[], now: Date): Promise<number> {
    return this.db.transaction(async (tx) => {
      const gone = await tx.delete(newsItemsTable).where(and(
        inArray(newsItemsTable.id, ids),
        eq(newsItemsTable.status, kind === "rejected" ? "rejected" : "hidden"),
        isNull(newsItemsTable.moderatedAt),
        eq(newsItemsTable.pinned, false),
      )).returning({ externalId: newsItemsTable.externalId, sourceId: newsItemsTable.sourceId, createdAt: newsItemsTable.createdAt });
      if (gone.length) {
        await tx.insert(newsSeenTable).values(gone.map((g) => ({
          externalId: g.externalId, sourceId: g.sourceId, firstSeenAt: g.createdAt, verdict: VERDICT[kind], purgedAt: now,
        }))).onConflictDoUpdate({
          target: newsSeenTable.externalId,
          set: { verdict: sql`excluded.verdict`, purgedAt: sql`excluded.purged_at` },
        });
      }
      return gone.length;
    });
  }

  private async deleteLoop(stmt: ReturnType<typeof sql>): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const res: any = await this.db.execute(stmt);
      const n = Number(res?.rowCount ?? 0);
      total += n;
      if (n < CLEANUP_BATCH) break;
    }
    return total;
  }

  private async countOf(stmt: ReturnType<typeof sql>): Promise<number> {
    const res: any = await this.db.execute(stmt);
    return Number(res?.rows?.[0]?.n ?? 0);
  }

  /** POST /admin/news/cleanup. A real one takes the run lock (busy while a run holds it). */
  async cleanNow(dryRun: boolean): Promise<CleanNowResult> {
    if (dryRun) return { kind: "done", ...(await this.clean({ dryRun: true, trigger: "manual" })) };
    const lock = await tryAcquireNewsLock();
    if (!lock) return { kind: "busy" };
    try {
      return { kind: "done", ...(await this.clean({ dryRun: false, trigger: "manual" })) };
    } finally {
      await lock.release();
    }
  }

  /**
   * The 60 s tick's share: at most once an hour. Lock first (never alongside a
   * run — whose own post-run cleanup covers that hour), then an atomic claim on
   * `last_cleanup_at` so two instances cannot both clean the same hour.
   */
  async hourly(now: Date = new Date()): Promise<"idle" | "busy" | "lost" | "cleaned"> {
    const row = await this.settings();
    if (!row || !cleanupDue(row.lastCleanupAt, now)) return "idle";
    const lock = await tryAcquireNewsLock();
    if (!lock) return "busy";
    try {
      const claimed = await this.db.update(newsJobSettingsTable).set({ lastCleanupAt: new Date() })
        .where(and(
          eq(newsJobSettingsTable.id, 1),
          sql`(${newsJobSettingsTable.lastCleanupAt} is null or ${newsJobSettingsTable.lastCleanupAt} <= now() - interval '1 hour')`,
        ))
        .returning({ id: newsJobSettingsTable.id });
      if (!claimed.length) return "lost";
      try {
        await this.clean({ dryRun: false, trigger: "hourly", now });
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        this.logger.warn(`news cleanup failed: ${msg}`);
        const stats: NewsCleanupStats = { trigger: "hourly", deleted: emptyDeleted(), ms: 0, runId: null, error: msg.slice(0, 500) };
        await this.db.update(newsJobSettingsTable).set({ lastCleanupStats: stats }).where(eq(newsJobSettingsTable.id, 1)).catch(() => undefined);
      }
      return "cleaned";
    } finally {
      await lock.release();
    }
  }
}
