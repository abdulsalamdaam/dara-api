import { pgTable, text, serial, timestamp, integer, boolean, pgEnum, uniqueIndex, jsonb, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { ownersTable } from "./owners";
import { deedsTable } from "./deeds";
import { lookupsTable } from "./lookups";

// Property `type` is plain text, driven by the central `lookups` table
// (category "property_type") so the option list is editable and supports
// an "Other" free-text value — see migration 0016.
export const propertyStatusEnum = pgEnum("property_status", ["active", "inactive", "maintenance"]);

export const propertiesTable = pgTable("properties", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // type / city / usageType / region dropped (0024) — now FK-only via the
  // *_lookup_id columns below.
  status: propertyStatusEnum("status").notNull().default("active"),
  district: text("district"),
  street: text("street"),
  // Legacy free-text deed number kept for backwards-compat with rows created
  // before the deeds table existed; new flows write via deedId and a join.
  deedNumber: text("deed_number"),
  // FK to the deed that legally backs this property. Enforced 1:1 via
  // uniqueIndex below — a deed can be linked to at most one property.
  deedId: integer("deed_id").references(() => deedsTable.id, { onDelete: "set null" }),
  totalUnits: integer("total_units").notNull().default(0),
  floors: integer("floors"),
  elevators: integer("elevators"),
  parkings: integer("parkings"),
  yearBuilt: integer("year_built"),
  buildingType: text("building_type"),
  postalCode: text("postal_code"),
  buildingNumber: text("building_number"),
  additionalNumber: text("additional_number"),
  ownerId: integer("owner_id").references(() => ownersTable.id, { onDelete: "set null" }),
  amenitiesData: text("amenities_data"),
  notes: text("notes"),
  // MinIO object key for the property photo (legacy single image).
  imageKey: text("image_key"),
  // JSON array of MinIO object keys — the property photo gallery.
  images: jsonb("images"),
  isDraft: boolean("is_draft").notNull().default(false),
  isDemo: boolean("is_demo").notNull().default(false),
  // Provenance for Ejar (NHC) imports — the Ejar property UUID lets a re-import
  // reuse the same local property instead of duplicating it.
  ejarId: text("ejar_id"),
  ejarSource: text("ejar_source"),
  /** Verbatim GetProperties attributes — see contracts.ejarRaw. */
  ejarRaw: jsonb("ejar_raw").$type<Record<string, unknown>>(),
  // Management / commission fee % charged by the managing account (broker /
  // office) to the property's landlord. When > 0, issuing a rent invoice for a
  // tenant also generates a commission invoice (فاتورة عمولة) for the landlord.
  managementFeePercent: numeric("management_fee_percent", { precision: 5, scale: 2 }),
  // Lookups-FK refactor (phase 3) — populated from the text columns
  // above; the text columns remain the source of truth until phase 6.
  typeLookupId: integer("type_lookup_id").references(() => lookupsTable.id, { onDelete: "set null" }),
  // Free-text "Other" property type — stored on the row itself (NOT added to
  // the shared lookups table, so it never appears for other users). Used only
  // when the chosen type doesn't match an existing lookup option.
  typeOther: text("type_other"),
  usageLookupId: integer("usage_lookup_id").references(() => lookupsTable.id, { onDelete: "set null" }),
  regionLookupId: integer("region_lookup_id").references(() => lookupsTable.id, { onDelete: "set null" }),
  cityLookupId: integer("city_lookup_id").references(() => lookupsTable.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // 1:1 enforcement: a single deed cannot back two properties.
  uniqDeedId: uniqueIndex("properties_deed_id_uniq").on(t.deedId),
}));

export const insertPropertySchema = createInsertSchema(propertiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProperty = z.infer<typeof insertPropertySchema>;
export type Property = typeof propertiesTable.$inferSelect;
