/**
 * Operational reports — the pure pieces: types, date arithmetic, the
 * installment money model and the small classifiers (aging, expiry, rates).
 *
 * Nothing here touches the database, so every rule a report number depends on
 * is unit-tested on its own (`ops-core.spec.ts`). The builders in
 * `ops-builders.ts` are pure too; only `ops-data.ts` reads Postgres.
 *
 * Shared contract: OPS-REPORTS-CONTRACT.md (ids, response shape and field
 * names are fixed — the web keys on them).
 */
import { liveStatus, riyadhToday } from "../../../common/payment-status";

export { riyadhToday };

/* ── contract types ─────────────────────────────────────────────────────── */

export type Lbl = { ar: string; en: string };
export type Tone = "good" | "bad" | "warn" | "neutral" | "brand";
export type Unit = "count" | "sar" | "pct" | "days";

export type OpsReportId =
  | "tenant_balances" | "defaulting_tenants" | "tenant_payment_behavior" | "landlord_portfolio"
  | "vacant_units" | "property_performance" | "occupancy_trend"
  | "contracts_report" | "expiring_contracts" | "contract_movement"
  | "collections_summary" | "installments_schedule"
  | "maintenance_requests" | "data_quality";

export type OpsFilterKey = "from" | "to" | "asOf" | "ownerId" | "propertyId" | "status" | "days";

export type OpsParams = {
  from?: string; to?: string; asOf?: string;
  ownerId?: number | null; propertyId?: number | null;
  status?: string | null; days?: number;
};

export type OpsReportMeta = {
  id: OpsReportId;
  category: "people" | "properties" | "contracts" | "collections" | "operations";
  label: Lbl; description: Lbl;
  filters: OpsFilterKey[];
  defaults?: Partial<OpsParams>;
};

export type OpsKpi = { key: string; label: Lbl; value: number; unit: Unit; tone?: Tone };
export type OpsChart = {
  key: string; type: "bar" | "hbar" | "donut" | "line" | "stacked";
  title: Lbl; unit: Unit;
  series: { key: string; label: Lbl; color?: string }[];
  data: ({ label: string; labelEn?: string } & Record<string, number | string>)[];
};
export type OpsColumn = {
  key: string; label: Lbl;
  type: "text" | "number" | "sar" | "pct" | "date" | "days" | "status" | "phone";
  statusMap?: Record<string, Lbl & { tone?: Tone }>;
};
export type OpsRow = Record<string, string | number | null>;
export type OpsReport = {
  id: OpsReportId;
  params: OpsParams;
  generatedAt: string;
  kpis: OpsKpi[];
  charts: OpsChart[];
  columns: OpsColumn[];
  rows: OpsRow[];
  totals?: Record<string, number>;
  notes?: Lbl[];
  statusOptions?: { value: string; label: Lbl }[];
};

/* ── numbers ────────────────────────────────────────────────────────────── */

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;
/** Money below half a halala is noise from float sums, not a balance. */
export const EPS = 0.005;

/** A 0–100 percentage at 1 dp, or null when the denominator is zero (there is nothing to rate). */
export function pct(numerator: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return round1((numerator / denominator) * 100);
}

/* ── dates (YYYY-MM-DD, calendar arithmetic in UTC so no DST/timezone drift) ── */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const toMs = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
export function addDays(d: string, n: number): string {
  return new Date(toMs(d) + n * 86400000).toISOString().slice(0, 10);
}
/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toMs(b) - toMs(a)) / 86400000);
}
export function firstOfMonth(d: string): string { return `${d.slice(0, 7)}-01`; }
export function lastOfMonth(d: string): string {
  const [y, m] = d.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
/** The first day of the month `n` months from `d`'s month (n may be negative). */
export function addMonthsFirst(d: string, n: number): string {
  const [y, m] = d.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
}
/** A timestamp's calendar date in Asia/Riyadh. */
export function riyadhDate(ts: Date | string | null | undefined): string | null {
  if (ts == null) return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Riyadh" });
}

export type MonthSlot = { ym: string; start: string; end: string };
/** Every calendar month touching [from, to], each clipped to the window. */
export function monthsIn(from: string, to: string): MonthSlot[] {
  const out: MonthSlot[] = [];
  let cur = firstOfMonth(from);
  while (cur <= to) {
    const end = lastOfMonth(cur);
    out.push({ ym: cur.slice(0, 7), start: cur < from ? from : cur, end: end > to ? to : end });
    cur = addMonthsFirst(cur, 1);
  }
  return out;
}

const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(ym: string): Lbl {
  const [y, m] = ym.split("-").map(Number);
  return { ar: `${AR_MONTHS[m - 1]} ${y}`, en: `${EN_MONTHS[m - 1]} ${y}` };
}

/* ── parameters ─────────────────────────────────────────────────────────── */

export class OpsParamError extends Error {}

export type DateDefault = "last12" | "thisMonth" | "none";
export type ResolvedParams = {
  from: string; to: string; asOf: string; today: string;
  ownerId: number | null; propertyId: number | null;
  status: string | null; days: number;
};

const MAX_RANGE_DAYS = 3660; // ten years — a monthly report beyond that is a mistake, not a question

function parseId(raw: unknown, name: string): number | null {
  if (raw == null || raw === "" || raw === "all") return null;
  const s = String(raw).trim();
  if (!/^\d{1,10}$/.test(s)) throw new OpsParamError(`${name} must be a positive integer`);
  const n = Number(s);
  if (!(n > 0 && n <= 2147483647)) throw new OpsParamError(`${name} must be a positive integer`);
  return n;
}

/**
 * Resolve the query string to the params a report actually runs with.
 * Defaults: asOf = today (Riyadh); `last12` = the first of the month eleven
 * months back → today; `thisMonth` = the current calendar month; days = 90.
 * Anything malformed is a 400, never silently ignored.
 */
export function resolveParams(raw: Record<string, unknown>, opts: { dates: DateDefault; today?: string; statuses?: readonly string[] }): ResolvedParams {
  const today = opts.today ?? riyadhToday();
  const date = (k: string): string | undefined => {
    const v = raw?.[k];
    if (v == null || v === "") return undefined;
    if (!isIsoDate(v)) throw new OpsParamError(`${k} must be a date YYYY-MM-DD`);
    return v;
  };
  const asOf = date("asOf") ?? today;
  let from = date("from");
  let to = date("to");
  if (opts.dates === "last12") {
    from ??= addMonthsFirst(today, -11);
    to ??= today;
  } else if (opts.dates === "thisMonth") {
    from ??= firstOfMonth(today);
    to ??= lastOfMonth(today);
  } else {
    from ??= "";
    to ??= "";
  }
  if (from && to) {
    if (from > to) throw new OpsParamError("from must not be after to");
    if (daysBetween(from, to) > MAX_RANGE_DAYS) throw new OpsParamError("date range is too long (max 10 years)");
  }
  let days = 90;
  if (raw?.days != null && raw.days !== "") {
    const s = String(raw.days).trim();
    if (!/^\d{1,4}$/.test(s) || Number(s) < 1 || Number(s) > 3650) throw new OpsParamError("days must be 1–3650");
    days = Number(s);
  }
  let status: string | null = null;
  if (raw?.status != null && raw.status !== "" && raw.status !== "all") {
    const s = String(raw.status).trim();
    if (opts.statuses && !opts.statuses.includes(s)) throw new OpsParamError(`status must be one of ${opts.statuses.join(", ")}`);
    status = s;
  }
  return {
    from, to, asOf, today,
    ownerId: parseId(raw?.ownerId, "ownerId"),
    propertyId: parseId(raw?.propertyId, "propertyId"),
    status, days,
  };
}

/* ── the installment money model ────────────────────────────────────────── */

export type Collection = { date: string; amount: number };
export type Installment = {
  id: number; contractId: number;
  amount: number; dueDate: string; paidDate: string | null;
  /** The STORED status — never 'overdue' in practice; see common/payment-status.ts. */
  status: string;
  collections: Collection[];
};

/** Stored statuses that mean "fully settled", whether or not collection rows back it. */
const FULLY_SETTLED = new Set(["paid", "settled_external"]);

/**
 * The dated money events behind an installment: its collection rows, plus — for
 * a row stored `paid` / `settled_external` whose collections fall short (a
 * contract ended in "mark all paid" mode, a historical settled row, a demo
 * seed) — the uncollected remainder, dated `paidDate ?? dueDate`.
 */
export function moneyEvents(i: Installment): Collection[] {
  const ev = [...i.collections].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (FULLY_SETTLED.has(i.status)) {
    const sum = ev.reduce((s, c) => s + c.amount, 0);
    if (i.amount - sum > EPS) ev.push({ date: i.paidDate ?? i.dueDate, amount: round2(i.amount - sum) });
  }
  return ev;
}

/** Collected on the installment, capped at its amount; optionally only money in by `asOf`. Cancelled → 0. */
export function collectedOf(i: Installment, asOf?: string): number {
  if (i.status === "cancelled") return 0;
  const sum = moneyEvents(i).filter((e) => !asOf || e.date <= asOf).reduce((s, e) => s + e.amount, 0);
  return round2(Math.min(i.amount, Math.max(0, sum)));
}

/** What is still owed. Cancelled installments owe nothing (and are excluded from "due"). */
export function remainingOf(i: Installment, asOf?: string): number {
  if (i.status === "cancelled") return 0;
  return round2(Math.max(0, i.amount - collectedOf(i, asOf)));
}

/** The date the installment became fully collected, or null if it never did. */
export function completionDate(i: Installment): string | null {
  if (i.status === "cancelled") return null;
  let run = 0;
  for (const e of moneyEvents(i)) {
    run += e.amount;
    if (run >= i.amount - EPS) return e.date;
  }
  return null;
}

/** Report status keys for an installment — the shared live-status helper, renamed for the UI. */
export type InstStatus = "paid" | "partial" | "pending" | "overdue" | "cancelled";
export function instStatus(i: Installment): InstStatus {
  const s = liveStatus(i.status, i.dueDate);
  if (s === "paid" || s === "settled_external") return "paid";
  if (s === "partially_paid") return "partial";
  if (s === "cancelled") return "cancelled";
  if (s === "overdue") return "overdue";
  return "pending";
}

/** Days an installment's unpaid remainder is past due at `asOf` (0 if not past due or nothing owed). */
export function daysOverdue(i: Installment, asOf: string): number {
  if (i.status === "cancelled" || remainingOf(i, asOf) <= EPS) return 0;
  return i.dueDate < asOf ? daysBetween(i.dueDate, asOf) : 0;
}

/* ── classifiers ────────────────────────────────────────────────────────── */

export type AgingBucket = "d1_30" | "d31_60" | "d61_90" | "d90_plus";
/** Overdue aging. Day 0 (due today) is not overdue → null. */
export function agingBucket(daysLate: number): AgingBucket | null {
  if (daysLate < 1) return null;
  if (daysLate <= 30) return "d1_30";
  if (daysLate <= 60) return "d31_60";
  if (daysLate <= 90) return "d61_90";
  return "d90_plus";
}

export type ExpiryBucket = "d0_30" | "d31_60" | "d61_90" | "d90_plus";
export function expiryBucket(daysRemaining: number): ExpiryBucket {
  if (daysRemaining <= 30) return "d0_30";
  if (daysRemaining <= 60) return "d31_60";
  if (daysRemaining <= 90) return "d61_90";
  return "d90_plus";
}

/* ── contracts and occupancy ────────────────────────────────────────────── */

export type ContractLike = {
  id: number; status: string; startDate: string; endDate: string;
  /** Riyadh date of the last update — the only termination date the schema keeps. */
  endedOn: string | null;
  unitIds: number[];
};

/** Statuses that represent a lease that ran (or runs) — not voided, not a pending offer. */
export const LEASE_STATUSES = new Set(["active", "expired", "terminated"]);

/**
 * Is the contract in force on day `d`? A live lease (`active`/`expired`) is in
 * force between its start and end dates. A `terminated` one is in force up to
 * the day before it was terminated (the update stamp; there is no termination
 * date column). `cancelled` and `pending` never are.
 */
export function inForceOn(c: ContractLike, d: string): boolean {
  if (!LEASE_STATUSES.has(c.status)) return false;
  if (d < c.startDate || d > c.endDate) return false;
  if (c.status === "terminated") return c.endedOn != null && d < c.endedOn;
  return true;
}

/** The effective contract status at `asOf`: a stored `active` past its end date reads `expired`. */
export function contractStatusAt(c: { status: string; endDate: string }, asOf: string): string {
  if (c.status === "active" && c.endDate < asOf) return "expired";
  return c.status;
}

/** Units (by id) occupied on day `d` — any in-force contract covering them. */
export function occupiedUnits(contracts: ContractLike[], d: string, unitScope?: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const c of contracts) {
    if (!inForceOn(c, d)) continue;
    for (const u of c.unitIds) if (!unitScope || unitScope.has(u)) out.add(u);
  }
  return out;
}

/**
 * The day a month is measured on for occupancy: its last day, or `today` for
 * the current (unfinished) month — a lease that starts next week does not
 * occupy anything yet.
 */
export function occupancyDay(slot: MonthSlot, today: string): string {
  const end = lastOfMonth(slot.start);
  return end > today && slot.start <= today ? today : end;
}
