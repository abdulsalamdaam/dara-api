/**
 * Who may reach Ejar: the server-wide `EJAR_ACCESS` rule plus the per-account
 * switch an admin sets (account_limit_overrides, key `ejar.enabled`).
 *
 *  - `EJAR_ACCESS=off` (or anything unreadable) is the kill switch: nothing
 *    gets through, whatever the account switch says.
 *  - account `disabled` always blocks (403 `ejar_disabled_for_account`).
 *  - account `enabled` lets the account through `EJAR_ACCESS=allowlist`.
 *  - account `default` (no row) follows `EJAR_ACCESS` as before.
 *  - an account on its free trial is blocked (403 `ejar_trial`) whatever the
 *    switch says: Ejar is a paid-subscription feature. Paying clears the
 *    trial flag, which opens it.
 *  - an account with an active PAID subscription (not a trial, not in grace)
 *    and no switch row counts as `enabled`: Ejar is on by default for paying
 *    customers, so it gets through `EJAR_ACCESS=allowlist` without an admin.
 */
import { and, eq } from "drizzle-orm";
import { accountLimitOverridesTable, usersTable } from "@dara/database";
import type { Drizzle } from "../../database/database.module";
import { EJAR_ENABLED_KEY } from "../../common/limit-core";
import { deriveSubscription } from "../../common/subscription";

export type EjarAccountMode = "default" | "enabled" | "disabled";
/** The switch, or `trial` when the account is on its free trial (and not switched off). */
export type EjarAccessMode = EjarAccountMode | "trial";
export type EjarEnvMode = "all" | "allowlist" | "off";

/** `EJAR_ACCESS`, normalised: unset → all; any value but all/allowlist → off. */
export function ejarEnvMode(env: Record<string, string | undefined> = process.env): EjarEnvMode {
  const mode = (env.EJAR_ACCESS ?? "all").trim().toLowerCase() || "all";
  return mode === "all" || mode === "allowlist" ? mode : "off";
}

/**
 * Who may make outbound Ejar calls, from `EJAR_ACCESS`:
 * - unset / `all` — any caller the route's permission check lets through;
 * - `allowlist` — only the user ids in `EJAR_ALLOWED_USER_IDS` (comma
 *   separated; empty means nobody), plus the unattended health probe;
 * - `off` — nothing at all, not even the probe.
 * Any other value is treated as `off`: a typo must not open the gate.
 */
export function ejarAccessDenial(userId: number | null | undefined, env: Record<string, string | undefined> = process.env): string | null {
  const mode = ejarEnvMode(env);
  if (mode === "all") return null;
  if (mode !== "allowlist") return "Ejar access is switched off on this server (EJAR_ACCESS).";
  if (userId == null) return null; // the unattended health probe
  const allowed = (env.EJAR_ALLOWED_USER_IDS ?? "").split(",").map((v) => Number(v.trim())).filter(Number.isInteger);
  return allowed.includes(userId) ? null : `Ejar access is restricted on this server; user ${userId} is not allowed.`;
}

export interface EjarDenial {
  code: "access_denied" | "ejar_disabled_for_account" | "ejar_trial";
  message: string;
}

export const EJAR_DISABLED_FOR_ACCOUNT_MESSAGE =
  "خدمة إيجار غير مفعّلة لهذا الحساب — تواصل مع الدعم · Ejar is switched off for this account; contact support.";

export const EJAR_TRIAL_MESSAGE =
  "الاستيراد من إيجار غير متاح خلال الفترة التجريبية — اشترك لتفعيله · Ejar import isn't available during the free trial; subscribe to unlock it.";

/** The rule above, for an account whose switch is `mode`. Pure. */
export function ejarDenialFor(
  mode: EjarAccessMode, userId: number | null | undefined, env: Record<string, string | undefined> = process.env,
): EjarDenial | null {
  if (ejarEnvMode(env) === "off") return { code: "access_denied", message: ejarAccessDenial(userId, env)! };
  if (mode === "disabled") return { code: "ejar_disabled_for_account", message: EJAR_DISABLED_FOR_ACCOUNT_MESSAGE };
  if (mode === "trial") return { code: "ejar_trial", message: EJAR_TRIAL_MESSAGE };
  if (mode === "enabled") return null;
  const d = ejarAccessDenial(userId, env);
  return d ? { code: "access_denied", message: d } : null;
}

/** An override value as a switch position: 1 → enabled, 0 → disabled, no row / null → default. */
export function ejarModeOf(value: number | null | undefined): EjarAccountMode {
  if (value === 1) return "enabled";
  if (value === 0) return "disabled";
  return "default";
}

/** The account's Ejar switch. `accountId` is the scope owner (scopeId). */
export async function accountEjarMode(db: Drizzle, accountId: number): Promise<EjarAccountMode> {
  const [row] = await db
    .select({ value: accountLimitOverridesTable.value })
    .from(accountLimitOverridesTable)
    .where(and(eq(accountLimitOverridesTable.accountId, accountId), eq(accountLimitOverridesTable.limitKey, EJAR_ENABLED_KEY)))
    .limit(1);
  return ejarModeOf(row?.value);
}

export type EjarSubscriptionState = "trial" | "paid" | "other";

/** The account's (scope owner's) subscription as Ejar sees it: trial, active paid, or anything else. */
export async function accountSubscriptionState(db: Drizzle, accountId: number, now = new Date()): Promise<EjarSubscriptionState> {
  const [row] = await db
    .select({
      trial: usersTable.subscriptionIsTrial,
      status: usersTable.subscriptionStatus,
      endsAt: usersTable.subscriptionEndsAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, accountId))
    .limit(1);
  if (!row) return "other";
  if (row.trial) return "trial";
  const sub = deriveSubscription({ storedStatus: row.status, subscriptionEndsAt: row.endsAt, isTrial: false, now });
  return sub.status === "active" ? "paid" : "other";
}

/**
 * The switch combined with the subscription: what the access rule is applied
 * to. Admin `disabled` always wins; then the trial; then an active paid
 * subscription turns the default on.
 */
export function ejarAccessModeOf(mode: EjarAccountMode, sub: EjarSubscriptionState | boolean): EjarAccessMode {
  const state: EjarSubscriptionState = sub === true ? "trial" : sub === false ? "other" : sub;
  if (mode === "disabled") return "disabled";
  if (state === "trial") return "trial";
  if (state === "paid") return "enabled";
  return mode;
}

/** The account's switch plus its subscription — the mode every Ejar gate checks. */
export async function accountEjarAccessMode(db: Drizzle, accountId: number): Promise<EjarAccessMode> {
  const [mode, sub] = await Promise.all([accountEjarMode(db, accountId), accountSubscriptionState(db, accountId)]);
  return ejarAccessModeOf(mode, sub);
}

/** Why `userId` (acting for account `scopeId`) may not reach Ejar, or null. */
export async function accountEjarDenial(
  db: Drizzle, scopeId: number, userId?: number | null, env: Record<string, string | undefined> = process.env,
): Promise<EjarDenial | null> {
  return ejarDenialFor(await accountEjarAccessMode(db, scopeId), userId, env);
}

/** Whether Ejar is usable for this caller right now — what /auth/me and /me/package report. */
export async function ejarEnabledFor(db: Drizzle, scopeId: number, userId?: number | null): Promise<boolean> {
  return (await accountEjarDenial(db, scopeId, userId)) == null;
}
