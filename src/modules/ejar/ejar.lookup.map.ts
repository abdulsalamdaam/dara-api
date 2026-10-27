/**
 * Ejar Import v2 — reading the two lookup bodies.
 *
 * A lookup is Invoices (by contract number; carries the contract UUID and the
 * payment schedule) and then either Get Contracts by UUID (the list resource:
 * contract facts, property, units and parties WITH their ID numbers, phones
 * and emails) or Details by UUID (contract facts and parties, names only).
 * All arrive as JSON:API bodies. This file turns them into the lookup
 * response, and decides what the user still has to supply before the
 * contract can be imported (`required[]`).
 *
 * Pure: no database, no network.
 */
import { EJAR_UUID_RE, type EjarBody, type JsonApiRef, type JsonApiResource } from "./ejar.types";

type Attrs = Record<string, unknown>;
export interface Bilingual { en: string | null; ar: string | null }

export interface LookupParty {
  role: string;
  kind: "organization" | "individual";
  name: string | null;
  crNumber: string | null;
  unifiedNumber: string | null;
  organizationType: string | null;
  idType: string | null;
  /** Get Contracts sends it; Details never does. */
  idNumber: string | null;
  approved: boolean | null;
  /** Get Contracts only. */
  phone: string | null;
  email: string | null;
  /** A 15-digit VAT number, when Get Contracts sends one. */
  vatNumber: string | null;
}

export interface LookupParties {
  lessor: LookupParty | null;
  tenant: LookupParty | null;
  lessorRepresentative: LookupParty | null;
  tenantRepresentative: LookupParty | null;
  others: LookupParty[];
}

export interface LookupContract {
  /** Which call the contract facts and parties came from. */
  source: "contracts" | "details";
  ejarId: string | null;
  contractNumber: string | null;
  contractType: string | null;
  state: string | null;
  startDate: string | null;
  endDate: string | null;
  registeredAt: string | null;
  version: string | null;
  securityDeposit: number | null;
  currency: string | null;
  ridServiceEnabled: boolean | null;
  /** Ejar's raw status (Get Contracts `status`, Details `state`). */
  status: string | null;
  /** Get Contracts only — null from Details. */
  totalValue: number | null;
  paymentFrequency: string | null;
  autoRenewal: boolean | null;
  broker: { name: string | null; nationalId: string | null } | null;
  // Get Contracts only (null from Details) — the rest of the contract's terms.
  /** Ejar's registration fee for this contract (contract_creation_ejar_fee). */
  ejarFee: number | null;
  subleaseAllowed: boolean | null;
  /** The contract-level unified (700) number Ejar lists. */
  unifiedNumber: string | null;
  /** company_cr_number: the CR on the contract record (the brokerage office's, as seen on prod 27 Oct). */
  companyCrNumber: string | null;
  /** Contract length in days (Ejar's `period`). */
  periodDays: number | null;
  daysRemaining: number | null;
  installmentValue: number | null;
  installmentCount: number | null;
}

export interface LookupProperty {
  ejarId: string | null;
  name: string | null;
  type: string | null;
  region: { key: string | null; nameAr: string | null; nameEn: string | null } | null;
  latitude: number | null;
  longitude: number | null;
  mapsUrl: string | null;
  /** Ejar's unit_count. */
  unitCount: number | null;
}

export interface LookupUnit {
  ejarId: string | null;
  unitNumber: string | null;
  unitType: string | null;
  /** Present only when Ejar sends them (prod 27 Oct sent id/type/number only). */
  floor: number | null;
  area: number | null;
  rooms: number | null;
  usage: string | null;
  /** The verbatim units[] entry — persisted as the unit's ejar_raw. */
  raw: Record<string, unknown>;
}

export interface LookupInvoice {
  id: string;
  sequenceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  lateDate: string | null;
  amount: number | null;
  remaining: number | null;
  status: string | null;
  statusLabel: Bilingual | null;
}

export interface LookupFinancial {
  totalRentAmount: number | null;
  paymentFrequency: Bilingual | null;
  recurringPayment: Bilingual | null;
  iban: string | null;
  invoiceCount: number;
  invoiceTotal: number;
  invoiceRemaining: number;
}

export interface MappedLookup {
  contract: LookupContract;
  parties: LookupParties;
  financial: LookupFinancial;
  invoices: LookupInvoice[];
  /** Get Contracts only — null / [] when the lookup used Details. */
  property: LookupProperty | null;
  units: LookupUnit[];
  /** The Get Contracts resource the mapping used (the import persists from it). */
  contractsResource: JsonApiResource | null;
}

export type RequiredSection = "landlord" | "tenant" | "property" | "unit" | "contract";
export interface RequiredEntry {
  key: string;
  section: RequiredSection;
  /** true: must be supplied unless an existing record is picked for the section. */
  required: boolean;
  reason: string;
}

const str = (v: unknown): string | null => (v == null || `${v}`.trim() === "" ? null : `${v}`.trim());
const num = (v: unknown): number | null => {
  if (v == null || `${v}`.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const date10 = (v: unknown) => str(v)?.slice(0, 10) ?? null;

function bilingual(v: unknown): Bilingual | null {
  if (v && typeof v === "object") {
    const o = v as Attrs;
    const en = str(o.en);
    const ar = str(o.ar);
    return en || ar ? { en, ar } : null;
  }
  const s = str(v);
  return s ? { en: s, ar: null } : null;
}

const asArray = <T>(v: T | T[] | null | undefined): T[] => (Array.isArray(v) ? v : v ? [v] : []);
const included = (body: EjarBody | null | undefined): JsonApiResource[] => (Array.isArray(body?.included) ? body!.included! : []);
const byType = (body: EjarBody | null | undefined, type: string) => included(body).filter((r) => r.type === type);
function find(body: EjarBody | null | undefined, ref: JsonApiRef | null | undefined): JsonApiResource | null {
  if (!ref) return null;
  return included(body).find((r) => r.type === ref.type && String(r.id) === String(ref.id)) ?? null;
}
function relOne(res: JsonApiResource | null | undefined, name: string): JsonApiRef | null {
  const d = res?.relationships?.[name]?.data;
  return Array.isArray(d) ? d[0] ?? null : d ?? null;
}

/** Contract numbers are digits; Arabic-Indic digits and spaces are tolerated. */
export function normalizeContractNumber(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s-]/g, "");
  return /^\d{5,20}$/.test(s) ? s : null;
}

/**
 * The contract UUID from an Invoices body: the `rental_invoices_contracts`
 * resource id (preferring the one whose contract_no matches), else the
 * rental fee's contract_id. Null when the body carries no contract.
 */
export function lookupUuid(invoices: EjarBody | null | undefined, contractNumber: string): string | null {
  const data = asArray(invoices?.data as JsonApiResource | JsonApiResource[] | null | undefined);
  const hit = data.find((r) => str(r.attributes?.contract_no) === contractNumber) ?? data[0];
  const candidates = [hit?.id, ...byType(invoices, "rental_fees").map((r) => r.attributes?.contract_id)];
  for (const c of candidates) {
    const s = str(c);
    if (s && EJAR_UUID_RE.test(s)) return s;
  }
  return null;
}

/** Ejar's English payment status as a stable key: "Partially Paid" → "partially_paid". */
function statusKey(label: Bilingual | null): string | null {
  const en = label?.en?.toLowerCase().trim();
  if (en) return en.replace(/[\s-]+/g, "_");
  const ar = label?.ar ?? "";
  if (/جزئ/.test(ar)) return "partially_paid";
  if (/غير مدفوع/.test(ar)) return "unpaid";
  if (/مدفوع/.test(ar)) return "paid";
  return null;
}

export function mapLookupInvoices(invoices: EjarBody | null | undefined): LookupInvoice[] {
  return byType(invoices, "payments")
    .map((r) => {
      const a = r.attributes || {};
      const label = bilingual(a.payment_status);
      return {
        id: String(r.id),
        sequenceNumber: str(a.sequence_number) ?? str(a.payment_schedule_sequence_number),
        issueDate: date10(a.invoice_issue_date),
        dueDate: date10(a.invoice_due_date),
        lateDate: date10(a.invoice_late_date),
        amount: num(a.invoice_amount),
        remaining: num(a.invoice_remaining_amount),
        status: statusKey(label),
        statusLabel: label,
      };
    })
    .sort((x, y) => String(x.dueDate ?? "").localeCompare(String(y.dueDate ?? "")));
}

function mapParty(details: EjarBody | null | undefined, cp: JsonApiResource): LookupParty {
  const a = cp.attributes || {};
  const orgRef = relOne(cp, "organization_entity");
  const indRef = relOne(cp, "individual_entity");
  const entityType = String(a.contract_party_entity_type ?? "");
  const isOrg = !!orgRef || (/organization/i.test(entityType) && !indRef);
  const entity = find(details, orgRef ?? indRef);
  const e = entity?.attributes || {};
  return {
    role: String(a.contract_party_role ?? "").trim().toLowerCase() || "unknown",
    kind: isOrg ? "organization" : "individual",
    name: str(e.name) ?? str(e.full_name),
    crNumber: isOrg ? str(e.registration_number) ?? str(e.cr_number) : null,
    unifiedNumber: isOrg ? str(e.unified_number) : null,
    organizationType: isOrg ? str(e.organization_type) : null,
    idType: isOrg ? null : str(e.id_type),
    idNumber: isOrg ? null : str(e.id_number) ?? str(e.national_id),
    approved: typeof a.approved === "boolean" ? a.approved : null,
    phone: null,
    email: null,
    vatNumber: null,
  };
}

export function mapLookupParties(details: EjarBody | null | undefined): LookupParties {
  const contract = asArray(details?.data as JsonApiResource | JsonApiResource[] | null | undefined)[0];
  const refs = asArray(contract?.relationships?.contract_parties?.data as JsonApiRef | JsonApiRef[] | null | undefined);
  // Follow the contract's own list when it has one; otherwise every
  // contract_parties resource that was included.
  const resources = refs.length
    ? refs.map((r) => find(details, r)).filter((r): r is JsonApiResource => !!r)
    : byType(details, "contract_parties");
  const out: LookupParties = { lessor: null, tenant: null, lessorRepresentative: null, tenantRepresentative: null, others: [] };
  const slot: Record<string, keyof Omit<LookupParties, "others">> = {
    lessor: "lessor", tenant: "tenant",
    lessor_representative: "lessorRepresentative", tenant_representative: "tenantRepresentative",
  };
  for (const r of resources) {
    const p = mapParty(details, r);
    const k = slot[p.role];
    if (k && !out[k]) out[k] = p;
    else out.others.push(p);
  }
  return out;
}

function ridEnabled(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const en = bilingual(v)?.en?.toLowerCase() ?? "";
  if (en === "enabled") return true;
  if (en === "disabled") return false;
  return null;
}

/** Only plain digits count as an identifier: Ejar sends some numbers as encrypted blobs. */
const digits = (v: unknown, min = 5): string | null => {
  const t = str(v);
  return t && new RegExp(`^\\d{${min},20}$`).test(t) ? t : null;
};

/** One `lessors[]` / `tenants[]` entry of a Get Contracts resource. */
function mapListParty(p: Attrs, fallbackRole: string): LookupParty {
  const type = str(p.type)?.toLowerCase() ?? null;
  const isOrg = type ? type !== "individual" : !!digits(p.registration_number);
  const vat = digits(p.vat, 15);
  return {
    role: str(p.role)?.toLowerCase() ?? fallbackRole,
    kind: isOrg ? "organization" : "individual",
    name: str(p.name) ?? str(p.full_name),
    crNumber: isOrg ? digits(p.registration_number) ?? digits(p.cr_number) ?? digits(p.commercial_registration) ?? digits(p.id_number) : null,
    unifiedNumber: isOrg ? digits(p.unified_number) : null,
    organizationType: isOrg ? str(p.organization_type) ?? (type && type !== "organization" ? type : null) : null,
    idType: str(p.id_type),
    idNumber: isOrg ? null : digits(p.id_number),
    approved: typeof p.approved === "boolean" ? p.approved : null,
    phone: str(p.phone_number) ?? str(p.phone),
    email: str(p.email),
    vatNumber: vat && vat.length === 15 ? vat : null,
  };
}

function listParties(r: JsonApiResource): LookupParties {
  const a = r.attributes || {};
  const out: LookupParties = { lessor: null, tenant: null, lessorRepresentative: null, tenantRepresentative: null, others: [] };
  const slot: Record<string, keyof Omit<LookupParties, "others">> = {
    lessor: "lessor", tenant: "tenant",
    lessor_representative: "lessorRepresentative", tenant_representative: "tenantRepresentative",
  };
  const all = [
    ...asArray(a.lessors as Attrs[] | null).map((p) => mapListParty(p, "lessor")),
    ...asArray(a.tenants as Attrs[] | null).map((p) => mapListParty(p, "tenant")),
  ];
  for (const p of all) {
    const k = slot[p.role];
    if (k && !out[k]) out[k] = p;
    else out.others.push(p);
  }
  return out;
}

/**
 * The Get Contracts resource for this contract: the one whose contract number
 * (or id) matches. Null when the body holds none — a renewed contract's list
 * entry carries the older version's id, so the query by the Invoices UUID
 * comes back empty (verified on staging).
 */
export function pickContractsResource(body: EjarBody | null | undefined, contractNumber: string | null, uuid?: string | null): JsonApiResource | null {
  const data = asArray(body?.data as JsonApiResource | JsonApiResource[] | null | undefined);
  return (
    data.find((r) => contractNumber && str(r.attributes?.contract_number) === contractNumber) ??
    data.find((r) => uuid && (String(r.id) === uuid || str(r.attributes?.contract_id) === uuid)) ??
    null
  );
}

export function mapsUrl(lat: number | null, lng: number | null): string | null {
  if (lat == null || lng == null || (lat === 0 && lng === 0)) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

const boolOf = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : null;

export function mapLookup(
  invoicesBody: EjarBody | null | undefined,
  detailsBody: EjarBody | null | undefined,
  contractsBody?: EjarBody | null,
  contractNumber?: string | null,
): MappedLookup {
  const fee = byType(invoicesBody, "rental_fees")[0]?.attributes || {};
  const invoices = mapLookupInvoices(invoicesBody);
  const financialBase = {
    totalRentAmount: num(fee.total_rent_amount),
    paymentFrequency: bilingual(fee.payment_frequency),
    recurringPayment: bilingual(fee.recurring_payment),
    invoiceCount: invoices.length,
    invoiceTotal: round2(invoices.reduce((s, i) => s + (i.amount ?? 0), 0)),
    invoiceRemaining: round2(invoices.reduce((s, i) => s + (i.remaining ?? 0), 0)),
  };

  const listed = contractsBody ? pickContractsResource(contractsBody, contractNumber ?? null, lookupUuid(invoicesBody, contractNumber ?? "")) : null;
  if (listed) {
    const a = listed.attributes || {};
    const region = a.region && typeof a.region === "object" ? (a.region as Attrs) : null;
    const lat = num(a.latitude);
    const lng = num(a.longitude);
    const brokerName = str(a.broker_name);
    const brokerId = digits(a.broker_national_id);
    return {
      contract: {
        source: "contracts",
        ejarId: str(a.contract_id) ?? String(listed.id),
        contractNumber: str(a.contract_number),
        contractType: str(a.contract_type)?.toLowerCase() ?? null,
        state: str(a.status),
        status: str(a.status),
        startDate: date10(a.start_time ?? a.start_date),
        endDate: date10(a.end_time ?? a.end_date),
        registeredAt: str(a.created_time),
        version: null,
        securityDeposit: num(a.security_deposit_value),
        currency: null,
        ridServiceEnabled: null,
        totalValue: num(a.total_value),
        paymentFrequency: str(a.payment_frequency),
        autoRenewal: boolOf(a.auto_renewal_enabled),
        broker: brokerName || brokerId ? { name: brokerName, nationalId: brokerId } : null,
        ejarFee: num(a.contract_creation_ejar_fee),
        subleaseAllowed: boolOf(a.sublease_allowed),
        unifiedNumber: digits(a.unified_number),
        companyCrNumber: digits(a.company_cr_number),
        periodDays: num(a.period),
        daysRemaining: num(a.days_remaining),
        installmentValue: num(a.installment_value),
        installmentCount: num(a.installment_count),
      },
      parties: listParties(listed),
      financial: { ...financialBase, iban: null },
      invoices,
      property: str(a.property_id) || str(a.property_name)
        ? {
            ejarId: str(a.property_id),
            name: str(a.property_name),
            type: str(a.property_type),
            region: region ? { key: str(region.key), nameAr: str(region.name_ar), nameEn: str(region.name_en) } : null,
            latitude: lat,
            longitude: lng,
            mapsUrl: mapsUrl(lat, lng),
            unitCount: num(a.unit_count),
          }
        : null,
      units: asArray(a.units as Attrs[] | null).map((u) => ({
        ejarId: str(u.id) ?? str(u.unit_id),
        unitNumber: str(u.unit_number),
        unitType: str(u.unit_type),
        floor: num(u.floor_number ?? u.floor),
        area: num(u.area ?? u.unit_area),
        rooms: num(u.rooms ?? u.rooms_count ?? u.bedrooms),
        usage: str(u.unit_usage ?? u.usage),
        raw: { ...u },
      })),
      contractsResource: listed,
    };
  }

  const contract = asArray(detailsBody?.data as JsonApiResource | JsonApiResource[] | null | undefined)[0] ?? null;
  const a = contract?.attributes || {};
  const fin = find(detailsBody, relOne(contract, "financial_information")) ?? byType(detailsBody, "financial_informations")[0] ?? null;
  const f = fin?.attributes || {};
  const major = str(a.major_version);
  const minor = str(a.minor_version);
  return {
    contract: {
      source: "details",
      ejarId: contract ? String(contract.id) : null,
      contractNumber: str(a.contract_number),
      contractType: str(a.contract_type)?.toLowerCase() ?? null,
      state: str(a.state),
      status: str(a.state),
      startDate: date10(a.contract_start_date),
      endDate: date10(a.contract_end_date),
      registeredAt: str(a.created_at),
      version: major ? (minor ? `${major}.${minor}` : major) : null,
      securityDeposit: num(a.security_deposit_amount) ?? num(f.security_deposit_amount),
      currency: str(a.security_deposit_amount_currency) ?? str(f.security_deposit_amount_currency),
      ridServiceEnabled: ridEnabled(a.rid_service_enabled),
      totalValue: null,
      paymentFrequency: null,
      autoRenewal: null,
      broker: null,
      ejarFee: null,
      subleaseAllowed: null,
      unifiedNumber: null,
      companyCrNumber: null,
      periodDays: null,
      daysRemaining: null,
      installmentValue: null,
      installmentCount: null,
    },
    parties: mapLookupParties(detailsBody),
    financial: { ...financialBase, iban: str(f.iban_number) },
    invoices,
    property: null,
    units: [],
    contractsResource: null,
  };
}

/** Every identifier a party can be matched on locally (CR, unified, ID). */
export function partyIdentifiers(p: LookupParty | null | undefined): string[] {
  if (!p) return [];
  return [p.crNumber, p.unifiedNumber, p.idNumber].filter((v): v is string => !!v);
}

/** Contract numbers, CRs and IDs: digits only, Arabic-Indic digits and spaces tolerated. */
export function normalizeIdentifier(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s-]/g, "");
}

/**
 * Everything a landlord CR typed at the inquiry may match: each LESSOR's CR,
 * unified number or national ID (lessor-role parties only — a representative
 * is not the landlord), plus the contract's own `company_cr_number`.
 */
export function lessorIdentifiers(m: Pick<MappedLookup, "parties" | "contract">): string[] {
  const p = m.parties;
  const lessors = [p.lessor, ...p.others].filter((x): x is LookupParty => !!x && x.role === "lessor");
  const ids = [...lessors.flatMap((x) => partyIdentifiers(x)), m.contract.companyCrNumber];
  return [...new Set(ids.filter((v): v is string => !!v))];
}

/** Every identifier of the contract's tenant side (tenant-role parties; never a representative). */
export function tenantIdentifiers(m: Pick<MappedLookup, "parties">): string[] {
  const p = m.parties;
  const tenants = [p.tenant, ...p.others].filter((x): x is LookupParty => !!x && x.role === "tenant");
  return [...new Set(tenants.flatMap((x) => partyIdentifiers(x)))];
}

/** Is `id` one of this contract's lessors (landlord) or tenants (tenant)? */
export function partyMatches(m: Pick<MappedLookup, "parties" | "contract">, role: "landlord" | "tenant", id: unknown): boolean {
  const v = normalizeIdentifier(id);
  if (!v) return false;
  return (role === "landlord" ? lessorIdentifiers(m) : tenantIdentifiers(m)).includes(v);
}

/** All identifiers on the contract — used for the locked-account rule. */
export function allPartyIdentifiers(parties: LookupParties): string[] {
  return [parties.lessor, parties.tenant, parties.lessorRepresentative, parties.tenantRepresentative, ...parties.others]
    .flatMap((p) => partyIdentifiers(p));
}

const PICK = "pick an existing record instead to skip this";

/** What the server could already resolve from Ejar's values (lookup ids) and the account (matches). */
export interface RequiredContext {
  resolved?: {
    propertyTypeId: number | null;
    usageId: number | null;
    cityId: number | null;
    /** One per Ejar unit, in order. */
    unitTypeIds: Array<number | null>;
  };
  matches?: {
    landlord: unknown | null;
    tenant: unknown | null;
    property: unknown | null;
    /** Ejar unit UUIDs already in the account. */
    unitEjarIds?: string[];
  };
}

/**
 * What the user still has to supply before an import can run.
 *
 * Decided from what a manually created contract has (ContractWizardV2 + the
 * create endpoints) against what Ejar gave:
 *  - the property needs a landlord, and the contract a tenant record (wizard
 *    step 2). An organization arrives with its CR. An individual arrives with
 *    an ID number from Get Contracts, but NOT from Details — then it has to be
 *    typed for a new record (parties are never linked to existing ones; the
 *    writer only dedupes by ID/CR).
 *  - property: name, type and city are what POST /properties requires; usage
 *    is what decides rent VAT (DARA-NOTES §4). Get Contracts gives the name
 *    and type, usage follows the contract type and the city the region when
 *    those resolve to lookup options; Details gives none of it.
 *  - unit: number and type are what POST /properties/:id/units requires; Get
 *    Contracts gives both. A mixed-use property also needs the unit's own
 *    usage (checked at import).
 *  - contract: dates, rent schedule and deposit all come from Ejar. Rent VAT
 *    is never asked: usage decides it, else Ejar's contract type.
 *  - landlord/tenant are never linked to existing records: a matched party
 *    in ctx is ignored for that reason by the callers (they pass none).
 * Phone/email are never required — no manual path requires them either.
 */
export function computeRequired(m: MappedLookup | LookupParties, ctx: RequiredContext = {}): RequiredEntry[] {
  // Back-compat: a bare parties object means a Details lookup with no context.
  const mapped: Pick<MappedLookup, "parties" | "property" | "units"> =
    "parties" in m ? m : { parties: m, property: null, units: [] };
  const { parties } = mapped;
  const out: RequiredEntry[] = [];
  const partyEntries = (section: "landlord" | "tenant", p: LookupParty | null, matched: boolean) => {
    const who = section === "landlord" ? "lessor" : "tenant";
    if (matched) return; // linked to the account's own record automatically
    if (!p) {
      out.push({ key: `${section}.name`, section, required: true, reason: `Ejar lists no ${who} on this contract; ${PICK}.` });
      out.push({ key: `${section}.idNumber`, section, required: false, reason: `Ejar lists no ${who}; the ID number is optional.` });
    } else if (p.kind === "individual" && !p.idNumber) {
      out.push({ key: `${section}.idNumber`, section, required: true, reason: `Ejar did not return this ${who}'s ID number; type it, or ${PICK}.` });
    }
    if (!p?.phone) out.push({ key: `${section}.phone`, section, required: false, reason: "Ejar did not return a phone number." });
    if (!p?.email) out.push({ key: `${section}.email`, section, required: false, reason: "Ejar did not return an email." });
  };
  partyEntries("landlord", parties.lessor, !!ctx.matches?.landlord);
  partyEntries("tenant", parties.tenant, !!ctx.matches?.tenant);

  const r = ctx.resolved;
  const ejarProp = mapped.property?.ejarId || mapped.property?.name ? mapped.property : null;
  if (!ctx.matches?.property) {
    const noProp = ejarProp ? "Ejar's value could not be matched to an option" : "Ejar did not return the property";
    const need = (key: string, have: boolean, why: string) =>
      out.push({ key, section: "property", required: !have, reason: have ? "From Ejar; a value here overrides it." : `${why}; ${PICK}.` });
    need("property.name", !!ejarProp?.name, ejarProp ? "Ejar returned no property name" : noProp);
    need("property.propertyTypeId", !!(ejarProp && r?.propertyTypeId), `A property needs a type (as when added manually) — ${noProp}`);
    need("property.usageId", !!r?.usageId, "Usage decides whether rent carries VAT");
    need("property.city", !!r?.cityId, "A property needs a city (as when added manually)");
    for (const k of ["district", "address", "deedNumber", "deedType"]) {
      out.push({ key: `property.${k}`, section: "property", required: false, reason: "Ejar does not return it." });
    }
  }
  const ejarUnits = mapped.units.filter((u) => u.unitNumber);
  const matchedUnits = new Set(ctx.matches?.unitEjarIds ?? []);
  const allUnitsMatched = ejarUnits.length > 0 && ejarUnits.every((u) => u.ejarId && matchedUnits.has(u.ejarId));
  if (!allUnitsMatched) {
    const typesKnown = ejarUnits.length > 0 && mapped.units.every((u, i) => (u.ejarId && matchedUnits.has(u.ejarId)) || r?.unitTypeIds?.[i]);
    out.push({
      key: "unit.unitNumber", section: "unit", required: ejarUnits.length === 0,
      reason: ejarUnits.length ? "From Ejar." : `Ejar did not return the unit; ${PICK}.`,
    });
    out.push({
      key: "unit.unitTypeId", section: "unit", required: !typesKnown,
      reason: typesKnown ? "From Ejar; a value here overrides it." : `A unit needs a type (as when added manually); ${PICK}.`,
    });
    out.push({ key: "unit.usageId", section: "unit", required: false, reason: "Required only when the property's usage is mixed (سكني - تجاري)." });
    if (!ejarUnits.length) {
      out.push({ key: "unit.floor", section: "unit", required: false, reason: "Ejar does not return it." });
      out.push({ key: "unit.area", section: "unit", required: false, reason: "Ejar does not return it." });
    }
  }
  // No contract.* keys: dates, schedule and deposit are Ejar's, and rent VAT
  // is decided server-side (usage, else the Ejar contract type).
  return out;
}

const blank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");

/**
 * The required keys an import body leaves unsatisfied. A section with an
 * `existingId` satisfies all of its keys; property/unit fields are read from
 * `<section>.new`, party fields from the section itself.
 */
export function missingRequired(required: RequiredEntry[], body: Record<string, any>): string[] {
  const missing: string[] = [];
  for (const r of required) {
    if (!r.required) continue;
    const sec = body?.[r.section];
    if (sec && sec.existingId != null && sec.existingId !== "") continue;
    const field = r.key.slice(r.section.length + 1);
    const holder = r.section === "property" || r.section === "unit" ? sec?.new : sec;
    if (blank(holder?.[field])) missing.push(r.key);
  }
  return missing;
}
