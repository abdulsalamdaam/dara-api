import { pgTable, text, serial, timestamp, integer, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { ownersTable } from "./owners";

/**
 * Which ZATCA environment a seller is currently operating in.
 *  - sandbox    : developer-portal — for testing
 *  - simulation : pre-production rehearsal
 *  - production : live (real invoices, real CSIDs)
 */
export const zatcaEnvEnum = pgEnum("zatca_env", ["sandbox", "simulation", "production"]);

/**
 * Initial PIH seed mandated by ZATCA: SHA-256 of the literal "0", then
 * hex-encoded, then base64. Used for the very first invoice in a chain.
 */
export const ZATCA_INITIAL_PIH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";

/**
 * Per-seller ZATCA onboarding state. One row per user. Sandbox and production
 * lifecycle are kept on the same row (separate columns) so that "switch to
 * production" is a simple `activeEnvironment` flip after the prod columns are
 * filled, with no risk of cross-environment chain contamination (each env has
 * its own ICV counter and PIH chain).
 *
 * Private keys and CSID secrets are stored AES-256-GCM encrypted with the
 * APP_ENCRYPTION_KEY env var — never written to disk in plaintext.
 */
export const zatcaCredentialsTable = pgTable("zatca_credentials", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),

  /**
   * The landlord (owner) this ZATCA seller belongs to. Each landlord onboards
   * separately with their own VAT registration + CSID; null = legacy
   * account-level seller (the management company).
   */
  ownerId: integer("owner_id").references(() => ownersTable.id, { onDelete: "cascade" }),

  /** Currently selected environment — controls which credentials and counter are used. */
  activeEnvironment: zatcaEnvEnum("active_environment").notNull().default("sandbox"),

  // ── Seller profile (UBL seller party + CSR fields) ───────────────────────
  sellerName: text("seller_name").notNull(),
  sellerNameAr: text("seller_name_ar"),
  sellerVatNumber: text("seller_vat_number").notNull(),
  sellerCrn: text("seller_crn"),
  /** BT-29-1 scheme for sellerCrn: CRN (commercial reg) | MOM | MLS | SAG | OTH | 700. */
  sellerIdScheme: text("seller_id_scheme").default("CRN"),
  sellerStreet: text("seller_street").notNull(),
  sellerBuildingNo: text("seller_building_no").notNull(),
  sellerDistrict: text("seller_district").notNull(),
  sellerCity: text("seller_city").notNull(),
  sellerPostalZone: text("seller_postal_zone").notNull(),
  sellerAdditionalNo: text("seller_additional_no"),

  // ── CSR-only fields ─────────────────────────────────────────────────────
  serialNumber: text("serial_number").notNull(),
  organizationIdentifier: text("organization_identifier").notNull(),
  organizationUnitName: text("organization_unit_name").notNull(),
  invoiceType: text("invoice_type").notNull().default("1100"),
  locationAddress: text("location_address").notNull(),
  industryCategory: text("industry_category").notNull(),
  countryName: text("country_name").notNull().default("SA"),
  commonName: text("common_name").notNull(),

  // ── Sandbox onboarding ──────────────────────────────────────────────────
  sandboxPrivateKeyEnc: text("sandbox_private_key_enc"),
  sandboxPublicKeyPem: text("sandbox_public_key_pem"),
  sandboxCsrPem: text("sandbox_csr_pem"),
  sandboxBinarySecurityToken: text("sandbox_binary_security_token"),
  sandboxSecretEnc: text("sandbox_secret_enc"),
  sandboxCertPem: text("sandbox_cert_pem"),
  sandboxComplianceRequestId: text("sandbox_compliance_request_id"),
  sandboxIcv: integer("sandbox_icv").notNull().default(0),
  sandboxPih: text("sandbox_pih").notNull().default(ZATCA_INITIAL_PIH),
  sandboxOnboardedAt: timestamp("sandbox_onboarded_at", { withTimezone: true }),

  // ── Production onboarding ───────────────────────────────────────────────
  prodPrivateKeyEnc: text("prod_private_key_enc"),
  prodPublicKeyPem: text("prod_public_key_pem"),
  prodCsrPem: text("prod_csr_pem"),
  prodBinarySecurityToken: text("prod_binary_security_token"),
  prodSecretEnc: text("prod_secret_enc"),
  prodCertPem: text("prod_cert_pem"),
  prodComplianceRequestId: text("prod_compliance_request_id"),
  prodIcv: integer("prod_icv").notNull().default(0),
  prodPih: text("prod_pih").notNull().default(ZATCA_INITIAL_PIH),
  prodOnboardedAt: timestamp("prod_onboarded_at", { withTimezone: true }),
  /**
   * Which environment the prod* columns above actually hold — "simulation" or
   * "production". The two share these columns (identical lifecycle, different
   * gateway prefix and CSR template), so without this a seller that had only
   * rehearsed on simulation reported itself as live. NULL = pre-dates this
   * column; treated as unknown, never as production.
   */
  prodSlotEnv: text("prod_slot_env"),

  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // One credential row per (account, landlord). Two partial unique indexes so a
  // null ownerId (the legacy account-level seller) is also unique per account.
  userOwnerUniq: uniqueIndex("zatca_credentials_user_owner_uniq").on(t.userId, t.ownerId),
}));

export const insertZatcaCredentialsSchema = createInsertSchema(zatcaCredentialsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertZatcaCredentials = z.infer<typeof insertZatcaCredentialsSchema>;
export type ZatcaCredentials = typeof zatcaCredentialsTable.$inferSelect;
