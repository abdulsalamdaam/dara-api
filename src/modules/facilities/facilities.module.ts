import { Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sum } from "drizzle-orm";
import { facilitiesTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { listQuerySchema, parseDateBound, wantsPagination } from "../../common/pagination";

const FIELDS = ["name", "propertyName", "type", "status", "lastMaintenance", "nextMaintenance", "monthlyOpex", "notes"] as const;

@ApiTags("facilities")
@ApiBearerAuth("user-jwt")
@Controller("facilities")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class FacilitiesController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /**
   * Facilities (lifts, generators, pumps...).
   *
   * Every filter the tab offers is a query parameter resolved in SQL: free-text
   * search, `status`, `type`, `propertyName`, and a `dueFrom`/`dueTo` window on
   * the next-maintenance date (the "due soon" view). Pagination is opt-in via
   * `page`/`pageSize`/`paginated`; without them this still answers with the
   * bare array its existing callers expect, only filtered by the database
   * rather than by the browser.
   *
   * `status` and `type` are free-text columns holding Arabic labels, so they
   * are matched verbatim instead of against an enum.
   */
  @Get()
  @RequirePermissions(PERMISSIONS.FACILITIES_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const paged = wantsPagination(rawQuery);
    const q = listQuerySchema.parse(rawQuery ?? {});

    const conds: any[] = [eq(facilitiesTable.userId, scopeId(user)), isNull(facilitiesTable.deletedAt)];
    if (q.search) {
      conds.push(or(
        ilike(facilitiesTable.name, `%${q.search}%`),
        ilike(facilitiesTable.propertyName, `%${q.search}%`),
        ilike(facilitiesTable.notes, `%${q.search}%`),
      ));
    }
    const csv = (v: unknown) => typeof v === "string" && v.trim()
      ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
    const statuses = csv(rawQuery?.status);
    const types = csv(rawQuery?.type);
    if (types?.length) conds.push(inArray(facilitiesTable.type, types));
    if (typeof rawQuery?.propertyName === "string" && rawQuery.propertyName.trim()) {
      conds.push(eq(facilitiesTable.propertyName, rawQuery.propertyName.trim()));
    }
    const dueFrom = parseDateBound(rawQuery?.dueFrom);
    const dueTo = parseDateBound(rawQuery?.dueTo);
    if (dueFrom) conds.push(gte(facilitiesTable.nextMaintenance, dueFrom));
    if (dueTo) conds.push(lte(facilitiesTable.nextMaintenance, dueTo));
    // Every filter EXCEPT status - the per-status tiles must keep their counts
    // while a status is selected. Opex is summed over the same set.
    const statsWhere = and(...conds);
    if (statuses?.length) conds.push(inArray(facilitiesTable.status, statuses));
    const where = and(...conds);

    // Ascending by default, as this list has always read; `id` breaks the tie
    // on a non-unique `created_at` so paging cannot repeat or drop a row.
    const dir = rawQuery?.order === "desc" ? desc : asc;
    let rowsQ = this.db.select().from(facilitiesTable).where(where)
      .orderBy(dir(facilitiesTable.createdAt), dir(facilitiesTable.id)).$dynamic();
    if (paged) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow, opexRow, byStatus] = await Promise.all([
      rowsQ,
      paged ? this.db.select({ total: count() }).from(facilitiesTable).where(where) : Promise.resolve([{ total: 0 }]),
      // Total monthly opex and the per-status counts are headline figures on
      // this tab. They used to be a reduce() over the fetched array, which is
      // only the whole truth while the whole table fits in one response.
      paged ? this.db.select({ opex: sum(facilitiesTable.monthlyOpex) }).from(facilitiesTable).where(statsWhere)
            : Promise.resolve([{ opex: null }]),
      paged ? this.db.select({ status: facilitiesTable.status, cnt: count() })
                .from(facilitiesTable).where(statsWhere).groupBy(facilitiesTable.status)
            : Promise.resolve([]),
    ]);
    if (!paged) return rows;
    const byStatusCounts: Record<string, number> = {};
    for (const r of byStatus as Array<{ status: string; cnt: number }>) byStatusCounts[r.status] = Number(r.cnt);
    return {
      data: rows,
      page: q.page,
      pageSize: q.pageSize,
      total: Number(totalRow[0]?.total ?? 0),
      stats: {
        monthlyOpex: Math.round((Number((opexRow[0] as { opex: string | null })?.opex ?? 0) + Number.EPSILON) * 100) / 100,
        byStatus: byStatusCounts,
      },
    };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.FACILITIES_WRITE)
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    if (!body.name) throw new BadRequestException("اسم المرفق مطلوب");
    const [row] = await this.db.insert(facilitiesTable).values({
      userId: scopeId(user),
      name: body.name,
      propertyName: body.propertyName || "",
      type: body.type || "خدمي",
      status: body.status || "يعمل",
      lastMaintenance: body.lastMaintenance ?? null,
      nextMaintenance: body.nextMaintenance ?? null,
      monthlyOpex: body.monthlyOpex ? String(body.monthlyOpex) : "0",
      notes: body.notes ?? null,
    }).returning();
    return row;
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.FACILITIES_WRITE)
  async update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    const fid = parseInt(id, 10);
    const updateData: Record<string, unknown> = {};
    for (const f of FIELDS) if (body[f] !== undefined) updateData[f] = body[f];
    const [row] = await this.db.update(facilitiesTable).set(updateData)
      .where(and(eq(facilitiesTable.id, fid), eq(facilitiesTable.userId, scopeId(user)), isNull(facilitiesTable.deletedAt))).returning();
    if (!row) throw new NotFoundException("المرفق غير موجود");
    return row;
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.FACILITIES_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const fid = parseInt(id, 10);
    await this.db.update(facilitiesTable).set({ deletedAt: new Date() } as any).where(and(eq(facilitiesTable.id, fid), eq(facilitiesTable.userId, scopeId(user)), isNull(facilitiesTable.deletedAt)));
    return { ok: true };
  }
}

@Module({ controllers: [FacilitiesController] })
export class FacilitiesModule {}
