import { pgTable, text, serial, timestamp, integer, boolean, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { ownersTable } from "./owners";

/**
 * Property title deed (الصك). In the data hierarchy:
 *
 *   Deed → Property → Unit → Contract (Owner ↔ Tenant)
 *
 * Each deed represents one legal property title. The FK from properties.deedId
 * is enforced 1:1 via a unique index on properties.deedId (see properties.ts),
 * so a single deed cannot be re-linked to a second property.
 */
export const deedsTable = pgTable("deeds", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),

  deedNumber: text("deed_number").notNull(),
  // Plain text — "electronic" | "paper" | any custom ("Other") value.
  deedType: text("deed_type").notNull().default("electronic"),

  // The attached document — single file. Filename kept separately so the UI
  // can show the original name even when the URL is a content-hash path.
  documentUrl: text("document_url"),
  documentName: text("document_name"),

  ownerId: integer("owner_id").references(() => ownersTable.id, { onDelete: "set null" }),
  // National ID of the deed owner — captured for electronic deeds.
  ownerNationalId: text("owner_national_id"),
  /**
   * The owners named ON THE DEED itself, which is not the same thing as
   * `ownerId` (the landlord the deed is filed under in this account). A deed
   * can name several co-owners, and Ejar returns them as a list on the
   * property/unit. Optional and free-standing: they are a record of what the
   * document says, not links to `owners` rows.
   */
  deedOwners: jsonb("deed_owners").$type<Array<{ name: string; idNumber?: string | null }>>(),
  issueDate: timestamp("issue_date", { withTimezone: true }),
  // Hijri form of the issue date as entered by the user (e.g. "1445-03-15").
  // issueDate above always holds the Gregorian equivalent.
  issueDateHijri: text("issue_date_hijri"),
  // Paper deed (صك عقاري) fields: copy date (تاريخ النسخة) and the real-estate
  // registry number (رقم السجل العقاري).
  copyDate: timestamp("copy_date", { withTimezone: true }),
  registryNumber: text("registry_number"),
  issuingAuthority: text("issuing_authority"),
  notes: text("notes"),

  // Provenance for Ejar (NHC) imports — see contracts.ejarRaw.
  ejarSource: text("ejar_source"),
  ejarRaw: jsonb("ejar_raw").$type<Record<string, unknown>>(),
  isDemo: boolean("is_demo").notNull().default(false),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // Deed numbers must be unique per landlord scope. Two different landlords
  // can each have their own deed numbered "1234".
  uniqDeedNumber: uniqueIndex("deeds_user_deednumber_uniq").on(t.userId, t.deedNumber),
}));

export const insertDeedSchema = createInsertSchema(deedsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDeed = z.infer<typeof insertDeedSchema>;
export type Deed = typeof deedsTable.$inferSelect;
