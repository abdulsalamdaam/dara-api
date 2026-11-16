import { pgTable, serial, integer, text, numeric, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { rolesTable } from "./roles";

/**
 * Linked accounts (0096_linked_accounts.sql). See src/common/linked-accounts.ts
 * for the access rules and src/modules/linked-accounts for the endpoints.
 *
 * Members are the `users` rows (account holders) whose `account_group_id`
 * points here. The primary is a member too.
 */
export type GroupBillingMode = "separate" | "shared";

export const accountGroupsTable = pgTable("account_groups", {
  id: serial("id").primaryKey(),
  primaryUserId: integer("primary_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name"),
  billingMode: text("billing_mode").$type<GroupBillingMode>().notNull().default("separate"),
  /** Shared mode: SAR before VAT per extra account per year. NULL = default (half the plan's yearly price). */
  extraAccountPriceYearly: numeric("extra_account_price_yearly", { precision: 12, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  primaryUniq: uniqueIndex("account_groups_primary_uniq").on(t.primaryUserId),
}));

/** An employee of one member account allowed into another member account, with the role they hold there. */
export const accountAccessTable = pgTable("account_access", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().references(() => accountGroupsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  accountId: integer("account_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  roleId: integer("role_id").notNull().references(() => rolesTable.id),
  grantedBy: integer("granted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  userAccountUniq: uniqueIndex("account_access_user_account_uniq").on(t.userId, t.accountId),
  byAccount: index("account_access_account_idx").on(t.accountId),
}));

export type AccountGroup = typeof accountGroupsTable.$inferSelect;
export type AccountAccess = typeof accountAccessTable.$inferSelect;
