-- Finance v2 (beta): the commission basis per PROPERTY (accountant's test,
-- 5 Oct 2026, finding 9: "per-property option: on billed or on collected").
--
-- Additive only: one new table, nothing existing is altered. Applied at boot
-- by bootstrap.ts after 0074, in its own try/catch (a failure reads as "no
-- property overrides": every property follows the account's basis, which is
-- exactly the behaviour before this table existed). Idempotent.
--
-- A missing row, or basis null, means the property follows the account's
-- `finance_settings.commission_basis`. `collected_from` is the property's own
-- collected-basis cutover (the first day of the Riyadh month it was switched
-- to 'collected'): its collections dated before it are never counted by the
-- monthly run.
create table if not exists finance_property_commission (
  user_id integer not null,
  property_id integer not null,
  basis text check (basis in ('billed','collected')),
  collected_from date,
  updated_by integer,
  updated_at timestamptz not null default now(),
  primary key (user_id, property_id)
);
create index if not exists finance_property_commission_collected_idx on finance_property_commission (user_id) where basis = 'collected';
