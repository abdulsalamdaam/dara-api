-- Real-estate news v2: free sources and a free filter.
--
--  * news_sources gains RSS/Atom feeds next to X accounts: `kind` ('x' | 'rss'),
--    `feed_url` (unique per rss row), `site_url` (the feed's own website — the
--    web derives a favicon from it), and the conditional-GET validators
--    `http_etag` / `http_last_modified`. `handle` becomes nullable (rss rows
--    have none); the existing unique index on it keeps working because NULLs
--    never collide in a unique index. A CHECK keeps X rows with a handle and
--    RSS rows with a feed URL.
--  * news_items gains `filter_kind` ('ai' | 'keyword'): which filter judged the
--    item, so the admin UI can say "keyword" or "Claude". NULL = not judged
--    (awaiting review, or a stored near-duplicate).
--
-- Idempotent on purpose, like 0061: `ensureSchema` (src/database/bootstrap.ts)
-- runs this file on every boot after 0061. Additive only.

ALTER TABLE "news_sources" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'x';
ALTER TABLE "news_sources" ADD COLUMN IF NOT EXISTS "feed_url" text;
ALTER TABLE "news_sources" ADD COLUMN IF NOT EXISTS "site_url" text;
ALTER TABLE "news_sources" ADD COLUMN IF NOT EXISTS "http_etag" text;
ALTER TABLE "news_sources" ADD COLUMN IF NOT EXISTS "http_last_modified" text;
ALTER TABLE "news_sources" ALTER COLUMN "handle" DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "news_sources_feed_url_uniq" ON "news_sources" ("feed_url") WHERE "kind" = 'rss';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'news_sources_kind_chk') THEN
    ALTER TABLE "news_sources" ADD CONSTRAINT "news_sources_kind_chk" CHECK (
      ("kind" = 'x' AND "handle" IS NOT NULL) OR ("kind" = 'rss' AND "feed_url" IS NOT NULL)
    );
  END IF;
END $$;

ALTER TABLE "news_items" ADD COLUMN IF NOT EXISTS "filter_kind" text;
-- Everything judged before v2 was judged by Claude (a score only comes from a verdict).
UPDATE "news_items" SET "filter_kind" = 'ai' WHERE "filter_kind" IS NULL AND "ai_score" IS NOT NULL;
