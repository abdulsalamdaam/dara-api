import { pgTable, text, serial, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Platform-wide key/value settings — one row per setting, JSON value.
 *
 * Deliberately global (no user/company column): the settings kept here describe
 * the platform's own state, not a customer's. The first two are the manual-add
 * override and the cached Ejar connectivity verdict, both of which apply to the
 * single Ejar connection the backend holds (one whitelisted IP, one credential
 * set), so scoping them per company would be misleading.
 */
export const appSettingsTable = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  value: jsonb("value").$type<Record<string, unknown>>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  uniqKey: uniqueIndex("app_settings_key_uniq").on(t.key),
}));

export type AppSetting = typeof appSettingsTable.$inferSelect;
