/**
 * Package quota enforcement. Counts a tenant's existing records and
 * throws when the subscription package's limit is reached, so creating
 * beyond the plan returns a clear error from the backend.
 */
import { ForbiddenException } from "@nestjs/common";
import { and, count, eq, isNull, isNotNull } from "drizzle-orm";
import { usersTable, propertiesTable, unitsTable, ownersTable } from "@dara/database";
import type { Drizzle } from "../database/database.module";
import { resolvePackage } from "./packages";

export type QuotaResource = "properties" | "units" | "landlords" | "users";

/** Count the team members (employees) under an owner account. */
export async function employeeCount(db: Drizzle, ownerId: number): Promise<number> {
  const [r] = await db
    .select({ c: count() }).from(usersTable)
    .where(and(eq(usersTable.ownerUserId, ownerId), isNotNull(usersTable.ownerUserId), isNull(usersTable.deletedAt)));
  return Number(r?.c ?? 0);
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
  const [owners] = await db
    .select({ c: count() }).from(ownersTable)
    .where(and(eq(ownersTable.userId, ownerId), isNull(ownersTable.deletedAt)));
  const employees = await employeeCount(db, ownerId);
  return {
    properties: Number(props?.c ?? 0),
    units: Number(units?.c ?? 0),
    landlords: Number(owners?.c ?? 0),
    employees,
  };
}

/**
 * Throw `ForbiddenException` if creating one more `resource` would exceed
 * the owner account's package limit. `ownerId` must be the scope id
 * (the top-level account — `scopeId(user)`).
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
    limit = pkg.maxUsers;
    labelAr = "مستخدم"; labelEn = "team members";
    used = await employeeCount(db, ownerId);
  } else {
    limit = pkg.maxLandlords;
    labelAr = "مالك"; labelEn = "landlords";
    const [r] = await db
      .select({ c: count() })
      .from(ownersTable)
      .where(and(eq(ownersTable.userId, ownerId), isNull(ownersTable.deletedAt)));
    used = Number(r?.c ?? 0);
  }

  if (used >= limit) {
    throw new ForbiddenException(
      `لقد بلغت الحد الأقصى لباقتك (${limit} ${labelAr}). للمزيد يرجى ترقية الباقة. ` +
      `— Your ${pkg.labelEn} plan limit of ${limit} ${labelEn} has been reached.`,
    );
  }
}
