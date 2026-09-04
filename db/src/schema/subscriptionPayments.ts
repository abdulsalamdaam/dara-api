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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
