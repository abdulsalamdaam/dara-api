import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { newsJobRunsTable, newsJobSettingsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { computeNextRunAt, NEWS_TZ } from "./news.schedule";
import { NewsRunnerService } from "./news.runner.service";
import { tryAcquireNewsLock } from "./news.lock";

const TICK_MS = 60_000;
const BOOT_DELAY_MS = 20_000;

/**
 * The daily trigger. In-process, no new infrastructure — a 60-second tick, the
 * same plain-timer approach as `ejar.policy.service`.
 *
 * Every instance ticks; exactly one claims a slot. The claim is a single
 * conditional UPDATE (`… WHERE next_run_at <= now() RETURNING`) that moves
 * `next_run_at` forward, so two instances (or a restart racing itself) cannot
 * both win the same slot. The run then also takes the advisory lock,
 * which covers the manual "run now" path too.
 *
 * `NEWS_SCHEDULER_DISABLED=1` turns the tick off (local dev, one-off scripts).
 */
@Injectable()
export class NewsSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("NewsScheduler");
  private timer: NodeJS.Timeout | null = null;
  private boot: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly runner: NewsRunnerService,
  ) {}

  onModuleInit(): void {
    if (process.env.NEWS_SCHEDULER_DISABLED === "1") {
      this.logger.log("news scheduler disabled (NEWS_SCHEDULER_DISABLED=1)");
      return;
    }
    this.boot = setTimeout(() => void this.onBoot(), BOOT_DELAY_MS);
    this.boot.unref?.();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.boot) clearTimeout(this.boot);
  }

  /**
   * A `running` row that no process is running: its owner died (a deploy or a
   * crash mid-run). Every live run holds the advisory lock from before its row
   * is written until after its row is finished, so "the lock is free" proves
   * nobody owns a `running` row. Such rows are marked failed; otherwise the
   * admin UI shows "running" (and keeps Run now disabled) forever.
   *
   * Checked on boot and on every tick — a restart shortly after a run began
   * leaves a row too young for any age rule, and a run on another instance is
   * never touched because that instance still holds the lock.
   */
  async recoverOrphanedRuns(): Promise<number> {
    const [open] = await this.db.select({ id: newsJobRunsTable.id }).from(newsJobRunsTable)
      .where(eq(newsJobRunsTable.status, "running")).limit(1);
    if (!open) return 0;
    const lock = await tryAcquireNewsLock();
    if (!lock) return 0; // a run is genuinely in progress somewhere
    try {
      const rows = await this.db.update(newsJobRunsTable)
        .set({ status: "failed", finishedAt: new Date(), error: "interrupted (the API restarted while the run was in progress)" })
        .where(eq(newsJobRunsTable.status, "running"))
        .returning({ id: newsJobRunsTable.id });
      if (rows.length) this.logger.warn(`marked ${rows.length} interrupted news run(s) failed`);
      return rows.length;
    } finally {
      await lock.release();
    }
  }

  /** Orphaned-run recovery + a first next_run_at. Never throws. */
  async onBoot(): Promise<void> {
    try {
      await this.recoverOrphanedRuns();

      const s = await this.runner.loadSettings();
      if (s && !s.nextRunAt) {
        const next = computeNextRunAt(new Date(), s.runTime, s.daysOfWeek, NEWS_TZ);
        await this.db.update(newsJobSettingsTable).set({ nextRunAt: next })
          .where(and(eq(newsJobSettingsTable.id, 1), isNull(newsJobSettingsTable.nextRunAt)));
      }
    } catch (err) {
      // The tables may not exist yet if ensureSchema warned; the tick retries.
      this.logger.warn(`news boot tasks skipped: ${(err as Error)?.message ?? err}`);
    }
  }

  async tick(now: Date = new Date()): Promise<"idle" | "claimed" | "lost"> {
    if (this.ticking) return "idle";
    this.ticking = true;
    try {
      await this.recoverOrphanedRuns().catch((err) => this.logger.warn(`news orphan check failed: ${(err as Error)?.message ?? err}`));
      const s = await this.runner.loadSettings();
      if (!s || !s.enabled) return "idle";
      if (!s.nextRunAt) {
        await this.onBoot();
        return "idle";
      }
      if (s.nextRunAt.getTime() > now.getTime()) return "idle";

      // Strictly after the slot being claimed, so a slot is never re-claimed.
      const next = computeNextRunAt(new Date(Math.max(now.getTime(), s.nextRunAt.getTime())), s.runTime, s.daysOfWeek, NEWS_TZ);
      const claimed = await this.db.update(newsJobSettingsTable)
        .set({ nextRunAt: next })
        .where(and(
          eq(newsJobSettingsTable.id, 1),
          eq(newsJobSettingsTable.enabled, true),
          // Under READ COMMITTED a concurrent claimer blocks on the row lock,
          // then re-checks this against the row the winner wrote (next_run_at
          // now in the future) and updates nothing.
          sql`${newsJobSettingsTable.nextRunAt} <= now()`,
        ))
        .returning({ id: newsJobSettingsTable.id });
      if (!claimed.length) return "lost";

      const res = await this.runner.startRun("schedule", null);
      if (res.kind === "not_configured") {
        // Not a failure: the feature is simply not switched on here yet.
        await this.runner.recordSkipped("schedule", `not configured — missing: ${res.missing.join(", ")}`);
      } else if (res.kind === "busy") {
        await this.runner.recordSkipped("schedule", "another news run was already in progress");
      }
      return "claimed";
    } catch (err) {
      this.logger.warn(`news tick failed: ${(err as Error)?.message ?? err}`);
      return "idle";
    } finally {
      this.ticking = false;
    }
  }
}
