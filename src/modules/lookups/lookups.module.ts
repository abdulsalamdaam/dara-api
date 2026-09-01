import { Body, Controller, Get, Inject, Module, Post, Patch, Delete, Param, Query, BadRequestException, NotFoundException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, count, eq, or, ilike, isNull, asc } from "drizzle-orm";
import { lookupsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { listQuerySchema, wantsPagination } from "../../common/pagination";

/**
 * Central lookup endpoint. Returns the system options plus any options the
 * caller's own company has added. `GET /api/lookups` → every category;
 * `?category=unit_type` → just one. Powers all the previously hard-coded
 * dropdowns across web + mobile.
 */
@ApiTags("lookups")
@ApiBearerAuth("user-jwt")
@Controller("lookups")
@UseGuards(JwtAuthGuard)
class LookupsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /**
   * Lookup options.
   *
   * Three shapes, by design rather than by accident:
   *
   *   no `category`     → the whole reference bundle, grouped
   *                       `{ unit_type: [...], city: [...] }`. This is the
   *                       payload every dropdown caches for ten minutes, and it
   *                       is deliberately NOT paged: a partial bundle would
   *                       silently give some dropdowns fewer options than exist.
   *   `category=x`      → that category's options as a bare array (unchanged).
   *   `category=x` plus `page`/`pageSize`/`paginated`
   *                     → `{ data, page, pageSize, total }`, for a picker over
   *                       a long category (cities, nationalities) that wants to
   *                       page and type rather than load the lot.
   *
   * `search` matches the key and both labels, in SQL, so a typed-in filter is
   * resolved by the database in every one of those shapes.
   */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const category = typeof rawQuery?.category === "string" && rawQuery.category ? rawQuery.category : undefined;
    const q = listQuerySchema.parse(rawQuery ?? {});
    // Paging only makes sense for a single category - a page of the grouped
    // bundle would be a bundle with holes in it.
    const paged = !!category && wantsPagination(rawQuery);

    const companyId = user.companyId ?? null;
    const scope = companyId != null
      ? or(isNull(lookupsTable.companyId), eq(lookupsTable.companyId, companyId))
      : isNull(lookupsTable.companyId);
    const where = and(
      eq(lookupsTable.isActive, true),
      scope,
      ...(category ? [eq(lookupsTable.category, category)] : []),
      ...(q.search ? [or(
        ilike(lookupsTable.key, `%${q.search}%`),
        ilike(lookupsTable.labelAr, `%${q.search}%`),
        ilike(lookupsTable.labelEn, `%${q.search}%`),
      )] : []),
    );

    let rowsQ = this.db.select({
      id: lookupsTable.id,
      category: lookupsTable.category,
      key: lookupsTable.key,
      labelAr: lookupsTable.labelAr,
      labelEn: lookupsTable.labelEn,
      sortOrder: lookupsTable.sortOrder,
      parentKey: lookupsTable.parentKey,
      companyId: lookupsTable.companyId,
    })
      .from(lookupsTable)
      .where(where)
      // `id` last - `sort_order` is deliberately non-unique (whole categories
      // are seeded at 999), so it alone cannot order a page deterministically.
      .orderBy(asc(lookupsTable.category), asc(lookupsTable.sortOrder), asc(lookupsTable.id))
      .$dynamic();
    if (paged) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow] = await Promise.all([
      rowsQ,
      paged ? this.db.select({ total: count() }).from(lookupsTable).where(where)
            : Promise.resolve([{ total: 0 }]),
    ]);

    if (paged) return { data: rows, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0) };

    // Grouped by category for easy consumption: { unit_type: [...], ... }
    const grouped: Record<string, typeof rows> = {};
    for (const r of rows) (grouped[r.category] ??= []).push(r);
    return category ? (grouped[category] ?? []) : grouped;
  }

  /** Add a company-specific option (e.g. a custom unit type). */
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    const category = String(body?.category || "").trim();
    const labelAr = String(body?.labelAr || "").trim();
    const labelEn = String(body?.labelEn || body?.labelAr || "").trim();
    if (!category || !labelAr) throw new BadRequestException("category and labelAr are required");
    const key = String(body?.key || labelEn || labelAr).trim().toLowerCase().replace(/\s+/g, "_").slice(0, 60);
    const [row] = await this.db.insert(lookupsTable).values({
      category, key, labelAr, labelEn,
      sortOrder: Number(body?.sortOrder ?? 999),
      companyId: user.companyId ?? null,
    }).returning();
    return row;
  }

  @Patch(":id")
  async update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    const lid = parseInt(id, 10);
    const [existing] = await this.db.select().from(lookupsTable).where(eq(lookupsTable.id, lid));
    if (!existing) throw new NotFoundException("Lookup not found");
    // A company may only edit its own options, never the system ones.
    if (existing.companyId == null || existing.companyId !== (user.companyId ?? null)) {
      throw new BadRequestException("System options cannot be edited");
    }
    const data: Record<string, unknown> = {};
    for (const f of ["labelAr", "labelEn", "sortOrder", "isActive"]) {
      if (body[f] !== undefined) data[f] = body[f];
    }
    const [row] = await this.db.update(lookupsTable).set(data).where(eq(lookupsTable.id, lid)).returning();
    return row;
  }

  @Delete(":id")
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const lid = parseInt(id, 10);
    const [existing] = await this.db.select().from(lookupsTable).where(eq(lookupsTable.id, lid));
    if (!existing) throw new NotFoundException("Lookup not found");
    if (existing.companyId == null || existing.companyId !== (user.companyId ?? null)) {
      throw new BadRequestException("System options cannot be deleted");
    }
    await this.db.delete(lookupsTable).where(eq(lookupsTable.id, lid));
    return { success: true };
  }
}

@Module({ controllers: [LookupsController] })
export class LookupsModule {}
