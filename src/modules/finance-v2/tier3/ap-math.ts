/**
 * Accounts-payable arithmetic (DESIGN §8.4). Pure, integer halalas.
 */
import { expenseAmounts } from "../tier1/expense-math";
import { bucketOf, type Bucket } from "../reports/sub-math";
import { daysBetween } from "../reports/core-math";
import type { VatCategory } from "../rules";

/**
 * A supplier's VAT rounding may differ from ours by a few halalas on a line;
 * an explicit VAT figure (copied from the tax invoice) is accepted within
 * this tolerance of the computed one, and never on a non-S line.
 */
export const VAT_TOLERANCE_HALALAS = 10;

export interface BillLineAmounts {
  net: number;
  vat: number;
  rate: number;
}

/**
 * One bill line from what the user typed. `amount` is net or gross per
 * `mode`; S splits/adds VAT at `rate` exactly as expenses do. `vatOverride`
 * (halalas) replaces the computed VAT when within tolerance; with a gross
 * amount the net is then gross − override, so the line still totals `amount`.
 * Throws a plain Error with a code prefix the service maps to 400.
 */
export function billLineAmounts(mode: "net" | "gross", amount: number, category: VatCategory, rate: number, vatOverride: number | null): BillLineAmounts {
  const a = expenseAmounts(mode, amount, category, rate);
  if (vatOverride == null) return { net: a.net, vat: a.vat, rate: a.rate };
  if (category !== "S") throw new Error("VAT_NOT_ALLOWED: only a standard-rated (S) line carries VAT");
  if (!Number.isSafeInteger(vatOverride) || vatOverride < 0) throw new Error("BAD_VAT: the VAT amount must be a non-negative amount");
  if (Math.abs(vatOverride - a.vat) > VAT_TOLERANCE_HALALAS) {
    throw new Error(`VAT_MISMATCH: the VAT differs from ${a.rate}% of the net by more than ${VAT_TOLERANCE_HALALAS / 100} SAR`);
  }
  if (mode === "gross") {
    const net = amount - vatOverride;
    if (net <= 0) throw new Error("BAD_AMOUNT: the net amount must be positive");
    return { net, vat: vatOverride, rate: a.rate };
  }
  return { net: a.net, vat: vatOverride, rate: a.rate };
}

/** Due date = bill date + payment terms (days), YYYY-MM-DD (calendar days, no time zone involved). */
export function dueDateOf(billDate: string, termsDays: number): string {
  const [y, m, d] = billDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + termsDays)).toISOString().slice(0, 10);
}

export interface ApItemIn {
  total: number;
  paid: number;
  dueDate: string;
}

/** A bill's AP-aging placement as of `asOf`: remaining, days past due and bucket (due date = day 0). */
export function apAgingOf(i: ApItemIn, asOf: string): { remaining: number; daysPastDue: number; bucket: Bucket } {
  const remaining = i.total - i.paid;
  const daysPastDue = daysBetween(i.dueDate, asOf);
  return { remaining, daysPastDue, bucket: bucketOf(daysPastDue) };
}

/** Payment status of a bill from its total and what posted payments allocated to it. */
export function paymentStatusOf(total: number, paid: number): "unpaid" | "partial" | "paid" {
  if (paid <= 0) return "unpaid";
  return paid >= total ? "paid" : "partial";
}
