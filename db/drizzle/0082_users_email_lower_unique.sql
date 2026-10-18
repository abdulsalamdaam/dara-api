-- One email, one account — case-insensitively (Oct 2026).
--
-- `users_email_unique` (from 0000) is a plain btree on `email`, so it is
-- case-sensitive: `A@x.com` and `a@x.com` could be two accounts. The API now
-- stores every email trimmed + lower-cased and looks it up by `lower(email)`
-- (src/common/user-email.ts); this index makes the database enforce the same
-- rule and serves those lookups.
--
-- Soft-deleted rows are deliberately NOT excluded: the old constraint never
-- excluded them either, and a deleted account keeps owning its address.
--
-- NOT applied at boot (not listed in src/database/bootstrap.ts). Apply by hand
-- per CLAUDE.md. Checked read-only on 2026-10-18: staging and production both
-- have zero case-insensitive duplicates and zero non-normalised emails, so it
-- builds cleanly on both. The DO block refuses with a clear message instead of
-- a bare unique-violation if that is no longer true when it runs.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users GROUP BY lower(btrim(email)) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'users has case-insensitive duplicate emails; resolve them before creating users_email_lower_unique';
  END IF;
END $$;

UPDATE users SET email = lower(btrim(email)) WHERE email <> lower(btrim(email));

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email));
