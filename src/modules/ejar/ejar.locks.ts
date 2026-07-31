/**
 * Which form fields are locked because Ejar supplied them.
 *
 * Ejar is the system of record for anything it sends, so an imported deed,
 * property, unit, landlord or tenant must not be edited into disagreeing with
 * it. A field Ejar left EMPTY stays editable — that is the gap the user is
 * expected to fill — and a manually created record is never locked at all.
 *
 * The decision is made from the `ejar_raw` snapshot rather than from "the field
 * currently has a value". That distinction matters: if we locked on the current
 * value, a blank Ejar field would lock itself the moment the user filled it in,
 * which is the opposite of the intent.
 */

/**
 * form field → the Ejar attribute(s) that populate it. A field locks when ANY
 * of its sources is present and non-empty in the snapshot.
 */
const FIELD_SOURCES: Record<string, Record<string, string[]>> = {
  property: {
    name: ["name", "property_name"],
    type: ["property_type"],
    usageType: ["property_usage"],
    city: ["city"],
    region: ["region"],
    district: ["district"],
    street: ["street_name"],
    postalCode: ["postcode"],
    deedNumber: ["title_deed_number"],
    yearBuilt: ["building_year"],
    elevators: ["elevator_count"],
    parkings: ["parking_count"],
    mapUrl: ["latitude", "longitude"],
    compoundName: ["compound_name"],
    inCompound: ["part_of_compound", "compound_name"],
  },
  unit: {
    unitNumber: ["unit_number"],
    type: ["unit_type", "unit_type_name"],
    floor: ["floor_number"],
    area: ["area"],
    bedrooms: ["room_count"],
    rentPrice: ["last_rental_price"],
    parkingSpaces: ["number_of_parking_lots"],
    electricityMeter: ["electricity_meter_number"],
    waterMeter: ["water_meter_number"],
    gasMeter: ["gas_meter_number"],
    unitWidth: ["width"],
    unitHeight: ["height"],
    unitLength: ["length"],
    facadeLength: ["unit_front_length"],
    hasMezzanine: ["include_mezzanine"],
    direction: ["direction"],
    finishing: ["unit_finishing"],
    furnishing: ["furnished", "furnish_type"],
    yearBuilt: ["construction_date", "established_date"],
  },
  deed: {
    deedNumber: ["title_deed_number"],
    deedType: ["title_deed_type"],
    deedOwners: ["owners"],
  },
  // Tenants and landlords are both Ejar "party" objects, so they share a map.
  tenant: {
    name: ["name"],
    type: ["type"],
    nationalId: ["id_number", "registration_number"],
    phone: ["phone_number"],
    email: ["email"],
    taxNumber: ["unified_number"],
  },
  landlord: {
    name: ["name"],
    type: ["type"],
    idNumber: ["id_number", "registration_number"],
    phone: ["phone_number"],
    email: ["email"],
    taxNumber: ["unified_number"],
  },
};

/**
 * form field → the row column(s) holding it. Used only as a FALLBACK for
 * records imported before `ejar_raw` existed: with no snapshot to consult, the
 * best available reading of "came from Ejar" is "the import left a value here".
 * Precise mode (FIELD_SOURCES) is always preferred when a snapshot exists.
 */
const FALLBACK_COLUMNS: Record<string, Record<string, string[]>> = {
  property: {
    name: ["name"], type: ["typeLookupId", "typeOther"], usageType: ["usageLookupId"],
    city: ["cityLookupId"], region: ["regionLookupId"], district: ["district"],
    street: ["street"], postalCode: ["postalCode"], deedNumber: ["deedNumber"],
    yearBuilt: ["yearBuilt"], elevators: ["elevators"], parkings: ["parkings"],
    mapUrl: ["mapUrl"], compoundName: ["amenitiesData"], inCompound: ["amenitiesData"],
  },
  unit: {
    unitNumber: ["unitNumber"], type: ["typeLookupId", "typeOther"], floor: ["floor"],
    area: ["area"], bedrooms: ["bedrooms"], rentPrice: ["rentPrice"],
    parkingSpaces: ["parkingSpaces"], electricityMeter: ["electricityMeter"],
    waterMeter: ["waterMeter"], gasMeter: ["gasMeter"], unitWidth: ["unitWidth"],
    unitHeight: ["unitHeight"], unitLength: ["unitLength"], facadeLength: ["facadeLength"],
    hasMezzanine: ["hasMezzanine"], direction: ["directionLookupId"],
    finishing: ["finishingLookupId"], furnishing: ["furnishing"], yearBuilt: ["yearBuilt"],
  },
  deed: { deedNumber: ["deedNumber"], deedType: ["deedType"], deedOwners: ["deedOwners"] },
  tenant: {
    name: ["name"], type: ["type"], nationalId: ["nationalId"],
    phone: ["phone"], email: ["email"], taxNumber: ["taxNumber"],
  },
  landlord: {
    name: ["name"], type: ["type"], idNumber: ["idNumber"],
    phone: ["phone"], email: ["email"], taxNumber: ["taxNumber"],
  },
};

export type EjarLockEntity = keyof typeof FIELD_SOURCES;

export function isLockEntity(v: unknown): v is EjarLockEntity {
  return typeof v === "string" && v in FIELD_SOURCES;
}

/** Present and meaningfully non-empty — `false` and `0` DO count as values. */
function supplied(raw: Record<string, unknown>, key: string): boolean {
  if (!(key in raw)) return false;
  const v = raw[key];
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

export interface EjarLocks {
  /** False for manually created records — nothing is locked. */
  isEjar: boolean;
  /** Form fields the UI must render read-only. */
  locked: string[];
}

export function computeEjarLocks(
  entity: EjarLockEntity,
  row: (Record<string, unknown> & { ejarSource?: string | null; ejarRaw?: Record<string, unknown> | null }) | null | undefined,
): EjarLocks {
  if (!row || row.ejarSource !== "ejar") return { isEjar: false, locked: [] };

  const raw = row.ejarRaw;
  if (raw && Object.keys(raw).length > 0) {
    const locked = Object.entries(FIELD_SOURCES[entity])
      .filter(([, keys]) => keys.some((k) => supplied(raw, k)))
      .map(([field]) => field);
    return { isEjar: true, locked };
  }

  // Imported before ejar_raw existed. Everything on the row was written by the
  // import, so a column that holds a value came from Ejar; one left empty is
  // still the user's to fill. Less precise than the snapshot — it cannot tell
  // an Ejar value from one the user typed later — but it keeps legacy imports
  // locked rather than silently editable.
  const locked = Object.entries(FALLBACK_COLUMNS[entity])
    .filter(([, cols]) => cols.some((c) => supplied(row, c)))
    .map(([field]) => field);
  return { isEjar: true, locked };
}
