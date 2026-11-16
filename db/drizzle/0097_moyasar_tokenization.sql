-- 0097: recurring subscription billing with Moyasar tokens (16 Nov 2026).
--
-- The first payment is made in-app with `save_card: true`; Moyasar returns a
-- token (`source.token`) we keep in `payment_methods`. Renewals charge that
-- token from the server (`POST /v1/payments`, source type `token`). No card
-- data is ever stored — only Moyasar's token id and the display fields.
--
-- users:
--   auto_renew                 renew automatically on `next_billing_at`
--   default_payment_method_id  the token renewals charge
--   next_billing_at            when the renewal job next tries (the period end,
--                              or the next dunning retry). NULL = nothing due.
--   billing_state              ok | past_due | canceled
--   billing_failed_attempts    failed renewal attempts for the current period
--
-- subscription_payments:
--   charge_type   invoice (hosted invoice link, the old flow) | checkout (first
--                 in-app payment that saves the card) | renewal (token charge)
--   renewal_of    the subscription end a renewal row pays for. Unique per
--                 account: one billing period can only ever have one renewal
--                 row, so overlapping or retried job runs cannot charge twice.
--   moyasar_given_id  the UUID sent as Moyasar `given_id` for the current
--                 attempt. Moyasar answers a repeat of the same id with the
--                 existing payment instead of charging again.
--
-- Idempotent: safe to run on every boot (bootstrap.ts).

CREATE TABLE IF NOT EXISTS payment_methods (
  id                serial PRIMARY KEY,
  user_id           integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  moyasar_token_id  text NOT NULL,
  type              text NOT NULL DEFAULT 'card',      -- card | applepay | samsungpay
  brand             text,                              -- visa | master | mada | amex | ...
  last4             text,
  exp_month         integer,
  exp_year          integer,
  name              text,
  status            text NOT NULL DEFAULT 'initiated', -- initiated | active | inactive | expired | deleted
  is_default        boolean NOT NULL DEFAULT false,
  -- live: the Moyasar environment the token lives in (a test token is unusable with a live key)
  live              boolean,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_token_unique ON payment_methods (moyasar_token_id);
CREATE INDEX IF NOT EXISTS payment_methods_user_idx ON payment_methods (user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_renew boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS default_payment_method_id integer;
ALTER TABLE users ADD COLUMN IF NOT EXISTS next_billing_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_state text NOT NULL DEFAULT 'ok';
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_failed_attempts integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS users_next_billing_idx ON users (next_billing_at) WHERE auto_renew AND next_billing_at IS NOT NULL;

ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS charge_type text NOT NULL DEFAULT 'invoice';
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS payment_method_id integer;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS renewal_of timestamptz;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS moyasar_given_id text;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS failure_reason text;
CREATE UNIQUE INDEX IF NOT EXISTS subscription_payments_renewal_unique
  ON subscription_payments (user_id, renewal_of) WHERE charge_type = 'renewal';
CREATE UNIQUE INDEX IF NOT EXISTS subscription_payments_given_id_unique
  ON subscription_payments (moyasar_given_id) WHERE moyasar_given_id IS NOT NULL;
