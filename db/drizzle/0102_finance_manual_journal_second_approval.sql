-- 0102: second-person approval for large manual journals (accountant notes, 27 Nov 2026, note 18).
--
-- When `manual_journal_second_approval` is on, a manual journal whose total is
-- at or above `manual_journal_second_approval_min` (SAR) must be approved by a
-- user other than everyone who created, edited or submitted it — the account
-- holder included, and with no one-person exception. Off (the default, every
-- existing account): approval works as before (manual-journals.service.ts).
-- Additive and idempotent (applied at boot by bootstrap.ts on every start).

alter table finance_settings add column if not exists manual_journal_second_approval boolean not null default false;
alter table finance_settings add column if not exists manual_journal_second_approval_min numeric(14,2) not null default 0;
do $$ begin
  alter table finance_settings add constraint finance_settings_mj_second_approval_min_chk check (manual_journal_second_approval_min >= 0);
exception when duplicate_object then null; end $$;
