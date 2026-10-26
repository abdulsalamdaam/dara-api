import { pgTable, serial, integer, text, numeric, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { subscriptionPaymentsTable } from "./subscriptionPayments";

/**
 * Account limits (Oct 2026) — created at boot by db/drizzle/0088_account_limits.sql.
 * The effective limit of a key is computed in src/common/limits.ts:
 * override replaces the package base, active add-ons are added on top.
 */

/**
 * An admin's replacement for the package base of one limit. `value` NULL =
 * unlimited. The per-account Ejar switch is the row `limit_key = 'ejar.enabled'`
 * (1 enabled / 0 disabled; no row = server default). Survives renewals and
 * package changes.
 */
export const accountLimitOverridesTable = pgTable("account_limit_overrides", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  limitKey: text("limit_key").notNull(),
  value: integer("value"),
  note: text("note").notNull(),
  setBy: integer("set_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  accountKey: uniqueIndex("account_limit_overrides_account_key_uniq").on(t.accountId, t.limitKey),
}));

export type AddonStatus = "offered" | "pending_payment" | "active" | "cancelled" | "expired";
export type AddonActivation = "on_payment" | "immediate";
export type AddonSource = "admin_free" | "admin_invoice" | "admin_offer" | "self_serve";
export type AddonPeriod = "subscription_period" | "one_off";

/**
 * Quantity added on top of base/override. Counts only while active:
 * `status = 'active' AND starts_at <= now AND (ends_at IS NULL OR ends_at > now)`,
 * evaluated at read time.
 */
export const accountLimitAddonsTable = pgTable("account_limit_addons", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  limitKey: text("limit_key").notNull(),
  quantity: integer("quantity").notNull(),
  catalogKey: text("catalog_key"),
  period: text("period").$type<AddonPeriod>().notNull().default("subscription_period"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  status: text("status").$type<AddonStatus>().notNull().default("pending_payment"),
  activation: text("activation").$type<AddonActivation>().notNull().default("on_payment"),
  source: text("source").$type<AddonSource>().notNull(),
  /** Before VAT. */
  priceSar: numeric("price_sar", { precision: 12, scale: 2 }),
  paymentId: integer("payment_id").references(() => subscriptionPaymentsTable.id, { onDelete: "set null" }),
  grantedBy: integer("granted_by"),
  note: text("note"),
  offerExpiresAt: timestamp("offer_expires_at", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  accountKeyStatus: index("account_limit_addons_account_key_status_idx").on(t.accountId, t.limitKey, t.status),
}));

export type LimitEventSource =
  | "admin_override" | "addon_purchase" | "addon_grant" | "addon_offer"
  | "addon_cancel" | "addon_expiry" | "ejar_toggle" | "offer_auto";

/** Audit trail: one row per change, with the EFFECTIVE value before and after. */
export const accountLimitEventsTable = pgTable("account_limit_events", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  actorUserId: integer("actor_user_id"),
  actorKind: text("actor_kind").$type<"admin" | "customer" | "system">().notNull(),
  source: text("source").$type<LimitEventSource>().notNull(),
  limitKey: text("limit_key").notNull(),
  oldValue: integer("old_value"),
  newValue: integer("new_value"),
  addonId: integer("addon_id"),
  paymentId: integer("payment_id"),
  note: text("note"),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  accountCreated: index("account_limit_events_account_created_idx").on(t.accountId, sql`${t.createdAt} desc`),
}));

export type AccountLimitOverride = typeof accountLimitOverridesTable.$inferSelect;
export type AccountLimitAddon = typeof accountLimitAddonsTable.$inferSelect;
export type AccountLimitEvent = typeof accountLimitEventsTable.$inferSelect;
