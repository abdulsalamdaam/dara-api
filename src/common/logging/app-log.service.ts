import { Global, Inject, Injectable, Module, type OnModuleInit } from "@nestjs/common";
import { lt } from "drizzle-orm";
import { appLogsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { currentRequestContext } from "../request-context";
import { logLine, type LogLevelName } from "./logger";
import {
  MAX_ERROR_CHARS, MAX_MESSAGE_CHARS, MAX_STACK_CHARS, prepareMeta, truncate,
} from "./redact";

/** One row of `app_logs`, as a caller describes it. Everything is optional but `level`. */
export interface AppLogEntry {
  level?: LogLevelName;
  event?: string | null;
  requestId?: string | null;
  method?: string | null;
  path?: string | null;
  status?: number | null;
  durationMs?: number | null;
  userId?: number | null;
  ownerUserId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  message?: string | null;
  context?: string | null;
  error?: unknown;
  stack?: string | null;
  meta?: unknown;
}

/** After this many consecutive insert failures, stop trying for `MUTE_MS`. */
const FAILURE_MUTE_AFTER = 5;
const MUTE_MS = 5 * 60_000;
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Set on construction so code that cannot take a constructor injection can
 * still log — specifically `OtpThrottlerGuard`, whose three-argument
 * `ThrottlerGuard` constructor would have to be reproduced by hand (with the
 * library's own private injection tokens) to add a fourth parameter. That is a
 * fragile thing to own across a dependency upgrade, and this is not.
 *
 * Null before the module graph is built, which is why every caller must handle
 * null rather than assume.
 */
let singleton: AppLogService | null = null;

/** The AppLogService, or null if the module graph is not up yet. */
export function appLog(): AppLogService | null {
  return singleton;
}

@Injectable()
export class AppLogService implements OnModuleInit {
  private consecutiveFailures = 0;
  private mutedUntil = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {
    singleton = this;
  }

  onModuleInit(): void {
    // There is no scheduler in this app — the only recurring work anywhere is
    // one `setInterval` in `ejar.policy.service`. So the sweep runs shortly
    // after boot (delayed so it does not compete with `ensureSchema` and the
    // first requests) and then daily.
    const sweep = () => void this.pruneOlderThan(retentionDays());
    const first = setTimeout(sweep, 60_000);
    first.unref();
    this.timer = setInterval(sweep, DAY_MS);
    // Unref'd: a retention timer must never be the reason a SIGTERM'd
    // container takes its full 30-second grace period to die.
    this.timer.unref();
  }

  /**
   * Persist one row. **Returns void, never throws, never blocks the caller.**
   *
   * Same discipline as `safeLog` in `ejar.client.service.ts`: the request that
   * produced this log is already doing something useful, and a logging failure
   * — a missing column after a half-applied bootstrap, a full disk, a pool
   * timeout — must not turn it into a 500. The insert is fired and its
   * rejection is caught and warned to stdout, which still exists when the
   * table does not.
   */
  record(entry: AppLogEntry): void {
    try {
      if (Date.now() < this.mutedUntil) return;
      const values = this.build(entry);
      void this.db
        .insert(appLogsTable)
        .values(values)
        .then(() => {
          this.consecutiveFailures = 0;
        })
        .catch((err) => this.onWriteFailure(err));
    } catch (err) {
      // Building the row is supposed to be total, but it runs over
      // caller-supplied data; a throw here would be the logger breaking the
      // very request it exists to explain.
      this.onWriteFailure(err);
    }
  }

  /**
   * A named thing that happened, with the current request's identity filled in
   * automatically. The convenience form of `record` — `event("otp_throttled",
   * { tracker })` is the whole call.
   */
  event(name: string, meta?: unknown, overrides?: AppLogEntry): void {
    this.record({ level: "warn", ...overrides, event: name, meta });
  }

  /**
   * Delete rows older than `days`.
   *
   * Retention is not optional housekeeping: this table takes a row on every
   * 5xx, every 429 and every slow request, and `APP_LOG_ALL_REQUESTS` can turn
   * it into a row per request. Thirty days is long enough to answer "what
   * happened to this customer last month" and short enough that nobody has to
   * think about the table's size.
   */
  async pruneOlderThan(days: number): Promise<number> {
    const keep = Number.isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - keep * DAY_MS);
    try {
      const deleted = await this.db
        .delete(appLogsTable)
        .where(lt(appLogsTable.createdAt, cutoff))
        .returning({ id: appLogsTable.id });
      const n = deleted.length;
      if (n > 0) logLine("log", "AppLog", `pruned ${n} log rows older than ${keep} days`);
      return n;
    } catch (err) {
      logLine("warn", "AppLog", `retention sweep failed: ${(err as Error)?.message ?? err}`);
      return 0;
    }
  }

  /** Fill in from the ambient request context, truncate, redact, bound. */
  private build(entry: AppLogEntry): typeof appLogsTable.$inferInsert {
    const ctx = currentRequestContext();
    const err = entry.error;
    const errText =
      err == null ? null
      : err instanceof Error ? `${err.name}: ${err.message}`
      : typeof err === "string" ? err
      : safeJson(err);
    const stack = entry.stack ?? (err instanceof Error ? err.stack ?? null : null);

    return {
      level: entry.level ?? "log",
      event: truncate(entry.event ?? null, 120),
      requestId: entry.requestId ?? ctx?.requestId ?? null,
      method: truncate(entry.method ?? ctx?.method ?? null, 16),
      path: truncate(entry.path ?? ctx?.path ?? null, 512),
      status: intOrNull(entry.status),
      durationMs: intOrNull(entry.durationMs),
      userId: intOrNull(entry.userId ?? ctx?.userId),
      ownerUserId: intOrNull(entry.ownerUserId ?? ctx?.ownerUserId),
      ip: truncate(entry.ip ?? ctx?.ip ?? null, 64),
      userAgent: truncate(entry.userAgent ?? ctx?.userAgent ?? null, 400),
      message: truncate(entry.message ?? null, MAX_MESSAGE_CHARS),
      context: truncate(entry.context ?? null, 120),
      error: truncate(errText, MAX_ERROR_CHARS),
      stack: truncate(stack, MAX_STACK_CHARS),
      meta: prepareMeta(entry.meta) as never,
    };
  }

  private onWriteFailure(err: unknown): void {
    this.consecutiveFailures += 1;
    // Warn on the first failure and on the one that mutes, not on every
    // attempt: a missing table would otherwise print a warning per request and
    // bury the stdout log we still have.
    if (this.consecutiveFailures === 1 || this.consecutiveFailures === FAILURE_MUTE_AFTER) {
      logLine("warn", "AppLog", `app_logs insert failed (request unaffected): ${(err as Error)?.message ?? err}`);
    }
    if (this.consecutiveFailures >= FAILURE_MUTE_AFTER) {
      this.mutedUntil = Date.now() + MUTE_MS;
      this.consecutiveFailures = 0;
    }
  }
}

function intOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : v == null ? NaN : Number(v);
  // Bounded to int4 — a value past 2^31 reaches the driver and comes back as
  // an error on a path that is not allowed to produce one.
  return Number.isInteger(n) && Math.abs(n) <= 2_147_483_647 ? n : null;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** `APP_LOG_RETENTION_DAYS`, or 30. */
export function retentionDays(): number {
  const raw = Number(process.env.APP_LOG_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_RETENTION_DAYS;
}

/**
 * Global so that anything — a controller, a service, a filter — can inject the
 * writer without its module having to import a logging module first. The whole
 * point is that the log is available wherever the interesting failure is.
 */
@Global()
@Module({
  providers: [AppLogService],
  exports: [AppLogService],
})
export class LoggingModule {}
