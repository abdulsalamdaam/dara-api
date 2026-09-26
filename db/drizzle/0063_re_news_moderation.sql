-- Real-estate news: remember which items an admin moderated by hand.
--
--  * news_items gains `moderated_by` (users.id) and `moderated_at`: set by
--    PATCH /admin/news/items/:id (publish, hide, pin, recategorise). The
--    re-score action (POST /admin/news/rescore) never touches a moderated item,
--    so a filter change can not undo an admin's decision.
--  * Backfill: items moderated before these columns existed are found in the
--    app log (`news_item_moderated`, meta.id = the item id); the latest such
--    entry wins.
--
-- Idempotent on purpose, like 0061/0062: `ensureSchema` runs it on every boot
-- after 0062. Additive only.

ALTER TABLE "news_items" ADD COLUMN IF NOT EXISTS "moderated_by" integer;
ALTER TABLE "news_items" ADD COLUMN IF NOT EXISTS "moderated_at" timestamp with time zone;

DO $$
BEGIN
  IF to_regclass('app_logs') IS NOT NULL THEN
    UPDATE "news_items" n
       SET "moderated_at" = l.at, "moderated_by" = l.user_id
      FROM (
        SELECT DISTINCT ON (meta->>'id') meta->>'id' AS item_id, created_at AS at, user_id
          FROM app_logs
         WHERE event = 'news_item_moderated' AND meta ? 'id'
         ORDER BY meta->>'id', created_at DESC
      ) l
     WHERE n."moderated_at" IS NULL AND n."id"::text = l.item_id;
  END IF;
END $$;
