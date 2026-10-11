-- Ejar Import v2: saved two-call lookups (staging, Oct 2026).
--
-- One row per (account, contract number): the raw Invoices and Details bodies
-- of the last lookup, so the import — and any repeat lookup inside
-- EJAR_LOOKUP_CACHE_HOURS — never calls Ejar again. `account_id` is the scope
-- owner (scopeId), `looked_up_by` the user who spent the calls.
--
-- Applied at boot by src/database/bootstrap.ts in its own try/catch.
-- Idempotent and additive only.

create table if not exists ejar_lookups (
  id serial primary key,
  account_id integer not null references users(id) on delete cascade,
  contract_number text not null,
  ejar_uuid text not null,
  invoices_body jsonb,
  details_body jsonb,
  looked_up_by integer,
  created_at timestamptz not null default now()
);

create unique index if not exists ejar_lookups_account_contract_uniq
  on ejar_lookups (account_id, contract_number);

-- The lookup budget sums ejar_api_logs.attempts per endpoint over a window.
create index if not exists ejar_api_logs_endpoint_created_idx
  on ejar_api_logs (endpoint, created_at);
