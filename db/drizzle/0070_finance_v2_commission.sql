-- Finance v2 (beta): the monthly management-commission run on the COLLECTED
-- basis and the commission transfer (the accountant's workbook, sheet
-- "قواعد القيود": فاتورة عمولة / تحويل عمولات; DESIGN §9 E1, Q6b, Q11).
--
-- Additive only: four new tables, nothing existing is altered. Applied at boot
-- by bootstrap.ts after 0069, in its own try/catch (a failure reads as "the
-- commission run is unavailable", never as a boot failure). Idempotent.

-- Per-account commission switches that are not in finance_settings (which
-- 0070 must not alter): the collected-basis CUTOVER date and the scheduled
-- month-end run. A missing row means: no cutover recorded (the run falls back
-- to the first day of the month the account was enabled) and auto-run on.
create table if not exists finance_commission_settings (
  account_user_id integer primary key,
  collected_from date,
  auto_run boolean not null default true,
  last_auto_month date,
  updated_by integer,
  updated_at timestamptz not null default now()
);

-- One row per (account, landlord, month) commission invoice. At most one LIVE
-- (status 'issued') row per key: that is the run's idempotency. A reversal
-- (commission credit note) marks the row 'reversed' and frees the key.
create table if not exists finance_commission_runs (
  id serial primary key,
  user_id integer not null,
  owner_id integer not null,
  month date not null check (extract(day from month) = 1),
  status text not null default 'issued' check (status in ('issued','reversed')),
  document_id integer,
  credit_document_id integer,
  collected numeric(14,2) not null,
  base numeric(14,2) not null,
  net numeric(14,2) not null check (net > 0),
  vat numeric(14,2) not null check (vat >= 0),
  total numeric(14,2) not null,
  vat_registered boolean not null,
  detail jsonb not null default '[]'::jsonb,
  origin text not null check (origin in ('manual','scheduled')),
  created_by integer,
  created_at timestamptz not null default now(),
  reversed_by integer,
  reversed_at timestamptz,
  reverse_reason text,
  unique (id, user_id)
);
create unique index if not exists finance_commission_runs_live_uq on finance_commission_runs (user_id, owner_id, month) where status = 'issued';
create index if not exists finance_commission_runs_month_idx on finance_commission_runs (user_id, month);

-- The ledger lines (collections moving 2122 → 2121, Ejar settlements) a run
-- counted. A line is counted by at most one live run, so a collection is never
-- charged commission twice and a line posted after its month's run (late, or
-- a reversal) is picked up by the next run.
create table if not exists finance_commission_run_items (
  run_id integer not null,
  user_id integer not null,
  line_id bigint not null,
  entry_id bigint not null,
  payment_id integer,
  property_id integer,
  gross numeric(14,2) not null,
  base numeric(14,2) not null,
  live boolean not null default true,
  primary key (run_id, line_id),
  foreign key (run_id, user_id) references finance_commission_runs (id, user_id)
);
create unique index if not exists finance_commission_run_items_live_uq on finance_commission_run_items (user_id, line_id) where live;

-- تحويل عمولات: commission moved from the client-money (trust) bank account to
-- the operating account. Posts Dr operating bank / Cr trust bank (rule E15T);
-- it never touches the landlord payable, so the landlord statement is unchanged.
create table if not exists finance_commission_transfers (
  id serial primary key,
  user_id integer not null,
  number text not null,
  transfer_date date not null,
  amount numeric(14,2) not null check (amount > 0),
  from_bank_account_id integer not null,
  to_bank_account_id integer not null,
  memo text,
  status text not null default 'posted' check (status in ('posted','void')),
  created_by integer,
  created_at timestamptz not null default now(),
  voided_by integer,
  voided_at timestamptz,
  void_reason text,
  unique (id, user_id),
  unique (user_id, number)
);
