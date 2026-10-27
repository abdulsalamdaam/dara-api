/**
 * Package feature gates — what a plan unlocks beyond its quotas.
 *
 * The analysis features are exclusive to المكاتب العقارية (`professional`) and
 * الشركات (`enterprise`). A null/unknown plan — and the `broker` column
 * default — resolves to DEFAULT_PACKAGE (professional) as everywhere
 * else in packages.ts, so nobody is locked out by a missing value.
 *
 * Always resolve with the ACCOUNT OWNER's plan (`users.package_plan` of
 * `scopeId(user)`) — employees inherit it, exactly as the seat quota does.
 *
 *  - `accounting`        Finance v2 as a whole (effective flag = stored flag && this).
 *  - `advanced_reports`  the six analysis ops reports in LOCKED_OPS_REPORTS.
 *  - `rental_offers`     formal B2B rental offers (عروض التأجير, /rental-offers).
 *
 * The custom report builder (`custom_reports`) was withdrawn on every plan
 * (Oct 2026) — it is no longer a feature, so it is not a key here.
 */
import { ForbiddenException } from "@nestjs/common";
import { LEGACY_ALIASES, PACKAGES, resolvePackage, type PackagePlan } from "./packages";

export type PlanFeature = "accounting" | "advanced_reports" | "rental_offers";

export const PLAN_FEATURE_KEYS: PlanFeature[] = ["accounting", "advanced_reports", "rental_offers"];

/** The plan every locked feature points the user to. */
export const FEATURE_REQUIRED_PLAN: PackagePlan = "professional";

const ALL: readonly PlanFeature[] = PLAN_FEATURE_KEYS;

/** Plan → unlocked features. */
const FEATURES_BY_PLAN: Record<PackagePlan, readonly PlanFeature[]> = {
  tenant: [],
  basic: [],
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
  rental_offers: "عروض التأجير متاحة في باقة «المكاتب العقارية» وباقة «الشركات». قم بترقية باقتك لإصدارها.",
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

/**
 * Commission (فاتورة عمولة, COM-…) — the office billing a landlord for managing
 * his property — is an Offices/Companies activity: it rides on `accounting`,
 * exactly as Finance v2's own commission run does (`fv2PlanEntitledSql`), so
 * عقاري (`basic`) and `tenant` never issue one, by any path: the legacy paired
 * commission on rent-invoice approval, a manual commission document, approving
 * a commission draft left from before a downgrade, or the v2 month-end run.
 * A stale `management_fee_percent` on a property does not change that.
 *
 * Same resolution as every other plan gate: the ACCOUNT OWNER's stored
 * `users.package_plan` through resolvePackage — a trial is the plan it grants,
 * an admin-assigned plan is that plan, null/unknown/`broker` → professional.
 */
export function planAllowsCommission(plan: string | null | undefined): boolean {
  return planHasFeature(plan, "accounting");
}

export const COMMISSION_LOCK_MESSAGE_AR =
  "فواتير العمولة متاحة في باقة «المكاتب العقارية» وباقة «الشركات» فقط، ولا تصدر في باقة «عقاري». قم بترقية باقتك لإصدارها.";

/** The 403 a commission document answers with on a plan without it (same shape as every plan gate). */
export class CommissionNotInPlanException extends ForbiddenException {
  constructor() {
    super({ ...planUpgradeRequiredBody("accounting"), message: COMMISSION_LOCK_MESSAGE_AR });
  }
}

/** Throws CommissionNotInPlanException unless `plan` includes commission. */
export function assertPlanAllowsCommission(plan: string | null | undefined): void {
  if (!planAllowsCommission(plan)) throw new CommissionNotInPlanException();
}

/**
 * The landlord CR on an Ejar inquiry (`POST /ejar/lookup` `landlord_cr`).
 *
 *  - عقاري (`basic`) — `required`: the account manages its own property, so
 *    it may only pull a contract whose lessor it is. The typed CR (or the
 *    individual landlord's national ID) must match a lessor in Ejar's answer,
 *    checked locally — Balady does not filter by CR (`cr_numbers` → 0, Oct 2026).
 *  - المكاتب / الشركات and the rest — `optional`: an office manages many
 *    landlords, so the contract number alone is enough (a CR sent anyway is
 *    still checked).
 * The `tenant` plan is scoped to its own CR by `ejar.scope.ts` instead.
 */
export type EjarLandlordCrRule = "required" | "optional";

export function ejarLandlordCrRule(plan: string | null | undefined): EjarLandlordCrRule {
  return resolvePackage(plan).key === "basic" ? "required" : "optional";
}
