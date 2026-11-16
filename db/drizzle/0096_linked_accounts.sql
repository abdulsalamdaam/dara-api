-- 0096: linked accounts (الحسابات المرتبطة, 16 Nov 2026).
--
-- One person runs several Dara accounts — each with its own CR / national ID,
-- its own data, ZATCA link, Ejar quota and team — and switches between them
-- without signing out. An account group ties them together:
--
--   account_groups   one row per group; `primary_user_id` is the account that
--                    created it (the only one that can add accounts, manage
--                    access and switch into every member).
--   users.account_group_id   set on each member account holder row (primary
--                    included). Employees never carry it; they inherit their
--                    account's.
--   account_access   an employee of one member account allowed to work in
--                    another member account, with the role they hold there.
--
-- billing_mode: 'separate' — every account keeps its own subscription;
--               'shared'   — the primary pays one subscription for the group
--                            and every member mirrors its plan and window.
-- extra_account_price_yearly: the admin's special price (SAR, before VAT) per
--   extra account per year in shared mode; NULL = the default (half the plan).
--
-- Additive and idempotent (applied at boot by bootstrap.ts on every start).

create table if not exists account_groups (
  id serial primary key,
  primary_user_id integer not null references users(id) on delete cascade,
  name text,
  billing_mode text not null default 'separate',
  extra_account_price_yearly numeric(12, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists account_groups_primary_uniq on account_groups(primary_user_id);

alter table users add column if not exists account_group_id integer references account_groups(id) on delete set null;
create index if not exists users_account_group_idx on users(account_group_id) where account_group_id is not null;

create table if not exists account_access (
  id serial primary key,
  group_id integer not null references account_groups(id) on delete cascade,
  user_id integer not null references users(id) on delete cascade,
  account_id integer not null references users(id) on delete cascade,
  role_id integer not null references roles(id),
  granted_by integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists account_access_user_account_uniq on account_access(user_id, account_id);
create index if not exists account_access_account_idx on account_access(account_id);
