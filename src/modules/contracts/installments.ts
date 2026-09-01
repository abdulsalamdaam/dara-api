export type FeeEntry = {
  id: string; name: string; amount: string; recurrence: string; dueDate: string; paymentMethod: string;
  // Used when recurrence === "custom": a hand-built list of {dueDate, amount}.
  customSchedule?: Array<{ dueDate: string; amount: string | number }>;
  // When true, 15% VAT is added on top of every installment of this fee.
  vat?: boolean;
};
/** Per-year rent override — `year` is 1-based (year 1, 2, 3, …). */
export type RentTerm = { year: number; amount: number };
/** One hand-built rent installment for a custom payment schedule. */
export type CustomScheduleEntry = { dueDate: string; amount: number | string };
export type InstallmentRow = { contractId: number; userId: number; amount: string; dueDate: string; status: "pending" | "settled_external"; paidDate?: string | null; description: string | null; vatEnabled: boolean; isDemo: boolean };

/**
 * Mark installments whose due date precedes `settledUntil` as `settled_external`
 * (rent collected outside the portal before onboarding). Stamps paidDate = due
 * date. No collection rows are created, so these never enter revenue/overdue.
 */
export function applyExternalSettlement(rows: InstallmentRow[], settledUntil?: string | null): InstallmentRow[] {
  if (!settledUntil) return rows;
  return rows.map((r) => (r.dueDate < settledUntil ? { ...r, status: "settled_external" as const, paidDate: r.dueDate } : r));
}

export const VAT_RATE = 0.15;
/** Round to 2 decimals without binary-float drift (e.g. 0.1 + 0.2). */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Put the rounding remainder of a run of installments onto its LAST row, so
 * the schedule sums to exactly what was contracted.
 *
 * Every period used to be rounded on its own and nothing reconciled the
 * result: a 10,000 annual rent paid monthly is 833.333… a month, which stores
 * as 12 × 833.33 = 9,999.96 — four halalas that were never billed, on every
 * contract whose rent does not divide cleanly by its cycle. The same applies to
 * a recurring fee split across its cycle, and to VAT-inclusive rows, where the
 * ×1.15 makes an exact division inexact.
 *
 * `exactTotal` is the sum of the UNROUNDED per-period amounts — i.e. the
 * contracted figure for this run — and the last row absorbs the difference.
 * The adjustment is only ever a few halalas, so it lands on the final period
 * rather than being smeared across the schedule, which keeps every other
 * installment on the round figure the landlord and tenant agreed.
 */
function reconcileToTotal(rows: InstallmentRow[], from: number, exactTotal: number): void {
  if (rows.length <= from) return;
  let sum = 0;
  for (let i = from; i < rows.length; i++) sum = round2(sum + Number(rows[i]!.amount));
  const diff = round2(round2(exactTotal) - sum);
  if (diff === 0) return;
  const last = rows[rows.length - 1]!;
  last.amount = round2(Number(last.amount) + diff).toFixed(2);
}

/**
 * Add `n` months to `base`, anchored to the base day-of-month and clamped to
 * the target month's length — UTC-based to match `new Date("YYYY-MM-DD")`.
 * Plain `Date.setMonth(+n)` overflows (e.g. Jan 31 + 1 month → Mar 2), which
 * drifts/skips months over a year; this keeps every period on the start day.
 */
export function addMonthsUTC(base: Date, n: number): Date {
  const day = base.getUTCDate();
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export function buildInstallments(
  contractId: number,
  userId: number,
  startDate: string,
  endDate: string,
  monthlyRent: string,
  paymentFrequency: string,
  additionalFees?: FeeEntry[] | null,
  vatEnabled = false,
  escalationRate = 0,
  escalationType = "percent",
  rentTerms?: RentTerm[] | null,
  prepaidRent = 0,
  customSchedule?: CustomScheduleEntry[] | null,
): InstallmentRow[] {
  const monthly = parseFloat(monthlyRent) || 0;
  const start = new Date(startDate);
  const end = new Date(endDate);
  const rows: InstallmentRow[] = [];

  // ── Custom payment schedule ──────────────────────────────────────────
  // When the cycle is "custom", the rent rows come straight from the
  // user-laid-out list (date + amount each). VAT, when on, is added on top
  // of each entered amount, mirroring the periodic path. Prepaid rent and
  // additional fees are still applied below via a shared exit.
  if (paymentFrequency === "custom" && customSchedule && customSchedule.length > 0) {
    const rentStart = rows.length;
    let exactTotal = 0;
    for (const e of customSchedule) {
      const base = Number(e.amount) || 0;
      if (!e.dueDate || base <= 0) continue;
      const amount = vatEnabled ? base * (1 + VAT_RATE) : base;
      exactTotal += amount;
      rows.push({
        contractId, userId,
        amount: round2(amount).toFixed(2),
        dueDate: new Date(e.dueDate).toISOString().split("T")[0]!,
        status: "pending",
        description: null,
        vatEnabled,
        isDemo: false,
      });
    }
    // The hand-entered amounts ARE the contracted figures — with VAT on top
    // they stop dividing cleanly, so the run still has to reconcile.
    reconcileToTotal(rows, rentStart, exactTotal);
    applyPrepaid(rows, rentStart, prepaidRent);
    appendFees(rows, contractId, userId, start, end, additionalFees);
    return sortRows(rows);
  }

  let stepMonths = 1;
  if (paymentFrequency === "quarterly") stepMonths = 3;
  else if (paymentFrequency === "semi_annual") stepMonths = 6;
  else if (paymentFrequency === "annual" || paymentFrequency === "yearly") stepMonths = 12;
  // Base annual rent; the per-period figure is a fraction of it.
  const baseAnnual = monthly * 12;
  const periodFrac = stepMonths / 12;
  // 'percent' → compound a rate; 'amount' → add a fixed yearly SAR amount.
  const escRate = escalationType === "amount" ? 0 : (Number(escalationRate) || 0) / 100;
  const escAmountAnnual = escalationType === "amount" ? (Number(escalationRate) || 0) : 0;
  // Per-year overrides — keyed by 1-based contract year.
  const termMap = new Map<number, number>();
  for (const t of rentTerms || []) {
    const y = Number(t.year), a = Number(t.amount);
    if (Number.isFinite(y) && y > 0 && Number.isFinite(a) && a > 0) termMap.set(y, a);
  }

  // Rent rows first (so prepaid can be applied to the earliest ones). Each
  // period is anchored to the start day (clamped) to avoid month drift.
  const rentStart = rows.length;
  let period = 0;
  let cursor = addMonthsUTC(start, 0);
  // Running sum of the UNROUNDED period amounts — the contracted total this
  // schedule has to add up to once every row is rounded to halalas.
  let exactRentTotal = 0;
  while (cursor <= end) {
    // Contract-year index (0-based) → escalation / per-year overrides.
    const monthsSince = period * stepMonths;
    const year = Math.max(0, Math.floor(monthsSince / 12));
    // An explicit per-year rate wins; otherwise the escalated base rent.
    const annualForYear = termMap.has(year + 1)
      ? termMap.get(year + 1)!
      : baseAnnual * Math.pow(1 + escRate, year) + escAmountAnnual * year;
    let amount = annualForYear * periodFrac;
    if (vatEnabled) amount = amount * (1 + VAT_RATE);
    exactRentTotal += amount;
    rows.push({
      contractId, userId,
      amount: round2(amount).toFixed(2),
      dueDate: cursor.toISOString().split("T")[0]!,
      status: "pending",
      description: null,
      vatEnabled,
      isDemo: false,
    });
    period++;
    cursor = addMonthsUTC(start, period * stepMonths);
  }

  // Reconcile BEFORE the prepaid deduction: the remainder belongs to the rent
  // schedule, not to whatever is left after an advance has eaten into it.
  reconcileToTotal(rows, rentStart, exactRentTotal);
  applyPrepaid(rows, rentStart, prepaidRent);
  appendFees(rows, contractId, userId, start, end, additionalFees);
  return sortRows(rows);
}

/** Deduct prepaid rent from the earliest rent installment(s), in place. */
function applyPrepaid(rows: InstallmentRow[], rentStart: number, prepaidRent: number) {
  let leftover = round2(Number(prepaidRent) || 0);
  for (let i = rentStart; i < rows.length && leftover > 0; i++) {
    const amt = Number(rows[i]!.amount);
    const ded = Math.min(leftover, amt);
    rows[i]!.amount = round2(amt - ded).toFixed(2);
    leftover = round2(leftover - ded);
  }
}

/** Append additional-fee installments across the contract span, in place. */
function appendFees(
  rows: InstallmentRow[], contractId: number, userId: number,
  start: Date, end: Date, additionalFees?: FeeEntry[] | null,
) {
  if (!additionalFees || additionalFees.length === 0) return;

  for (const fee of additionalFees) {
    // 15% VAT added on top of the fee when opted in.
    const feeVat = fee.vat ? 1 + VAT_RATE : 1;

    // Custom fee schedule — one row per hand-built {dueDate, amount}.
    if (fee.recurrence === "custom") {
      for (const e of fee.customSchedule || []) {
        const amt = Number(e?.amount) || 0;
        if (!e?.dueDate || amt <= 0) continue;
        rows.push({
          contractId, userId,
          amount: round2(amt * feeVat).toFixed(2),
          dueDate: new Date(e.dueDate).toISOString().split("T")[0]!,
          status: "pending",
          description: fee.name || "رسوم",
          vatEnabled: !!fee.vat,
          isDemo: false,
        });
      }
      continue;
    }

    const feeAnnual = parseFloat(fee.amount) || 0;
    if (feeAnnual <= 0) continue;

    // A one-time fee is charged once in full.
    if (fee.recurrence === "one_time" || fee.recurrence === "once") {
      const d = fee.dueDate ? new Date(fee.dueDate) : new Date(start);
      rows.push({
        contractId, userId,
        amount: round2(feeAnnual * feeVat).toFixed(2),
        dueDate: d.toISOString().split("T")[0]!,
        status: "pending",
        description: fee.name || "رسوم",
        vatEnabled: !!fee.vat,
        isDemo: false,
      });
      continue;
    }

    // Recurring fees behave like rent: the entered amount is the ANNUAL fee,
    // split across the cycle. step/12 is the per-occurrence fraction —
    // e.g. 1000 quarterly → 250 each (×4 = 1000/yr); 1000 monthly → 83.33 each.
    const step = fee.recurrence === "annual" ? 12 : fee.recurrence === "semi_annual" ? 6 : fee.recurrence === "quarterly" ? 3 : 1;
    const perPeriod = feeAnnual * (step / 12) * feeVat;
    const feeStart = rows.length;
    let feeExactTotal = 0;
    for (let i = 0, d = addMonthsUTC(start, 0); d <= end; i++, d = addMonthsUTC(start, i * step)) {
      feeExactTotal += perPeriod;
      rows.push({
        contractId, userId,
        amount: round2(perPeriod).toFixed(2),
        dueDate: d.toISOString().split("T")[0]!,
        status: "pending",
        description: fee.name || "رسوم",
        vatEnabled: !!fee.vat,
        isDemo: false,
      });
    }
    // Same reconciliation as rent: 1,000 a year billed monthly is 83.33 a
    // month, which is 999.96 unless the last occurrence carries the remainder.
    reconcileToTotal(rows, feeStart, feeExactTotal);
  }
}

/** Sort by due date, with rent rows (null description) before fee rows. */
function sortRows(rows: InstallmentRow[]): InstallmentRow[] {
  rows.sort((a, b) => {
    const dc = a.dueDate.localeCompare(b.dueDate);
    if (dc !== 0) return dc;
    if (a.description === null && b.description !== null) return -1;
    if (a.description !== null && b.description === null) return 1;
    return 0;
  });
  return rows;
}
