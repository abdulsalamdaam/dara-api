-- Finance v2 (beta), tier 1 and tier 2 additions: bank reconciliation, rent
-- reminders (built DISABLED) and two small v2 side tables. Design:
-- docs/finance-v2/DESIGN.md §8.2, §8.3.
--
-- Same rules as 0066 (DESIGN §1.4 point 7, §2.2):
--  * ADDITIVE ONLY: new tables and indexes; it alters nothing, not even the
--    0066 tables (CI rejects ALTER TABLE on a table this file did not create).
--  * IDEMPOTENT: `ensureSchema` (src/database/bootstrap.ts) runs it on every
--    boot, after 0066.
--  * No FK to any legacy table. One simple-query message = one transaction.
--  * No immutability triggers: these rows are working data, so the account
--    purge deletes them from code (hooks.service purgeAccount), and the
--    purge switch stays confined to 0066.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Name-collision guard (as in 0066): an existing table with one of these
--    names must carry every column this file expects.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  expected jsonb := jsonb_build_object(
    'finance_document_meta', '["document_id","user_id","bank_account_id","created_at"]'::jsonb,
    'tenant_credit_targets', '["action_id","user_id","target_payment_id","target_contract_id"]'::jsonb,
    'bank_import_profiles', '["id","user_id","bank_account_id","name","delimiter","encoding","skip_rows","date_col","date_format","desc_col","ref_col","amount_col","debit_col","credit_col","balance_col","created_at"]'::jsonb,
    'bank_statements', '["id","user_id","bank_account_id","period_from","period_to","opening_balance","closing_balance","file_key","imported_by","imported_at","status","reconciled_at"]'::jsonb,
    'bank_statement_lines', '["id","statement_id","user_id","bank_account_id","line_no","txn_date","description","reference","amount","running_balance","fingerprint","match_status"]'::jsonb,
    'bank_matches', '["id","user_id","group_id","statement_line_id","journal_line_id","amount","method","matched_by","matched_at"]'::jsonb,
    'reminder_settings', '["user_id","enabled","offsets","channels","template_ar","template_en","updated_at"]'::jsonb,
    'reminder_log', '["id","user_id","payment_id","offset_days","channel","status","recipient_hash","created_at"]'::jsonb
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
-- 1. Tier 1 side tables
-- ─────────────────────────────────────────────────────────────────────────────
-- Which cash/bank account a DOCUMENT's money used (receipt and deposit
-- vouchers: E09 posts the voucher, not a collection). 1:1, v2 only.
create table if not exists finance_document_meta (
  document_id integer primary key,              -- simple_invoices.id
  user_id integer not null,
  bank_account_id integer,
  created_at timestamptz not null default now()
);
-- A tenant-credit "apply" aimed at an installment rather than a document
-- (tenant_credit_actions has target_document_id only). 1:1 with the action.
create table if not exists tenant_credit_targets (
  action_id integer primary key,                -- tenant_credit_actions.id
  user_id integer not null,
  target_payment_id integer,
  target_contract_id integer
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Bank reconciliation (DESIGN §8.3 a)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists bank_import_profiles (
  id serial primary key, user_id integer not null, bank_account_id integer not null, name text not null,
  delimiter text not null default ',', encoding text not null default 'utf-8', skip_rows smallint not null default 0,
  date_col text not null, date_format text not null,
  desc_col text, ref_col text, amount_col text, debit_col text, credit_col text, balance_col text,
  created_at timestamptz not null default now()
);
create index if not exists bank_import_profiles_user_idx on bank_import_profiles (user_id, bank_account_id);
create table if not exists bank_statements (
  id serial primary key, user_id integer not null, bank_account_id integer not null,
  period_from date, period_to date, opening_balance numeric(14,2), closing_balance numeric(14,2),
  file_key text, imported_by integer not null, imported_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open','reconciled')), reconciled_at timestamptz
);
create index if not exists bank_statements_user_idx on bank_statements (user_id, bank_account_id, id desc);
create table if not exists bank_statement_lines (
  id bigserial primary key, statement_id integer not null, user_id integer not null, bank_account_id integer not null,
  line_no integer not null, txn_date date not null, description text, reference text,
  amount numeric(14,2) not null check (amount <> 0),   -- + money in, - money out
  running_balance numeric(14,2),
  fingerprint text not null,
  match_status text not null default 'unmatched' check (match_status in ('unmatched','auto','manual','ignored')),
  unique (bank_account_id, fingerprint)
);
create index if not exists bank_statement_lines_stmt_idx on bank_statement_lines (statement_id, line_no);
-- A match is a GROUP: its statement lines and its journal lines (1:1, 1:n or
-- n:1) sum to the same signed amount. Each statement line and each journal
-- line belongs to at most one group (the two partial unique indexes).
create table if not exists bank_matches (
  id bigserial primary key, user_id integer not null,
  group_id bigint not null,
  statement_line_id bigint, journal_line_id bigint,
  amount numeric(14,2) not null,                 -- signed: + money in
  method text not null check (method in ('auto','manual')),
  matched_by integer, matched_at timestamptz not null default now(),
  check ((statement_line_id is null) <> (journal_line_id is null))
);
create unique index if not exists bank_matches_sl_once on bank_matches (statement_line_id) where statement_line_id is not null;
create unique index if not exists bank_matches_jl_once on bank_matches (journal_line_id) where journal_line_id is not null;
create index if not exists bank_matches_group_idx on bank_matches (user_id, group_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Scheduled rent reminders: BUILT DISABLED (DESIGN §8.3 b). Nothing here
--    sends anything; the only sender is a dry run that writes reminder_log.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists reminder_settings (
  user_id integer primary key,
  enabled boolean not null default false,
  offsets integer[] not null default '{-3,0,7}',
  channels text[] not null default '{sms}',
  template_ar text, template_en text,
  updated_at timestamptz not null default now()
);
create table if not exists reminder_log (
  id bigserial primary key, user_id integer not null, payment_id integer not null,
  offset_days integer not null, channel text not null,
  status text not null check (status in ('dry_run','sent','skipped','failed')),
  recipient_hash text,
  created_at timestamptz not null default now()
);
-- One real attempt per (installment, offset, channel); dry runs are keyed apart
-- so a dry run can never block a later real reminder.
create unique index if not exists reminder_log_real_uq on reminder_log (payment_id, offset_days, channel) where status <> 'dry_run';
create unique index if not exists reminder_log_dry_uq on reminder_log (payment_id, offset_days, channel) where status = 'dry_run';
create index if not exists reminder_log_user_idx on reminder_log (user_id, created_at desc);
