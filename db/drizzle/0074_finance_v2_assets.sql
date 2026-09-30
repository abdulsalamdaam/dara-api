-- Finance v2 (beta): fixed-asset register, depreciation run log, and the
-- chart's external account codes (the accountant's round, agent E).
-- Design: docs/finance-v2/DESIGN.md §8.5.
--
-- Same rules as 0066–0069 (DESIGN §1.4 point 7, §2.2):
--  * ADDITIVE ONLY: new tables and indexes; it alters nothing, not even the
--    0066–0069 tables (CI rejects ALTER TABLE on a table this file did not create).
--    The external code of an account is a 1:1 side table, not a column on `accounts`.
--  * IDEMPOTENT: `ensureSchema` (src/database/bootstrap.ts) runs it on every
--    boot, after 0069.
--  * No FK to any legacy table. One simple-query message = one transaction.
--  * No immutability triggers: the register is a working record; the ledger
--    entries it produces (source_type `fixed_asset`) are the immutable record.
--    The account purge deletes these rows from code (hooks.service purgeAccount).

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Name-collision guard (as in 0066–0069).
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  expected jsonb := jsonb_build_object(
    'fixed_assets', '["id","user_id","number","name_ar","name_en","category","property_id","acquisition_date","cost","salvage_value","useful_life_months","method","depreciation_start","opening_accumulated","asset_account_id","accum_account_id","expense_account_id","acquisition_mode","acquisition_bank_account_id","status","disposed_on","disposal_proceeds","disposal_bank_account_id","disposal_note","disposed_by","disposed_at","voided_on","voided_by","voided_at","void_reason","notes","created_by","created_at","updated_at"]'::jsonb,
    'fixed_asset_dep_runs', '["id","user_id","month","trigger","run_by","run_at","assets","queued","total"]'::jsonb,
    'account_external_codes', '["account_id","user_id","external_code","updated_by","updated_at"]'::jsonb
  );
  t text;
  missing text[];
begin
  for t in select jsonb_object_keys(expected) loop
    if exists (select 1 from information_schema.tables
                where table_schema = current_schema() and table_name = t) then
      select array_agg(c) into missing
        from jsonb_array_elements_text(expected -> t) as c
       where c not in (select column_name from information_schema.columns
                        where table_schema = current_schema() and table_name = t);
      if missing is not null then
        raise exception 'fv2: table %.% already exists and is not the Finance v2 table (missing columns: %)',
          current_schema(), t, array_to_string(missing, ', ');
      end if;
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Fixed-asset register (سجل الأصول الثابتة). Straight line only.
--    Depreciable base = cost − salvage − opening_accumulated, spread over
--    useful_life_months counted from depreciation_start (pro-rata by day in the
--    first month). useful_life_months = 0 → not depreciated (land).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists fixed_assets (
  id serial primary key,
  user_id integer not null,
  number text not null,                              -- FA-######, per account
  name_ar text not null,
  name_en text,
  category text not null check (category in ('buildings','land','furniture','equipment','computers','vehicles','software','other')),
  property_id integer,                               -- optional link (property profitability); no FK: legacy table
  acquisition_date date not null,
  cost numeric(14,2) not null check (cost > 0),
  salvage_value numeric(14,2) not null default 0 check (salvage_value >= 0),
  useful_life_months integer not null check (useful_life_months between 0 and 1200),
  method text not null default 'straight_line' check (method = 'straight_line'),
  depreciation_start date not null,
  opening_accumulated numeric(14,2) not null default 0 check (opening_accumulated >= 0),
  asset_account_id integer not null,                 -- accounts.id (cost)
  accum_account_id integer,                          -- accounts.id (contra); null only when not depreciated
  expense_account_id integer,                        -- accounts.id (depreciation expense); null only when not depreciated
  acquisition_mode text not null default 'none' check (acquisition_mode in ('none','bank')),
  acquisition_bank_account_id integer,               -- bank_accounts.id when acquisition_mode = 'bank'
  status text not null default 'active' check (status in ('active','disposed','void')),
  disposed_on date,
  disposal_proceeds numeric(14,2) check (disposal_proceeds is null or disposal_proceeds >= 0),
  disposal_bank_account_id integer,
  disposal_note text,
  disposed_by integer,
  disposed_at timestamptz,
  voided_on date,
  voided_by integer,
  voided_at timestamptz,
  void_reason text,
  notes text,
  created_by integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (salvage_value + opening_accumulated <= cost),
  check (depreciation_start >= acquisition_date),
  check (useful_life_months = 0 or (accum_account_id is not null and expense_account_id is not null)),
  check (status <> 'disposed' or disposed_on is not null),
  check (disposed_on is null or disposed_on >= acquisition_date),
  unique (user_id, number),
  unique (id, user_id)
);
create index if not exists fixed_assets_user_idx on fixed_assets (user_id, status, id);
create index if not exists fixed_assets_property_idx on fixed_assets (user_id, property_id) where property_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Depreciation run log: who ran which month and what it queued. The entries
--    themselves are keyed `fixed_asset,<id>,dep:YYYY-MM` in the outbox/journal,
--    so a repeated run queues nothing (idempotent per asset and month).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists fixed_asset_dep_runs (
  id serial primary key,
  user_id integer not null,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  trigger text not null check (trigger in ('auto','manual')),
  run_by integer,
  run_at timestamptz not null default now(),
  assets integer not null default 0,
  queued integer not null default 0,
  total numeric(14,2) not null default 0
);
create index if not exists fixed_asset_dep_runs_user_idx on fixed_asset_dep_runs (user_id, run_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. External account code (كود النظام الخارجي) per chart account, for the
--    journal export. Many Dara accounts may map to one external code.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists account_external_codes (
  account_id integer primary key references accounts (id) on delete cascade,
  user_id integer not null,
  external_code text not null check (length(external_code) between 1 and 50),
  updated_by integer,
  updated_at timestamptz not null default now()
);
create index if not exists account_external_codes_user_idx on account_external_codes (user_id);
