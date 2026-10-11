import {
  BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException,
} from "@nestjs/common";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { dateOnly, email as emailOf, nationalId, partyIdentityNumber, saudiPhone, text, LIMITS } from "../../common/validation";
import { MIXED_USAGE_KEY, rentVatFromUsage } from "../../common/usage-vat";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { FinanceV2Hooks } from "../finance-v2/hooks/hooks.service"; // finance-v2: E26 — Ejar-paid becomes settled_external (DESIGN §9 E7)
import {
  allPartyIdentifiers, computeRequired, missingRequired, normalizeContractNumber,
  type LookupParty, type MappedLookup,
} from "./ejar.lookup.map";
import { summarizeInvoices, normalizeStatus, type EjarPartyInfo } from "./ejar.map";
import type { EjarLookupStore } from "./ejar.lookup.store";
import {
  BAD_FORMAT_MESSAGE, EJAR_LOOKUP_STORE, SCOPE_MISMATCH_MESSAGE, lookupContext, mapSaved, matchedUnitEjarIds,
} from "./ejar.lookup.service";
import { EjarImportWriter, type ImportPlan, type ImportResult, type PartyChoice } from "./ejar.import.writer";
import type { EjarBody } from "./ejar.types";

export const EJAR_IMPORT_RUNNER = Symbol("EJAR_IMPORT_RUNNER");

/** Writes a validated plan. The real one is transactional; tests fake it. */
export interface EjarImportRunnerLike {
  run(ownerId: number, plan: ImportPlan): Promise<ImportResult>;
}

/**
 * Persist a plan in one transaction, then stamp Ejar's invoice identity onto
 * the generated installments once it has committed (the finance-v2 attach
 * reads them through its own pool connection, which cannot see uncommitted
 * rows). The attach never fails the import — as before.
 */
@Injectable()
export class EjarImportRunner implements EjarImportRunnerLike {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}
  @Inject(FinanceV2Hooks) private readonly fv2h?: FinanceV2Hooks; // finance-v2: property-injected, so the constructor is untouched

  async run(ownerId: number, plan: ImportPlan): Promise<ImportResult> {
    const fv2 = (await this.fv2h?.resolve(ownerId)) === true; // finance-v2: E26
    const { result, installments } = await this.db.transaction((tx) => new EjarImportWriter(tx as never).persist(ownerId, plan));
    if (installments.length && plan.invoices.length) {
      try {
        if (fv2) await this.fv2h!.ejarAttachV2({ fv2, userId: ownerId }, installments, plan.invoices as any[]); // finance-v2: v2 replaces the attach step (E7)
        else await new EjarImportWriter(this.db).attachEjarInvoices(installments, plan.invoices); // finance-v2: flag off → the legacy attach, unchanged
      } catch {
        // The contract and its schedule are saved; only the invoice stamps are missing.
      }
    }
    return result;
  }
}

const blank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");
const idOf = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
};

/** A phone in the canonical bare form the manual forms store, or as Ejar sent it. */
function canonicalPhone(v: string | null): string | null {
  if (!v) return null;
  try { return saudiPhone(v) ?? v; } catch { return v; }
}

/**
 * A Ejar lookup party in the shape the existing upserts take. What Ejar said
 * wins; what the user typed only fills gaps (Details gives names only; Get
 * Contracts usually gives ID, phone and email too).
 */
function partyInfo(
  p: LookupParty | null, group: "tenant" | "lessor", typed: { idNumber?: string | null; phone?: string | null; email?: string | null; name?: string | null },
): EjarPartyInfo | null {
  const name = p?.name ?? typed.name ?? null;
  if (!p && !name) return null;
  const isOrg = p?.kind === "organization";
  // Only what Ejar itself said goes into ejar_raw: the locks read it, and a
  // field the user typed (an individual's ID number) must stay editable.
  const raw: Record<string, unknown> = p
    ? {
        role: p.role, name: p.name, type: isOrg ? "organization" : "individual",
        ...(p.crNumber ? { registration_number: p.crNumber } : {}),
        ...(p.unifiedNumber ? { unified_number_ejar: p.unifiedNumber } : {}),
        ...(p.organizationType ? { organization_type: p.organizationType } : {}),
        ...(p.idType ? { id_type: p.idType } : {}),
        ...(p.idNumber ? { id_number: p.idNumber } : {}),
        ...(p.phone ? { phone_number: p.phone } : {}),
        ...(p.email ? { email: p.email } : {}),
        ...(p.vatNumber ? { unified_number: p.vatNumber } : {}),
        approved: p.approved,
      }
    : {};
  return {
    group,
    role: p?.role ?? group,
    isRepresentative: false,
    name,
    partyType: isOrg ? "organization" : "individual",
    idType: p?.idType ?? null,
    idNumber: isOrg ? null : (p?.idNumber ?? typed.idNumber ?? null),
    phone: canonicalPhone(p?.phone ?? null) ?? typed.phone ?? null,
    email: p?.email?.toLowerCase() ?? typed.email ?? null,
    // The upserts write this into tax_number, a VAT number: only ever a real
    // 15-digit VAT number from Ejar, never a CR / unified number.
    unifiedNumber: p?.vatNumber ?? null,
    registrationNumber: isOrg ? p?.crNumber ?? null : null,
    organizationType: p?.organizationType ?? null,
    vat: p?.vatNumber ?? null,
    nationality: !isOrg && (p?.idType ?? "").toLowerCase() === "national_id" ? "سعودي" : null,
    raw: p ? raw : (null as never),
  };
}

function repInfo(p: LookupParty | null, group: "tenant" | "lessor"): EjarPartyInfo | null {
  if (!p) return null;
  return { ...partyInfo(p, group, {})!, isRepresentative: true };
}

/** Months covered by [start, end], at least 1 — monthly rent is total / months, as the wizard stores it. */
function contractMonths(start: string, end: string): number {
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  return Math.max(1, Math.round(days / (365.25 / 12)));
}

/**
 * Ejar Import v2 — turn a saved lookup plus what the user completed into a
 * full local record. Never calls Ejar.
 */
@Injectable()
export class EjarImportService {
  constructor(
    @Inject(EJAR_LOOKUP_STORE) private readonly store: EjarLookupStore,
    @Inject(EJAR_IMPORT_RUNNER) private readonly runner: EjarImportRunnerLike,
  ) {}

  async import(user: AuthUser, body: Record<string, any>): Promise<ImportResult> {
    const contractNumber = normalizeContractNumber(body?.contract_number);
    if (!contractNumber) throw new BadRequestException({ code: "bad_format", message: BAD_FORMAT_MESSAGE });
    const accountId = scopeId(user);

    const saved = await this.store.getLookup(accountId, contractNumber);
    if (!saved) {
      throw new ConflictException({
        code: "no_lookup",
        message: "استعلم عن العقد من إيجار أولاً · Look the contract up in Ejar first.",
      });
    }
    const imported = await this.store.findImported(accountId, contractNumber);
    if (imported) {
      throw new ConflictException({
        code: "already_imported", contractId: imported.contractId,
        message: `العقد ${contractNumber} مستورد مسبقًا (#${imported.contractId}) · Already imported.`,
      });
    }

    const mapped = mapSaved(saved);
    const scope = await this.store.scope(accountId);
    if (scope.locked && !allPartyIdentifiers(mapped.parties).includes(scope.idNumber!)) {
      throw new ForbiddenException({ code: "scope_mismatch", message: SCOPE_MISMATCH_MESSAGE });
    }

    // ── Picked records must be the caller's own ──
    const notInAccount = (key: string) =>
      new NotFoundException({ code: "not_in_account", key, message: `${key} غير موجود في حسابك · ${key} was not found in your account.` });
    const existing = async <T>(section: string, find: (id: number) => Promise<T | null>): Promise<T | null> => {
      const raw = body?.[section]?.existingId;
      if (blank(raw)) return null;
      const id = idOf(raw);
      if (id == null) throw new BadRequestException({ code: "invalid_field", key: `${section}.existingId`, message: `${section}.existingId is not a valid id` });
      const row = await find(id);
      if (!row) throw notInAccount(`${section}.existingId`);
      return row;
    };
    const landlordRow = await existing("landlord", (id) => this.store.landlord(accountId, id));
    const tenantRow = await existing("tenant", (id) => this.store.tenant(accountId, id));
    const propertyRow = await existing("property", (id) => this.store.property(accountId, id));
    const unitRow = await existing("unit", (id) => this.store.unit(accountId, id));
    if (unitRow && (!propertyRow || unitRow.propertyId !== propertyRow.id)) {
      throw new BadRequestException({
        code: "invalid_field", key: "unit.existingId",
        message: "الوحدة المختارة لا تتبع العقار المختار · The chosen unit does not belong to the chosen property.",
      });
    }

    // ── What still has to be supplied — decided exactly as the lookup decided it ──
    const { matches, resolved } = await lookupContext(this.store, accountId, mapped);
    const required = computeRequired(mapped, {
      resolved, matches: { ...matches, unitEjarIds: matchedUnitEjarIds(mapped, matches.units) },
    });
    const missing = new Set(missingRequired(required, body));

    const lookupKey = async (key: string, category: string, value: unknown): Promise<{ id: number; key: string } | null> => {
      if (blank(value)) return null;
      const id = idOf(value);
      const row = id != null ? await this.store.lookupRow(id) : null;
      if (!row || row.category !== category) {
        throw new BadRequestException({ code: "invalid_field", key, message: `${key} is not a valid ${category} option` });
      }
      return { id: row.id, key: row.key };
    };
    const keyOf = async (id: number | null) => (id ? (await this.store.lookupRow(id))?.key ?? null : null);

    const ejarProp = mapped.property && (mapped.property.ejarId || mapped.property.name) ? mapped.property : null;
    const ejarUnits = mapped.units.filter((u) => u.unitNumber);
    const pNew = propertyRow ? null : (body?.property?.new ?? {});
    const uNew = unitRow ? null : (body?.unit?.new ?? {});
    const propType = pNew ? await lookupKey("property.propertyTypeId", "property_type", pNew.propertyTypeId) : null;
    const propUsage = pNew ? await lookupKey("property.usageId", "property_usage", pNew.usageId) : null;
    const unitType = uNew ? await lookupKey("unit.unitTypeId", "unit_type", uNew.unitTypeId) : null;
    const unitUsage = uNew ? await lookupKey("unit.usageId", "property_usage", uNew.usageId) : null;

    // Usage decides rent VAT, exactly as on a manual contract. A typed value
    // wins; otherwise Ejar's contract type (residential / commercial).
    const propUsageId = propertyRow ? propertyRow.usageLookupId : propUsage?.id ?? resolved.usageId;
    const propUsageKey = propertyRow ? await keyOf(propertyRow.usageLookupId) : propUsage?.key ?? (await keyOf(resolved.usageId));
    const unitUsageKey = unitRow ? await keyOf(unitRow.usageLookupId) : unitUsage?.key ?? null;
    if (propUsageKey === MIXED_USAGE_KEY && !unitRow && !unitUsage) missing.add("unit.usageId");
    const derivedVat = rentVatFromUsage(propUsageKey, unitUsageKey);
    const chosenVat = typeof body?.contract?.vatEnabled === "boolean" ? body.contract.vatEnabled : null;
    // Ask for the VAT choice only when no missing usage would have decided it.
    if (derivedVat === null && chosenVat === null && !missing.has("property.usageId") && !missing.has("unit.usageId")) {
      missing.add("contract.vatEnabled");
    }

    if (missing.size) {
      throw new BadRequestException({
        code: "missing_fields", missing: [...missing],
        message: `بيانات ناقصة: ${[...missing].join(", ")} · Missing: ${[...missing].join(", ")}`,
      });
    }

    // ── Shape/format of what was typed (same rules as the manual forms) ──
    const typedParty = (section: "landlord" | "tenant", p: LookupParty | null) => {
      const s = body?.[section] ?? {};
      const label = section === "landlord" ? "المؤجر" : "المستأجر";
      return {
        name: text(s.name, `اسم ${label}`, LIMITS.name),
        // Only read when Ejar gave none — what Ejar said is not overridden.
        idNumber: p?.kind === "organization" || p?.idNumber
          ? null
          : p ? nationalId(s.idNumber, `رقم هوية ${label}`) : partyIdentityNumber(s.idNumber, null, `رقم هوية ${label}`),
        phone: saudiPhone(s.phone, `جوال ${label}`),
        email: emailOf(s.email, `بريد ${label} الإلكتروني`),
      };
    };
    const landlord: PartyChoice = landlordRow
      ? { existingId: landlordRow.id }
      : { party: partyInfo(mapped.parties.lessor, "lessor", typedParty("landlord", mapped.parties.lessor)), rep: repInfo(mapped.parties.lessorRepresentative, "lessor") };
    const tenant: PartyChoice = tenantRow
      ? { existingId: tenantRow.id }
      : { party: partyInfo(mapped.parties.tenant, "tenant", typedParty("tenant", mapped.parties.tenant)), rep: repInfo(mapped.parties.tenantRepresentative, "tenant") };

    // City: a lookup id, or a lookup key / Arabic label; else Ejar's region if it resolved.
    let cityLookupId: number | null = null;
    if (pNew && !blank(pNew.city)) {
      const asId = idOf(pNew.city);
      cityLookupId = asId != null
        ? ((await this.store.lookupRow(asId))?.category === "city" ? asId : null)
        : await this.store.resolveLookup("city", String(pNew.city).trim());
      if (cityLookupId == null) {
        throw new BadRequestException({ code: "invalid_field", key: "property.city", message: "property.city is not a known city" });
      }
    }
    cityLookupId ??= resolved.cityId;
    const deed = pNew && !blank(pNew.deedNumber)
      ? { deedNumber: String(pNew.deedNumber).trim(), deedType: text(pNew.deedType, "نوع الصك") }
      : null;
    const typedP = pNew
      ? {
          name: text(pNew.name, "اسم العقار", LIMITS.name),
          district: text(pNew.district, "الحي", LIMITS.name),
          street: text(pNew.address, "العنوان", LIMITS.address),
          deedNumber: text(pNew.deedNumber, "رقم الصك", LIMITS.code),
        }
      : {};
    const lattrs = (mapped.contractsResource?.attributes ?? {}) as Record<string, unknown>;
    const property: ImportPlan["property"] = propertyRow
      ? { existingId: propertyRow.id }
      : ejarProp
        ? {
            // From Get Contracts: matched by Ejar UUID (upsertProperty), Ejar's
            // values locked; the user's input only fills what Ejar left out.
            create: {
              p: {
                ...typedP,
                ejarId: ejarProp.ejarId,
                name: ejarProp.name ?? (typedP as { name?: string | null }).name ?? null,
                propertyType: ejarProp.type,
                regionKey: ejarProp.region?.key ?? null,
                latitude: ejarProp.latitude,
                longitude: ejarProp.longitude,
              },
              raw: {
                property_id: lattrs.property_id ?? null, property_name: lattrs.property_name ?? null,
                property_type: lattrs.property_type ?? null, region: lattrs.region ?? null,
                latitude: lattrs.latitude ?? null, longitude: lattrs.longitude ?? null,
              },
              overrides: {
                ...(propType ? { typeLookupId: propType.id, typeOther: null } : {}),
                ...(propUsageId != null ? { usageLookupId: propUsageId } : {}),
                ...(cityLookupId != null ? { cityLookupId } : {}),
              },
              deed,
            },
          }
        : {
            create: {
              p: typedP,
              overrides: {
                typeLookupId: propType?.id ?? null,
                typeOther: null,
                usageLookupId: propUsageId ?? null,
                cityLookupId,
                ejarSource: null,
              },
              deed,
            },
          };

    const c = mapped.contract;
    const startDate = dateOnly(c.startDate, "تاريخ بداية العقد");
    const endDate = dateOnly(c.endDate, "تاريخ نهاية العقد");
    if (!startDate || !endDate) {
      throw new BadRequestException({ code: "incomplete_lookup", message: "Ejar returned no contract dates; look the contract up again." });
    }
    const status = normalizeStatus(c.state);
    const unitStatus = status === "active" || status === "pending" ? "rented" as const : "available" as const;
    const unitUsageLookupId = propUsageKey === MIXED_USAGE_KEY ? unitUsage?.id ?? null : null;
    // The property the units will sit on, when it already exists.
    const knownPropertyId = propertyRow?.id ?? matches.property?.id ?? null;

    let unit: ImportPlan["unit"];
    if (unitRow) {
      unit = { existingId: unitRow.id };
    } else if (ejarUnits.length) {
      // Ejar's units, reused by Ejar UUID under the property; one with the
      // same number already on an existing property is linked, not duplicated.
      const linkIds: number[] = [];
      const fresh: typeof ejarUnits = [];
      for (const u of ejarUnits) {
        const held = matches.units.find((m) => m.ejarId === u.ejarId && (!knownPropertyId || m.propertyId === knownPropertyId));
        const taken = !held && knownPropertyId ? await this.store.unitNumberTaken(knownPropertyId, u.unitNumber!) : null;
        if (taken) linkIds.push(taken);
        else fresh.push(u);
      }
      unit = {
        ejar: {
          units: fresh.map((u) => ({ ejarId: u.ejarId, unitNumber: u.unitNumber, unitType: u.unitType })),
          raw: Object.fromEntries(fresh.filter((u) => u.ejarId).map((u) => [u.ejarId!, { id: u.ejarId, unit_number: u.unitNumber, unit_type: u.unitType }])),
          overrides: {
            ...(unitType ? { typeLookupId: unitType.id, typeOther: null } : {}),
            ...(unitUsageLookupId != null ? { usageLookupId: unitUsageLookupId } : {}),
            status: unitStatus,
          },
          linkIds,
        },
      };
    } else {
      unit = {
        create: {
          u: { unitNumber: text(uNew!.unitNumber, "رقم الوحدة", LIMITS.code), floor: uNew!.floor, area: uNew!.area },
          overrides: {
            typeLookupId: unitType?.id ?? null,
            typeOther: null,
            usageLookupId: unitUsageLookupId,
            status: unitStatus,
            ejarSource: null,
          },
        },
      };
      if (knownPropertyId) {
        const taken = await this.store.unitNumberTaken(knownPropertyId, String(uNew!.unitNumber).trim());
        if (taken) {
          throw new ConflictException({
            code: "unit_exists", unitId: taken, key: "unit.unitNumber",
            message: "رقم الوحدة مستخدم في هذا العقار — اختر الوحدة الموجودة · That unit number exists on this property; pick it instead.",
          });
        }
      }
    }

    const plan: ImportPlan = {
      contractNumber,
      landlord, tenant, property, unit,
      contract: this.contractFields(mapped, startDate, endDate, status, chosenVat ?? derivedVat, body?.contract?.notes),
      additionalFees: Array.isArray(body?.additionalFees) ? body.additionalFees : [],
      invoices: summarizeInvoices(saved.invoicesBody as EjarBody | null),
    };
    return this.runner.run(accountId, plan);
  }

  private contractFields(
    m: MappedLookup, startDate: string, endDate: string, status: string, vat: boolean | null, notes: unknown,
  ): ImportPlan["contract"] {
    const customSchedule = m.invoices
      .filter((i) => i.dueDate && (i.amount ?? 0) > 0)
      .map((i) => ({ dueDate: i.dueDate!, amount: String(i.amount) }));
    const scheduleTotal = customSchedule.reduce((s, e) => s + Number(e.amount), 0);
    // Ejar's total rent is the whole contract, ex-VAT; invoices may carry VAT.
    const total = m.financial.totalRentAmount ?? m.contract.totalValue ?? scheduleTotal;
    const monthly = total > 0 ? total / contractMonths(startDate, endDate) : 0;
    return {
      startDate, endDate, status,
      signingDate: m.contract.registeredAt?.slice(0, 10) ?? null,
      monthlyRent: String(Math.round(monthly * 1e6) / 1e6),
      customSchedule,
      frequencyHint: m.financial.recurringPayment?.en ?? m.contract.paymentFrequency ?? m.financial.paymentFrequency?.en ?? null,
      depositAmount: m.contract.securityDeposit != null && m.contract.securityDeposit > 0 ? String(m.contract.securityDeposit) : null,
      vatEnabled: vat,
      notes: text(notes, "الملاحظات", LIMITS.notes),
      ejarRaw: {
        source: "ejar-lookup-v2",
        lookupSource: m.contract.source,
        ejarId: m.contract.ejarId,
        propertyId: m.property?.ejarId ?? null,
        autoRenewal: m.contract.autoRenewal,
        broker: m.contract.broker,
        contractType: m.contract.contractType,
        state: m.contract.state,
        version: m.contract.version,
        iban: m.financial.iban,
        totalRentAmount: m.financial.totalRentAmount,
      },
    };
  }
}
