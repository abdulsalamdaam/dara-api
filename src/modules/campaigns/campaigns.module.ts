import { Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, sum } from "drizzle-orm";
import { campaignsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { likeContains, listQuerySchema, parseDateBound, wantsPagination } from "../../common/pagination";

/**
 * Campaigns created before the status keys were English carry the Arabic
 * label instead (`نشطة` was even the create default). They are read as their
 * English key wherever status is grouped or filtered - no data migration.
 */
const LEGACY_STATUS: Record<string, string> = { "نشطة": "active", "متوقفة": "paused", "منتهية": "ended" };
// Inlined as literals, not bound parameters: the same expression is used in
// SELECT and GROUP BY, and Postgres only matches the two when they are
// textually identical - `$1` in one and `$7` in the other is a GROUP BY error.
const statusKeySql = sql<string>`case ${campaignsTable.status} ${sql.raw(
  Object.entries(LEGACY_STATUS).map(([ar, en]) => `when '${ar}' then '${en}'`).join(" "),
)} else ${campaignsTable.status} end`;

const FIELDS = ["name", "targetUnits", "channel", "budget", "leads", "conversions", "status", "startDate", "endDate", "notes"] as const;

@ApiTags("campaigns")
@ApiBearerAuth("user-jwt")
@Controller("campaigns")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class CampaignsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /**
   * Marketing campaigns.
   *
   * Filters (search / status / channel / date window) are applied in SQL, so an
   * unpaginated caller still gets the FILTERED list rather than a filtered
   * slice. Pagination is opt-in — `page`/`pageSize`/`paginated` switch the
   * response to `{ data, page, pageSize, total }`; without them the legacy bare
   * array is preserved. `status` and `channel` are free text on this table
   * (older rows carry Arabic status labels), so they are matched exactly
   * against whatever the caller sends rather than validated against an enum -
   * except that `status=active` also matches a legacy `نشطة` row, and so on.
   *
   * `stats` (paged only) aggregates the whole filtered set ignoring status:
   * the headline totals, `byStatus` (count + leads per English status key) and
   * `byChannel` (leads / conversions / budget per channel, most leads first) -
   * everything the channels and analytics panels used to sum in the browser.
   */
  @Get()
  @RequirePermissions(PERMISSIONS.CAMPAIGNS_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const paged = wantsPagination(rawQuery);
    const q = listQuerySchema.parse(rawQuery ?? {});

    const conds: any[] = [eq(campaignsTable.userId, scopeId(user)), isNull(campaignsTable.deletedAt)];
    if (q.search) {
      const pattern = likeContains(q.search);
      conds.push(or(
        ilike(campaignsTable.name, pattern),
        ilike(campaignsTable.channel, pattern),
        ilike(campaignsTable.targetUnits, pattern),
        ilike(campaignsTable.notes, pattern),
      ));
    }
    const statuses = typeof rawQuery?.status === "string" && rawQuery.status.trim()
      ? rawQuery.status.split(",").map((x: string) => x.trim()).filter(Boolean) : undefined;
    if (typeof rawQuery?.channel === "string" && rawQuery.channel.trim()) {
      conds.push(eq(campaignsTable.channel, rawQuery.channel.trim()));
    }
    // Window on the campaign period: everything running on or after `from`,
    // and starting on or before `to`.
    const from = parseDateBound(rawQuery?.from);
    const to = parseDateBound(rawQuery?.to);
    if (from) conds.push(gte(campaignsTable.endDate, from));
    if (to) conds.push(lte(campaignsTable.startDate, to));
    // Totals ignore the status filter - the analytics panel shows the whole
    // programme's leads/conversions/budget alongside a per-status breakdown,
    // so selecting one status must not rewrite the headline figures.
    const statsWhere = and(...conds);
    if (statuses?.length) {
      const legacy = Object.entries(LEGACY_STATUS).filter(([, en]) => statuses.includes(en)).map(([ar]) => ar);
      conds.push(inArray(campaignsTable.status, [...statuses, ...legacy]));
    }
    const where = and(...conds);

    // Kept ascending by default — this list has always read oldest-first and
    // the tab renders it in that order. `id` is the tiebreak: `created_at` is
    // not unique, and without it a page boundary landing inside a batch of
    // same-instant rows can repeat one row and drop another.
    const dir = rawQuery?.order === "desc" ? desc : asc;
    let rowsQ = this.db.select().from(campaignsTable).where(where)
      .orderBy(dir(campaignsTable.createdAt), dir(campaignsTable.id)).$dynamic();
    if (paged) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow, statsRow, statusRows, channelRows] = await Promise.all([
      rowsQ,
      paged ? this.db.select({ total: count() }).from(campaignsTable).where(where) : Promise.resolve([{ total: 0 }]),
      // The marketing tab's headline figures - leads, conversions, budget and
      // the conversion rate derived from them - were summed in the browser over
      // whatever rows had been fetched. Aggregated here over the SAME filtered
      // set instead, so they describe the whole campaign list and not the page.
      paged ? this.db.select({
        leads: sum(campaignsTable.leads),
        conversions: sum(campaignsTable.conversions),
        budget: sum(campaignsTable.budget),
      }).from(campaignsTable).where(statsWhere) : Promise.resolve([{ leads: null, conversions: null, budget: null }]),
      paged ? this.db.select({ status: statusKeySql, cnt: count(), leads: sum(campaignsTable.leads) })
        .from(campaignsTable).where(statsWhere).groupBy(statusKeySql) : Promise.resolve([]),
      paged ? this.db.select({
        channel: campaignsTable.channel,
        leads: sum(campaignsTable.leads),
        conversions: sum(campaignsTable.conversions),
        budget: sum(campaignsTable.budget),
      }).from(campaignsTable).where(statsWhere).groupBy(campaignsTable.channel) : Promise.resolve([]),
    ]);
    if (!paged) return rows;
    const st = statsRow[0] as { leads: string | null; conversions: string | null; budget: string | null } | undefined;
    const leads = Number(st?.leads ?? 0);
    const conversions = Number(st?.conversions ?? 0);
    const byStatus: Record<string, { count: number; leads: number }> = {};
    for (const r of statusRows as Array<{ status: string; cnt: number; leads: string | null }>) {
      byStatus[r.status] = { count: Number(r.cnt), leads: Number(r.leads ?? 0) };
    }
    const byChannel = (channelRows as Array<{ channel: string; leads: string | null; conversions: string | null; budget: string | null }>)
      .map((r) => ({
        channel: r.channel,
        leads: Number(r.leads ?? 0),
        conversions: Number(r.conversions ?? 0),
        budget: Math.round((Number(r.budget ?? 0) + Number.EPSILON) * 100) / 100,
      }))
      .sort((a, b) => b.leads - a.leads);
    return {
      data: rows,
      page: q.page,
      pageSize: q.pageSize,
      total: Number(totalRow[0]?.total ?? 0),
      stats: {
        leads,
        conversions,
        budget: Math.round((Number(st?.budget ?? 0) + Number.EPSILON) * 100) / 100,
        conversionRate: leads > 0 ? Math.round((conversions / leads) * 1000) / 10 : 0,
        byStatus,
        byChannel,
      },
    };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CAMPAIGNS_WRITE)
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    if (!body.name) throw new BadRequestException("اسم الحملة مطلوب");
    const [row] = await this.db.insert(campaignsTable).values({
      userId: scopeId(user),
      name: body.name,
      targetUnits: body.targetUnits ?? null,
      channel: body.channel || "",
      budget: body.budget ? String(body.budget) : "0",
      leads: body.leads ?? 0,
      conversions: body.conversions ?? 0,
      status: body.status || "active",
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      notes: body.notes ?? null,
    }).returning();
    return row;
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.CAMPAIGNS_WRITE)
  async update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    const cid = parseInt(id, 10);
    const updateData: Record<string, unknown> = {};
    for (const f of FIELDS) if (body?.[f] !== undefined) updateData[f] = body[f];
    // Nothing to write was a Drizzle "No values to set" — a 500.
    if (Object.keys(updateData).length === 0) throw new BadRequestException("لا توجد بيانات للتحديث · Nothing to update");
    const [row] = await this.db.update(campaignsTable).set(updateData)
      .where(and(eq(campaignsTable.id, cid), eq(campaignsTable.userId, scopeId(user)), isNull(campaignsTable.deletedAt))).returning();
    if (!row) throw new NotFoundException("الحملة غير موجودة");
    return row;
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.CAMPAIGNS_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const cid = parseInt(id, 10);
    await this.db.update(campaignsTable).set({ deletedAt: new Date() } as any).where(and(eq(campaignsTable.id, cid), eq(campaignsTable.userId, scopeId(user)), isNull(campaignsTable.deletedAt)));
    return { ok: true };
  }
}

@Module({ controllers: [CampaignsController] })
export class CampaignsModule {}
