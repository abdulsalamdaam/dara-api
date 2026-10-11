/**
 * Ejar Import v2 — reading the two lookup bodies.
 *
 * A lookup is exactly two Balady calls: Invoices (by contract number; carries
 * the contract UUID and the payment schedule) and Details (by UUID; carries
 * the contract facts and the parties). Both arrive as JSON:API bodies. This
 * file turns them into the lookup response, and decides what the user still
 * has to supply before the contract can be imported (`required[]`).
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
  /** Ejar does not send an individual's ID number today; kept if it ever does. */
  idNumber: string | null;
  approved: boolean | null;
}

export interface LookupParties {
  lessor: LookupParty | null;
  tenant: LookupParty | null;
  lessorRepresentative: LookupParty | null;
  tenantRepresentative: LookupParty | null;
  others: LookupParty[];
}

export interface LookupContract {
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

export function mapLookup(invoicesBody: EjarBody | null | undefined, detailsBody: EjarBody | null | undefined): MappedLookup {
  const contract = asArray(detailsBody?.data as JsonApiResource | JsonApiResource[] | null | undefined)[0] ?? null;
  const a = contract?.attributes || {};
  const fin = find(detailsBody, relOne(contract, "financial_information")) ?? byType(detailsBody, "financial_informations")[0] ?? null;
  const f = fin?.attributes || {};
  const fee = byType(invoicesBody, "rental_fees")[0]?.attributes || {};
  const invoices = mapLookupInvoices(invoicesBody);
  const major = str(a.major_version);
  const minor = str(a.minor_version);
  return {
    contract: {
      ejarId: contract ? String(contract.id) : null,
      contractNumber: str(a.contract_number),
      contractType: str(a.contract_type)?.toLowerCase() ?? null,
      state: str(a.state),
      startDate: date10(a.contract_start_date),
      endDate: date10(a.contract_end_date),
      registeredAt: str(a.created_at),
      version: major ? (minor ? `${major}.${minor}` : major) : null,
      securityDeposit: num(a.security_deposit_amount) ?? num(f.security_deposit_amount),
      currency: str(a.security_deposit_amount_currency) ?? str(f.security_deposit_amount_currency),
      ridServiceEnabled: ridEnabled(a.rid_service_enabled),
    },
    parties: mapLookupParties(detailsBody),
    financial: {
      totalRentAmount: num(fee.total_rent_amount),
      paymentFrequency: bilingual(fee.payment_frequency),
      recurringPayment: bilingual(fee.recurring_payment),
      iban: str(f.iban_number),
      invoiceCount: invoices.length,
      invoiceTotal: round2(invoices.reduce((s, i) => s + (i.amount ?? 0), 0)),
      invoiceRemaining: round2(invoices.reduce((s, i) => s + (i.remaining ?? 0), 0)),
    },
    invoices,
  };
}

/** Every identifier a party can be matched on locally (CR, unified, ID). */
export function partyIdentifiers(p: LookupParty | null | undefined): string[] {
  if (!p) return [];
  return [p.crNumber, p.unifiedNumber, p.idNumber].filter((v): v is string => !!v);
}

/** All identifiers on the contract — used for the locked-account rule. */
export function allPartyIdentifiers(parties: LookupParties): string[] {
  return [parties.lessor, parties.tenant, parties.lessorRepresentative, parties.tenantRepresentative, ...parties.others]
    .flatMap((p) => partyIdentifiers(p));
}

const PICK = "pick an existing record instead to skip this";

/**
 * What the user still has to supply before an import can run.
 *
 * Decided from what a manually created contract has (ContractWizardV2 + the
 * create endpoints) against what Ejar gives:
 *  - the property needs a landlord, and the contract a tenant record (wizard
 *    step 2). Ejar names both, but gives an individual no ID number at all —
 *    so an individual party needs one typed, or an existing record picked.
 *    An organization arrives with its CR and needs nothing.
 *  - property: name, type and city are what POST /properties requires; usage
 *    is what decides rent VAT (DARA-NOTES §4) — Ejar gives none of them.
 *  - unit: number and type are what POST /properties/:id/units requires; a
 *    mixed-use property also needs the unit's own usage (checked at import).
 *  - contract: dates, rent schedule and deposit all come from Ejar. VAT is
 *    derived from usage; only when usage cannot decide (no usage, or mixed
 *    with no unit usage) must the user choose it (checked at import).
 * Phone/email are never required — no manual path requires them either.
 */
export function computeRequired(parties: LookupParties): RequiredEntry[] {
  const out: RequiredEntry[] = [];
  const partyEntries = (section: "landlord" | "tenant", p: LookupParty | null) => {
    const who = section === "landlord" ? "lessor" : "tenant";
    if (!p) {
      out.push({ key: `${section}.name`, section, required: true, reason: `Ejar lists no ${who} on this contract; ${PICK}.` });
      out.push({ key: `${section}.idNumber`, section, required: false, reason: `Ejar lists no ${who}; the ID number is optional.` });
    } else if (p.kind === "individual" && !p.idNumber) {
      out.push({ key: `${section}.idNumber`, section, required: true, reason: `Ejar does not return an individual ${who}'s ID number; type it, or ${PICK}.` });
    }
    out.push({ key: `${section}.phone`, section, required: false, reason: "Ejar does not return contact details." });
    out.push({ key: `${section}.email`, section, required: false, reason: "Ejar does not return contact details." });
  };
  partyEntries("landlord", parties.lessor);
  partyEntries("tenant", parties.tenant);

  const noProp = "Ejar's contract details do not include the property";
  out.push({ key: "property.name", section: "property", required: true, reason: `${noProp}; ${PICK}.` });
  out.push({ key: "property.propertyTypeId", section: "property", required: true, reason: `A property needs a type (as when added manually); ${PICK}.` });
  out.push({ key: "property.usageId", section: "property", required: true, reason: `Usage decides whether rent carries VAT; ${PICK}.` });
  out.push({ key: "property.city", section: "property", required: true, reason: `A property needs a city (as when added manually); ${PICK}.` });
  for (const k of ["district", "address", "deedNumber", "deedType"]) {
    out.push({ key: `property.${k}`, section: "property", required: false, reason: `${noProp}.` });
  }
  const noUnit = "Ejar's contract details do not include the unit";
  out.push({ key: "unit.unitNumber", section: "unit", required: true, reason: `${noUnit}; ${PICK}.` });
  out.push({ key: "unit.unitTypeId", section: "unit", required: true, reason: `A unit needs a type (as when added manually); ${PICK}.` });
  out.push({ key: "unit.usageId", section: "unit", required: false, reason: "Required only when the property's usage is mixed (سكني - تجاري)." });
  out.push({ key: "unit.floor", section: "unit", required: false, reason: `${noUnit}.` });
  out.push({ key: "unit.area", section: "unit", required: false, reason: `${noUnit}.` });
  out.push({
    key: "contract.vatEnabled", section: "contract", required: false,
    reason: "Required only when the chosen property/unit usage cannot decide rent VAT (no usage, or mixed-use with no unit usage).",
  });
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
