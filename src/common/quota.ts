/**
 * Package quota enforcement. Counts a tenant's existing records and
 * throws when the subscription package's limit is reached, so creating
 * beyond the plan returns a clear error from the backend.
 */
import { ForbiddenException } from "@nestjs/common";
import { and, count, eq, isNull, or } from "drizzle-orm";
import { usersTable, propertiesTable, unitsTable, ownersTable } from "@dara/database";
import type { Drizzle } from "../database/database.module";
import { resolvePackage, type PackagePlan } from "./packages";
import { FEATURE_REQUIRED_PLAN } from "./plan-features";
import { combineLimit, normBase, readAdjustments, resolveLimit } from "./limit-core";

export type QuotaResource = "properties" | "units" | "landlords" | "users";

/**
 * Seats consumed against `maxUsers` — the account holder PLUS their employees.
 *
 * The owner used to be excluded, on the reasoning that they are not an
 * "employee". But maxUsers is a seat allowance: the owner holds a login, a role
 * and a permission set exactly like everyone else on the team, and they appear
 * in the team list as such. Excluding them meant a "3 users" plan quietly
 * granted four logins, and the Settings usage row read 0/3 for an account that
 * already had someone signed in — which is what it looked like to the user.
 *
 * Counted by topology (`id = owner OR ownerUserId = owner`) rather than by role
 * key, for the same reason isCustomerAccount() is: a company owner holds the
 * `general` role, so a role test would misclassify them.
 */
export async function employeeCount(db: Drizzle, ownerId: number): Promise<number> {
  const [r] = await db
    .select({ c: count() }).from(usersTable)
    .where(and(
      or(eq(usersTable.id, ownerId), eq(usersTable.ownerUserId, ownerId)),
      isNull(usersTable.deletedAt),
    ));
  return Number(r?.c ?? 0);
}

/**
 * Landlord records counted against `maxLandlords`: every live (not
 * soft-deleted) owners row of the account — the account-holder row, drafts,
 * inactive rows and Ejar-imported parties alike. Scope is the ACCOUNT OWNER
 * (`scopeId(user)`), so an employee adds against the owner's allowance.
 */
export async function landlordCount(db: Drizzle, ownerId: number): Promise<number> {
  const [r] = await db
    .select({ c: count() }).from(ownersTable)
    .where(and(eq(ownersTable.userId, ownerId), isNull(ownersTable.deletedAt)));
  return Number(r?.c ?? 0);
}

/** The 403 body every landlord-creating path answers with at the cap. The web keys off `code`. */
export interface PlanLimitLandlordsBody {
  statusCode: 403;
  code: "PLAN_LIMIT_LANDLORDS";
  requiredPlan: PackagePlan;
  limit: number;
  message: string;
}

/** Arabic first; the plan label comes from packages.ts so a rename follows. */
export function landlordLimitMessage(limit: number, planLabelAr: string, context: "create" | "ejar_import" = "create"): string {
  const allowance = limit === 1 ? "مؤجرًا واحدًا فقط" : `${limit} مؤجرين فقط`;
  const lead = context === "ejar_import"
    ? `مؤجر هذا العقد ليس المؤجر المسجّل في حسابك، وباقة «${planLabelAr}» تتيح ${allowance}.`
    : `باقة «${planLabelAr}» تتيح ${allowance}.`;
  return `${lead} لإضافة مؤجرين آخرين قم بالترقية إلى باقة «المكاتب العقارية».`;
}

export function planLimitLandlordsBody(limit: number, planLabelAr: string, context: "create" | "ejar_import" = "create"): PlanLimitLandlordsBody {
  return {
    statusCode: 403,
    code: "PLAN_LIMIT_LANDLORDS",
    requiredPlan: FEATURE_REQUIRED_PLAN,
    limit,
    message: landlordLimitMessage(limit, planLabelAr, context),
  };
}

export class PlanLimitLandlordsException extends ForbiddenException {
  constructor(limit: number, planLabelAr: string, context: "create" | "ejar_import" = "create") {
    super(planLimitLandlordsBody(limit, planLabelAr, context));
  }
}

/**
 * Used / limit for one capped resource, as the client reads it. `limit` null =
 * unlimited. `over` = above the limit (an admin lowered it below usage) —
 * nothing is deleted, `canAdd` is just false.
 */
export interface QuotaView { used: number; limit: number | null; canAdd: boolean; over: boolean }

export function quotaView(used: number, limit: number | null): QuotaView {
  const l = normBase(limit);
  return { used, limit: l, canAdd: l == null || used < l, over: l != null && used > l };
}

/**
 * Landlord + seat allowance for an account: the OWNER's plan, with the
 * account's admin overrides and active add-ons applied (common/limits.ts).
 * `/me/package` returns it as `limits`, so the portal can say «مؤجر واحد» and
 * disable "add landlord" / "add user" before the API has to refuse.
 */
export async function planLimits(db: Drizzle, ownerId: number, packagePlan?: string | null): Promise<{ landlords: QuotaView; users: QuotaView }> {
  let plan = packagePlan;
  if (plan === undefined) {
    const [owner] = await db.select({ packagePlan: usersTable.packagePlan }).from(usersTable).where(eq(usersTable.id, ownerId));
    plan = owner?.packagePlan ?? null;
  }
  const pkg = resolvePackage(plan);
  const [landlords, users, adj] = await Promise.all([
    landlordCount(db, ownerId), employeeCount(db, ownerId), readAdjustments(db, ownerId),
  ]);
  return {
    landlords: quotaView(landlords, combineLimit(normBase(pkg.maxLandlords), adj.landlords.override, adj.landlords.addons)),
    users: quotaView(users, combineLimit(normBase(pkg.maxUsers), adj.users.override, adj.users.addons)),
  };
}

/** Current record counts for an owner account — drives the package usage UI. */
export async function packageUsage(db: Drizzle, ownerId: number) {
  const [props] = await db
    .select({ c: count() }).from(propertiesTable)
    .where(and(eq(propertiesTable.userId, ownerId), isNull(propertiesTable.deletedAt)));
  const [units] = await db
    .select({ c: count() }).from(unitsTable)
    .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
    .where(and(eq(propertiesTable.userId, ownerId), isNull(unitsTable.deletedAt), isNull(propertiesTable.deletedAt)));
  const landlords = await landlordCount(db, ownerId);
  const employees = await employeeCount(db, ownerId);
  return {
    properties: Number(props?.c ?? 0),
    units: Number(units?.c ?? 0),
    landlords,
    employees,
  };
}

/**
 * Throw `ForbiddenException` if creating one more `resource` would exceed
 * the owner account's package limit. `ownerId` must be the scope id
 * (the top-level account — `scopeId(user)`).
 *
 * `landlords` throws `PlanLimitLandlordsException` (403 `PLAN_LIMIT_LANDLORDS`,
 * see PlanLimitLandlordsBody). `users` and `landlords` are checked against the
 * EFFECTIVE limit (admin override + active add-ons, common/limits.ts). An account already above its cap keeps every
 * row it has; it only cannot add one. `db` may be a transaction.
 */
export async function assertWithinQuota(db: Drizzle, ownerId: number, resource: QuotaResource): Promise<void> {
  const [owner] = await db
    .select({ packagePlan: usersTable.packagePlan })
    .from(usersTable)
    .where(eq(usersTable.id, ownerId));
  const pkg = resolvePackage(owner?.packagePlan);

  let used = 0;
  let limit = 0;
  let labelAr = "";
  let labelEn = "";

  if (resource === "properties") {
    limit = pkg.maxProperties;
    labelAr = "عقار"; labelEn = "properties";
    const [r] = await db
      .select({ c: count() })
      .from(propertiesTable)
      .where(and(eq(propertiesTable.userId, ownerId), isNull(propertiesTable.deletedAt)));
    used = Number(r?.c ?? 0);
  } else if (resource === "units") {
    limit = pkg.maxUnits;
    labelAr = "وحدة"; labelEn = "units";
    const [r] = await db
      .select({ c: count() })
      .from(unitsTable)
      .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
      .where(and(
        eq(propertiesTable.userId, ownerId),
        isNull(unitsTable.deletedAt),
        isNull(propertiesTable.deletedAt),
      ));
    used = Number(r?.c ?? 0);
  } else if (resource === "users") {
    // Seats and landlords are account limits: override + add-ons apply.
    const eff = await resolveLimit(db, ownerId, "users", pkg.maxUsers);
    if (eff == null) return;
    limit = eff;
    labelAr = "مستخدم"; labelEn = "team members";
    used = await employeeCount(db, ownerId);
  } else {
    const eff = await resolveLimit(db, ownerId, "landlords", pkg.maxLandlords);
    if (eff == null) return;
    used = await landlordCount(db, ownerId);
    if (used >= eff) throw new PlanLimitLandlordsException(eff, pkg.labelAr);
    return;
  }

  if (used >= limit) {
    throw new ForbiddenException(
      `لقد بلغت الحد الأقصى لباقتك (${limit} ${labelAr}). للمزيد يرجى ترقية الباقة. ` +
      `— Your ${pkg.labelEn} plan limit of ${limit} ${labelEn} has been reached.`,
    );
  }
}
