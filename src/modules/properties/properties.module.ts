import {
  Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param,
  Patch, Post, Query, BadRequestException, ConflictException, UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, isNull, notInArray, inArray, sql, or, ilike, count, asc, desc } from "drizzle-orm";
import { deedsTable, propertiesTable, unitsTable, usersTable, ownersTable } from "@oqudk/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { listQuerySchema } from "../../common/pagination";
import { assertWithinQuota } from "../../common/quota";
import { resolveLookupId, attachLookupLabels } from "../../common/lookups-resolve";

/** Maps property `*_lookup_id` FKs back to the text fields clients expect. */
const PROPERTY_LOOKUP_SPEC = [
  { idField: "typeLookupId", out: "type", mode: "key" as const },
  { idField: "usageLookupId", out: "usageType", mode: "key" as const },
  { idField: "regionLookupId", out: "region", mode: "labelAr" as const },
  { idField: "cityLookupId", out: "city", mode: "labelAr" as const },
];

/** Surface the free-text "Other" type when the row has no lookup FK. Mutates in place. */
function overlayTypeOther<T extends { type?: unknown; typeOther?: unknown }>(rows: T[]): T[] {
  for (const r of rows) {
    if ((r.type == null || r.type === "") && r.typeOther) (r as { type?: unknown }).type = r.typeOther;
  }
  return rows;
}

/** When the caller is an employee, list their owner's data. Top-level users see their own. */
function scopeId(user: AuthUser): number {
  return user.ownerUserId ?? user.id;
}

@ApiTags("properties")
@ApiBearerAuth("user-jwt")
@Controller("properties")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class PropertiesController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PROPERTIES_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    // Backwards compat: legacy callers send no query params and expect a
    // bare Property[]. When `page` or `pageSize` is present (or `search`),
    // we switch to the paginated shape { data, page, pageSize, total }.
    const usePaginated = rawQuery && (rawQuery.page != null || rawQuery.pageSize != null || rawQuery.search != null);
    const q = listQuerySchema.parse(rawQuery ?? {});
    const owner = scopeId(user);

    const baseWhere = and(eq(propertiesTable.userId, owner), isNull(propertiesTable.deletedAt));
    const where = q.search
      ? and(baseWhere, or(
          ilike(propertiesTable.name, `%${q.search}%`),
          ilike(propertiesTable.district, `%${q.search}%`),
          ilike(propertiesTable.deedNumber, `%${q.search}%`),
          ilike(deedsTable.deedNumber, `%${q.search}%`),
        ))
      : baseWhere;

    // Total respects the same WHERE so pagination headers are correct.
    const totalP = usePaginated
      ? this.db
          .select({ total: count() })
          .from(propertiesTable)
          .leftJoin(deedsTable, and(eq(propertiesTable.deedId, deedsTable.id), isNull(deedsTable.deletedAt)))
          .where(where)
      : Promise.resolve([{ total: 0 }]);

    const sortFn = q.order === "asc" ? asc : desc;
    let rowsQuery = this.db
      .select({
        property: propertiesTable,
        deedNumber: deedsTable.deedNumber,
        deedType: deedsTable.deedType,
      })
      .from(propertiesTable)
      .leftJoin(deedsTable, and(eq(propertiesTable.deedId, deedsTable.id), isNull(deedsTable.deletedAt)))
      .where(where)
      .orderBy(sortFn(propertiesTable.createdAt))
      .$dynamic();
    if (usePaginated) {
      rowsQuery = rowsQuery.limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    }

    const [rows, totalRow] = await Promise.all([rowsQuery, totalP]);

    // Fetch every page property's units in ONE query (was an N+1 — one
    // units query per property), then group by propertyId in memory.
    const propIds = rows.map((r) => r.property.id);
    const allUnits = propIds.length
      ? await this.db
          .select({ propertyId: unitsTable.propertyId, status: unitsTable.status })
          .from(unitsTable)
          .where(and(inArray(unitsTable.propertyId, propIds), isNull(unitsTable.deletedAt)))
      : [];
    const unitsByProperty = new Map<number, { status: string }[]>();
    for (const u of allUnits) {
      const arr = unitsByProperty.get(u.propertyId) ?? [];
      arr.push({ status: u.status });
      unitsByProperty.set(u.propertyId, arr);
    }

    const data = rows.map(({ property: prop, deedNumber, deedType }) => {
      const units = unitsByProperty.get(prop.id) ?? [];
      const totalUnits = prop.totalUnits || units.length || 0;
      const rentedUnits = units.filter((u) => u.status === "rented").length;
      const occupancyRate = totalUnits > 0 ? Math.round((rentedUnits / totalUnits) * 100) : 0;
      const effectiveDeedNumber = deedNumber ?? prop.deedNumber ?? null;
      return { ...prop, occupancyRate, rentedUnits, linkedDeedNumber: deedNumber, linkedDeedType: deedType, effectiveDeedNumber };
    });

    await attachLookupLabels(this.db, data, PROPERTY_LOOKUP_SPEC);
    overlayTypeOther(data);
    if (!usePaginated) return data; // legacy shape
    return { data, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0) };
  }

  /**
   * Deeds the user can still attach to a NEW property (i.e. not already
   * linked to one). Powers the dropdown on the property add wizard.
   * If `currentDeedId` is provided, include it in the result so the edit
   * wizard can show the property's existing deed even though it's linked.
   */
  @Get("available-deeds")
  @RequirePermissions(PERMISSIONS.PROPERTIES_VIEW)
  async availableDeeds(@CurrentUser() user: AuthUser) {
    const owner = scopeId(user);
    // Sub-query of deed_ids already in use by a non-deleted property.
    const linkedDeedIds = this.db
      .select({ id: propertiesTable.deedId })
      .from(propertiesTable)
      .where(and(
        eq(propertiesTable.userId, owner),
        isNull(propertiesTable.deletedAt),
        sql`${propertiesTable.deedId} IS NOT NULL`,
      ));

    return this.db.select({
      id: deedsTable.id,
      deedNumber: deedsTable.deedNumber,
      deedType: deedsTable.deedType,
    })
    .from(deedsTable)
    .where(and(
      eq(deedsTable.userId, owner),
      isNull(deedsTable.deletedAt),
      // Either not linked anywhere yet …
      sql`${deedsTable.id} NOT IN ${linkedDeedIds}`,
    ))
    .orderBy(deedsTable.createdAt);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PROPERTIES_WRITE)
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    const isDraft = Boolean(body.isDraft ?? false);
    const name = body.name;
    // Draft properties only need a name; type/city are optional and fall back
    // to the schema default / empty string so the row can still be inserted.
    const type = body.type || "residential";
    const city = body.city || "";
    if (!name || (!isDraft && (!body.type || !body.city))) {
      throw new BadRequestException("الاسم والنوع والمدينة مطلوبة · Name, type, and city are required");
    }

    const owner = scopeId(user);
    // Enforce the subscription package's property quota.
    await assertWithinQuota(this.db, owner, "properties");
    const deedId = body.deedId == null ? null : (typeof body.deedId === "number" ? body.deedId : parseInt(String(body.deedId), 10));

    // Validate the deed belongs to this scope and isn't already linked to
    // another property (1:1 enforcement at the API layer for nice errors;
    // the DB unique index is the ultimate safety net).
    if (deedId != null) {
      const [deed] = await this.db.select({ id: deedsTable.id })
        .from(deedsTable)
        .where(and(eq(deedsTable.id, deedId), eq(deedsTable.userId, owner), isNull(deedsTable.deletedAt)));
      if (!deed) throw new BadRequestException("الصك المختار غير موجود · Selected deed not found");

      const [clash] = await this.db.select({ id: propertiesTable.id })
        .from(propertiesTable)
        .where(and(eq(propertiesTable.deedId, deedId), isNull(propertiesTable.deletedAt)));
      if (clash) throw new ConflictException("الصك مرتبط بعقار آخر · This deed is already linked to another property");
    }

    // Resolve the landlord when the form sends none:
    //   1. Use the account's flagged default landlord, if any.
    //   2. Otherwise, individual-owner accounts auto-link their sole landlord.
    let ownerId: number | null = body.ownerId != null ? Number(body.ownerId) : null;
    if (ownerId == null) {
      const [def] = await this.db.select({ id: ownersTable.id })
        .from(ownersTable)
        .where(and(eq(ownersTable.userId, owner), eq(ownersTable.isDefault, true), isNull(ownersTable.deletedAt)))
        .orderBy(asc(ownersTable.id))
        .limit(1);
      ownerId = def?.id ?? null;
    }
    if (ownerId == null) {
      const [u] = await this.db.select({ packagePlan: usersTable.packagePlan })
        .from(usersTable).where(eq(usersTable.id, owner));
      if (u?.packagePlan === "individual_owner") {
        const [soleOwner] = await this.db.select({ id: ownersTable.id })
          .from(ownersTable)
          .where(and(eq(ownersTable.userId, owner), isNull(ownersTable.deletedAt)))
          .orderBy(asc(ownersTable.id))
          .limit(1);
        ownerId = soleOwner?.id ?? null;
      }
    }

    // Resolve the property type to a lookup FK; if it matches no option, keep
    // the raw text on the row (typeOther) instead of polluting the shared
    // lookups table.
    const typeLookupId = body.typeLookupId ?? await resolveLookupId(this.db, "property_type", type);
    const typeOther = typeLookupId == null && type ? String(type).trim() || null : null;

    const [prop] = await this.db.insert(propertiesTable).values({
      userId: owner,
      ownerId,
      name,
      district: body.district ?? null,
      street: body.street ?? null,
      deedNumber: body.deedNumber ?? null,
      deedId,
      totalUnits: body.totalUnits ?? 0,
      floors: body.floors ? parseInt(body.floors) : null,
      elevators: body.elevators ? parseInt(body.elevators) : null,
      parkings: body.parkings ? parseInt(body.parkings) : null,
      buildingType: body.buildingType ?? null,
      yearBuilt: body.yearBuilt ? parseInt(body.yearBuilt) : null,
      managementFeePercent: body.managementFeePercent != null && body.managementFeePercent !== ""
        ? String(body.managementFeePercent) : null,
      typeLookupId,
      typeOther,
      usageLookupId: body.usageLookupId ?? await resolveLookupId(this.db, "property_usage", body.usageType),
      regionLookupId: body.regionLookupId ?? await resolveLookupId(this.db, "region", body.region),
      cityLookupId: body.cityLookupId ?? await resolveLookupId(this.db, "city", city),
      postalCode: body.postalCode ?? null,
      buildingNumber: body.buildingNumber ?? null,
      additionalNumber: body.additionalNumber ?? null,
      mapUrl: body.mapUrl ?? null,
      amenitiesData: body.amenitiesData ?? null,
      notes: body.notes ?? null,
      imageKey: body.imageKey ?? null,
      images: Array.isArray(body.images) ? body.images : null,
      isDraft: Boolean(body.isDraft ?? false),
      isDemo: false,
    }).returning();

    const [withLabels] = overlayTypeOther(await attachLookupLabels(this.db, [{ ...prop }], PROPERTY_LOOKUP_SPEC));
    return { ...withLabels, occupancyRate: 0, rentedUnits: 0 };
  }

  @Get(":propertyId")
  @RequirePermissions(PERMISSIONS.PROPERTIES_VIEW)
  async getOne(@CurrentUser() user: AuthUser, @Param("propertyId") propertyId: string) {
    const id = parseInt(propertyId, 10);
    const [prop] = await this.db.select().from(propertiesTable)
      .where(and(eq(propertiesTable.id, id), eq(propertiesTable.userId, scopeId(user)), isNull(propertiesTable.deletedAt)));
    if (!prop) throw new NotFoundException("Property not found");

    // Surface the linked deed inline so the detail page can render the
    // clickable Deed chip without a separate round-trip.
    let deed: { id: number; deedNumber: string; deedType: string } | null = null;
    if (prop.deedId) {
      const [d] = await this.db.select({
        id: deedsTable.id,
        deedNumber: deedsTable.deedNumber,
        deedType: deedsTable.deedType,
      }).from(deedsTable)
        .where(and(eq(deedsTable.id, prop.deedId), isNull(deedsTable.deletedAt)));
      deed = d ?? null;
    }
    const [withLabels] = overlayTypeOther(await attachLookupLabels(this.db, [{ ...prop }], PROPERTY_LOOKUP_SPEC));
    return { ...withLabels, deed };
  }

  @Patch(":propertyId")
  @RequirePermissions(PERMISSIONS.PROPERTIES_WRITE)
  async update(@CurrentUser() user: AuthUser, @Param("propertyId") propertyId: string, @Body() body: any) {
    const id = parseInt(propertyId, 10);
    const owner = scopeId(user);
    const updateData: Record<string, unknown> = {};
    const fields = ["name", "status", "district", "street", "deedNumber", "totalUnits", "floors", "elevators", "parkings", "buildingType", "yearBuilt", "postalCode", "buildingNumber", "additionalNumber", "mapUrl", "amenitiesData", "notes", "imageKey", "images", "isDraft", "typeLookupId", "usageLookupId", "regionLookupId", "cityLookupId"];
    for (const field of fields) if (body[field] !== undefined) updateData[field] = body[field];
    if (body.managementFeePercent !== undefined) {
      updateData.managementFeePercent = body.managementFeePercent == null || body.managementFeePercent === ""
        ? null : String(body.managementFeePercent);
    }
    // Keep the lookup FKs in sync when the matching text field changes.
    if (body.type !== undefined) {
      const typeLookupId = body.typeLookupId ?? await resolveLookupId(this.db, "property_type", body.type);
      updateData.typeLookupId = typeLookupId;
      // Free-text "Other" type lives on the row, not in the shared lookups.
      updateData.typeOther = typeLookupId == null && body.type ? String(body.type).trim() || null : null;
    }
    if (body.usageType !== undefined) updateData.usageLookupId = body.usageLookupId ?? await resolveLookupId(this.db, "property_usage", body.usageType);
    if (body.region !== undefined) updateData.regionLookupId = body.regionLookupId ?? await resolveLookupId(this.db, "region", body.region);
    if (body.city !== undefined) updateData.cityLookupId = body.cityLookupId ?? await resolveLookupId(this.db, "city", body.city);
    if (body.ownerId !== undefined) {
      updateData["ownerId"] = body.ownerId === null ? null : (typeof body.ownerId === "number" ? body.ownerId : parseInt(String(body.ownerId), 10));
    }
    // Handle deedId change: re-validate ownership + 1:1 freshness.
    if (body.deedId !== undefined) {
      const nextDeedId = body.deedId === null ? null : (typeof body.deedId === "number" ? body.deedId : parseInt(String(body.deedId), 10));
      if (nextDeedId != null) {
        const [deed] = await this.db.select({ id: deedsTable.id })
          .from(deedsTable)
          .where(and(eq(deedsTable.id, nextDeedId), eq(deedsTable.userId, owner), isNull(deedsTable.deletedAt)));
        if (!deed) throw new BadRequestException("الصك المختار غير موجود · Selected deed not found");
        // Allow re-linking the deed already pointing to THIS property; block
        // re-linking a deed already attached to ANOTHER property.
        const [clash] = await this.db.select({ id: propertiesTable.id })
          .from(propertiesTable)
          .where(and(eq(propertiesTable.deedId, nextDeedId), isNull(propertiesTable.deletedAt)));
        if (clash && clash.id !== id) {
          throw new ConflictException("الصك مرتبط بعقار آخر · This deed is already linked to another property");
        }
      }
      updateData["deedId"] = nextDeedId;
    }
    const [prop] = await this.db.update(propertiesTable)
      .set(updateData as any)
      .where(and(eq(propertiesTable.id, id), eq(propertiesTable.userId, owner), isNull(propertiesTable.deletedAt)))
      .returning();
    if (!prop) throw new NotFoundException("Property not found");
    return overlayTypeOther(await attachLookupLabels(this.db, [{ ...prop }], PROPERTY_LOOKUP_SPEC))[0];
  }

  @Delete(":propertyId")
  @RequirePermissions(PERMISSIONS.PROPERTIES_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param("propertyId") propertyId: string) {
    const id = parseInt(propertyId, 10);
    // Soft delete: mark deleted_at instead of removing the row.
    const now = new Date();
    const [prop] = await this.db.update(propertiesTable)
      .set({ deletedAt: now } as any)
      .where(and(eq(propertiesTable.id, id), eq(propertiesTable.userId, scopeId(user)), isNull(propertiesTable.deletedAt)))
      .returning();
    if (!prop) throw new NotFoundException("Property not found");
    // Cascade: also soft-delete units belonging to this property.
    await this.db.update(unitsTable)
      .set({ deletedAt: now } as any)
      .where(and(eq(unitsTable.propertyId, id), isNull(unitsTable.deletedAt)));
    return { success: true, message: "تم الحذف بنجاح" };
  }
}

@Module({ controllers: [PropertiesController] })
export class PropertiesModule {}
