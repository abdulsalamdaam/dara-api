/**
 * Ejar → local domain vocabulary.
 *
 * Ejar's enum values do not line up with the `lookups` table keys, so an
 * imported record would otherwise land with an empty type/usage dropdown
 * everywhere in the portal. These maps translate the raw Ejar value to the
 * lookup KEY (`resolveLookupId` accepts a key or an Arabic label); anything
 * unmapped falls through to the row's `type_other` free-text column so the
 * original value is never lost.
 *
 * The source values are the ones actually observed in the UAT payloads
 * (see ejar_api_logs) plus the obvious siblings from the Ejar catalogue.
 */

/** contracts.attributes.property_type / properties.property_type → `property_type`. */
export const EJAR_PROPERTY_TYPE: Record<string, string> = {
  building: "apartment_building",
  apartment_building: "apartment_building",
  villa: "villa",
  tower: "tower",
  land: "land",
  rest_house: "chalet",
  chalet: "chalet",
  shopping_mall: "mall",
  mall: "mall",
  plaza: "plaza",
  commercial_complex: "plaza",
  factory: "factory",
  farm: "farm",
};

/** contracts.units[].unit_type / units.unit_type → `unit_type`. */
export const EJAR_UNIT_TYPE: Record<string, string> = {
  apartment: "apartment",
  studio: "studio",
  villa: "villa",
  building: "building",
  floor: "floor",
  shop: "shop",
  office: "office",
  showroom: "showroom",
  workshop: "workshop",
  warehouse: "warehouse",
  land: "land",
  leased_land: "leasedLand",
  station: "station",
  kiosk: "kiosk",
  cinema: "cinema",
  hotel: "hotel",
  hotel_room: "hotelRoom",
  duplex: "duplex",
  annex: "annex",
  tower: "tower",
  atm: "atm",
  car_parking: "parkingLot",
  parking: "parkingLot",
  driver_room: "driverRoom",
  shared_room: "sharedRoom",
  traditional_house: "traditionalHouse",
  rooftop_villa: "rooftopVilla",
  rest_house: "chalet",
  chalet: "chalet",
  power_station: "powerStation",
  telecom_tower: "telecomTower",
  plaza: "plaza",
  shopping_mall: "mall",
  mall: "mall",
  educational_complex: "educational_complex",
  car_wash: "car_wash",
};

/** properties.property_usage / units.unit_usage → `property_usage`. */
export const EJAR_USAGE: Record<string, string> = {
  // `families` and `group_housing` now exist as their own options, so these no
  // longer have to collapse into the generic "individuals".
  residential_families: "families",
  residential_singles: "individuals",
  communal_housing: "group_housing",
  residential: "individuals",
  commercial: "commercial",
  mixed: "mixed",
  mixed_use: "mixed",
};

/** units.direction → `unit_direction`. */
export const EJAR_DIRECTION: Record<string, string> = {
  north: "north",
  south: "south",
  east: "east",
  west: "west",
  north_east: "northeast",
  northeast: "northeast",
  north_west: "northwest",
  northwest: "northwest",
  south_east: "southeast",
  southeast: "southeast",
  south_west: "southwest",
  southwest: "southwest",
};

/** units.unit_finishing → `unit_finishing`. */
export const EJAR_FINISHING: Record<string, string> = {
  shell: "shell",
  core_and_shell: "shell",
  incomplete: "incomplete",
  semi_finished: "incomplete",
  complete: "complete",
  finished: "complete",
  fully_finished: "complete",
};

/** units.furnish_type / furnished → `furnishing` (stored as text, not an FK). */
export const EJAR_FURNISHING: Record<string, string> = {
  furnished: "fully",
  fully_furnished: "fully",
  full: "fully",
  semi_furnished: "partial",
  partially_furnished: "partial",
  partial: "partial",
  unfurnished: "none",
  not_furnished: "none",
};

/**
 * properties/units.title_deed_type → the `deed_type` lookup key.
 *
 * Keys match the lookups table exactly (electronic | paper | hojjat_esthkam |
 * real_estate_registry) so an imported deed renders in the dropdown like a
 * hand-entered one. Anything unrecognised is left unmapped and handled by the
 * caller as a custom ("Other") value rather than being forced into
 * "electronic", which used to silently mislabel unknown Ejar deed types.
 */
export const EJAR_DEED_TYPE: Record<string, string> = {
  paper_title_deed: "paper",
  paper_deed: "paper",
  paper: "paper",
  electronic_title_deed: "electronic",
  electronic_deed: "electronic",
  electronic: "electronic",
  instrument: "electronic",
  hojjat_esthkam: "hojjat_esthkam",
  hujjat_esthkam: "hojjat_esthkam",
  hojat_estehkam: "hojjat_esthkam",
  esthkam: "hojjat_esthkam",
  real_estate_registry_title_deed: "real_estate_registry",
  real_estate_registry: "real_estate_registry",
  registry_title_deed: "real_estate_registry",
  real_estate_registry_deed: "real_estate_registry",
};

/** units.availability → units.status. */
export const EJAR_UNIT_STATUS: Record<string, "available" | "rented" | "maintenance" | "reserved"> = {
  occupied: "rented",
  rented: "rented",
  available: "available",
  vacant: "available",
  reserved: "reserved",
  maintenance: "maintenance",
  under_maintenance: "maintenance",
};

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/** Look a raw Ejar value up in one of the maps above. */
export function mapEjarValue(table: Record<string, string>, raw: unknown): string | null {
  const k = norm(raw);
  return k ? table[k] ?? null : null;
}

/**
 * A lookup FK plus the free-text fallback: when Ejar sends a value we have no
 * lookup option for ("factory", "other"), the FK stays null and the original
 * string is kept in `type_other` so nothing is silently dropped.
 */
export function lookupOrOther(mapped: string | null, raw: unknown): { key: string | null; other: string | null } {
  const rawStr = String(raw ?? "").trim();
  if (mapped) return { key: mapped, other: null };
  return { key: null, other: rawStr || null };
}

/** Ejar party type → our `individual` | `company` enums. */
export function partyKind(type: unknown): "individual" | "company" {
  return /organization|company|establishment|corporate/.test(norm(type)) ? "company" : "individual";
}

/** Ejar booleans arrive as real booleans or the strings "true"/"false". */
export function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const s = norm(v);
  if (s === "true") return true;
  if (s === "false") return false;
  return null;
}
