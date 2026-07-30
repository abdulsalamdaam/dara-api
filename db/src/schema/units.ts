import { pgTable, text, serial, timestamp, integer, numeric, boolean, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { propertiesTable } from "./properties";
import { lookupsTable } from "./lookups";

// Unit `type` is plain text, driven by the central `lookups` table
// (category "unit_type") so the option list is editable and supports an
// "Other" free-text value — see migration 0016.
export const unitStatusEnum = pgEnum("unit_status", ["available", "rented", "maintenance", "reserved"]);

export const unitsTable = pgTable("units", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => propertiesTable.id, { onDelete: "cascade" }),
  unitNumber: text("unit_number").notNull(),
  // type / unitDirection / finishing dropped (0024) — FK-only via *_lookup_id.
  status: unitStatusEnum("status").notNull().default("available"),
  floor: integer("floor"),
  area: numeric("area", { precision: 10, scale: 2 }),
  bedrooms: integer("bedrooms"),
  bathrooms: integer("bathrooms"),
  livingRooms: integer("living_rooms"),
  halls: integer("halls"),
  parkingSpaces: integer("parking_spaces"),
  rentPrice: numeric("rent_price", { precision: 12, scale: 2 }),
  electricityMeter: text("electricity_meter"),
  waterMeter: text("water_meter"),
  gasMeter: text("gas_meter"),
  acUnits: integer("ac_units"),
  acType: text("ac_type"),
  parkingType: text("parking_type"),
  furnishing: text("furnishing"),
  kitchenType: text("kitchen_type"),
  fiber: text("fiber"),
  amenities: text("amenities"),
  // JSON string { counts: { <facilityKey>: number } } holding the full
  // facility-count breakdown — including each AC type (central/split/desert/
  // window) and rooms with no dedicated column (maid's room, kitchen, storage,
  // backyard, elevator). Mirrors properties.amenities_data so the unit add/edit
  // forms persist every selected facility without collapsing them into the
  // single ac_units total. See migration 0057.
  amenitiesData: text("amenities_data"),
  /* extra detail fields */
  yearBuilt: text("year_built"),
  facadeLength: numeric("facade_length", { precision: 10, scale: 2 }),
  unitLength: numeric("unit_length", { precision: 10, scale: 2 }),
  unitWidth: numeric("unit_width", { precision: 10, scale: 2 }),
  unitHeight: numeric("unit_height", { precision: 10, scale: 2 }),
  hasMezzanine: boolean("has_mezzanine"),
  // Attachments — MinIO object keys uploaded via the FileUpload component
  // and persisted here so the unit detail view can show them again.
  // imageKey + floorPlanKey are single files; documents is a JSON array of
  //   { key, originalName, contentType, size }
  // entries to support multiple uploads.
  imageKey: text("image_key"),
  floorPlanKey: text("floor_plan_key"),
  documents: jsonb("documents"),
  // JSON array of MinIO object keys — the unit photo gallery.
  images: jsonb("images"),
  isDraft: boolean("is_draft").notNull().default(false),
  isDemo: boolean("is_demo").notNull().default(false),
  notes: text("notes"),
  // Lookups-FK refactor (phase 3) — backfilled from the text columns.
  typeLookupId: integer("type_lookup_id").references(() => lookupsTable.id, { onDelete: "set null" }),
  // Free-text "Other" unit type — stored on the row itself (NOT added to the
  // shared lookups table, so it never appears for other users). Used only when
  // the chosen type matches no existing lookup option.
  typeOther: text("type_other"),
  directionLookupId: integer("direction_lookup_id").references(() => lookupsTable.id, { onDelete: "set null" }),
  finishingLookupId: integer("finishing_lookup_id").references(() => lookupsTable.id, { onDelete: "set null" }),
  // Provenance for Ejar (NHC) imports — the Ejar unit UUID lets a re-import
  // reuse the same local unit and lets one unit sit on multiple contracts.
  ejarId: text("ejar_id"),
  ejarSource: text("ejar_source"),
  /** Verbatim GetUnits attributes — see contracts.ejarRaw. */
  ejarRaw: jsonb("ejar_raw").$type<Record<string, unknown>>(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUnitSchema = createInsertSchema(unitsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUnit = z.infer<typeof insertUnitSchema>;
export type Unit = typeof unitsTable.$inferSelect;
