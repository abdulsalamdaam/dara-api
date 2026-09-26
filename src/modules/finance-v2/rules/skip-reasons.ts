/**
 * Every `ledger_outbox.skip_reason` the engine can write. The web labels each
 * one (financeV2.ledger.errors.skip.* in both locale files; dara-web
 * scripts/finance-v2-i18n-codes.test.mts mirrors this list), and
 * skip-reasons.spec.ts fails when a rule or the engine skips with a reason
 * that is not listed here. Add the label in dara-web with any new reason.
 */
export const SKIP_REASONS = [
  "agent_not_deferred", "allocation_only", "already_charged", "already_reversed", "cancelled_but_invoiced", "covered_by_opening",
  "fully_linked", "no_installment", "not_charged", "not_standard_rated", "nothing_booked", "nothing_to_release", "nothing_to_reverse",
  "repoint_no_effect", "self_commission", "settled_by_deduction", "written_off", "zero_amount",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];
