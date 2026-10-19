-- Externally-settled installments: count them or skip them, per contract
-- (Oct 2026). An existing contract added with "earlier rent was collected
-- outside the platform", or an Ejar import whose invoices were already paid,
-- has installments stored `settled_external`. Until now they always counted:
-- due + collected in the operational reports, and booked by the finance-v2
-- recognizer (E02 + E33). The landlord now chooses:
--   'count' — today's behaviour (the default, so every existing contract keeps it);
--   'skip'  — they stay in the payment schedule only: left out of the reports
--             and KPIs, and never posted to the ledger.
--
-- Additive, NOT NULL with a default, guarded by a CHECK. Applied at boot by
-- src/database/bootstrap.ts (idempotent).

ALTER TABLE contracts ADD COLUMN IF NOT EXISTS external_settlement_mode text NOT NULL DEFAULT 'count';

DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_external_settlement_mode_check
    CHECK (external_settlement_mode IN ('count', 'skip'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
