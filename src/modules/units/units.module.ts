import { Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, isNull, or, ilike, count, asc, desc } from "drizzle-orm";
import { listQuerySchema } from "../../common/pagination";
import { unitsTable, propertiesTable, contractsTable, contractUnitsTable , lookupsTable } from "@dara/database";
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

  @Get("units")
  @RequirePermissions(PERMISSIONS.UNITS_VIEW)
  async listAll(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const usePaginated = rawQuery && (rawQuery.page != null || rawQuery.pageSize != null || rawQuery.search != null);
    const q = listQuerySchema.parse(rawQuery ?? {});

    const baseWhere = and(
      eq(propertiesTable.userId, scopeId(user)),
      isNull(propertiesTable.deletedAt),
      isNull(unitsTable.deletedAt),
    );
    const where = q.search ? and(baseWhere, or(
      ilike(unitsTable.unitNumber, `%${q.search}%`),
      ilike(propertiesTable.name, `%${q.search}%`),
    )) : baseWhere;

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
        tenantName: contractsTable.tenantName,
        tenantPhone: contractsTable.tenantPhone,
      })
      .from(unitsTable)
      .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
      // A unit's active contract is reached through the contract_units
      // join table now that a contract can span many units.
      .leftJoin(contractUnitsTable, eq(contractUnitsTable.unitId, unitsTable.id))
      .leftJoin(contractsTable, and(
        eq(contractsTable.id, contractUnitsTable.contractId),
        eq(contractsTable.status, "active"),
        isNull(contractsTable.deletedAt),
      ))
      .where(where)
      .orderBy((q.order === "asc" ? asc : desc)(unitsTable.createdAt))
      .$dynamic();
    if (usePaginated) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow] = await Promise.all([
      rowsQ,
      usePaginated
        ? this.db.select({ total: count() }).from(unitsTable)
            .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
            .where(where)
        : Promise.resolve([{ total: 0 }]),
    ]);
    // A unit with more than one active contract would be joined into multiple
    // rows — dedupe by id so each unit appears once.
    const deduped = Array.from(new Map(rows.map((r) => [r.id, r])).values());
    await attachLookupLabels(this.db, deduped, UNIT_LOOKUP_SPEC);
    overlayUnitTypeOther(deduped);
    if (!usePaginated) return deduped;
    return { data: deduped, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0) };
  }

  @Get("properties/:propertyId/units")
  @RequirePermissions(PERMISSIONS.UNITS_VIEW)
  async listByProperty(@CurrentUser() user: AuthUser, @Param("propertyId") propertyId: string) {
    const id = parseInt(propertyId, 10);
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
    const id = parseInt(propertyId, 10);
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

    const values: Record<string, unknown> = { propertyId: id, isDemo: false };
    for (const f of UNIT_FIELDS) values[f] = body[f] ?? null;
    values.unitNumber = body.unitNumber;
    // status is NOT NULL — fall back to the schema default if the loop above
    // set it to null because body.status was undefined.
    if (values.status == null) values.status = "available";
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
    const id = parseInt(unitId, 10);
    // Verify the unit belongs to a property owned by this user/owner before allowing edits.
    const [unit0] = await this.db
      .select({ id: unitsTable.id })
      .from(unitsTable)
      .innerJoin(propertiesTable, and(eq(unitsTable.propertyId, propertiesTable.id), eq(propertiesTable.userId, scopeId(user)), isNull(propertiesTable.deletedAt)))
      .where(and(eq(unitsTable.id, id), isNull(unitsTable.deletedAt)));
    if (!unit0) throw new NotFoundException("Unit not found");
    const updateData: Record<string, unknown> = {};
    for (const f of UNIT_FIELDS) if (body[f] !== undefined) updateData[f] = body[f];
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
    const [unit] = await this.db.update(unitsTable).set(updateData).where(eq(unitsTable.id, id)).returning();
    return overlayUnitTypeOther(await attachLookupLabels(this.db, [unit!], UNIT_LOOKUP_SPEC))[0];
  }

  @Delete("units/:unitId")
  @RequirePermissions(PERMISSIONS.UNITS_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param("unitId") unitId: string) {
    const id = parseInt(unitId, 10);
    const [unit0] = await this.db
      .select({ id: unitsTable.id })
      .from(unitsTable)
      .innerJoin(propertiesTable, and(eq(unitsTable.propertyId, propertiesTable.id), eq(propertiesTable.userId, scopeId(user)), isNull(propertiesTable.deletedAt)))
      .where(and(eq(unitsTable.id, id), isNull(unitsTable.deletedAt)));
    if (!unit0) throw new NotFoundException("Unit not found");
    await this.db.update(unitsTable).set({ deletedAt: new Date() } as any).where(eq(unitsTable.id, id));
    return { success: true, message: "تم الحذف بنجاح" };
  }
}

@Module({ controllers: [UnitsController] })
export class UnitsModule {}
