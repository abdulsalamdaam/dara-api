import { eq } from "drizzle-orm";
import { usersTable } from "@dara/database";
import type { Drizzle } from "../database/database.module";
import { assertPlanAllowsCommission, planAllowsCommission } from "./plan-features";

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
