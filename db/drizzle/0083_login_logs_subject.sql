-- Login history: who a phone login belongs to when it is not a `users` row
-- (Oct 2026). Tenant (mobile app) and owner-kind landlord logins were logged
-- with user_id NULL, so the admin log showed them with no name and could not
-- tell a tenant from an unknown number.
--
-- Plain nullable integers, no FK: the log is history and keeps the id after
-- the party is removed. Applied at boot by src/database/bootstrap.ts.

ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS tenant_id integer;
ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS owner_id integer;
