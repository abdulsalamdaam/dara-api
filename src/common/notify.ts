/**
 * Notify a tenant: persist an in-app notification row AND deliver a push to
 * their device (Expo). Push is fire-and-forget so it never blocks the caller;
 * the row is always saved. Returns the saved notification.
 */
import { eq } from "drizzle-orm";
import { notificationsTable, tenantsTable } from "@dara/database";
import type { Drizzle } from "../database/database.module";
import { sendExpoPush } from "./push";

export interface NotifyTenantParams {
  /** Landlord (owner) scope id that owns the notification. */
  userId: number;
  tenantId: number;
  title: string;
  body: string;
  type?: string;
  data?: Record<string, unknown>;
}

export async function notifyTenant(db: Drizzle, params: NotifyTenantParams) {
  const { userId, tenantId, title, body, type = "custom", data } = params;
  const [row] = await db.insert(notificationsTable).values({
    userId, tenantId, title, body, type,
  }).returning();

  const [t] = await db.select({ fcmToken: tenantsTable.fcmToken })
    .from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (t?.fcmToken) {
    void sendExpoPush([{
      to: t.fcmToken,
      title,
      body,
      data: { type, notificationId: row?.id, ...(data ?? {}) },
    }]);
  }
  return row;
}
