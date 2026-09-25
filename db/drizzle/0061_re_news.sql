-- Real-estate news: sources (X accounts), fetched + AI-filtered items, the
-- single-row job settings, and a run history with a per-run log.
--
-- Idempotent on purpose: `ensureSchema` (src/database/bootstrap.ts) runs this
-- file on every boot, so a deploy creates the tables with no manual step and a
-- re-run changes nothing. Additive only — no existing table is touched.
-- `gen_random_uuid()` is core Postgres since 13.

CREATE TABLE IF NOT EXISTS "news_sources" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "handle"             text NOT NULL,
  "display_name"       text,
  "avatar_url"         text,
  "x_user_id"          text,
  "enabled"            boolean NOT NULL DEFAULT true,
  "notes"              text,
  "last_fetched_at"    timestamp with time zone,
  "last_seen_tweet_id" text,
  "last_error"         text,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "news_sources_handle_uniq" ON "news_sources" ("handle");

CREATE TABLE IF NOT EXISTS "news_job_runs" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trigger"        text NOT NULL,
  "triggered_by"   integer,
  "status"         text NOT NULL DEFAULT 'running',
  "started_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at"    timestamp with time zone,
  "accounts_total" integer NOT NULL DEFAULT 0,
  "accounts_ok"    integer NOT NULL DEFAULT 0,
  "fetched"        integer NOT NULL DEFAULT 0,
  "new_items"      integer NOT NULL DEFAULT 0,
  "published"      integer NOT NULL DEFAULT 0,
  "rejected"       integer NOT NULL DEFAULT 0,
  "duplicates"     integer NOT NULL DEFAULT 0,
  "error"          text,
  "log"            jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS "news_job_runs_started_idx" ON "news_job_runs" ("started_at");
CREATE INDEX IF NOT EXISTS "news_job_runs_status_idx" ON "news_job_runs" ("status");

CREATE TABLE IF NOT EXISTS "news_items" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id"         uuid CONSTRAINT "news_items_source_id_news_sources_id_fk" REFERENCES "news_sources"("id") ON DELETE SET NULL,
  "external_id"       text NOT NULL,
  "url"               text,
  "author_handle"     text,
  "author_name"       text,
  "author_avatar_url" text,
  "text"              text NOT NULL,
  "lang"              text,
  "posted_at"         timestamp with time zone,
  "media"             jsonb NOT NULL DEFAULT '[]'::jsonb,
  "metrics"           jsonb,
  "ai_relevant"       boolean,
  "ai_score"          integer,
  "ai_category"       text,
  "ai_title_ar"       text,
  "ai_title_en"       text,
  "ai_summary_ar"     text,
  "ai_summary_en"     text,
  "ai_tags"           text[],
  "ai_reason"         text,
  "status"            text NOT NULL DEFAULT 'hidden',
  "pinned"            boolean NOT NULL DEFAULT false,
  "run_id"            uuid CONSTRAINT "news_items_run_id_news_job_runs_id_fk" REFERENCES "news_job_runs"("id") ON DELETE SET NULL,
  "created_at"        timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "news_items_external_id_uniq" ON "news_items" ("external_id");
CREATE INDEX IF NOT EXISTS "news_items_feed_idx" ON "news_items" ("status", "pinned", "posted_at");
CREATE INDEX IF NOT EXISTS "news_items_category_idx" ON "news_items" ("ai_category");
CREATE INDEX IF NOT EXISTS "news_items_source_idx" ON "news_items" ("source_id");

CREATE TABLE IF NOT EXISTS "news_job_settings" (
  "id"                 integer PRIMARY KEY NOT NULL,
  "enabled"            boolean NOT NULL DEFAULT true,
  "run_time"           text NOT NULL DEFAULT '07:00',
  "days_of_week"       integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  "lookback_hours"     integer NOT NULL DEFAULT 36,
  "max_per_account"    integer NOT NULL DEFAULT 20,
  "min_score"          integer NOT NULL DEFAULT 60,
  "extra_instructions" text,
  "next_run_at"        timestamp with time zone,
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by"         integer
);

-- The one settings row. next_run_at is left NULL: the scheduler computes it on
-- boot (Asia/Riyadh, run_time, days_of_week) — computing it in SQL would be a
-- second copy of that logic.
INSERT INTO "news_job_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
