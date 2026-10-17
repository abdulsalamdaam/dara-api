import { pgTable, text, serial, timestamp, integer, numeric, date, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { paymentsTable } from "./payments";
import { usersTable } from "./users";

/**
 * Payment collections — a single collection event against a payment
 * (installment). An installment can be collected in several steps: each
 * partial (or full) amount handed over is one row here. The parent
 * payment's status becomes `partially_paid` while collections sum to less
 * than its amount, and `paid` once they cover it in full.
 */
export const paymentCollectionsTable = pgTable("payment_collections", {
  id: serial("id").primaryKey(),
  // Null for collections against installment-less invoices (commission / free
  // invoices) — those reconcile by invoiceId instead.
  paymentId: integer("payment_id").references(() => paymentsTable.id, { onDelete: "cascade" }),
  // Landlord that owns the payment — kept for tenant-scoped queries.
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  collectedDate: date("collected_date").notNull(),
  // bank_transfer | cash | cheque | other
  method: text("method"),
  receiptNumber: text("receipt_number"),
  // MinIO object key for the evidence document attached to this collection.
  attachmentKey: text("attachment_key"),
  // The simple-invoice this collection was recorded for (when collected via
  // an invoice) — lets the Collections tab link back to the invoice.
  invoiceId: integer("invoice_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byPayment: index("payment_collections_payment_idx").on(t.paymentId),
  // Built on boot by src/database/indexes.ts.
  byInvoice: index("payment_collections_invoice_idx").on(t.invoiceId),
  byUserDate: index("payment_collections_user_date_idx").on(t.userId, t.collectedDate),
}));

export const insertPaymentCollectionSchema = createInsertSchema(paymentCollectionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPaymentCollection = z.infer<typeof insertPaymentCollectionSchema>;
export type PaymentCollection = typeof paymentCollectionsTable.$inferSelect;
