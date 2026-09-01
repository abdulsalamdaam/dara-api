import { Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, ConflictException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, isNull, or, ilike, count, asc, desc, inArray, sql, notInArray } from "drizzle-orm";
import { listQuerySchema, parseEnumList, parseIdList, wantsPagination } from "../../common/pagination";
import { unitsTable, propertiesTable, contractsTable, contractUnitsTable , lookupsTable } from "@dara/database";
import {
  BOUNDS, LIMITS, applyBool, applyBoolNonNull, applyDecimal, applyForeignKey, applyInt,
  applyMoney, applyOneOfNonNull, applyRequiredText, applyText, requiredForeignKeyId,
  requiredText,
} from "../../common/validation";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { assertWithinQuota } from "../../common/quota";
import { resolveLookupId, attachLookupLabels } from "../../common/lookups-resolve";

/** Maps unit `*_lookup_id` FKs back to the text fields the clients expect. */
const UNIT_LOOKUP_SPEC = [
  { idField: "typeLookupId", out: "type", mode: "key" as const },
  { idField: "finishingLookupId", out: "finishing", mode: "key" as const },
  // NULL here means "inherit the property's usage" — the client renders the
  // parent's value read-only in that case.
  { idField: "usageLookupId", out: "usage", mode: "key" as const },
];

/** Surface the free-text "Other" type when the row has no lookup FK. Mutates in place. */
function overlayUnitTypeOther<T extends { type?: unknown; typeOther?: unknown }>(rows: T[]): T[] {
  for (const r of rows) {
    if ((r.type == null || r.type === "") && r.typeOther) (r as { type?: unknown }).type = r.typeOther;
  }
  return rows;
}

const UNIT_FIELDS = [
  "unitNumber", "status", "floor", "area", "bedrooms", "bathrooms",
  "livingRooms", "halls", "parkingSpaces", "rentPrice", "electricityMeter",
  "waterMeter", "gasMeter", "acUnits", "acType", "parkingType",
  "amenities", "amenitiesData",
  "facadeLength", "unitLength", "unitWidth", "unitHeight",
  "hasMezzanine", "notes",
  // Attachments — Phase 7. MinIO keys + a JSON array for multi-doc uploads.
  // The frontend's AddUnitPage was already sending these; the columns now
  // exist (migration 0003_unit_attachments).
  "imageKey", "floorPlanKey", "documents", "images", "isDraft",
  // Lookups-FK refactor — FK ids alongside the legacy text columns.
  "typeLookupId", "finishingLookupId",
] as const;

const UNIT_STATUSES = ["available", "rented", "maintenance", "reserved"] as const;

/**
 * Statuses that mean "this contract is over". Anything else still binds the
 * unit — so the unit cannot be deleted, and a second overlapping contract
 * cannot be written against it.
 */
const ENDED_CONTRACT_STATUSES = ["terminated", "cancelled"] as const;

/**
 * Shape, length and range checks for every unit field a request may set.
 *
 * Applied to the create payload AND to the PATCH allowlist, because the two
 * paths write the same columns: a 5,000-character `unitNumber`, `"abc"` in
 * `area` or a negative `rentPrice` were all accepted on one path or the other.
 * Absent keys stay absent, so a PATCH still touches only what it sent.
 */
function sanitizeUnitFields(v: Record<string, unknown>): void {
  applyRequiredText(v, "unitNumber", "رقم الوحدة", LIMITS.code);
  applyOneOfNonNull(v, "status", UNIT_STATUSES, "حالة الوحدة");
  applyInt(v, "floor", "الدور", BOUNDS.floor);
  applyDecimal(v, "area", "المساحة", BOUNDS.area);
  applyInt(v, "bedrooms", "عدد غرف النوم");
  applyInt(v, "bathrooms", "عدد دورات المياه");
  applyInt(v, "livingRooms", "عدد غرف المعيشة");
  applyInt(v, "halls", "عدد الصالات");
  applyInt(v, "parkingSpaces", "عدد المواقف");
  applyInt(v, "acUnits", "عدد المكيفات");
  applyMoney(v, "rentPrice", "قيمة الإيجار");
  applyText(v, "electricityMeter", "رقم عداد الكهرباء", LIMITS.code);
  applyText(v, "waterMeter", "رقم عداد المياه", LIMITS.code);
  applyText(v, "gasMeter", "رقم عداد الغاز", LIMITS.code);
  applyText(v, "acType", "نوع التكييف");
  applyText(v, "parkingType", "نوع الموقف");
  applyText(v, "amenities", "المرافق", LIMITS.blob);
  applyText(v, "amenitiesData", "تفاصيل المرافق", LIMITS.blob);
  applyDecimal(v, "facadeLength", "طول الواجهة", BOUNDS.length);
  applyDecimal(v, "unitLength", "طول الوحدة", BOUNDS.length);
  applyDecimal(v, "unitWidth", "عرض الوحدة", BOUNDS.length);
  applyDecimal(v, "unitHeight", "ارتفاع الوحدة", BOUNDS.length);
  applyBool(v, "hasMezzanine", "وجود ميزانين");
  applyText(v, "notes", "الملاحظات", LIMITS.notes);
  applyText(v, "imageKey", "صورة الوحدة", LIMITS.address);
  applyText(v, "floorPlanKey", "المخطط", LIMITS.address);
  applyBoolNonNull(v, "isDraft", "مسودة");
  applyForeignKey(v, "typeLookupId", "نوع الوحدة");
  applyForeignKey(v, "finishingLookupId", "التشطيب");
}

/** True when a property's usage is `mixed` (سكني - تجاري). */
async function isMixedProperty(db: any, propertyUsageLookupId: number | null): Promise<boolean> {
  if (!propertyUsageLookupId) return false;
  const [row] = await db
    .select({ key: lookupsTable.key })
    .from(lookupsTable)
    .where(eq(lookupsTable.id, propertyUsageLookupId));
  return row?.key === "mixed";
}

/** Raised when a mixed-use property's unit arrives without its own usage. */
const USAGE_REQUIRED_MSG =
  "استخدام الوحدة مطلوب: العقار مسجَّل كـ (سكني - تجاري)، فلا يمكن اشتقاق استخدام الوحدة منه. " +
  "اختر استخدام هذه الوحدة.";

/**
 * Resolve the usage to store on a unit.
 *
 * Units inherit their property's usage — that is what every unit did before
 * the column existed. The single exception is a property whose usage is
 * `mixed` (سكني - تجاري), where units genuinely differ and the user picks per
 * unit. Anywhere else an override is silently dropped rather than rejected:
 * the client should not be offering the control at all, and failing the whole
 * save over a field the user could not see would be worse than ignoring it.
 *
 * Returns `undefined` when the caller supplied nothing, so PATCH can tell
 * "leave alone" apart from "clear it".
 */
async function resolveUnitUsage(
  db: any,
  propertyUsageLookupId: number | null,
  requested: unknown,
): Promise<number | null | undefined> {
  if (requested === undefined) return undefined;
  // Not mixed → always inherit, i.e. store NULL.
  if (!(await isMixedProperty(db, propertyUsageLookupId))) return null;
  if (requested === null || requested === "") return null;
  // Accept either a lookup key ("commercial") or a raw id, matching how the
  // type and finishing fields are already handled.
  if (typeof requested === "number" || /^\d+$/.test(String(requested))) {
    const n = Number(requested);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return await resolveLookupId(db, "property_usage", String(requested));
}

@ApiTags("units")
@ApiBearerAuth("user-jwt")
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
class UnitsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /**
   * A unit number identifies the unit inside its property — "R-1" twice in one
   * building is two records nobody can tell apart on a contract, an invoice or
   * a report. Compared case-insensitively; `excludeId` lets an edit keep its
   * own number.
   */
  private async assertUnitNumberFree(propertyId: number, unitNumber: string, excludeId: number | null) {
    const conds = [
      eq(unitsTable.propertyId, propertyId),
      isNull(unitsTable.deletedAt),
      sql`lower(${unitsTable.unitNumber}) = lower(${unitNumber})`,
    ];
    if (excludeId != null) conds.push(sql`${unitsTable.id} <> ${excludeId}`);
    const [clash] = await this.db.select({ id: unitsTable.id }).from(unitsTable).where(and(...conds)).limit(1);
    if (clash) {
      throw new ConflictException(
        `رقم الوحدة "${unitNumber}" مستخدم بالفعل في هذا العقار · Unit number already exists in this property`,
      );
    }
  }

  /**
   * Refuse to delete a unit that a live contract still points at.
   *
   * Deleting it left the contract `active` with pending installments against a
   * unit that no longer exists — the contract kept billing, the schedule kept
   * running, and nothing in the UI could explain where the unit went. Same
   * precedent as the deed → property guard in `deeds.module.ts`: ask the user
   * to end the contract first rather than silently orphan it.
   *
   * Draft contracts do not count: a draft occupies no unit and generates no
   * installments until it is finalised.
   */
  private async liveContractsForUnits(unitIds: number[]) {
    if (unitIds.length === 0) return [];
    return this.db
      .select({ contractNumber: contractsTable.contractNumber })
      .from(contractUnitsTable)
      .innerJoin(contractsTable, eq(contractsTable.id, contractUnitsTable.contractId))
      .where(and(
        inArray(contractUnitsTable.unitId, unitIds),
        isNull(contractsTable.deletedAt),
        eq(contractsTable.isDraft, false),
        notInArray(contractsTable.status, ENDED_CONTRACT_STATUSES as any),
      ))
      .limit(5);
  }

  /**
   * Units across the account, paginated and filtered by the database.
   *
   * Query parameters, all applied in SQL: `search` (unit number / property
   * name), `status`, `propertyId`, `typeLookupId`, `floor` and `isDraft`. The
   * Units tab drives its four headline cards off the status counts, so those
   * come back in `stats.byStatus` - counted by the database over the same
   * filter, rather than by counting whatever rows the browser happened to hold.
   */
  @Get("units")
  @RequirePermissions(PERMISSIONS.UNITS_VIEW)
  async listAll(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const usePaginated = wantsPagination(rawQuery, ["search"]);
    const q = listQuerySchema.parse(rawQuery ?? {});

    const conds: any[] = [
      eq(propertiesTable.userId, scopeId(user)),
      isNull(propertiesTable.deletedAt),
      isNull(unitsTable.deletedAt),
    ];
    if (q.search) {
      conds.push(or(
        ilike(unitsTable.unitNumber, `%${q.search}%`),
        ilike(propertiesTable.name, `%${q.search}%`),
      ));
    }
    const statuses = parseEnumList(rawQuery?.status, ["available", "rented", "maintenance", "reserved"] as const);
    const propertyIds = parseIdList(rawQuery?.propertyId) ?? parseIdList(rawQuery?.propertyIds);
    if (propertyIds) conds.push(inArray(unitsTable.propertyId, propertyIds));
    // Same two spellings as properties: the portal's chips carry the lookup
    // key, integrations carry the id.
    const typeIds = parseIdList(rawQuery?.typeLookupId)
      ?? await (async () => {
        const raw = rawQuery?.type;
        if (raw == null || raw === "" || raw === "all") return null;
        const values = String(raw).split(",").map((v: string) => v.trim()).filter(Boolean);
        if (values.length === 0) return null;
        const ids = await Promise.all(values.map((v: string) => resolveLookupId(this.db, "unit_type", v)));
        return ids.filter((id): id is number => id != null);
      })();
    if (typeIds) conds.push(inArray(unitsTable.typeLookupId, typeIds));
    if (typeof rawQuery?.floor === "string" && rawQuery.floor.trim() !== "") {
      const floors = rawQuery.floor.split(",").map((x: string) => parseInt(x.trim(), 10)).filter(Number.isInteger);
      if (floors.length) conds.push(inArray(unitsTable.floor, floors));
    }
    if (rawQuery?.isDraft === "1" || rawQuery?.isDraft === "true") conds.push(eq(unitsTable.isDraft, true));
    else if (rawQuery?.isDraft === "0" || rawQuery?.isDraft === "false") conds.push(eq(unitsTable.isDraft, false));
    // Every filter EXCEPT status - the four status cards ARE the status filter,
    // so picking one must not blank the other three.
    const statsWhere = and(...conds);
    if (statuses) conds.push(inArray(unitsTable.status, statuses));
    const where = and(...conds);

    /**
     * The current tenant, as a correlated sub-query rather than a join.
     *
     * Joining `contract_units` -> `contracts` multiplied a unit into one row
     * per active contract, and the de-duplication that hid it ran AFTER
     * LIMIT/OFFSET: a unit with two active contracts consumed two slots on the
     * page and collapsed back to one, so that page came back short and the row
     * it displaced belonged to nobody's page. One row per unit here, which is
     * also exactly what the `total` below counts.
     */
    const fromActiveContract = (col: any) => sql<string | null>`(${this.db
      .select({ v: col })
      .from(contractUnitsTable)
      .innerJoin(contractsTable, eq(contractsTable.id, contractUnitsTable.contractId))
      .where(and(
        eq(contractUnitsTable.unitId, unitsTable.id),
        eq(contractsTable.status, "active"),
        isNull(contractsTable.deletedAt),
      ))
      .orderBy(desc(contractsTable.id))
      .limit(1)})`;

    let rowsQ = this.db
      .select({
        id: unitsTable.id,
        propertyId: unitsTable.propertyId,
        propertyName: propertiesTable.name,
        unitNumber: unitsTable.unitNumber,
        typeLookupId: unitsTable.typeLookupId,
        typeOther: unitsTable.typeOther,
        status: unitsTable.status,
        floor: unitsTable.floor,
        area: unitsTable.area,
        bedrooms: unitsTable.bedrooms,
        bathrooms: unitsTable.bathrooms,
        livingRooms: unitsTable.livingRooms,
        halls: unitsTable.halls,
        parkingSpaces: unitsTable.parkingSpaces,
        rentPrice: unitsTable.rentPrice,
        electricityMeter: unitsTable.electricityMeter,
        waterMeter: unitsTable.waterMeter,
        gasMeter: unitsTable.gasMeter,
        acUnits: unitsTable.acUnits,
        acType: unitsTable.acType,
        parkingType: unitsTable.parkingType,
        amenities: unitsTable.amenities,
        amenitiesData: unitsTable.amenitiesData,
        finishingLookupId: unitsTable.finishingLookupId,
        // Needed by UNIT_LOOKUP_SPEC to produce `usage`. Without it the list
        // silently returned no usage at all, so the edit modal always reopened
        // on "inherit" and the contract wizard could not read a mixed-use
        // unit's own usage to decide VAT.
        usageLookupId: unitsTable.usageLookupId,
        facadeLength: unitsTable.facadeLength,
        unitLength: unitsTable.unitLength,
        unitWidth: unitsTable.unitWidth,
        unitHeight: unitsTable.unitHeight,
        hasMezzanine: unitsTable.hasMezzanine,
        // Attachments — surfaced so the unit detail view can render them.
        imageKey: unitsTable.imageKey,
        floorPlanKey: unitsTable.floorPlanKey,
        documents: unitsTable.documents,
        images: unitsTable.images,
        isDraft: unitsTable.isDraft,
        notes: unitsTable.notes,
        createdAt: unitsTable.createdAt,
        tenantName: fromActiveContract(contractsTable.tenantName).as("tenant_name"),
        tenantPhone: fromActiveContract(contractsTable.tenantPhone).as("tenant_phone"),
      })
      .from(unitsTable)
      .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
      .where(where)
      // `id` tiebreak on a non-unique `created_at`, so a page boundary landing
      // inside a batch of units created together cannot repeat or drop one.
      .orderBy(
        (q.order === "asc" ? asc : desc)(unitsTable.createdAt),
        (q.order === "asc" ? asc : desc)(unitsTable.id),
      )
      .$dynamic();
    if (usePaginated) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow, statusRows] = await Promise.all([
      rowsQ,
      usePaginated
        ? this.db.select({ total: count() }).from(unitsTable)
            .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
            .where(where)
        : Promise.resolve([{ total: 0 }]),
      // The Units tab's four status cards. Counted by the database over the
      // same filter so a card can never disagree with the table below it.
      usePaginated
        ? this.db.select({ status: unitsTable.status, cnt: count() })
            .from(unitsTable)
            .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
            .where(statsWhere)
            .groupBy(unitsTable.status)
        : Promise.resolve([]),
    ]);
    await attachLookupLabels(this.db, rows as any[], UNIT_LOOKUP_SPEC);
    overlayUnitTypeOther(rows as any[]);
    if (!usePaginated) return rows;
    const byStatus: Record<string, number> = {};
    for (const r of statusRows as Array<{ status: string; cnt: number }>) byStatus[r.status] = Number(r.cnt);
    return {
      data: rows,
      page: q.page,
      pageSize: q.pageSize,
      total: Number(totalRow[0]?.total ?? 0),
      stats: { byStatus },
    };
  }

  @Get("properties/:propertyId/units")
  @RequirePermissions(PERMISSIONS.UNITS_VIEW)
  async listByProperty(@CurrentUser() user: AuthUser, @Param("propertyId") propertyId: string) {
    const id = requiredForeignKeyId(propertyId, "رقم العقار");
    const [prop] = await this.db.select().from(propertiesTable)
      .where(and(eq(propertiesTable.id, id), eq(propertiesTable.userId, scopeId(user)), isNull(propertiesTable.deletedAt)));
    if (!prop) throw new NotFoundException("Property not found");
    const rows = await this.db.select().from(unitsTable)
      .where(and(eq(unitsTable.propertyId, id), isNull(unitsTable.deletedAt)))
      .orderBy(unitsTable.createdAt);
    return overlayUnitTypeOther(await attachLookupLabels(this.db, rows, UNIT_LOOKUP_SPEC));
  }

  @Post("properties/:propertyId/units")
  @RequirePermissions(PERMISSIONS.UNITS_WRITE)
  async create(@CurrentUser() user: AuthUser, @Param("propertyId") propertyId: string, @Body() body: any) {
    const id = requiredForeignKeyId(propertyId, "رقم العقار");
    const [prop] = await this.db.select().from(propertiesTable)
      .where(and(eq(propertiesTable.id, id), eq(propertiesTable.userId, scopeId(user)), isNull(propertiesTable.deletedAt)));
    if (!prop) throw new NotFoundException("Property not found");

    // Enforce the subscription package's unit quota.
    await assertWithinQuota(this.db, scopeId(user), "units");

    // A property declares how many units it has (properties.total_units). Stop
    // the list from exceeding it — otherwise occupancy rates, unit counts and
    // every report built on them silently disagree with the property record.
    // Only enforced when totalUnits is actually set; legacy rows leave it null.
    const declared = Number(prop.totalUnits ?? 0);
    if (declared > 0) {
      const [{ existing }] = await this.db
        .select({ existing: count() })
        .from(unitsTable)
        .where(and(eq(unitsTable.propertyId, id), isNull(unitsTable.deletedAt)));
      if (Number(existing) >= declared) {
        throw new BadRequestException(
          `لا يمكن إضافة وحدة جديدة: العقار مُسجَّل بـ ${declared} وحدة وتم إضافتها بالكامل. ` +
          `عدّل عدد وحدات العقار أولاً إذا كان الرقم غير صحيح.`,
        );
      }
    }

    const isDraft = Boolean(body.isDraft ?? false);
    // Draft units only need a unit number; type falls back to the schema default.
    if (!body.unitNumber || (!isDraft && !body.type)) {
      throw new BadRequestException("رقم الوحدة والنوع مطلوبان");
    }
    const unitNumber = requiredText(body.unitNumber, "رقم الوحدة", LIMITS.code);
    await this.assertUnitNumberFree(id, unitNumber, null);

    const values: Record<string, unknown> = { propertyId: id, isDemo: false };
    for (const f of UNIT_FIELDS) values[f] = body[f] ?? null;
    values.unitNumber = unitNumber;
    sanitizeUnitFields(values);
    // status is NOT NULL — fall back to the schema default if the loop above
    // set it to null because body.status was undefined.
    if (values.status == null) values.status = "available";
    // is_draft is NOT NULL, and the field loop above writes an explicit null
    // when the caller omits it — so creating a unit without `isDraft` in the
    // body was a 500. The web form always sends it; nothing else does.
    values.isDraft = isDraft;
    // Unit type / direction / finishing are FK-only now.
    const unitTypeLookupId = body.typeLookupId ?? await resolveLookupId(this.db, "unit_type", body.type || "apartment");
    values.typeLookupId = unitTypeLookupId;
    // A custom "Other" type that matches no lookup stays as raw text on the row.
    values.typeOther = unitTypeLookupId == null && body.type ? String(body.type).trim() || null : null;
    values.finishingLookupId = body.finishingLookupId ?? await resolveLookupId(this.db, "unit_finishing", body.finishing);
    values.usageLookupId = (await resolveUnitUsage(this.db, prop.usageLookupId, body.usage ?? body.usageLookupId)) ?? null;
    // On a mixed-use property there is nothing to inherit — the unit's own
    // usage is the only thing that decides whether its rent carries VAT, so it
    // cannot be left empty. A draft is exempt, like `type` above: it is
    // explicitly incomplete and cannot be contracted against yet.
    if (!isDraft && values.usageLookupId == null && (await isMixedProperty(this.db, prop.usageLookupId))) {
      throw new BadRequestException(USAGE_REQUIRED_MSG);
    }

    const [unit] = await this.db.insert(unitsTable).values(values as any).returning();
    return overlayUnitTypeOther(await attachLookupLabels(this.db, [unit!], UNIT_LOOKUP_SPEC))[0];
  }

  @Patch("units/:unitId")
  @RequirePermissions(PERMISSIONS.UNITS_WRITE)
  async update(@CurrentUser() user: AuthUser, @Param("unitId") unitId: string, @Body() body: any) {
    const id = requiredForeignKeyId(unitId, "رقم الوحدة");
    // Verify the unit belongs to a property owned by this user/owner before allowing edits.
    const [unit0] = await this.db
      .select({
        id: unitsTable.id, propertyId: unitsTable.propertyId,
        // Needed to spot the draft → live transition, and to know what the
        // unit's usage already is when the request does not send one.
        isDraft: unitsTable.isDraft, usageLookupId: unitsTable.usageLookupId,
        propertyUsageLookupId: propertiesTable.usageLookupId,
      })
      .from(unitsTable)
      .innerJoin(propertiesTable, and(eq(unitsTable.propertyId, propertiesTable.id), eq(propertiesTable.userId, scopeId(user)), isNull(propertiesTable.deletedAt)))
      .where(and(eq(unitsTable.id, id), isNull(unitsTable.deletedAt)));
    if (!unit0) throw new NotFoundException("Unit not found");
    const updateData: Record<string, unknown> = {};
    for (const f of UNIT_FIELDS) if (body[f] !== undefined) updateData[f] = body[f];
    // Same rules the create path enforces — the edit path used to write every
    // value straight through, so a unit that could not be created malformed
    // could still be edited into that state.
    sanitizeUnitFields(updateData);
    if (typeof updateData.unitNumber === "string") {
      await this.assertUnitNumberFree(unit0.propertyId, updateData.unitNumber, id);
    }
    if (body.type !== undefined) {
      const unitTypeLookupId = body.typeLookupId ?? await resolveLookupId(this.db, "unit_type", body.type);
      updateData.typeLookupId = unitTypeLookupId;
      // Free-text "Other" type lives on the row, not in the shared lookups.
      updateData.typeOther = unitTypeLookupId == null && body.type ? String(body.type).trim() || null : null;
    }
    if (body.finishing !== undefined) updateData.finishingLookupId = body.finishingLookupId ?? await resolveLookupId(this.db, "unit_finishing", body.finishing);
    if (body.usage !== undefined || body.usageLookupId !== undefined) {
      const [parent] = await this.db
        .select({ usageLookupId: propertiesTable.usageLookupId })
        .from(unitsTable)
        .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
        .where(eq(unitsTable.id, id));
      const resolved = await resolveUnitUsage(this.db, parent?.usageLookupId ?? null, body.usage ?? body.usageLookupId);
      // Same rule as create: a mixed-use property's unit may not be cleared
      // back to "inherit", because there is nothing coherent to inherit.
      if (resolved === null && (await isMixedProperty(this.db, parent?.usageLookupId ?? null))) {
        throw new BadRequestException(USAGE_REQUIRED_MSG);
      }
      if (resolved !== undefined) updateData.usageLookupId = resolved;
    }
    // Finalising a draft applies the rule the create path applies to a live
    // unit: on a mixed-use property nothing can be inherited, so the unit's own
    // usage decides whether its rent carries VAT and cannot be missing. The
    // draft exemption ended the moment `isDraft` was cleared, but nothing
    // re-checked it — a draft with no usage went live and billed on a guess.
    const willBeDraft = updateData.isDraft !== undefined ? Boolean(updateData.isDraft) : Boolean(unit0.isDraft);
    if (unit0.isDraft && !willBeDraft) {
      const nextUsage = updateData.usageLookupId !== undefined
        ? (updateData.usageLookupId as number | null)
        : unit0.usageLookupId;
      if (nextUsage == null && (await isMixedProperty(this.db, unit0.propertyUsageLookupId ?? null))) {
        throw new BadRequestException(USAGE_REQUIRED_MSG);
      }
    }
    if (Object.keys(updateData).length === 0) throw new BadRequestException("لا توجد حقول للتحديث · No updatable fields in request");
    const [unit] = await this.db.update(unitsTable).set(updateData).where(eq(unitsTable.id, id)).returning();
    return overlayUnitTypeOther(await attachLookupLabels(this.db, [unit!], UNIT_LOOKUP_SPEC))[0];
  }

  @Delete("units/:unitId")
  @RequirePermissions(PERMISSIONS.UNITS_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param("unitId") unitId: string) {
    const id = requiredForeignKeyId(unitId, "رقم الوحدة");
    const [unit0] = await this.db
      .select({ id: unitsTable.id })
      .from(unitsTable)
      .innerJoin(propertiesTable, and(eq(unitsTable.propertyId, propertiesTable.id), eq(propertiesTable.userId, scopeId(user)), isNull(propertiesTable.deletedAt)))
      .where(and(eq(unitsTable.id, id), isNull(unitsTable.deletedAt)));
    if (!unit0) throw new NotFoundException("Unit not found");
    // Deleting a unit out from under a live contract left the contract active
    // with pending installments and no unit — refuse, and name the contract so
    // the user knows what to end first.
    const live = await this.liveContractsForUnits([id]);
    if (live.length > 0) {
      const numbers = live.map((c) => c.contractNumber).join("، ");
      throw new ConflictException(
        `لا يمكن حذف الوحدة لارتباطها بعقد ساري (${numbers}). أنهِ العقد أولاً ثم احذف الوحدة · Cannot delete: unit is linked to an active contract`,
      );
    }
    await this.db.update(unitsTable).set({ deletedAt: new Date() } as any).where(eq(unitsTable.id, id));
    return { success: true, message: "تم الحذف بنجاح" };
  }
}

@Module({ controllers: [UnitsController] })
export class UnitsModule {}
