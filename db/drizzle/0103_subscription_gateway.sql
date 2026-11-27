-- 0103: which payment gateway a subscription payment went through (28 Nov 2026).
--
-- Dara takes subscription payments through Moyasar today. Dhamen (Elm) is being
-- trialled on staging as a second gateway: an embedded card / mada / Apple Pay
-- widget, opened per account with BILLING_DHAMEN_ENABLED / BILLING_DHAMEN_USERS.
--
-- subscription_payments:
--   gateway             'moyasar' (default — every existing row) | 'dhamen'
--   gateway_ref         our paymentReferenceId at Dhamen (unique, ≤ 50 chars)
--   gateway_invoice_id  Dhamen's hashed invoice id, what the widget mounts
--
-- Idempotent: safe to run on every boot (bootstrap.ts).

ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS gateway text NOT NULL DEFAULT 'moyasar';
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS gateway_ref text;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS gateway_invoice_id text;
CREATE UNIQUE INDEX IF NOT EXISTS subscription_payments_gateway_ref_uq ON subscription_payments (gateway_ref) WHERE gateway_ref IS NOT NULL;
