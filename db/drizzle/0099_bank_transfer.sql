-- 0099: pay a subscription (or an add-on) by bank transfer (19 Nov 2026).
--
-- The customer transfers to Dara's bank account and uploads the bank receipt.
-- The row waits as status `review` until a platform admin checks the receipt
-- against the bank statement and approves it (→ `paid`, which activates the
-- subscription exactly like a card payment) or rejects it (→ `rejected`, with
-- the reason shown to the customer).
--
-- subscription_payments:
--   charge_type          + 'bank_transfer'
--   status               + 'review' | 'rejected'
--   receipt_key          object key of the uploaded receipt (MinIO, acct/<id>/…)
--   receipt_name/_type   original file name and content type
--   receipt_uploaded_at  when the customer uploaded it
--   reviewed_by/_at      the admin who approved or rejected, and when
--   review_note          the rejection reason shown to the customer
--
-- Idempotent: safe to run on every boot (bootstrap.ts).

ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS receipt_key text;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS receipt_name text;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS receipt_type text;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS receipt_uploaded_at timestamptz;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS reviewed_by integer;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS review_note text;
CREATE INDEX IF NOT EXISTS subscription_payments_review_idx ON subscription_payments (created_at) WHERE status = 'review';
