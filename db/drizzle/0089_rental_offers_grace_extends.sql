-- Rental offers: the grace period EXTENDS the lease (Oct 2026).
-- A lease is now `free_months + duration_months` long and the full
-- `duration_months` of rent is billed after the grace, so the grace is no
-- longer bounded by the duration (0086 required free_months < duration_months)
-- — only by a sane cap of 36 months (the API and web enforce the same).
--
-- Offers store inputs only; schedule and totals are derived by the web, so
-- existing rows need no rewrite — they simply recompute under the new rule.
-- NOT VALID: a legacy staging row above the cap must not stop the boot; new
-- writes are checked.
--
-- Idempotent; applied at boot after 0087 by src/database/bootstrap.ts.

ALTER TABLE rental_offers DROP CONSTRAINT IF EXISTS rental_offers_free_months_check;
ALTER TABLE rental_offers DROP CONSTRAINT IF EXISTS rental_offers_grace_months_check;
ALTER TABLE rental_offers ADD CONSTRAINT rental_offers_grace_months_check CHECK (free_months BETWEEN 0 AND 36) NOT VALID;
