/**
 * The rent an imported Ejar contract is stored with — one rule for the
 * lookup's review and the import, so the contract header, its installments
 * and its totals agree.
 *
 * What Ejar sends (verified on 20498373268 and 20499000017):
 *
 *  - Invoices `rental_fees.total_rent_amount` is the rent PER CONTRACT YEAR,
 *    before VAT. On a one-year residential lease it equals the whole schedule
 *    (48,000 = 4 × 12,000); on a three-year commercial lease it is 63,500
 *    while the six invoices and Get Contracts `total_value` are 238,125
 *    (= 63,500 × 3 years × 1.25). It is NOT the contract total, and Ejar does
 *    not say what the 25% on top is made of beyond 15% VAT.
 *  - The invoices are what the tenant is actually billed, VAT included, and
 *    they become the contract's installments as they are.
 *
 * So Dara takes the rent from the invoices, not from total_rent_amount:
 *
 *   gross    = Σ invoice amounts            (else total_value)
 *   months   = Ejar's `period` in months     (else the start→end span)
 *   monthly  = gross ÷ (1.15 if rent VAT applies, else 1) ÷ months,  2 decimals
 *   annual   = monthly × 12;  annual VAT = annual × 15%;  total VAT = gross − gross ÷ 1.15
 *
 * which is exactly what the installments carry: their VAT is extracted from
 * the VAT-inclusive amounts. Only when Ejar sent neither invoices nor a total
 * is total_rent_amount used — as the annual rent before VAT.
 */

export const RENT_VAT_RATE = 0.15;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pos = (v: number | null | undefined): number | null => (v != null && Number.isFinite(v) && v > 0 ? v : null);

/** Months covered by [start, end], at least 1. */
export function spanMonths(start: string | null, end: string | null): number {
  const a = Date.parse(String(start)), b = Date.parse(String(end));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 12;
  const days = (b - a) / 86_400_000 + 1;
  return Math.max(1, Math.round(days / (365.25 / 12)));
}

/** The contract's length in months: Ejar's `period` (days) when it sent one, else the date span. */
export function contractMonths(c: { periodDays?: number | null; startDate: string | null; endDate: string | null }): number {
  const p = pos(c.periodDays ?? null);
  return p != null ? Math.max(1, Math.round(p / (365 / 12))) : spanMonths(c.startDate, c.endDate);
}

/** What the rent is derived from — kept on the import plan so the writer can apply the final VAT verdict. */
export interface RentBasis {
  /** What the tenant is billed over the whole contract, VAT included when it applies. */
  gross: number | null;
  months: number;
  /** Ejar's annual rent before VAT — used only when there is no gross. */
  annualExVat: number | null;
}

export function rentBasis(m: {
  contract: { periodDays?: number | null; startDate: string | null; endDate: string | null; totalValue?: number | null };
  financial: { totalRentAmount: number | null };
  invoices: Array<{ amount: number | null }>;
}): RentBasis {
  const schedule = round2(m.invoices.reduce((s, i) => s + (pos(i.amount) ?? 0), 0));
  return {
    gross: pos(schedule) ?? pos(m.contract.totalValue ?? null),
    months: contractMonths(m.contract),
    annualExVat: pos(m.financial.totalRentAmount),
  };
}

/** The monthly rent before VAT, 2 decimals (0 when Ejar gave nothing to go on). */
export function monthlyRentFrom(b: RentBasis, vat: boolean): number {
  if (b.gross != null) return round2(b.gross / (vat ? 1 + RENT_VAT_RATE : 1) / b.months);
  if (b.annualExVat != null) return round2(b.annualExVat / 12);
  return 0;
}

/** The figures the review shows, under a VAT verdict. */
export interface RentFigures {
  /** Σ invoices (or total_value): the contract's total, VAT included. */
  total: number | null;
  months: number;
  vat: boolean;
  monthly: number;
  /** Annual rent before VAT. */
  annual: number;
  annualVat: number;
  /** VAT over the whole contract, as the installments carry it. */
  totalVat: number;
  /** Ejar's own rental_fees.total_rent_amount (per contract year, before VAT). */
  ejarAnnualRent: number | null;
}

export function rentFigures(b: RentBasis, vat: boolean): RentFigures {
  const monthly = monthlyRentFrom(b, vat);
  const annual = round2(monthly * 12);
  return {
    total: b.gross,
    months: b.months,
    vat,
    monthly,
    annual,
    annualVat: vat ? round2(annual * RENT_VAT_RATE) : 0,
    totalVat: vat && b.gross != null ? round2(b.gross - b.gross / (1 + RENT_VAT_RATE)) : 0,
    ejarAnnualRent: b.annualExVat,
  };
}
