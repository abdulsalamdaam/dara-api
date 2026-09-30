/**
 * Pure classification rules of the accountant's reports (cash flow, rent
 * roll, deposits register, property profitability). Everything here works on
 * one journal line or one entry at a time, in integer halalas, so the DB
 * service only sums what these functions decide. Every report reads the
 * journal: a figure here is always a sum of journal lines, never a
 * re-computation from the legacy tables.
 */

/** A rule code as stamped on the entry payload (reversals take the original's rule). */
export type Rule = string | null;

// ───────────────────────────── cash flow (direct method) ─────────────────────────────

export type CashActivity = "operating" | "investing" | "financing";

/** The cash-flow lines, in print order within each activity. */
export const CASH_LINES = {
  operating: [
    "tenant_receipts", "ejar_settlements", "tenant_refunds", "deposits_received", "deposits_refunded",
    "landlord_payouts", "commission_received", "supplier_payments", "expenses_paid", "vat", "other_operating",
  ],
  investing: ["investing"],
  financing: ["capital", "drawings", "borrowings", "opening_balances"],
} as const;
export type CashLine = (typeof CASH_LINES)[CashActivity][number] | "internal_transfer";

export function activityOf(line: CashLine): CashActivity | null {
  for (const a of Object.keys(CASH_LINES) as CashActivity[]) if ((CASH_LINES[a] as readonly string[]).includes(line)) return a;
  return null;
}

/** A non-cash line of an entry that moves cash: its account and its signed cash effect (credit − debit). */
export interface Counter {
  systemKey: string | null;
  type: string;
  code: string;
  /** credit − debit, in halalas: what this line contributes to the entry's cash movement. */
  net: number;
}

/** The line a counter-account belongs to, used for entries without a known rule (manual, opening, …). */
export function lineOfCounter(c: Counter): CashLine {
  switch (c.systemKey) {
    case "tenant_receivable": case "tenant_receivable_agency": case "unearned_rent": return "tenant_receipts";
    case "deposits_held": return c.net >= 0 ? "deposits_received" : "deposits_refunded";
    case "landlord_payable": case "landlord_payable_uncollected": case "landlord_receivable": return "landlord_payouts";
    case "accounts_payable": case "supplier_advances": case "accrued_expenses": return "supplier_payments";
    case "output_vat": case "input_vat": case "vat_settlement": case "vat_refundable": return "vat";
    case "commission_revenue": case "agency_fee_revenue": return "commission_received";
    case "capital": case "reserves": case "retained_earnings": return "capital";
    case "owner_drawings": return "drawings";
    case "opening_balance_equity": return "opening_balances";
    default: break;
  }
  if (c.type === "expense") return "expenses_paid";
  if (c.type === "equity") return "capital";
  // Non-current assets (the 1200 group: investment property, equipment, intangibles).
  if (c.type === "asset" && c.code.startsWith("12")) return "investing";
  // Borrowings and related-party balances (2170, 2180, 2320).
  if (c.type === "liability" && /^(217|218|232)/.test(c.code)) return "borrowings";
  return "other_operating";
}

/**
 * The cash-flow line of a whole entry, from its posting rule. `null` means
 * "no single line": the entry is split across its counter-accounts
 * (lineOfCounter), which is exact because an entry balances.
 *
 * `cashNet` is the entry's net movement on the cash accounts (debit − credit);
 * `isReversal` when the entry is a reversal (its rule is the original's).
 */
export function lineOfRule(rule: Rule, counters: Counter[], cashNet: number, isReversal: boolean): CashLine | null {
  const has = (k: string) => counters.some((c) => c.systemKey === k);
  switch (rule) {
    case "E03": return "tenant_receipts";
    case "E33": return "ejar_settlements";
    case "E04": return has("deposits_held") ? "deposits_refunded" : "tenant_refunds";
    case "E20": return "tenant_refunds";
    case "E09": return "deposits_received";
    // A collection on a legacy deposit installment: negative = the deposit handed back.
    case "E09C": return !isReversal && cashNet < 0 ? "deposits_refunded" : "deposits_received";
    case "E10": return "deposits_refunded";
    case "E16": return "commission_received";
    // Owner mode (principal): a payout is the owner's drawings, a financing flow.
    case "E19": return has("owner_drawings") ? "drawings" : "landlord_payouts";
    case "E18": return "expenses_paid";
    case "E39": return "supplier_payments";
    default: return null;
  }
}

// ───────────────────────────── rent roll / receivables ─────────────────────────────

/** Charges and their reductions (invoice, due-date charge, debit note, rent receipt, agency fee, advance VAT, cancellation, credit note). */
const BILLED = new Set(["E01", "E02", "E05", "E06", "E07", "E08", "E17", "E34"]);
/** Money in and out (collection, refund, Ejar settlement, deposit applied to arrears). */
const COLLECTED = new Set(["E03", "E04", "E20", "E33", "E12B"]);

/**
 * The rent-roll column of a receivable (1121/1122) line: `billed` (net of
 * credit notes and cancellations), `collected` (net of refunds) or
 * `adjustment` (write-offs, transfers between contracts, manual and opening
 * lines). closing = opening + billed − collected + adjustment, exactly.
 */
export function arColumn(rule: Rule): "billed" | "collected" | "adjustment" {
  if (rule && BILLED.has(rule)) return "billed";
  if (rule && COLLECTED.has(rule)) return "collected";
  return "adjustment";
}

// ───────────────────────────── deposits register ─────────────────────────────

export type DepositColumn = "received" | "refunded" | "forfeited" | "converted" | "applied" | "other";

/**
 * The deposits-register column of a 2141 line. `credit` is the line's side as
 * posted; a reversal is classified as the line it mirrors (its side flipped),
 * so reversing a receipt lowers `received` rather than raising `refunded`.
 */
export function depositColumn(rule: Rule, credit: boolean, isReversal: boolean): DepositColumn {
  const asOriginal = isReversal ? !credit : credit;
  switch (rule) {
    case "E09": return "received";
    case "E09C": return asOriginal ? "received" : "refunded";
    case "E10": case "E04": return "refunded";
    case "E11": return "forfeited";
    case "E12": return "converted";
    case "E12B": return "applied";
    default: return "other";
  }
}

/** Signed amount a 2141 line adds to its column (received/other: credit − debit; the rest: debit − credit). */
export function depositAmount(col: DepositColumn, debit: number, credit: number): number {
  return col === "received" || col === "other" ? credit - debit : debit - credit;
}

export type DepositState = "none" | "not_collected" | "held" | "partially_released" | "refunded" | "forfeited" | "settled";

/** A contract's deposit state from its totals (halalas). */
export function depositState(x: { required: number; received: number; refunded: number; deducted: number; balance: number }): DepositState {
  if (x.received <= 0 && x.balance === 0) return x.required > 0 ? "not_collected" : "none";
  if (x.balance > 0) return x.refunded > 0 || x.deducted > 0 ? "partially_released" : "held";
  if (x.refunded > 0 && x.deducted === 0) return "refunded";
  if (x.deducted > 0 && x.refunded === 0) return "forfeited";
  return "settled";
}

// ───────────────────────────── shared ─────────────────────────────

/** part ÷ whole as a percentage string with two decimals ("94.91"), or null when whole is 0. */
export function pct(part: number, whole: number): string | null {
  if (!whole) return null;
  const bp = Math.round((part * 10_000) / whole);
  const sign = bp < 0 ? "-" : "";
  const a = Math.abs(bp);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** Whole days from `a` to `b` (b − a), both `YYYY-MM-DD`. */
export function daysFrom(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
