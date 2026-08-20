-- Phone-OTP codes, now that SMS goes through Taqnyat.
--
-- Twilio Verify owned the code lifecycle (generate, expire, count attempts).
-- Taqnyat is a plain SMS gateway, so that lifecycle moves here — same shape
-- and same hardening as email_otp_tokens: bcrypt hash only, explicit expiry,
-- attempt counter, single use.

CREATE TABLE IF NOT EXISTS "phone_otp_tokens" (
  "id"          serial PRIMARY KEY NOT NULL,
  "phone"       text NOT NULL,
  "purpose"     text NOT NULL,
  "code_hash"   text NOT NULL,
  "attempts"    integer NOT NULL DEFAULT 0,
  "consumed_at" timestamp with time zone,
  "expires_at"  timestamp with time zone NOT NULL,
  "ip"          text,
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "phone_otp_tokens_phone_idx"
  ON "phone_otp_tokens" ("phone", "expires_at");
