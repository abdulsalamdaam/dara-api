-- Mark the landlord / tenant row that IS the account holder.
--
-- The settings profile has to bind to the account's own record. It used to take
-- the newest row in the list, which broke the moment an Ejar import inserted
-- landlords and tenants for the parties on the imported contracts. `is_default`
-- is not a safe substitute: it means "new properties auto-link to this
-- landlord", it is a user preference, and the user can move it onto an imported
-- row at any time — which would hand the imported party's data to the profile.
--
-- This flag is server-owned. It is absent from every controller field
-- allowlist, so no request body can set, move or clear it.

ALTER TABLE "owners"  ADD COLUMN IF NOT EXISTS "is_account_holder" boolean NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "is_account_holder" boolean NOT NULL DEFAULT false;

-- Backfill for accounts created before the flag existed: the account's own
-- record is the OLDEST one it did not import from Ejar. Same rule the portal
-- fell back to, made durable. Accounts whose every landlord came from Ejar
-- (a managing office that only ever imported) correctly get none.
WITH first_own AS (
  SELECT DISTINCT ON (user_id) id
  FROM "owners"
  WHERE "deleted_at" IS NULL AND "ejar_source" IS NULL
  ORDER BY user_id, created_at ASC, id ASC
)
UPDATE "owners" SET "is_account_holder" = true
WHERE id IN (SELECT id FROM first_own);

WITH first_own AS (
  SELECT DISTINCT ON (user_id) id
  FROM "tenants"
  WHERE "deleted_at" IS NULL AND "ejar_source" IS NULL
  ORDER BY user_id, created_at ASC, id ASC
)
UPDATE "tenants" SET "is_account_holder" = true
WHERE id IN (SELECT id FROM first_own);

-- Exactly one per account (soft-deleted rows excluded, mirroring
-- owners_one_default_per_user).
CREATE UNIQUE INDEX IF NOT EXISTS "owners_one_account_holder_per_user"
  ON "owners" ("user_id")
  WHERE "is_account_holder" = true AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "tenants_one_account_holder_per_user"
  ON "tenants" ("user_id")
  WHERE "is_account_holder" = true AND "deleted_at" IS NULL;
