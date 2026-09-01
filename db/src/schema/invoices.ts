import {
  pgTable, text, serial, timestamp, integer, jsonb, date, pgEnum, boolean, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { contractsTable } from "./contracts";
import { paymentsTable } from "./payments";
import { ownersTable } from "./owners";
import { zatcaEnvEnum } from "./zatcaCredentials";

export const invoiceProfileEnum = pgEnum("invoice_profile", ["standard", "simplified"]);
export const invoiceDocTypeEnum = pgEnum("invoice_doc_type", ["invoice", "credit", "debit"]);
export const invoiceLanguageEnum = pgEnum("invoice_language", ["ar", "en"]);
/**
 * Lifecycle:
 *   draft     — built locally, not yet sent
 *   submitted — sent to ZATCA (any endpoint)
 *   cleared   — clearance succeeded (B2B standard)
 *   reported  — reporting accepted (B2C simplified)
 *   rejected  — ZATCA rejected with validation errors
 *   error     — local or transport-layer failure
 */
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft", "submitted", "cleared", "reported", "rejected", "error",
]);

export type SellerSnapshot = {
  name: string; nameAr?: string | null;
  vat: string; crn?: string | null;
  /** BT-29-1 scheme for the seller identification: CRN | MOM | MLS | SAG | OTH | 700. Defaults to CRN. */
  idScheme?: string | null;
  street: string; buildingNo: string; district: string; city: string;
  postalZone: string; additionalNo?: string | null;
  logoUrl?: string | null;
};
export type BuyerSnapshot = {
  name: string; nameAr?: string | null;
  vat?: string | null;
  /**
   * The buyer's own identifier — CR for a company, national ID / iqama for an
   * individual. ZATCA's BT-46, and the counterpart of the seller's `crn`.
   *
   * Emitted as the buyer `PartyIdentification` on a STANDARD (B2B) invoice
   * only. A simplified invoice is issued to a walk-in consumer who has no
   * identifier to state, and adding an empty or invented one to a B2C document
   * is worse than omitting it.
   */
  id?: string | null;
  /** BT-46-1 scheme for `id`: CRN | MOM | MLS | SAG | OTH | 700 (NAT/IQA are NOT valid). */
  idScheme?: string | null;
  street?: string | null; buildingNo?: string | null; district?: string | null;
  city?: string | null; postalZone?: string | null; additionalNo?: string | null;
};
export type InvoiceTotals = {
  lineExtension: number; taxExclusive: number;
  taxAmount: number; taxInclusive: number; payable: number;
  subtotals: { category: string; percent: number; taxable: number; tax: number }[];
};
export type ZatcaResponse = {
  validationResults?: {
    status?: string;
    errorMessages?: { code: string; message: string }[];
    warningMessages?: { code: string; message: string }[];
    infoMessages?: { code: string; message: string }[];
  };
  clearanceStatus?: string;
  reportingStatus?: string;
  clearedInvoice?: string;
  [k: string]: unknown;
} | null;

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),

  invoiceNumber: text("invoice_number").notNull(),
  uuid: text("uuid").notNull(),

  contractId: integer("contract_id").references(() => contractsTable.id, { onDelete: "set null" }),
  paymentId: integer("payment_id").references(() => paymentsTable.id, { onDelete: "set null" }),
  /** The landlord (seller) this invoice was issued for. Null = account-level
   *  seller. Each landlord keeps its OWN ICV/PIH chain, so uniqueness below is
   *  scoped per landlord. */
  ownerId: integer("owner_id").references(() => ownersTable.id, { onDelete: "set null" }),

  profile: invoiceProfileEnum("profile").notNull(),
  docType: invoiceDocTypeEnum("doc_type").notNull().default("invoice"),
  language: invoiceLanguageEnum("language").notNull().default("ar"),
  currency: text("currency").notNull().default("SAR"),

  issueDate: date("issue_date").notNull(),
  issueTime: text("issue_time").notNull(),

  /** Sequential per-(user, environment) — matches ZATCA's ICV / PIH chain. */
  icv: integer("icv").notNull(),
  pih: text("pih").notNull(),
  environment: zatcaEnvEnum("environment").notNull(),

  // Credit / debit notes
  billingReferenceId: text("billing_reference_id"),
  instructionNote: text("instruction_note"),
  paymentMeansCode: text("payment_means_code").notNull().default("10"),

  /** Frozen at issue time. Never mutated — even if seller/buyer info changes later. */
  sellerSnapshot: jsonb("seller_snapshot").$type<SellerSnapshot>().notNull(),
  buyerSnapshot: jsonb("buyer_snapshot").$type<BuyerSnapshot | null>(),
  totals: jsonb("totals").$type<InvoiceTotals>().notNull(),

  unsignedXml: text("unsigned_xml").notNull(),
  signedXml: text("signed_xml"),
  invoiceHash: text("invoice_hash"),
  qrBase64: text("qr_base64"),
  signatureValue: text("signature_value"),

  status: invoiceStatusEnum("status").notNull().default("draft"),
  submittedTo: text("submitted_to"),
  httpStatus: integer("http_status"),
  zatcaResponse: jsonb("zatca_response").$type<ZatcaResponse>(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  clearedXml: text("cleared_xml"),

  notes: text("notes"),
  isDemo: boolean("is_demo").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // Invoice numbers must be unique per seller (across all envs).
  invoiceNumberUniq: uniqueIndex("invoices_user_invoice_number_uniq").on(t.userId, t.invoiceNumber),
  // ICV must be unique per (landlord seller, environment) — each landlord has
  // its OWN ICV/PIH chain, so account-level (owner_id null → 0) and every
  // landlord get independent sequences.
  icvUniq: uniqueIndex("invoices_user_owner_env_icv_uniq").on(t.userId, sql`coalesce(${t.ownerId}, 0)`, t.environment, t.icv),
  byUser: index("invoices_user_idx").on(t.userId, t.createdAt),
  byContract: index("invoices_contract_idx").on(t.contractId),
  byPayment: index("invoices_payment_idx").on(t.paymentId),
}));

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;
