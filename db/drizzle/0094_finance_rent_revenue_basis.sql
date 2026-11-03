-- 0094: rent revenue basis per account (customer accounting notes, 3 Nov 2026).
--
-- 'accrual' (default, every existing account): rent is booked to unearned rent
-- (2131) when due and released month by month over the period it covers
-- (straight line, E35) — as before.
-- 'cash': rent is still booked to 2131 when due, so the tenant's receivable
-- stays right, but it reaches revenue only as it is received (collections,
-- settled outside the platform, Ejar-reported part payments) — rule E35C.
-- Switchable from the account's finance settings; the recognizer restates
-- open periods to the chosen basis on its next run.
-- Additive and idempotent (applied at boot by bootstrap.ts on every start).

alter table finance_settings add column if not exists rent_revenue_basis text not null default 'accrual';
do $$ begin
  alter table finance_settings add constraint finance_settings_rent_revenue_basis_chk check (rent_revenue_basis in ('accrual', 'cash'));
exception when duplicate_object then null; end $$;
