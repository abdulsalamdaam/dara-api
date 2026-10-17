import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

/**
 * audit_logs — a lightweight record of update/delete actions, so an owner
 * can see what their employees changed. Written by a global interceptor
 * after any successful PATCH/PUT/DELETE request.
 */
export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  /** Account scope — the owner whose data was touched. */
  ownerUserId: integer("owner_user_id").notNull(),
  /** The user who performed the action. */
  actorUserId: integer("actor_user_id").notNull(),
  action: text("action").notNull(),       // "update" | "delete"
  entity: text("entity").notNull(),         // "properties", "units", "contracts", …
  entityId: text("entity_id"),
  method: text("method").notNull(),
  path: text("path").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Built on boot by src/database/indexes.ts (CONCURRENTLY), which also drops
  // the single-column audit_logs_owner_idx this replaces.
  ownerCreatedIdx: index("audit_logs_owner_created_idx").on(t.ownerUserId, t.createdAt.desc(), t.id.desc()),
}));

export type AuditLog = typeof auditLogsTable.$inferSelect;
