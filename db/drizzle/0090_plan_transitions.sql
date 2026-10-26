-- 0090: plan transitions (عقاري ⇄ المكاتب ⇄ الشركات).
--
-- account_plan_changes   one row per plan change of a customer account: from/to,
--                        who and what caused it, the steps the orchestrator ran
--                        (src/modules/plan-transition), and `commission_from`,
--                        the date commission starts after an upgrade into a plan
--                        with accounting (no COM- for rent due before it, D1).
-- finance_ledger_archives the Owner-mode ledger rows a Manager-mode rebuild threw
--                        away, kept so an admin can restore them.
--
-- New tables only; nothing existing is altered. Idempotent (applied at boot by
-- bootstrap.ts on every start).

create table if not exists account_plan_changes (
  id bigserial primary key,
  account_user_id integer not null references users(id) on delete cascade,
  from_plan text,
  to_plan text not null,
  from_features jsonb not null default '[]',
  to_features jsonb not null default '[]',
  direction text not null check (direction in ('upgrade','downgrade','lateral','initial')),
  source text not null check (source in ('admin_approve','admin_package_change','subscription_paid','backfill','sweep','owner_mode_guard')),
  actor_user_id integer,
  subscription_payment_id integer,
  reason text,
  commission_from date,
  status text not null default 'pending' check (status in ('pending','done','attention','blocked','failed')),
  steps jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists account_plan_changes_acct on account_plan_changes(account_user_id, created_at desc);
create index if not exists account_plan_changes_attention on account_plan_changes(status) where status in ('attention','blocked','failed');

create table if not exists finance_ledger_archives (
  id bigserial primary key,
  account_user_id integer not null,
  plan_change_id bigint references account_plan_changes(id),
  reason text not null,
  settings jsonb not null,
  journal_entries jsonb not null,
  journal_lines jsonb not null,
  ledger_outbox jsonb not null,
  installment_charges jsonb not null,
  installment_vat_points jsonb not null,
  counts jsonb not null,
  restored_at timestamptz,
  restored_by integer,
  created_by integer,
  created_at timestamptz not null default now()
);
create index if not exists finance_ledger_archives_acct on finance_ledger_archives(account_user_id, created_at desc);

-- Baseline: one `initial` row per live customer account that has none, so the
-- history starts somewhere and `commission_from` stays null for accounts that
-- were always on a plan with accounting (no restriction). Plans without
-- accounting: tenant, basic (plan-features.ts); every other key (professional,
-- enterprise, the `broker` default, null) has all three features.
insert into account_plan_changes (account_user_id, from_plan, to_plan, from_features, to_features, direction, source, status, steps)
select u.id, null, coalesce(u.package_plan, 'broker'), '[]'::jsonb,
       case when coalesce(u.package_plan, '') in ('tenant', 'basic') then '[]'::jsonb
            else '["accounting","advanced_reports","rental_offers"]'::jsonb end,
       'initial', 'backfill', 'done', '[]'::jsonb
  from users u
  left join roles r on r.id = u.role_id
 where u.owner_user_id is null
   and u.deleted_at is null
   and coalesce(r.key, '') not in ('super_admin', 'admin')
   and not exists (select 1 from account_plan_changes x where x.account_user_id = u.id);
