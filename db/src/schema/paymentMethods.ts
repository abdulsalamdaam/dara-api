import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * A saved Moyasar payment token (migration 0097). Only Moyasar's token id and
 * the fields shown to the user (brand, last 4, expiry) — never card data.
 * `status` mirrors Moyasar's token status (initiated | active | inactive |
 * expired) plus our own `deleted` once the token was removed at Moyasar.
 */
export const paymentMethodsTable = pgTable("payment_methods", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  moyasarTokenId: text("moyasar_token_id").notNull(),
  type: text("type").$type<"card" | "applepay" | "samsungpay">().notNull().default("card"),
  brand: text("brand"),
  last4: text("last4"),
  expMonth: integer("exp_month"),
  expYear: integer("exp_year"),
  name: text("name"),
  status: text("status").notNull().default("initiated"),
  isDefault: boolean("is_default").notNull().default(false),
  live: boolean("live"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  /**
   * 0103: `moyasar` (a Moyasar token) or `dhamen` — then `gateway_ref` is the
   * reference of the first recurring-enabled Dhamen payment, which renewals
   * charge with customer-payment-subsequent, and `moyasar_token_id` holds
   * `dhamen:<ref>` only to keep that column NOT NULL + unique.
   */
  gateway: text("gateway").$type<"moyasar" | "dhamen">().notNull().default("moyasar"),
  gatewayRef: text("gateway_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type PaymentMethod = typeof paymentMethodsTable.$inferSelect;
