-- ════════════════════════════════════════════════════════════════════
-- Migration: store every Saudi mobile as the bare 9 digits (5XXXXXXXX).
--
-- The canonical stored form changed from `05XXXXXXXX` to the 9 significant
-- digits — no country code, no leading zero. `saudiPhone()` in
-- `src/common/validation.ts` now emits that form on every controller write;
-- this backfills the rows written before it.
--
-- Why it has to cover EVERY column, not just the login ones
-- ────────────────────────────────────────────────────────
-- Two joins are plain string equality:
--   * tenant portal   — contracts.tenant_phone = tenants.phone
--   * maintenance     — tenants.phone = contracts.tenant_phone
-- If one side is `+966502907100` and the other `502907100`, the tenant sees an
-- empty portal. Both columns must be normalised in the SAME transaction.
--
-- What it deliberately does NOT touch
-- ───────────────────────────────────
--   * phone_otp_tokens.phone — keyed by `PhoneOtpService.normalizePhone()`,
--     which is E.164 (`+966…`) by design. Rewriting it would orphan every
--     in-flight OTP and break `check()` outright.
--   * invoices.buyer_snapshot / seller_snapshot, simple_invoices.client —
--     snapshots of an issued (potentially ZATCA-signed) document. They record
--     what was invoiced; they are not join keys and must not be rewritten.
--   * *.ejar_raw — verbatim copies of Ejar API payloads, kept for audit.
--   * Anything that is not a recognisable Saudi mobile — a landline, a foreign
--     number, junk. Left exactly as found (see the report query at the bottom).
--
-- Idempotent: the WHERE clause only selects rows that are BOTH a recognisable
-- Saudi mobile AND not already canonical, so a second run updates 0 rows.
--
-- ⚠ HOW TO APPLY — this file does NOT run by itself.
-- `db/sql/*` is not executed at boot. Only `db/init.sql`, `db/data.sql` and the
-- inline statements in `src/database/bootstrap.ts` run automatically, and the
-- runtime image does not even copy `db/sql/`. To apply to production, run it by
-- hand against the production DB container:
--   docker exec -i <prod-db-container> psql -U postgres -d dara \
--     < db/sql/2026_08_phone_bare_9_digits.sql
-- (or paste it into a psql session). Alternatively, add its statements inline
-- to bootstrap.ts if it should run on every deploy — but a one-off backfill
-- does not need to.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- A value is a Saudi mobile if, once spaces/dashes/parentheses are stripped, it
-- is 5XXXXXXXX optionally prefixed by 0, 966 or +966. The canonical form is
-- then simply its last 9 digits.
CREATE OR REPLACE FUNCTION pg_temp.sa_mobile(v text) RETURNS boolean AS $$
  SELECT v IS NOT NULL
     AND regexp_replace(v, '[\s\-()]', '', 'g') ~ '^(\+?966)?0?5\d{8}$';
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION pg_temp.sa_core(v text) RETURNS text AS $$
  SELECT right(regexp_replace(v, '\D', '', 'g'), 9);
$$ LANGUAGE sql IMMUTABLE;

UPDATE users SET phone = pg_temp.sa_core(phone)
  WHERE pg_temp.sa_mobile(phone) AND phone <> pg_temp.sa_core(phone);

UPDATE tenants SET phone = pg_temp.sa_core(phone)
  WHERE pg_temp.sa_mobile(phone) AND phone <> pg_temp.sa_core(phone);

UPDATE tenants SET original_tenant_phone = pg_temp.sa_core(original_tenant_phone)
  WHERE pg_temp.sa_mobile(original_tenant_phone)
    AND original_tenant_phone <> pg_temp.sa_core(original_tenant_phone);

UPDATE owners SET phone = pg_temp.sa_core(phone)
  WHERE pg_temp.sa_mobile(phone) AND phone <> pg_temp.sa_core(phone);

UPDATE owners SET original_owner_phone = pg_temp.sa_core(original_owner_phone)
  WHERE pg_temp.sa_mobile(original_owner_phone)
    AND original_owner_phone <> pg_temp.sa_core(original_owner_phone);

-- Both sides of the tenant-portal / maintenance join, in the same transaction.
UPDATE contracts SET tenant_phone = pg_temp.sa_core(tenant_phone)
  WHERE pg_temp.sa_mobile(tenant_phone) AND tenant_phone <> pg_temp.sa_core(tenant_phone);

UPDATE contracts SET landlord_phone = pg_temp.sa_core(landlord_phone)
  WHERE pg_temp.sa_mobile(landlord_phone) AND landlord_phone <> pg_temp.sa_core(landlord_phone);

UPDATE companies SET company_phone = pg_temp.sa_core(company_phone)
  WHERE pg_temp.sa_mobile(company_phone) AND company_phone <> pg_temp.sa_core(company_phone);

UPDATE contact_submissions SET phone = pg_temp.sa_core(phone)
  WHERE pg_temp.sa_mobile(phone) AND phone <> pg_temp.sa_core(phone);

COMMIT;

-- ── Verification (read-only; run after the COMMIT) ───────────────────
-- Every phone value that is NOT now the canonical 9 digits. Each row here is
-- either a landline, a foreign number or junk — inspect, do not auto-fix.
--
-- WITH p AS (
--   SELECT 'users.phone' AS col, id, phone AS v FROM users
--   UNION ALL SELECT 'tenants.phone', id, phone FROM tenants
--   UNION ALL SELECT 'tenants.original_tenant_phone', id, original_tenant_phone FROM tenants
--   UNION ALL SELECT 'owners.phone', id, phone FROM owners
--   UNION ALL SELECT 'owners.original_owner_phone', id, original_owner_phone FROM owners
--   UNION ALL SELECT 'contracts.tenant_phone', id, tenant_phone FROM contracts
--   UNION ALL SELECT 'contracts.landlord_phone', id, landlord_phone FROM contracts
--   UNION ALL SELECT 'companies.company_phone', id, company_phone FROM companies
--   UNION ALL SELECT 'contact_submissions.phone', id, phone FROM contact_submissions
-- )
-- SELECT col, id, v FROM p WHERE v IS NOT NULL AND v <> '' AND v !~ '^5\d{8}$' ORDER BY 1, 2;
