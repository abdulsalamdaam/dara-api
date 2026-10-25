-- Rental offers (عروض التأجير) — Oct 2026. A formal, non-binding offer an
-- office issues to a prospective (usually corporate) tenant for one unit:
-- pricing, fees, schedule inputs and terms. A draft that precedes the Ejar
-- contract, never a contract itself — nothing else reads this table.
--
-- The unit is linked AND snapshotted: the printed offer must keep saying what
-- was offered even if the unit is later edited or deleted.
--
-- Additive and idempotent. Applied at boot by src/database/bootstrap.ts.

CREATE TABLE IF NOT EXISTS rental_offers (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by integer,
  number text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  title text,
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  valid_until date,
  unit_id integer REFERENCES units(id) ON DELETE SET NULL,
  property_id integer REFERENCES properties(id) ON DELETE SET NULL,
  unit_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  landlord_name text,
  client_name text NOT NULL,
  client_cr text,
  client_vat text,
  client_contact_name text,
  client_contact_title text,
  client_phone text,
  client_email text,
  client_address text,
  annual_rent numeric(14, 2) NOT NULL DEFAULT 0,
  duration_months integer NOT NULL DEFAULT 12,
  start_date date,
  payment_frequency text NOT NULL DEFAULT 'quarterly',
  vat_applies boolean NOT NULL DEFAULT false,
  escalation_percent numeric(6, 2) NOT NULL DEFAULT 0,
  free_months integer NOT NULL DEFAULT 0,
  deposit_amount numeric(14, 2) NOT NULL DEFAULT 0,
  commission_type text NOT NULL DEFAULT 'none',
  commission_value numeric(14, 2) NOT NULL DEFAULT 0,
  commission_vat boolean NOT NULL DEFAULT true,
  fees jsonb NOT NULL DEFAULT '[]'::jsonb,
  terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  language text NOT NULL DEFAULT 'ar',
  sent_at timestamptz,
  decided_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rental_offers_status_check CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'cancelled')),
  CONSTRAINT rental_offers_frequency_check CHECK (payment_frequency IN ('monthly', 'quarterly', 'semiannual', 'annual')),
  CONSTRAINT rental_offers_commission_check CHECK (commission_type IN ('none', 'percent', 'amount')),
  CONSTRAINT rental_offers_duration_check CHECK (duration_months BETWEEN 1 AND 360),
  CONSTRAINT rental_offers_free_months_check CHECK (free_months >= 0 AND free_months < duration_months)
);

-- Numbers are per account (RO-2026-0001) and never reused, deleted rows included.
CREATE UNIQUE INDEX IF NOT EXISTS rental_offers_user_number_uniq ON rental_offers (user_id, number);
CREATE INDEX IF NOT EXISTS rental_offers_user_created_idx ON rental_offers (user_id, created_at DESC) WHERE deleted_at IS NULL;
