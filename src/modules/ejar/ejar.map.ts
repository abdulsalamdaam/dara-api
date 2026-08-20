// Map Ejar (JSON:API) payloads into this API's Contract shape.
//
// Field names verified against the REAL UAT responses (captured in
// ejar_api_logs):
//   GetRentalContracts   — dates start_time/end_time, total_value,
//                          security_deposit_value, inline tenants/lessors/units,
//                          plus broker_name, unified_number, company_cr_number,
//                          period/days_remaining, contract_activities.
//   RentalFinancialData  — rent in included[rental_fees].total_rent_amount.
//   RentalContractInvoices — invoices in included[payments]: invoice_amount,
//                          invoice_due_date, payment_status.{ar,en}.
//   NationalAddress      — NO street address; included has property coordinates
//                          + property_type and a unit (unit_number, floor_number,
//                          unit_type). All bilingual fields are {ar,en}.
//   GetProperties        — address/district/city/region (name_ar+name_en),
//                          owners[], title deed, usage, utilities, amenities.
//   GetUnits             — area/room_count/floor, owners[], meters, deed,
//                          availability, usage, unified_numbers.
//
// Everything Ejar sends is surfaced: the flat `contract` object is what the
// import writes, and the extra blocks (parties / contractInfo / financial /
// activities / raw) exist so the wizard can show the full record BEFORE import.
// READ-ONLY: nothing is pushed to NHC.

import type { EjarBody, JsonApiResource } from "./ejar.types";

type Attrs = Record<string, unknown>;

function pick(attrs: Attrs | null | undefined, ...keys: string[]): string | null {
  if (!attrs) return null;
  for (const k of keys) {
    const v = attrs[k];
    if (v !== undefined && v !== null && `${v}`.trim() !== "") return `${v}`;
  }
  return null;
}

/**
 * Ejar returns many labels as objects — { ar, en } on the detail endpoints and
 * { name_ar, name_en } on Get Properties/Units. Prefer Arabic, fall back to en.
 */
function bilingual(v: unknown): string | null {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return (o.ar as string) || (o.name_ar as string) || (o.en as string) || (o.name_en as string) || null;
  }
  return v == null || `${v}`.trim() === "" ? null : `${v}`;
}

/**
 * Some GetProperties columns come back encrypted (base64 blobs with a trailing
 * newline, e.g. unified_numbers / companies_cr_numbers). Showing those as data
 * is worse than showing nothing — drop them.
 */
function isEncrypted(v: string): boolean {
  return /[+/=]/.test(v) && /^[A-Za-z0-9+/]{16,}={0,2}\s*$/.test(v);
}

/** A string list attribute (lessor_names, utilities, …), cleaned of blobs. */
function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (x == null ? "" : `${x}`.trim()))
    .filter((x) => x !== "" && !isEncrypted(x));
}

/** Included resources of a given JSON:API type. */
function includedByType(body: EjarBody | null | undefined, type: string): JsonApiResource[] {
  const inc = body?.included;
  return Array.isArray(inc) ? inc.filter((r) => r.type === type) : [];
}

const roleOf = (p: Attrs) => String(p?.role || "").toLowerCase();

/** Primary party (actual tenant/lessor, possibly an org) — NOT its representative. */
function party(arr: unknown, preferRole: string): Attrs | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const items = arr as Attrs[];
  return (
    items.find((p) => roleOf(p) === preferRole) ||
    items.find((p) => !roleOf(p).includes("representative")) ||
    items[0]
  );
}

function representative(arr: unknown): Attrs | null {
  if (!Array.isArray(arr)) return null;
  return (arr as Attrs[]).find((p) => roleOf(p).includes("representative")) || null;
}

const isOrg = (p: Attrs | null | undefined) =>
  !!p && /organization|company|establishment/.test(String(p.type || "").toLowerCase());

export function normalizeStatus(raw: string | null): string {
  const s = (raw || "").toLowerCase();
  if (/active|registered|نشط|ساري|current|valid/.test(s)) return "active";
  if (/expired|منتهي|ended/.test(s)) return "expired";
  if (/terminat|فسخ|منهي/.test(s)) return "terminated";
  if (/cancel|ملغ/.test(s)) return "cancelled";
  if (/pend|draft|waiting|مسودة|قيد/.test(s)) return "pending";
  return "active";
}

/** Ejar payment_frequency → our enum (fallback when there are no invoices). */
function mapFrequency(raw: string | null): string {
  const s = (raw || "").toLowerCase();
  if (/quarter|ربع/.test(s)) return "quarterly";
  if (/semi|نصف/.test(s)) return "semi_annual";
  if (/month|شهري/.test(s)) return "monthly";
  return "annual"; // incl. "one payment" / "دفعة واحدة"
}

export interface EjarContractSummary {
  id: string;
  contractNumber: string;
  contractType: string | null;
  status: string;
  rawStatus: string | null;
  startDate: string | null;
  endDate: string | null;
  propertyName: string | null;
  tenantName: string | null;
  landlordName: string | null;
  monthlyRent: string | null;
  annualRent: string | null;
}

export function summarizeContract(res: JsonApiResource): EjarContractSummary {
  const a = res.attributes || {};
  const tenant = party(a.tenants, "tenant");
  const lessor = party(a.lessors, "lessor");
  return {
    id: res.id,
    contractNumber: pick(a, "contract_number", "contractNumber", "number") || res.id,
    contractType: pick(a, "contract_type", "contractType", "type", "rental_type"),
    rawStatus: pick(a, "status", "contract_status", "contractStatus", "state"),
    status: normalizeStatus(pick(a, "status", "contract_status", "contractStatus", "state")),
    startDate: pick(a, "start_time", "start_date", "startDate", "contract_start_date", "from_date"),
    endDate: pick(a, "end_time", "end_date", "endDate", "contract_end_date", "to_date"),
    propertyName: pick(a, "property_name", "propertyName", "property"),
    tenantName: pick(tenant, "name", "full_name", "party_name") || pick(a, "tenant_name", "tenantName"),
    landlordName: pick(lessor, "name", "full_name", "party_name") || pick(a, "lessor_name", "landlord_name"),
    monthlyRent: pick(a, "monthly_rent", "monthlyRent", "rent_amount", "installment_value"),
    annualRent: pick(a, "total_value", "annual_rent", "annualRent", "total_contract_value", "yearly_rent"),
  };
}

export function summarizeContractsBody(body: EjarBody): EjarContractSummary[] {
  const data = body.data;
  if (!data) return [];
  const arr = Array.isArray(data) ? data : [data];
  return arr.map((r) => summarizeContract(r));
}

export interface EjarInvoiceRow {
  id: string;
  number: string | null;
  dueDate: string | null;
  issueDate: string | null;
  lateDate: string | null;
  amount: string | null;
  remaining: string | null;
  status: string | null;
  scheduleNumber: string | null;
}

/** Real invoices live in included[type=payments], not in `data`. */
export function summarizeInvoices(body?: EjarBody | null): EjarInvoiceRow[] {
  return includedByType(body, "payments").map((r) => {
    const a = r.attributes || {};
    return {
      id: r.id,
      number: pick(a, "sequence_number", "invoice_number", "number", "reference"),
      dueDate: pick(a, "invoice_due_date", "due_date", "dueDate"),
      issueDate: pick(a, "invoice_issue_date", "issue_date"),
      lateDate: pick(a, "invoice_late_date", "late_date"),
      amount: pick(a, "invoice_amount", "amount", "total", "total_amount"),
      remaining: pick(a, "invoice_remaining_amount", "remaining_amount"),
      status: bilingual(a.payment_status) || pick(a, "status", "payment_status"),
      scheduleNumber: pick(a, "payment_schedule_sequence_number"),
    };
  });
}

/** The rental_fees included resource (RentalFinancialData / Invoices). */
function rentalFee(body?: EjarBody | null): Attrs {
  return includedByType(body, "rental_fees")[0]?.attributes || {};
}

export interface EjarContractDetail {
  contract: JsonApiResource;
  listBody?: EjarBody;
  nationalAddress?: EjarBody | null;
  financial?: EjarBody | null;
  invoices?: EjarBody | null;
  propertiesBody?: EjarBody | null;
  unitsBody?: EjarBody | null;
}

/* ── Parties ──
 * Ejar inlines `tenants` / `lessors` on the contract. Each entry is either an
 * individual (name + id_number + phone_number + email) or an organization
 * (name + registration_number + unified_number + organization_type) and may
 * carry role="…representative". We surface EVERY party, not just the primary
 * one, because a contract can legitimately have several of each.
 */
export interface EjarPartyInfo {
  group: "tenant" | "lessor" | "broker";
  role: string | null;
  isRepresentative: boolean;
  name: string | null;
  partyType: string | null;
  idType: string | null;
  idNumber: string | null;
  phone: string | null;
  email: string | null;
  unifiedNumber: string | null;
  registrationNumber: string | null;
  organizationType: string | null;
  vat: string | null;
  /**
   * Nationality (الجنسية). Ejar does not publish it as its own field on every
   * contract, so this is the explicit value when present and otherwise the one
   * safe inference: a Saudi national ID means a Saudi national. An iqama or a
   * passport says the holder is NOT Saudi but not which nationality they are,
   * so those stay null rather than guessing.
   */
  nationality: string | null;
  /** The verbatim Ejar party object — persisted to tenants/owners.ejar_raw. */
  raw: Record<string, unknown>;
}

/** Nationality from an explicit Ejar field, else inferred from the ID type. */
function partyNationality(p: Attrs, idType: string | null): string | null {
  const explicit = pick(p, "nationality", "nationality_name", "nationality_ar", "party_nationality");
  if (explicit) return explicit;
  return (idType || "").toLowerCase() === "national_id" ? "سعودي" : null;
}

function mapParty(p: Attrs, group: EjarPartyInfo["group"]): EjarPartyInfo {
  const role = pick(p, "role");
  const idType = pick(p, "id_type", "owner_id_type");
  return {
    raw: p as Record<string, unknown>,
    group,
    role,
    isRepresentative: (role || "").toLowerCase().includes("representative"),
    name: pick(p, "name", "full_name", "party_name", "owner_name"),
    partyType: pick(p, "type", "party_type", "owner_type"),
    idType,
    nationality: partyNationality(p, idType),
    idNumber: pick(p, "id_number", "national_id", "identity_number", "owner_id"),
    phone: pick(p, "phone_number", "phone", "mobile"),
    email: pick(p, "email"),
    unifiedNumber: pick(p, "unified_number"),
    registrationNumber: pick(p, "registration_number", "cr_number", "commercial_registration"),
    organizationType: pick(p, "organization_type"),
    vat: pick(p, "vat"),
  };
}

export interface EjarParties {
  tenants: EjarPartyInfo[];
  lessors: EjarPartyInfo[];
  brokers: EjarPartyInfo[];
}

export function mapEjarParties(detail: EjarContractDetail): EjarParties {
  const a = detail.contract.attributes || {};
  const list = (v: unknown, group: EjarPartyInfo["group"]) =>
    (Array.isArray(v) ? (v as Attrs[]) : []).map((p) => mapParty(p, group));

  const brokers: EjarPartyInfo[] = [];
  const brokerName = pick(a, "broker_name");
  const brokerId = pick(a, "broker_national_id");
  if (brokerName || brokerId) {
    brokers.push({
      raw: { broker_name: brokerName, broker_national_id: brokerId },
      group: "broker",
      role: "broker",
      isRepresentative: false,
      name: brokerName,
      partyType: null,
      idType: brokerId ? "national_id" : null,
      nationality: brokerId ? "سعودي" : null,
      idNumber: brokerId,
      phone: null,
      email: null,
      unifiedNumber: pick(a, "unified_number"),
      registrationNumber: pick(a, "company_cr_number"),
      organizationType: null,
      vat: null,
    });
  }
  return { tenants: list(a.tenants, "tenant"), lessors: list(a.lessors, "lessor"), brokers };
}

/* ── Contract facts (everything the list endpoint returns, labelled) ── */
export interface EjarContractInfo {
  ejarId: string | null;
  contractNumber: string | null;
  contractType: string | null;
  status: string | null;
  statusNormalized: string;
  startDate: string | null;
  endDate: string | null;
  createdTime: string | null;
  periodDays: string | null;
  daysRemaining: string | null;
  totalValue: string | null;
  securityDeposit: string | null;
  paymentFrequency: string | null;
  installmentCount: string | null;
  installmentValue: string | null;
  ejarFee: string | null;
  autoRenewal: string | null;
  subleaseAllowed: string | null;
  classification: string | null;
  unitCount: string | null;
  tenantCount: string | null;
  lessorCount: string | null;
  brokerName: string | null;
  brokerNationalId: string | null;
  unifiedNumber: string | null;
  companyCrNumber: string | null;
  propertyId: string | null;
  propertyName: string | null;
  propertyType: string | null;
  region: string | null;
  latitude: string | null;
  longitude: string | null;
}

const yesNo = (v: unknown): string | null => (typeof v === "boolean" ? (v ? "true" : "false") : pick({ v }, "v"));

export function mapEjarContractInfo(detail: EjarContractDetail): EjarContractInfo {
  const a = detail.contract.attributes || {};
  const region = (a.region && typeof a.region === "object" ? (a.region as Attrs) : {}) as Attrs;
  return {
    ejarId: pick(a, "contract_id") || detail.contract.id,
    contractNumber: pick(a, "contract_number"),
    contractType: pick(a, "contract_type"),
    status: pick(a, "status"),
    statusNormalized: normalizeStatus(pick(a, "status")),
    startDate: pick(a, "start_time", "start_date"),
    endDate: pick(a, "end_time", "end_date"),
    createdTime: pick(a, "created_time"),
    periodDays: pick(a, "period"),
    daysRemaining: pick(a, "days_remaining"),
    totalValue: pick(a, "total_value"),
    securityDeposit: pick(a, "security_deposit_value"),
    paymentFrequency: pick(a, "payment_frequency"),
    installmentCount: pick(a, "installment_count"),
    installmentValue: pick(a, "installment_value"),
    ejarFee: pick(a, "contract_creation_ejar_fee"),
    autoRenewal: yesNo(a.auto_renewal_enabled),
    subleaseAllowed: yesNo(a.sublease_allowed),
    classification: yesNo(a.classification),
    unitCount: pick(a, "unit_count"),
    tenantCount: pick(a, "tenant_count"),
    lessorCount: pick(a, "lessor_count"),
    brokerName: pick(a, "broker_name"),
    brokerNationalId: pick(a, "broker_national_id"),
    unifiedNumber: pick(a, "unified_number"),
    companyCrNumber: pick(a, "company_cr_number"),
    propertyId: pick(a, "property_id"),
    propertyName: pick(a, "property_name"),
    propertyType: pick(a, "property_type"),
    region: pick(region, "name_ar", "name_en") || pick(a, "region"),
    latitude: pick(a, "latitude"),
    longitude: pick(a, "longitude"),
  };
}

/* ── Contract activity trail ── */
export interface EjarActivityRow {
  type: string | null;
  timestamp: string | null;
  person: string | null;
}

export function mapEjarActivities(detail: EjarContractDetail): EjarActivityRow[] {
  const a = detail.contract.attributes || {};
  const rows = Array.isArray(a.contract_activities) ? (a.contract_activities as Attrs[]) : [];
  return rows
    .map((r) => ({
      type: pick(r, "activity_type", "type", "status"),
      timestamp: pick(r, "timestamp", "created_at", "date"),
      person: pick(r, "person", "actor", "name"),
    }))
    .sort((x, y) => String(y.timestamp || "").localeCompare(String(x.timestamp || "")));
}

/* ── Financials ── */
export interface EjarFinancialInfo {
  totalRentAmount: string | null;
  paymentFrequency: string | null;
  recurringPayment: string | null;
  totalValue: string | null;
  securityDeposit: string | null;
  ejarFee: string | null;
  installmentCount: string | null;
  installmentValue: string | null;
  invoiceCount: number;
  invoiceTotal: string | null;
  invoiceRemaining: string | null;
}

function sumOf(values: Array<string | null>): string | null {
  const nums = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  return nums.length ? String(nums.reduce((s, n) => s + n, 0)) : null;
}

export function mapEjarFinancial(detail: EjarContractDetail, invoices: EjarInvoiceRow[]): EjarFinancialInfo {
  const a = detail.contract.attributes || {};
  const fee = { ...rentalFee(detail.financial), ...rentalFee(detail.invoices) };
  return {
    totalRentAmount: pick(fee, "total_rent_amount", "total_rent", "rent_amount"),
    paymentFrequency: bilingual(fee.payment_frequency) || pick(a, "payment_frequency"),
    recurringPayment: bilingual(fee.recurring_payment),
    totalValue: pick(a, "total_value"),
    securityDeposit: pick(a, "security_deposit_value"),
    ejarFee: pick(a, "contract_creation_ejar_fee"),
    installmentCount: pick(a, "installment_count"),
    installmentValue: pick(a, "installment_value"),
    invoiceCount: invoices.length,
    invoiceTotal: sumOf(invoices.map((i) => i.amount)),
    invoiceRemaining: sumOf(invoices.map((i) => i.remaining)),
  };
}

/* ── Property / units ── */
export interface EjarOwnerInfo {
  name: string | null;
  id: string | null;
  idType: string | null;
  type: string | null;
}

function mapOwners(v: unknown): EjarOwnerInfo[] {
  if (!Array.isArray(v)) return [];
  return (v as Attrs[]).map((o) => ({
    name: pick(o, "owner_name", "name"),
    id: pick(o, "owner_id", "id_number", "id"),
    idType: pick(o, "owner_id_type", "id_type"),
    type: pick(o, "owner_type", "type"),
  }));
}

export interface EjarPropertyInfo {
  ejarId: string | null;
  name: string | null;
  propertyType: string | null;
  propertyUsage: string | null;
  address: string | null;
  district: string | null;
  street: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  /** Ejar's region *key* ("riyadh") — matches the `region` lookup key, unlike
   *  `region` above which holds the display name ("الرياض"). */
  regionKey: string | null;
  deedNumber: string | null;
  deedType: string | null;
  yearBuilt: string | null;
  constructionDate: string | null;
  contractStatus: string | null;
  compoundName: string | null;
  partOfCompound: string | null;
  parkingCount: string | null;
  elevatorCount: string | null;
  unitsCount: string | null;
  latitude: string | null;
  longitude: string | null;
  owners: EjarOwnerInfo[];
  lessorNames: string[];
  brokerIds: string[];
  unifiedNumbers: string[];
  crNumbers: string[];
  utilities: string[];
  amenities: string[];
}

export interface EjarUnitInfo {
  ejarId: string | null;
  unitNumber: string | null;
  unitType: string | null;
  unitUsage: string | null;
  floor: string | null;
  area: string | null;
  rooms: string | null;
  rentPrice: string | null;
  availability: string | null;
  contracted: string | null;
  contractStatus: string | null;
  isVerified: string | null;
  furnished: string | null;
  furnishType: string | null;
  finishing: string | null;
  direction: string | null;
  deedNumber: string | null;
  deedType: string | null;
  parkingLots: string | null;
  includeMezzanine: string | null;
  width: string | null;
  height: string | null;
  length: string | null;
  frontLength: string | null;
  waterMeter: string | null;
  gasMeter: string | null;
  electricityMeter: string | null;
  establishedDate: string | null;
  constructionDate: string | null;
  region: string | null;
  latitude: string | null;
  longitude: string | null;
  propertyId: string | null;
  rentalContractId: string | null;
  owners: EjarOwnerInfo[];
  lessorNames: string[];
  unifiedNumbers: string[];
  brokerIds: string[];
  crNumbers: string[];
  amenities: string[];
  utilities: string[];
}

export interface EjarNationalAddressInfo {
  contractNumber: string | null;
  contractStatus: string | null;
  contractEndDate: string | null;
  propertyType: string | null;
  unitType: string | null;
  unitNumber: string | null;
  floorNumber: string | null;
  region: string | null;
  latitude: string | null;
  longitude: string | null;
}

/**
 * Raw Ejar payloads, kept alongside the mapped view so nothing is hidden —
 * and persisted verbatim into each entity's `ejar_raw` column on import.
 * `units` is keyed by the unit's Ejar UUID so the import can attach the right
 * block to the right row.
 */
export interface EjarRawBlocks {
  contract: Record<string, unknown> | null;
  property: Record<string, unknown> | null;
  units: Record<string, Record<string, unknown>>;
  nationalAddress: Record<string, unknown> | null;
  financial: Record<string, unknown> | null;
  invoices: Array<Record<string, unknown>>;
}

export interface EjarImportPreview {
  /** Flat payload the import endpoint writes. */
  contract: Record<string, unknown>;
  contractInfo: EjarContractInfo;
  parties: EjarParties;
  financial: EjarFinancialInfo;
  activities: EjarActivityRow[];
  invoices: EjarInvoiceRow[];
  nationalAddress: EjarNationalAddressInfo;
  property: EjarPropertyInfo;
  units: EjarUnitInfo[];
  raw: EjarRawBlocks;
}

/** Find a resource in a body's `data` array by id. */
function findData(body: EjarBody | null | undefined, id: string | null): Attrs {
  if (!id || !body?.data) return {};
  const arr = Array.isArray(body.data) ? body.data : [body.data];
  return arr.find((r) => r.id === id)?.attributes || {};
}

function localizedName(v: unknown): string | null {
  if (v && typeof v === "object") return bilingual(v);
  return v == null ? null : `${v}`;
}

/** Build the local Property from the contract + optional GetProperties enrich. */
export function mapEjarProperty(detail: EjarContractDetail): EjarPropertyInfo {
  const a = detail.contract.attributes || {};
  const pid = pick(a, "property_id");
  const p = findData(detail.propertiesBody, pid);
  const region = (a.region && typeof a.region === "object" ? (a.region as Attrs) : {}) as Attrs;
  return {
    ejarId: pid,
    name: pick(a, "property_name") || pick(p, "name"),
    propertyType: pick(a, "property_type") || pick(p, "property_type"),
    propertyUsage: pick(p, "property_usage"),
    address: pick(p, "address"),
    district: localizedName(p.district),
    street: pick(p, "street_name", "street"),
    city: localizedName(p.city),
    region: pick(region, "name_ar", "name_en") || localizedName(p.region),
    postalCode: pick(p, "postcode", "postal_code"),
    regionKey: pick(region, "key") || pick((p.region && typeof p.region === "object" ? (p.region as Attrs) : {}), "key"),
    deedNumber: pick(p, "title_deed_number", "deed_number"),
    deedType: pick(p, "title_deed_type"),
    yearBuilt: pick(p, "building_year", "year_built"),
    constructionDate: pick(p, "construction_date"),
    contractStatus: pick(p, "contract_status"),
    compoundName: pick(p, "compound_name"),
    partOfCompound: yesNo(p.part_of_compound),
    parkingCount: pick(p, "parking_count"),
    elevatorCount: pick(p, "elevator_count"),
    unitsCount: Array.isArray(p.units) ? String((p.units as unknown[]).length) : pick(a, "unit_count"),
    latitude: pick(a, "latitude") || pick(p, "latitude"),
    longitude: pick(a, "longitude") || pick(p, "longitude"),
    owners: mapOwners(p.owners),
    lessorNames: strList(p.lessor_names),
    brokerIds: strList(p.brokers_national_ids),
    unifiedNumbers: strList(p.unified_numbers),
    crNumbers: strList(p.companies_cr_numbers),
    utilities: strList(p.utilities),
    amenities: strList(p.amenities_and_facilities ?? p.amenities),
  };
}

/** Build the local Unit(s) from the contract.units + optional GetUnits enrich. */
export function mapEjarUnits(detail: EjarContractDetail): EjarUnitInfo[] {
  const a = detail.contract.attributes || {};
  const units = Array.isArray(a.units) ? (a.units as Attrs[]) : [];
  const naUnit = includedByType(detail.nationalAddress, "national_address_units")[0]?.attributes || {};
  return units.map((u) => {
    const uid = pick(u, "id", "unit_id");
    const full = findData(detail.unitsBody, uid);
    const region = (full.region && typeof full.region === "object" ? (full.region as Attrs) : {}) as Attrs;
    return {
      ejarId: uid,
      unitNumber: pick(u, "unit_number") || pick(full, "unit_number"),
      unitType: pick(u, "unit_type") || pick(full, "unit_type", "unit_type_name"),
      unitUsage: pick(full, "unit_usage"),
      floor: pick(full, "floor_number") || pick(naUnit, "floor_number"),
      area: pick(full, "area"),
      rooms: pick(full, "room_count", "bedrooms"),
      rentPrice: pick(full, "last_rental_price", "rent_price"),
      availability: pick(full, "availability"),
      contracted: yesNo(full.contracted),
      contractStatus: pick(full, "contract_status"),
      isVerified: yesNo(full.is_verified),
      furnished: yesNo(full.furnished),
      furnishType: pick(full, "furnish_type"),
      finishing: pick(full, "unit_finishing"),
      direction: pick(full, "direction"),
      deedNumber: pick(full, "title_deed_number"),
      deedType: pick(full, "title_deed_type"),
      parkingLots: pick(full, "number_of_parking_lots"),
      includeMezzanine: yesNo(full.include_mezzanine),
      width: pick(full, "width"),
      height: pick(full, "height"),
      length: pick(full, "length"),
      frontLength: pick(full, "unit_front_length"),
      waterMeter: pick(full, "water_meter_number"),
      gasMeter: pick(full, "gas_meter_number"),
      electricityMeter: pick(full, "electricity_meter_number"),
      establishedDate: pick(full, "established_date"),
      constructionDate: pick(full, "construction_date"),
      region: pick(region, "name_ar", "name_en"),
      latitude: pick(full, "latitude"),
      longitude: pick(full, "longitude"),
      propertyId: pick(full, "property_id") || pick(a, "property_id"),
      rentalContractId: pick(full, "rental_contract_id"),
      owners: mapOwners(full.owners),
      lessorNames: strList(full.lessor_names),
      unifiedNumbers: strList(full.unified_numbers),
      brokerIds: strList(full.brokers_national_ids),
      crNumbers: strList(full.companies_cr_numbers),
      amenities: strList(full.amenities),
      utilities: strList(full.utilities),
    };
  });
}

export function mapEjarToContract(detail: EjarContractDetail): EjarImportPreview {
  const summary = summarizeContract(detail.contract);
  const a = detail.contract.attributes || {};

  const tenant = party(a.tenants, "tenant") || {};
  const tenantRep = representative(a.tenants);
  const lessor = party(a.lessors, "lessor") || {};
  const lessorRep = representative(a.lessors);
  const region = (a.region && typeof a.region === "object" ? (a.region as Attrs) : {}) as Attrs;

  // Rent: RentalFinancialData.total_rent_amount is authoritative; fall back to
  // the list's total_value.
  const fee = { ...rentalFee(detail.financial), ...rentalFee(detail.invoices) };
  const totalRent = pick(fee, "total_rent_amount", "total_rent", "rent_amount") || summary.annualRent;

  // Real invoices → a custom payment schedule (exact amounts + due dates).
  const invoices = summarizeInvoices(detail.invoices);
  const customSchedule = invoices
    .filter((inv) => inv.dueDate && Number(inv.amount) > 0)
    .map((inv) => ({ dueDate: String(inv.dueDate).slice(0, 10), amount: String(Number(inv.amount)) }));

  // National address: no street — coordinates + property/unit descriptors.
  const naContract = (Array.isArray(detail.nationalAddress?.data)
    ? detail.nationalAddress?.data[0]
    : detail.nationalAddress?.data)?.attributes || {};
  const naProp = includedByType(detail.nationalAddress, "national_address_properties")[0]?.attributes || {};
  const naUnit = includedByType(detail.nationalAddress, "national_address_units")[0]?.attributes || {};
  const coords = (naProp.coordinates && typeof naProp.coordinates === "object" ? naProp.coordinates : {}) as Attrs;
  const listUnit = (Array.isArray(a.units) && (a.units as Attrs[])[0]) || {};
  const nationalAddress: EjarNationalAddressInfo = {
    contractNumber: pick(naContract, "contract_no") || summary.contractNumber,
    contractStatus: bilingual(naContract.contract_status),
    contractEndDate: pick(naContract, "contract_end_date"),
    propertyType: bilingual(naProp.property_type) || pick(a, "property_type"),
    unitType: bilingual(naUnit.unit_type) || pick(listUnit, "unit_type"),
    unitNumber: pick(naUnit, "unit_number") || pick(listUnit, "unit_number"),
    floorNumber: pick(naUnit, "floor_number"),
    region: pick(region, "name_ar", "name_en"),
    latitude: coords.latitude != null ? `${coords.latitude}` : pick(a, "latitude"),
    longitude: coords.longitude != null ? `${coords.longitude}` : pick(a, "longitude"),
  };

  const unitLabel = [nationalAddress.unitNumber && `وحدة ${nationalAddress.unitNumber}`, nationalAddress.floorNumber && `دور ${nationalAddress.floorNumber}`]
    .filter(Boolean)
    .join(" - ");

  const contract: Record<string, unknown> = {
    ejarSource: "ejar",
    ejarContractNumber: summary.contractNumber,
    contractNumber: summary.contractNumber,
    startDate: summary.startDate,
    endDate: summary.endDate,
    status: summary.status,
    annualRent: totalRent,
    monthlyRent: totalRent, // representative; custom schedule drives installments
    depositAmount: pick(a, "security_deposit_value", "deposit", "deposit_amount", "security_deposit"),
    paymentFrequency: customSchedule.length ? "custom" : mapFrequency(bilingual(fee.payment_frequency) || pick(a, "payment_frequency")),
    customSchedule: customSchedule.length ? customSchedule : undefined,
    tenantType: isOrg(tenant) ? "company" : "individual",
    tenantName: pick(tenant, "name", "full_name", "party_name") || summary.tenantName,
    tenantIdNumber: pick(tenant, "id_number", "national_id", "identity_number", "registration_number"),
    tenantPhone: pick(tenant, "phone_number", "phone", "mobile"),
    tenantEmail: pick(tenant, "email"),
    companyUnified: pick(tenant, "unified_number"),
    companyOrgType: pick(tenant, "organization_type"),
    repName: pick(tenantRep, "name", "full_name"),
    repIdNumber: pick(tenantRep, "id_number", "national_id", "identity_number"),
    landlordName: pick(lessor, "name", "full_name", "party_name") || summary.landlordName,
    landlordIdNumber: pick(lessor, "id_number", "national_id", "identity_number", "registration_number"),
    landlordPhone: pick(lessor, "phone_number", "phone", "mobile"),
    landlordEmail: pick(lessor, "email"),
    landlordRepName: pick(lessorRep, "name", "full_name"),
    landlordRepIdNumber: pick(lessorRep, "id_number", "national_id", "identity_number"),
    propertyName: summary.propertyName,
    notes: [`مستورد من إيجار — عقد رقم ${summary.contractNumber}`, nationalAddress.propertyType, unitLabel]
      .filter(Boolean)
      .join(" — "),
  };

  for (const k of Object.keys(contract)) {
    if (contract[k] === null || contract[k] === undefined || contract[k] === "") delete contract[k];
  }

  const property = mapEjarProperty(detail);
  const units = mapEjarUnits(detail);
  const pid = pick(a, "property_id");
  const rawProperty = Object.keys(findData(detail.propertiesBody, pid)).length
    ? findData(detail.propertiesBody, pid)
    : null;

  return {
    contract,
    contractInfo: mapEjarContractInfo(detail),
    parties: mapEjarParties(detail),
    financial: mapEjarFinancial(detail, invoices),
    activities: mapEjarActivities(detail),
    invoices,
    nationalAddress,
    property,
    units,
    raw: {
      contract: (a as Record<string, unknown>) || null,
      property: rawProperty,
      units: Object.fromEntries(
        units
          .map((u) => [u.ejarId ?? "", findData(detail.unitsBody, u.ejarId)] as const)
          .filter(([id, attrs]) => id && Object.keys(attrs).length > 0),
      ) as Record<string, Record<string, unknown>>,
      nationalAddress: detail.nationalAddress ? ({ data: detail.nationalAddress.data, included: detail.nationalAddress.included } as Record<string, unknown>) : null,
      financial: Object.keys(fee).length ? (fee as Record<string, unknown>) : null,
      invoices: includedByType(detail.invoices, "payments").map((r) => (r.attributes || {}) as Record<string, unknown>),
    },
  };
}
