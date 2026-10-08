-- Finance v2 (beta): the trust (أمانات) account is mandatory in Manager mode
-- (accountant round 3, 7 Oct 2026: "حساب الأمانات لسه «غير محدد» افتراضياً").
--
-- New Manager-mode enables get it from FinanceSetupService.ensureTrust; this
-- does the same, once, for accounts enabled before it. Data only, nothing is
-- altered. Applied at boot by bootstrap.ts after 0075, in its own try/catch.
-- Idempotent: every step only acts where something is missing.
--
--  1. A Manager-mode account with the chart seeded and no active trust bank
--     account gets one on the template's 1114 leaf (unless 1114 already backs
--     a box — that one is left alone and the account is skipped by step 1;
--     FinanceSetupService.ensureTrust repairs it on the next enable).
--  2. Every Manager-mode account with active trust accounts but no default
--     makes its lowest-id one the default.
--  3. Trust routing (agency_collections_to_trust) on where a default trust
--     account exists.

with need as (
  select fs.account_user_id as uid, a.id as gl
    from finance_settings fs
    join accounts a on a.user_id = fs.account_user_id and a.code = '1114'
   where fs.accounting_mode = 'manager'
     and not exists (select 1 from bank_accounts b where b.user_id = fs.account_user_id and b.kind = 'bank' and b.is_trust and b.is_active)
     and not exists (select 1 from bank_accounts b where b.user_id = fs.account_user_id and b.gl_account_id = a.id)
), ins as (
  insert into bank_accounts (user_id, kind, name_ar, name_en, is_trust, is_default, gl_account_id)
  select uid, 'bank', 'حساب الأمانات (أموال العملاء)', 'Trust account (client money)', true, false, gl from need
  returning id, gl_account_id
)
update accounts a set bank_account_id = ins.id from ins where a.id = ins.gl_account_id and a.bank_account_id is null;

update bank_accounts b set is_default = true, updated_at = now()
  from (select distinct on (b2.user_id) b2.id
          from bank_accounts b2 join finance_settings fs on fs.account_user_id = b2.user_id and fs.accounting_mode = 'manager'
         where b2.kind = 'bank' and b2.is_trust and b2.is_active
           and not exists (select 1 from bank_accounts d where d.user_id = b2.user_id and d.kind = 'bank' and d.is_trust and d.is_default and d.is_active)
         order by b2.user_id, b2.id) pick
 where b.id = pick.id;

update finance_settings fs set agency_collections_to_trust = true, updated_at = now()
 where fs.accounting_mode = 'manager' and not fs.agency_collections_to_trust
   and exists (select 1 from bank_accounts b where b.user_id = fs.account_user_id and b.kind = 'bank' and b.is_trust and b.is_default and b.is_active);
