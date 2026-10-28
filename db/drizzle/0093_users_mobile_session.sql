-- 0093: the mobile app gets its own session slot (owner decision, 28 Oct 2026).
--
-- Single session per account (0082 era) bumps users.token_version on every
-- login, so the landlord mobile app and the web portal — both signing in as
-- the same users row — signed each other out. The app is not counted any
-- more: a phone-OTP login (the app's only login) signs its token with
-- mobile_token_version, which logins never bump. Web logins keep the single
-- session among themselves. Revocations (admin force-logout, password reset,
-- employee deactivation / password reset / delete, the app's own logout) bump
-- mobile_token_version so a phone is still signed out when it must be.
-- mobile_last_login_at keeps a phone login from being read as a web login
-- when the guard explains a stale web token (SESSION_REPLACED vs REVOKED).
-- Additive and idempotent (applied at boot by bootstrap.ts on every start).

alter table users add column if not exists mobile_token_version integer not null default 0;
alter table users add column if not exists mobile_last_login_at timestamptz;
