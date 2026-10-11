/**
 * The Ejar lookup budget (Ejar Import v2).
 *
 * One lookup = one Ejar request = two calls (Invoices, then Details). The
 * budget is expressed in lookups: `EJAR_LOOKUP_LIMIT=50` allows at most 50
 * Invoices calls AND 50 Details calls per window. It is counted from what
 * actually left the server — `ejar_api_logs` rows for the two endpoints on a
 * Balady env, summing `attempts` — never from a counter that could drift.
 *
 * Pure functions only; the counting query lives in the store.
 */

export type LookupWindow = "day" | "month" | "total";

export interface LookupConfig {
  /** Lookups per window (each = one Invoices + one Details call). */
  limit: number;
  window: LookupWindow;
  /** Lookups per account per window; null = no per-account cap. */
  perAccount: number | null;
  /** How long a saved lookup is reused instead of calling Ejar again. */
  cacheHours: number;
}

/** Calls counted so far in the current window. */
export interface LookupUsage {
  invoices: number;
  details: number;
  /** This account's lookups: max of its invoices and details calls. */
  account: number;
}

export interface EjarBudget {
  limit: number;
  window: LookupWindow;
  used: { invoices: number; details: number };
  /** Lookups left: limit - max(used), min'd with the account's remaining. */
  remaining: number;
  resetsAt: string | null;
  perAccount: { limit: number | null; used: number; remaining: number | null };
}

/** Riyadh is UTC+3 all year (no DST). */
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * A non-negative integer from the environment. Unset → the default; set but
 * unreadable → 0, so a typo closes the budget instead of opening it.
 */
function intEnv(raw: string | undefined, dflt: number): number {
  const v = (raw ?? "").trim();
  if (v === "") return dflt;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export function lookupConfig(env: Record<string, string | undefined> = process.env): LookupConfig {
  const w = (env.EJAR_LOOKUP_WINDOW ?? "").trim().toLowerCase();
  const window: LookupWindow = w === "day" || w === "total" ? w : "month";
  const pa = (env.EJAR_LOOKUP_LIMIT_PER_ACCOUNT ?? "").trim();
  const hours = Number((env.EJAR_LOOKUP_CACHE_HOURS ?? "").trim() || "24");
  return {
    limit: intEnv(env.EJAR_LOOKUP_LIMIT, 50),
    window,
    perAccount: pa === "" ? null : intEnv(pa, 0),
    cacheHours: Number.isFinite(hours) && hours >= 0 ? hours : 24,
  };
}

/**
 * Start (inclusive) and reset time of the window containing `now`, at Riyadh
 * day/month boundaries. `total` has neither: it never resets.
 */
export function windowBounds(window: LookupWindow, now = new Date()): { start: Date | null; resetsAt: Date | null } {
  if (window === "total") return { start: null, resetsAt: null };
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  if (window === "day") {
    const start = Date.UTC(y, m, d) - RIYADH_OFFSET_MS;
    return { start: new Date(start), resetsAt: new Date(start + 24 * 60 * 60 * 1000) };
  }
  return {
    start: new Date(Date.UTC(y, m, 1) - RIYADH_OFFSET_MS),
    resetsAt: new Date(Date.UTC(y, m + 1, 1) - RIYADH_OFFSET_MS),
  };
}

export function computeBudget(cfg: LookupConfig, usage: LookupUsage, now = new Date()): EjarBudget {
  const { resetsAt } = windowBounds(cfg.window, now);
  const globalLeft = Math.max(0, cfg.limit - Math.max(usage.invoices, usage.details));
  const accountLeft = cfg.perAccount == null ? null : Math.max(0, cfg.perAccount - usage.account);
  return {
    limit: cfg.limit,
    window: cfg.window,
    used: { invoices: usage.invoices, details: usage.details },
    remaining: accountLeft == null ? globalLeft : Math.min(globalLeft, accountLeft),
    resetsAt: resetsAt ? resetsAt.toISOString() : null,
    perAccount: { limit: cfg.perAccount, used: usage.account, remaining: accountLeft },
  };
}

/**
 * Whether one more lookup may be sent. Both endpoints need a call of headroom
 * (a lookup that could send Invoices but not Details would spend a call for
 * nothing), and so does the account.
 */
export function canLookup(budget: EjarBudget): boolean {
  return budget.remaining >= 1;
}
