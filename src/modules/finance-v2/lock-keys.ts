/**
 * Every advisory-lock constant Finance v2 uses, in ONE place (DESIGN §2.3.7).
 *
 * Locks are the two-int form `pg_advisory_xact_lock(user_id, KEY)`. The
 * positive second-int space is already taken by legacy code: (uid, 1|2|3) the
 * invoice/credit/debit series (billing.module.ts), (uid, 11) contract numbers,
 * (uid, docId) per document and (scope, paymentId) per installment. Any small
 * positive constant could collide with a real document or installment id, so
 * every Finance v2 key is NEGATIVE.
 */
export const LOCK_KEYS = {
  /** JV- manual journal numbers. */
  JV: -101,
  /** PV- payment voucher numbers (deposit refunds, tenant refunds). */
  PV: -102,
  /** RR- rent receipt (non-tax document) numbers. */
  RR: -103,
  /** AGF- agency-fee document numbers. */
  AGF: -104,
  /** journal_entries.entry_no. */
  ENTRY_NO: -105,
  /** First-enable setup (chart seed, periods, default bank accounts). */
  SETUP: -106,
  /** Bank account create (the next free 1110xx GL code). */
  BANK_ACCOUNT: -107,
  /** Bank statement import and matching, per account. */
  BANK_REC: -108,
  /** Tenant credit refund / apply: the credit-sufficiency check and the write, serialised per account. */
  TENANT_CREDIT: -109,
  /** BILL- supplier bill numbers (tier 3). */
  BILL: -110,
  /** Supplier payment allocation: the bill open-amount check and the write, serialised per account (tier 3). */
  AP: -111,
  /** FA- fixed-asset numbers and the per-account asset/depreciation writes (§8.5). */
  FIXED_ASSET: -140,
  /** The monthly commission run (collected basis): one landlord-month at a time per account. */
  COMMISSION_RUN: -170,
  /** TRF- commission transfer numbers and the unsent-commission check. */
  COMMISSION_TRANSFER: -171,
} as const;

export type LockKey = (typeof LOCK_KEYS)[keyof typeof LOCK_KEYS];
