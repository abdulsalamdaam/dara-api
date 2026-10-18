import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const loginLogsTable = pgTable("login_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  /** Phone logins that are not a `users` row: a tenant, or an owner-kind landlord login. */
  tenantId: integer("tenant_id"),
  ownerId: integer("owner_id"),
  email: text("email").notNull(),
  status: text("status").notNull(),
  ip: text("ip"),
  device: text("device"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type LoginLog = typeof loginLogsTable.$inferSelect;
