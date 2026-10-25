-- Rental offers follow the contract wizard's money rules (Oct 2026):
--  * payment cycle is quarterly / semi_annual / annual — the contract's own
--    keys (the offer used `semiannual`, and offered monthly);
--  * escalation is a yearly % OR a fixed SAR amount per year, like contracts;
--  * fees recur one_time / quarterly / semi_annual / annual (kept in the jsonb).
-- `free_months` is the grace period: rent starts that many months after the
-- lease start.
--
-- Idempotent; applied at boot after 0086 by src/database/bootstrap.ts. Only
-- staging rows exist, so the value rewrite is safe.

ALTER TABLE rental_offers ADD COLUMN IF NOT EXISTS escalation_type text NOT NULL DEFAULT 'percent';
ALTER TABLE rental_offers ADD COLUMN IF NOT EXISTS escalation_amount numeric(14, 2) NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE rental_offers ADD CONSTRAINT rental_offers_escalation_type_check CHECK (escalation_type IN ('percent', 'amount'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE rental_offers DROP CONSTRAINT IF EXISTS rental_offers_frequency_check;
UPDATE rental_offers SET payment_frequency = 'semi_annual' WHERE payment_frequency = 'semiannual';
UPDATE rental_offers SET payment_frequency = 'quarterly' WHERE payment_frequency = 'monthly';
ALTER TABLE rental_offers ADD CONSTRAINT rental_offers_frequency_check CHECK (payment_frequency IN ('quarterly', 'semi_annual', 'annual'));
