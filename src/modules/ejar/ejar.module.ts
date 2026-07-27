import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpException, Inject, Module,
  NotFoundException, Param, Post, Query, ServiceUnavailableException, UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, sql } from "drizzle-orm";
import { contractsTable, paymentsTable, propertiesTable, unitsTable, contractUnitsTable } from "@oqudk/database";
import { buildInstallments } from "../contracts/installments";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard, type AuthUser } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { EjarClientService, EjarApiError, EjarConfigError } from "./ejar.client.service";
import { EjarLogService, type EjarLogFilter } from "./ejar.log.service";
import { isEjarEndpointKey, type EjarBody, type JsonApiResource } from "./ejar.types";
import { mapEjarToContract, summarizeContractsBody } from "./ejar.map";

const PAYMENT_FREQ = new Set(["monthly", "quarterly", "semi_annual", "annual", "custom"]);
const HEALTH_CONTRACT = "10732702933";

/**
 * Ejar (NHC) integration — the sensitive, credential-holding backend. The web
 * portal calls these endpoints; the IBM client id/secret never leave here.
 * Everything is READ-ONLY against NHC (we pull, never push).
 */
@ApiTags("ejar")
@ApiBearerAuth("user-jwt")
@Controller("ejar")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class EjarController {
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
   * Import a reviewed Ejar contract as a full local record: it creates (or
   * reuses, by Ejar UUID) the Property + Unit, links the Contract to the Unit,
   * and generates the payment schedule. Does NOT go through /api/contracts
   * (which requires selecting an existing local unit and blocks occupied ones)
   * — a unit may legitimately sit on several Ejar contracts. Scoped to the
   * caller's account; deduped on (user_id, contract_number).
   */
  @Post("import")
  @RequirePermissions(PERMISSIONS.CONTRACTS_WRITE)
  async import(
    @CurrentUser() user: AuthUser,
    @Body() body: { contract?: Record<string, unknown>; property?: Record<string, unknown>; units?: Array<Record<string, unknown>> },
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

    // 1) Property — reuse by Ejar UUID, else create.
    const propertyId = await this.upsertProperty(ownerId, body?.property || {});
    // 2) Unit(s) — reuse by Ejar UUID under that property, else create. A unit
    //    can already be linked to another contract — that's allowed (Ejar reuse).
    const unitIds = await this.upsertUnits(ownerId, propertyId, body?.units || []);

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

    const [created] = await this.db
      .insert(contractsTable)
      .values({
        userId: ownerId,
        contractNumber: num,
        ejarSource: "ejar",
        ejarContractNumber: num,
        tenantType: str(src.tenantType),
        tenantName: str(src.tenantName) || "—",
        tenantIdNumber: str(src.tenantIdNumber),
        tenantPhone: str(src.tenantPhone),
        tenantEmail: str(src.tenantEmail),
        companyUnified: str(src.companyUnified),
        companyOrgType: str(src.companyOrgType),
        repName: str(src.repName),
        repIdNumber: str(src.repIdNumber),
        landlordName: str(src.landlordName),
        landlordIdNumber: str(src.landlordIdNumber),
        landlordPhone: str(src.landlordPhone),
        landlordEmail: str(src.landlordEmail),
        startDate: str(src.startDate)?.slice(0, 10) || today,
        endDate: str(src.endDate)?.slice(0, 10) || today,
        monthlyRent: String(monthly),
        paymentFrequency: freq as never,
        customSchedule: customSchedule.length ? customSchedule : null,
        depositAmount: num2(src.depositAmount) != null ? String(num2(src.depositAmount)) : null,
        status: status as never,
        notes: [str(src.notes), src.propertyName ? `العقار: ${src.propertyName}` : null].filter(Boolean).join(" — ") || null,
      })
      .returning();

    // 3) Link the contract to its unit(s). The (contract_id, unit_id) unique
    //    index only stops linking the SAME unit twice to the SAME contract — a
    //    unit can still belong to many contracts, so imports never collide.
    if (unitIds.length > 0) {
      await this.db
        .insert(contractUnitsTable)
        .values(unitIds.map((unitId) => ({ contractId: created.id, unitId })))
        .onConflictDoNothing();
    }

    // 4) Generate the payment schedule from the real Ejar invoices (custom) or
    //    the mapped frequency. Mirrors the manual-create path so the Payment
    //    Log shows the actual amounts + due dates — not a synthetic 0.
    let installmentsCreated = 0;
    try {
      const rows = buildInstallments(
        created.id, ownerId, created.startDate, created.endDate, created.monthlyRent, freq,
        null, false, 0, "percent", null, 0, customSchedule.length ? customSchedule : null,
      );
      if (rows.length > 0) {
        await this.db.insert(paymentsTable).values(rows);
        installmentsCreated = rows.length;
      }
    } catch (e) {
      // Never let schedule generation fail the import — the contract is saved.
    }
    return { ...created, propertyId, unitIds, installmentsCreated };
  }

  /** Reuse the imported property by Ejar UUID (per account), else create it. */
  private async upsertProperty(ownerId: number, p: Record<string, unknown>): Promise<number | null> {
    const str = (v: unknown) => (v == null || v === "" ? null : String(v));
    const int = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
    const ejarId = str(p.ejarId);
    if (ejarId) {
      const [found] = await this.db
        .select({ id: propertiesTable.id })
        .from(propertiesTable)
        .where(and(eq(propertiesTable.userId, ownerId), eq(propertiesTable.ejarId, ejarId)))
        .limit(1);
      if (found) return found.id;
    }
    const [row] = await this.db
      .insert(propertiesTable)
      .values({
        userId: ownerId,
        name: str(p.name) || "عقار (إيجار)",
        district: str(p.district),
        street: str(p.street),
        postalCode: str(p.postalCode),
        deedNumber: str(p.deedNumber),
        yearBuilt: int(p.yearBuilt),
        typeOther: str(p.propertyType),
        notes: [str(p.city), str(p.region)].filter(Boolean).join("، ") || null,
        ejarId,
        ejarSource: "ejar",
      })
      .returning({ id: propertiesTable.id });
    return row?.id ?? null;
  }

  /** Reuse imported units by Ejar UUID, else create them under the property. */
  private async upsertUnits(ownerId: number, propertyId: number | null, units: Array<Record<string, unknown>>): Promise<number[]> {
    if (!propertyId || units.length === 0) return [];
    const str = (v: unknown) => (v == null || v === "" ? null : String(v));
    const int = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
    const numr = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : String(Number(v)));
    const ids: number[] = [];
    let created = 0;
    for (const u of units) {
      const ejarId = str(u.ejarId);
      if (ejarId) {
        const [found] = await this.db
          .select({ id: unitsTable.id })
          .from(unitsTable)
          .where(and(eq(unitsTable.propertyId, propertyId), eq(unitsTable.ejarId, ejarId)))
          .limit(1);
        if (found) { ids.push(found.id); continue; }
      }
      const [row] = await this.db
        .insert(unitsTable)
        .values({
          propertyId,
          unitNumber: str(u.unitNumber) || "—",
          floor: int(u.floor),
          area: numr(u.area),
          rentPrice: numr(u.rentPrice),
          typeOther: str(u.unitType),
          status: "rented",
          ejarId,
          ejarSource: "ejar",
        })
        .returning({ id: unitsTable.id });
      if (row) { ids.push(row.id); created++; }
    }
    if (created > 0) {
      await this.db
        .update(propertiesTable)
        .set({ totalUnits: sql`${propertiesTable.totalUnits} + ${created}` })
        .where(eq(propertiesTable.id, propertyId));
    }
    return ids;
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
