-- Finance v2 (beta): the per-account flag, the chart of accounts, the general
-- ledger and its side tables. Design: docs/finance-v2/DESIGN.md §1, §2, §3.
--
-- Rules this file keeps (DESIGN §1.4 point 7, §2.2):
--  * ADDITIVE ONLY. It creates new tables, functions, triggers and indexes and
--    alters NOTHING that existed before it. Every trigger attaches to a table
--    created here. CI greps this file for ALTER TABLE on existing tables.
--  * IDEMPOTENT. `ensureSchema` (src/database/bootstrap.ts) runs it on every
--    boot: create ... if not exists, create or replace function,
--    drop trigger if exists + create trigger.
--  * No FK to any legacy table (users, contracts, payments ...): posted
--    history must survive the legacy hard deletes (DESIGN §2.3 conventions).
--  * The whole file is one simple-query message, so Postgres runs it in one
--    implicit transaction: it applies completely or not at all. If it fails,
--    finance_settings does not exist and the flag reads off (DESIGN §1.4.8).
--
-- The chart-of-accounts template itself lives in code
-- (src/modules/finance-v2/coa-template.ts) and is seeded per account on the
-- first enable, not here.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Name-collision guard (DESIGN §2.2 point 3).
--    The live DB was built with `push`. If a table with one of these generic
--    names already exists and is NOT ours, `create table if not exists` would
--    silently keep the foreign table. Refuse instead: an existing table must
--    carry every column this file expects (a superset is fine, so a later
--    additive migration of a v2 table does not break the re-run).
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  expected jsonb := jsonb_build_object(
    'finance_settings', '["account_user_id","finance_v2_enabled","accounting_mode","fiscal_year_start_month","vat_filing_frequency","default_bank_account_id","default_cash_account_id","agency_collections_to_trust","commission_basis","deposit_forfeit_vat","ledger_go_live_date","ledger_started_at","defer_rent_straight_line","input_vat_method","enabled_at","enabled_by","created_at","updated_at"]'::jsonb,
    'finance_settings_events', '["id","account_user_id","actor_user_id","field","old_value","new_value","reason","created_at"]'::jsonb,
    'accounts', '["id","user_id","code","name_ar","name_en","type","normal_balance","parent_id","system_key","is_group","is_active","is_template","bank_account_id","description","created_by","created_at","updated_at"]'::jsonb,
    'fiscal_periods', '["id","user_id","fiscal_year","period_no","starts_on","ends_on","status","vat_locked_at","closed_at","closed_by","reopened_at","reopened_by","reopen_reason"]'::jsonb,
    'journal_entries', '["id","user_id","entry_no","entry_date","original_date","period_id","is_late","origin","source_type","source_id","event","memo","status","reversal_of","reversed_by","reversed_at","total","payload","warnings","created_by","posted_at"]'::jsonb,
    'journal_lines', '["id","entry_id","user_id","line_no","entry_date","account_id","debit","credit","memo","owner_id","property_id","unit_id","tenant_id","contract_id","payment_id","document_id","bank_account_id","vat_category","vat_rate","vat_base","tax_role","seller_key","doc_class"]'::jsonb,
    'ledger_outbox', '["id","user_id","source_type","source_id","event","occurred_on","origin","payload","status","attempts","next_attempt_at","last_error","last_error_code","skip_reason","entry_id","backfill_run_id","created_at","processed_at","dismissed_by","dismissed_reason"]'::jsonb,
    'bank_accounts', '["id","user_id","kind","name_ar","name_en","bank_name","iban","account_number","currency","is_trust","is_default","is_active","gl_account_id","opening_balance","created_by","created_at","updated_at"]'::jsonb,
    'finance_collection_meta', '["collection_id","user_id","bank_account_id","method_detail","settled_by_deduction","classification","date_defaulted_utc","created_at"]'::jsonb,
    'finance_expense_details', '["expense_id","user_id","revision","expense_on","gross_amount","net_amount","vat_rate","vat_amount","vat_category","vat_recoverable","supplier_name","supplier_vat_number","supplier_invoice_no","supplier_invoice_date","attachment_key","bank_account_id","charge_to","gl_account_id","updated_by","created_at","updated_at"]'::jsonb,
    'finance_expense_category_map', '["user_id","category","account_id"]'::jsonb,
    'finance_payout_meta', '["payout_id","user_id","paid_on","bank_account_id","created_at"]'::jsonb,
    'finance_deposit_refunds', '["id","user_id","contract_id","tenant_id","owner_id","voucher_ids","amount","refunded_on","bank_account_id","method","reference","number","created_by","created_at"]'::jsonb,
    'finance_installment_charges', '["payment_id","generation","user_id","charged_on","charged_by","document_id","amount","vat_amount","entry_id","reversed_at","reversed_reason"]'::jsonb,
    'finance_installment_vat_points', '["collection_id","payment_id","user_id","vat_booked","booked_on","entry_id"]'::jsonb,
    'tenant_credit_actions', '["id","user_id","tenant_id","contract_id","owner_id","kind","amount","action_on","target_document_id","source_document_id","bank_account_id","method","reference","number","status","created_by","created_at"]'::jsonb,
    'finance_write_offs', '["id","user_id","tenant_id","contract_id","owner_id","payment_ids","document_ids","amount","written_off_on","reason","created_by","approved_by","created_at"]'::jsonb,
    'finance_ejar_settlements', '["payment_id","user_id","reported_status","reported_amount","imported_at"]'::jsonb,
    'manual_journals', '["id","user_id","kind","status","entry_date","memo","attachment_key","lines","created_by","submitted_at","approved_by","approved_at","rejected_by","rejected_reason","posted_entry_id","created_at","updated_at"]'::jsonb,
    'finance_backfill_runs', '["id","user_id","actor_user_id","mode","dry_run","cutover_date","started_at","finished_at","status","summary"]'::jsonb,
    'finance_contract_dims', '["contract_id","user_id","owner_id","property_id","unit_ids","ended_on","captured_at"]'::jsonb,
    'finance_vat_return_drafts', '["id","user_id","seller_key","period_start","period_end","box14","box15","locked_at","locked_by"]'::jsonb
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
-- 1. The flag and per-account settings (DESIGN §2.3.1). A missing row = off.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists finance_settings (
  account_user_id         integer primary key,            -- = scopeId(); no FK
  finance_v2_enabled      boolean not null default false,
  accounting_mode         text check (accounting_mode in ('owner','manager')),
  fiscal_year_start_month smallint not null default 1 check (fiscal_year_start_month between 1 and 12),
  vat_filing_frequency    text not null default 'quarterly' check (vat_filing_frequency in ('monthly','quarterly')),
  default_bank_account_id integer,
  default_cash_account_id integer,
  agency_collections_to_trust boolean not null default false,
  commission_basis        text not null default 'billed' check (commission_basis in ('billed','collected')),
  deposit_forfeit_vat     text not null default 'O' check (deposit_forfeit_vat in ('O','S','E')),
  ledger_go_live_date     date,
  ledger_started_at       timestamptz,
  defer_rent_straight_line boolean not null default true,
  input_vat_method        text not null default 'direct_plus_ratio' check (input_vat_method in ('direct_plus_ratio','direct_only')),
  enabled_at timestamptz, enabled_by integer,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists finance_settings_events (
  id bigserial primary key, account_user_id integer not null, actor_user_id integer not null,
  field text not null, old_value jsonb, new_value jsonb, reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists finance_settings_events_acct_idx on finance_settings_events (account_user_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Chart of accounts (DESIGN §2.3.2)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists accounts (
  id serial primary key,
  user_id integer not null,
  code text not null check (code ~ '^[0-9]{4,8}$'),
  name_ar text not null, name_en text not null,
  type text not null check (type in ('asset','liability','equity','revenue','expense')),
  normal_balance text not null check (normal_balance in ('debit','credit')),
  parent_id integer references accounts(id),
  system_key text,
  is_group boolean not null default false,
  is_active boolean not null default true,
  is_template boolean not null default false,
  bank_account_id integer,
  description text,
  created_by integer, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, code),
  unique (id, user_id)
);
create unique index if not exists accounts_system_key_uq on accounts (user_id, system_key) where system_key is not null;
create index if not exists accounts_parent_idx on accounts (user_id, parent_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Fiscal periods (DESIGN §2.3.3)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists fiscal_periods (
  id serial primary key, user_id integer not null,
  fiscal_year integer not null, period_no smallint not null check (period_no between 1 and 12),
  starts_on date not null, ends_on date not null check (ends_on >= starts_on),
  status text not null default 'open' check (status in ('open','closed','locked')),
  vat_locked_at timestamptz,
  closed_at timestamptz, closed_by integer, reopened_at timestamptz, reopened_by integer, reopen_reason text,
  unique (user_id, fiscal_year, period_no), unique (user_id, starts_on), unique (id, user_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. General ledger (DESIGN §2.3.4)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists journal_entries (
  id bigserial primary key,
  user_id integer not null,
  entry_no text not null,
  entry_date date not null,
  original_date date not null,
  period_id integer not null,
  is_late boolean not null default false,
  origin text not null check (origin in ('auto','backfill','manual','opening','closing','reversal')),
  source_type text not null,
  source_id bigint not null,
  event text not null,
  memo text,
  status text not null default 'posted' check (status in ('posted','reversed')),
  reversal_of bigint references journal_entries(id),
  reversed_by bigint references journal_entries(id),
  reversed_at timestamptz,
  total numeric(14,2) not null check (total > 0),
  payload jsonb not null default '{}'::jsonb,
  warnings text[] not null default '{}',
  created_by integer,
  posted_at timestamptz not null default now(),
  foreign key (period_id, user_id) references fiscal_periods (id, user_id),
  unique (id, user_id)
);
create unique index if not exists journal_entries_idem_uq  on journal_entries (user_id, source_type, source_id, event);
create unique index if not exists journal_entries_no_uq    on journal_entries (user_id, entry_no);
create unique index if not exists journal_entries_one_opening on journal_entries (user_id) where origin = 'opening' and status = 'posted';
create index if not exists journal_entries_date_idx on journal_entries (user_id, entry_date);
create index if not exists journal_entries_source_idx on journal_entries (user_id, source_type, source_id);

create table if not exists journal_lines (
  id bigserial primary key,
  entry_id bigint not null,
  user_id integer not null,
  line_no smallint not null,
  entry_date date not null,
  account_id integer not null,
  debit  numeric(14,2) not null default 0 check (debit  >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  memo text,
  owner_id integer, property_id integer, unit_id integer, tenant_id integer, contract_id integer,
  payment_id integer,
  document_id integer,
  bank_account_id integer,
  vat_category char(1) check (vat_category in ('S','Z','E','O')),
  vat_rate numeric(5,2),
  vat_base numeric(14,2),
  tax_role text check (tax_role in ('output','input','input_nonrecoverable')),
  seller_key text,
  doc_class text check (doc_class in ('invoice','debit','credit','charge','charge_cancel','advance','rent_receipt','expense','other')),
  check ((debit > 0) <> (credit > 0)),
  foreign key (entry_id, user_id)   references journal_entries (id, user_id),
  foreign key (account_id, user_id) references accounts (id, user_id),
  unique (entry_id, line_no)
);
create index if not exists journal_lines_acct_date_idx on journal_lines (user_id, account_id, entry_date);
create index if not exists journal_lines_tenant_idx   on journal_lines (user_id, tenant_id, entry_date)   where tenant_id is not null;
create index if not exists journal_lines_owner_idx    on journal_lines (user_id, owner_id, entry_date)    where owner_id is not null;
create index if not exists journal_lines_property_idx on journal_lines (user_id, property_id, entry_date) where property_id is not null;
create index if not exists journal_lines_contract_idx on journal_lines (user_id, contract_id)             where contract_id is not null;
create index if not exists journal_lines_payment_idx  on journal_lines (user_id, payment_id)              where payment_id is not null;
create index if not exists journal_lines_vat_idx      on journal_lines (user_id, seller_key, entry_date)  where tax_role is not null or vat_category is not null;
create index if not exists journal_lines_entry_idx    on journal_lines (entry_id);
create index if not exists journal_lines_account_idx  on journal_lines (account_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Posting queue / posting-errors list (DESIGN §2.3.5)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists ledger_outbox (
  id bigserial primary key,
  user_id integer not null,
  source_type text not null, source_id bigint not null, event text not null,
  occurred_on date not null,
  origin text not null default 'live' check (origin in ('live','backfill','recognizer','repair')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','posted','skipped','failed','dismissed')),
  attempts smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text, last_error_code text,
  skip_reason text,
  entry_id bigint,
  backfill_run_id integer,
  created_at timestamptz not null default now(), processed_at timestamptz,
  dismissed_by integer, dismissed_reason text
);
-- blocked_on (DESIGN §5.3/§5.4): the outbox row this pending row waits for (a
-- reversal whose original is not posted, or a charge-state event behind an
-- earlier failed/pending event on the same installment). Added with ALTER so a
-- database that already ran the first version of this block gains it on the
-- next boot; ledger_outbox is created above, in this file.
alter table ledger_outbox add column if not exists blocked_on bigint;
create unique index if not exists ledger_outbox_idem_uq on ledger_outbox (user_id, source_type, source_id, event);
create index if not exists ledger_outbox_due_idx on ledger_outbox (status, next_attempt_at) where status = 'pending';
create index if not exists ledger_outbox_user_idx on ledger_outbox (user_id, status, id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Bank accounts and cash boxes (DESIGN §2.3.6)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists bank_accounts (
  id serial primary key, user_id integer not null,
  kind text not null check (kind in ('bank','cash')),
  name_ar text not null, name_en text,
  bank_name text,
  iban text check (iban is null or iban ~ '^SA[0-9]{2}[0-9A-Z]{20}$'),
  account_number text,
  currency char(3) not null default 'SAR',
  is_trust boolean not null default false,
  is_default boolean not null default false,
  is_active boolean not null default true,
  gl_account_id integer not null,
  opening_balance numeric(14,2),
  created_by integer, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (gl_account_id, user_id) references accounts (id, user_id)
);
create unique index if not exists bank_accounts_iban_uq on bank_accounts (user_id, iban) where iban is not null;
create unique index if not exists bank_accounts_default_uq on bank_accounts (user_id, kind, is_trust) where is_default and is_active;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Side tables: v2 attributes of existing records, 1:1, never on the legacy
--    table (DESIGN §2.3.7, §4.3, §7.5)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists finance_collection_meta (
  collection_id integer primary key,
  user_id integer not null, bank_account_id integer, method_detail text,
  settled_by_deduction boolean not null default false,
  classification text check (classification in ('deposit_offset','deposit_conversion','commission_cash')),
  date_defaulted_utc boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists finance_expense_details (
  expense_id integer primary key, user_id integer not null,
  revision integer not null default 1,
  expense_on date,
  gross_amount numeric(14,2) not null,
  net_amount numeric(14,2) not null,
  vat_rate numeric(5,2) not null default 0,
  vat_amount numeric(14,2) not null default 0,
  vat_category char(1) not null default 'S' check (vat_category in ('S','Z','E','O')),
  vat_recoverable boolean not null default false,
  supplier_name text, supplier_vat_number text check (supplier_vat_number is null or supplier_vat_number ~ '^3[0-9]{13}3$'),
  supplier_invoice_no text, supplier_invoice_date date,
  attachment_key text,
  bank_account_id integer,
  charge_to text not null default 'company' check (charge_to in ('company','landlord')),
  gl_account_id integer,
  updated_by integer, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (net_amount + vat_amount = gross_amount)
);
create table if not exists finance_expense_category_map (
  user_id integer not null, category text not null, account_id integer not null,
  primary key (user_id, category)
);
create table if not exists finance_payout_meta (
  payout_id integer primary key, user_id integer not null,
  paid_on date, bank_account_id integer, created_at timestamptz not null default now()
);
create table if not exists finance_deposit_refunds (
  id serial primary key, user_id integer not null,
  contract_id integer not null, tenant_id integer, owner_id integer,
  voucher_ids integer[] not null default '{}',
  amount numeric(14,2) not null check (amount > 0),
  refunded_on date not null, bank_account_id integer, method text, reference text,
  number text not null,
  created_by integer, created_at timestamptz not null default now(),
  unique (user_id, number)
);
create table if not exists finance_installment_charges (
  payment_id integer not null, generation smallint not null default 1,
  user_id integer not null,
  charged_on date not null,
  charged_by text not null check (charged_by in ('due','document','settled_external')),
  document_id integer,
  amount numeric(14,2) not null, vat_amount numeric(14,2) not null default 0,
  entry_id bigint,
  reversed_at timestamptz, reversed_reason text,
  primary key (payment_id, generation)
);
create unique index if not exists finance_installment_charges_active_uq
  on finance_installment_charges (payment_id) where reversed_at is null;
create table if not exists finance_installment_vat_points (
  collection_id integer primary key, payment_id integer not null, user_id integer not null,
  vat_booked numeric(14,2) not null check (vat_booked > 0), booked_on date not null, entry_id bigint
);
create index if not exists finance_installment_vat_points_pay_idx on finance_installment_vat_points (user_id, payment_id);
create table if not exists tenant_credit_actions (
  id serial primary key, user_id integer not null,
  tenant_id integer not null, contract_id integer, owner_id integer,
  kind text not null check (kind in ('refund','apply')),
  amount numeric(14,2) not null check (amount > 0),
  action_on date not null,
  target_document_id integer,
  source_document_id integer,
  bank_account_id integer, method text, reference text, number text,
  status text not null default 'posted' check (status in ('posted','void')),
  created_by integer, created_at timestamptz not null default now()
);
create index if not exists tenant_credit_actions_tenant_idx on tenant_credit_actions (user_id, tenant_id);
create table if not exists finance_write_offs (
  id serial primary key, user_id integer not null,
  tenant_id integer, contract_id integer, owner_id integer,
  payment_ids integer[] not null default '{}', document_ids integer[] not null default '{}',
  amount numeric(14,2) not null check (amount > 0),
  written_off_on date not null, reason text not null,
  created_by integer not null, approved_by integer, created_at timestamptz not null default now()
);
create table if not exists finance_ejar_settlements (
  payment_id integer primary key, user_id integer not null,
  reported_status text not null, reported_amount numeric(14,2), imported_at timestamptz not null default now()
);
create table if not exists manual_journals (
  id serial primary key, user_id integer not null,
  kind text not null default 'manual' check (kind in ('manual','opening')),
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','posted','void')),
  entry_date date not null, memo text not null, attachment_key text,
  lines jsonb not null,
  created_by integer not null, submitted_at timestamptz,
  approved_by integer, approved_at timestamptz, rejected_by integer, rejected_reason text,
  posted_entry_id bigint,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists manual_journals_user_idx on manual_journals (user_id, status, id);
create table if not exists finance_backfill_runs (
  id serial primary key, user_id integer not null, actor_user_id integer not null,
  mode text not null check (mode in ('full','cutover','catchup')), dry_run boolean not null,
  cutover_date date, started_at timestamptz not null default now(), finished_at timestamptz,
  status text not null default 'running' check (status in ('running','done','failed')),
  summary jsonb
);
create index if not exists finance_backfill_runs_user_idx on finance_backfill_runs (user_id, id desc);
create table if not exists finance_contract_dims (
  contract_id integer primary key, user_id integer not null,
  owner_id integer, property_id integer, unit_ids integer[] not null default '{}',
  ended_on date,
  captured_at timestamptz not null default now()
);
create table if not exists finance_vat_return_drafts (
  id serial primary key,
  user_id integer not null, seller_key text not null, period_start date not null, period_end date not null,
  box14 numeric(14,2) not null default 0, box15 numeric(14,2) not null default 0,
  locked_at timestamptz, locked_by integer, unique (user_id, seller_key, period_start)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Enforcement (DESIGN §2.4)
-- ─────────────────────────────────────────────────────────────────────────────

-- 8.1 Balance: a deferred constraint trigger (§2.4.1). Runs at COMMIT, once per
-- entry per transaction. The per-transaction marker is `fv2.chk_<id>`: Postgres
-- refuses a custom GUC name segment that starts with a digit, so the design's
-- `fv2.chk.<id>` cannot be used as written.
create or replace function fv2_check_entry_balanced() returns trigger language plpgsql as $$
declare eid bigint; d numeric(16,2); c numeric(16,2); n int; t numeric(14,2); found_entry boolean;
begin
  if tg_table_name = 'journal_entries' then eid := new.id; else eid := new.entry_id; end if;
  if current_setting('fv2.chk_' || eid, true) = '1' then return null; end if;
  perform set_config('fv2.chk_' || eid, '1', true);
  select coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) into d, c, n from journal_lines where entry_id = eid;
  select total, true into t, found_entry from journal_entries where id = eid;
  if found_entry is null then return null; end if;   -- purged in the same transaction
  if n < 2 then raise exception 'fv2: journal entry % has % line(s); at least 2 required', eid, n using errcode = '23514'; end if;
  if d <> c then raise exception 'fv2: journal entry % is unbalanced (debit %, credit %)', eid, d, c using errcode = '23514'; end if;
  if t is distinct from d then raise exception 'fv2: journal entry % total % <> line total %', eid, t, d using errcode = '23514'; end if;
  return null;
end $$;
drop trigger if exists journal_lines_balanced on journal_lines;
create constraint trigger journal_lines_balanced after insert on journal_lines
  deferrable initially deferred for each row execute function fv2_check_entry_balanced();
drop trigger if exists journal_entries_balanced on journal_entries;
create constraint trigger journal_entries_balanced after insert on journal_entries
  deferrable initially deferred for each row execute function fv2_check_entry_balanced();

-- 8.2 Immutability (§2.4.2). The only permitted change to a posted entry is
-- posted -> reversed with reversed_by/reversed_at; lines never change.
create or replace function fv2_ledger_immutable() returns trigger language plpgsql as $$
begin
  if current_setting('fv2.purge', true) = 'on' then
    if tg_op = 'DELETE' then return old; elsif tg_op = 'UPDATE' then return new; else return null; end if;
  end if;
  if tg_table_name = 'journal_lines' then
    raise exception 'fv2: journal lines are immutable (correct with a reversal)' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    -- reversed_by must be THIS entry's reversal (same account, reversal_of = it),
    -- so an entry cannot be marked reversed by pointing at an unrelated entry.
    if old.status = 'posted' and new.status = 'reversed' and new.reversed_by is not null
       and (to_jsonb(new) - 'status' - 'reversed_by' - 'reversed_at') = (to_jsonb(old) - 'status' - 'reversed_by' - 'reversed_at')
       and exists (select 1 from journal_entries r where r.id = new.reversed_by and r.user_id = old.user_id and r.reversal_of = old.id) then
      return new;
    end if;
  end if;
  raise exception 'fv2: journal entries are immutable (correct with a reversal)' using errcode = '55000';
end $$;
drop trigger if exists journal_lines_immutable on journal_lines;
create trigger journal_lines_immutable before update or delete on journal_lines for each row execute function fv2_ledger_immutable();
drop trigger if exists journal_entries_immutable on journal_entries;
create trigger journal_entries_immutable before update or delete on journal_entries for each row execute function fv2_ledger_immutable();
drop trigger if exists journal_no_truncate on journal_lines;
create trigger journal_no_truncate before truncate on journal_lines for each statement execute function fv2_ledger_immutable();
drop trigger if exists journal_entries_no_truncate on journal_entries;
create trigger journal_entries_no_truncate before truncate on journal_entries for each statement execute function fv2_ledger_immutable();

-- 8.2b Fiscal periods (§2.3.3): a period's identity and dates never change
-- (entries are validated against them at insert), `locked` is terminal, and a
-- VAT lock is never lifted.
create or replace function fv2_periods_guard() returns trigger language plpgsql as $$
begin
  if current_setting('fv2.purge', true) = 'on' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'fv2: fiscal periods cannot be deleted' using errcode = '55000';
  end if;
  if new.user_id is distinct from old.user_id or new.fiscal_year is distinct from old.fiscal_year
     or new.period_no is distinct from old.period_no or new.starts_on is distinct from old.starts_on
     or new.ends_on is distinct from old.ends_on then
    raise exception 'fv2: a fiscal period''s account, year, number and dates are fixed' using errcode = '55000';
  end if;
  if old.status = 'locked' and new.status is distinct from 'locked' then
    raise exception 'fv2: period % is locked (irreversible)', old.id using errcode = '55000';
  end if;
  if old.vat_locked_at is not null and new.vat_locked_at is distinct from old.vat_locked_at then
    raise exception 'fv2: period % is VAT-locked (irreversible)', old.id using errcode = '55000';
  end if;
  return new;
end $$;
drop trigger if exists fiscal_periods_guard on fiscal_periods;
create trigger fiscal_periods_guard before update or delete on fiscal_periods for each row execute function fv2_periods_guard();

-- 8.3 Postable account (§2.4.3): active, not a group. Also: a line's
-- entry_date is the entry's (it is a copy kept for index-only scans).
create or replace function fv2_line_account_ok() returns trigger language plpgsql as $$
declare a record; e record;
begin
  select is_active, is_group, code into a from accounts where id = new.account_id and user_id = new.user_id;
  if not found then raise exception 'fv2: account % not in this chart', new.account_id using errcode = '23503'; end if;
  if a.is_group then raise exception 'fv2: account % is a group account and cannot take postings', a.code using errcode = '55000'; end if;
  if not a.is_active then raise exception 'fv2: account % is inactive', a.code using errcode = '55000'; end if;
  select entry_date into e from journal_entries where id = new.entry_id and user_id = new.user_id;
  if found and e.entry_date <> new.entry_date then
    raise exception 'fv2: line entry_date % <> entry date %', new.entry_date, e.entry_date using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists journal_lines_account_ok on journal_lines;
create trigger journal_lines_account_ok before insert on journal_lines for each row execute function fv2_line_account_ok();

-- 8.4 Open period (§2.4.3). `open` takes everything; `closed` takes manual
-- adjustments and the year-end closing entry only; `locked` takes nothing.
create or replace function fv2_entry_period_open() returns trigger language plpgsql as $$
declare p record;
begin
  select status, starts_on, ends_on into p from fiscal_periods where id = new.period_id and user_id = new.user_id;
  if not found then raise exception 'fv2: period % not found for this account', new.period_id using errcode = '23503'; end if;
  if new.entry_date < p.starts_on or new.entry_date > p.ends_on then
    raise exception 'fv2: entry date % outside period % (% .. %)', new.entry_date, new.period_id, p.starts_on, p.ends_on using errcode = '23514';
  end if;
  if p.status = 'open' then return new; end if;
  if p.status = 'closed' and new.origin in ('manual','closing') then return new; end if;
  raise exception 'fv2: period closed' using errcode = '55000';
end $$;
drop trigger if exists journal_entries_period_open on journal_entries;
create trigger journal_entries_period_open before insert on journal_entries for each row execute function fv2_entry_period_open();

-- 8.5 VAT lock (§2.4.3): VAT-bearing lines are refused in a VAT-locked month.
create or replace function fv2_line_vat_lock() returns trigger language plpgsql as $$
begin
  if new.tax_role is null and new.vat_category is null then return new; end if;
  if exists (select 1 from journal_entries e join fiscal_periods p on p.id = e.period_id and p.user_id = e.user_id
              where e.id = new.entry_id and e.user_id = new.user_id and p.vat_locked_at is not null) then
    raise exception 'fv2: VAT period locked' using errcode = '55000';
  end if;
  return new;
end $$;
drop trigger if exists journal_lines_vat_lock on journal_lines;
create trigger journal_lines_vat_lock before insert on journal_lines for each row execute function fv2_line_vat_lock();

-- 8.6 Chart guards (§2.3.2)
create or replace function fv2_accounts_guard() returns trigger language plpgsql as $$
declare has_postings boolean := false; p record; cur integer; depth integer := 0;
begin
  if current_setting('fv2.purge', true) = 'on' then return new; end if;
  if tg_op = 'UPDATE' then
    has_postings := exists (select 1 from journal_lines where account_id = old.id);
    if has_postings and (new.type is distinct from old.type or new.normal_balance is distinct from old.normal_balance
        or new.system_key is distinct from old.system_key or new.user_id is distinct from old.user_id) then
      raise exception 'fv2: account % has postings; type, normal balance, system key and owner are locked', old.code using errcode = '55000';
    end if;
    if new.code is distinct from old.code and has_postings then
      raise exception 'fv2: account % has postings; its code is locked', old.code using errcode = '55000';
    end if;
    if old.is_group and not new.is_group and exists (select 1 from accounts where parent_id = old.id) then
      raise exception 'fv2: account % has sub-accounts and must stay a group', old.code using errcode = '55000';
    end if;
  end if;
  if new.is_group and (has_postings or new.system_key is not null) then
    raise exception 'fv2: account % cannot be a group (it has postings or a system key)', new.code using errcode = '55000';
  end if;
  if new.parent_id is not null then
    select id, user_id, type, is_group, system_key into p from accounts where id = new.parent_id;
    if not found then raise exception 'fv2: parent account % not found', new.parent_id using errcode = '23503'; end if;
    if p.user_id <> new.user_id then raise exception 'fv2: parent account belongs to another chart' using errcode = '23514'; end if;
    if p.type <> new.type then raise exception 'fv2: parent account type % differs from %', p.type, new.type using errcode = '23514'; end if;
    if not p.is_group then raise exception 'fv2: parent account is not a group' using errcode = '23514'; end if;
    if p.system_key is not null then raise exception 'fv2: parent account has a system key' using errcode = '23514'; end if;
    if tg_op = 'UPDATE' then
      cur := new.parent_id;
      while cur is not null loop
        if cur = new.id then raise exception 'fv2: account hierarchy would contain a cycle' using errcode = '23514'; end if;
        depth := depth + 1;
        if depth > 64 then raise exception 'fv2: account hierarchy too deep' using errcode = '23514'; end if;
        select parent_id into cur from accounts where id = cur;
      end loop;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists accounts_guard on accounts;
create trigger accounts_guard before insert or update on accounts for each row execute function fv2_accounts_guard();

create or replace function fv2_accounts_no_delete() returns trigger language plpgsql as $$
begin
  if current_setting('fv2.purge', true) = 'on' then return old; end if;
  if old.is_template then raise exception 'fv2: template account % cannot be deleted (deactivate it)', old.code using errcode = '55000'; end if;
  if exists (select 1 from journal_lines where account_id = old.id) then
    raise exception 'fv2: account % has postings and cannot be deleted', old.code using errcode = '55000';
  end if;
  if exists (select 1 from bank_accounts where gl_account_id = old.id) then
    raise exception 'fv2: account % is linked to a bank account', old.code using errcode = '55000';
  end if;
  return old;
end $$;
drop trigger if exists accounts_no_delete on accounts;
create trigger accounts_no_delete before delete on accounts for each row execute function fv2_accounts_no_delete();

-- 8.7 Posted manual journals are frozen (§2.4.2): the only move is
-- posted -> void, and only once the posted entry has been reversed.
create or replace function fv2_manual_journal_frozen() returns trigger language plpgsql as $$
begin
  if current_setting('fv2.purge', true) = 'on' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if old.status not in ('posted','void') then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'UPDATE' and old.status = 'posted' and new.status = 'void'
     and (to_jsonb(new) - 'status' - 'updated_at') = (to_jsonb(old) - 'status' - 'updated_at')
     and exists (select 1 from journal_entries where id = old.posted_entry_id and status = 'reversed') then
    return new;
  end if;
  raise exception 'fv2: manual journal % is %; correct it with a reversal', old.id, old.status using errcode = '55000';
end $$;
drop trigger if exists manual_journals_frozen on manual_journals;
create trigger manual_journals_frozen before update or delete on manual_journals for each row execute function fv2_manual_journal_frozen();

-- 8.8 Account purge (§2.4.5), the only delete path for ledger rows. Called
-- after an admin hard delete of the account. `fv2.purge` is an accident guard,
-- not a security boundary; CI confines the string to this function.
create or replace function fv2_purge_account(p_user integer) returns void language plpgsql as $$
begin
  perform set_config('fv2.purge', 'on', true);
  delete from journal_lines where user_id = p_user;
  delete from journal_entries where user_id = p_user;
  delete from ledger_outbox where user_id = p_user;
  delete from manual_journals where user_id = p_user;
  delete from finance_backfill_runs where user_id = p_user;
  delete from finance_collection_meta where user_id = p_user;
  delete from finance_expense_details where user_id = p_user;
  delete from finance_expense_category_map where user_id = p_user;
  delete from finance_payout_meta where user_id = p_user;
  delete from finance_deposit_refunds where user_id = p_user;
  delete from finance_installment_charges where user_id = p_user;
  delete from finance_installment_vat_points where user_id = p_user;
  delete from tenant_credit_actions where user_id = p_user;
  delete from finance_write_offs where user_id = p_user;
  delete from finance_ejar_settlements where user_id = p_user;
  delete from finance_contract_dims where user_id = p_user;
  delete from finance_vat_return_drafts where user_id = p_user;
  delete from bank_accounts where user_id = p_user;
  delete from accounts where user_id = p_user;
  delete from fiscal_periods where user_id = p_user;
  delete from finance_settings_events where account_user_id = p_user;
  delete from finance_settings where account_user_id = p_user;
  perform set_config('fv2.purge', 'off', true);
end $$;
