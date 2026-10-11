-- Ejar Import v2: keep the Get Contracts body of a lookup (Oct 2026).
--
-- The lookup's second call is now Get Contracts by UUID (property, units and
-- parties with their ID numbers), with Details as the fallback. Nullable:
-- lookups saved before this, and Details-mode lookups, have none.
--
-- Applied at boot by src/database/bootstrap.ts after 0077, in its own
-- try/catch. Idempotent and additive only.

alter table ejar_lookups add column if not exists contracts_body jsonb;
