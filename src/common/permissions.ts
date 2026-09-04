/**
 * Permission catalog. Add new keys as features are added — these strings are
 * the contract between the API guard and the dashboard's UI gating.
 */
export const PERMISSIONS = {
  DEEDS_VIEW:   "deeds.view",
  DEEDS_WRITE:  "deeds.write",
  DEEDS_DELETE: "deeds.delete",

  PROPERTIES_VIEW:   "properties.view",
  PROPERTIES_WRITE:  "properties.write",
  PROPERTIES_DELETE: "properties.delete",

  UNITS_VIEW:   "units.view",
  UNITS_WRITE:  "units.write",
  UNITS_DELETE: "units.delete",

  CONTRACTS_VIEW:   "contracts.view",
  CONTRACTS_WRITE:  "contracts.write",
  CONTRACTS_DELETE: "contracts.delete",

  PAYMENTS_VIEW:  "payments.view",
  PAYMENTS_WRITE: "payments.write",

  OWNERS_VIEW:   "owners.view",
  OWNERS_WRITE:  "owners.write",
  OWNERS_DELETE: "owners.delete",

  TENANTS_VIEW:   "tenants.view",
  TENANTS_WRITE:  "tenants.write",
  TENANTS_DELETE: "tenants.delete",

  MAINTENANCE_VIEW:   "maintenance.view",
  MAINTENANCE_WRITE:  "maintenance.write",
  MAINTENANCE_DELETE: "maintenance.delete",

  FACILITIES_VIEW:   "facilities.view",
  FACILITIES_WRITE:  "facilities.write",
  FACILITIES_DELETE: "facilities.delete",

  CAMPAIGNS_VIEW:   "campaigns.view",
  CAMPAIGNS_WRITE:  "campaigns.write",
  CAMPAIGNS_DELETE: "campaigns.delete",

  REPORTS_VIEW: "reports.view",

  SUPPORT_VIEW:    "support.view",
  SUPPORT_RESPOND: "support.respond",

  ADMIN_DASHBOARD: "admin.dashboard",
  ADMIN_USERS:     "admin.users",
  ADMIN_ROLES:     "admin.roles",
  ADMIN_DEMO:      "admin.demo",

  INVOICES_VIEW:   "invoices.view",
  INVOICES_WRITE:  "invoices.write",
  INVOICES_DELETE: "invoices.delete",
  ZATCA_ONBOARD:              "zatca.onboard",
  ZATCA_PROMOTE_PRODUCTION:   "zatca.promote-production",

  // Expenses — finance sub-module (managed/approved by Accountant + GM).
  EXPENSES_VIEW:    "expenses.view",
  EXPENSES_WRITE:   "expenses.write",
  EXPENSES_APPROVE: "expenses.approve",

  // Subscription/billing management (General Manager).
  SUBSCRIPTION_MANAGE: "subscription.manage",
} as const;

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS) as Permission[];

/** Read-only, viewer-style preset for a typical accountant or read-only user. */
const VIEW_ONLY: Permission[] = [
  PERMISSIONS.DEEDS_VIEW,
  PERMISSIONS.PROPERTIES_VIEW, PERMISSIONS.UNITS_VIEW, PERMISSIONS.CONTRACTS_VIEW,
  PERMISSIONS.PAYMENTS_VIEW, PERMISSIONS.OWNERS_VIEW, PERMISSIONS.TENANTS_VIEW,
  PERMISSIONS.MAINTENANCE_VIEW, PERMISSIONS.FACILITIES_VIEW, PERMISSIONS.CAMPAIGNS_VIEW,
  PERMISSIONS.REPORTS_VIEW, PERMISSIONS.INVOICES_VIEW,
];

const FULL_TENANT_ADMIN: Permission[] = [
  PERMISSIONS.DEEDS_VIEW, PERMISSIONS.DEEDS_WRITE, PERMISSIONS.DEEDS_DELETE,
  PERMISSIONS.PROPERTIES_VIEW, PERMISSIONS.PROPERTIES_WRITE, PERMISSIONS.PROPERTIES_DELETE,
  PERMISSIONS.UNITS_VIEW, PERMISSIONS.UNITS_WRITE, PERMISSIONS.UNITS_DELETE,
  PERMISSIONS.CONTRACTS_VIEW, PERMISSIONS.CONTRACTS_WRITE, PERMISSIONS.CONTRACTS_DELETE,
  PERMISSIONS.PAYMENTS_VIEW, PERMISSIONS.PAYMENTS_WRITE,
  PERMISSIONS.OWNERS_VIEW, PERMISSIONS.OWNERS_WRITE, PERMISSIONS.OWNERS_DELETE,
  PERMISSIONS.TENANTS_VIEW, PERMISSIONS.TENANTS_WRITE, PERMISSIONS.TENANTS_DELETE,
  PERMISSIONS.MAINTENANCE_VIEW, PERMISSIONS.MAINTENANCE_WRITE, PERMISSIONS.MAINTENANCE_DELETE,
  PERMISSIONS.FACILITIES_VIEW, PERMISSIONS.FACILITIES_WRITE, PERMISSIONS.FACILITIES_DELETE,
  PERMISSIONS.CAMPAIGNS_VIEW, PERMISSIONS.CAMPAIGNS_WRITE, PERMISSIONS.CAMPAIGNS_DELETE,
  PERMISSIONS.REPORTS_VIEW,
  PERMISSIONS.SUPPORT_VIEW,
  PERMISSIONS.INVOICES_VIEW, PERMISSIONS.INVOICES_WRITE, PERMISSIONS.INVOICES_DELETE,
  PERMISSIONS.ZATCA_ONBOARD, PERMISSIONS.ZATCA_PROMOTE_PRODUCTION,
  PERMISSIONS.EXPENSES_VIEW, PERMISSIONS.EXPENSES_WRITE, PERMISSIONS.EXPENSES_APPROVE,
  PERMISSIONS.SUBSCRIPTION_MANAGE,
];

/**
 * Default permissions per role enum. `super_admin` gets everything; `admin`
 * gets everything except platform-level admin operations; `user` is a tenant-
 * facing landlord with full property control; `demo` is read-only.
 */
export const ROLE_PRESETS: Record<"super_admin" | "admin" | "user" | "demo", Permission[]> = {
  super_admin: ALL_PERMISSIONS,
  admin: [
    ...FULL_TENANT_ADMIN,
    PERMISSIONS.SUPPORT_RESPOND,
    PERMISSIONS.ADMIN_DASHBOARD,
    PERMISSIONS.ADMIN_USERS,
  ],
  user: FULL_TENANT_ADMIN,
  demo: VIEW_ONLY,
};

/**
 * Resolve the permissions a principal actually holds.
 *
 * A custom array is a SUBSET of the role's preset, never an extension of it.
 * This used to return the custom array verbatim, so whatever wrote it decided
 * the ceiling — and the docstring three definitions below already claimed
 * `ROLE_PRESETS.user` was the upper bound for employees while nothing enforced
 * it. A custom array carrying `admin.users` or `zatca.promote-production`
 * would have been honoured in full.
 *
 * Intersecting is the enforcement. Widening what a role may hold is then a
 * deliberate edit to `ROLE_PRESETS`, which is reviewable, rather than a value
 * that arrived in a column.
 */
export function effectivePermissions(role: keyof typeof ROLE_PRESETS, custom?: string[] | null): Permission[] {
  const preset = ROLE_PRESETS[role] || [];
  if (!custom || !Array.isArray(custom)) return preset;
  const granted = new Set<string>(custom);
  // Iterating the PRESET (not the stored array) is what makes this a clamp:
  // anything in `custom` that the preset does not contain cannot appear in the
  // output at all, and the result is de-duplicated and stably ordered for free.
  return preset.filter((p) => granted.has(p));
}

export function hasPermission(perms: string[] | undefined | null, key: Permission): boolean {
  if (!perms) return false;
  return perms.includes(key);
}

/**
 * Employee role templates picked by an owner when adding a team member. These
 * are *labels*, not role-enum values — the underlying user.role stays "user"
 * (so `ROLE_PRESETS.user` is the upper bound) and we copy these permissions
 * into user.permissions JSONB. Owners can then trim/extend per individual.
 *
 * **Two of them exceed that upper bound today.** `general` and
 * `customerService` grant `support.respond`, which `ROLE_PRESETS.user`
 * (= `FULL_TENANT_ADMIN`) does not contain — it answers a customer's own
 * support tickets, which a General Manager and a customer-service employee
 * legitimately do. Nothing is broken by it right now: permissions are read
 * from `roles.permissions` at request time (`JwtAuthGuard`), these presets are
 * seeded into `roles` rows by `bootstrap.ts`, and `effectivePermissions` has
 * no caller. But it means the clamp above and this comment disagree, so before
 * wiring `effectivePermissions` into the employee path, `SUPPORT_RESPOND` has
 * to be added to `FULL_TENANT_ADMIN` deliberately (which also grants it to
 * every landlord account) or these two presets have to give it up.
 * `permissions.spec.ts` pins the discrepancy so a THIRD one cannot appear
 * unnoticed.
 */
export const EMPLOYEE_PRESETS: Record<string, { labelAr: string; labelEn: string; permissions: Permission[] }> = {
  // 1) المدير العام — highest authority: everything the owner can do.
  general: {
    labelAr: "المدير العام",
    labelEn: "General Manager",
    permissions: [...FULL_TENANT_ADMIN, PERMISSIONS.SUPPORT_RESPOND, PERMISSIONS.CAMPAIGNS_VIEW, PERMISSIONS.CAMPAIGNS_WRITE],
  },
  // 2) مدير العقارات — daily operations across properties; no finance writes,
  //    no system settings / user management.
  propertyManager: {
    labelAr: "مدير العقارات",
    labelEn: "Property Manager",
    permissions: [
      PERMISSIONS.DEEDS_VIEW, PERMISSIONS.DEEDS_WRITE,
      PERMISSIONS.PROPERTIES_VIEW, PERMISSIONS.PROPERTIES_WRITE,
      PERMISSIONS.UNITS_VIEW, PERMISSIONS.UNITS_WRITE,
      PERMISSIONS.OWNERS_VIEW, PERMISSIONS.OWNERS_WRITE,
      PERMISSIONS.TENANTS_VIEW, PERMISSIONS.TENANTS_WRITE,
      PERMISSIONS.CONTRACTS_VIEW, PERMISSIONS.CONTRACTS_WRITE,
      PERMISSIONS.MAINTENANCE_VIEW, PERMISSIONS.MAINTENANCE_WRITE,
      PERMISSIONS.PAYMENTS_VIEW,
      PERMISSIONS.REPORTS_VIEW,
    ],
  },
  // 3) مسؤول العقود — contracts only: create/edit drafts, attachments, add
  //    owners/tenants, renew. No financial reports, no payments.
  leasingOfficer: {
    labelAr: "مسؤول العقود",
    labelEn: "Leasing Officer",
    permissions: [
      PERMISSIONS.CONTRACTS_VIEW, PERMISSIONS.CONTRACTS_WRITE,
      PERMISSIONS.OWNERS_VIEW, PERMISSIONS.OWNERS_WRITE,
      PERMISSIONS.TENANTS_VIEW, PERMISSIONS.TENANTS_WRITE,
      PERMISSIONS.DEEDS_VIEW, PERMISSIONS.DEEDS_WRITE,
      PERMISSIONS.PROPERTIES_VIEW,
      PERMISSIONS.UNITS_VIEW,
    ],
  },
  // 4) مسؤول التحصيل — collections, invoices (view), installments, overdue,
  //    reminders, payment plans. No contracts/properties writes; can't approve
  //    notes (no invoices.write).
  collectionOfficer: {
    labelAr: "مسؤول التحصيل",
    labelEn: "Collection Officer",
    permissions: [
      PERMISSIONS.PAYMENTS_VIEW, PERMISSIONS.PAYMENTS_WRITE,
      PERMISSIONS.INVOICES_VIEW,
      PERMISSIONS.CONTRACTS_VIEW,
      PERMISSIONS.TENANTS_VIEW,
      PERMISSIONS.REPORTS_VIEW,
    ],
  },
  // 5) المحاسب — finance: installments, invoices, payments, receipts, taxes,
  //    expenses + approvals; no property or user management.
  accountant: {
    labelAr: "المحاسب",
    labelEn: "Accountant",
    permissions: [
      PERMISSIONS.PAYMENTS_VIEW, PERMISSIONS.PAYMENTS_WRITE,
      PERMISSIONS.INVOICES_VIEW, PERMISSIONS.INVOICES_WRITE, PERMISSIONS.INVOICES_DELETE,
      PERMISSIONS.EXPENSES_VIEW, PERMISSIONS.EXPENSES_WRITE, PERMISSIONS.EXPENSES_APPROVE,
      PERMISSIONS.ZATCA_ONBOARD,
      PERMISSIONS.CONTRACTS_VIEW,
      PERMISSIONS.TENANTS_VIEW,
      PERMISSIONS.OWNERS_VIEW,
      PERMISSIONS.PROPERTIES_VIEW,
      PERMISSIONS.UNITS_VIEW,
      PERMISSIONS.REPORTS_VIEW,
    ],
  },
  // 6) مسؤول الصيانة — maintenance, suppliers/technicians (facilities),
  //    scheduling + maintenance reports. No finance, no contracts.
  maintenanceManager: {
    labelAr: "مسؤول الصيانة",
    labelEn: "Maintenance Manager",
    permissions: [
      PERMISSIONS.MAINTENANCE_VIEW, PERMISSIONS.MAINTENANCE_WRITE, PERMISSIONS.MAINTENANCE_DELETE,
      PERMISSIONS.FACILITIES_VIEW, PERMISSIONS.FACILITIES_WRITE,
      PERMISSIONS.PROPERTIES_VIEW,
      PERMISSIONS.UNITS_VIEW,
      PERMISSIONS.REPORTS_VIEW,
    ],
  },
  // 7) موظف خدمة العملاء — tenants, tickets, support, notifications. No
  //    finance, no contracts.
  customerService: {
    labelAr: "موظف خدمة العملاء",
    labelEn: "Customer Service",
    permissions: [
      PERMISSIONS.TENANTS_VIEW, PERMISSIONS.TENANTS_WRITE,
      PERMISSIONS.SUPPORT_VIEW, PERMISSIONS.SUPPORT_RESPOND,
      PERMISSIONS.MAINTENANCE_VIEW,
    ],
  },
};

/**
 * Role keys belonging to Dara's own staff rather than to a customer account.
 */
export const STAFF_ROLE_KEYS = ["super_admin", "admin"] as const;

/**
 * Is this row a customer account (a "company" in the admin portal) rather than
 * an employee under one, or Dara staff?
 *
 * Defined by TOPOLOGY — no owner above it, and not staff — instead of by
 * `roleKey === "user"`. The role key stopped being a reliable signal once a
 * company account's owner could hold the General Manager role: the old test
 * would have dropped those accounts from the admin's registrations list, so a
 * new company signup could never have been approved.
 */
export function isCustomerAccount(row: { ownerUserId?: number | null; roleKey?: string | null }): boolean {
  if (row.ownerUserId != null) return false;                       // an employee
  return !(STAFF_ROLE_KEYS as readonly string[]).includes(row.roleKey ?? "");
}
