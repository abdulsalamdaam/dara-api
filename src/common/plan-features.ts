/**
 * Package feature gates — what a plan unlocks beyond its quotas.
 *
 * The analysis features are exclusive to المكاتب العقارية (`professional`) and
 * الشركات (`enterprise`); the legacy `advanced` tier is grandfathered in, and a
 * null/unknown plan resolves to DEFAULT_PACKAGE (professional) as everywhere
 * else in packages.ts, so nobody is locked out by a missing value.
 *
 * Always resolve with the ACCOUNT OWNER's plan (`users.package_plan` of
 * `scopeId(user)`) — employees inherit it, exactly as the seat quota does.
 *
 *  - `accounting`        Finance v2 as a whole (effective flag = stored flag && this).
 *  - `advanced_reports`  the six analysis ops reports in LOCKED_OPS_REPORTS.
 *  - `custom_reports`    the custom report builder (client-side over list data;
 *                        the API only advertises the entitlement).
 */
import { ForbiddenException } from "@nestjs/common";
import { LEGACY_ALIASES, PACKAGES, resolvePackage, type PackagePlan } from "./packages";

export type PlanFeature = "accounting" | "advanced_reports" | "custom_reports";

export const PLAN_FEATURE_KEYS: PlanFeature[] = ["accounting", "advanced_reports", "custom_reports"];

/** The plan every locked feature points the user to. */
export const FEATURE_REQUIRED_PLAN: PackagePlan = "professional";

const ALL: readonly PlanFeature[] = PLAN_FEATURE_KEYS;

/** Plan → unlocked features. */
const FEATURES_BY_PLAN: Record<PackagePlan, readonly PlanFeature[]> = {
  tenant: [],
  basic: [],
  advanced: ALL,
  professional: ALL,
  enterprise: ALL,
};

/** Ops report ids that need a feature (everything else stays open on every plan). */
export const LOCKED_OPS_REPORTS: Record<string, PlanFeature> = {
  defaulting_tenants: "advanced_reports",
  tenant_payment_behavior: "advanced_reports",
  landlord_portfolio: "advanced_reports",
  property_performance: "advanced_reports",
  occupancy_trend: "advanced_reports",
  contract_movement: "advanced_reports",
};

/** The features a (stored, possibly null/legacy) plan key unlocks. */
export function planFeatures(plan: string | null | undefined): PlanFeature[] {
  return [...FEATURES_BY_PLAN[resolvePackage(plan).key]];
}

export function planHasFeature(plan: string | null | undefined, f: PlanFeature): boolean {
  return FEATURES_BY_PLAN[resolvePackage(plan).key].includes(f);
}

/**
 * Every stored plan key (current + legacy alias) that does NOT unlock `f`.
 * For SQL filters over many accounts (background jobs), which cannot call
 * resolvePackage per row: "entitled" = the key is not in this list — so a
 * null or unknown key stays entitled, matching resolvePackage's default.
 */
export function planKeysWithout(f: PlanFeature): string[] {
  const keys = [...Object.keys(PACKAGES), ...Object.keys(LEGACY_ALIASES)];
  return keys.filter((k) => !planHasFeature(k, f)).sort();
}

const LOCK_MESSAGE_AR: Record<PlanFeature, string> = {
  accounting: "المحاسبة متاحة في باقة «المكاتب العقارية» وباقة «الشركات». قم بترقية باقتك لاستخدامها.",
  advanced_reports: "هذا التقرير التحليلي متاح في باقة «المكاتب العقارية» وباقة «الشركات». قم بترقية باقتك لعرضه.",
  custom_reports: "التقارير المخصصة متاحة في باقة «المكاتب العقارية» وباقة «الشركات». قم بترقية باقتك لاستخدامها.",
};

export interface PlanUpgradeRequiredBody {
  statusCode: 403;
  code: "PLAN_UPGRADE_REQUIRED";
  feature: PlanFeature;
  requiredPlan: PackagePlan;
  message: string;
  teaser: unknown;
}

/** The 403 a locked feature answers with. `teaser` is feature-specific (null when none / it failed). */
export function planUpgradeRequiredBody(feature: PlanFeature, teaser: unknown = null): PlanUpgradeRequiredBody {
  return {
    statusCode: 403,
    code: "PLAN_UPGRADE_REQUIRED",
    feature,
    requiredPlan: FEATURE_REQUIRED_PLAN,
    message: LOCK_MESSAGE_AR[feature],
    teaser,
  };
}

export class PlanUpgradeRequiredException extends ForbiddenException {
  constructor(feature: PlanFeature, teaser: unknown = null) {
    super(planUpgradeRequiredBody(feature, teaser));
  }
}
