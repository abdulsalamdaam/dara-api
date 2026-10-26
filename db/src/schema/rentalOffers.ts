import { pgTable, serial, integer, text, jsonb, timestamp, numeric, boolean, date, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { unitsTable } from "./units";
import { propertiesTable } from "./properties";

/** What was offered, frozen at save time — the printed offer reads this, not the live unit. */
export type RentalOfferUnitSnapshot = {
  propertyName?: string | null;
  unitNumber?: string | null;
  unitType?: string | null;
  area?: string | null;
  floor?: number | null;
  city?: string | null;
  district?: string | null;
  street?: string | null;
  usage?: string | null;
  /** property_usage lookup key the VAT rule was resolved from. */
  usageKey?: string | null;
  deedNumber?: string | null;
  description?: string | null;
};

/** `amount` is per occurrence for one_time, and an ANNUAL figure split across the cycle otherwise (as contract fees). */
export type RentalOfferFee = {
  typeKey?: string | null;
  label: string;
  amount: number;
  recurrence: "one_time" | "quarterly" | "semi_annual" | "annual";
  vat: boolean;
};

/**
 * Rental offers (عروض التأجير): a formal, non-binding offer to a prospective
 * tenant for one unit. Precedes the Ejar contract; nothing else reads it.
 * `expired` is not a stored status — it is derived from `valid_until` at read
 * time, like overdue installments.
 *
 * Created at boot by db/drizzle/0086_rental_offers.sql.
 */
export const rentalOffersTable = pgTable("rental_offers", {
  id: serial("id").primaryKey(),
  /** The scope owner (scopeId), not the employee who wrote it. */
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  createdBy: integer("created_by"),
  number: text("number").notNull(),
  status: text("status").notNull().default("draft"),
  title: text("title"),
  issueDate: date("issue_date").notNull().defaultNow(),
  validUntil: date("valid_until"),
  unitId: integer("unit_id").references(() => unitsTable.id, { onDelete: "set null" }),
  propertyId: integer("property_id").references(() => propertiesTable.id, { onDelete: "set null" }),
  unitSnapshot: jsonb("unit_snapshot").$type<RentalOfferUnitSnapshot>().notNull().default({}),
  landlordName: text("landlord_name"),
  clientName: text("client_name").notNull(),
  clientCr: text("client_cr"),
  clientVat: text("client_vat"),
  clientContactName: text("client_contact_name"),
  clientContactTitle: text("client_contact_title"),
  clientPhone: text("client_phone"),
  clientEmail: text("client_email"),
  clientAddress: text("client_address"),
  annualRent: numeric("annual_rent", { precision: 14, scale: 2 }).notNull().default("0"),
  durationMonths: integer("duration_months").notNull().default(12),
  startDate: date("start_date"),
  paymentFrequency: text("payment_frequency").notNull().default("quarterly"),
  vatApplies: boolean("vat_applies").notNull().default(false),
  /** `percent` uses escalationPercent, `amount` adds escalationAmount SAR per contract year (0087). */
  escalationType: text("escalation_type").notNull().default("percent"),
  escalationPercent: numeric("escalation_percent", { precision: 6, scale: 2 }).notNull().default("0"),
  escalationAmount: numeric("escalation_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  /** Grace period (0–36): added on top of durationMonths — rent starts this many months after the lease start and the full duration is billed (0089). */
  freeMonths: integer("free_months").notNull().default(0),
  depositAmount: numeric("deposit_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  commissionType: text("commission_type").notNull().default("none"),
  commissionValue: numeric("commission_value", { precision: 14, scale: 2 }).notNull().default("0"),
  commissionVat: boolean("commission_vat").notNull().default(true),
  fees: jsonb("fees").$type<RentalOfferFee[]>().notNull().default([]),
  terms: jsonb("terms").$type<string[]>().notNull().default([]),
  notes: text("notes"),
  language: text("language").notNull().default("ar"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  uniqUserNumber: uniqueIndex("rental_offers_user_number_uniq").on(t.userId, t.number),
}));

export type RentalOffer = typeof rentalOffersTable.$inferSelect;
