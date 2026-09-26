-- Real-estate news: retention. Rejected news is not kept for longer than a day.
--
--  * news_seen: every external_id the job has ever stored. The run's dedupe
--    treats an id found here as already seen, so an item the cleaner deleted is
--    never stored, judged (Claude) or re-counted again. `purged_at` is set
--    when the cleaner removes the item; the seen row is kept for
--    `seen_retention_days` after that (or after first_seen_at if the item was
--    never purged and is gone), which must outlast the lookback window.
--  * news_job_settings gains the five retention settings and the last
--    cleanup's time and result.
--  * Backfill: every stored item's external_id. Re-run on every boot
--    (ON CONFLICT DO NOTHING), so an item stored by an older container during
--    a rolling deploy is covered too.
--
-- Idempotent on purpose, like 0061–0063: `ensureSchema` runs it on every boot
-- after 0063. Additive only.

CREATE TABLE IF NOT EXISTS "news_seen" (
  "external_id"   text PRIMARY KEY NOT NULL,
  "source_id"     uuid,
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- 'stored' | 'duplicate' at insert; the cleaner sets 'rejected' | 'duplicate' | 'hidden'.
  "verdict"       text,
  "purged_at"     timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "news_seen_age_idx" ON "news_seen" ((coalesce("purged_at", "first_seen_at")));

ALTER TABLE "news_job_settings" ADD COLUMN IF NOT EXISTS "rejected_retention_hours" integer NOT NULL DEFAULT 24;
ALTER TABLE "news_job_settings" ADD COLUMN IF NOT EXISTS "purge_duplicates" boolean NOT NULL DEFAULT true;
ALTER TABLE "news_job_settings" ADD COLUMN IF NOT EXISTS "hidden_retention_days" integer NOT NULL DEFAULT 14;
ALTER TABLE "news_job_settings" ADD COLUMN IF NOT EXISTS "runs_retention_days" integer NOT NULL DEFAULT 90;
ALTER TABLE "news_job_settings" ADD COLUMN IF NOT EXISTS "seen_retention_days" integer NOT NULL DEFAULT 30;
ALTER TABLE "news_job_settings" ADD COLUMN IF NOT EXISTS "last_cleanup_at" timestamp with time zone;
ALTER TABLE "news_job_settings" ADD COLUMN IF NOT EXISTS "last_cleanup_stats" jsonb;

-- The cleaner's candidate scan (status + age) and the runs sweep.
CREATE INDEX IF NOT EXISTS "news_items_created_idx" ON "news_items" ("created_at", "id");

INSERT INTO "news_seen" ("external_id", "source_id", "first_seen_at", "verdict")
SELECT "external_id", "source_id", "created_at", 'stored' FROM "news_items"
ON CONFLICT ("external_id") DO NOTHING;
