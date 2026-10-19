import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  contractsTable, paymentsTable, propertiesTable, unitsTable, contractUnitsTable,
  ownersTable, deedsTable, tenantsTable,
} from "@dara/database";
import { buildInstallments } from "../contracts/installments";
import { resolveLookupId } from "../../common/lookups-resolve";
import type { Drizzle } from "../../database/database.module";
import { ejarInvoiceDescription, mapEjarStatusLegacy, matchEjarInvoices } from "../finance-v2/hooks/classify"; // finance-v2: 11a/11b/11i — one reading of Ejar invoices for both paths
import { ejarRentVatVerdict } from "./ejar-rent-vat"; // finance-v2: 11g — rent VAT by usage, as the manual wizard
import { ejarLandlordCapGate } from "./ejar.landlord-cap"; // finance-v2: n/a — plan landlord cap (CONTRACT2 §5)
import type { EjarPartyInfo, EjarInvoiceRow } from "./ejar.map";
import {
  EJAR_PROPERTY_TYPE, EJAR_UNIT_TYPE, EJAR_USAGE, EJAR_DIRECTION, EJAR_FINISHING,
  EJAR_FURNISHING, EJAR_DEED_TYPE, EJAR_UNIT_STATUS, mapEjarValue, lookupOrOther, partyKind, asBool,
} from "./ejar.import";

/*
 * The Ejar import's write side: Landlord -> Deed -> Property -> Unit(s) ->
 * Tenant -> Contract + schedule. Moved out of the controller unchanged so the
 * v2 import (a saved lookup plus what the user typed) feeds the same code the
 * old preview-based import did. Everything here takes its db handle from the
 * constructor, so the runner can hand it a transaction.
 */

/** A Google Maps link from Ejar coordinates, or null when it sent none. */
function mapsUrl(lat: unknown, lng: unknown): string | null {
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) return null;
  return `https://www.google.com/maps?q=${a},${b}`;
}

/**
 * The owners named on the deed, taken from the Ejar property's `owners` list.
 * Deduped on name+id because the same person often appears on both the
 * property and its units. Returns null (not []) when Ejar sent none, so a
 * re-import can't blank a list the user filled in by hand — see onlyPresent().
 */
function deedOwnersFrom(p: Record<string, unknown>): Array<{ name: string; idNumber: string | null }> | null {
  const raw = Array.isArray(p.owners) ? (p.owners as Array<Record<string, unknown>>) : [];
  const seen = new Set<string>();
  const out: Array<{ name: string; idNumber: string | null }> = [];
  for (const o of raw) {
    const name = o?.name == null ? "" : String(o.name).trim();
    if (!name) continue;
    const idNumber = o?.id == null || String(o.id).trim() === "" ? null : String(o.id).trim();
    const key = `${name}|${idNumber ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, idNumber });
  }
  return out.length ? out : null;
}

/**
 * Drop null/undefined keys before an UPDATE. Re-importing a contract refreshes
 * the property/unit with the latest Ejar detail, but Ejar leaves plenty of
 * fields empty — without this, a refresh would wipe values the user had filled
 * in by hand.
 */
function onlyPresent<T extends Record<string, unknown>>(values: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (v !== null && v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** Columns the v2 import sets directly instead of mapping from Ejar values. */
export interface PropertyOverrides {
  typeLookupId?: number | null;
  typeOther?: string | null;
  usageLookupId?: number | null;
  cityLookupId?: number | null;
  /** null for a property the user typed in: Ejar supplied none of it, so nothing locks. */
  ejarSource?: string | null;
}
export interface UnitOverrides {
  typeLookupId?: number | null;
  typeOther?: string | null;
  usageLookupId?: number | null;
  status?: "available" | "rented" | "maintenance" | "reserved";
  ejarSource?: string | null;
}

export class EjarImportWriter {
  constructor(private readonly db: Drizzle) {}

  /**
   * Stamp the real Ejar invoice onto each generated installment, matched by
   * due date. Ejar's payment_status tells us which installments were already
   * settled, so an imported contract's Payment Log opens in the right state
   * instead of showing everything as pending.
   */
  async attachEjarInvoices(
    rows: Array<{ id: number; dueDate: string }>,
    invoices: EjarInvoiceRow[],
    opts: { skipExternal?: boolean } = {}, // finance-v2: 0084
  ): Promise<void> {
    if (rows.length === 0 || invoices.length === 0) return;
    // Invoices are RENT: match rent rows only, each invoice once, so a fee on
    // the same due date is never stamped as rent or marked paid (issue 11a).
    const described = await this.db
      .select({ id: paymentsTable.id, description: paymentsTable.description })
      .from(paymentsTable)
      .where(inArray(paymentsTable.id, rows.map((r) => r.id)));
    const descOf = new Map(described.map((d) => [d.id, d.description]));
    for (const { row, inv } of matchEjarInvoices(rows.map((r) => ({ ...r, description: descOf.get(r.id) ?? null })), invoices)) {
      // "مدفوعة جزئياً" is a part payment, never fully paid (issue 11b).
      const legacyStatus = mapEjarStatusLegacy(inv);
      // finance-v2: 0084 — on a contract set to SKIP them, an Ejar-paid row is stored `settled_external` (as v2 does),
      // so the reports can leave it out; `paid` with no collection behind it would count as collected everywhere.
      const status = opts.skipExternal && legacyStatus === "paid" ? "settled_external" : legacyStatus; // finance-v2:
      await this.db
        .update(paymentsTable)
        .set(
          onlyPresent({
            receiptNumber: inv.number,
            status: status as never,
            ...(status === "settled_external" ? { paidDate: row.dueDate } : {}), // finance-v2: 0084
            // Deliberately no Ejar payment status here: the row's own `status`
            // column already carries it, and repeating "غير مدفوعة" in the
            // description froze a moment-in-time verdict into text that never
            // updates once the installment is collected locally. Always begins
            // "فاتورة إيجار", with or without a number, so it reads as rent (11i).
            description: ejarInvoiceDescription(inv),
          }),
        )
        .where(eq(paymentsTable.id, row.id));
    }
  }

  /**
   * The Ejar lessor becomes a real landlord (owners) row — matched on ID
   * number first (the stable key), then name. Blank fields on an existing
   * landlord are backfilled; populated ones are left alone so a locally
   * curated record is never overwritten by Ejar.
   */
  async upsertLandlord(
    scope: number,
    lessor: EjarPartyInfo | null,
    rep: EjarPartyInfo | null,
    src: Record<string, unknown>,
    created: string[],
    linked: string[],
  ): Promise<number | null> {
    const str = (v: unknown) => (v == null || v === "" ? null : String(v));
    const name = str(lessor?.name) || str(src.landlordName);
    const idNumber = str(lessor?.idNumber) || str(lessor?.registrationNumber) || str(src.landlordIdNumber);
    if (!name && !idNumber) return null;

    // `original*` holds the agent acting for this landlord — the wakala flow
    // the owner wizard already renders.
    const repFields = rep
      ? {
          isRepresentative: true,
          originalOwnerName: str(rep.name),
          originalOwnerIdNumber: str(rep.idNumber),
          originalOwnerPhone: str(rep.phone),
          originalOwnerEmail: str(rep.email),
        }
      : {};

    const where = idNumber
      ? and(eq(ownersTable.userId, scope), eq(ownersTable.idNumber, idNumber), isNull(ownersTable.deletedAt))
      : and(eq(ownersTable.userId, scope), eq(ownersTable.name, name!), isNull(ownersTable.deletedAt));
    const [found] = await this.db.select().from(ownersTable).where(where).limit(1);
    if (found) {
      const fill: Record<string, unknown> = { ...repFields };
      if (!found.phone && (lessor?.phone || src.landlordPhone)) fill.phone = str(lessor?.phone) || str(src.landlordPhone);
      if (!found.email && (lessor?.email || src.landlordEmail)) fill.email = str(lessor?.email) || str(src.landlordEmail);
      if (!found.idNumber && idNumber) fill.idNumber = idNumber;
      if (!found.taxNumber && lessor?.unifiedNumber) fill.taxNumber = str(lessor.unifiedNumber);
      if (!found.nationalityLookupId && lessor?.nationality) {
        fill.nationalityLookupId = await resolveLookupId(this.db, "nationality", lessor.nationality);
      }
      if (lessor?.raw) { fill.ejarRaw = lessor.raw; fill.ejarSource = "ejar"; }
      if (Object.keys(fill).length) await this.db.update(ownersTable).set(onlyPresent(fill)).where(eq(ownersTable.id, found.id));
      linked.push("landlord");
      return found.id;
    }
    // finance-v2: n/a (plan gate, not ledger) — عقاري holds one landlord (CONTRACT2 §5): at the cap reuse the account's own row or refuse with 403 PLAN_LIMIT_LANDLORDS before the first write of the import
    const capped = await ejarLandlordCapGate(this.db, scope, lessor, name, idNumber); // finance-v2: n/a — landlord cap gate
    if (capped != null) { linked.push("landlord"); return capped; } // finance-v2: n/a — landlord cap reuse
    const [row] = await this.db
      .insert(ownersTable)
      .values({
        userId: scope,
        name: name || idNumber!,
        type: partyKind(lessor?.partyType),
        idNumber,
        phone: str(lessor?.phone) || str(src.landlordPhone),
        email: str(lessor?.email) || str(src.landlordEmail),
        taxNumber: str(lessor?.unifiedNumber),
        nationalityLookupId: await resolveLookupId(this.db, "nationality", lessor?.nationality),
        status: "active",
        notes: "مستورد من إيجار",
        ejarSource: "ejar",
        ejarRaw: lessor?.raw ?? null,
        ...repFields,
      })
      .returning({ id: ownersTable.id });
    created.push("landlord");
    return row?.id ?? null;
  }

  /**
   * Ejar reports the title deed on the property (and each unit). Deed numbers
   * are unique per account, so a second contract on the same property reuses
   * the existing deed instead of colliding on the unique index.
   */
  async upsertDeed(
    scope: number,
    p: Record<string, unknown>,
    landlordId: number | null,
    lessor: EjarPartyInfo | null,
    created: string[],
    linked: string[],
    /** `typed`: the user entered this deed (v2 import) — not Ejar data, so nothing locks. */
    origin: "ejar" | "typed" = "ejar",
  ): Promise<number | null> {
    const deedNumber = p.deedNumber == null || p.deedNumber === "" ? null : String(p.deedNumber);
    if (!deedNumber) return null;
    const [found] = await this.db
      .select({ id: deedsTable.id, ownerId: deedsTable.ownerId })
      .from(deedsTable)
      .where(and(eq(deedsTable.userId, scope), eq(deedsTable.deedNumber, deedNumber), isNull(deedsTable.deletedAt)))
      .limit(1);
    if (found) {
      if (!found.ownerId && landlordId) {
        await this.db.update(deedsTable).set({ ownerId: landlordId }).where(eq(deedsTable.id, found.id));
      }
      linked.push("deed");
      return found.id;
    }
    const [row] = await this.db
      .insert(deedsTable)
      .values({
        userId: scope,
        deedNumber,
        // A recognised Ejar type becomes the matching `deed_type` lookup key;
        // anything else is kept verbatim as a custom ("Other") value, which the
        // text column and the LookupOtherSelect both support. Only a completely
        // absent type falls back to the column default.
        deedType: mapEjarValue(EJAR_DEED_TYPE, p.deedType)
          || (p.deedType == null || String(p.deedType).trim() === "" ? "electronic" : String(p.deedType).trim()),
        ownerId: landlordId,
        ownerNationalId: lessor?.idNumber ?? null,
        // Ejar names the deed's own owners on the property (and unit). They are
        // the document's co-owners, which is not necessarily the landlord this
        // deed is filed under, so they are kept as their own list.
        deedOwners: deedOwnersFrom(p),
        issuingAuthority: origin === "ejar" ? "إيجار (الهيئة العامة للعقار)" : null,
        notes: "مستورد من إيجار",
        ejarSource: origin === "ejar" ? "ejar" : null,
        ejarRaw: origin === "ejar"
          ? {
              title_deed_number: p.deedNumber ?? null,
              title_deed_type: p.deedType ?? null,
              owners: p.owners ?? [],
              property_ejar_id: p.ejarId ?? null,
            }
          : null,
      })
      .returning({ id: deedsTable.id });
    created.push("deed");
    return row?.id ?? null;
  }

  /**
   * Reuse the imported property by Ejar UUID (per account), else create it.
   * Either way the row is written with the full Ejar detail — type/usage/city/
   * region resolved to `lookups` FKs so every dropdown in the portal renders
   * the imported property exactly like a manually created one.
   */
  async upsertProperty(
    ownerId: number,
    p: Record<string, unknown>,
    landlordId: number | null,
    deedId: number | null,
    rawAttrs: Record<string, unknown> | null | undefined,
    created: string[],
    linked: string[],
    /** Values that win over the Ejar mapping — the v2 import's typed-in lookups. */
    overrides: PropertyOverrides = {},
  ): Promise<number | null> {
    const str = (v: unknown) => (v == null || v === "" ? null : String(v));
    const int = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
    const ejarId = str(p.ejarId);

    const type = lookupOrOther(mapEjarValue(EJAR_PROPERTY_TYPE, p.propertyType), p.propertyType);
    const usageKey = mapEjarValue(EJAR_USAGE, p.propertyUsage);
    const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String).filter(Boolean) : []);
    const extras = [
      ...list(p.utilities).map((x) => `خدمة: ${x}`),
      ...list(p.amenities).map((x) => `مرفق: ${x}`),
    ];

    const values = {
      // Facilities/utilities keep the shape the property form reads back
      // ({ counts: {...} }) so an imported property edits like a manual one.
      // Same JSON shape the property form writes and the detail view reads:
      // facility counts plus the compound flag. Written whenever Ejar gave us
      // either, so an imported property shows "داخل مجمع" like a manual one.
      amenitiesData: (() => {
        const inCompound = asBool(p.partOfCompound) === true || !!str(p.compoundName);
        const facilities = [...list(p.amenities), ...list(p.utilities)];
        if (!facilities.length && !inCompound) return null;
        return JSON.stringify({
          counts: Object.fromEntries(facilities.map((k) => [k, 1])),
          inCompound,
          compoundName: str(p.compoundName) || "",
        });
      })(),
      ejarRaw: rawAttrs ?? null,
      name: str(p.name) || "عقار (إيجار)",
      district: str(p.district),
      street: str(p.street),
      postalCode: str(p.postalCode),
      deedNumber: str(p.deedNumber),
      deedId,
      ownerId: landlordId,
      yearBuilt: int(p.yearBuilt),
      elevators: int(p.elevatorCount),
      parkings: int(p.parkingCount),
      typeLookupId: await resolveLookupId(this.db, "property_type", type.key),
      typeOther: type.other,
      usageLookupId: await resolveLookupId(this.db, "property_usage", usageKey),
      regionLookupId: await resolveLookupId(this.db, "region", p.regionKey ?? p.region),
      cityLookupId: await resolveLookupId(this.db, "city", p.city),
      notes: [str(p.address), ...extras, "مستورد من إيجار"]
        .filter(Boolean)
        .join(" — "),
      // Ejar gives coordinates, not a link. Turn them into the Maps URL the
      // property screen actually shows; a user can still overwrite it.
      mapUrl: mapsUrl(p.latitude, p.longitude),
      ejarId,
      ejarSource: "ejar" as string | null,
      ...overrides,
    };

    if (ejarId) {
      const [found] = await this.db
        .select({ id: propertiesTable.id })
        .from(propertiesTable)
        .where(and(eq(propertiesTable.userId, ownerId), eq(propertiesTable.ejarId, ejarId)))
        .limit(1);
      if (found) {
        // Refresh it — a re-import brings newer Ejar detail — but only with
        // values Ejar actually sent, so a field the user filled in locally is
        // never blanked out. The deed FK is 1:1, so it goes through linkDeed.
        const { deedId: newDeed, ...rest } = values;
        await this.db.update(propertiesTable).set(onlyPresent(rest)).where(eq(propertiesTable.id, found.id));
        if (newDeed) await this.linkDeed(found.id, newDeed);
        linked.push("property");
        return found.id;
      }
    }
    const [row] = await this.db
      .insert(propertiesTable)
      .values({ userId: ownerId, ...values })
      .returning({ id: propertiesTable.id });
    created.push("property");
    return row?.id ?? null;
  }

  /** properties.deed_id is uniquely indexed — only claim a free deed. */
  async linkDeed(propertyId: number, deedId: number) {
    const [taken] = await this.db
      .select({ id: propertiesTable.id })
      .from(propertiesTable)
      .where(eq(propertiesTable.deedId, deedId))
      .limit(1);
    if (!taken) await this.db.update(propertiesTable).set({ deedId }).where(eq(propertiesTable.id, propertyId));
  }

  /**
   * Reuse imported units by Ejar UUID, else create them under the property —
   * with the full GetUnits detail (rooms, meters, dimensions, direction,
   * finishing, furnishing, parking, amenities) so the Units tab shows a
   * complete record rather than a bare unit number.
   */
  async upsertUnits(
    ownerId: number,
    propertyId: number | null,
    units: Array<Record<string, unknown>>,
    rawUnits: Record<string, Record<string, unknown>>,
    created: string[],
    linked: string[],
    /** Values that win over the Ejar mapping — the v2 import's typed-in lookups. */
    overrides: UnitOverrides = {},
  ): Promise<number[]> {
    if (!propertyId || units.length === 0) return [];
    const str = (v: unknown) => (v == null || v === "" ? null : String(v));
    const int = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
    const numr = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : String(Number(v)));
    const ids: number[] = [];
    let newUnits = 0;

    for (const u of units) {
      const ejarId = str(u.ejarId);
      const type = lookupOrOther(mapEjarValue(EJAR_UNIT_TYPE, u.unitType), u.unitType);
      const furnishRaw = u.furnishType ?? (asBool(u.furnished) === true ? "furnished" : asBool(u.furnished) === false ? "unfurnished" : null);
      const amenities = [
        ...(Array.isArray(u.amenities) ? (u.amenities as unknown[]).map(String) : []),
        ...(Array.isArray(u.utilities) ? (u.utilities as unknown[]).map(String) : []),
      ].filter(Boolean);

      const values = {
        unitNumber: str(u.unitNumber) || "—",
        floor: int(u.floor),
        area: numr(u.area),
        bedrooms: int(u.rooms),
        rentPrice: numr(u.rentPrice),
        parkingSpaces: int(u.parkingLots),
        electricityMeter: str(u.electricityMeter),
        waterMeter: str(u.waterMeter),
        gasMeter: str(u.gasMeter),
        unitWidth: numr(u.width),
        unitHeight: numr(u.height),
        unitLength: numr(u.length),
        facadeLength: numr(u.frontLength),
        hasMezzanine: asBool(u.includeMezzanine),
        furnishing: mapEjarValue(EJAR_FURNISHING, furnishRaw),
        amenities: amenities.length ? amenities.join(", ") : null,
        amenitiesData: amenities.length
          ? JSON.stringify({ counts: Object.fromEntries(amenities.map((k) => [k, 1])) })
          : null,
        // Ejar has no "year built" on a unit — construction_date is the build
        // date and established_date the registration date; prefer the former.
        yearBuilt: str(u.constructionDate) || str(u.establishedDate),
        ejarRaw: (ejarId && rawUnits[ejarId]) || null,
        typeLookupId: await resolveLookupId(this.db, "unit_type", type.key),
        typeOther: type.other,
        directionLookupId: await resolveLookupId(this.db, "unit_direction", mapEjarValue(EJAR_DIRECTION, u.direction)),
        finishingLookupId: await resolveLookupId(this.db, "unit_finishing", mapEjarValue(EJAR_FINISHING, u.finishing)),
        status: (mapEjarValue(EJAR_UNIT_STATUS, u.availability) || "rented") as "available" | "rented" | "maintenance" | "reserved",
        notes: [str(u.deedNumber) && `صك: ${u.deedNumber}`, str(u.unitUsage) && `الاستخدام: ${u.unitUsage}`, "مستورد من إيجار"]
          .filter(Boolean)
          .join(" — "),
        ejarId,
        ejarSource: "ejar" as string | null,
        ...overrides,
      };

      if (ejarId) {
        const [found] = await this.db
          .select({ id: unitsTable.id })
          .from(unitsTable)
          .where(and(eq(unitsTable.propertyId, propertyId), eq(unitsTable.ejarId, ejarId)))
          .limit(1);
        if (found) {
          // Same rule as the property: refresh with what Ejar sent, never null
          // out a field somebody filled in locally.
          await this.db.update(unitsTable).set(onlyPresent(values)).where(eq(unitsTable.id, found.id));
          ids.push(found.id);
          linked.push("unit");
          continue;
        }
      }
      const [row] = await this.db
        .insert(unitsTable)
        .values({ propertyId, ...values })
        .returning({ id: unitsTable.id });
      if (row) { ids.push(row.id); newUnits++; created.push("unit"); }
    }
    if (newUnits > 0) {
      await this.db
        .update(propertiesTable)
        .set({ totalUnits: sql`${propertiesTable.totalUnits} + ${newUnits}` })
        .where(eq(propertiesTable.id, propertyId));
    }
    return ids;
  }

  /**
   * The Ejar tenant becomes a real tenants row, matched on national ID (or
   * the CR number for organizations) then name, so the imported contract
   * shows up under Tenants and in the tenant portal like a manual one.
   */
  async upsertTenant(
    scope: number,
    party: EjarPartyInfo | null,
    rep: EjarPartyInfo | null,
    src: Record<string, unknown>,
    created: string[],
    linked: string[],
  ): Promise<number | null> {
    const str = (v: unknown) => (v == null || v === "" ? null : String(v));
    const name = str(party?.name) || str(src.tenantName);
    const nationalId = str(party?.idNumber) || str(party?.registrationNumber) || str(src.tenantIdNumber);
    if (!name && !nationalId) return null;

    // Same wakala mapping as the landlord: the row is the real tenant, the
    // `original*` block is the representative Ejar returned alongside it.
    const repFields = rep
      ? {
          isRepresentative: true,
          originalTenantName: str(rep.name),
          originalTenantIdNumber: str(rep.idNumber),
          originalTenantPhone: str(rep.phone),
          originalTenantEmail: str(rep.email),
        }
      : {};

    const where = nationalId
      ? and(eq(tenantsTable.userId, scope), eq(tenantsTable.nationalId, nationalId), isNull(tenantsTable.deletedAt))
      : and(eq(tenantsTable.userId, scope), eq(tenantsTable.name, name!), isNull(tenantsTable.deletedAt));
    const [found] = await this.db.select().from(tenantsTable).where(where).limit(1);
    if (found) {
      const fill: Record<string, unknown> = { ...repFields };
      if (!found.phone && (party?.phone || src.tenantPhone)) fill.phone = str(party?.phone) || str(src.tenantPhone);
      if (!found.email && (party?.email || src.tenantEmail)) fill.email = str(party?.email) || str(src.tenantEmail);
      if (!found.nationalId && nationalId) fill.nationalId = nationalId;
      if (!found.taxNumber && party?.unifiedNumber) fill.taxNumber = str(party.unifiedNumber);
      if (!found.nationality && party?.nationality) {
        fill.nationality = party.nationality;
        fill.nationalityLookupId = await resolveLookupId(this.db, "nationality", party.nationality);
      }
      if (party?.raw) { fill.ejarRaw = party.raw; fill.ejarSource = "ejar"; }
      if (Object.keys(fill).length) await this.db.update(tenantsTable).set(onlyPresent(fill)).where(eq(tenantsTable.id, found.id));
      linked.push("tenant");
      return found.id;
    }
    const [row] = await this.db
      .insert(tenantsTable)
      .values({
        userId: scope,
        name: name || nationalId!,
        type: partyKind(party?.partyType ?? src.tenantType),
        nationalId,
        phone: str(party?.phone) || str(src.tenantPhone),
        email: str(party?.email) || str(src.tenantEmail),
        taxNumber: str(party?.unifiedNumber) || str(src.companyUnified),
        nationality: str(party?.nationality),
        nationalityLookupId: await resolveLookupId(this.db, "nationality", party?.nationality),
        status: "active",
        isDemo: "false",
        notes: "مستورد من إيجار",
        ejarSource: "ejar",
        ejarRaw: party?.raw ?? null,
        ...repFields,
      })
      .returning({ id: tenantsTable.id });
    created.push("tenant");
    return row?.id ?? null;
  }

  /**
   * Write one import plan: the whole hierarchy, the contract, its unit links
   * and its payment schedule. Mirrors what the preview-based import did, with
   * each entity either picked (existingId, already checked against the
   * account by the caller) or created through the upserts above.
   *
   * Returns the inserted installments so the caller can stamp the Ejar
   * invoices onto them AFTER the transaction commits — the finance-v2 attach
   * reads them through its own pool connection.
   */
  async persist(ownerId: number, plan: ImportPlan): Promise<{ result: ImportResult; installments: Array<{ id: number; dueDate: string }> }> {
    const created: string[] = [];
    const linked: string[] = [];
    const c = plan.contract;

    // 1) Landlord
    let landlordId: number | null;
    if ("existingId" in plan.landlord) { landlordId = plan.landlord.existingId; linked.push("landlord"); }
    else landlordId = await this.upsertLandlord(ownerId, plan.landlord.party, plan.landlord.rep, {}, created, linked);

    // 2) Deed + 3) Property
    let propertyId: number | null;
    let deedId: number | null = null;
    if ("existingId" in plan.property) {
      propertyId = plan.property.existingId;
      // The wizard takes the landlord from the property; give an unowned one this landlord.
      if (landlordId) {
        await this.db.update(propertiesTable).set({ ownerId: landlordId })
          .where(and(eq(propertiesTable.id, propertyId), isNull(propertiesTable.ownerId)));
      }
      linked.push("property");
    } else {
      const { p, overrides, deed, raw } = plan.property.create;
      const lessor = "existingId" in plan.landlord ? null : plan.landlord.party;
      deedId = deed ? await this.upsertDeed(ownerId, deed, landlordId, lessor, created, linked, "typed") : null;
      // The deed is linked after the insert: properties.deed_id is unique, and a
      // reused deed may already belong to another property.
      propertyId = await this.upsertProperty(ownerId, p, landlordId, null, raw ?? null, created, linked, overrides);
      if (propertyId && deedId) await this.linkDeed(propertyId, deedId);
    }

    // 4) Unit
    let unitIds: number[];
    if ("existingId" in plan.unit) { unitIds = [plan.unit.existingId]; linked.push("unit"); }
    else if ("ejar" in plan.unit) {
      // Ejar's units: reused by Ejar UUID under the property (upsertUnits), or
      // linked when the same number already exists there.
      const { units, raw, overrides, linkIds } = plan.unit.ejar;
      for (const _ of linkIds) linked.push("unit");
      unitIds = [...linkIds, ...(await this.upsertUnits(ownerId, propertyId, units, raw, created, linked, overrides))];
    }
    else unitIds = await this.upsertUnits(ownerId, propertyId, [plan.unit.create.u], {}, created, linked, plan.unit.create.overrides);

    // 5) Tenant
    let tenantId: number | null;
    if ("existingId" in plan.tenant) { tenantId = plan.tenant.existingId; linked.push("tenant"); }
    else tenantId = await this.upsertTenant(ownerId, plan.tenant.party, plan.tenant.rep, {}, created, linked);

    // finance-v2: 11g — rent VAT follows the property/unit usage (DARA-NOTES §4), as a manual contract; Ejar's amounts stay VAT-inclusive
    // Never the client's choice: usage first, then Ejar's contract type.
    const rentVat = (await ejarRentVatVerdict(this.db, propertyId, unitIds)) ?? c.vatFallback;

    // The contract's party columns are a snapshot of the records, exactly as
    // the manual wizard copies them from the picked tenant and landlord.
    const [landlord] = landlordId
      ? await this.db.select().from(ownersTable).where(eq(ownersTable.id, landlordId)).limit(1)
      : [];
    const [tenant] = tenantId
      ? await this.db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1)
      : [];
    const tenantParty = "existingId" in plan.tenant ? null : plan.tenant.party;
    const tenantRep = "existingId" in plan.tenant ? null : plan.tenant.rep;
    const landlordRep = "existingId" in plan.landlord ? null : plan.landlord.rep;

    const str = (v: unknown) => (v == null || v === "" ? null : String(v));
    const additionalFees = sanitizeFees(plan.additionalFees);
    const freq = c.customSchedule.length ? "custom" : frequencyFrom(c.frequencyHint);
    const status = ["active", "expired", "terminated", "cancelled", "pending"].includes(c.status) ? c.status : "active";

    const [contract] = await this.db
      .insert(contractsTable)
      .values({
        userId: ownerId,
        contractNumber: plan.contractNumber,
        ejarSource: "ejar",
        ejarContractNumber: plan.contractNumber,
        tenantId,
        tenantType: str(tenant?.type),
        tenantName: str(tenant?.name) || str(tenantParty?.name) || "—",
        tenantIdNumber: str(tenant?.nationalId),
        tenantPhone: str(tenant?.phone),
        tenantEmail: str(tenant?.email),
        tenantTaxNumber: str(tenant?.taxNumber),
        companyUnified: str(tenantParty?.unifiedNumber),
        companyOrgType: str(tenantParty?.organizationType),
        repName: str(tenantRep?.name),
        repIdNumber: str(tenantRep?.idNumber),
        landlordName: str(landlord?.name),
        landlordIdNumber: str(landlord?.idNumber),
        landlordPhone: str(landlord?.phone),
        landlordEmail: str(landlord?.email),
        landlordTaxNumber: str(landlord?.taxNumber),
        landlordRepName: str(landlordRep?.name),
        landlordRepIdNumber: str(landlordRep?.idNumber),
        signingDate: c.signingDate,
        startDate: c.startDate,
        endDate: c.endDate,
        monthlyRent: c.monthlyRent,
        paymentFrequency: freq as never,
        customSchedule: c.customSchedule.length ? c.customSchedule : null,
        depositAmount: c.depositAmount,
        depositStatus: c.depositAmount && Number(c.depositAmount) > 0 ? "pending" : null,
        vatEnabled: rentVat, // finance-v2: 11g — was always false
        status: status as never,
        notes: c.notes,
        externalSettlementMode: c.externalSettlementMode === "skip" ? "skip" : "count", // finance-v2: 0084
        ejarRaw: c.ejarRaw,
        additionalFees: additionalFees.length ? (additionalFees as never) : null,
      })
      .returning();
    created.push("contract");

    // 6) Link the contract to its unit(s). A unit may sit on several Ejar
    //    contracts, so imports never collide on the (contract, unit) index.
    if (unitIds.length > 0) {
      await this.db
        .insert(contractUnitsTable)
        .values(unitIds.map((unitId) => ({ contractId: contract.id, unitId })))
        .onConflictDoNothing();
      if (status === "active" || status === "pending") {
        await this.db.update(unitsTable).set({ status: "rented" }).where(inArray(unitsTable.id, unitIds));
      }
    }

    // 7) The payment schedule, from the real Ejar invoices (custom) — as the
    //    manual path builds it. A failure never fails the import: it runs in a
    //    savepoint, so the contract above survives it.
    let installments: Array<{ id: number; dueDate: string }> = [];
    try {
      const rows = buildInstallments(
        contract.id, ownerId, contract.startDate, contract.endDate, contract.monthlyRent, freq,
        additionalFees.length ? (additionalFees as never) : null,
        false, 0, "percent", null, 0, c.customSchedule.length ? c.customSchedule : null,
      );
      for (const r of rows) if (r.description === null) r.vatEnabled = rentVat; // finance-v2: 11g — rent rows only (fees keep their own treatment); amounts are Ejar's, VAT-inclusive
      if (rows.length > 0) {
        installments = await this.db.transaction(async (sp) =>
          sp.insert(paymentsTable).values(rows).returning({ id: paymentsTable.id, dueDate: paymentsTable.dueDate }));
      }
    } catch {
      installments = [];
    }

    return {
      result: {
        contractId: contract.id, propertyId, unitIds, landlordId, deedId, tenantId,
        installmentsCreated: installments.length, created, linked,
      },
      installments,
    };
  }
}

export type PartyChoice = { existingId: number } | { party: EjarPartyInfo | null; rep: EjarPartyInfo | null };

/** Everything one v2 import writes, decided and validated by EjarImportService. */
export interface ImportPlan {
  contractNumber: string;
  landlord: PartyChoice;
  tenant: PartyChoice;
  property:
    | { existingId: number }
    | {
        create: {
          p: Record<string, unknown>;
          overrides: PropertyOverrides;
          deed: { deedNumber: string; deedType: string | null } | null;
          /** Ejar's own attributes (Get Contracts) — persisted as ejar_raw, which drives the field locks. */
          raw?: Record<string, unknown> | null;
        };
      };
  unit:
    | { existingId: number }
    | { create: { u: Record<string, unknown>; overrides: UnitOverrides } }
    | {
        ejar: {
          units: Array<Record<string, unknown>>;
          /** Ejar unit UUID → its attributes, persisted as ejar_raw. */
          raw: Record<string, Record<string, unknown>>;
          overrides: UnitOverrides;
          /** Units already on the property under the same number. */
          linkIds: number[];
        };
      };
  contract: {
    startDate: string;
    endDate: string;
    status: string;
    signingDate: string | null;
    /** Numeric string, ex-VAT, as the manual wizard stores it. */
    monthlyRent: string;
    customSchedule: Array<{ dueDate: string; amount: string }>;
    /** Ejar's payment frequency text; only used when there is no schedule. */
    frequencyHint: string | null;
    depositAmount: string | null;
    /**
     * Rent VAT when the property/unit usage cannot decide it: from Ejar's
     * contract type (commercial → 15%, residential → exempt). The usage
     * verdict always wins; the client never chooses.
     */
    vatFallback: boolean;
    notes: string | null;
    ejarRaw: Record<string, unknown> | null;
    /** finance-v2: 0084 — count or skip the installments Ejar reports already paid (default count). */
    externalSettlementMode?: "count" | "skip";
  };
  additionalFees: Array<Record<string, unknown>>;
  invoices: EjarInvoiceRow[];
}

export interface ImportResult {
  contractId: number;
  propertyId: number | null;
  unitIds: number[];
  landlordId: number | null;
  deedId: number | null;
  tenantId: number | null;
  installmentsCreated: number;
  created: string[];
  linked: string[];
}

const PAYMENT_FREQ = new Set(["monthly", "quarterly", "semi_annual", "annual", "custom"]);

/** Ejar's frequency wording → our enum (only used when Ejar sent no invoices). */
export function frequencyFrom(raw: string | null | undefined): string {
  const f = String(raw || "").toLowerCase();
  return PAYMENT_FREQ.has(f) ? f
    : /semi|bi-annual|biannual|نصف/.test(f) ? "semi_annual"
    : /quarter|ربع/.test(f) ? "quarterly"
    : /month|شهري/.test(f) ? "monthly"
    : "annual";
}

/**
 * Fees chosen on the confirm-import step — same shape the manual contract
 * wizard sends, so both paths produce identical fee installments. Anything
 * without a positive amount is dropped, so an empty row left behind in the
 * modal can never create a zero-value installment.
 */
export function sanitizeFees(raw: unknown): Array<Record<string, any>> {
  const str = (v: unknown) => (v == null || v === "" ? null : String(v));
  return (Array.isArray(raw) ? (raw as Array<Record<string, any>>) : [])
    .map((f) => ({
      id: String(f?.id ?? ""),
      typeKey: str(f?.typeKey),
      name: str(f?.name) || "رسوم",
      amount: String(f?.amount ?? ""),
      recurrence: String(f?.recurrence ?? "one_time"),
      dueDate: "",
      paymentMethod: "separate",
      vat: !!f?.vat,
      // The fee's ZATCA treatment, as the fees step chose it.
      ...(typeof f?.vatCategory === "string" ? { vatCategory: f.vatCategory } : {}),
      ...(typeof f?.exemptionReason === "string" && f.exemptionReason ? { exemptionReason: f.exemptionReason } : {}),
      ...(f?.vatCategory === "O" && typeof f?.exemptionReasonText === "string" && f.exemptionReasonText.trim()
        ? { exemptionReasonText: f.exemptionReasonText.trim().slice(0, 300) } : {}),
      ...(f?.recurrence === "custom" && Array.isArray(f?.customSchedule)
        ? {
            customSchedule: (f.customSchedule as Array<{ dueDate?: unknown; amount?: unknown }>)
              .map((e) => ({ dueDate: String(e?.dueDate ?? "").slice(0, 10), amount: String(e?.amount ?? "") }))
              .filter((e) => e.dueDate && Number(e.amount) > 0),
          }
        : {}),
    }))
    .filter((f: Record<string, any>) => (f.recurrence === "custom" ? (f.customSchedule?.length ?? 0) > 0 : Number(f.amount) > 0));
}
