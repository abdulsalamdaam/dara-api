import { pgTable, text, serial, timestamp, pgEnum, integer, boolean, numeric, jsonb } from "drizzle-orm/pg-core";

export const tenantTypeEnum = pgEnum("tenant_type", ["individual", "company"]);
export const tenantStatusEnum = pgEnum("tenant_status", ["active", "inactive"]);

export const tenantsTable = pgTable("tenants", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  name: text("name").notNull(),
  // Short / display name (الاسم المختصر) for quick reference across the UI.
  shortName: text("short_name"),
  type: tenantTypeEnum("type").notNull().default("individual"),
  nationalId: text("national_id"),
  phone: text("phone"),
  email: text("email"),
  taxNumber: text("tax_number"),
  // Financial fields — surfaced on the new Financial step of the tenant
  // wizard. iban + employer + monthlyIncome help collectors size payment
  // plans. All nullable; pre-migration rows leave them empty.
  iban: text("iban"),
  employer: text("employer"),
  monthlyIncome: numeric("monthly_income", { precision: 12, scale: 2 }),
  // National address (العنوان الوطني) — structured Saudi block. Legacy
  // `address` stays for free-text fallback.
  nationalAddressCity: text("national_address_city"),
  nationalAddressDistrict: text("national_address_district"),
  nationalAddressStreet: text("national_address_street"),
  address: text("address"),
  postalCode: text("postal_code"),
  additionalNumber: text("additional_number"),
  buildingNumber: text("building_number"),
  nationality: text("nationality"),
  // Representative (وكيل) flow — same pattern as owners.ts. When set, the
  // row describes the agent and original-tenant fields hold the actual
  // tenant identity.
  isRepresentative: boolean("is_representative").notNull().default(false),
  representativeDocUrl: text("representative_doc_url"),
  originalTenantName: text("original_tenant_name"),
  originalTenantIdNumber: text("original_tenant_id_number"),
  originalTenantPhone: text("original_tenant_phone"),
  originalTenantEmail: text("original_tenant_email"),
  status: tenantStatusEnum("status").notNull().default("active"),
  notes: text("notes"),
  isDemo: text("is_demo").default("false"),
  // Draft records are saved incomplete and finished later.
  isDraft: boolean("is_draft").notNull().default(false),
  /**
   * This tenant row IS the account holder — a tenant-package account tracking
   * its own leases, not a third party. Server-owned; see owners.isAccountHolder
   * for why this is a column of its own and never in a field allowlist.
   */
  isAccountHolder: boolean("is_account_holder").notNull().default(false),
  // Provenance for Ejar (NHC) imports — `ejarRaw` is the verbatim party
  // object from the contract (id_type, vat, organization_type, role…), see
  // contracts.ejarRaw.
  ejarSource: text("ejar_source"),
  ejarRaw: jsonb("ejar_raw").$type<Record<string, unknown>>(),
  tokenVersion: integer("token_version").notNull().default(0),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  fcmToken: text("fcm_token"),
  fcmPlatform: text("fcm_platform"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type Tenant = typeof tenantsTable.$inferSelect;
