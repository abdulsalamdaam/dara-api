/**
 * Subscription packages. Four tiers gate the unit quota (properties scale
 * with units; landlords are unlimited — the Landlords tab is available on
 * every plan). The plan key is stored on the top-level user row
 * (`users.package_plan`); employees inherit their owner's plan.
 *
 * Account *type* (individual vs company) is a separate concept stored on
 * `users.user_type` and only drives Settings visibility — it is NOT a plan.
 */

export type PackagePlan = "tenant" | "basic" | "advanced" | "professional" | "enterprise";

/** Two product modes: the tenant self-tracker vs the full landlord portal. */
export type PackageMode = "tenant" | "landlord";

/** Sentinel for "unlimited" — large enough to never gate in practice. */
export const UNLIMITED = 1_000_000;

/** Account type stored on `users.user_type`. */
export type UserAccountType = "individual" | "company";

export interface PackageDef {
  key: PackagePlan;
  labelAr: string;
  labelEn: string;
  /** tenant = personal contract tracker; landlord = full portal. */
  mode: PackageMode;
  /**
   * When set, only this account type may hold the plan. Enforced on every
   * path that writes `users.package_plan` — self-registration, admin approval
   * and admin package changes — because the UI hiding an option is a
   * convenience, not a control.
   */
  requiresUserType?: UserAccountType;
  /** Landlord (owner) records — unlimited on every plan. */
  maxLandlords: number;
  maxProperties: number;
  maxUnits: number;
  /** Team members (employees) the owner may add — excludes the owner itself. */
  maxUsers: number;
}

export const PACKAGES: Record<PackagePlan, PackageDef> = {
  // Tenant package — a self-managed tracker for a company's own leases. The
  // account holder IS the tenant. It runs the same portal, the same
  // getting-started checklist and the same seat model as the other plans;
  // only the quotas differ.
  // Landing limits: Tenant 50 units / 1 user, Basic 500 / 3, Pro 1,000 / 6,
  // Enterprise unlimited. `maxUsers` counts ADDED employees — the account
  // holder is not billed against it (see listEmployees).
  tenant: {
    key: "tenant",
    labelAr: "المستأجرين",
    labelEn: "Tenants",
    mode: "tenant",
    // Sold to corporate tenants only — a company tracking the units it leases
    // (staff housing, branches). An individual renting their own home is not
    // the buyer for this, so the plan is closed to individual accounts.
    requiresUserType: "company",
    // A tenant adds the landlord(s) they rent from — don't gate that.
    maxLandlords: UNLIMITED,
    maxProperties: 50,
    maxUnits: 50,
    // One seat: the tenant tracker is a single-user product by design.
    maxUsers: 1,
  },
  basic: {
    key: "basic",
    labelAr: "الأساسية",
    labelEn: "Basic",
    mode: "landlord",
    maxLandlords: UNLIMITED,
    maxProperties: 500,
    maxUnits: 500,
    maxUsers: 3,
  },
  // Legacy tier — not offered anymore; mapped to the closest current limits.
  advanced: {
    key: "advanced",
    labelAr: "المتقدمة",
    labelEn: "Advanced",
    mode: "landlord",
    maxLandlords: UNLIMITED,
    maxProperties: 500,
    maxUnits: 500,
    maxUsers: 3,
  },
  professional: {
    key: "professional",
    labelAr: "المطورة",
    labelEn: "Pro",
    mode: "landlord",
    maxLandlords: UNLIMITED,
    maxProperties: 1000,
    maxUnits: 1000,
    maxUsers: 6,
  },
  enterprise: {
    key: "enterprise",
    labelAr: "الأعمال",
    labelEn: "Enterprise",
    mode: "landlord",
    maxLandlords: UNLIMITED,
    maxProperties: UNLIMITED,
    maxUnits: UNLIMITED,
    maxUsers: UNLIMITED,
  },
};

/** Existing/unassigned accounts fall back to this — never lock anyone out. */
export const DEFAULT_PACKAGE: PackagePlan = "professional";

/** Pre-tier plan keys map onto the closest new tier (kept for old rows). */
const LEGACY_ALIASES: Record<string, PackagePlan> = {
  individual_owner: "basic",
  broker: "professional",
};

export function resolvePackage(plan: string | null | undefined): PackageDef {
  if (plan && plan in PACKAGES) return PACKAGES[plan as PackagePlan];
  if (plan && LEGACY_ALIASES[plan]) return PACKAGES[LEGACY_ALIASES[plan]];
  return PACKAGES[DEFAULT_PACKAGE];
}

/** Whether a string is one of the current plan keys. */
export function isPackagePlan(plan: string | null | undefined): plan is PackagePlan {
  return !!plan && plan in PACKAGES;
}

/** The product mode (tenant tracker vs landlord portal) for a plan. */
export function packageMode(plan: string | null | undefined): PackageMode {
  return resolvePackage(plan).mode;
}

/** The account type a plan is restricted to, or null when it is open to all. */
export function planRequiredUserType(plan: string | null | undefined): UserAccountType | null {
  return resolvePackage(plan).requiresUserType ?? null;
}

/**
 * Whether an account of `userType` may hold `plan`.
 *
 * An unknown/missing userType is treated as "individual", matching how
 * registration normalises it — the restriction has to fail closed, or the
 * check could be skipped by simply omitting the field.
 */
export function planAllowedForUserType(
  plan: string | null | undefined,
  userType: string | null | undefined,
): boolean {
  const required = planRequiredUserType(plan);
  if (!required) return true;
  return (userType === "company" ? "company" : "individual") === required;
}

/** User-facing refusal message for a plan an account type may not hold. */
export function planUserTypeError(plan: string | null | undefined): string {
  const def = resolvePackage(plan);
  return def.requiresUserType === "company"
    ? `باقة "${def.labelAr}" متاحة للمنشآت والشركات فقط. اختر نوع الحساب "منشأة" أو اختر باقة أخرى.`
    : `باقة "${def.labelAr}" غير متاحة لهذا النوع من الحسابات.`;
}

/* ── Subscription pricing (SAR) ────────────────────────────────────────────
 * Mirrors the landing: a monthly base price, and a yearly price that applies a
 * 15% discount (round(monthly × 0.85) × 12). Enterprise is sold on request
 * (no online payment). Used to bill the Moyasar subscription invoice. */

export type BillingCycle = "monthly" | "yearly";
export const YEARLY_DISCOUNT = 0.15;

/** Monthly base price per plan, in SAR. `null` = priced on request. */
export const PLAN_MONTHLY_PRICE: Record<PackagePlan, number | null> = {
  tenant: 50,
  basic: 250,
  advanced: 250,
  professional: 350,
  enterprise: null,
};

/**
 * TEST MODE — charge every payable plan (any cycle, initial or renewal) a flat
 * 1 SAR so the Moyasar flow can be exercised with real money cheaply.
 * Revert by deleting this flag / the early return below to restore real pricing.
 */
export const TEST_FLAT_PRICE_SAR: number | null = 1;

/** Amount charged (SAR) for a plan on the given cycle, or null if on-request. */
export function planPrice(plan: string | null | undefined, cycle: BillingCycle): number | null {
  const monthly = PLAN_MONTHLY_PRICE[resolvePackage(plan).key];
  if (monthly == null) return null;
  // TEST MODE: flat price for any payable plan/cycle (see TEST_FLAT_PRICE_SAR).
  if (TEST_FLAT_PRICE_SAR != null) return TEST_FLAT_PRICE_SAR;
  return cycle === "yearly" ? Math.round(monthly * (1 - YEARLY_DISCOUNT)) * 12 : monthly;
}

/** Whether a plan can be paid for online (Enterprise is contact-sales only). */
export function isPayablePlan(plan: string | null | undefined): boolean {
  return PLAN_MONTHLY_PRICE[resolvePackage(plan).key] != null;
}
