/**
 * The Ejar lookup budget (Ejar Import v2).
 *
 * One lookup = one Ejar request: Invoices, then a second call — Get Contracts
 * (`EJAR_LOOKUP_SECOND_CALL=contracts`, default) or Details (`details`) — and,
 * in `contracts` mode only, Details as a fallback when Get Contracts does not
 * hold the contract. The budget is expressed in lookups and counted PER
 * ENDPOINT: `EJAR_LOOKUP_LIMIT=50` allows at most 50 calls to each of
 * Invoices, Get Contracts and Details per window. It is counted from what
 * actually left the server — `ejar_api_logs` rows for those endpoints on a
 * Balady env, summing `attempts` — never from a counter that could drift.
 *
 * Pure functions only; the counting query lives in the store.
 */

export type LookupWindow = "day" | "month" | "total";
/** What the lookup calls after Invoices. */
export type SecondCall = "contracts" | "details";
export type BudgetEndpoint = "invoices" | "contracts" | "details";

export interface LookupConfig {
  /** Lookups per window (each = one Invoices + one Details call). */
  limit: number;
  window: LookupWindow;
  /** Lookups per account per window; null = no per-account cap. */
  perAccount: number | null;
  /** How long a saved lookup is reused instead of calling Ejar again. */
  cacheHours: number;
  secondCall: SecondCall;
}

/** Calls counted so far in the current window, per endpoint. */
export interface LookupUsage {
  invoices: number;
  contracts: number;
  details: number;
  /** The same counts for this account alone. */
  account: { invoices: number; contracts: number; details: number };
}

export interface EjarBudget {
  limit: number;
  window: LookupWindow;
  used: { invoices: number; contracts: number; details: number };
  /** Lookups left: limit - max(used), min'd with the account's remaining. */
  remaining: number;
  resetsAt: string | null;
  perAccount: { limit: number | null; used: number; remaining: number | null };
  /** The call made after Invoices (EJAR_LOOKUP_SECOND_CALL). */
  secondCall: SecondCall;
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
  // Unset → contracts. Anything else than the two values → details, the call
  // production is subscribed to (Get Contracts answers 401 there today).
  const sc = (env.EJAR_LOOKUP_SECOND_CALL ?? "").trim().toLowerCase();
  const secondCall: SecondCall = sc === "" || sc === "contracts" ? "contracts" : "details";
  return {
    limit: intEnv(env.EJAR_LOOKUP_LIMIT, 50),
    window,
    perAccount: pa === "" ? null : intEnv(pa, 0),
    cacheHours: Number.isFinite(hours) && hours >= 0 ? hours : 24,
    secondCall,
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

const maxOf = (u: { invoices: number; contracts: number; details: number }) => Math.max(u.invoices, u.contracts, u.details);

export function computeBudget(cfg: LookupConfig, usage: LookupUsage, now = new Date()): EjarBudget {
  const { resetsAt } = windowBounds(cfg.window, now);
  const globalLeft = Math.max(0, cfg.limit - maxOf(usage));
  const accountUsed = maxOf(usage.account);
  const accountLeft = cfg.perAccount == null ? null : Math.max(0, cfg.perAccount - accountUsed);
  return {
    limit: cfg.limit,
    window: cfg.window,
    used: { invoices: usage.invoices, contracts: usage.contracts, details: usage.details },
    remaining: accountLeft == null ? globalLeft : Math.min(globalLeft, accountLeft),
    resetsAt: resetsAt ? resetsAt.toISOString() : null,
    perAccount: { limit: cfg.perAccount, used: accountUsed, remaining: accountLeft },
    secondCall: cfg.secondCall,
  };
}

/** One more call to `endpoint` fits, globally and for the account. */
export function hasHeadroom(cfg: LookupConfig, usage: LookupUsage, endpoint: BudgetEndpoint): boolean {
  if (cfg.limit - usage[endpoint] < 1) return false;
  return cfg.perAccount == null || cfg.perAccount - usage.account[endpoint] >= 1;
}

/**
 * Whether a lookup may start: Invoices and the second call it will make both
 * need a call of headroom (a lookup that could send Invoices but not its
 * second call would spend a call for nothing). The Details fallback is
 * checked separately, when it is needed.
 */
export function canLookup(cfg: LookupConfig, usage: LookupUsage): boolean {
  return hasHeadroom(cfg, usage, "invoices") && hasHeadroom(cfg, usage, cfg.secondCall);
}
