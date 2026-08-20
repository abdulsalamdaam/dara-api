-- 1. Trial subscriptions.
--
-- An admin can approve a registration with a free window instead of requiring
-- payment ("give them 30 days"). That already worked mechanically — status
-- active + an end date — but nothing recorded WHY the window was free, so a
-- trial was indistinguishable from a paid year in the admin list, in billing,
-- and in support. This flag is that distinction; it is cleared the moment a
-- real payment lands (see activateFromPaidRow).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "subscription_is_trial" boolean NOT NULL DEFAULT false;

-- 2. Party nationality (الجنسية), via the central lookups table.
--
-- `owners.nationality` was dropped in 0024 in favour of an FK, but no endpoint
-- ever wrote the FK, so landlords have had no nationality since. Tenants kept a
-- free-text column, which drifts ("سعودي" / "سعودية" / "Saudi" / "SA") and
-- cannot be filtered or reported on. Both now point at the `nationality`
-- lookup category, matching how property/unit type, city and region work.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "nationality_lookup_id" integer;

DO $$
BEGIN
  ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_nationality_lookup_id_lookups_id_fk"
    FOREIGN KEY ("nationality_lookup_id") REFERENCES "lookups"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Backfill the FK from the free-text column where it maps cleanly. Matches the
-- lookup key ("saudi") or its Arabic label ("سعودي"), case-insensitively, and
-- only against the global (company_id IS NULL) options. Anything unmatched
-- keeps its text and simply has no FK — the API falls back to the text.
UPDATE "tenants" t
SET "nationality_lookup_id" = l.id
FROM "lookups" l
WHERE t."nationality_lookup_id" IS NULL
  AND t."nationality" IS NOT NULL
  AND btrim(t."nationality") <> ''
  AND l."category" = 'nationality'
  AND l."company_id" IS NULL
  AND (lower(l."key") = lower(btrim(t."nationality")) OR l."label_ar" = btrim(t."nationality"));
