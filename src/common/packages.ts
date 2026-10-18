/**
 * Subscription packages. Units and properties are unlimited on every plan;
 * the tiers differ by seats (`maxUsers`), by landlord records (`maxLandlords`
 * — عقاري holds exactly one, Oct 2026) and by the features in plan-features.ts.
 * The plan key is stored on the top-level user row (`users.package_plan`);
 * employees inherit their owner's plan.
 *
 * Account *type* (individual vs company) is a separate concept stored on
 * `users.user_type` and only drives Settings visibility — it is NOT a plan.
 */

import { daraSeller, isTaxInvoice, SUBSCRIPTION_VAT_RATE } from "./dara-seller";

export type PackagePlan = "tenant" | "basic" | "professional" | "enterprise";

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
  /**
   * Landlord (owner) records, counting every live row of the account
   * (the account-holder row and Ejar-imported parties alike). Only عقاري
   * (`basic`) is capped — at 1, its own landlord. An account already above
   * the cap keeps its rows; it just cannot add another.
   */
  maxLandlords: number;
  maxProperties: number;
  maxUnits: number;
  /** Seats — the account holder PLUS its employees (see quota.employeeCount). */
  maxUsers: number;
}

export const PACKAGES: Record<PackagePlan, PackageDef> = {
  // Tenant package — a self-managed tracker for a company's own leases. The
  // account holder IS the tenant. It runs the same portal, the same
  // getting-started checklist and the same seat model as the other plans;
  // only the quotas differ.
  // Units and properties are unlimited on every plan (Oct 2026); plans differ
  // by seats — Tenant 1 user, Basic 2, Pro 4, Enterprise unlimited (Oct 2026;
  // accounts already above a cap keep their users but cannot add more).
  // `maxUsers` counts the account holder too (see quota.employeeCount).
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
    maxProperties: UNLIMITED,
    maxUnits: UNLIMITED,
    // One seat: the tenant tracker is a single-user product by design.
    maxUsers: 1,
  },
  basic: {
    key: "basic",
    labelAr: "عقاري",
    labelEn: "Aqari",
    mode: "landlord",
    // Exactly one landlord: the account's own. Managing other people's
    // property is what المكاتب العقارية is for.
    maxLandlords: 1,
    maxProperties: UNLIMITED,
    maxUnits: UNLIMITED,
    maxUsers: 2,
  },
  professional: {
    key: "professional",
    labelAr: "المكاتب العقارية",
    labelEn: "Real Estate Offices",
    mode: "landlord",
    maxLandlords: UNLIMITED,
    maxProperties: UNLIMITED,
    maxUnits: UNLIMITED,
    maxUsers: 4,
  },
  enterprise: {
    key: "enterprise",
    labelAr: "الشركات",
    labelEn: "Companies",
    mode: "landlord",
    maxLandlords: UNLIMITED,
    maxProperties: UNLIMITED,
    maxUnits: UNLIMITED,
    maxUsers: UNLIMITED,
  },
};

/** Existing/unassigned accounts fall back to this — never lock anyone out. */
export const DEFAULT_PACKAGE: PackagePlan = "professional";

/**
 * Pre-tier plan keys map onto the closest new tier. `broker` is still the
 * `users.package_plan` column default (an unassigned account), so it stays.
 */
export const LEGACY_ALIASES: Readonly<Record<string, PackagePlan>> = {
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
 * Priced from a YEARLY list price. A shorter cycle costs more per year: six
 * months is the yearly price +10% (annualised), three months +20% — so Basic
 * is 4,200 a year, 2,310 per six months (4,620/yr) and 1,260 per quarter
 * (5,040/yr). Each payment = yearly × (1 + uplift) × months / 12.
 * Enterprise is sold on request (no online payment). Used to bill the Moyasar
 * subscription invoice. */

export type BillingCycle = "monthly" | "quarterly" | "semiannual" | "yearly";
export const BILLING_CYCLES: readonly BillingCycle[] = ["monthly", "quarterly", "semiannual", "yearly"];

/** Months one payment on `cycle` buys. */
export const CYCLE_MONTHS: Record<BillingCycle, number> = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };
/** Annualised mark-up over the yearly price. Monthly is withdrawn; priced like quarterly. */
export const CYCLE_UPLIFT: Record<BillingCycle, number> = { monthly: 0.2, quarterly: 0.2, semiannual: 0.1, yearly: 0 };

/** Arabic label for a cycle, as printed on invoices and emails. */
export const CYCLE_LABEL_AR: Record<BillingCycle, string> = {
  monthly: "شهري", quarterly: "ربع سنوي", semiannual: "نصف سنوي", yearly: "سنوي",
};

export function isBillingCycle(v: unknown): v is BillingCycle {
  return typeof v === "string" && (BILLING_CYCLES as readonly string[]).includes(v);
}

/** A stored/submitted cycle, normalised — anything unknown reads as monthly. */
export function parseCycle(v: unknown): BillingCycle {
  return isBillingCycle(v) ? v : "monthly";
}

/**
 * Cycles a NEW payment may be made on. Monthly was withdrawn (Oct 2026): it
 * stays a valid stored value — old payment rows and accounts still carry it —
 * but anything that starts a payment or records a choice goes through
 * `purchasableCycle`, which moves monthly up to quarterly.
 */
export const PURCHASABLE_CYCLES: readonly BillingCycle[] = ["quarterly", "semiannual", "yearly"];

export function purchasableCycle(v: unknown): BillingCycle {
  const c = parseCycle(v);
  return PURCHASABLE_CYCLES.includes(c) ? c : "quarterly";
}

/** Yearly list price per plan, in SAR. `null` = priced on request. */
export const PLAN_YEARLY_PRICE: Record<PackagePlan, number | null> = {
  tenant: 1000,
  basic: 4200,
  professional: 5400,
  enterprise: null,
};

/* ── Ejar lookup quota ─────────────────────────────────────────────────────
 * Ejar lookups a plan includes per YEAR, prorated to the paid period: a
 * quarterly Basic account gets floor(90 × 3/12) = 22 for its three months.
 * Enforced by the Ejar lookup budget (ejar.lookup.service) on top of the
 * gateway-wide EJAR_LOOKUP_LIMIT. Deliberately NOT advertised on the landing
 * or in the package pages — the import screen is the only place it shows.
 * `null` = no plan cap (Enterprise). */
export const PLAN_EJAR_LOOKUPS_PER_YEAR: Record<PackagePlan, number | null> = {
  tenant: 30,
  basic: 90,
  professional: 150,
  enterprise: null,
};

/** Ejar lookups a plan's period on `cycle` includes, or null when uncapped. */
export function ejarLookupQuota(plan: string | null | undefined, cycle: BillingCycle): number | null {
  const yearly = PLAN_EJAR_LOOKUPS_PER_YEAR[resolvePackage(plan).key];
  if (yearly == null) return null;
  return Math.floor((yearly * CYCLE_MONTHS[cycle]) / 12);
}

/**
 * TEST MODE — charge every payable plan (any cycle, initial or renewal) a flat
 * 1 SAR so the Moyasar flow can be exercised with real money cheaply.
 * Revert by deleting this flag / the early return below to restore real pricing.
 */
export const TEST_FLAT_PRICE_SAR: number | null = 1;

/** Price-list amount (SAR, VAT EXCLUDED) for a plan on a cycle, before any test override. */
export function listPrice(plan: string | null | undefined, cycle: BillingCycle): number | null {
  const yearly = PLAN_YEARLY_PRICE[resolvePackage(plan).key];
  if (yearly == null) return null;
  return Math.round((yearly * (1 + CYCLE_UPLIFT[cycle]) * CYCLE_MONTHS[cycle]) / 12);
}

/**
 * VAT added on top of the list price, in percent — or null while Dara is not
 * VAT-registered (no `DARA_SELLER_VAT`), when no VAT may be charged at all.
 * Same predicate as the invoice (`isTaxInvoice`), so the amount charged and
 * the document issued for it always agree.
 */
export function chargedVatRate(): number | null {
  return isTaxInvoice(daraSeller()) ? SUBSCRIPTION_VAT_RATE : null;
}

/**
 * Amount charged (SAR) for a plan on the given cycle, or null if on-request.
 * List prices exclude VAT; the charge adds it (to the halala). The invoice
 * then extracts the same VAT back out of the charged total, landing on the
 * list price as its subtotal.
 */
export function planPrice(plan: string | null | undefined, cycle: BillingCycle): number | null {
  const price = listPrice(plan, cycle);
  if (price == null) return null;
  // TEST MODE: flat price for any payable plan/cycle (see TEST_FLAT_PRICE_SAR).
  if (TEST_FLAT_PRICE_SAR != null) return TEST_FLAT_PRICE_SAR;
  const vat = chargedVatRate();
  return vat == null ? price : Math.round(price * (100 + vat)) / 100;
}

/**
 * Every payable plan's list price on every cycle — what the checkout renders —
 * plus the flat test charge when TEST MODE is on, so the page can say the
 * amount actually taken differs from the list.
 */
export function planPriceTable(): {
  list: Partial<Record<PackagePlan, Record<BillingCycle, number>>>;
  testFlatPrice: number | null;
  /** VAT % added on top of `list` at payment; null = none charged. */
  vatRate: number | null;
} {
  const list: Partial<Record<PackagePlan, Record<BillingCycle, number>>> = {};
  for (const key of ["tenant", "basic", "professional"] as const) {
    list[key] = {
      // Not purchasable any more; kept so older clients still find the key.
      monthly: listPrice(key, "monthly")!,
      quarterly: listPrice(key, "quarterly")!,
      semiannual: listPrice(key, "semiannual")!,
      yearly: listPrice(key, "yearly")!,
    };
  }
  return { list, testFlatPrice: TEST_FLAT_PRICE_SAR, vatRate: chargedVatRate() };
}

/** Whether a plan can be paid for online (Enterprise is contact-sales only). */
export function isPayablePlan(plan: string | null | undefined): boolean {
  return PLAN_YEARLY_PRICE[resolvePackage(plan).key] != null;
}
