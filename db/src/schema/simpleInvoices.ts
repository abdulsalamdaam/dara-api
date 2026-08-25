import { pgTable, serial, integer, text, numeric, date, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";

/**
 * Plain (non-ZATCA) business documents: invoices + credit/debit notes. A
 * document is created as a `draft` and `confirmed` later; confirming an
 * invoice linked to an installment records the collection (so it flows into
 * Payments / Collections) and stamps a receipt-voucher number. Receipt
 * vouchers are simply confirmed invoices (no separate table).
 */
export const simpleInvoiceTypeEnum = pgEnum("simple_invoice_type", ["invoice", "credit", "debit"]);
export const simpleInvoiceStatusEnum = pgEnum("simple_invoice_status", ["draft", "confirmed", "cancelled"]);

export const simpleInvoicesTable = pgTable("simple_invoices", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  number: text("number").notNull(),
  type: simpleInvoiceTypeEnum("type").notNull().default("invoice"),
  status: simpleInvoiceStatusEnum("status").notNull().default("draft"),
  // Sub-kind of an invoice document. Normal rent invoices are null; a
  // "commission" invoice (فاتورة عمولة) bills the property's landlord for the
  // managing account's management fee. Seller = the account, buyer = landlord.
  kind: text("kind"),
  // Optional links to the rest of the domain.
  contractId: integer("contract_id"),
  paymentId: integer("payment_id"),
  // When an invoice covers several same-day installments, all their ids.
  paymentIds: jsonb("payment_ids").$type<number[]>(),
  tenantId: integer("tenant_id"),
  tenantName: text("tenant_name"),
  // Extra client contact details captured on the document itself.
  client: jsonb("client").$type<{ phone?: string; email?: string; address?: string; vatNumber?: string } | null>(),
  // Line items: [{ description, quantity, unitPrice, amount }].
  items: jsonb("items").$type<Array<{ description: string; quantity: number; unitPrice: number; amount: number; vat?: boolean }>>(),
  subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull().default("0"),
  total: numeric("total", { precision: 14, scale: 2 }).notNull().default("0"),
  issueDate: date("issue_date"),
  dueDate: date("due_date"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  paidDate: date("paid_date"),
  // Payment method captured at the collection step (bank_transfer/cash/…).
  paymentMethod: text("payment_method"),
  // Collection evidence (receipt/photo) attached when the invoice is confirmed.
  attachmentKey: text("attachment_key"),
  // Rendered PDF of the document (MinIO key) — generated on first download so
  // the file is cached/persisted rather than regenerated every time.
  pdfKey: text("pdf_key"),
  // ZATCA e-invoicing outcome for this document, set on approval:
  //   cleared   — standard (B2B) invoice accepted by ZATCA clearance
  //   reported  — simplified (B2C) invoice reported to ZATCA
  //   skipped   — not required (exempt / out-of-scope supply, e.g. residential rent)
  //   failed    — submission attempted but ZATCA rejected it (see zatcaError)
  //   null      — not applicable / never attempted
  zatcaStatus: text("zatca_status"),
  zatcaError: text("zatca_error"),
  // The QR ZATCA's signing produced for THIS document (base64 TLV, tags 1-9:
  // the Phase-1 five plus the invoice hash, the ECDSA signature, the public key
  // and — for a cleared standard invoice — ZATCA's stamp).
  //
  // Kept here rather than joined from `invoices` because nothing links the two
  // tables, so the document had no way to reach its own QR and printed a
  // locally-built Phase-1 one instead: five fields, no signature, nothing a
  // verifier can check. Null until the document is actually submitted; the
  // Phase-1 fallback still covers drafts and exempt supplies.
  zatcaQr: text("zatca_qr"),
  // Receipt-voucher number, stamped when an invoice is confirmed.
  receiptNumber: text("receipt_number"),
  // For credit/debit notes — the original invoice number being adjusted.
  billingReference: text("billing_reference"),
  notes: text("notes"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type SimpleInvoice = typeof simpleInvoicesTable.$inferSelect;
