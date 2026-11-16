-- 0098: linked accounts — a special price per account in a shared package (16 Nov 2026).
--
-- account_groups.member_prices maps account id → yearly price in SAR before VAT,
-- set by a Dara admin. An account without an entry costs the default: the plan
-- price for the primary, the group's extra-account price for the others.
ALTER TABLE account_groups ADD COLUMN IF NOT EXISTS member_prices jsonb NOT NULL DEFAULT '{}'::jsonb;
