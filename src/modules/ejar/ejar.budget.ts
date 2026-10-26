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
 * On top of that, each account has its plan's quota (PLAN_EJAR_LOOKUPS_PER_YEAR
 * prorated to its paid period — see `planQuotaWindow`), counted the same way.
 *
 * Pure functions only; the counting query lives in the store.
 */

import { CYCLE_MONTHS, ejarLookupQuota, parseCycle } from "../../common/packages";

export type LookupWindow = "day" | "month" | "total";
/** The window the budget is REPORTED in: the gateway's, or the plan's paid period. */
export type BudgetWindow = LookupWindow | "period";
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
  /**
   * Wrong contract numbers (Ejar answered "no such contract") per account per
   * Riyadh day. They don't count toward the lookup budget, so this is the only
   * thing that stops someone burning the gateway quota on random numbers;
   * null = no cap.
   */
  wrongNumbersPerDay: number | null;
}

/** Calls counted so far in the current window, per endpoint. */
export interface LookupUsage {
  invoices: number;
  contracts: number;
  details: number;
  /** The same counts for this account alone. */
  account: { invoices: number; contracts: number; details: number };
}

/**
 * The account's plan quota (PLAN_EJAR_LOOKUPS_PER_YEAR prorated to the paid
 * period), counted per endpoint from the period's start, like the gateway
 * budget. Absent for an uncapped plan (Enterprise).
 */
export interface PlanQuota {
  limit: number;
  /** Start of the paid period the quota covers. */
  since: Date;
  /** When the period — and so the quota — renews; null when unknown. */
  resetsAt: Date | null;
  /** The account's calls since `since`, per endpoint. */
  used: { invoices: number; contracts: number; details: number };
}

export interface EjarBudget {
  /** The cap the user is up against: the plan quota when there is one, else the gateway's. */
  limit: number;
  window: BudgetWindow;
  used: { invoices: number; contracts: number; details: number };
  /** Lookups left: limit - max(used), min'd with the account's remaining. */
  remaining: number;
  resetsAt: string | null;
  perAccount: { limit: number | null; used: number; remaining: number | null };
  /** The call made after Invoices (EJAR_LOOKUP_SECOND_CALL). */
  secondCall: SecondCall;
  /** The plan quota, when the plan has one. */
  plan: { limit: number; used: number; remaining: number; since: string; resetsAt: string | null } | null;
  /** The gateway-wide budget (EJAR_LOOKUP_LIMIT), reported separately once a plan quota takes `limit`. */
  gateway: { limit: number; window: LookupWindow; resetsAt: string | null };
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

/** Unset → 20; "off" / "none" → no cap; anything unreadable → 0 (closed). */
function wrongNumberCap(raw: string | undefined): number | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "off" || v === "none") return null;
  return intEnv(v, 20);
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
    wrongNumbersPerDay: wrongNumberCap(env.EJAR_LOOKUP_WRONG_NUMBERS_PER_DAY),
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

export function computeBudget(cfg: LookupConfig, usage: LookupUsage, now = new Date(), plan: PlanQuota | null = null): EjarBudget {
  const { resetsAt } = windowBounds(cfg.window, now);
  const globalLeft = Math.max(0, cfg.limit - maxOf(usage));
  const accountUsed = maxOf(usage.account);
  const accountLeft = cfg.perAccount == null ? null : Math.max(0, cfg.perAccount - accountUsed);
  const planUsed = plan ? maxOf(plan.used) : 0;
  const planLeft = plan ? Math.max(0, plan.limit - planUsed) : null;
  let remaining = accountLeft == null ? globalLeft : Math.min(globalLeft, accountLeft);
  if (planLeft != null) remaining = Math.min(remaining, planLeft);
  const gatewayResets = resetsAt ? resetsAt.toISOString() : null;
  return {
    limit: plan ? plan.limit : cfg.limit,
    window: plan ? "period" : cfg.window,
    used: { invoices: usage.invoices, contracts: usage.contracts, details: usage.details },
    remaining,
    resetsAt: plan ? (plan.resetsAt ? plan.resetsAt.toISOString() : null) : gatewayResets,
    perAccount: { limit: cfg.perAccount, used: accountUsed, remaining: accountLeft },
    secondCall: cfg.secondCall,
    plan: plan
      ? {
        limit: plan.limit, used: planUsed, remaining: planLeft!,
        since: plan.since.toISOString(), resetsAt: plan.resetsAt ? plan.resetsAt.toISOString() : null,
      }
      : null,
    gateway: { limit: cfg.limit, window: cfg.window, resetsAt: gatewayResets },
  };
}

/** One more call to `endpoint` fits — globally, for the account, and in its plan quota. */
export function hasHeadroom(cfg: LookupConfig, usage: LookupUsage, endpoint: BudgetEndpoint, plan: PlanQuota | null = null): boolean {
  if (cfg.limit - usage[endpoint] < 1) return false;
  if (plan && plan.limit - plan.used[endpoint] < 1) return false;
  return cfg.perAccount == null || cfg.perAccount - usage.account[endpoint] >= 1;
}

/**
 * Whether a lookup may start: Invoices and the second call it will make both
 * need a call of headroom (a lookup that could send Invoices but not its
 * second call would spend a call for nothing). The Details fallback is
 * checked separately, when it is needed.
 */
export function canLookup(cfg: LookupConfig, usage: LookupUsage, plan: PlanQuota | null = null): boolean {
  return hasHeadroom(cfg, usage, "invoices", plan) && hasHeadroom(cfg, usage, cfg.secondCall, plan);
}

/** The account's subscription, as far as the plan quota needs it. */
export interface PlanPeriod {
  packagePlan: string | null;
  billingCycle: string | null;
  subscriptionStartedAt: Date | string | null;
  subscriptionEndsAt: Date | string | null;
}

/**
 * The plan quota's limit and window for an account. The window is the paid
 * period (`subscription_started_at` → `subscription_ends_at`) — every payment
 * restarts it, so the quota renews with the subscription. Without a usable
 * start (legacy rows) it falls back to a rolling window of the cycle's length.
 * Returns null when the plan is uncapped (or `limitOverride` is null).
 */
export function planQuotaWindow(
  p: PlanPeriod | null, now = new Date(), limitOverride?: number | null,
): { limit: number; since: Date; resetsAt: Date | null } | null {
  const cycle = parseCycle(p?.billingCycle);
  // `limitOverride` is the account's EFFECTIVE quota (common/limits.ts: admin
  // override and active add-ons applied); undefined = the plan's own. null =
  // unlimited, like an uncapped plan.
  const limit = limitOverride !== undefined ? limitOverride : ejarLookupQuota(p?.packagePlan ?? null, cycle);
  if (limit == null) return null;
  const start = p?.subscriptionStartedAt ? new Date(p.subscriptionStartedAt) : null;
  const ends = p?.subscriptionEndsAt ? new Date(p.subscriptionEndsAt) : null;
  if (start && !Number.isNaN(start.getTime()) && start <= now && (!ends || ends > now)) {
    return { limit, since: start, resetsAt: ends && !Number.isNaN(ends.getTime()) ? ends : null };
  }
  const since = new Date(now);
  since.setMonth(since.getMonth() - CYCLE_MONTHS[cycle]);
  return { limit, since, resetsAt: null };
}
