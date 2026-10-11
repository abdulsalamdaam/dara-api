import { pgTable, serial, integer, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Saved Ejar lookups (Ejar Import v2). One row per (account, contract number)
 * holding the raw bodies of the two calls a lookup makes — Invoices and
 * Details — so the import, and any repeat lookup within
 * EJAR_LOOKUP_CACHE_HOURS, is served from here without calling Ejar.
 *
 * Created at boot by db/drizzle/0077_ejar_lookups.sql.
 */
export const ejarLookupsTable = pgTable("ejar_lookups", {
  id: serial("id").primaryKey(),
  /** The scope owner (scopeId), not the employee who looked it up. */
  accountId: integer("account_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  contractNumber: text("contract_number").notNull(),
  ejarUuid: text("ejar_uuid").notNull(),
  invoicesBody: jsonb("invoices_body").$type<Record<string, unknown>>(),
  detailsBody: jsonb("details_body").$type<Record<string, unknown>>(),
  lookedUpBy: integer("looked_up_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqAccountContract: uniqueIndex("ejar_lookups_account_contract_uniq").on(t.accountId, t.contractNumber),
}));

export type EjarLookupRow = typeof ejarLookupsTable.$inferSelect;
