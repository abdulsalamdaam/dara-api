import { pgTable, serial, integer, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * A subscription payment attempt against a Moyasar hosted invoice. One row is
 * created when the user starts paying (status "pending" with the Moyasar
 * invoice id + URL); the Moyasar webhook flips it to "paid" (or "failed") and
 * the owner account's subscription window is then opened/renewed.
 */
export const subscriptionPaymentsTable = pgTable("subscription_payments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  plan: text("plan").notNull(),
  billingCycle: text("billing_cycle").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("SAR"),
  /** pending | paid | failed | cancelled | review (bank receipt awaiting an admin) | rejected */
  status: text("status").notNull().default("pending"),
  /** Moyasar hosted-invoice id + the URL the user is redirected to. */
  moyasarInvoiceId: text("moyasar_invoice_id"),
  moyasarPaymentId: text("moyasar_payment_id"),
  paymentUrl: text("payment_url"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  /**
   * The invoice Dara issues for this payment. Stamped once, when the row is
   * first activated, and never recomputed — the number and the period a
   * customer holds a PDF of must keep resolving to the same document even after
   * the subscription is renewed or the plan changed.
   */
  invoiceNumber: text("invoice_number"),
  invoiceIssuedAt: timestamp("invoice_issued_at", { withTimezone: true }),
  /**
   * When the invoice was CONFIRMED sent, which is a different fact from having
   * been numbered.
   *
   * The number and the issue date are stamped before the document is rendered
   * and mailed, because the number must be stable for the download endpoint
   * before anything that can fail runs. Without this column a render or a send
   * that failed after the stamp left a row indistinguishable from a delivered
   * one — no retry, no trace, and a paying customer with nothing in their
   * inbox. NULL against a numbered row therefore means exactly "issued but not
   * delivered", and is what
   * `POST /admin/subscription-payments/:id/issue-invoice` is for.
   */
  invoiceEmailedAt: timestamp("invoice_emailed_at", { withTimezone: true }),
  /** The subscription window this payment bought. */
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  /**
   * `subscription` (a plan payment — activates/renews the window) or `addon`
   * (an account-limit add-on — activates `addon_id`, never touches the plan).
   * 0088_account_limits.sql.
   */
  kind: text("kind").$type<"subscription" | "addon">().notNull().default("subscription"),
  /** account_limit_addons.id for kind = 'addon' (FK in 0088; not declared here to avoid an import cycle). */
  addonId: integer("addon_id"),
  /** Line description for an add-on invoice; null = the package line. */
  description: text("description"),
  /**
   * How this row is paid (migration 0097): `invoice` — a hosted invoice link
   * (the old flow); `checkout` — the first in-app payment, which saves the
   * card; `renewal` — a server-side charge of the saved token;
   * `bank_transfer` — the customer transferred and uploaded the receipt (0099).
   */
  chargeType: text("charge_type").$type<"invoice" | "checkout" | "renewal" | "bank_transfer">().notNull().default("invoice"),
  paymentMethodId: integer("payment_method_id"),
  /** The subscription end a renewal pays for — unique per account (no double charge). */
  renewalOf: timestamp("renewal_of", { withTimezone: true }),
  /** The Moyasar `given_id` of the current attempt; a repeat returns the same payment. */
  moyasarGivenId: text("moyasar_given_id"),
  attempt: integer("attempt").notNull().default(0),
  failureReason: text("failure_reason"),
  /**
   * Bank transfer (0099): the receipt the customer uploaded (MinIO object key,
   * original name, content type) and the admin review. `review_note` is the
   * rejection reason the customer sees.
   */
  receiptKey: text("receipt_key"),
  receiptName: text("receipt_name"),
  receiptType: text("receipt_type"),
  receiptUploadedAt: timestamp("receipt_uploaded_at", { withTimezone: true }),
  reviewedBy: integer("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNote: text("review_note"),
  /**
   * The gateway that took this payment (0103): `moyasar` (every row before
   * Dhamen) or `dhamen`. For Dhamen, `gateway_ref` is our paymentReferenceId
   * there and `gateway_invoice_id` the invoice the embedded widget mounts.
   */
  gateway: text("gateway").$type<"moyasar" | "dhamen">().notNull().default("moyasar"),
  gatewayRef: text("gateway_ref"),
  gatewayInvoiceId: text("gateway_invoice_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
