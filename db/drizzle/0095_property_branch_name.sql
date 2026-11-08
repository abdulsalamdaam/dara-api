-- 0095: properties.branch_name — the account's own label for a property
-- (customer note, 4 Nov 2026: a tenant with several shops calls each one by
-- its branch, «فرع الشعلة»). Ejar-imported names are locked, so this is a
-- separate column Ejar never writes; clients show it in place of the name.
-- Additive and idempotent (applied at boot by bootstrap.ts on every start).

alter table properties add column if not exists branch_name text;
