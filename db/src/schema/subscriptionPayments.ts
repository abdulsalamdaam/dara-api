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
  /** pending | paid | failed */
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
