/**
 * The low-level half of account limits (src/common/limits.ts is the front
 * door): the key registry, how base / override / add-ons combine, and the
 * reader for an account's overrides and active add-ons. Kept free of the
 * record counters (quota.ts) so quota.ts can use it without an import cycle.
 */
import { and, eq } from "drizzle-orm";
import { accountLimitAddonsTable, accountLimitOverridesTable } from "@dara/database";
import type { Drizzle } from "../database/database.module";
import { UNLIMITED } from "./packages";

export type LimitKey = "users" | "landlords" | "ejar_lookups";
export const LIMIT_KEY_LIST: readonly LimitKey[] = ["users", "landlords", "ejar_lookups"];

/** The per-account Ejar switch lives in account_limit_overrides under this key (1 = enabled, 0 = disabled). */
export const EJAR_ENABLED_KEY = "ejar.enabled";

export function isLimitKey(v: unknown): v is LimitKey {
  return typeof v === "string" && (LIMIT_KEY_LIST as readonly string[]).includes(v);
}

/** A package base as the limits layer reads it: UNLIMITED (or missing) → null. */
export function normBase(n: number | null | undefined): number | null {
  return n == null || n >= UNLIMITED ? null : n;
}

/**
 * The effective limit. `override` replaces `base` when it is not undefined
 * (undefined = no override row; null = overridden to unlimited). Unlimited
 * stays unlimited — add-ons add nothing to it. Otherwise active add-ons are
 * added on top.
 */
export function combineLimit(base: number | null, override: number | null | undefined, addonSum: number): number | null {
  const b = override !== undefined ? override : base;
  if (b == null || b >= UNLIMITED) return null;
  return b + Math.max(0, addonSum || 0);
}

export interface AddonActivity {
  status: string;
  startsAt: Date | string | null;
  endsAt: Date | string | null;
}

/** `status='active' AND starts_at<=now AND (ends_at IS NULL OR ends_at>now)` — evaluated at read time. */
export function addonIsActive(a: AddonActivity, now = new Date()): boolean {
  if (a.status !== "active") return false;
  if (!a.startsAt || new Date(a.startsAt).getTime() > now.getTime()) return false;
  return a.endsAt == null || new Date(a.endsAt).getTime() > now.getTime();
}

export interface LimitAdjustment {
  /** undefined = no override row; null = overridden to unlimited. */
  override: number | null | undefined;
  /** Sum of the quantities of the add-ons active right now. */
  addons: number;
}

export type LimitAdjustments = Record<LimitKey, LimitAdjustment>;

const empty = (): LimitAdjustments => ({
  users: { override: undefined, addons: 0 },
  landlords: { override: undefined, addons: 0 },
  ejar_lookups: { override: undefined, addons: 0 },
});

/** An account's overrides and active add-on totals, per limit key. `db` may be a transaction. */
export async function readAdjustments(db: Drizzle, accountId: number, now = new Date()): Promise<LimitAdjustments> {
  const out = empty();
  const [overrides, addons] = await Promise.all([
    db.select({ limitKey: accountLimitOverridesTable.limitKey, value: accountLimitOverridesTable.value })
      .from(accountLimitOverridesTable)
      .where(eq(accountLimitOverridesTable.accountId, accountId)),
    db.select({
      limitKey: accountLimitAddonsTable.limitKey, quantity: accountLimitAddonsTable.quantity,
      status: accountLimitAddonsTable.status, startsAt: accountLimitAddonsTable.startsAt, endsAt: accountLimitAddonsTable.endsAt,
    })
      .from(accountLimitAddonsTable)
      .where(and(eq(accountLimitAddonsTable.accountId, accountId), eq(accountLimitAddonsTable.status, "active"))),
  ]);
  for (const o of overrides ?? []) if (isLimitKey(o.limitKey)) out[o.limitKey].override = o.value ?? null;
  for (const a of addons ?? []) if (isLimitKey(a.limitKey) && addonIsActive(a, now)) out[a.limitKey].addons += Number(a.quantity) || 0;
  return out;
}

/** The effective limit of one key, given the package base — without counting usage. */
export async function resolveLimit(
  db: Drizzle, accountId: number, key: LimitKey, base: number | null, now = new Date(),
): Promise<number | null> {
  const adj = (await readAdjustments(db, accountId, now))[key];
  return combineLimit(normBase(base), adj.override, adj.addons);
}
