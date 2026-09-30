/**
 * Straight-line depreciation (DESIGN §8.5). Pure, integer halalas.
 *
 * Depreciable base D = cost − salvage − openingAccumulated, spread evenly over
 * `lifeMonths` counted from `start` (YYYY-MM-DD). The first month is pro-rata
 * by day (start day included): an asset bought on the 16th of a 30-day month
 * gets 15/30 of a month. The schedule is CUMULATIVE and rounded once per
 * month end:
 *
 *   cum(t) = min(D, round(D × elapsedMonths(t) / lifeMonths))
 *
 * and a month's charge is cum(month end) − cum(previous month end). So the
 * charges add up to D exactly (no rounding drift), the last (partial) month
 * takes the remainder, and nothing is charged once the net book value reaches
 * salvage. With a pro-rata first month the schedule runs into month
 * lifeMonths + 1. lifeMonths = 0 means not depreciated (land).
 *
 * A disposal on day d of a month charges that month up to and including d.
 */

export interface ScheduleInput {
  /** Halalas. */
  cost: number;
  salvage: number;
  opening: number;
  lifeMonths: number;
  /** Depreciation start date, YYYY-MM-DD. */
  start: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "YYYY-MM" → months since year 0 (for differences). */
export function monthIndex(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return y * 12 + (m - 1);
}

export function monthOfIndex(i: number): string {
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}

export function addMonths(ym: string, n: number): string {
  return monthOfIndex(monthIndex(ym) + n);
}

export function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${pad(daysInMonth(y, m))}`;
}

export const monthOf = (date: string) => date.slice(0, 7);

export function depreciableBase(a: ScheduleInput): number {
  return Math.max(0, a.cost - a.salvage - a.opening);
}

/** Round half up of n / d for non-negative BigInts. */
function divRound(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

/**
 * Cumulative depreciation from `start` through `date` inclusive (default:
 * through the end of `date`'s month is the caller's choice; pass the day).
 */
export function cumulativeAt(a: ScheduleInput, date: string): number {
  const D = depreciableBase(a);
  if (D <= 0 || a.lifeMonths <= 0 || date < a.start) return 0;
  const [sy, sm, sd] = a.start.split("-").map(Number);
  const [y, m, d] = date.split("-").map(Number);
  const dim0 = daysInMonth(sy, sm);
  let num: bigint;
  let den: bigint;
  if (y === sy && m === sm) {
    num = BigInt(d - sd + 1);
    den = BigInt(dim0);
  } else {
    // first month's part + the full months strictly between + d/dim of the current month
    const dimT = daysInMonth(y, m);
    const between = monthIndex(`${y}-${pad(m)}`) - monthIndex(`${sy}-${pad(sm)}`) - 1;
    num = BigInt(dim0 - sd + 1) * BigInt(dimT) + BigInt(between) * BigInt(dim0) * BigInt(dimT) + BigInt(d) * BigInt(dim0);
    den = BigInt(dim0) * BigInt(dimT);
  }
  const cum = divRound(BigInt(D) * num, den * BigInt(a.lifeMonths));
  return Number(cum > BigInt(D) ? BigInt(D) : cum);
}

/** Cumulative depreciation through the end of month `ym`. */
export function cumulativeThroughMonth(a: ScheduleInput, ym: string): number {
  return cumulativeAt(a, monthEnd(ym));
}

/** The charge for month `ym` (0 before the start and after the base is used up). */
export function monthCharge(a: ScheduleInput, ym: string): number {
  if (ym < monthOf(a.start)) return 0;
  return cumulativeThroughMonth(a, ym) - cumulativeThroughMonth(a, addMonths(ym, -1));
}

/** The disposal month's charge: from its first day (or the start) through the disposal date. */
export function partialCharge(a: ScheduleInput, disposalDate: string): number {
  const ym = monthOf(disposalDate);
  if (ym < monthOf(a.start)) return 0;
  return cumulativeAt(a, disposalDate) - cumulativeThroughMonth(a, addMonths(ym, -1));
}

/** The month the base is fully depreciated (the last month with a charge), or null when never depreciated. */
export function lastChargeMonth(a: ScheduleInput): string | null {
  if (depreciableBase(a) <= 0 || a.lifeMonths <= 0) return null;
  const first = monthOf(a.start);
  // the schedule ends in month lifeMonths (start on the 1st) or lifeMonths + 1 (pro-rata first month)
  for (let k = a.lifeMonths - 1; k <= a.lifeMonths + 1; k++) {
    const ym = addMonths(first, k);
    if (cumulativeThroughMonth(a, ym) >= depreciableBase(a)) return ym;
  }
  return addMonths(first, a.lifeMonths + 1);
}

export interface ScheduleRow {
  month: string;
  charge: number;
  /** Accumulated including the opening accumulated depreciation. */
  accumulated: number;
  /** Net book value at the month end. */
  nbv: number;
}

/** Every month from the start to the last charge (or `until`, whichever is first). */
export function schedule(a: ScheduleInput, until?: string): ScheduleRow[] {
  const last = lastChargeMonth(a);
  if (!last) return [];
  const end = until && until < last ? until : last;
  const out: ScheduleRow[] = [];
  for (let ym = monthOf(a.start); ym <= end; ym = addMonths(ym, 1)) {
    const cum = cumulativeThroughMonth(a, ym);
    out.push({ month: ym, charge: monthCharge(a, ym), accumulated: a.opening + cum, nbv: a.cost - a.opening - cum });
  }
  return out;
}

/**
 * Disposal figures (FA03): the disposal month's charge up to the date, the
 * accumulated depreciation removed (opening + everything charged through the
 * disposal date), the net book value and the gain (> 0) or loss (< 0).
 */
export function disposalFigures(a: ScheduleInput, disposalDate: string, proceeds: number) {
  const partial = partialCharge(a, disposalDate);
  const before = a.opening + cumulativeThroughMonth(a, addMonths(monthOf(disposalDate), -1));
  const accumulated = before + partial;
  const nbv = a.cost - accumulated;
  return { partial, accumulatedBefore: before, accumulated, nbv, gain: proceeds - nbv };
}
