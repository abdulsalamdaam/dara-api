import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { companiesTable, usersTable } from "@dara/database";

import { packageMode } from "../../common/packages";

/**
 * Which Ejar records an account is allowed to search.
 *
 * The tenant package is a self-tracker sold to corporate tenants: the account
 * holder is a party to their own leases and has no business enumerating anyone
 * else's. Ejar has no way to express that for us — GetRentalContracts honours
 * exactly one filter, `id_number`, and silently IGNORES `contract_number`
 * (verified against the UAT gateway: passing a contract number returns the
 * whole 12,460-row dataset unfiltered). So the boundary has to be enforced
 * here, by pinning `id_number` to the CR on the account's own company record.
 *
 * Landlord-mode packages are unchanged: a property manager legitimately looks
 * up contracts for the many owners and tenants they act for.
 */

export interface EjarScope {
  /** True when this account may only search its own CR. */
  locked: boolean;
  /** The CR to force onto every lookup; null when unlocked. */
  idNumber: string | null;
}

/** Params that would widen a search past the account's own records. */
export const SCOPE_BREAKING_PARAMS = ["skip_filter_id_number"] as const;

export const NO_CR_MESSAGE =
  "لم يتم ربط رقم السجل التجاري بحسابك بعد. أضفه من إعدادات المنشأة قبل البحث في إيجار. " +
  "· Your account has no commercial registration on file — add it in company settings before searching Ejar.";

/**
 * Resolve the caller's Ejar search scope.
 *
 * `ownerId` must be the OWNER account (scopeId), not the employee: an employee
 * inherits their owner's package and company, and scoping them by their own
 * row would leave them unrestricted.
 */
export async function resolveEjarScope(db: any, ownerId: number): Promise<EjarScope> {
  const [row] = await db
    .select({
      packagePlan: usersTable.packagePlan,
      commercialReg: companiesTable.commercialReg,
    })
    .from(usersTable)
    .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
    .where(eq(usersTable.id, ownerId));

  if (packageMode(row?.packagePlan) !== "tenant") return { locked: false, idNumber: null };

  const cr = String(row?.commercialReg ?? "").trim();
  // Fail closed. An unset CR must not degrade to "search anything" — that is
  // precisely the scope this exists to prevent.
  if (!cr) throw new BadRequestException(NO_CR_MESSAGE);
  return { locked: true, idNumber: cr };
}

/**
 * The id_number a lookup must run with.
 *
 * A locked account's own CR always wins over whatever the client sent. It is
 * not an error for the client to send something else — the import wizard
 * prefills from several places — it simply does not widen the scope.
 */
export function scopedIdNumber(scope: EjarScope, requested?: string | null): string | undefined {
  if (scope.locked) return scope.idNumber ?? undefined;
  const v = (requested ?? "").trim();
  return v || undefined;
}

/**
 * Reject params that would defeat the pin on a locked account.
 *
 * `skip_filter_id_number=true` turns Ejar's own id filter off; with it, a
 * lookup returns the entire dataset. Nothing a locked account does may set it.
 */
export function assertScopeSafeParams(scope: EjarScope, params: Record<string, unknown>): void {
  if (!scope.locked) return;
  for (const key of SCOPE_BREAKING_PARAMS) {
    if (params[key] !== undefined) {
      throw new ForbiddenException(
        `المعامل ${key} غير مسموح لهذا النوع من الحسابات · ${key} is not permitted for this account type.`,
      );
    }
  }
}
