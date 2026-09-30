-- Finance v2 (beta): the accountant's control checks (sheet "فحوصات الرقابة").
-- One row per run of the checks for one account: the nightly run (after the
-- 03:30 repair sweep), a manual run, and every period close (with or without
-- an override). The checks themselves are computed in code
-- (reports/control-checks.ts, controls.service.ts); this table only keeps
-- their results so the dashboard can show "last run / N failing".
--
-- Same rules as 0066–0069 (DESIGN §1.4 point 7, §2.2):
--  * ADDITIVE ONLY: one new table and its index; it alters nothing.
--  * IDEMPOTENT: `ensureSchema` (src/database/bootstrap.ts) runs it on every
--    boot, after 0069. One simple-query message = one transaction.
--  * No FK to any legacy table. The account purge deletes its rows from code
--    (hooks.service purgeAccount); the purge switch stays confined to 0066.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Name-collision guard (as in 0066–0069).
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  expected jsonb := jsonb_build_object(
    'finance_control_runs', '["id","user_id","as_of","trigger","period_id","ran_at","ran_by","total","passed","failed","not_applicable","failing","results","duration_ms","error"]'::jsonb
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
-- 1. Control-check runs
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists finance_control_runs (
  id bigserial primary key,
  user_id integer not null,
  as_of date not null,
  trigger text not null check (trigger in ('nightly','manual','period_close','period_close_override')),
  period_id integer,                                 -- fiscal_periods.id for a period close
  ran_at timestamptz not null default now(),
  ran_by integer,                                    -- null for the nightly run
  total smallint not null default 0,                 -- the accountant's 21 checks
  passed smallint not null default 0,                -- ok or not applicable
  failed smallint not null default 0,
  not_applicable smallint not null default 0,
  failing text[] not null default '{}',              -- check ids that block closing (R1…R21)
  results jsonb not null default '[]'::jsonb,        -- [{no, checkId, status, value1, value2, difference, unit}]
  duration_ms integer,
  error text                                         -- the run failed; the other columns are zero
);
create index if not exists finance_control_runs_user_idx on finance_control_runs (user_id, ran_at desc);
