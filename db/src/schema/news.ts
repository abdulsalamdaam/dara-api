import {
  pgTable, text, uuid, boolean, integer, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Real-estate news — a daily job pulls posts from admin-managed X accounts, a
 * Claude filter keeps the Saudi real-estate ones and writes a bilingual title +
 * summary, and landlords read the result as a feed.
 *
 * Four tables, all owned by `src/modules/news`. Created by
 * `db/drizzle/0061_re_news.sql`, which `ensureSchema` also runs on every boot
 * (it is idempotent), so a deploy needs no manual SQL.
 */

export type NewsMedia = { type: string; url: string | null; preview_url: string | null };
export type NewsMetrics = { likes: number; retweets: number; replies: number; views: number | null };
export type NewsRunLogEntry = { at: string; level: "info" | "warn" | "error"; message: string; handle?: string };

/** One X account the job reads. `handle` is stored normalised: no @, lowercase. */
export const newsSourcesTable = pgTable("news_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  handle: text("handle").notNull(),
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
  /** 'published' | 'rejected' | 'hidden' */
  status: text("status").notNull().default("hidden"),
  pinned: boolean("pinned").notNull().default(false),
  runId: uuid("run_id").references(() => newsJobRunsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  uniqExternal: uniqueIndex("news_items_external_id_uniq").on(t.externalId),
  byFeed: index("news_items_feed_idx").on(t.status, t.pinned, t.postedAt),
  byCategory: index("news_items_category_idx").on(t.aiCategory),
  bySource: index("news_items_source_idx").on(t.sourceId),
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
});

export type NewsSource = typeof newsSourcesTable.$inferSelect;
export type NewsItem = typeof newsItemsTable.$inferSelect;
export type NewsJobRun = typeof newsJobRunsTable.$inferSelect;
export type NewsJobSettings = typeof newsJobSettingsTable.$inferSelect;
