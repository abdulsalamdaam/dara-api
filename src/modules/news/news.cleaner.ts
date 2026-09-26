/**
 * Retention rules for the news tables — pure, so every keep/delete case is
 * unit-tested (`news.cleaner.spec.ts`). `NewsCleanerService` applies them.
 *
 * Owner: "rejected news I don't want them for longer than a day, I don't want
 * to keep it in my db". So, for `news_items`:
 *
 *  - never: published, pinned, or anything an admin moderated by hand
 *    (`moderated_at` set — an explicit decision is kept);
 *  - `rejected` → deleted after `rejectedRetentionHours` (default 24);
 *  - `hidden` + "duplicate of …" (a stored near-duplicate) → the same window
 *    when `purgeDuplicates`, else the hidden window below;
 *  - any other `hidden` (held by the guard, AI gave up, waiting for the AI) →
 *    after `hiddenRetentionDays` (default 14). An item still waiting for an AI
 *    retry is never cut short: it is also kept for the whole retry window.
 *
 * Deleted items stay in `news_seen`, so the next run never stores or judges
 * them again. `news_seen` rows are dropped `seenRetentionDays` after their item
 * is gone; `news_job_runs` rows after `runsRetentionDays`.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Same as the runner's RETRY_WINDOW_MS: unjudged items are retried for a week. */
export const AI_RETRY_WINDOW_MS = 7 * DAY_MS;

/** A seen row must outlive the lookback window by at least this much. */
export const SEEN_MARGIN_HOURS = 48;

/** Rows per DELETE statement. */
export const CLEANUP_BATCH = 500;

/** The hourly tick runs the cleaner at most this often. */
export const CLEANUP_INTERVAL_MS = HOUR_MS;

export interface RetentionSettings {
  rejectedRetentionHours: number;
  purgeDuplicates: boolean;
  hiddenRetentionDays: number;
  runsRetentionDays: number;
  seenRetentionDays: number;
}

export const RETENTION_DEFAULTS: RetentionSettings = {
  rejectedRetentionHours: 24,
  purgeDuplicates: true,
  hiddenRetentionDays: 14,
  runsRetentionDays: 90,
  seenRetentionDays: 30,
};

/** Bounds for PATCH /admin/news/settings. */
export const RETENTION_BOUNDS = {
  rejectedRetentionHours: [1, 168],
  hiddenRetentionDays: [1, 90],
  runsRetentionDays: [7, 365],
  seenRetentionDays: [7, 180],
} as const;

export type PurgeKind = "rejected" | "duplicates" | "hidden";

export interface PurgeCandidate {
  status: string;
  aiReason: string | null;
  /** null = the filter never judged it. */
  aiRelevant: boolean | null;
  aiAttempts: number;
  moderatedAt: Date | null;
  pinned: boolean;
  createdAt: Date;
}

export function isStoredDuplicate(r: Pick<PurgeCandidate, "status" | "aiReason">): boolean {
  return r.status === "hidden" && (r.aiReason ?? "").startsWith("duplicate of");
}

/** Still in line for another AI review (the runner's retry query would pick it up). */
function awaitingAiRetry(r: PurgeCandidate, maxAttempts: number, now: number): boolean {
  return r.aiRelevant === null && r.aiAttempts < maxAttempts && now - r.createdAt.getTime() < AI_RETRY_WINDOW_MS;
}

/**
 * Why this item may be deleted now, or null to keep it.
 * `maxAttempts` = AI_MAX_ATTEMPTS (passed in to keep this file import-free).
 */
export function purgeKind(r: PurgeCandidate, s: RetentionSettings, now: Date, maxAttempts = 3): PurgeKind | null {
  if (r.pinned || r.moderatedAt || r.status === "published") return null;
  const age = now.getTime() - r.createdAt.getTime();
  const shortWindow = s.rejectedRetentionHours * HOUR_MS;
  if (r.status === "rejected") return age > shortWindow ? "rejected" : null;
  if (r.status !== "hidden") return null;
  if (isStoredDuplicate(r) && s.purgeDuplicates) return age > shortWindow ? "duplicates" : null;
  if (awaitingAiRetry(r, maxAttempts, now.getTime())) return null;
  return age > s.hiddenRetentionDays * DAY_MS ? "hidden" : null;
}

/**
 * The oldest `created_at` the candidate scan can skip: nothing younger than the
 * shortest window can be deleted.
 */
export function candidateCutoff(s: RetentionSettings, now: Date): Date {
  const shortest = Math.min(s.rejectedRetentionHours * HOUR_MS, s.hiddenRetentionDays * DAY_MS);
  return new Date(now.getTime() - shortest);
}

export function seenCutoff(s: RetentionSettings, now: Date): Date {
  return new Date(now.getTime() - s.seenRetentionDays * DAY_MS);
}

export function runsCutoff(s: RetentionSettings, now: Date): Date {
  return new Date(now.getTime() - s.runsRetentionDays * DAY_MS);
}

/** The fewest days of news_seen that still covers `lookbackHours` + the margin. */
export function minSeenRetentionDays(lookbackHours: number): number {
  return Math.max(RETENTION_BOUNDS.seenRetentionDays[0], Math.ceil((lookbackHours + SEEN_MARGIN_HOURS) / 24));
}

/** Whether the hourly tick is due to clean. */
export function cleanupDue(lastCleanupAt: Date | null, now: Date): boolean {
  return !lastCleanupAt || now.getTime() - lastCleanupAt.getTime() >= CLEANUP_INTERVAL_MS;
}

export type CleanupDeleted = { rejected: number; duplicates: number; hidden: number; seen: number; runs: number };

export function emptyDeleted(): CleanupDeleted {
  return { rejected: 0, duplicates: 0, hidden: 0, seen: 0, runs: 0 };
}

export function describeDeleted(d: CleanupDeleted): string {
  return `${d.rejected} rejected, ${d.duplicates} duplicate(s), ${d.hidden} old hidden item(s), ${d.seen} seen id(s), ${d.runs} old run(s)`;
}
