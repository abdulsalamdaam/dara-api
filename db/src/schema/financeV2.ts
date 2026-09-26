import {
  pgTable, serial, bigserial, integer, bigint, smallint, text, boolean, date, timestamp, numeric, jsonb, char,
  primaryKey,
} from "drizzle-orm/pg-core";

/**
 * Finance v2 (beta) tables. The SQL source of truth is
 * `db/drizzle/0066_finance_v2.sql` (constraints, triggers, indexes); these are
 * the Drizzle views of the same tables, for typed queries in
 * `src/modules/finance-v2`.
 *
 * DELIBERATELY NOT exported from the barrel `./index.ts` (DESIGN §1.4 point 5):
 * the flag-off guarantee includes "no pre-existing schema file changes", and
 * nothing here is ever pushed with drizzle-kit. Import this file directly.
 *
 * Money columns are numeric(14,2), which Drizzle returns as strings; the
 * engine converts them to integer halalas, never to floats.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const financeSettingsTable = pgTable("finance_settings", {
  accountUserId: integer("account_user_id").primaryKey(),
  financeV2Enabled: boolean("finance_v2_enabled").notNull().default(false),
  accountingMode: text("accounting_mode").$type<"owner" | "manager" | null>(),
  fiscalYearStartMonth: smallint("fiscal_year_start_month").notNull().default(1),
  vatFilingFrequency: text("vat_filing_frequency").$type<"monthly" | "quarterly">().notNull().default("quarterly"),
  defaultBankAccountId: integer("default_bank_account_id"),
  defaultCashAccountId: integer("default_cash_account_id"),
  agencyCollectionsToTrust: boolean("agency_collections_to_trust").notNull().default(false),
  commissionBasis: text("commission_basis").$type<"billed" | "collected">().notNull().default("billed"),
  depositForfeitVat: text("deposit_forfeit_vat").$type<"O" | "S" | "E">().notNull().default("O"),
  ledgerGoLiveDate: date("ledger_go_live_date"),
  ledgerStartedAt: ts("ledger_started_at"),
  deferRentStraightLine: boolean("defer_rent_straight_line").notNull().default(true),
  inputVatMethod: text("input_vat_method").$type<"direct_plus_ratio" | "direct_only">().notNull().default("direct_plus_ratio"),
  enabledAt: ts("enabled_at"),
  enabledBy: integer("enabled_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const financeSettingsEventsTable = pgTable("finance_settings_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  accountUserId: integer("account_user_id").notNull(),
  actorUserId: integer("actor_user_id").notNull(),
  field: text("field").notNull(),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  reason: text("reason").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const accountsTable = pgTable("accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  code: text("code").notNull(),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en").notNull(),
  type: text("type").$type<"asset" | "liability" | "equity" | "revenue" | "expense">().notNull(),
  normalBalance: text("normal_balance").$type<"debit" | "credit">().notNull(),
  parentId: integer("parent_id"),
  systemKey: text("system_key"),
  isGroup: boolean("is_group").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  isTemplate: boolean("is_template").notNull().default(false),
  bankAccountId: integer("bank_account_id"),
  description: text("description"),
  createdBy: integer("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const fiscalPeriodsTable = pgTable("fiscal_periods", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  fiscalYear: integer("fiscal_year").notNull(),
  periodNo: smallint("period_no").notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  status: text("status").$type<"open" | "closed" | "locked">().notNull().default("open"),
  vatLockedAt: ts("vat_locked_at"),
  closedAt: ts("closed_at"),
  closedBy: integer("closed_by"),
  reopenedAt: ts("reopened_at"),
  reopenedBy: integer("reopened_by"),
  reopenReason: text("reopen_reason"),
});

export type JournalOrigin = "auto" | "backfill" | "manual" | "opening" | "closing" | "reversal";

export const journalEntriesTable = pgTable("journal_entries", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: integer("user_id").notNull(),
  entryNo: text("entry_no").notNull(),
  entryDate: date("entry_date").notNull(),
  originalDate: date("original_date").notNull(),
  periodId: integer("period_id").notNull(),
  isLate: boolean("is_late").notNull().default(false),
  origin: text("origin").$type<JournalOrigin>().notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: bigint("source_id", { mode: "number" }).notNull(),
  event: text("event").notNull(),
  memo: text("memo"),
  status: text("status").$type<"posted" | "reversed">().notNull().default("posted"),
  reversalOf: bigint("reversal_of", { mode: "number" }),
  reversedBy: bigint("reversed_by", { mode: "number" }),
  reversedAt: ts("reversed_at"),
  total: numeric("total", { precision: 14, scale: 2 }).notNull(),
  payload: jsonb("payload").notNull().default({}),
  warnings: text("warnings").array().notNull().default([]),
  createdBy: integer("created_by"),
  postedAt: ts("posted_at").notNull().defaultNow(),
});

export const journalLinesTable = pgTable("journal_lines", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  entryId: bigint("entry_id", { mode: "number" }).notNull(),
  userId: integer("user_id").notNull(),
  lineNo: smallint("line_no").notNull(),
  entryDate: date("entry_date").notNull(),
  accountId: integer("account_id").notNull(),
  debit: numeric("debit", { precision: 14, scale: 2 }).notNull().default("0"),
  credit: numeric("credit", { precision: 14, scale: 2 }).notNull().default("0"),
  memo: text("memo"),
  ownerId: integer("owner_id"),
  propertyId: integer("property_id"),
  unitId: integer("unit_id"),
  tenantId: integer("tenant_id"),
  contractId: integer("contract_id"),
  paymentId: integer("payment_id"),
  documentId: integer("document_id"),
  bankAccountId: integer("bank_account_id"),
  vatCategory: char("vat_category", { length: 1 }).$type<"S" | "Z" | "E" | "O" | null>(),
  vatRate: numeric("vat_rate", { precision: 5, scale: 2 }),
  vatBase: numeric("vat_base", { precision: 14, scale: 2 }),
  taxRole: text("tax_role").$type<"output" | "input" | "input_nonrecoverable" | null>(),
  sellerKey: text("seller_key"),
  docClass: text("doc_class"),
});

export const ledgerOutboxTable = pgTable("ledger_outbox", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: integer("user_id").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: bigint("source_id", { mode: "number" }).notNull(),
  event: text("event").notNull(),
  occurredOn: date("occurred_on").notNull(),
  origin: text("origin").$type<"live" | "backfill" | "recognizer" | "repair">().notNull().default("live"),
  payload: jsonb("payload").notNull(),
  status: text("status").$type<"pending" | "posted" | "skipped" | "failed" | "dismissed">().notNull().default("pending"),
  attempts: smallint("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  lastError: text("last_error"),
  lastErrorCode: text("last_error_code"),
  skipReason: text("skip_reason"),
  entryId: bigint("entry_id", { mode: "number" }),
  backfillRunId: integer("backfill_run_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  processedAt: ts("processed_at"),
  dismissedBy: integer("dismissed_by"),
  dismissedReason: text("dismissed_reason"),
});

export const bankAccountsTable = pgTable("bank_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  kind: text("kind").$type<"bank" | "cash">().notNull(),
  nameAr: text("name_ar").notNull(),
  nameEn: text("name_en"),
  bankName: text("bank_name"),
  iban: text("iban"),
  accountNumber: text("account_number"),
  currency: char("currency", { length: 3 }).notNull().default("SAR"),
  isTrust: boolean("is_trust").notNull().default(false),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  glAccountId: integer("gl_account_id").notNull(),
  openingBalance: numeric("opening_balance", { precision: 14, scale: 2 }),
  createdBy: integer("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const financeCollectionMetaTable = pgTable("finance_collection_meta", {
  collectionId: integer("collection_id").primaryKey(),
  userId: integer("user_id").notNull(),
  bankAccountId: integer("bank_account_id"),
  methodDetail: text("method_detail"),
  settledByDeduction: boolean("settled_by_deduction").notNull().default(false),
  classification: text("classification").$type<"deposit_offset" | "deposit_conversion" | "commission_cash" | null>(),
  dateDefaultedUtc: boolean("date_defaulted_utc").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const financeExpenseDetailsTable = pgTable("finance_expense_details", {
  expenseId: integer("expense_id").primaryKey(),
  userId: integer("user_id").notNull(),
  revision: integer("revision").notNull().default(1),
  expenseOn: date("expense_on"),
  grossAmount: numeric("gross_amount", { precision: 14, scale: 2 }).notNull(),
  netAmount: numeric("net_amount", { precision: 14, scale: 2 }).notNull(),
  vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  vatAmount: numeric("vat_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  vatCategory: char("vat_category", { length: 1 }).notNull().default("S"),
  vatRecoverable: boolean("vat_recoverable").notNull().default(false),
  supplierName: text("supplier_name"),
  supplierVatNumber: text("supplier_vat_number"),
  supplierInvoiceNo: text("supplier_invoice_no"),
  supplierInvoiceDate: date("supplier_invoice_date"),
  attachmentKey: text("attachment_key"),
  bankAccountId: integer("bank_account_id"),
  chargeTo: text("charge_to").$type<"company" | "landlord">().notNull().default("company"),
  glAccountId: integer("gl_account_id"),
  updatedBy: integer("updated_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const financeExpenseCategoryMapTable = pgTable("finance_expense_category_map", {
  userId: integer("user_id").notNull(),
  category: text("category").notNull(),
  accountId: integer("account_id").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.userId, t.category] }) }));

export const financePayoutMetaTable = pgTable("finance_payout_meta", {
  payoutId: integer("payout_id").primaryKey(),
  userId: integer("user_id").notNull(),
  paidOn: date("paid_on"),
  bankAccountId: integer("bank_account_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const financeDepositRefundsTable = pgTable("finance_deposit_refunds", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  contractId: integer("contract_id").notNull(),
  tenantId: integer("tenant_id"),
  ownerId: integer("owner_id"),
  voucherIds: integer("voucher_ids").array().notNull().default([]),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  refundedOn: date("refunded_on").notNull(),
  bankAccountId: integer("bank_account_id"),
  method: text("method"),
  reference: text("reference"),
  number: text("number").notNull(),
  createdBy: integer("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const financeInstallmentChargesTable = pgTable("finance_installment_charges", {
  paymentId: integer("payment_id").notNull(),
  generation: smallint("generation").notNull().default(1),
  userId: integer("user_id").notNull(),
  chargedOn: date("charged_on").notNull(),
  chargedBy: text("charged_by").$type<"due" | "document" | "settled_external">().notNull(),
  documentId: integer("document_id"),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  vatAmount: numeric("vat_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  entryId: bigint("entry_id", { mode: "number" }),
  reversedAt: ts("reversed_at"),
  reversedReason: text("reversed_reason"),
}, (t) => ({ pk: primaryKey({ columns: [t.paymentId, t.generation] }) }));

export const financeInstallmentVatPointsTable = pgTable("finance_installment_vat_points", {
  collectionId: integer("collection_id").primaryKey(),
  paymentId: integer("payment_id").notNull(),
  userId: integer("user_id").notNull(),
  vatBooked: numeric("vat_booked", { precision: 14, scale: 2 }).notNull(),
  bookedOn: date("booked_on").notNull(),
  entryId: bigint("entry_id", { mode: "number" }),
});

export const tenantCreditActionsTable = pgTable("tenant_credit_actions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tenantId: integer("tenant_id").notNull(),
  contractId: integer("contract_id"),
  ownerId: integer("owner_id"),
  kind: text("kind").$type<"refund" | "apply">().notNull(),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  actionOn: date("action_on").notNull(),
  targetDocumentId: integer("target_document_id"),
  sourceDocumentId: integer("source_document_id"),
  bankAccountId: integer("bank_account_id"),
  method: text("method"),
  reference: text("reference"),
  number: text("number"),
  status: text("status").$type<"posted" | "void">().notNull().default("posted"),
  createdBy: integer("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const financeWriteOffsTable = pgTable("finance_write_offs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tenantId: integer("tenant_id"),
  contractId: integer("contract_id"),
  ownerId: integer("owner_id"),
  paymentIds: integer("payment_ids").array().notNull().default([]),
  documentIds: integer("document_ids").array().notNull().default([]),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  writtenOffOn: date("written_off_on").notNull(),
  reason: text("reason").notNull(),
  createdBy: integer("created_by").notNull(),
  approvedBy: integer("approved_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const financeEjarSettlementsTable = pgTable("finance_ejar_settlements", {
  paymentId: integer("payment_id").primaryKey(),
  userId: integer("user_id").notNull(),
  reportedStatus: text("reported_status").notNull(),
  reportedAmount: numeric("reported_amount", { precision: 14, scale: 2 }),
  importedAt: ts("imported_at").notNull().defaultNow(),
});

export const manualJournalsTable = pgTable("manual_journals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  kind: text("kind").$type<"manual" | "opening">().notNull().default("manual"),
  status: text("status").$type<"draft" | "submitted" | "approved" | "rejected" | "posted" | "void">().notNull().default("draft"),
  entryDate: date("entry_date").notNull(),
  memo: text("memo").notNull(),
  attachmentKey: text("attachment_key"),
  lines: jsonb("lines").notNull(),
  createdBy: integer("created_by").notNull(),
  submittedAt: ts("submitted_at"),
  approvedBy: integer("approved_by"),
  approvedAt: ts("approved_at"),
  rejectedBy: integer("rejected_by"),
  rejectedReason: text("rejected_reason"),
  postedEntryId: bigint("posted_entry_id", { mode: "number" }),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const financeBackfillRunsTable = pgTable("finance_backfill_runs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  actorUserId: integer("actor_user_id").notNull(),
  mode: text("mode").$type<"full" | "cutover" | "catchup">().notNull(),
  dryRun: boolean("dry_run").notNull(),
  cutoverDate: date("cutover_date"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  status: text("status").$type<"running" | "done" | "failed">().notNull().default("running"),
  summary: jsonb("summary"),
});

export const financeContractDimsTable = pgTable("finance_contract_dims", {
  contractId: integer("contract_id").primaryKey(),
  userId: integer("user_id").notNull(),
  ownerId: integer("owner_id"),
  propertyId: integer("property_id"),
  unitIds: integer("unit_ids").array().notNull().default([]),
  endedOn: date("ended_on"),
  capturedAt: ts("captured_at").notNull().defaultNow(),
});

export const financeVatReturnDraftsTable = pgTable("finance_vat_return_drafts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  sellerKey: text("seller_key").notNull(),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  box14: numeric("box14", { precision: 14, scale: 2 }).notNull().default("0"),
  box15: numeric("box15", { precision: 14, scale: 2 }).notNull().default("0"),
  lockedAt: ts("locked_at"),
  lockedBy: integer("locked_by"),
});

export type FinanceSettings = typeof financeSettingsTable.$inferSelect;
export type Account = typeof accountsTable.$inferSelect;
export type FiscalPeriod = typeof fiscalPeriodsTable.$inferSelect;
export type JournalEntry = typeof journalEntriesTable.$inferSelect;
export type JournalLine = typeof journalLinesTable.$inferSelect;
export type BankAccount = typeof bankAccountsTable.$inferSelect;
