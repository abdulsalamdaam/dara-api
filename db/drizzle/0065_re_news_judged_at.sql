-- Real-estate news: `judged_at` — when the item got its current verdict.
--
-- The retention cleaner used to age rejected / duplicate / hidden items by
-- `created_at`, so an item stored days ago but only judged now (an AI retry,
-- a re-score) was purged at once instead of after `rejected_retention_hours`.
-- It now ages them by `coalesce(judged_at, created_at)`. Every path that
-- writes a verdict or status sets `judged_at` (runner keyword + AI verdicts,
-- guard hold, AI give-up, stored near-duplicates, re-score, admin PATCH).
--
-- Backfill: every already-judged row gets `coalesce(updated_at, created_at)`.
-- Re-run on every boot (only rows still NULL), so an item judged by an older
-- container during a rolling deploy is covered too. Items still waiting for
-- the AI stay NULL.
--
-- Idempotent on purpose, like 0061–0064: `ensureSchema` runs it on every boot
-- after 0064. Additive only.

ALTER TABLE "news_items" ADD COLUMN IF NOT EXISTS "judged_at" timestamp with time zone;

UPDATE "news_items" SET "judged_at" = coalesce("updated_at", "created_at")
WHERE "judged_at" IS NULL
  AND ("ai_relevant" IS NOT NULL OR "status" <> 'hidden' OR "ai_attempts" >= 3 OR "moderated_at" IS NOT NULL);

-- The cleaner's candidate scan: purgeable statuses, by retention age.
CREATE INDEX IF NOT EXISTS "news_items_retention_age_idx" ON "news_items" ((coalesce("judged_at", "created_at")), "id")
  WHERE "status" IN ('rejected', 'hidden') AND "moderated_at" IS NULL AND "pinned" = false;
