/**
 * Asia/Riyadh business dates and fiscal-period arithmetic (DESIGN §2.3.3).
 * Riyadh has no DST (UTC+3 all year), but the conversion goes through Intl so
 * nothing here depends on that.
 */
export { riyadhToday } from "../../common/payment-status";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(d: string): { y: number; m: number; day: number } {
  const m = DATE_RE.exec(String(d).slice(0, 10));
  if (!m) throw new Error(`fv2: not an ISO date: ${d}`);
  return { y: Number(m[1]), m: Number(m[2]), day: Number(m[3]) };
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

export function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export interface PeriodSpan {
  /** Labelled by the calendar year the fiscal year STARTS in. */
  fiscalYear: number;
  /** 1..12, counted from the fiscal year's first month. */
  periodNo: number;
  startsOn: string;
  endsOn: string;
}

/** The monthly fiscal period containing `date`, for a fiscal year starting in `startMonth` (1..12). */
export function periodFor(date: string, startMonth = 1): PeriodSpan {
  if (!(startMonth >= 1 && startMonth <= 12)) throw new Error(`fv2: bad fiscal start month ${startMonth}`);
  const { y, m } = parseIsoDate(date);
  const fiscalYear = m >= startMonth ? y : y - 1;
  const periodNo = ((m - startMonth + 12) % 12) + 1;
  return {
    fiscalYear,
    periodNo,
    startsOn: `${y}-${pad(m)}-01`,
    endsOn: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}`,
  };
}

/** The twelve monthly periods of a fiscal year. */
export function periodsOfFiscalYear(fiscalYear: number, startMonth = 1): PeriodSpan[] {
  const out: PeriodSpan[] = [];
  for (let i = 0; i < 12; i++) {
    const m0 = startMonth - 1 + i;
    const y = fiscalYear + Math.floor(m0 / 12);
    const m = (m0 % 12) + 1;
    out.push({ fiscalYear, periodNo: i + 1, startsOn: `${y}-${pad(m)}-01`, endsOn: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}` });
  }
  return out;
}
