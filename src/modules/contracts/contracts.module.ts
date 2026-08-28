import { Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, isNull, or, ilike, count, asc, desc, inArray, notExists } from "drizzle-orm";
import { contractsTable, contractUnitsTable, contractRentTermsTable, unitsTable, propertiesTable, paymentsTable, paymentCollectionsTable, tenantsTable, simpleInvoicesTable, lookupsTable } from "@dara/database";

const DEPOSIT_DESC = "تأمين (وديعة)";

/** Parse + sanitise the per-year rent overrides sent by the client. */
function parseRentTerms(raw: any): { year: number; amount: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t: any) => ({ year: parseInt(t?.year, 10), amount: Number(t?.amount) }))
    .filter((t) => Number.isFinite(t.year) && t.year > 0 && Number.isFinite(t.amount) && t.amount > 0);
}
import { listQuerySchema } from "../../common/pagination";
import { rentVatFromUsage } from "../../common/usage-vat";
import { nextReceiptVoucherNumber } from "../../common/receipt-number";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { buildInstallments, applyExternalSettlement, type FeeEntry } from "./installments";
import { attachLookupLabels } from "../../common/lookups-resolve";

const CONTRACT_FIELDS = [
  "tenantId",
  "tenantType", "tenantName", "tenantIdNumber", "tenantPhone", "tenantEmail",
  "tenantTaxNumber", "tenantAddress", "tenantPostalCode", "tenantAdditionalNumber", "tenantBuildingNumber",
  "repName", "repIdNumber", "companyUnified", "companyOrgType",
  "signingDate", "signingPlace", "ejarContractNumber",
  "startDate", "endDate", "monthlyRent", "paymentFrequency", "depositAmount",
  "depositStatus", "depositDueDate", "depositMethod", "prepaidRent", "prepaidMethod",
  "vatEnabled", "escalationRate", "escalationType",
  "agencyFee", "firstPaymentAmount", "additionalFees", "customSchedule",
  "landlordName", "landlordIdNumber", "landlordPhone", "landlordEmail",
  "landlordTaxNumber", "landlordAddress", "landlordPostalCode", "landlordAdditionalNumber", "landlordBuildingNumber",
  "status", "notes", "isDraft", "attachmentKey", "settledExternalUntil",
] as const;

@ApiTags("contracts")
@ApiBearerAuth("user-jwt")
@Controller("contracts")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class ContractsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /**
   * Load the units of a set of contracts via the `contract_units` join
   * table, grouped by contract id. Each entry carries the unit row plus
   * its property's display fields — done as a separate query so a
   * multi-unit contract never multiplies the contract rows themselves.
   */
  /** Per-year rent overrides grouped by contract id. */
  private async rentTermsByContract(contractIds: number[]) {
    const map = new Map<number, { year: number; amount: number }[]>();
    if (contractIds.length === 0) return map;
    const rows = await this.db.select().from(contractRentTermsTable)
      .where(inArray(contractRentTermsTable.contractId, contractIds))
      .orderBy(asc(contractRentTermsTable.year));
    for (const r of rows) {
      const list = map.get(r.contractId) ?? [];
      list.push({ year: r.year, amount: Number(r.amount) });
      map.set(r.contractId, list);
    }
    return map;
  }

  private async unitsByContract(contractIds: number[]) {
    const map = new Map<number, any[]>();
    if (contractIds.length === 0) return map;
    const rows = await this.db
      .select({
        contractId: contractUnitsTable.contractId,
        unit: unitsTable,
        propertyName: propertiesTable.name,
        propertyTypeLookupId: propertiesTable.typeLookupId,
        propertyBuildingType: propertiesTable.buildingType,
        propertyUsageLookupId: propertiesTable.usageLookupId,
        propertyFloors: propertiesTable.floors,
        propertyElevators: propertiesTable.elevators,
        propertyParkings: propertiesTable.parkings,
        propertyCityLookupId: propertiesTable.cityLookupId,
        propertyDistrict: propertiesTable.district,
        propertyTotalUnits: propertiesTable.totalUnits,
      })
      .from(contractUnitsTable)
      .innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
      .leftJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
      .where(inArray(contractUnitsTable.contractId, contractIds))
      .orderBy(asc(contractUnitsTable.id));
    for (const r of rows) {
      const list = map.get(r.contractId) ?? [];
      list.push({
        ...r.unit,
        propertyName: r.propertyName,
        propertyTypeLookupId: r.propertyTypeLookupId,
        propertyBuildingType: r.propertyBuildingType,
        propertyUsageLookupId: r.propertyUsageLookupId,
        propertyFloors: r.propertyFloors,
        propertyElevators: r.propertyElevators,
        propertyParkings: r.propertyParkings,
        propertyCityLookupId: r.propertyCityLookupId,
        propertyDistrict: r.propertyDistrict,
        propertyTotalUnits: r.propertyTotalUnits,
      });
      map.set(r.contractId, list);
    }
    // Resolve the lookup FKs back to the text fields the clients expect.
    await attachLookupLabels(this.db, [...map.values()].flat(), [
      { idField: "typeLookupId", out: "type", mode: "key" },
      { idField: "finishingLookupId", out: "finishing", mode: "key" },
      { idField: "propertyTypeLookupId", out: "propertyType", mode: "key" },
      { idField: "propertyUsageLookupId", out: "propertyUsageType", mode: "key" },
      { idField: "propertyCityLookupId", out: "propertyCity", mode: "labelAr" },
    ]);
    return map;
  }

  /**
   * Attach `units` to each contract, plus a primary unit/property surface
   * (`unitNumber`, `propertyId`, `propertyName`, …) taken from the first
   * unit — keeps the list/detail UIs working without an N-way join.
   */
  private withUnits<T extends { id: number }>(rows: T[], unitsByContract: Map<number, any[]>) {
    return rows.map((row) => {
      const units = unitsByContract.get(row.id) ?? [];
      const first: any = units[0] ?? null;
      return {
        ...row,
        units,
        unitId: first?.id ?? null,
        unitNumber: first?.unitNumber ?? null,
        propertyId: first?.propertyId ?? null,
        propertyName: first?.propertyName ?? null,
        propertyType: first?.propertyType ?? null,
        propertyBuildingType: first?.propertyBuildingType ?? null,
        propertyUsageType: first?.propertyUsageType ?? null,
        propertyFloors: first?.propertyFloors ?? null,
        propertyElevators: first?.propertyElevators ?? null,
        propertyParkings: first?.propertyParkings ?? null,
        propertyCity: first?.propertyCity ?? null,
        propertyDistrict: first?.propertyDistrict ?? null,
        propertyTotalUnits: first?.propertyTotalUnits ?? null,
      };
    });
  }

  @Get()
  @RequirePermissions(PERMISSIONS.CONTRACTS_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const usePaginated = rawQuery && (rawQuery.page != null || rawQuery.pageSize != null || rawQuery.search != null);
    const q = listQuerySchema.parse(rawQuery ?? {});
    const baseWhere = and(eq(contractsTable.userId, scopeId(user)), isNull(contractsTable.deletedAt));
    const where = q.search ? and(baseWhere, or(
      ilike(contractsTable.contractNumber, `%${q.search}%`),
      ilike(contractsTable.tenantName, `%${q.search}%`),
      ilike(contractsTable.tenantIdNumber, `%${q.search}%`),
      ilike(contractsTable.tenantPhone, `%${q.search}%`),
    )) : baseWhere;

    let rowsQ = this.db
      .select({
        id: contractsTable.id,
        contractNumber: contractsTable.contractNumber,
        tenantId: contractsTable.tenantId,
        tenantType: contractsTable.tenantType,
        tenantName: contractsTable.tenantName,
        tenantShortName: tenantsTable.shortName,
        tenantIdNumber: contractsTable.tenantIdNumber,
        tenantPhone: contractsTable.tenantPhone,
        tenantEmail: contractsTable.tenantEmail,
        tenantTaxNumber: contractsTable.tenantTaxNumber,
        tenantAddress: contractsTable.tenantAddress,
        tenantPostalCode: contractsTable.tenantPostalCode,
        tenantAdditionalNumber: contractsTable.tenantAdditionalNumber,
        tenantBuildingNumber: contractsTable.tenantBuildingNumber,
        repName: contractsTable.repName,
        repIdNumber: contractsTable.repIdNumber,
        companyUnified: contractsTable.companyUnified,
        companyOrgType: contractsTable.companyOrgType,
        signingDate: contractsTable.signingDate,
        signingPlace: contractsTable.signingPlace,
        ejarContractNumber: contractsTable.ejarContractNumber,
        startDate: contractsTable.startDate,
        endDate: contractsTable.endDate,
        monthlyRent: contractsTable.monthlyRent,
        paymentFrequency: contractsTable.paymentFrequency,
        depositAmount: contractsTable.depositAmount,
        depositStatus: contractsTable.depositStatus,
        depositDueDate: contractsTable.depositDueDate,
        depositMethod: contractsTable.depositMethod,
        prepaidRent: contractsTable.prepaidRent,
        prepaidMethod: contractsTable.prepaidMethod,
        vatEnabled: contractsTable.vatEnabled,
        escalationRate: contractsTable.escalationRate,
        escalationType: contractsTable.escalationType,
        agencyFee: contractsTable.agencyFee,
        firstPaymentAmount: contractsTable.firstPaymentAmount,
        additionalFees: contractsTable.additionalFees,
        customSchedule: contractsTable.customSchedule,
        landlordName: contractsTable.landlordName,
        landlordIdNumber: contractsTable.landlordIdNumber,
        landlordPhone: contractsTable.landlordPhone,
        landlordEmail: contractsTable.landlordEmail,
        landlordTaxNumber: contractsTable.landlordTaxNumber,
        landlordAddress: contractsTable.landlordAddress,
        landlordPostalCode: contractsTable.landlordPostalCode,
        landlordAdditionalNumber: contractsTable.landlordAdditionalNumber,
        landlordBuildingNumber: contractsTable.landlordBuildingNumber,
        status: contractsTable.status,
        notes: contractsTable.notes,
        attachmentKey: contractsTable.attachmentKey,
        settledExternalUntil: contractsTable.settledExternalUntil,
        isDraft: contractsTable.isDraft,
        createdAt: contractsTable.createdAt,
      })
      .from(contractsTable)
      .leftJoin(tenantsTable, eq(contractsTable.tenantId, tenantsTable.id))
      .where(where)
      .orderBy((q.order === "asc" ? asc : desc)(contractsTable.createdAt))
      .$dynamic();
    if (usePaginated) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow] = await Promise.all([
      rowsQ,
      usePaginated ? this.db.select({ total: count() }).from(contractsTable).where(where) : Promise.resolve([{ total: 0 }]),
    ]);
    const ids = rows.map((r) => r.id);
    const [unitsMap, termsMap] = await Promise.all([
      this.unitsByContract(ids),
      this.rentTermsByContract(ids),
    ]);
    const data = this.withUnits(rows, unitsMap).map((c) => ({ ...c, rentTerms: termsMap.get(c.id) ?? [] }));
    if (!usePaginated) return data;
    return { data, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0) };
  }


  /**
   * Rent VAT for a contract.
   *
   * Residential rent is exempt, everything else is taxable at 15% — see
   * common/usage-vat.ts. Derived here rather than trusted from the request so
   * a stale client (or an Ejar import, which never goes through the wizard)
   * cannot produce a residential contract carrying VAT, or a commercial one
   * without it.
   *
   * The caller's choice is honoured only where usage genuinely does not
   * decide: a mixed-use property whose unit has no usage of its own.
   */
  private async resolveRentVat(body: any, requested: boolean): Promise<boolean> {
    const unitId = Number(body?.unitId ?? (Array.isArray(body?.unitIds) ? body.unitIds[0] : null));
    if (!Number.isFinite(unitId) || unitId <= 0) return requested;

    const [row] = await this.db
      .select({
        propertyUsageId: propertiesTable.usageLookupId,
        unitUsageId: unitsTable.usageLookupId,
      })
      .from(unitsTable)
      .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
      .where(eq(unitsTable.id, unitId));
    if (!row) return requested;

    // Resolve both FKs to their lookup keys in one query.
    const ids = [row.propertyUsageId, row.unitUsageId].filter((v): v is number => v != null);
    const keyById = new Map<number, string>();
    if (ids.length) {
      const rows = await this.db
        .select({ id: lookupsTable.id, key: lookupsTable.key })
        .from(lookupsTable)
        .where(inArray(lookupsTable.id, ids));
      for (const r of rows) keyById.set(r.id, r.key);
    }

    const verdict = rentVatFromUsage(
      row.propertyUsageId != null ? keyById.get(row.propertyUsageId) ?? null : null,
      row.unitUsageId != null ? keyById.get(row.unitUsageId) ?? null : null,
    );
    return verdict === null ? requested : verdict;
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CONTRACTS_WRITE)
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    const isDraft = Boolean(body.isDraft ?? false);
    // A contract spans one or more units (`unitIds`). The legacy single
    // `unitId` is still accepted so older callers keep working.
    const unitIds: number[] = (Array.isArray(body.unitIds) && body.unitIds.length > 0
      ? body.unitIds
      : (body.unitId != null ? [body.unitId] : []))
      .map((n: any) => Number(n))
      .filter((n: number) => Number.isFinite(n) && n > 0);
    if (unitIds.length === 0 || (!isDraft && (!body.tenantName || !body.startDate || !body.endDate || !body.monthlyRent))) {
      throw new BadRequestException(isDraft ? "اختر وحدة واحدة على الأقل لحفظ المسودة" : "البيانات الأساسية مطلوبة");
    }
    // Draft contracts may be incomplete — fall back so NOT NULL columns hold.
    const today = new Date().toISOString().slice(0, 10);
    const tenantName = body.tenantName || (isDraft ? "—" : body.tenantName);
    const startDate = body.startDate || (isDraft ? today : body.startDate);
    const endDate = body.endDate || (isDraft ? today : body.endDate);
    const monthlyRent = body.monthlyRent || (isDraft ? "0" : body.monthlyRent);

    const freq = body.paymentFrequency || "monthly";
    const ownerId = scopeId(user);
    // Existing/legacy contract: rent due before this date was settled outside
    // the portal. Normalised to YYYY-MM-DD or null.
    const settledExternalUntil: string | null = body.settledExternalUntil
      ? String(body.settledExternalUntil).slice(0, 10)
      : null;
    // Per-account sequential contract number (EQ-000001, EQ-000002 …). Each
    // account has its own counter (unique is composite on user_id + number).
    const [cCount] = await this.db.select({ c: count() }).from(contractsTable)
      .where(eq(contractsTable.userId, ownerId));
    const contractNumber = `EQ-${String(Number(cCount?.c ?? 0) + 1).padStart(6, "0")}`;

    const additionalFees: FeeEntry[] | null = body.additionalFees && Array.isArray(body.additionalFees) && body.additionalFees.length > 0 ? body.additionalFees : null;
    // Custom payment schedule — only kept when the cycle is "custom".
    const customSchedule = freq === "custom" && Array.isArray(body.customSchedule)
      ? body.customSchedule
          .map((e: any) => ({ dueDate: String(e?.dueDate ?? "").slice(0, 10), amount: String(e?.amount ?? "") }))
          .filter((e: any) => e.dueDate && Number(e.amount) > 0)
      : null;

    const [contract] = await this.db.insert(contractsTable).values({
      userId: ownerId,
      contractNumber,
      tenantId: body.tenantId != null ? Number(body.tenantId) : null,
      tenantType: body.tenantType ?? null,
      tenantName,
      tenantIdNumber: body.tenantIdNumber ?? null,
      tenantPhone: body.tenantPhone ?? null,
      tenantEmail: body.tenantEmail ?? null,
      tenantTaxNumber: body.tenantTaxNumber ?? null,
      tenantAddress: body.tenantAddress ?? null,
      tenantPostalCode: body.tenantPostalCode ?? null,
      tenantAdditionalNumber: body.tenantAdditionalNumber ?? null,
      tenantBuildingNumber: body.tenantBuildingNumber ?? null,
      repName: body.repName ?? null,
      repIdNumber: body.repIdNumber ?? null,
      companyUnified: body.companyUnified ?? null,
      companyOrgType: body.companyOrgType ?? null,
      signingDate: body.signingDate ?? null,
      signingPlace: body.signingPlace ?? null,
      ejarContractNumber: body.ejarContractNumber ?? null,
      startDate,
      endDate,
      monthlyRent: String(monthlyRent),
      paymentFrequency: freq,
      depositAmount: body.depositAmount ? String(body.depositAmount) : null,
      depositStatus: body.depositStatus ?? null,
      depositDueDate: body.depositDueDate ?? null,
      depositMethod: body.depositMethod ?? null,
      prepaidRent: body.prepaidRent != null ? String(body.prepaidRent) : "0",
      prepaidMethod: body.prepaidMethod ?? null,
      vatEnabled: await this.resolveRentVat(body, Boolean(body.vatEnabled ?? false)),
      escalationType: body.escalationType === "amount" ? "amount" : "percent",
      escalationRate: body.escalationRate != null ? String(body.escalationRate) : "0",
      agencyFee: body.agencyFee ? String(body.agencyFee) : null,
      firstPaymentAmount: body.firstPaymentAmount ? String(body.firstPaymentAmount) : null,
      additionalFees,
      customSchedule: customSchedule && customSchedule.length > 0 ? customSchedule : null,
      landlordName: body.landlordName ?? null,
      landlordIdNumber: body.landlordIdNumber ?? null,
      landlordPhone: body.landlordPhone ?? null,
      landlordEmail: body.landlordEmail ?? null,
      landlordTaxNumber: body.landlordTaxNumber ?? null,
      landlordAddress: body.landlordAddress ?? null,
      landlordPostalCode: body.landlordPostalCode ?? null,
      landlordAdditionalNumber: body.landlordAdditionalNumber ?? null,
      landlordBuildingNumber: body.landlordBuildingNumber ?? null,
      status: body.isDraft ? "pending" : "active",
      attachmentKey: body.attachmentKey ?? null,
      settledExternalUntil: settledExternalUntil,
      notes: body.notes ?? null,
      isDraft: Boolean(body.isDraft ?? false),
      isDemo: false,
    }).returning();

    // Link every unit to the new contract.
    await this.db.insert(contractUnitsTable).values(
      unitIds.map((unitId) => ({ contractId: contract!.id, unitId })),
    );

    // Per-year rent overrides (saved for drafts too, so they prefill on edit).
    const rentTerms = parseRentTerms(body.rentTerms);
    if (rentTerms.length > 0) {
      await this.db.insert(contractRentTermsTable).values(
        rentTerms.map((t) => ({ contractId: contract!.id, year: t.year, amount: String(t.amount) })),
      );
    }

    // A draft contract doesn't occupy its units and generates no
    // installments until it is finalised.
    if (isDraft) {
      return { ...contract, unitIds, installmentsCreated: 0 };
    }

    await this.db.update(unitsTable).set({ status: "rented" }).where(inArray(unitsTable.id, unitIds));

    // Build installments at their FULL amount (prepaid is NOT deducted — it's
    // recorded as a collection below so each installment shows its full value
    // with the remaining).
    const rows = applyExternalSettlement(
      buildInstallments(
        contract!.id, ownerId, startDate, endDate, String(monthlyRent), freq, additionalFees,
        Boolean(body.vatEnabled ?? false), Number(body.escalationRate) || 0,
        body.escalationType === "amount" ? "amount" : "percent",
        rentTerms, 0, customSchedule,
      ),
      settledExternalUntil,
    );
    const inserted = rows.length > 0 ? await this.db.insert(paymentsTable).values(rows).returning() : [];

    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const nowStr = new Date().toISOString().slice(0, 10);
    const startDay = body.startDate || nowStr;

    // Advance/prepaid rent → record as a collection on the earliest rent
    // installments (keeps full amount; flips them to paid / partially_paid).
    // The advance carries its OWN receipt-voucher number so it shows in the
    // Collections tab as a distinct سند القبض — the later collection of the
    // remaining balance produces a second voucher. (Hence: with advance rent
    // there are two receipt vouchers for the rent — advance + remainder.)
    const prepaid = round2(Number(body.prepaidRent) || 0);
    if (prepaid > 0 && inserted.length > 0) {
      const method = body.prepaidMethod || "bank_transfer";
      const advanceVoucher = await this.nextReceiptNumber(ownerId);

      /* Which additional fees the advance is allowed to settle.
       *
       * The advance used to go to rent alone: `!p.description` matched rent
       * installments and nothing else. A landlord who collected enough up front
       * to cover the service fee as well had no way to say so — the fee sat
       * unpaid next to a rent installment that was already covered, and had to
       * be collected again by hand.
       *
       * Matched by NAME, because that is what an installment carries:
       * `appendFees()` writes `description = fee.name`. The fee `id` lives only
       * on the contract's JSON and never reaches the payments table. Two fees
       * sharing a name are therefore indistinguishable here — they are also
       * indistinguishable on the schedule, so this adds no new ambiguity.
       */
      const pickedFeeIds = new Set(
        (Array.isArray(body.prepaidFeeIds) ? body.prepaidFeeIds : []).map((v: unknown) => String(v)),
      );
      const pickedFeeNames = new Set(
        (additionalFees ?? [])
          .filter((f: any) => pickedFeeIds.has(String(f?.id)))
          .map((f: any) => String(f?.name || "رسوم")),
      );

      /* Rent is a choice too, not a fixture. A landlord may have taken the
       * advance specifically to clear the fees and be collecting rent monthly
       * as normal — forcing rent to absorb it first made that impossible to
       * express. Defaults to true, so a caller that says nothing gets exactly
       * the historical behaviour.
       *
       * If the caller manages to select nothing at all, fall back to rent
       * rather than settling nothing: the amount is already recorded on the
       * contract, and quietly applying it to no installment would leave money
       * banked against a schedule that still reads as fully unpaid. */
      const wantsRent = body.prepaidCoversRent !== false;
      const coversRent = (wantsRent || pickedFeeNames.size === 0);

      /* Which of the chosen items gets paid first.
       *
       * Ticking a fee is worthless without this. Rent installments dwarf fees —
       * 100,000 rent against a 1,000 service fee is ordinary — so a
       * rent-first advance is swallowed whole by the first rent row and the fee
       * it was explicitly ticked for receives nothing. The tick looked like it
       * did nothing because, in that shape, it did.
       *
       * "fees" clears the ticked fees first and puts the remainder on rent,
       * which is what someone ticking a fee almost always means. Defaults to
       * "rent" — the historical behaviour, and the safer one, since rent is the
       * obligation that accrues late fees.
       */
      const feesFirst = String(body.prepaidPriority ?? "rent") === "fees";

      const settleRows = inserted
        .filter((p) => p.status !== "settled_external"
          && (p.description ? pickedFeeNames.has(p.description) : coversRent))
        .sort((a, b) => {
          const aFee = !!a.description, bFee = !!b.description;
          // Priority decides the class order; due date orders within a class,
          // so the money still walks the schedule forwards.
          if (aFee !== bFee) return feesFirst ? (aFee ? -1 : 1) : (aFee ? 1 : -1);
          return String(a.dueDate).localeCompare(String(b.dueDate));
        });

      let left = prepaid;
      let applied = 0;
      for (const p of settleRows) {
        if (left <= 0.01) break;
        const full = round2(Number(p.amount));
        const amt = round2(Math.min(left, full));
        await this.db.insert(paymentCollectionsTable).values({
          paymentId: p.id, userId: ownerId, amount: amt.toFixed(2),
          collectedDate: startDay, method, receiptNumber: advanceVoucher,
          // This exact string buckets the collection as "advance" when the
          // contract is ended (see settlementBuckets) — a fee-covering
          // collection is still part of the advance, so it must not diverge.
          notes: "إيجار مدفوع مقدماً", attachmentKey: body.prepaidAttachmentKey ?? null,
        } as any);
        const fully = amt >= full - 0.01;
        await this.db.update(paymentsTable)
          .set({ status: fully ? "paid" : "partially_paid", paidDate: fully ? startDay : null })
          .where(eq(paymentsTable.id, p.id));
        left = round2(left - amt);
        applied = round2(applied + amt);
      }
      // Advance receipt-voucher DOCUMENT (kind="receipt") so the advance shows in
      // the Receipt Vouchers page too — it shares the RV number stamped on the
      // collection(s) above. Not linked to an installment (the collection is),
      // so it doesn't double-count in collections.
      if (applied > 0.01) {
        const c = contract!;
        await this.db.insert(simpleInvoicesTable).values({
          userId: ownerId, number: advanceVoucher, type: "invoice", kind: "receipt", status: "confirmed",
          contractId: c.id, tenantId: c.tenantId ?? null, tenantName: c.tenantName ?? null,
          items: [{ description: "إيجار مدفوع مقدماً", quantity: 1, unitPrice: applied, amount: applied, vat: false }],
          subtotal: applied.toFixed(2), total: applied.toFixed(2),
          issueDate: startDay, paidDate: startDay, confirmedAt: new Date(),
          receiptNumber: advanceVoucher, paymentMethod: method, notes: "إيجار مدفوع مقدماً",
          attachmentKey: body.prepaidAttachmentKey ?? null,
        } as any);
      }
    }

    // Collected deposit → issue a receipt voucher (سند قبض) only. A deposit is
    // held trust money (amanat), NOT rent revenue — it is no longer an
    // installment/payment row, so it never appears in the financial schedule.
    // The voucher is viewable from the contract once the deposit is collected.
    const depositAmt = round2(Number(body.depositAmount) || 0);
    if (depositAmt > 0 && body.depositStatus === "collected") {
      await this.createDepositVoucher(
        ownerId, contract!, depositAmt, body.depositDueDate || startDay, body.depositMethod || "bank_transfer",
        body.depositAttachmentKey ?? null,
      );
    }

    return { ...contract, unitIds, installmentsCreated: inserted.length };
  }

  /** Next per-account receipt-voucher (سند قبض) number: RV-000001, … */
  private async nextReceiptNumber(ownerId: number): Promise<string> {
    return nextReceiptVoucherNumber(this.db, ownerId);
  }

  /**
   * Issue a deposit receipt voucher (سند قبض) for a contract: a confirmed
   * simple-invoice marked `kind="deposit"` (so it stays out of revenue/reports),
   * no VAT, stamped with an RV number. This is the ONLY artefact a collected
   * deposit produces — there is no installment/payment row for it.
   */
  private async createDepositVoucher(ownerId: number, contract: any, amount: number, date: string, method: string, attachmentKey?: string | null) {
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const amt = round2(amount);
    const voucher = await this.nextReceiptNumber(ownerId);
    // A deposit voucher is a سند قبض, not a tax invoice — its number IS the RV
    // number; it never consumes an INV-#### sequence.
    const number = voucher;
    const [doc] = await this.db.insert(simpleInvoicesTable).values({
      userId: ownerId, number, type: "invoice", kind: "deposit", status: "confirmed",
      contractId: contract.id, tenantId: contract.tenantId ?? null, tenantName: contract.tenantName ?? null,
      items: [{ description: DEPOSIT_DESC, quantity: 1, unitPrice: amt, amount: amt, vat: false }],
      subtotal: amt.toFixed(2), total: amt.toFixed(2),
      issueDate: date, paidDate: date, confirmedAt: new Date(),
      receiptNumber: voucher, paymentMethod: method, notes: DEPOSIT_DESC,
      attachmentKey: attachmentKey ?? null,
    } as any).returning();
    return doc;
  }

  /**
   * Deposit summary for a contract: amount, status, and its receipt voucher (if
   * collected). Drives the deposit card on the contract detail.
   */
  @Get(":contractId/deposit")
  @RequirePermissions(PERMISSIONS.CONTRACTS_VIEW)
  async getDeposit(@CurrentUser() user: AuthUser, @Param("contractId") contractId: string) {
    const id = parseInt(contractId, 10);
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const ownerId = scopeId(user);
    const [contract] = await this.db.select({
      depositAmount: contractsTable.depositAmount, depositStatus: contractsTable.depositStatus,
      depositMethod: contractsTable.depositMethod, depositDueDate: contractsTable.depositDueDate,
    }).from(contractsTable)
      .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, ownerId), isNull(contractsTable.deletedAt)));
    if (!contract) throw new NotFoundException("Contract not found");
    const [voucher] = await this.db.select().from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.userId, ownerId), eq(simpleInvoicesTable.contractId, id),
        eq(simpleInvoicesTable.kind, "deposit"), isNull(simpleInvoicesTable.deletedAt)))
      .orderBy(desc(simpleInvoicesTable.id)).limit(1);
    // The advance/prepaid-rent receipt voucher (سند قبض), if any — so the contract
    // detail can show its proof alongside the deposit.
    const [prepaidVoucher] = await this.db.select().from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.userId, ownerId), eq(simpleInvoicesTable.contractId, id),
        eq(simpleInvoicesTable.kind, "receipt"), isNull(simpleInvoicesTable.deletedAt)))
      .orderBy(desc(simpleInvoicesTable.id)).limit(1);
    return {
      amount: round2(Number(contract.depositAmount) || 0),
      status: contract.depositStatus ?? null,
      method: contract.depositMethod ?? null,
      dueDate: contract.depositDueDate ?? null,
      voucher: voucher ?? null,
      prepaidVoucher: prepaidVoucher ?? null,
    };
  }

  /**
   * Collect a contract's deposit — marks it collected on the contract and issues
   * the receipt voucher (سند قبض). Idempotent: returns the existing voucher if
   * the deposit was already collected.
   */
  @Post(":contractId/collect-deposit")
  @RequirePermissions(PERMISSIONS.PAYMENTS_WRITE)
  async collectDeposit(@CurrentUser() user: AuthUser, @Param("contractId") contractId: string, @Body() body: any) {
    const id = parseInt(contractId, 10);
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const ownerId = scopeId(user);
    const [contract] = await this.db.select().from(contractsTable)
      .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, ownerId), isNull(contractsTable.deletedAt)));
    if (!contract) throw new NotFoundException("Contract not found");
    const amt = round2(Number(contract.depositAmount) || 0);
    if (!(amt > 0)) throw new BadRequestException("لا يوجد مبلغ تأمين على هذا العقد");

    const [existing] = await this.db.select().from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.userId, ownerId), eq(simpleInvoicesTable.contractId, id),
        eq(simpleInvoicesTable.kind, "deposit"), isNull(simpleInvoicesTable.deletedAt)))
      .orderBy(desc(simpleInvoicesTable.id)).limit(1);
    if (existing && existing.status !== "cancelled") {
      if (contract.depositStatus !== "collected") {
        await this.db.update(contractsTable).set({ depositStatus: "collected" } as any).where(eq(contractsTable.id, id));
      }
      return { voucher: existing };
    }

    const date = body?.paidDate || new Date().toISOString().slice(0, 10);
    const method = body?.method || contract.depositMethod || "bank_transfer";
    const voucher = await this.createDepositVoucher(ownerId, contract, amt, date, method);
    await this.db.update(contractsTable)
      .set({ depositStatus: "collected", depositMethod: method, depositDueDate: contract.depositDueDate || date } as any)
      .where(eq(contractsTable.id, id));
    return { voucher };
  }

  @Post(":contractId/generate-installments")
  @RequirePermissions(PERMISSIONS.CONTRACTS_WRITE)
  async generateInstallments(@CurrentUser() user: AuthUser, @Param("contractId") contractId: string, @Body() body: any) {
    const id = parseInt(contractId, 10);
    const ownerId = scopeId(user);
    const [contract] = await this.db.select().from(contractsTable)
      .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, ownerId), isNull(contractsTable.deletedAt)));
    if (!contract) throw new NotFoundException("Contract not found");

    // Never regenerate once money has been collected — re-creating rent rows
    // alongside already-paid ones would duplicate periods. Only fully-pending
    // contracts can be safely rebuilt from their (possibly edited) schedule.
    const existing = await this.db.select({ status: paymentsTable.status }).from(paymentsTable)
      .where(and(eq(paymentsTable.contractId, id), eq(paymentsTable.userId, ownerId), isNull(paymentsTable.deletedAt)));
    if (existing.some((p) => p.status === "paid" || p.status === "partially_paid")) {
      return { success: false, skipped: true, reason: "has_collected_payments", installmentsCreated: 0 };
    }

    // Soft-delete the AUTO-generated installments (pending + settled_external)
    // before regenerating — both are rebuilt from the contract terms, so this
    // avoids duplicate periods. Collected rows (paid/partial) already blocked above.
    await this.db.update(paymentsTable).set({ deletedAt: new Date() } as any).where(
      and(
        eq(paymentsTable.contractId, id),
        eq(paymentsTable.userId, ownerId),
        inArray(paymentsTable.status, ["pending", "settled_external"] as any),
        isNull(paymentsTable.deletedAt),
      )
    );

    const freq = (body?.paymentFrequency as string) || contract.paymentFrequency || "monthly";
    const termRows = await this.db.select().from(contractRentTermsTable)
      .where(eq(contractRentTermsTable.contractId, id));
    const rentTerms = termRows.map((t) => ({ year: t.year, amount: Number(t.amount) }));
    const rows = applyExternalSettlement(
      buildInstallments(
        contract.id, ownerId,
        contract.startDate, contract.endDate,
        contract.monthlyRent, freq,
        (contract.additionalFees as FeeEntry[] | null) ?? null,
        Boolean(contract.vatEnabled), Number(contract.escalationRate) || 0,
        (contract as any).escalationType || "percent",
        rentTerms, 0, // prepaid is tracked as a collection, not a deduction
        ((contract as any).customSchedule as { dueDate: string; amount: string }[] | null) ?? null,
      ),
      (contract as any).settledExternalUntil ?? null,
    );
    if (rows.length > 0) await this.db.insert(paymentsTable).values(rows);
    return { success: true, installmentsCreated: rows.length };
  }

  @Patch(":contractId")
  @RequirePermissions(PERMISSIONS.CONTRACTS_WRITE)
  async update(@CurrentUser() user: AuthUser, @Param("contractId") contractId: string, @Body() body: any) {
    const id = parseInt(contractId, 10);
    const updateData: Record<string, unknown> = {};
    for (const f of CONTRACT_FIELDS) if (body[f] !== undefined) updateData[f] = body[f];
    // tenant_id is an integer FK — coerce the incoming value (or clear it).
    if (body.tenantId !== undefined) updateData.tenantId = body.tenantId != null ? Number(body.tenantId) : null;

    const [contract] = await this.db.update(contractsTable)
      .set(updateData)
      .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, scopeId(user)), isNull(contractsTable.deletedAt)))
      .returning();
    if (!contract) throw new NotFoundException("Contract not found");

    // Replace the per-year rent overrides when the client sends them.
    if (body.rentTerms !== undefined) {
      await this.db.delete(contractRentTermsTable).where(eq(contractRentTermsTable.contractId, id));
      const terms = parseRentTerms(body.rentTerms);
      if (terms.length > 0) {
        await this.db.insert(contractRentTermsTable).values(
          terms.map((t) => ({ contractId: id, year: t.year, amount: String(t.amount) })),
        );
      }
    }

    // A status change cascades to every unit the contract covers.
    const newStatus = body.status as string | undefined;
    if (newStatus === "terminated" || newStatus === "expired" || newStatus === "active") {
      const unitIds = (await this.db.select({ unitId: contractUnitsTable.unitId })
        .from(contractUnitsTable).where(eq(contractUnitsTable.contractId, id))).map((r) => r.unitId);
      if (unitIds.length > 0) {
        const unitStatus = newStatus === "active" ? "rented" : "available";
        await this.db.update(unitsTable).set({ status: unitStatus }).where(inArray(unitsTable.id, unitIds));
      }
    }
    return contract;
  }

  /**
   * End a contract. This does NOT delete it — the contract stays as a
   * historical record with status `terminated`. Its units are unlinked
   * and freed (status `available`).
   *
   * NOTE: the installment/payment/invoice settlement on termination is
   * intentionally DISABLED for now (commented below) — terminating a
   * contract must not touch its installments/payments/invoices. Re-enable
   * the block when the settlement behaviour is finalised.
   */
  /**
   * End a contract. The `mode` query param decides what happens to the still-
   * unpaid installments:
   *   - "paid"      → settle them all as paid (closes the contract as fully
   *                   collected — "consider all installments as paid").
   *   - "cancelled" → mark every not-paid installment as cancelled.
   *   - undefined   → leave installments untouched (legacy behaviour).
   * The contract is marked "terminated" and its units freed either way.
   */
  @Delete(":contractId")
  @RequirePermissions(PERMISSIONS.CONTRACTS_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param("contractId") contractId: string, @Query("mode") mode?: string) {
    const id = parseInt(contractId, 10);
    const now = new Date();
    // Cancelling the unpaid installments cancels the contract; otherwise it's a
    // normal termination.
    const endStatus = mode === "cancelled" ? "cancelled" : "terminated";
    const [contract] = await this.db.update(contractsTable)
      .set({ status: endStatus })
      .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, scopeId(user)), isNull(contractsTable.deletedAt)))
      .returning();
    if (!contract) throw new NotFoundException("Contract not found");

    // Free every unit the contract covered, then drop the contract↔unit
    // linkage so the units are fully released.
    const unitIds = (await this.db.select({ unitId: contractUnitsTable.unitId })
      .from(contractUnitsTable).where(eq(contractUnitsTable.contractId, id))).map((r) => r.unitId);
    if (unitIds.length > 0) {
      await this.db.update(unitsTable).set({ status: "available" }).where(inArray(unitsTable.id, unitIds));
    }
    await this.db.delete(contractUnitsTable).where(eq(contractUnitsTable.contractId, id));

    // Settle the still-unpaid installments per the chosen mode. Only rows that
    // aren't already fully paid (pending/overdue/partially_paid) are affected.
    const unsettled = ["pending", "overdue", "partially_paid"] as any;
    if (mode === "paid") {
      await this.db.update(paymentsTable)
        .set({ status: "paid", paidDate: now.toISOString().slice(0, 10) } as any)
        .where(and(eq(paymentsTable.contractId, id), isNull(paymentsTable.deletedAt), inArray(paymentsTable.status, unsettled)));
    } else if (mode === "cancelled") {
      await this.db.update(paymentsTable)
        .set({ status: "cancelled" } as any)
        .where(and(
          eq(paymentsTable.contractId, id), isNull(paymentsTable.deletedAt),
          inArray(paymentsTable.status, unsettled),
          // Never void an installment that already holds collected money. A
          // partially-collected row is in `unsettled`, so cancelling a contract
          // used to flip it to "cancelled" — and every total derived from
          // payment status then stopped counting money the landlord really
          // received. It stays as it is; only untouched rows are voided.
          notExists(
            this.db.select({ id: paymentCollectionsTable.id }).from(paymentCollectionsTable)
              .where(eq(paymentCollectionsTable.paymentId, paymentsTable.id)),
          ),
        ));
    }
    return {
      success: true,
      message: mode === "paid" ? "تم إنهاء العقد واعتبار جميع الأقساط مدفوعة"
        : mode === "cancelled" ? "تم إنهاء العقد وإلغاء الأقساط غير المدفوعة"
        : "تم إنهاء العقد",
    };
  }

  /**
   * Group every amount already collected on a contract into three buckets so
   * the cancellation dialog can ask the landlord what to do with each:
   *   - deposit      → collections on the "تأمين (وديعة)" payment row.
   *   - advance      → collections marked "إيجار مدفوع مقدماً" (prepaid rent).
   *   - installments → any other collected rent / fees.
   * Sums are NET (negative refund rows reduce a bucket), so an already-settled
   * bucket reads 0.
   */
  private async collectedBuckets(contractId: number) {
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const pays = await this.db.select({ id: paymentsTable.id, description: paymentsTable.description })
      .from(paymentsTable)
      .where(and(eq(paymentsTable.contractId, contractId), isNull(paymentsTable.deletedAt)));
    const depIds = new Set(pays.filter((p) => p.description === "تأمين (وديعة)").map((p) => p.id));
    const payIds = pays.map((p) => p.id);
    const cols = payIds.length
      ? await this.db.select().from(paymentCollectionsTable).where(inArray(paymentCollectionsTable.paymentId, payIds))
      : [];
    const mk = () => ({ total: 0, rows: [] as { paymentId: number; amount: number }[] });
    const deposit = mk(), advance = mk(), installments = mk();
    for (const c of cols) {
      const amt = Number(c.amount);
      const b = depIds.has(c.paymentId) ? deposit : c.notes === "إيجار مدفوع مقدماً" ? advance : installments;
      b.total = round2(b.total + amt);
      b.rows.push({ paymentId: c.paymentId, amount: amt });
    }
    // New-model deposits are receipt vouchers (kind="deposit"), not payment
    // rows — add their value to the deposit bucket and track them for refund.
    const depVouchers = await this.db.select({ id: simpleInvoicesTable.id, total: simpleInvoicesTable.total })
      .from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.contractId, contractId), eq(simpleInvoicesTable.kind, "deposit"),
        eq(simpleInvoicesTable.status, "confirmed"), isNull(simpleInvoicesTable.deletedAt)));
    const depositVoucherIds: number[] = [];
    let depositVoucherTotal = 0;
    for (const v of depVouchers) {
      deposit.total = round2(deposit.total + Number(v.total));
      depositVoucherTotal = round2(depositVoucherTotal + Number(v.total));
      depositVoucherIds.push(v.id);
    }
    return { deposit, advance, installments, depositVoucherIds, depositVoucherTotal };
  }

  /** Next per-account disbursement-voucher (سند صرف) number: RFND-0001, … */
  private async nextRefundNumber(ownerId: number): Promise<string> {
    const rows = await this.db.select({ rn: paymentCollectionsTable.receiptNumber })
      .from(paymentCollectionsTable)
      .where(and(eq(paymentCollectionsTable.userId, ownerId), ilike(paymentCollectionsTable.receiptNumber, "RFND-%")));
    let max = 0;
    for (const r of rows) {
      const m = /RFND-(\d+)/.exec(r.rn || "");
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `RFND-${String(max + 1).padStart(4, "0")}`;
  }

  /** Settlement preview — the collected buckets the cancel dialog asks about. */
  @Get(":contractId/settlement")
  @RequirePermissions(PERMISSIONS.CONTRACTS_DELETE)
  async settlement(@CurrentUser() user: AuthUser, @Param("contractId") contractId: string) {
    const id = parseInt(contractId, 10);
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const [contract] = await this.db.select({ id: contractsTable.id }).from(contractsTable)
      .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, scopeId(user)), isNull(contractsTable.deletedAt)));
    if (!contract) throw new NotFoundException("Contract not found");
    const b = await this.collectedBuckets(id);
    return {
      deposit: round2(b.deposit.total),
      advance: round2(b.advance.total),
      installments: round2(b.installments.total),
      total: round2(b.deposit.total + b.advance.total + b.installments.total),
    };
  }

  /**
   * Terminate a contract AND settle the money already collected. `mode`
   * handles the still-unpaid installments (paid | cancelled), exactly like the
   * legacy DELETE. The `deposit` / `advance` / `installments` fields decide each
   * collected bucket: "refund" issues a disbursement voucher (a negative
   * collection that nets Total Collected down) and recomputes the affected
   * installments; "keep" / "forfeit" leave the cash with the landlord.
   */
  @Post(":contractId/terminate")
  @RequirePermissions(PERMISSIONS.CONTRACTS_DELETE)
  async terminate(@CurrentUser() user: AuthUser, @Param("contractId") contractId: string, @Body() body: any) {
    const id = parseInt(contractId, 10);
    const ownerId = scopeId(user);
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const today = new Date().toISOString().slice(0, 10);
    const mode = body?.mode as string | undefined;
    // Cancelling the unpaid installments cancels the contract; otherwise it's a
    // normal termination.
    const endStatus = mode === "cancelled" ? "cancelled" : "terminated";

    const [contract] = await this.db.update(contractsTable)
      .set({ status: endStatus })
      .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, ownerId), isNull(contractsTable.deletedAt)))
      .returning();
    if (!contract) throw new NotFoundException("Contract not found");

    // Free + unlink every unit the contract covered.
    const unitIds = (await this.db.select({ unitId: contractUnitsTable.unitId })
      .from(contractUnitsTable).where(eq(contractUnitsTable.contractId, id))).map((r) => r.unitId);
    if (unitIds.length > 0) {
      await this.db.update(unitsTable).set({ status: "available" }).where(inArray(unitsTable.id, unitIds));
    }
    await this.db.delete(contractUnitsTable).where(eq(contractUnitsTable.contractId, id));

    // Settle the still-unpaid installments per the chosen mode.
    const unsettled = ["pending", "overdue", "partially_paid"] as any;
    if (mode === "paid") {
      await this.db.update(paymentsTable).set({ status: "paid", paidDate: today } as any)
        .where(and(eq(paymentsTable.contractId, id), isNull(paymentsTable.deletedAt), inArray(paymentsTable.status, unsettled)));
    } else if (mode === "cancelled") {
      await this.db.update(paymentsTable).set({ status: "cancelled" } as any)
        .where(and(
          eq(paymentsTable.contractId, id), isNull(paymentsTable.deletedAt),
          inArray(paymentsTable.status, unsettled),
          // Never void an installment that already holds collected money. A
          // partially-collected row is in `unsettled`, so cancelling a contract
          // used to flip it to "cancelled" — and every total derived from
          // payment status then stopped counting money the landlord really
          // received. It stays as it is; only untouched rows are voided.
          notExists(
            this.db.select({ id: paymentCollectionsTable.id }).from(paymentCollectionsTable)
              .where(eq(paymentCollectionsTable.paymentId, paymentsTable.id)),
          ),
        ));
    }

    // ── Settle already-collected money ──
    const buckets = await this.collectedBuckets(id);
    const toRefund: { key: "deposit" | "advance" | "installments"; rows: { paymentId: number; amount: number }[] }[] = [];
    if (body?.deposit === "refund" && buckets.deposit.total > 0.01) toRefund.push({ key: "deposit", rows: buckets.deposit.rows });
    if (body?.advance === "refund" && buckets.advance.total > 0.01) toRefund.push({ key: "advance", rows: buckets.advance.rows });
    if (body?.installments === "refund" && buckets.installments.total > 0.01) toRefund.push({ key: "installments", rows: buckets.installments.rows });

    let refundNumber: string | null = null;
    let refunded = 0;
    const affected = new Set<number>();
    if (toRefund.length > 0) {
      refundNumber = await this.nextRefundNumber(ownerId);
      const method = body?.refundMethod || "bank_transfer";
      for (const rb of toRefund) {
        for (const r of rb.rows) {
          if (r.amount <= 0.01) continue; // only mirror positive collections
          await this.db.insert(paymentCollectionsTable).values({
            paymentId: r.paymentId, userId: ownerId, amount: (-r.amount).toFixed(2),
            collectedDate: today, method, receiptNumber: refundNumber, notes: "استرداد عند إلغاء العقد",
          } as any);
          affected.add(r.paymentId);
          refunded = round2(refunded + r.amount);
        }
        if (rb.key === "deposit") {
          await this.db.update(contractsTable).set({ depositStatus: "returned" } as any).where(eq(contractsTable.id, id));
        }
      }
    }
    // New-model deposit refund: cancel its receipt voucher(s) and count the
    // refunded amount (voucher deposits have no payment rows to mirror).
    if (body?.deposit === "refund" && buckets.depositVoucherIds.length > 0) {
      await this.db.update(simpleInvoicesTable).set({ status: "cancelled" } as any)
        .where(inArray(simpleInvoicesTable.id, buckets.depositVoucherIds));
      refunded = round2(refunded + buckets.depositVoucherTotal);
      await this.db.update(contractsTable).set({ depositStatus: "returned" } as any).where(eq(contractsTable.id, id));
    }
    // Forfeited deposit stays with the landlord but is flagged as such.
    if (body?.deposit === "forfeit" && buckets.deposit.total > 0.01) {
      await this.db.update(contractsTable).set({ depositStatus: "forfeited" } as any).where(eq(contractsTable.id, id));
    }
    // Take the deposit as a collection (revenue) for the landlord: record a real
    // collection against each deposit voucher so the held amount now appears in
    // Collections as collected money. The deposit is flagged forfeited (kept).
    if (body?.deposit === "revenue" && buckets.depositVoucherIds.length > 0) {
      const vouchers = await this.db.select({
        id: simpleInvoicesTable.id, total: simpleInvoicesTable.total,
        receiptNumber: simpleInvoicesTable.receiptNumber, method: simpleInvoicesTable.paymentMethod,
      }).from(simpleInvoicesTable).where(inArray(simpleInvoicesTable.id, buckets.depositVoucherIds));
      for (const v of vouchers) {
        const amt = round2(Number(v.total));
        if (amt <= 0.01) continue;
        // Idempotent — skip if this voucher was already converted.
        const [existing] = await this.db.select({ id: paymentCollectionsTable.id })
          .from(paymentCollectionsTable).where(eq(paymentCollectionsTable.invoiceId, v.id));
        if (existing) continue;
        await this.db.insert(paymentCollectionsTable).values({
          paymentId: null, userId: ownerId, amount: amt.toFixed(2), collectedDate: today,
          method: v.method || "bank_transfer", receiptNumber: v.receiptNumber, invoiceId: v.id,
          notes: "تأمين محوّل إلى إيراد عند إنهاء العقد",
        } as any);
      }
      await this.db.update(contractsTable).set({ depositStatus: "forfeited" } as any).where(eq(contractsTable.id, id));
    }

    // Recompute the status of every installment a refund touched.
    for (const pid of affected) {
      const [p] = await this.db.select({ amount: paymentsTable.amount }).from(paymentsTable).where(eq(paymentsTable.id, pid));
      if (!p) continue;
      const cols = await this.db.select({ amount: paymentCollectionsTable.amount })
        .from(paymentCollectionsTable).where(eq(paymentCollectionsTable.paymentId, pid));
      const collected = round2(cols.reduce((s, c) => s + Number(c.amount), 0));
      const amount = Number(p.amount);
      const status = collected <= 0.01 ? "cancelled" : collected < amount - 0.01 ? "partially_paid" : "paid";
      await this.db.update(paymentsTable)
        .set({ status, paidDate: status === "paid" ? today : null } as any)
        .where(eq(paymentsTable.id, pid));
    }

    return {
      success: true,
      refundNumber,
      refunded: round2(refunded),
      message: refundNumber
        ? `تم إنهاء العقد وإصدار سند صرف ${refundNumber} بمبلغ ${round2(refunded)} ر.س`
        : mode === "paid" ? "تم إنهاء العقد واعتبار جميع الأقساط مدفوعة"
        : mode === "cancelled" ? "تم إنهاء العقد وإلغاء الأقساط غير المدفوعة"
        : "تم إنهاء العقد",
    };
  }
}

@Module({ controllers: [ContractsController] })
export class ContractsModule {}
