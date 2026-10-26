/**
 * Account limits — the effective allowance of each capped resource for one
 * account: the package base, replaced by an admin override when there is one,
 * plus the add-ons active right now.
 *
 *   effective = combineLimit(base, override, Σ active add-ons)
 *
 * Every gate (team seats, landlord records, Ejar lookups) reads this, never
 * `PACKAGES[...]` directly, so an override or an add-on takes effect
 * everywhere at once. Lowering a limit below usage deletes nothing: the gates
 * refuse adding (`used >= limit`) and `over` says the account is above it.
 */
import { eq } from "drizzle-orm";
import { usersTable } from "@dara/database";
import type { Drizzle } from "../database/database.module";
import { resolvePackage } from "./packages";
import { employeeCount, landlordCount } from "./quota";
import { combineLimit, normBase, readAdjustments, type LimitAdjustments, type LimitKey } from "./limit-core";
import { planQuotaWindow, type PlanPeriod } from "../modules/ejar/ejar.budget";
import { ejarLookupUsage } from "../modules/ejar/ejar.usage";

export {
  combineLimit, addonIsActive, isLimitKey, normBase, readAdjustments, resolveLimit,
  EJAR_ENABLED_KEY, LIMIT_KEY_LIST,
  type LimitKey, type LimitAdjustment, type LimitAdjustments,
} from "./limit-core";

export interface LimitKeyDef {
  key: LimitKey;
  labelAr: string;
  labelEn: string;
  /** `none` = a standing count (seats, records); `period` = counted per paid subscription period. */
  window: "none" | "period";
}

/** The limit registry. Bases: users = pkg.maxUsers, landlords = pkg.maxLandlords, ejar_lookups = planQuotaWindow. */
export const LIMIT_KEYS: Record<LimitKey, LimitKeyDef> = {
  users: { key: "users", labelAr: "المستخدمون", labelEn: "Users", window: "none" },
  landlords: { key: "landlords", labelAr: "المؤجرون", labelEn: "Landlords", window: "none" },
  ejar_lookups: { key: "ejar_lookups", labelAr: "استعلامات إيجار", labelEn: "Ejar lookups", window: "period" },
};

export interface EffectiveLimit {
  key: LimitKey;
  /** The package's own allowance; null = unlimited. */
  base: number | null;
  /** The admin override's value (null when there is none, or when it is "unlimited" — see the overrides list). */
  override: number | null;
  /** Quantity of the add-ons active right now. */
  addons: number;
  /** What the gates enforce; null = unlimited. */
  effective: number | null;
  used: number;
  remaining: number | null;
  /** Above the limit (an override lowered below usage) — nothing is deleted, adding is refused. */
  over: boolean;
  window: "none" | "period";
  /** When a period-windowed count renews; null otherwise / unknown. */
  resetsAt: string | null;
}

function build(
  key: LimitKey, base: number | null, adj: LimitAdjustments[LimitKey], used: number, resetsAt: Date | null = null,
): EffectiveLimit {
  const effective = combineLimit(base, adj.override, adj.addons);
  return {
    key,
    base,
    override: adj.override ?? null,
    addons: adj.addons,
    effective,
    used,
    remaining: effective == null ? null : Math.max(0, effective - used),
    over: effective != null && used > effective,
    window: LIMIT_KEYS[key].window,
    resetsAt: resetsAt ? resetsAt.toISOString() : null,
  };
}

const maxOf = (u: { invoices: number; contracts: number; details: number }) => Math.max(u.invoices, u.contracts, u.details);

/** The account row the bases are read from. */
async function accountPeriod(db: Drizzle, accountId: number): Promise<PlanPeriod | null> {
  const [row] = await db
    .select({
      packagePlan: usersTable.packagePlan, billingCycle: usersTable.billingCycle,
      subscriptionStartedAt: usersTable.subscriptionStartedAt, subscriptionEndsAt: usersTable.subscriptionEndsAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, accountId))
    .limit(1);
  return row ?? null;
}

/**
 * Every limit of an account, effective and used. `accountId` is the scope
 * owner (`scopeId(user)`). `db` may be a transaction — the limits service
 * recomputes inside its write transaction to log old/new values.
 */
export async function effectiveLimits(
  db: Drizzle, accountId: number, opts: { now?: Date; only?: LimitKey } = {},
): Promise<EffectiveLimit[]> {
  const now = opts.now ?? new Date();
  const want = (k: LimitKey) => !opts.only || opts.only === k;
  const [period, adj] = await Promise.all([accountPeriod(db, accountId), readAdjustments(db, accountId, now)]);
  const pkg = resolvePackage(period?.packagePlan);
  const out: EffectiveLimit[] = [];
  if (want("users")) out.push(build("users", normBase(pkg.maxUsers), adj.users, await employeeCount(db, accountId)));
  if (want("landlords")) out.push(build("landlords", normBase(pkg.maxLandlords), adj.landlords, await landlordCount(db, accountId)));
  if (want("ejar_lookups")) {
    const base = planQuotaWindow(period, now)?.limit ?? null;
    const effective = combineLimit(base, adj.ejar_lookups.override, adj.ejar_lookups.addons);
    // The paid period is the window even when the quota is unlimited, so `used` still reads.
    const span = planQuotaWindow(period, now, effective ?? 0)!;
    const used = maxOf((await ejarLookupUsage(db, span.since, accountId)).account);
    out.push(build("ejar_lookups", base, adj.ejar_lookups, used, span.resetsAt));
  }
  return out;
}

/** One limit of an account. */
export async function effectiveLimit(db: Drizzle, accountId: number, key: LimitKey, now = new Date()): Promise<EffectiveLimit> {
  const [l] = await effectiveLimits(db, accountId, { now, only: key });
  return l!;
}
