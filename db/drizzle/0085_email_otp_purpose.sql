-- Self-service change of login email (Oct 2026). The code confirming a new
-- address reuses email_otp_tokens: `purpose` says what a row is for and
-- `user_id` ties an 'email_change' row to the account asking for it (`email`
-- then holds the NEW address). Every existing row is a login code, so the
-- default keeps them as they were; login queries filter on purpose = 'login'.
--
-- Additive, NOT NULL with a default. Applied at boot by
-- src/database/bootstrap.ts (idempotent).

ALTER TABLE email_otp_tokens ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'login';
ALTER TABLE email_otp_tokens ADD COLUMN IF NOT EXISTS user_id integer;
CREATE INDEX IF NOT EXISTS email_otp_tokens_user_purpose_idx ON email_otp_tokens (user_id, purpose, created_at);
