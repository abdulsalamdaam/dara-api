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
 *
 * GENERAL SERVICES (verified on 20498373268's contract PDF, 28 Oct 2026): the
 * "25% on top" was 15% VAT plus «الأجرة السنوية للخدمات العامة» — 6,350 a year
 * of maintenance fees, billed inside every rent payment WITHOUT VAT (each
 * invoice = 31,750 rent + 4,762.50 VAT + 3,175 services = 39,687). Ejar's API
 * has no field for it, but it is exactly what the invoices carry beyond
 * total_rent_amount (+ VAT when Ejar charges it). When that remainder is there
 * it is NOT rent: the rent is total_rent_amount ÷ 12, the services become their
 * own fee on the invoices' dates, and each rent installment drops its share —
 * otherwise VAT would be extracted from the services too. The security deposit
 * (security_deposit_value) is a separate, one-off figure and never in the
 * invoices; on this contract it happens to be the same 6,350.
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
  /** The general-services share of the invoices (see above), or null when there is none. */
  services?: EjarServices | null;
}

/** General services Ejar bills inside the rent payments, before any VAT. */
export interface EjarServices {
  /** Per contract year. */
  annual: number;
  /** Over the whole contract. */
  total: number;
  /** One entry per invoice, same order and dates as the rent schedule. */
  schedule: Array<{ dueDate: string; amount: number }>;
}

/**
 * What the invoices carry beyond the rent (and its VAT when Ejar charges it).
 * `ejarVat` is Ejar's own treatment — its contract type — not Dara's verdict:
 * it decides how Ejar built the amounts. Null when there is no remainder worth
 * a fee (under 1 SAR: Ejar's rounding), when Ejar sent no annual rent, or when
 * the remainder is implausible (over half the bills — a rent that changes by
 * year, not a service), so nothing is split on a guess.
 */
export function ejarServices(
  m: {
    contract: { periodDays?: number | null; startDate: string | null; endDate: string | null };
    financial: { totalRentAmount: number | null };
    invoices: Array<{ dueDate?: string | null; amount: number | null }>;
  },
  ejarVat: boolean,
): EjarServices | null {
  const annual = pos(m.financial.totalRentAmount);
  const bills = m.invoices.filter((i) => i.dueDate && pos(i.amount) != null) as Array<{ dueDate: string; amount: number }>;
  if (annual == null || bills.length === 0) return null;
  const gross = round2(bills.reduce((s, i) => s + i.amount, 0));
  const years = contractMonths(m.contract) / 12;
  const total = round2(gross - annual * years * (ejarVat ? 1 + RENT_VAT_RATE : 1));
  if (total < 1 || total > gross / 2) return null;
  // Ejar bills the same services amount with every payment; the last absorbs the halalas.
  const each = round2(total / bills.length);
  const schedule = bills.map((b, i) => ({
    dueDate: b.dueDate,
    amount: i === bills.length - 1 ? round2(total - each * (bills.length - 1)) : each,
  }));
  return { annual: round2(total / years), total, schedule };
}

export function rentBasis(m: {
  contract: { periodDays?: number | null; startDate: string | null; endDate: string | null; totalValue?: number | null };
  financial: { totalRentAmount: number | null };
  invoices: Array<{ dueDate?: string | null; amount: number | null }>;
}, ejarVat?: boolean): RentBasis {
  const schedule = round2(m.invoices.reduce((s, i) => s + (pos(i.amount) ?? 0), 0));
  return {
    gross: pos(schedule) ?? pos(m.contract.totalValue ?? null),
    months: contractMonths(m.contract),
    annualExVat: pos(m.financial.totalRentAmount),
    services: ejarVat === undefined ? null : ejarServices(m, ejarVat),
  };
}

/** The rent part of each invoice — the invoice less its services share. */
export function rentSchedule(
  invoices: Array<{ dueDate: string; amount: string }>, services: EjarServices | null | undefined,
): Array<{ dueDate: string; amount: string }> {
  if (!services) return invoices;
  return invoices.map((i, k) => ({ dueDate: i.dueDate, amount: String(round2(Number(i.amount) - (services.schedule[k]?.amount ?? 0))) }));
}

/** The monthly rent before VAT, 2 decimals (0 when Ejar gave nothing to go on). */
export function monthlyRentFrom(b: RentBasis, vat: boolean): number {
  // Services split out: what is left is exactly Ejar's annual rent.
  if (b.services && b.annualExVat != null) return round2(b.annualExVat / 12);
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
  /** General services billed with the rent — imported as their own fee. */
  services: EjarServices | null;
}

export function rentFigures(b: RentBasis, vat: boolean): RentFigures {
  const monthly = monthlyRentFrom(b, vat);
  const services = b.services ?? null;
  // With services split out the annual rent is Ejar's own figure, not
  // monthly × 12 (5,291.67 × 12 = 63,500.04 for 63,500).
  const annual = services && b.annualExVat != null ? round2(b.annualExVat) : round2(monthly * 12);
  // The rent's own gross: the bills less the services in them.
  const rentGross = b.gross != null ? round2(b.gross - (services?.total ?? 0)) : null;
  return {
    total: b.gross,
    months: b.months,
    vat,
    monthly,
    annual,
    annualVat: vat ? round2(annual * RENT_VAT_RATE) : 0,
    totalVat: vat && rentGross != null ? round2(rentGross - rentGross / (1 + RENT_VAT_RATE)) : 0,
    ejarAnnualRent: b.annualExVat,
    services,
  };
}
