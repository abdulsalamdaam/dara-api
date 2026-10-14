-- Finance v2 (beta): the payment voucher (سند صرف, PV-######) of a landlord
-- payout (accountant, 15 Oct 2026: «تحويل للمؤجر» from the landlords screen
-- produces a سند صرف, Dr 2121 / Cr 1114).
--
-- Additive only: one new table, nothing existing is altered. Applied at boot
-- by bootstrap.ts after 0076, in its own try/catch (a failure means a v2
-- payout has no voucher number; the payout itself and its E19 posting are
-- unchanged). Idempotent.
--
-- One row per payout made through the v2 path: its number in the account's
-- ONE PV- series (pv-number.ts, shared with tenant refunds, deposit refunds
-- and supplier payments) and the form's per-open request id, so a double
-- click or a retry returns the first payout instead of paying twice.
create table if not exists finance_payout_vouchers (
  payout_id integer primary key,
  user_id integer not null,
  number text not null,
  request_id text,
  created_by integer,
  created_at timestamptz not null default now()
);
create unique index if not exists finance_payout_vouchers_number_uq on finance_payout_vouchers (user_id, number);
create unique index if not exists finance_payout_vouchers_request_uq on finance_payout_vouchers (user_id, request_id) where request_id is not null;
