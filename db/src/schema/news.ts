import {
  pgTable, text, uuid, boolean, integer, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Real-estate news — a daily job pulls posts from admin-managed X accounts and
 * RSS/Atom feeds, a filter (Claude, or the free keyword lexicon) keeps the Saudi
 * real-estate ones and titles them, and landlords read the result as a feed.
 *
 * Five tables, all owned by `src/modules/news`. Created by
 * `db/drizzle/0061_re_news.sql`, `0062_re_news_rss.sql`, `0063_re_news_moderation.sql` +
 * `0064_re_news_retention.sql`, which `ensureSchema` runs on every boot (all
 * idempotent), so a deploy needs no manual SQL.
 */

export type NewsMedia = { type: string; url: string | null; preview_url: string | null };
export type NewsMetrics = { likes: number; retweets: number; replies: number; views: number | null };
export type NewsRunLogEntry = { at: string; level: "info" | "warn" | "error"; message: string; handle?: string };

/**
 * One source the job reads: an X account (`kind = 'x'`, `handle` stored
 * normalised: no @, lowercase) or an RSS/Atom feed (`kind = 'rss'`, `feedUrl`,
 * no handle). Columns 0062 added are the rss ones plus `kind`.
 */
export const newsSourcesTable = pgTable("news_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** 'x' | 'rss' */
  kind: text("kind").notNull().default("x"),
  /** X rows only (NULL for rss). */
  handle: text("handle"),
  /** RSS rows only: the feed URL (unique among rss rows). */
  feedUrl: text("feed_url"),
  /** RSS rows: the feed's own website (channel link) — the web shows its favicon. */
  siteUrl: text("site_url"),
  /** RSS conditional GET validators from the last 200 response. */
  httpEtag: text("http_etag"),
  httpLastModified: text("http_last_modified"),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  /** X's numeric user id, cached after the first lookup (saves a call per run). */
  xUserId: text("x_user_id"),
  enabled: boolean("enabled").notNull().default(true),
  notes: text("notes"),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  /** Highest tweet id seen — the next run asks only for newer ones. */
  lastSeenTweetId: text("last_seen_tweet_id"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  uniqHandle: uniqueIndex("news_sources_handle_uniq").on(t.handle),
  uniqFeed: uniqueIndex("news_sources_feed_url_uniq").on(t.feedUrl).where(sql`${t.kind} = 'rss'`),
}));

export const newsJobRunsTable = pgTable("news_job_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** 'schedule' | 'manual' */
  trigger: text("trigger").notNull(),
  triggeredBy: integer("triggered_by"),
  /** 'running' | 'success' | 'partial' | 'failed' | 'skipped' */
  status: text("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  accountsTotal: integer("accounts_total").notNull().default(0),
  accountsOk: integer("accounts_ok").notNull().default(0),
  fetched: integer("fetched").notNull().default(0),
  newItems: integer("new_items").notNull().default(0),
  published: integer("published").notNull().default(0),
  rejected: integer("rejected").notNull().default(0),
  duplicates: integer("duplicates").notNull().default(0),
  error: text("error"),
  log: jsonb("log").$type<NewsRunLogEntry[]>().notNull().default([]),
}, (t) => ({
  byStarted: index("news_job_runs_started_idx").on(t.startedAt),
  byStatus: index("news_job_runs_status_idx").on(t.status),
}));

export const newsItemsTable = pgTable("news_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").references(() => newsSourcesTable.id, { onDelete: "set null" }),
  /** The tweet id. Unique — the dedupe key across runs. */
  externalId: text("external_id").notNull(),
  url: text("url"),
  authorHandle: text("author_handle"),
  authorName: text("author_name"),
  authorAvatarUrl: text("author_avatar_url"),
  text: text("text").notNull(),
  lang: text("lang"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  media: jsonb("media").$type<NewsMedia[]>().notNull().default([]),
  metrics: jsonb("metrics").$type<NewsMetrics>(),
  aiRelevant: boolean("ai_relevant"),
  aiScore: integer("ai_score"),
  aiCategory: text("ai_category"),
  aiTitleAr: text("ai_title_ar"),
  aiTitleEn: text("ai_title_en"),
  aiSummaryAr: text("ai_summary_ar"),
  aiSummaryEn: text("ai_summary_en"),
  aiTags: text("ai_tags").array(),
  aiReason: text("ai_reason"),
  /** Failed AI reviews. At AI_MAX_ATTEMPTS the item is given up: hidden, never retried. */
  aiAttempts: integer("ai_attempts").notNull().default(0),
  /** Which filter judged it: 'ai' (Claude) | 'keyword' (free lexicon). NULL = not judged. */
  filterKind: text("filter_kind"),
  /** 'published' | 'rejected' | 'hidden' */
  status: text("status").notNull().default("hidden"),
  /**
   * Set when an admin changes the item by hand (PATCH: status, pin, category).
   * The re-score action skips these, so a filter change never undoes a human
   * decision. Added by 0063 (backfilled from the app log).
   */
  moderatedBy: integer("moderated_by"),
  moderatedAt: timestamp("moderated_at", { withTimezone: true }),
  pinned: boolean("pinned").notNull().default(false),
  runId: uuid("run_id").references(() => newsJobRunsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  uniqExternal: uniqueIndex("news_items_external_id_uniq").on(t.externalId),
  byFeed: index("news_items_feed_idx").on(t.status, t.pinned, t.postedAt),
  byCategory: index("news_items_category_idx").on(t.aiCategory),
  bySource: index("news_items_source_idx").on(t.sourceId),
  byCreated: index("news_items_created_idx").on(t.createdAt, t.id),
}));

/** Single row, id = 1. */
export const newsJobSettingsTable = pgTable("news_job_settings", {
  id: integer("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  /** 'HH:MM', Asia/Riyadh wall clock. */
  runTime: text("run_time").notNull().default("07:00"),
  /** 0 = Sunday … 6 = Saturday. */
  daysOfWeek: integer("days_of_week").array().notNull().default([0, 1, 2, 3, 4, 5, 6]),
  lookbackHours: integer("lookback_hours").notNull().default(36),
  maxPerAccount: integer("max_per_account").notNull().default(20),
  minScore: integer("min_score").notNull().default(60),
  extraInstructions: text("extra_instructions"),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer("updated_by"),
  // ── retention (0064) — see news.cleaner.ts ──
  /** Rejected items (and, with purgeDuplicates, stored duplicates) are deleted after this many hours. 1–168. */
  rejectedRetentionHours: integer("rejected_retention_hours").notNull().default(24),
  purgeDuplicates: boolean("purge_duplicates").notNull().default(true),
  /** Other hidden items (guard-held, AI gave up, admin-unmoderated) are deleted after this many days. 1–90. */
  hiddenRetentionDays: integer("hidden_retention_days").notNull().default(14),
  /** Run history rows (with their logs) are deleted after this many days. 7–365. */
  runsRetentionDays: integer("runs_retention_days").notNull().default(90),
  /** news_seen rows are kept this long after their item is gone. 7–180, ≥ lookback + 2 days. */
  seenRetentionDays: integer("seen_retention_days").notNull().default(30),
  lastCleanupAt: timestamp("last_cleanup_at", { withTimezone: true }),
  lastCleanupStats: jsonb("last_cleanup_stats").$type<NewsCleanupStats>(),
});

/** What the last cleanup removed (news_job_settings.last_cleanup_stats). */
export type NewsCleanupStats = {
  trigger: "hourly" | "run" | "manual";
  deleted: { rejected: number; duplicates: number; hidden: number; seen: number; runs: number };
  ms: number;
  /** trigger 'run': the run it followed. */
  runId?: string | null;
  error?: string | null;
};

/**
 * Every external_id the job has stored — kept after the item itself is
 * deleted, so the next run's dedupe still knows it. A purged rejected item is
 * therefore never stored, judged or counted again. See 0064.
 */
export const newsSeenTable = pgTable("news_seen", {
  externalId: text("external_id").primaryKey(),
  sourceId: uuid("source_id"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  /** 'stored' | 'duplicate' at insert; the cleaner sets 'rejected' | 'duplicate' | 'hidden'. */
  verdict: text("verdict"),
  /** When the cleaner deleted the item (null while it is stored). */
  purgedAt: timestamp("purged_at", { withTimezone: true }),
});

export type NewsSource = typeof newsSourcesTable.$inferSelect;
export type NewsItem = typeof newsItemsTable.$inferSelect;
export type NewsJobRun = typeof newsJobRunsTable.$inferSelect;
export type NewsJobSettings = typeof newsJobSettingsTable.$inferSelect;
export type NewsSeen = typeof newsSeenTable.$inferSelect;
