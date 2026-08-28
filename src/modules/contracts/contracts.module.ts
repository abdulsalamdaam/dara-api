import { Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, ConflictException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, ne, lt, gt, isNull, or, ilike, count, asc, desc, inArray, notInArray, notExists, sql } from "drizzle-orm";
import { contractsTable, contractUnitsTable, contractRentTermsTable, unitsTable, propertiesTable, paymentsTable, paymentCollectionsTable, tenantsTable, simpleInvoicesTable, invoicesTable, auditLogsTable, lookupsTable } from "@dara/database";
import {
  BOUNDS, LIMITS, applyBoolNonNull, applyDate, applyEmail, applyForeignKey, applyFourDigitCode,
  applyMoney, applyOneOf, applyOneOfNonNull, applyPhone, applyPostalCode, applyRequiredText,
  applyText, applyVatNumber, applyWith, applyWithNonNull, assertDateOrder, dateOnly, money,
  partyIdentityNumber, percent, requiredForeignKeyId, applyDraftPhone,
} from "../../common/validation";

const DEPOSIT_DESC = "تأمين (وديعة)";

/** Round to 2 decimals without binary-float drift. Money is halalas. */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const CONTRACT_STATUSES = ["active", "expired", "terminated", "cancelled", "pending"] as const;
const PAYMENT_FREQUENCIES = ["monthly", "quarterly", "semi_annual", "annual", "custom"] as const;
const DEPOSIT_STATUSES = ["pending", "collected", "returned", "forfeited"] as const;
const ESCALATION_TYPES = ["percent", "amount"] as const;

/**
 * Statuses that mean the contract is over. Anything else still binds its
 * units — no second contract may overlap it, and neither the unit nor its
 * property can be deleted (see units/properties modules).
 */
const ENDED_CONTRACT_STATUSES = ["terminated", "cancelled"] as const;

/**
 * The advisory-lock key space for contract numbering. `billing.module.ts` locks
 * `(account, 1|2|3)` for its invoice/credit/debit sequences; contracts take
 * their own slot in the same two-int space so the two never contend.
 */
const CONTRACT_NUMBER_LOCK = 11;

/**
 * A contract request that has passed every rule the create path enforces,
 * carrying everything needed to write it and everything it will generate.
 *
 * Produced once by `prepareContract` and consumed by BOTH the create and the
 * rebuild path — that shared object is what stops the two from drifting apart
 * on validation, VAT derivation, the advance plan or the schedule itself.
 */
type PreparedContract = {
  ownerId: number;
  isDraft: boolean;
  unitIds: number[];
  /** The column values to write to `contracts` — no id, no contract number. */
  values: Record<string, unknown>;
  rentTerms: { year: number; amount: number }[];
  additionalFees: FeeEntry[] | null;
  customSchedule: { dueDate: string; amount: string }[] | null;
  settledExternalUntil: string | null;
  freq: string;
  startDate: string;
  endDate: string;
  /** The DERIVED VAT verdict — never the raw request flag. */
  rentVat: boolean;
  prepaidRequested: number;
  /** Fee installments (matched by name) the advance may settle. */
  pickedFeeNames: Set<string>;
  /** Whether the advance may settle rent installments. */
  coversRent: boolean;
  /** Whether the advance clears fees before rent. */
  feesFirst: boolean;
  prepaidAttachmentKey: string | null;
  depositAttachmentKey: string | null;
};

/**
 * Shape, length and range checks for every contract field a request may set.
 *
 * Run on create and on PATCH alike. The party blocks are denormalised
 * snapshots of the tenant/landlord at signing time, so they get the same
 * identity rules those records get. Drafts are exempt from the exact identity
 * formats (a draft is explicitly incomplete) but never from the length caps,
 * the numeric bounds or the enums.
 *
 * `escalationType` decides how `escalationRate` reads: a percentage (0–100) or
 * a flat money amount.
 */
function sanitizeContractFields(v: Record<string, unknown>, isDraft: boolean, escalationType: string): void {
  applyForeignKey(v, "tenantId", "المستأجر");
  applyRequiredText(v, "tenantName", "اسم المستأجر", LIMITS.name);
  applyText(v, "tenantType", "نوع المستأجر");
  applyText(v, "tenantAddress", "عنوان المستأجر", LIMITS.address);
  applyText(v, "repName", "اسم الممثل", LIMITS.name);
  applyText(v, "companyUnified", "الرقم الموحد", LIMITS.identifier);
  applyText(v, "companyOrgType", "نوع المنشأة");
  applyText(v, "signingPlace", "مكان التوقيع");
  applyText(v, "ejarContractNumber", "رقم عقد إيجار", LIMITS.code);
  applyText(v, "landlordName", "اسم المؤجر", LIMITS.name);
  applyText(v, "landlordAddress", "عنوان المؤجر", LIMITS.address);
  applyText(v, "notes", "الملاحظات", LIMITS.notes);
  applyText(v, "attachmentKey", "المرفق", LIMITS.address);
  applyText(v, "depositMethod", "طريقة سداد التأمين");
  applyText(v, "prepaidMethod", "طريقة سداد الإيجار المقدَّم");

  // `start_date` / `end_date` / `monthly_rent` are NOT NULL — a blank leaves
  // the stored value alone rather than crashing the driver.
  applyWithNonNull(v, "startDate", (raw) => dateOnly(raw, "تاريخ بداية العقد"));
  applyWithNonNull(v, "endDate", (raw) => dateOnly(raw, "تاريخ نهاية العقد"));
  applyDate(v, "signingDate", "تاريخ التوقيع");
  applyDate(v, "depositDueDate", "تاريخ استحقاق التأمين");
  applyDate(v, "settledExternalUntil", "تاريخ السداد خارج المنصة");

  applyWithNonNull(v, "monthlyRent", (raw) => money(raw, "قيمة الإيجار"));
  applyWithNonNull(v, "prepaidRent", (raw) => money(raw, "الإيجار المدفوع مقدماً"));
  applyMoney(v, "depositAmount", "مبلغ التأمين");
  applyMoney(v, "agencyFee", "أتعاب الوساطة");
  applyMoney(v, "firstPaymentAmount", "قيمة الدفعة الأولى");
  applyWithNonNull(v, "escalationRate", (raw) =>
    escalationType === "amount" ? money(raw, "قيمة الزيادة السنوية") : percent(raw, "نسبة الزيادة السنوية"));

  applyOneOfNonNull(v, "paymentFrequency", PAYMENT_FREQUENCIES, "دورية السداد");
  applyOneOfNonNull(v, "escalationType", ESCALATION_TYPES, "نوع الزيادة السنوية");
  applyOneOfNonNull(v, "status", CONTRACT_STATUSES, "حالة العقد");
  applyOneOf(v, "depositStatus", DEPOSIT_STATUSES, "حالة التأمين");
  applyBoolNonNull(v, "vatEnabled", "احتساب ضريبة القيمة المضافة");
  applyBoolNonNull(v, "isDraft", "مسودة");

  if (!isDraft) {
    applyWith(v, "tenantIdNumber", (raw) => partyIdentityNumber(raw, null, "رقم هوية المستأجر"));
    applyWith(v, "repIdNumber", (raw) => partyIdentityNumber(raw, null, "رقم هوية الممثل"));
    applyWith(v, "landlordIdNumber", (raw) => partyIdentityNumber(raw, null, "رقم هوية المؤجر"));
    applyPhone(v, "tenantPhone", "جوال المستأجر");
    applyPhone(v, "landlordPhone", "جوال المؤجر");
    applyEmail(v, "tenantEmail", "بريد المستأجر الإلكتروني");
    applyEmail(v, "landlordEmail", "بريد المؤجر الإلكتروني");
    applyVatNumber(v, "tenantTaxNumber", "الرقم الضريبي للمستأجر");
    applyVatNumber(v, "landlordTaxNumber", "الرقم الضريبي للمؤجر");
    applyPostalCode(v, "tenantPostalCode", "الرمز البريدي للمستأجر");
    applyPostalCode(v, "landlordPostalCode", "الرمز البريدي للمؤجر");
    applyFourDigitCode(v, "tenantAdditionalNumber", "الرقم الإضافي للمستأجر");
    applyFourDigitCode(v, "tenantBuildingNumber", "رقم مبنى المستأجر");
    applyFourDigitCode(v, "landlordAdditionalNumber", "الرقم الإضافي للمؤجر");
    applyFourDigitCode(v, "landlordBuildingNumber", "رقم مبنى المؤجر");
  } else {
    for (const [key, label] of [
      ["tenantIdNumber", "رقم هوية المستأجر"], ["repIdNumber", "رقم هوية الممثل"],
      ["landlordIdNumber", "رقم هوية المؤجر"],
      ["tenantTaxNumber", "الرقم الضريبي للمستأجر"],
      ["landlordTaxNumber", "الرقم الضريبي للمؤجر"], ["tenantPostalCode", "الرمز البريدي للمستأجر"],
      ["landlordPostalCode", "الرمز البريدي للمؤجر"], ["tenantAdditionalNumber", "الرقم الإضافي للمستأجر"],
      ["tenantBuildingNumber", "رقم مبنى المستأجر"], ["landlordAdditionalNumber", "الرقم الإضافي للمؤجر"],
      ["landlordBuildingNumber", "رقم مبنى المؤجر"],
    ] as const) {
      applyText(v, key, label, LIMITS.identifier);
      // A draft's phone is NORMALISED but never refused: half-typed values are
    // the whole point of a draft. Storing the canonical form as soon as the
    // number is recognisable matters because `contracts.tenant_phone` joins to
    // `tenants.phone` by exact string equality, and a draft is visible in the
    // portal for its whole life.
    applyDraftPhone(v, "tenantPhone", "جوال المستأجر");
    applyDraftPhone(v, "landlordPhone", "جوال المؤجر");
  }
    applyText(v, "tenantEmail", "بريد المستأجر الإلكتروني");
    applyText(v, "landlordEmail", "بريد المؤجر الإلكتروني");
  }
}

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
import {
  ADVANCE_NOTE, DEPOSIT_KIND, RECEIPT_KIND, classifyContractDocs, collectionsTotal,
  contractMoneyFacts, factsDiff, foreignCollections, rebuildAuditPath, rebuildBlockReason,
  type ContractCollectionRow, type ContractDocRow,
} from "./rebuild";
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
   * Next per-account contract number: EQ-000001, EQ-000002 …
   *
   * MUST be called inside the advisory-locked transaction in `create`. It used
   * to be `COUNT(*) + 1` read outside any transaction, which is not atomic
   * against the partial unique index `contracts_user_contract_number_uq
   * (user_id, contract_number) WHERE deleted_at IS NULL` — six parallel POSTs
   * produced four 500s because they all read the same count.
   *
   * Derived from MAX(sequence)+1 rather than COUNT, for the same reasons
   * `billing.module.ts` does: it stays unique after a contract in the middle is
   * deleted, and the `EQ-%` filter isolates the sequence from the Ejar-imported
   * contracts, which carry the Ejar contract number verbatim.
   */
  private async nextContractNumber(tx: any, ownerId: number): Promise<string> {
    const res: any = await tx.execute(sql`
      select coalesce(max(cast(substring(${contractsTable.contractNumber} from '[0-9]+$') as integer)), 0) as m
      from ${contractsTable}
      where ${contractsTable.userId} = ${ownerId} and ${contractsTable.contractNumber} like 'EQ-%'
    `);
    const rows = Array.isArray(res) ? res : (res?.rows ?? []);
    return `EQ-${String(Number(rows?.[0]?.m ?? 0) + 1).padStart(6, "0")}`;
  }

  /**
   * Refuse to put a unit under two live contracts at once.
   *
   * Nothing stopped it before: one unit could carry two active contracts whose
   * dates overlapped, each generating a full rent schedule, so the same unit
   * was billed twice for the same months.
   *
   * Periods are compared as half-open at the boundary — a renewal that starts
   * on the day the previous contract ends is the normal way to write a
   * back-to-back contract and is NOT a clash; any genuine overlap is.
   *
   * Drafts are unrestricted, on both sides: a draft occupies no unit and
   * generates no installments until it is finalised.
   */
  private async assertNoOverlappingContract(
    db: any,
    unitIds: number[],
    startDate: string,
    endDate: string,
    excludeContractId: number | null,
  ): Promise<void> {
    if (unitIds.length === 0) return;
    const conds = [
      inArray(contractUnitsTable.unitId, unitIds),
      isNull(contractsTable.deletedAt),
      eq(contractsTable.isDraft, false),
      notInArray(contractsTable.status, ENDED_CONTRACT_STATUSES as any),
      lt(contractsTable.startDate, endDate),
      gt(contractsTable.endDate, startDate),
    ];
    if (excludeContractId != null) conds.push(ne(contractsTable.id, excludeContractId));
    const [clash] = await db
      .select({
        contractNumber: contractsTable.contractNumber,
        unitNumber: unitsTable.unitNumber,
        startDate: contractsTable.startDate,
        endDate: contractsTable.endDate,
      })
      .from(contractUnitsTable)
      .innerJoin(contractsTable, eq(contractsTable.id, contractUnitsTable.contractId))
      .innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
      .where(and(...conds))
      .limit(1);
    if (clash) {
      throw new ConflictException(
        `لا يمكن حجز الوحدة "${clash.unitNumber}": يوجد عقد ساري (${clash.contractNumber}) عليها ` +
        `من ${clash.startDate} إلى ${clash.endDate} يتداخل مع فترة هذا العقد · ` +
        `Unit already has an active contract overlapping these dates`,
      );
    }
  }

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
      // A deleted property must not keep supplying its name to a contract that
      // still points at it — the join had no `deleted_at` guard, so an orphan
      // left over from before the delete was blocked still reads as if the
      // property were there.
      .leftJoin(propertiesTable, and(eq(propertiesTable.id, unitsTable.propertyId), isNull(propertiesTable.deletedAt)))
      .where(and(inArray(contractUnitsTable.contractId, contractIds), isNull(unitsTable.deletedAt)))
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

  /**
   * Everything a contract needs BEFORE it touches the database, validated.
   *
   * This is the whole of the create path's rule set — unit parsing and bounds,
   * unit ownership, the required-fields gate, the VAT derivation, the field
   * sanitiser, the period/rent sanity checks, the advance plan and the
   * advance-rent ceiling — pulled out of `create` so the rebuild path can run
   * the EXACT same rules rather than a second copy of them that drifts.
   *
   * Read-only: it never writes, so it is safe to call before opening the
   * transaction. The two things it deliberately leaves to the caller are the
   * contract number and the double-booking check, because both are only correct
   * inside the advisory-locked transaction.
   */
  private async prepareContract(user: AuthUser, body: any): Promise<PreparedContract> {
    const isDraft = Boolean(body.isDraft ?? false);
    // A contract spans one or more units (`unitIds`). The legacy single
    // `unitId` is still accepted so older callers keep working.
    const unitIds: number[] = (Array.isArray(body.unitIds) && body.unitIds.length > 0
      ? body.unitIds
      : (body.unitId != null ? [body.unitId] : []))
      .map((n: any) => Number(n))
      // Bounded to what the int4 column can hold. An id past 2^31 reached the
      // driver and came back a 500 instead of a clean refusal; the same bound
      // was already being applied to tenantId.
      .filter((n: number) => Number.isFinite(n));
    // Refuse an out-of-range unit id rather than dropping it: silently
    // narrowing the list meant a contract was created against fewer units than
    // the caller asked for, and answered 201 as if it had honoured them all.
    for (const n of unitIds) {
      if (!Number.isInteger(n) || n < BOUNDS.foreignKey.min || n > BOUNDS.foreignKey.max) {
        throw new BadRequestException("معرف الوحدة غير صالح · Invalid unit id");
      }
    }
    if (unitIds.length === 0 || (!isDraft && (!body.tenantName || !body.startDate || !body.endDate || !body.monthlyRent))) {
      throw new BadRequestException(isDraft ? "اختر وحدة واحدة على الأقل لحفظ المسودة" : "البيانات الأساسية مطلوبة");
    }
    const ownerId = scopeId(user);
    // The units have to be the caller's. Nothing checked, so a contract could
    // be written against another account's unit: it linked, it showed that
    // account's property and unit in the list, and once active it flipped
    // their unit to "rented" — a cross-account write, not just a read.
    //
    // The rebuild runs this too, which is what stops an edit from moving a
    // contract onto a unit belonging to somebody else.
    const ownedUnits = await this.db
      .select({ id: unitsTable.id })
      .from(unitsTable)
      .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
      .where(and(
        inArray(unitsTable.id, unitIds),
        eq(propertiesTable.userId, ownerId),
        isNull(unitsTable.deletedAt),
        isNull(propertiesTable.deletedAt),
      ));
    if (ownedUnits.length !== unitIds.length) {
      throw new NotFoundException("الوحدة غير موجودة · Unit not found");
    }
    // Derive the VAT decision ONCE. The contract row stored the derived
    // value while the installments were built from the raw request flag, so
    // the same contract could say "exempt" and still bill 15% — VAT charged
    // on exempt residential rent, and headed for a ZATCA invoice.
    const rentVat = await this.resolveRentVat(body, Boolean(body.vatEnabled ?? false));
    // Draft contracts may be incomplete — fall back so NOT NULL columns hold.
    const today = new Date().toISOString().slice(0, 10);
    const tenantName = body.tenantName || (isDraft ? "—" : body.tenantName);
    const startDate = dateOnly(body.startDate, "تاريخ بداية العقد") ?? today;
    const endDate = dateOnly(body.endDate, "تاريخ نهاية العقد") ?? today;
    const monthlyRent = money(body.monthlyRent, "قيمة الإيجار") ?? "0";

    // A live contract has to describe a real rental period and a real rent.
    // Neither was checked: an end date on or before the start produced a live
    // contract with an empty schedule that still flipped its unit to "rented",
    // and a zero/negative rent produced a full schedule of negative
    // installments. The web wizard blocks both; the mobile app and the Ejar
    // import call this endpoint directly. Drafts stay unrestricted.
    if (!isDraft) {
      assertDateOrder(startDate, endDate);
      if (!(Number(monthlyRent) > 0)) {
        throw new BadRequestException("قيمة الإيجار يجب أن تكون أكبر من صفر · Monthly rent must be greater than zero");
      }
    }

    const freq = body.paymentFrequency || "monthly";
    // Existing/legacy contract: rent due before this date was settled outside
    // the portal. Normalised to YYYY-MM-DD or null.
    const settledExternalUntil: string | null = dateOnly(body.settledExternalUntil, "تاريخ السداد خارج المنصة");

    const additionalFees: FeeEntry[] | null = body.additionalFees && Array.isArray(body.additionalFees) && body.additionalFees.length > 0 ? body.additionalFees : null;
    // Custom payment schedule — only kept when the cycle is "custom".
    const customSchedule = freq === "custom" && Array.isArray(body.customSchedule)
      ? body.customSchedule
          .map((e: any) => ({ dueDate: String(e?.dueDate ?? "").slice(0, 10), amount: String(e?.amount ?? "") }))
          .filter((e: any) => e.dueDate && Number(e.amount) > 0)
      : null;

    const values: Record<string, unknown> = {
      userId: ownerId,
      tenantId: body.tenantId ?? null,
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
      monthlyRent,
      paymentFrequency: freq,
      depositAmount: body.depositAmount ?? null,
      depositStatus: body.depositStatus ?? null,
      depositDueDate: body.depositDueDate ?? null,
      depositMethod: body.depositMethod ?? null,
      prepaidRent: body.prepaidRent ?? "0",
      prepaidMethod: body.prepaidMethod ?? null,
      vatEnabled: rentVat,
      escalationType: body.escalationType === "amount" ? "amount" : "percent",
      escalationRate: body.escalationRate ?? "0",
      agencyFee: body.agencyFee ?? null,
      firstPaymentAmount: body.firstPaymentAmount ?? null,
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
      isDraft,
      isDemo: false,
    };
    sanitizeContractFields(values, isDraft, String(values.escalationType));
    if (values.monthlyRent == null) values.monthlyRent = monthlyRent; // NOT NULL
    if (values.prepaidRent == null) values.prepaidRent = "0";         // NOT NULL
    if (values.escalationRate == null) values.escalationRate = "0";   // NOT NULL

    // Per-year rent overrides. Parsed before the insert because the schedule
    // preview below is built from them (they are stored after it, once the
    // contract has an id).
    const rentTerms = parseRentTerms(body.rentTerms);

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

    const prepared: PreparedContract = {
      ownerId, isDraft, unitIds, values, rentTerms, additionalFees,
      customSchedule: customSchedule && customSchedule.length > 0 ? customSchedule : null,
      settledExternalUntil, freq, startDate, endDate, rentVat,
      prepaidRequested: round2(Number(values.prepaidRent) || 0),
      pickedFeeNames, coversRent, feesFirst,
      prepaidAttachmentKey: body.prepaidAttachmentKey ?? null,
      depositAttachmentKey: body.depositAttachmentKey ?? null,
    };

    // The advance can only ever be applied to installments the schedule
    // actually contains, and only to the ones the caller chose it to cover.
    // Anything above that was stored on the contract as received and then
    // silently dropped: `prepaidRent: 999999` against a 12,000 schedule
    // recorded 987,999 with no collection, no receipt voucher and no error.
    if (!isDraft && prepared.prepaidRequested > 0) {
      // Contract id 0 — the preview only needs the shape and the amounts.
      const absorbable = round2(this.buildScheduleRows(0, prepared)
        .filter((p) => this.advanceCovers(prepared, p.status, p.description))
        .reduce((sum, p) => sum + Number(p.amount), 0));
      if (prepared.prepaidRequested > absorbable + 0.01) {
        throw new BadRequestException(
          `الإيجار المدفوع مقدماً (${prepared.prepaidRequested.toFixed(2)}) يتجاوز ما يمكن سداده من جدول الدفعات — ` +
          `الحد الأقصى ${absorbable.toFixed(2)} ر.س · Advance rent exceeds what the schedule can settle`,
        );
      }
    }

    return prepared;
  }

  /**
   * The installment schedule a prepared contract produces. One definition, used
   * by the ceiling preview, the create path and the rebuild path alike — the
   * preview used to be a separate closure, which is how a preview and the rows
   * actually written could disagree.
   */
  private buildScheduleRows(contractId: number, p: PreparedContract) {
    return applyExternalSettlement(
      buildInstallments(
        contractId, p.ownerId, p.startDate, p.endDate, String(p.values.monthlyRent), p.freq,
        p.additionalFees, p.rentVat, Number(p.values.escalationRate) || 0,
        String(p.values.escalationType) === "amount" ? "amount" : "percent",
        p.rentTerms,
        0, // prepaid is tracked as a collection, not a deduction
        p.customSchedule,
      ),
      p.settledExternalUntil,
    );
  }

  /**
   * Is this installment one the advance is allowed to settle? The ceiling check
   * and the settlement loop MUST answer this identically — deciding it twice is
   * how a contract ends up accepting an advance it then cannot apply.
   */
  private advanceCovers(p: PreparedContract, status: string, description: string | null): boolean {
    if (status === "settled_external") return false;
    return description ? p.pickedFeeNames.has(description) : p.coversRent;
  }

  /**
   * Generate everything a contract row implies: its per-year rent overrides,
   * its unit statuses, its installment schedule, the advance collections and
   * receipt voucher, and the deposit voucher.
   *
   * Takes the db handle so the create path can run it on `this.db` (unchanged
   * behaviour — after its own transaction commits) while the rebuild path runs
   * it inside the transaction that destroyed the previous generation, so a
   * failure anywhere leaves the contract exactly as it was.
   */
  private async materializeContract(db: any, contract: any, p: PreparedContract): Promise<number> {
    const ownerId = p.ownerId;
    // Per-year rent overrides (saved for drafts too, so they prefill on edit).
    if (p.rentTerms.length > 0) {
      await db.insert(contractRentTermsTable).values(
        p.rentTerms.map((t) => ({ contractId: contract.id, year: t.year, amount: String(t.amount) })),
      );
    }

    // A draft contract doesn't occupy its units and generates no
    // installments until it is finalised.
    if (p.isDraft) return 0;

    await db.update(unitsTable).set({ status: "rented" }).where(inArray(unitsTable.id, p.unitIds));

    // Build installments at their FULL amount (prepaid is NOT deducted — it's
    // recorded as a collection below so each installment shows its full value
    // with the remaining).
    const rows = this.buildScheduleRows(contract.id, p);
    const inserted = rows.length > 0 ? await db.insert(paymentsTable).values(rows).returning() : [];

    const nowStr = new Date().toISOString().slice(0, 10);
    const startDay = p.startDate || nowStr;

    // Advance/prepaid rent → record as a collection on the earliest rent
    // installments (keeps full amount; flips them to paid / partially_paid).
    // The advance carries its OWN receipt-voucher number so it shows in the
    // Collections tab as a distinct سند القبض — the later collection of the
    // remaining balance produces a second voucher. (Hence: with advance rent
    // there are two receipt vouchers for the rent — advance + remainder.)
    const prepaid = p.prepaidRequested;
    if (prepaid > 0 && inserted.length > 0) {
      const method = (p.values.prepaidMethod as string | null) || "bank_transfer";
      const advanceVoucher = await this.nextReceiptNumber(db, ownerId);

      // `pickedFeeNames`, `coversRent` and `feesFirst` were decided during
      // `prepareContract` — the ceiling check needs the same answers this loop
      // uses, and deciding them twice is how the two could drift apart.
      const settleRows = inserted
        .filter((row: any) => this.advanceCovers(p, row.status, row.description))
        .sort((a: any, b: any) => {
          const aFee = !!a.description, bFee = !!b.description;
          // Priority decides the class order; due date orders within a class,
          // so the money still walks the schedule forwards.
          if (aFee !== bFee) return p.feesFirst ? (aFee ? -1 : 1) : (aFee ? 1 : -1);
          return String(a.dueDate).localeCompare(String(b.dueDate));
        });

      let left = prepaid;
      let applied = 0;
      for (const row of settleRows) {
        if (left <= 0.01) break;
        const full = round2(Number(row.amount));
        const amt = round2(Math.min(left, full));
        await db.insert(paymentCollectionsTable).values({
          paymentId: row.id, userId: ownerId, amount: amt.toFixed(2),
          collectedDate: startDay, method, receiptNumber: advanceVoucher,
          // This exact string buckets the collection as "advance" when the
          // contract is ended (see settlementBuckets) — a fee-covering
          // collection is still part of the advance, so it must not diverge.
          // It is also what the rebuild path recognises as its own artefact.
          notes: ADVANCE_NOTE, attachmentKey: p.prepaidAttachmentKey,
        } as any);
        const fully = amt >= full - 0.01;
        await db.update(paymentsTable)
          .set({ status: fully ? "paid" : "partially_paid", paidDate: fully ? startDay : null })
          .where(eq(paymentsTable.id, row.id));
        left = round2(left - amt);
        applied = round2(applied + amt);
      }
      // Advance receipt-voucher DOCUMENT (kind="receipt") so the advance shows in
      // the Receipt Vouchers page too — it shares the RV number stamped on the
      // collection(s) above. Not linked to an installment (the collection is),
      // so it doesn't double-count in collections.
      if (applied > 0.01) {
        await db.insert(simpleInvoicesTable).values({
          userId: ownerId, number: advanceVoucher, type: "invoice", kind: RECEIPT_KIND, status: "confirmed",
          contractId: contract.id, tenantId: contract.tenantId ?? null, tenantName: contract.tenantName ?? null,
          items: [{ description: ADVANCE_NOTE, quantity: 1, unitPrice: applied, amount: applied, vat: false }],
          subtotal: applied.toFixed(2), total: applied.toFixed(2),
          issueDate: startDay, paidDate: startDay, confirmedAt: new Date(),
          receiptNumber: advanceVoucher, paymentMethod: method, notes: ADVANCE_NOTE,
          attachmentKey: p.prepaidAttachmentKey,
        } as any);
      }
    }

    // Collected deposit → issue a receipt voucher (سند قبض) only. A deposit is
    // held trust money (amanat), NOT rent revenue — it is no longer an
    // installment/payment row, so it never appears in the financial schedule.
    // The voucher is viewable from the contract once the deposit is collected.
    //
    // Guarded by an existence check because the rebuild reaches here too: a
    // deposit voucher is deliberately NOT destroyed by a rebuild (it is proof
    // that trust money was received), so it must not be minted a second time.
    const depositAmt = round2(Number(p.values.depositAmount) || 0);
    if (depositAmt > 0 && p.values.depositStatus === "collected") {
      const [existing] = await db.select({ id: simpleInvoicesTable.id }).from(simpleInvoicesTable)
        .where(and(
          eq(simpleInvoicesTable.userId, ownerId), eq(simpleInvoicesTable.contractId, contract.id),
          eq(simpleInvoicesTable.kind, DEPOSIT_KIND), ne(simpleInvoicesTable.status, "cancelled"),
          isNull(simpleInvoicesTable.deletedAt),
        )).limit(1);
      if (!existing) {
        await this.createDepositVoucher(
          db, ownerId, contract, depositAmt,
          (p.values.depositDueDate as string | null) || startDay,
          (p.values.depositMethod as string | null) || "bank_transfer",
          p.depositAttachmentKey,
        );
      }
    }

    return inserted.length;
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CONTRACTS_WRITE)
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    const p = await this.prepareContract(user, body);
    const ownerId = p.ownerId;

    // Numbering + insert + unit linking happen inside ONE transaction guarded
    // by a per-account advisory lock — the same technique billing uses for
    // document numbers. Without it, concurrent POSTs read the same sequence and
    // collided on `contracts_user_contract_number_uq` (six parallel creates →
    // four 500s). The double-booking check lives inside the lock too, so two
    // simultaneous contracts cannot both find the unit free. The lock releases
    // when the transaction commits.
    const contract = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ownerId}, ${CONTRACT_NUMBER_LOCK})`);
      if (!p.isDraft) await this.assertNoOverlappingContract(tx, p.unitIds, p.startDate, p.endDate, null);
      p.values.contractNumber = await this.nextContractNumber(tx, ownerId);
      const [row] = await tx.insert(contractsTable).values(p.values as any).returning();
      // Link every unit to the new contract.
      await tx.insert(contractUnitsTable).values(
        p.unitIds.map((unitId) => ({ contractId: row!.id, unitId })),
      );
      return row;
    });

    const installmentsCreated = await this.materializeContract(this.db, contract!, p);
    return { ...contract, unitIds: p.unitIds, installmentsCreated };
  }

  /** Next per-account receipt-voucher (سند قبض) number: RV-000001, …
   *  Takes the db handle so it can be generated inside a transaction — the
   *  rebuild mints its advance voucher within the transaction that destroyed
   *  the previous one, so the number must be read under the same lock. */
  private async nextReceiptNumber(db: any, ownerId: number): Promise<string> {
    return nextReceiptVoucherNumber(db, ownerId);
  }

  /**
   * Issue a deposit receipt voucher (سند قبض) for a contract: a confirmed
   * simple-invoice marked `kind="deposit"` (so it stays out of revenue/reports),
   * no VAT, stamped with an RV number. This is the ONLY artefact a collected
   * deposit produces — there is no installment/payment row for it.
   */
  private async createDepositVoucher(db: any, ownerId: number, contract: any, amount: number, date: string, method: string, attachmentKey?: string | null) {
    const amt = round2(amount);
    const voucher = await this.nextReceiptNumber(db, ownerId);
    // A deposit voucher is a سند قبض, not a tax invoice — its number IS the RV
    // number; it never consumes an INV-#### sequence.
    const number = voucher;
    const [doc] = await db.insert(simpleInvoicesTable).values({
      userId: ownerId, number, type: "invoice", kind: DEPOSIT_KIND, status: "confirmed",
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
    const id = requiredForeignKeyId(contractId, "رقم العقد");
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
    const id = requiredForeignKeyId(contractId, "رقم العقد");
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
    const voucher = await this.createDepositVoucher(this.db, ownerId, contract, amt, date, method);
    await this.db.update(contractsTable)
      .set({ depositStatus: "collected", depositMethod: method, depositDueDate: contract.depositDueDate || date } as any)
      .where(eq(contractsTable.id, id));
    return { voucher };
  }

  @Post(":contractId/generate-installments")
  @RequirePermissions(PERMISSIONS.CONTRACTS_WRITE)
  async generateInstallments(@CurrentUser() user: AuthUser, @Param("contractId") contractId: string, @Body() body: any) {
    const id = requiredForeignKeyId(contractId, "رقم العقد");
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

  /**
   * Rebuild a contract in place — the edit path.
   *
   * A landlord who has just written a contract and got the rent, the dates, the
   * fees, the units or the tenant wrong cannot patch their way out of it: the
   * installment schedule, the unit links and the advance artefacts were all
   * DERIVED from the values that were wrong. So an edit does not adjust them —
   * it destroys everything the creation path produced and generates it again
   * from the corrected values.
   *
   * ── The contract keeps its identity ──
   * Same row, same `id`, same `contract_number`. No number is allocated and no
   * second contract row is written; every document, link and report that
   * already points at this contract still points at the same contract.
   *
   * ── What is destroyed and remade ──
   *   payments              → deleted outright, rebuilt from the new terms
   *   payment_collections   → deleted with them (only the create-path advance
   *                           can be present; see the gate)
   *   the advance voucher   → cancelled + tombstoned, re-minted by materialize
   *   contract_units        → deleted and re-linked
   *   contract_rent_terms   → deleted and re-inserted
   *
   * Deleted, not soft-deleted, because a rebuild is not a business event that
   * deserves a paper trail of tombstoned installments — every edit would leave
   * another full schedule behind. What happened is recorded once, in
   * `audit_logs`, with the counts. The gate below has already guaranteed that
   * nothing outside the contract references any of those rows.
   *
   * The deposit voucher is the one artefact deliberately left alone: it is
   * proof that trust money was actually received, so voiding and re-minting it
   * would destroy the tenant's receipt and burn an RV number. The gate refuses
   * instead if the rebuild would move the amount it attests to.
   *
   * ── Same rules as create, not a second copy of them ──
   * `prepareContract` runs the whole create rule set (unit bounds, unit
   * ownership, required fields, the derived VAT verdict, the field sanitiser,
   * the period and rent checks, the advance plan, the advance ceiling), and
   * `materializeContract` writes exactly what create writes. The only things
   * this path adds are the eligibility gate, the destruction, and the audit.
   *
   * Everything runs inside one transaction, under the same per-account advisory
   * lock the create path takes: a failure anywhere leaves the contract exactly
   * as it was, and a concurrent create cannot interleave with the moment the
   * units are unlinked.
   */
  private async rebuildContract(user: AuthUser, id: number, body: any) {
    const ownerId = scopeId(user);

    // Cheap refusals first, so a draft or an ended contract gets its own reason
    // instead of a validation error from a rule set that does not apply to it.
    const [head] = await this.db
      .select({ id: contractsTable.id, isDraft: contractsTable.isDraft, status: contractsTable.status })
      .from(contractsTable)
      .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, ownerId), isNull(contractsTable.deletedAt)));
    if (!head) throw new NotFoundException("Contract not found");
    // `"false"` is a truthy string — read the flag the way the dispatch does.
    const wantsDraft = body?.isDraft === true || body?.isDraft === "true";
    const early = rebuildBlockReason({
      isDraft: Boolean(head.isDraft), status: head.status,
      zatcaInvoiceCount: 0, docs: classifyContractDocs([]), foreignCollections: [],
      nextDepositStatus: null,
      depositVoucherTotal: 0, nextDepositAmount: 0,
      wantsDraft: wantsDraft,
    });
    if (early) throw new BadRequestException(early.message);

    // The create path's ENTIRE rule set, over the new payload. A rebuild is
    // never a draft — a draft is exempt from the identity formats, the period
    // check and the rent check, none of which a live contract may skip.
    const p = await this.prepareContract(user, { ...body, isDraft: false });

    return this.db.transaction(async (tx) => {
      // The SAME lock the create path takes, in the same key space. Without it
      // a create could run its double-booking check in the window where this
      // rebuild has unlinked the old units and not yet linked the new ones, and
      // both would find the unit free. It also serialises two concurrent
      // rebuilds: the second waits, then re-reads the row and re-runs the gate
      // against whatever the first one left behind.
      await tx.execute(sql`select pg_advisory_xact_lock(${ownerId}, ${CONTRACT_NUMBER_LOCK})`);

      // Re-read under a row lock. The eligibility facts are only meaningful for
      // the row as it is INSIDE this transaction — an invoice issued between
      // the early check and here must still block the rebuild.
      const [current] = await tx.select().from(contractsTable)
        .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, ownerId), isNull(contractsTable.deletedAt)))
        .for("update");
      if (!current) throw new NotFoundException("Contract not found");

      /* ── Eligibility ───────────────────────────────────────────────────
       * Three reads establish everything `rebuildBlockReason` needs; the rule
       * itself, and the reasoning behind it, lives in ./rebuild.ts.
       */

      // (a) The ZATCA e-invoice table, joined by contract. Any non-deleted row
      //     bars the rebuild whatever its status — even a `draft` invoice has
      //     already taken an ICV and a PIH in the landlord's hash chain.
      const [zatcaCount] = await tx.select({ n: count() }).from(invoicesTable)
        .where(and(eq(invoicesTable.contractId, id), isNull(invoicesTable.deletedAt)));

      // (b) Every live billing document on the contract, classified into the
      //     ones that reached ZATCA, the create path's own artefacts, and
      //     anything else that would be left pointing at deleted installments.
      const docRows: ContractDocRow[] = await tx.select({
        id: simpleInvoicesTable.id,
        kind: simpleInvoicesTable.kind,
        status: simpleInvoicesTable.status,
        notes: simpleInvoicesTable.notes,
        zatcaStatus: simpleInvoicesTable.zatcaStatus,
        zatcaQr: simpleInvoicesTable.zatcaQr,
        zatcaInvoiceId: simpleInvoicesTable.zatcaInvoiceId,
        attachmentKey: simpleInvoicesTable.attachmentKey,
        total: simpleInvoicesTable.total,
      }).from(simpleInvoicesTable).where(and(
        eq(simpleInvoicesTable.contractId, id),
        eq(simpleInvoicesTable.userId, ownerId),
        isNull(simpleInvoicesTable.deletedAt),
      ));
      // docs are classified below, once the collections are known

      // (c) Money already collected. Tombstoned installments are included on
      //     purpose — a soft-deleted row can still carry a collection, and the
      //     rebuild is about to remove it for good either way.
      const payIds = (await tx.select({ id: paymentsTable.id }).from(paymentsTable)
        .where(and(eq(paymentsTable.contractId, id), eq(paymentsTable.userId, ownerId))))
        .map((r) => r.id);
      const colRows: ContractCollectionRow[] = payIds.length > 0
        ? await tx.select({
            id: paymentCollectionsTable.id,
            notes: paymentCollectionsTable.notes,
            amount: paymentCollectionsTable.amount,
            invoiceId: paymentCollectionsTable.invoiceId,
          }).from(paymentCollectionsTable).where(inArray(paymentCollectionsTable.paymentId, payIds))
        : [];
      // A receipt voucher some collection points at was written by the billing
      // module, not by contract creation, so it is not ours to void.
      const docsReferencedByCollection = new Set(
        colRows.map((c) => c.invoiceId).filter((x): x is number => x != null),
      );

      const docs = classifyContractDocs(docRows, docsReferencedByCollection);
      const depositVoucherTotal = round2(
        docs.depositVouchers.reduce((s, d) => s + (Number(d.total) || 0), 0),
      );

      const refusal = rebuildBlockReason({
        isDraft: Boolean(current.isDraft),
        status: current.status,
        zatcaInvoiceCount: Number(zatcaCount?.n ?? 0),
        docs,
        foreignCollections: foreignCollections(colRows),
        depositVoucherTotal,
        nextDepositAmount: round2(Number(p.values.depositAmount) || 0),
        nextDepositStatus: (p.values.depositStatus as string | null) ?? null,
        wantsDraft: wantsDraft,
      });
      if (refusal) {
        // A draft / to-draft request is a malformed request; everything else is
        // a state conflict — the contract exists but is past the point of being
        // rebuildable.
        if (refusal.code === "draft" || refusal.code === "to_draft") throw new BadRequestException(refusal.message);
        throw new ConflictException(refusal.message);
      }

      // The contract as it stands, for the audit diff — read before anything is
      // destroyed, and inside the lock so it is the state actually replaced.
      const priorUnitIds = (await tx.select({ unitId: contractUnitsTable.unitId })
        .from(contractUnitsTable).where(eq(contractUnitsTable.contractId, id))).map((r) => r.unitId);
      const priorFacts = contractMoneyFacts(current, priorUnitIds,
        (await tx.select().from(contractRentTermsTable).where(eq(contractRentTermsTable.contractId, id)))
          .map((t: any) => ({ year: t.year, amount: Number(t.amount) })));

      // The same double-booking rule the create path enforces, with this
      // contract excluded from the comparison — its own links must not read as
      // a clash with its own new period. Inside the lock, so a concurrent
      // create cannot slip a second contract onto the unit meanwhile.
      await this.assertNoOverlappingContract(tx, p.unitIds, p.startDate, p.endDate, id);

      /* ── Destroy everything the previous generation produced ────────── */
      const installmentsRemoved = payIds.length;
      if (payIds.length > 0) {
        await tx.delete(paymentCollectionsTable).where(inArray(paymentCollectionsTable.paymentId, payIds));
        await tx.delete(paymentsTable)
          .where(and(eq(paymentsTable.contractId, id), eq(paymentsTable.userId, ownerId)));
      }
      // The advance receipt voucher is a document, not a row nobody has seen —
      // tombstone it as cancelled rather than deleting it, so an RV number that
      // may already have been printed resolves to a voided document instead of
      // to nothing.
      const advanceVoucherIds = docs.advanceVouchers.map((d) => d.id);
      if (advanceVoucherIds.length > 0) {
        await tx.update(simpleInvoicesTable)
          .set({ status: "cancelled", deletedAt: new Date() } as any)
          .where(inArray(simpleInvoicesTable.id, advanceVoucherIds));
      }
      // The proof of payment the landlord uploaded for the advance is not a
      // contract column, so the wizard cannot send it back and every rebuild
      // would reissue the voucher with no attachment — quietly losing the
      // evidence that the money arrived. Carry it from the voucher being
      // voided unless the caller supplied a new one.
      if (!p.prepaidAttachmentKey) {
        const carried = docs.advanceVouchers.find((d) => d.attachmentKey);
        if (carried?.attachmentKey) p.prepaidAttachmentKey = carried.attachmentKey;
      }
      await tx.delete(contractRentTermsTable).where(eq(contractRentTermsTable.contractId, id));
      await tx.delete(contractUnitsTable).where(eq(contractUnitsTable.contractId, id));

      /* ── Rewrite the contract row (same id, same number) ─────────────── */
      const setValues: Record<string, unknown> = { ...p.values };
      // Identity and account facts are not contract terms: the number is never
      // reallocated, the owner never moves, and `isDemo` belongs to how the row
      // was seeded, not to what the landlord just typed.
      delete setValues.userId;
      delete setValues.isDemo;
      delete setValues.contractNumber;
      // `prepareContract` returns "active", because that is what a NEW live
      // contract is. A rebuild must not silently reactivate an expired contract
      // or change its lifecycle at all — the stored status stands. Changing it
      // is what the ordinary PATCH (and `terminate`) are for.
      setValues.status = current.status;
      const [updated] = await tx.update(contractsTable).set(setValues as any)
        .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, ownerId), isNull(contractsTable.deletedAt)))
        .returning();
      if (!updated) throw new NotFoundException("Contract not found");

      /* ── Regenerate ─────────────────────────────────────────────────── */
      await tx.insert(contractUnitsTable).values(
        p.unitIds.map((unitId) => ({ contractId: id, unitId })),
      );
      const installmentsCreated = await this.materializeContract(tx, updated, p);

      // A unit dropped from the contract goes back to "available" — but only if
      // nothing else still holds it. The contract's own links are already gone
      // at this point, so it cannot count as its own occupant.
      const released = priorUnitIds.filter((u) => !p.unitIds.includes(u));
      let freed: number[] = [];
      if (released.length > 0) {
        const stillHeld = await tx.select({ unitId: contractUnitsTable.unitId })
          .from(contractUnitsTable)
          .innerJoin(contractsTable, eq(contractsTable.id, contractUnitsTable.contractId))
          .where(and(
            inArray(contractUnitsTable.unitId, released),
            isNull(contractsTable.deletedAt),
            eq(contractsTable.isDraft, false),
            notInArray(contractsTable.status, ENDED_CONTRACT_STATUSES as any),
          ));
        const held = new Set(stillHeld.map((r) => r.unitId));
        freed = released.filter((u) => !held.has(u));
        if (freed.length > 0) {
          await tx.update(unitsTable).set({ status: "available" }).where(inArray(unitsTable.id, freed));
        }
      }

      /* ── Audit ──────────────────────────────────────────────────────── */
      // Written INSIDE the transaction, unlike the global interceptor's
      // fire-and-forget row: a rebuild that rolls back must not leave a log
      // entry claiming it happened. See `rebuildAuditPath` for the shape and
      // why the payload rides on `path`.
      const diff = factsDiff(priorFacts, contractMoneyFacts(updated, p.unitIds, p.rentTerms));
      await tx.insert(auditLogsTable).values({
        ownerUserId: ownerId,
        actorUserId: user.id,
        action: "rebuild",
        entity: "contracts",
        entityId: String(id),
        method: "PATCH",
        path: rebuildAuditPath(id, updated.contractNumber, diff, { installmentsRemoved, installmentsCreated }),
      });

      return {
        ...updated,
        unitIds: p.unitIds,
        rebuilt: true,
        installmentsRemoved,
        installmentsCreated,
        collectionsRemoved: colRows.length,
        collectionsRemovedTotal: collectionsTotal(colRows),
        vouchersVoided: advanceVoucherIds.length,
        unitsReleased: freed,
        changed: Object.keys(diff),
        message:
          `تم تحديث العقد ${updated.contractNumber} وإعادة بناء جدول الدفعات ` +
          `(${installmentsRemoved} دفعة سابقة ← ${installmentsCreated} دفعة جديدة)`,
      };
    });
  }

  /**
   * PATCH /contracts/:contractId
   *
   * Two behaviours behind one route, chosen by the body:
   *
   *   - the ordinary field patch (default) — merges the sent fields into the
   *     stored row and leaves the generated schedule alone;
   *   - `rebuild: true` — REBUILDS the contract in place from a full wizard
   *     payload (see `rebuildContract`).
   *
   * Deliberately not a second endpoint: the portal's edit flow is the same
   * wizard as its create flow, so the edit call is the create body plus one
   * flag. A parallel route would have made "edit" a new concept for the client
   * and split the contract surface in two.
   */
  @Patch(":contractId")
  @RequirePermissions(PERMISSIONS.CONTRACTS_WRITE)
  async update(@CurrentUser() user: AuthUser, @Param("contractId") contractId: string, @Body() body: any) {
    const id = requiredForeignKeyId(contractId, "رقم العقد");
    const ownerId = scopeId(user);
    if (body?.rebuild === true || body?.rebuild === "true") {
      return this.rebuildContract(user, id, body);
    }
    // The prior row is needed to reason about the contract AS IT WILL BE: a
    // PATCH that moves only the end date, or only flips `isDraft`, still has to
    // satisfy the same period / rent / double-booking rules the create path
    // enforces. Without it the update path silently skipped all of them.
    const [prior] = await this.db.select().from(contractsTable)
      .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, ownerId), isNull(contractsTable.deletedAt)));
    if (!prior) throw new NotFoundException("Contract not found");

    const updateData: Record<string, unknown> = {};
    for (const f of CONTRACT_FIELDS) if (body[f] !== undefined) updateData[f] = body[f];
    const willBeDraft = body.isDraft !== undefined ? Boolean(body.isDraft) : Boolean(prior.isDraft);
    const escalationType = String(body.escalationType ?? (prior as any).escalationType ?? "percent");
    // `tenantId` is an integer FK; the sanitiser coerces and range-checks it
    // (and `null` still clears it) — `Number("abc")` used to reach the driver.
    sanitizeContractFields(updateData, willBeDraft, escalationType);

    /* ── Finalising a draft re-validates the WHOLE contract ──
     *
     * Drafts are exempt from the exact identity formats, which is right while
     * they are drafts. But nothing re-checked them when the draft went live, so
     * whatever was typed during the draft simply became a live contract: one
     * was found in production carrying `tenant_phone = +966500000001` and
     * `tenant_id_number = 99`. The tenant portal matches contracts to a tenant
     * by phone STRING, so the real tenant saw no contracts at all while theirs
     * was live.
     *
     * The same rules the non-draft create path runs, applied to the row as it
     * WILL BE — the stored draft merged with this request — so a value that
     * arrived while it was a draft cannot slip through by simply not being
     * re-sent. The normalised forms are written back too (a phone becomes
     * `05XXXXXXXX`), because that is what the portal's exact match needs.
     *
     * The journey is unchanged: the same button, now able to say why.
     */
    if (prior.isDraft && !willBeDraft) {
      const merged: Record<string, unknown> = {};
      for (const f of CONTRACT_FIELDS) {
        merged[f] = f in updateData ? updateData[f] : (prior as Record<string, any>)[f];
      }
      sanitizeContractFields(merged, false, escalationType);
      for (const f of CONTRACT_FIELDS) {
        if (f in updateData) continue;                       // the caller's own value, already checked
        if (!(f in merged)) continue;                        // blank on a NOT NULL column — leave it alone
        if (merged[f] !== (prior as Record<string, any>)[f]) updateData[f] = merged[f];
      }
    }

    const nextStart = (updateData.startDate as string | undefined) ?? prior.startDate;
    const nextEnd = (updateData.endDate as string | undefined) ?? prior.endDate;
    const nextRent = (updateData.monthlyRent as string | undefined) ?? prior.monthlyRent;
    const nextStatus = (updateData.status as string | undefined) ?? prior.status;
    if (!willBeDraft) {
      assertDateOrder(nextStart, nextEnd);
      if (!(Number(nextRent) > 0)) {
        throw new BadRequestException("قيمة الإيجار يجب أن تكون أكبر من صفر · Monthly rent must be greater than zero");
      }
      // A contract that is (or is becoming) live must not share a unit with
      // another live contract over the same period — including when a draft is
      // finalised, which is how a second contract used to slip onto an already
      // occupied unit.
      if (!(ENDED_CONTRACT_STATUSES as readonly string[]).includes(nextStatus)) {
        const ownUnitIds = (await this.db.select({ unitId: contractUnitsTable.unitId })
          .from(contractUnitsTable).where(eq(contractUnitsTable.contractId, id))).map((r) => r.unitId);
        await this.assertNoOverlappingContract(this.db, ownUnitIds, nextStart, nextEnd, id);
      }
    }

    // A body whose keys all fall outside CONTRACT_FIELDS (e.g. `rentTerms`
    // alone) would reach `set({})`, which crashes the driver. Skip the update
    // and let the side-effects below still run.
    let contract = prior;
    if (Object.keys(updateData).length > 0) {
      const [updated] = await this.db.update(contractsTable)
        .set(updateData)
        .where(and(eq(contractsTable.id, id), eq(contractsTable.userId, ownerId), isNull(contractsTable.deletedAt)))
        .returning();
      if (!updated) throw new NotFoundException("Contract not found");
      contract = updated;
    }

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
    const id = requiredForeignKeyId(contractId, "رقم العقد");
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
    const id = requiredForeignKeyId(contractId, "رقم العقد");
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
    const id = requiredForeignKeyId(contractId, "رقم العقد");
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
