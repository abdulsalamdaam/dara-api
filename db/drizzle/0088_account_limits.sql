-- Account limits (Oct 2026): per-account overrides of the package limits,
-- paid/free add-ons on top of them, a per-account Ejar switch, and an audit
-- trail of every change with the effective value before and after.
--
--  * account_limit_overrides — an admin's replacement for the package base of
--    one limit (value NULL = unlimited). The Ejar switch is the row
--    limit_key = 'ejar.enabled' with value 1 (enabled) / 0 (disabled); no row
--    means the server default (EJAR_ACCESS).
--  * account_limit_addons — quantity added on top of base/override while
--    active (status 'active', starts_at <= now, ends_at NULL or in the future —
--    evaluated at read time, so expiry needs no job to take effect).
--  * account_limit_events — who changed what, old/new effective value.
--  * subscription_payments gains kind/addon_id/description so an add-on is
--    billed through the same Moyasar + SUB- invoice path as a subscription.
--
-- Additive and idempotent. Applied at boot after 0087 by src/database/bootstrap.ts.

CREATE TABLE IF NOT EXISTS account_limit_overrides (
  id serial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  limit_key text NOT NULL,
  value integer,
  note text NOT NULL,
  set_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS account_limit_overrides_account_key_uniq
  ON account_limit_overrides (account_id, limit_key);

ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'subscription';
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS addon_id integer;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS description text;
DO $$ BEGIN
  ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_kind_check CHECK (kind IN ('subscription', 'addon'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS account_limit_addons (
  id serial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  limit_key text NOT NULL,
  quantity integer NOT NULL,
  catalog_key text,
  period text NOT NULL DEFAULT 'subscription_period',
  starts_at timestamptz,
  ends_at timestamptz,
  status text NOT NULL DEFAULT 'pending_payment',
  activation text NOT NULL DEFAULT 'on_payment',
  source text NOT NULL,
  price_sar numeric(12, 2),
  payment_id integer REFERENCES subscription_payments(id) ON DELETE SET NULL,
  granted_by integer,
  note text,
  offer_expires_at timestamptz,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE account_limit_addons ADD CONSTRAINT account_limit_addons_quantity_check CHECK (quantity > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE account_limit_addons ADD CONSTRAINT account_limit_addons_period_check CHECK (period IN ('subscription_period', 'one_off'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE account_limit_addons ADD CONSTRAINT account_limit_addons_status_check
    CHECK (status IN ('offered', 'pending_payment', 'active', 'cancelled', 'expired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE account_limit_addons ADD CONSTRAINT account_limit_addons_activation_check CHECK (activation IN ('on_payment', 'immediate'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE account_limit_addons ADD CONSTRAINT account_limit_addons_source_check
    CHECK (source IN ('admin_free', 'admin_invoice', 'admin_offer', 'self_serve'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS account_limit_addons_account_key_status_idx
  ON account_limit_addons (account_id, limit_key, status);

DO $$ BEGIN
  ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_addon_id_fk
    FOREIGN KEY (addon_id) REFERENCES account_limit_addons(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS account_limit_events (
  id serial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id integer,
  actor_kind text NOT NULL,
  source text NOT NULL,
  limit_key text NOT NULL,
  old_value integer,
  new_value integer,
  addon_id integer,
  payment_id integer,
  note text,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE account_limit_events ADD CONSTRAINT account_limit_events_actor_kind_check CHECK (actor_kind IN ('admin', 'customer', 'system'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE account_limit_events ADD CONSTRAINT account_limit_events_source_check
    CHECK (source IN ('admin_override', 'addon_purchase', 'addon_grant', 'addon_offer', 'addon_cancel', 'addon_expiry', 'ejar_toggle', 'offer_auto'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS account_limit_events_account_created_idx
  ON account_limit_events (account_id, created_at DESC);
