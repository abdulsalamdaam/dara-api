import { and, eq } from "drizzle-orm";
import { accountLimitOverridesTable, usersTable } from "@dara/database";
import type { Drizzle } from "../database/database.module";
import {
  ACCOUNTING_ENABLED_KEY, assertPlanAllowsCommission, planAllowsCommission, planFeatures, type PlanFeature,
} from "./plan-features";

/**
 * The stored plan key of an account — `ownerId` must be the scope id
 * (`scopeId(user)`, the account holder), so an employee resolves to the
 * owner's plan exactly as the seat quota does. Raw value (may be null or a
 * legacy alias); pass it through resolvePackage / planHasFeature.
 */
export async function accountPlan(db: Drizzle, ownerId: number): Promise<string | null> {
  const [row] = await db.select({ p: usersTable.packagePlan }).from(usersTable).where(eq(usersTable.id, ownerId));
  return row?.p ?? null;
}

/** Whether the account (`ownerId` = scope id) may issue commission documents (plan-features.ts planAllowsCommission). */
export async function accountAllowsCommission(db: Drizzle, ownerId: number): Promise<boolean> {
  return planAllowsCommission(await accountPlan(db, ownerId));
}

/** 403 CommissionNotInPlanException unless the account's plan includes commission. */
export async function assertAccountAllowsCommission(db: Drizzle, ownerId: number): Promise<void> {
  assertPlanAllowsCommission(await accountPlan(db, ownerId));
}

/** Whether an admin has granted accounting to the account (plan-features.ts ACCOUNTING_ENABLED_KEY). Raw grant — the plan decides if it counts. */
export async function accountAccountingGranted(db: Drizzle, ownerId: number): Promise<boolean> {
  const [row] = await db.select({ v: accountLimitOverridesTable.value }).from(accountLimitOverridesTable)
    .where(and(eq(accountLimitOverridesTable.accountId, ownerId), eq(accountLimitOverridesTable.limitKey, ACCOUNTING_ENABLED_KEY)))
    .limit(1);
  return row?.v === 1;
}

/**
 * The features the account gets (/auth/me `planFeatures`, /subscription
 * `features`): its plan's, plus accounting when granted on a grantable plan,
 * plus `commission` when the plan issues commission — a separate key because
 * an عقاري account with the accounting grant has accounting but no commission.
 */
export async function accountFeatures(db: Drizzle, ownerId: number, plan: string | null | undefined): Promise<Array<PlanFeature | "commission">> {
  const out: Array<PlanFeature | "commission"> = planFeatures(plan, await accountAccountingGranted(db, ownerId));
  if (planAllowsCommission(plan)) out.push("commission");
  return out;
}
