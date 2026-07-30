import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpException, Inject, Module,
  NotFoundException, Param, Post, Query, ServiceUnavailableException, UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  contractsTable, paymentsTable, propertiesTable, unitsTable, contractUnitsTable,
  ownersTable, deedsTable, tenantsTable,
} from "@oqudk/database";
import { buildInstallments } from "../contracts/installments";
import { resolveLookupId } from "../../common/lookups-resolve";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard, type AuthUser } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { EjarClientService, EjarApiError, EjarConfigError } from "./ejar.client.service";
import { EjarLogService, type EjarLogFilter } from "./ejar.log.service";
import { isEjarEndpointKey, type EjarBody, type JsonApiResource } from "./ejar.types";
import {
  mapEjarToContract, summarizeContractsBody,
  type EjarPartyInfo, type EjarInvoiceRow, type EjarRawBlocks,
} from "./ejar.map";
import {
  EJAR_PROPERTY_TYPE, EJAR_UNIT_TYPE, EJAR_USAGE, EJAR_DIRECTION, EJAR_FINISHING,
  EJAR_FURNISHING, EJAR_DEED_TYPE, EJAR_UNIT_STATUS, mapEjarValue, lookupOrOther, partyKind, asBool,
} from "./ejar.import";

const PAYMENT_FREQ = new Set(["monthly", "quarterly", "semi_annual", "annual", "custom"]);
const HEALTH_CONTRACT = "10732702933";

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

/**
 * Ejar (NHC) integration — the sensitive, credential-holding backend. The web
 * portal calls these endpoints; the IBM client id/secret never leave here.
 * Everything is READ-ONLY against NHC (we pull, never push).
 */
@ApiTags("ejar")
@ApiBearerAuth("user-jwt")
@Controller("ejar")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class EjarController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly client: EjarClientService,
    private readonly logs: EjarLogService,
  ) {}

  /** Run one whitelisted endpoint; returns the unwrapped Body + the log row. */
  @Post("call")
  @RequirePermissions(PERMISSIONS.CONTRACTS_VIEW)
  async call(@CurrentUser() user: AuthUser, @Body() body: { endpoint?: string; params?: Record<string, unknown> }) {
    if (!isEjarEndpointKey(body?.endpoint)) {
      throw new BadRequestException(
        "Unknown or missing endpoint. Allowed: getRentalContracts, getProperties, getUnits, nationalAddress, rentalContractInvoices, rentalFinancialData",
      );
    }
    const params = this.cleanParams(body.params);
    try {
      return await this.client.request(body.endpoint, params, { userId: user.id });
    } catch (err) {
      throw this.toHttp(err);
    }
  }

  /**
   * Step 1 of the wizard: list a national ID's rental contracts, summarised
   * server-side. The browser never calls Ejar directly — it calls this, and
   * the backend calls GetRentalContracts, summarises, and returns the rows +
   * pagination + the request log.
   */
  @Post("contracts")
  @RequirePermissions(PERMISSIONS.CONTRACTS_VIEW)
  async listContracts(
    @CurrentUser() user: AuthUser,
    @Body() body: { id_number?: string; page?: number; pageSize?: number },
  ) {
    const idNumber = body?.id_number?.trim();
    if (!idNumber) throw new BadRequestException("id_number is required");
    const page = Math.max(1, Number(body?.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(body?.pageSize) || 10));
    try {
      const { body: resp, log } = await this.client.request(
        "getRentalContracts",
        { id_number: idNumber, "page[size]": pageSize, "page[number]": page },
        { userId: user.id },
      );
      const contracts = resp ? summarizeContractsBody(resp) : [];
      const total = Number(resp?.meta?.count ?? contracts.length);
      return { contracts, total, page, pageSize, log };
    } catch (err) {
      throw this.toHttp(err);
    }
  }

  /** Assemble + map a full import preview for one contract (server-side). */
  @Post("preview")
  @RequirePermissions(PERMISSIONS.CONTRACTS_VIEW)
  async preview(
    @CurrentUser() user: AuthUser,
    @Body() body: { id_number?: string; contract_number?: string; partyType?: number },
  ) {
    const idNumber = body?.id_number?.trim();
    const contractNumber = body?.contract_number?.trim();
    const partyType = body?.partyType ?? 0;
    if (!contractNumber) throw new BadRequestException("contract_number is required");

    const logs: unknown[] = [];
    const run = async (fn: () => Promise<{ body: EjarBody | null; log: unknown }>) => {
      try {
        const r = await fn();
        logs.push(r.log);
        return r.body;
      } catch (e) {
        if (e instanceof EjarApiError && e.log) logs.push(e.log);
        if (e instanceof EjarConfigError) throw this.toHttp(e);
        return null;
      }
    };

    // Best-effort: list the ID's contracts so relationships resolve. The list
    // resource is the ONLY source of the parties (tenants/lessors), the
    // property_id and the unit ids — so we page until we actually find it. A
    // broker can have hundreds of contracts; stopping at the first page silently
    // produced a preview with no tenant/landlord/property at all.
    let listBody: EjarBody | null = null;
    let resource: JsonApiResource | null = null;
    if (idNumber) {
      const PAGE = 100;
      const MAX_PAGES = 20;
      for (let p = 1; p <= MAX_PAGES && !resource; p++) {
        const body = await run(() =>
          this.client.request("getRentalContracts", { id_number: idNumber, "page[size]": PAGE, "page[number]": p }, { userId: user.id }),
        );
        if (!body) break;
        if (p === 1) listBody = body;
        const arr = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
        if (arr.length === 0) break;
        const idx = summarizeContractsBody(body).findIndex((s) => s.contractNumber === contractNumber);
        if (idx >= 0) {
          resource = arr[idx];
          listBody = body;
          break;
        }
        const total = Number(body.meta?.count ?? 0);
        if (total && p * PAGE >= total) break;
        if (!total && arr.length < PAGE) break;
      }
    }
    if (!resource) resource = { type: "rental-contract", id: contractNumber, attributes: { contract_number: contractNumber } };

    // Ejar identifiers to enrich the property + unit(s).
    const attrs = resource.attributes || {};
    const broker = String(attrs.broker_national_id || idNumber || "");
    const propertyId = String(attrs.property_id || "");
    const unitIds = (Array.isArray(attrs.units) ? attrs.units : [])
      .map((u: Record<string, unknown>) => String(u?.id || u?.unit_id || ""))
      .filter(Boolean)
      .join(",");

    const [na, fin, inv, propsBody, unitsBody] = await Promise.all([
      run(() => this.client.request("nationalAddress", { contractNumber, partyType }, { userId: user.id })),
      run(() => this.client.request("rentalFinancialData", { contractNumber, partyType }, { userId: user.id })),
      run(() => this.client.request("rentalContractInvoices", { contractNumber, partyType }, { userId: user.id })),
      broker && propertyId
        ? run(() => this.client.request("getProperties", { id_number: broker, property_ids: propertyId, skip_filter_id_number: "true" }, { userId: user.id }))
        : Promise.resolve(null),
      broker && unitIds
        ? run(() => this.client.request("getUnits", { id_number: broker, unit_ids: unitIds, skip_filter_id_number: "true" }, { userId: user.id }))
        : Promise.resolve(null),
    ]);

    const preview = mapEjarToContract({
      contract: resource, listBody: listBody ?? undefined,
      nationalAddress: na, financial: fin, invoices: inv,
      propertiesBody: propsBody, unitsBody,
    });
    return { ...preview, logs };
  }

  /**
   * Import a reviewed Ejar contract as a FULL local record, so it shows up
   * everywhere in the portal rather than only under Contracts. Down the whole
   * hierarchy — Deed → Property → Unit → Contract (Landlord ↔ Tenant):
   *
   *   Landlord (owners)  from the Ejar lessor — reused by ID number, else name
   *   Deed    (deeds)    from title_deed_number/_type, linked to the landlord
   *   Property           reused by Ejar UUID; type/usage/city/region resolved
   *                      to `lookups` FKs so every dropdown renders
   *   Unit(s)            reused by Ejar UUID; type/direction/finishing FKs,
   *                      meters, dimensions, rooms, parking, amenities
   *   Tenant  (tenants)  from the Ejar tenant — reused by national ID
   *   Contract           linked to the tenant + unit(s), schedule generated
   *
   * Does NOT go through /api/contracts (which requires selecting an existing
   * local unit and blocks occupied ones) — a unit may legitimately sit on
   * several Ejar contracts. Scoped to the caller's account; deduped on
   * (user_id, contract_number).
   */
  @Post("import")
  @RequirePermissions(PERMISSIONS.CONTRACTS_WRITE)
  async import(
    @CurrentUser() user: AuthUser,
    @Body() body: {
      contract?: Record<string, unknown>;
      property?: Record<string, unknown>;
      units?: Array<Record<string, unknown>>;
      parties?: { tenants?: EjarPartyInfo[]; lessors?: EjarPartyInfo[]; brokers?: EjarPartyInfo[] };
      contractInfo?: Record<string, unknown>;
      invoices?: EjarInvoiceRow[];
      raw?: Partial<EjarRawBlocks>;
    },
  ) {
    const src = body?.contract || {};
    const ownerId = scopeId(user);
    const num = String(src.ejarContractNumber || src.contractNumber || "").trim();
    if (!num) throw new BadRequestException("رقم عقد إيجار مطلوب للاستيراد");

    const [dup] = await this.db
      .select({ id: contractsTable.id })
      .from(contractsTable)
      .where(and(eq(contractsTable.userId, ownerId), eq(contractsTable.contractNumber, num)))
      .limit(1);
    if (dup) throw new ConflictException(`العقد ${num} مستورد مسبقًا (#${dup.id}).`);

    const prop = body?.property || {};
    const raw = body?.raw || {};
    // Ejar returns each side as a list that may hold the party AND its
    // representative (وكيل). The row we create describes the real party;
    // `isRepresentative` + `original*` carry the agent, matching how the
    // tenant/landlord wizards already read those columns.
    const primary = (list?: EjarPartyInfo[]) => list?.find((p) => !p.isRepresentative) || list?.[0] || null;
    const agent = (list?: EjarPartyInfo[]) => list?.find((p) => p.isRepresentative) || null;
    const lessor = primary(body?.parties?.lessors);
    const lessorRep = agent(body?.parties?.lessors);
    const tenantParty = primary(body?.parties?.tenants);
    const tenantRep = agent(body?.parties?.tenants);
    const created: string[] = [];
    const linked: string[] = [];

    // 1) Landlord — the Ejar lessor becomes a real owners row so the property
    //    and the Landlords tab both point at the same person.
    const landlordId = await this.upsertLandlord(ownerId, lessor, lessorRep, src, created, linked);
    // 2) Deed — Ejar gives the title deed number/type on the property + unit.
    const deedId = await this.upsertDeed(ownerId, prop, landlordId, lessor, created, linked);
    // 3) Property — reuse by Ejar UUID, else create; enriched either way.
    const propertyId = await this.upsertProperty(ownerId, prop, landlordId, deedId, raw.property, created, linked);
    // 4) Unit(s) — reuse by Ejar UUID under that property, else create. A unit
    //    can already be linked to another contract — that's allowed (Ejar reuse).
    const unitIds = await this.upsertUnits(ownerId, propertyId, body?.units || [], raw.units || {}, created, linked);
    // 5) Tenant — so the contract joins the Tenants tab like a manual one.
    const tenantId = await this.upsertTenant(ownerId, tenantParty, tenantRep, src, created, linked);

    const today = new Date().toISOString().slice(0, 10);
    const num2 = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
    const str = (v: unknown) => (v == null || v === "" ? null : String(v));

    // Real Ejar invoices arrive as a custom schedule (exact due dates + amounts).
    const customSchedule = Array.isArray(src.customSchedule)
      ? (src.customSchedule as Array<{ dueDate?: unknown; amount?: unknown }>)
          .map((e) => ({ dueDate: String(e?.dueDate ?? "").slice(0, 10), amount: String(e?.amount ?? "") }))
          .filter((e) => e.dueDate && Number(e.amount) > 0)
      : [];

    const freqRaw = String(src.paymentFrequency || "").toLowerCase();
    const freq = customSchedule.length
      ? "custom"
      : PAYMENT_FREQ.has(freqRaw) ? freqRaw
      : /year|annual|سنوي/.test(freqRaw) ? "annual"
      : /quarter|ربع/.test(freqRaw) ? "quarterly"
      : /semi|نصف/.test(freqRaw) ? "semi_annual"
      : /month|شهري/.test(freqRaw) ? "monthly"
      : "annual";

    // Rent: prefer the schedule total, then annual/monthly hints. NOT NULL col.
    const scheduleTotal = customSchedule.reduce((s, e) => s + Number(e.amount), 0);
    const monthly = num2(src.monthlyRent) ?? num2(src.annualRent) ?? (scheduleTotal || 0);
    const status = ["active", "expired", "terminated", "cancelled", "pending"].includes(String(src.status))
      ? (src.status as string)
      : "active";

    const [contract] = await this.db
      .insert(contractsTable)
      .values({
        userId: ownerId,
        contractNumber: num,
        ejarSource: "ejar",
        ejarContractNumber: num,
        tenantId,
        tenantType: str(src.tenantType),
        tenantName: str(src.tenantName) || "—",
        tenantIdNumber: str(src.tenantIdNumber),
        tenantPhone: str(src.tenantPhone),
        tenantEmail: str(src.tenantEmail),
        tenantTaxNumber: str(src.companyUnified),
        companyUnified: str(src.companyUnified),
        companyOrgType: str(src.companyOrgType),
        repName: str(src.repName),
        repIdNumber: str(src.repIdNumber),
        landlordName: str(src.landlordName),
        landlordIdNumber: str(src.landlordIdNumber),
        landlordPhone: str(src.landlordPhone),
        landlordEmail: str(src.landlordEmail),
        landlordTaxNumber: str(lessor?.unifiedNumber),
        // Ejar's created_time is when the contract was registered — the closest
        // thing it has to a signing date.
        signingDate: str(body?.contractInfo?.createdTime)?.slice(0, 10) || null,
        startDate: str(src.startDate)?.slice(0, 10) || today,
        endDate: str(src.endDate)?.slice(0, 10) || today,
        monthlyRent: String(monthly),
        paymentFrequency: freq as never,
        customSchedule: customSchedule.length ? customSchedule : null,
        depositAmount: num2(src.depositAmount) != null ? String(num2(src.depositAmount)) : null,
        status: status as never,
        notes: [str(src.notes), src.propertyName ? `العقار: ${src.propertyName}` : null].filter(Boolean).join(" — ") || null,
        ejarRaw: raw.contract ?? null,
      })
      .returning();
    created.push("contract");

    // 6) Link the contract to its unit(s). The (contract_id, unit_id) unique
    //    index only stops linking the SAME unit twice to the SAME contract — a
    //    unit can still belong to many contracts, so imports never collide.
    if (unitIds.length > 0) {
      await this.db
        .insert(contractUnitsTable)
        .values(unitIds.map((unitId) => ({ contractId: contract.id, unitId })))
        .onConflictDoNothing();
      if (status === "active" || status === "pending") {
        await this.db.update(unitsTable).set({ status: "rented" }).where(inArray(unitsTable.id, unitIds));
      }
    }

    // 7) Generate the payment schedule from the real Ejar invoices (custom) or
    //    the mapped frequency. Mirrors the manual-create path so the Payment
    //    Log shows the actual amounts + due dates — not a synthetic 0.
    let installmentsCreated = 0;
    try {
      const rows = buildInstallments(
        contract.id, ownerId, contract.startDate, contract.endDate, contract.monthlyRent, freq,
        null, false, 0, "percent", null, 0, customSchedule.length ? customSchedule : null,
      );
      if (rows.length > 0) {
        const inserted = await this.db.insert(paymentsTable).values(rows).returning({ id: paymentsTable.id, dueDate: paymentsTable.dueDate });
        installmentsCreated = inserted.length;
        // Carry the REAL Ejar invoice identity onto the generated installments
        // (number, issue/late dates, paid state) — matched on the due date the
        // schedule was built from. Without this the Payment Log shows generic
        // rows even though Ejar told us the invoice number and whether it was
        // already paid.
        await this.attachEjarInvoices(inserted, body?.invoices || []);
      }
    } catch (e) {
      // Never let schedule generation fail the import — the contract is saved.
    }
    return { ...contract, propertyId, unitIds, landlordId, deedId, tenantId, installmentsCreated, created, linked };
  }

  /**
   * Stamp the real Ejar invoice onto each generated installment, matched by
   * due date. Ejar's payment_status tells us which installments were already
   * settled, so an imported contract's Payment Log opens in the right state
   * instead of showing everything as pending.
   */
  private async attachEjarInvoices(
    rows: Array<{ id: number; dueDate: string }>,
    invoices: EjarInvoiceRow[],
  ): Promise<void> {
    if (rows.length === 0 || invoices.length === 0) return;
    const byDue = new Map<string, EjarInvoiceRow>();
    for (const inv of invoices) {
      const key = String(inv.dueDate ?? "").slice(0, 10);
      if (key && !byDue.has(key)) byDue.set(key, inv);
    }
    for (const row of rows) {
      const inv = byDue.get(String(row.dueDate).slice(0, 10));
      if (!inv) continue;
      const paid = /paid|مدفوع/i.test(inv.status || "") && !/unpaid|غير مدفوع/i.test(inv.status || "");
      const remaining = Number(inv.remaining);
      const partly = !paid && Number.isFinite(remaining) && remaining > 0 && remaining < Number(inv.amount);
      await this.db
        .update(paymentsTable)
        .set(
          onlyPresent({
            receiptNumber: inv.number,
            status: (paid ? "paid" : partly ? "partially_paid" : null) as never,
            description: [
              inv.number && `فاتورة إيجار رقم ${inv.number}`,
              inv.issueDate && `تاريخ الإصدار ${inv.issueDate}`,
              inv.lateDate && `تاريخ التأخر ${inv.lateDate}`,
              inv.status && `الحالة لدى إيجار: ${inv.status}`,
            ]
              .filter(Boolean)
              .join(" — ") || null,
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
  private async upsertLandlord(
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
      if (lessor?.raw) { fill.ejarRaw = lessor.raw; fill.ejarSource = "ejar"; }
      if (Object.keys(fill).length) await this.db.update(ownersTable).set(onlyPresent(fill)).where(eq(ownersTable.id, found.id));
      linked.push("landlord");
      return found.id;
    }
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
  private async upsertDeed(
    scope: number,
    p: Record<string, unknown>,
    landlordId: number | null,
    lessor: EjarPartyInfo | null,
    created: string[],
    linked: string[],
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
        deedType: mapEjarValue(EJAR_DEED_TYPE, p.deedType) || "electronic",
        ownerId: landlordId,
        ownerNationalId: lessor?.idNumber ?? null,
        issuingAuthority: "إيجار (الهيئة العامة للعقار)",
        notes: "مستورد من إيجار",
        ejarSource: "ejar",
        ejarRaw: {
          title_deed_number: p.deedNumber ?? null,
          title_deed_type: p.deedType ?? null,
          owners: p.owners ?? [],
          property_ejar_id: p.ejarId ?? null,
        },
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
  private async upsertProperty(
    ownerId: number,
    p: Record<string, unknown>,
    landlordId: number | null,
    deedId: number | null,
    rawAttrs: Record<string, unknown> | null | undefined,
    created: string[],
    linked: string[],
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
      amenitiesData: extras.length
        ? JSON.stringify({ counts: Object.fromEntries([...list(p.amenities), ...list(p.utilities)].map((k) => [k, 1])) })
        : null,
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
      notes: [str(p.address), str(p.compoundName) && `مجمع: ${p.compoundName}`, ...extras, "مستورد من إيجار"]
        .filter(Boolean)
        .join(" — "),
      ejarId,
      ejarSource: "ejar",
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
  private async linkDeed(propertyId: number, deedId: number) {
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
  private async upsertUnits(
    ownerId: number,
    propertyId: number | null,
    units: Array<Record<string, unknown>>,
    rawUnits: Record<string, Record<string, unknown>>,
    created: string[],
    linked: string[],
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
        ejarSource: "ejar",
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
  private async upsertTenant(
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

  @Get("logs")
  @RequirePermissions(PERMISSIONS.CONTRACTS_VIEW)
  async listLogs(@Query("endpoint") endpoint?: string, @Query("status") status?: string, @Query("limit") limit?: string) {
    const filter: EjarLogFilter = { endpoint: endpoint || undefined, limit: limit ? Number(limit) : undefined };
    if (status === "ok" || status === "error") filter.status = status;
    else if (status && !Number.isNaN(Number(status))) filter.status = Number(status);
    const logs = await this.logs.list(filter);
    return { count: logs.length, logs };
  }

  /** Re-run a logged call verbatim (params were persisted on the row). */
  @Post("logs/:id/replay")
  @RequirePermissions(PERMISSIONS.CONTRACTS_VIEW)
  async replay(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const row = await this.logs.get(Number(id));
    if (!row) throw new NotFoundException("log not found");
    if (!isEjarEndpointKey(row.endpoint)) throw new BadRequestException("cannot replay this endpoint");
    try {
      return await this.client.request(row.endpoint, row.params ?? {}, { userId: user.id });
    } catch (err) {
      throw this.toHttp(err);
    }
  }

  /** Lightweight whitelist + creds check (pings NationalAddress). */
  @Get("health")
  @RequirePermissions(PERMISSIONS.CONTRACTS_VIEW)
  async health(@CurrentUser() user: AuthUser) {
    try {
      const { log } = await this.client.request(
        "nationalAddress",
        { contractNumber: HEALTH_CONTRACT, partyType: 0 },
        { userId: user.id, skipLog: true },
      );
      return { ok: true, status: (log as { status?: number }).status ?? null, transactionId: (log as { transactionId?: string }).transactionId ?? null };
    } catch (err) {
      if (err instanceof EjarConfigError) return { ok: false, status: null, transactionId: null, detail: "not-configured" };
      const e = err as EjarApiError;
      return { ok: false, status: e.status ?? null, transactionId: e.transactionId ?? null, detail: e.message };
    }
  }

  private cleanParams(params?: Record<string, unknown>): Record<string, string | number | undefined> {
    const clean: Record<string, string | number | undefined> = {};
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === "") continue;
      clean[k] = typeof v === "number" ? v : String(v);
    }
    return clean;
  }

  private toHttp(err: unknown) {
    if (err instanceof EjarConfigError) return new ServiceUnavailableException(err.message);
    if (err instanceof EjarApiError) {
      // Surface the REAL upstream status instead of masking everything as 400.
      // A gateway/whitelist/credential problem is not a client error — mapping
      // it to 400 made every failure look like a bad request. Client mistakes
      // (missing param → status 400) stay 400; anything ≥500 (or unknown)
      // becomes 502 Bad Gateway; 401/403/404 pass through.
      const upstream = err.status;
      const code = upstream && upstream >= 400 && upstream < 500 ? upstream : 502;
      return new HttpException(
        { message: err.message, status: upstream, transactionId: err.transactionId, log: err.log ?? null },
        code,
      );
    }
    return err instanceof Error ? new BadRequestException(err.message) : new BadRequestException("Ejar call failed");
  }
}

@Module({
  controllers: [EjarController],
  providers: [EjarClientService, EjarLogService],
})
export class EjarModule {}
