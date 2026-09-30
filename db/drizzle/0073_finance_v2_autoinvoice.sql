-- Finance v2 (beta): automatic invoicing of due installments (the accountant's
-- requirement "فوترة تلقائية للأقساط المستحقة وتنبيه للمستحق غير المفوتر").
--
-- Same rules as 0066–0069 (DESIGN §1.4 point 7, §2.2):
--  * ADDITIVE ONLY: two new side tables; it alters nothing.
--  * IDEMPOTENT: `ensureSchema` (src/database/bootstrap.ts) runs it on every boot, after 0069.
--  * No FK to any legacy table. The account purge deletes these rows from code (hooks.service purgeAccount).

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Name-collision guard (as in 0066/0067/0069).
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  expected jsonb := jsonb_build_object(
    'finance_auto_invoice_settings', '["user_id","enabled","lead_days","start_from","updated_by","created_at","updated_at"]'::jsonb,
    'finance_auto_invoice_links', '["payment_id","user_id","document_id","status","origin","attempts","last_error","last_error_code","zatca","claimed_at","issued_at","dismissed_by","dismissed_reason","created_at","updated_at"]'::jsonb
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
-- 1. The per-account setting. A missing row means OFF.
--    lead_days: issue N days before the due date (0 = on the due date).
--    start_from: installments due before this date are never auto-issued
--    (set to the day the setting is first turned on, so switching it on never
--    mass-issues a backlog; the backlog stays on the "due, not invoiced" list).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists finance_auto_invoice_settings (
  user_id integer primary key,                        -- = scopeId(); no FK
  enabled boolean not null default false,
  lead_days smallint not null default 0 check (lead_days between 0 and 60),
  start_from date,
  updated_by integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. One row per installment the automation (or the "issue now" bulk action)
--    has touched. The primary key IS the idempotency guarantee: an installment
--    is claimed once, so it can never get two automatic invoices.
--      claimed   — being issued now (a claim older than 15 min is stale and re-claimable)
--      draft     — the draft exists (document_id), approval pending or refused
--      issued    — the document is confirmed (document_id)
--      covered   — a document the user issued covers it (document_id); nothing to do
--      failed    — the last attempt failed (last_error_code); retried by the next run
--      dismissed — a user dismissed the failure; the daily job leaves it alone
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists finance_auto_invoice_links (
  payment_id integer primary key,
  user_id integer not null,
  document_id integer,
  status text not null check (status in ('claimed','draft','issued','covered','failed','dismissed')),
  origin text not null default 'auto' check (origin in ('auto','bulk')),
  attempts smallint not null default 0,
  last_error text,
  last_error_code text,
  zatca jsonb,
  claimed_at timestamptz,
  issued_at timestamptz,
  dismissed_by integer,
  dismissed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists finance_auto_invoice_links_user_idx on finance_auto_invoice_links (user_id, status);
