import { BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module, type CanActivate, type ExecutionContext, NotFoundException, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { and, count, desc, eq, ilike, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { propertiesTable, rentalOffersTable, unitsTable, type RentalOffer } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { likeContains, listQuerySchema, wantsPagination } from "../../common/pagination";
import { riyadhToday } from "../../common/payment-status";
import { accountPlan } from "../../common/account-plan";
import { PlanUpgradeRequiredException, planHasFeature } from "../../common/plan-features";
import { formatOfferNumber, normalizeOffer, offerPrefix, offerSeq } from "./rental-offers.normalize";

/**
 * Rental offers (عروض التأجير) — the formal, non-binding offer an office sends
 * a prospective tenant (usually a company) before the Ejar contract.
 *
 * Gated with the marketing permissions, like the Offers tab that hosts it, and
 * by package: only «المكاتب العقارية» / «الشركات» (`rental_offers`) — every
 * route, reads included, answers 403 PLAN_UPGRADE_REQUIRED on tenant / عقاري.
 * The server stores the offer's INPUTS; the schedule and totals are derived
 * from them by the web (lib/rental-offer.ts), which is what prints them — so
 * no stored total can disagree when the money rules change. The grace period
 * (`free_months`) is added on top of `duration_months` (lease = grace +
 * duration, full rent billed after the grace), Oct 2026.
 *
 * `expired` is never stored: an offer still `draft` / `sent` whose
 * `valid_until` is before Riyadh today reads as expired (`effectiveStatus`),
 * exactly as an installment reads as overdue.
 */
const OPEN_STATUSES = ["draft", "sent"];

function withEffectiveStatus(row: RentalOffer, today = riyadhToday()) {
  const expired = OPEN_STATUSES.includes(row.status) && !!row.validUntil && String(row.validUntil) < today;
  return { ...row, effectiveStatus: expired ? "expired" : row.status };
}

/** Stamps that follow a status change: when it was sent, when it was decided. */
function statusStamps(status: unknown, prev?: RentalOffer): Record<string, unknown> {
  if (status === "sent" && !prev?.sentAt) return { sentAt: new Date() };
  if (status === "accepted" || status === "rejected") return { decidedAt: new Date() };
  if (status === "draft") return { sentAt: null, decidedAt: null };
  return {};
}

/** 403 PLAN_UPGRADE_REQUIRED unless the account owner's plan includes `rental_offers`. */
@Injectable()
export class RentalOffersPlanGuard implements CanActivate {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /** The account owner's stored plan. Overridable for the spec. */
  protected planOf(ownerId: number): Promise<string | null> {
    return accountPlan(this.db, ownerId);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const user = ctx.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (!user) return true; // JwtAuthGuard runs first and has already refused
    if (!planHasFeature(await this.planOf(scopeId(user)), "rental_offers")) throw new PlanUpgradeRequiredException("rental_offers");
    return true;
  }
}

@ApiTags("rental-offers")
@ApiBearerAuth("user-jwt")
@Controller("rental-offers")
@UseGuards(JwtAuthGuard, PermissionsGuard, RentalOffersPlanGuard)
class RentalOffersController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /**
   * Offers of the caller's account, newest first. `search` matches the number,
   * client, title and offered property / unit; `status` takes a comma list and
   * understands the derived `expired`. Pagination is opt-in, like campaigns;
   * the paged response adds `stats.byStatus` (effective status counts over the
   * search-filtered set, ignoring the status filter).
   */
  @Get()
  @RequirePermissions(PERMISSIONS.CAMPAIGNS_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const paged = wantsPagination(rawQuery);
    const q = listQuerySchema.parse(rawQuery ?? {});
    const today = riyadhToday();
    const T = rentalOffersTable;

    const conds: any[] = [eq(T.userId, scopeId(user)), isNull(T.deletedAt)];
    if (q.search) {
      const p = likeContains(q.search);
      conds.push(or(
        ilike(T.number, p), ilike(T.clientName, p), ilike(T.title, p),
        sql`${T.unitSnapshot}->>'propertyName' ilike ${p}`,
        sql`${T.unitSnapshot}->>'unitNumber' ilike ${p}`,
      ));
    }
    const statsWhere = and(...conds);

    // `today` is inlined as a literal, not bound: the expression is used in
    // SELECT and GROUP BY, and Postgres only matches the two when they are
    // textually identical (`$1` in one and `$4` in the other is a GROUP BY
    // error). riyadhToday() is always YYYY-MM-DD; checked anyway.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`unexpected date ${today}`);
    const expiredSql = sql`(${T.status} in ('draft', 'sent') and ${T.validUntil} is not null and ${T.validUntil} < ${sql.raw(`'${today}'`)}::date)`;
    const statuses = typeof rawQuery?.status === "string" && rawQuery.status.trim()
      ? rawQuery.status.split(",").map((s: string) => s.trim()).filter(Boolean) : [];
    if (statuses.length) {
      const parts: any[] = [];
      const stored = statuses.filter((s: string) => s !== "expired");
      if (stored.length) {
        // A stored draft/sent offer past its date is "expired", not draft/sent.
        parts.push(and(inArray(T.status, stored), sql`not ${expiredSql}`));
      }
      if (statuses.includes("expired")) parts.push(expiredSql);
      conds.push(or(...parts));
    }
    const where = and(...conds);

    let rowsQ = this.db.select().from(T).where(where).orderBy(desc(T.createdAt), desc(T.id)).$dynamic();
    if (paged) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const effectiveSql = sql<string>`case when ${expiredSql} then 'expired' else ${T.status} end`;
    const [rows, totalRow, statusRows] = await Promise.all([
      rowsQ,
      paged ? this.db.select({ total: count() }).from(T).where(where) : Promise.resolve([{ total: 0 }]),
      paged
        ? this.db.select({ status: effectiveSql, cnt: count() }).from(T).where(statsWhere).groupBy(effectiveSql)
        : Promise.resolve([]),
    ]);
    const data = (rows as RentalOffer[]).map((r) => withEffectiveStatus(r, today));
    if (!paged) return data;
    const byStatus: Record<string, number> = {};
    for (const r of statusRows as Array<{ status: string; cnt: number }>) byStatus[r.status] = Number(r.cnt);
    return {
      data, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0),
      stats: { byStatus, total: Object.values(byStatus).reduce((s, n) => s + n, 0) },
    };
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.CAMPAIGNS_VIEW)
  async get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return withEffectiveStatus(await this.load(user, id));
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CAMPAIGNS_WRITE)
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    const values = normalizeOffer(body, false);
    // An offer is always for one of the account's units — no free-typed space.
    if (body?.unitId === undefined || body?.unitId === null || body?.unitId === "") {
      throw new BadRequestException("اختر الوحدة المعروضة · Choose the unit being offered");
    }
    const link = await this.resolveUnit(user, body?.unitId);
    const status = (values.status as string | undefined) ?? "draft";
    return withEffectiveStatus(await this.insertNumbered(scopeId(user), {
      ...values,
      ...link,
      status,
      ...statusStamps(status),
      createdBy: user.id,
    }));
  }

  /** A copy as a fresh draft with a new number — the usual way to re-quote. */
  @Post(":id/duplicate")
  @RequirePermissions(PERMISSIONS.CAMPAIGNS_WRITE)
  async duplicate(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const src = await this.load(user, id);
    const { id: _id, number: _n, createdAt: _c, updatedAt: _u, sentAt: _s, decidedAt: _d, deletedAt: _x, ...rest } = src;
    return withEffectiveStatus(await this.insertNumbered(scopeId(user), {
      ...rest,
      status: "draft",
      issueDate: riyadhToday(),
      createdBy: user.id,
    }));
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.CAMPAIGNS_WRITE)
  async update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    const prev = await this.load(user, id);
    const values: Record<string, unknown> = normalizeOffer(body, true);
    if (body?.unitId !== undefined) {
      if (body.unitId === null || body.unitId === "") throw new BadRequestException("اختر الوحدة المعروضة · Choose the unit being offered");
      Object.assign(values, await this.resolveUnit(user, body.unitId));
    }
    if (Object.keys(values).length === 0) throw new BadRequestException("لا توجد بيانات للتحديث · Nothing to update");
    if (values.status !== undefined && values.status !== prev.status) Object.assign(values, statusStamps(values.status, prev));
    const [row] = await this.db.update(rentalOffersTable).set(values as any)
      .where(and(eq(rentalOffersTable.id, prev.id), eq(rentalOffersTable.userId, scopeId(user)), isNull(rentalOffersTable.deletedAt)))
      .returning();
    if (!row) throw new NotFoundException("العرض غير موجود · Offer not found");
    return withEffectiveStatus(row);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.CAMPAIGNS_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const oid = parseInt(id, 10);
    if (!Number.isInteger(oid) || oid <= 0) throw new NotFoundException("العرض غير موجود · Offer not found");
    await this.db.update(rentalOffersTable).set({ deletedAt: new Date() } as any)
      .where(and(eq(rentalOffersTable.id, oid), eq(rentalOffersTable.userId, scopeId(user)), isNull(rentalOffersTable.deletedAt)));
    return { ok: true };
  }

  private async load(user: AuthUser, id: string): Promise<RentalOffer> {
    const oid = parseInt(id, 10);
    if (!Number.isInteger(oid) || oid <= 0) throw new NotFoundException("العرض غير موجود · Offer not found");
    const [row] = await this.db.select().from(rentalOffersTable)
      .where(and(eq(rentalOffersTable.id, oid), eq(rentalOffersTable.userId, scopeId(user)), isNull(rentalOffersTable.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException("العرض غير موجود · Offer not found");
    return row as RentalOffer;
  }

  /**
   * The linked unit must belong to the caller's account (through its
   * property). The property is taken from the unit, never from the body.
   * `null` / "" unlinks — an offer may describe space that is not a unit yet.
   */
  private async resolveUnit(user: AuthUser, raw: unknown): Promise<{ unitId: number | null; propertyId: number | null }> {
    if (raw === undefined || raw === null || raw === "") return { unitId: null, propertyId: null };
    const uid = Number(raw);
    if (!Number.isInteger(uid) || uid <= 0) throw new BadRequestException("الوحدة غير صالحة · Invalid unit");
    const [u] = await this.db.select({ id: unitsTable.id, propertyId: unitsTable.propertyId })
      .from(unitsTable)
      .innerJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
      .where(and(eq(unitsTable.id, uid), eq(propertiesTable.userId, scopeId(user))))
      .limit(1);
    if (!u) throw new BadRequestException("الوحدة غير موجودة · Unit not found");
    return { unitId: u.id, propertyId: u.propertyId };
  }

  /**
   * Insert with the account's next `RO-<year>-NNNN`. Numbers are never reused
   * (deleted rows still hold theirs), and two concurrent creates race on the
   * unique (user_id, number) index — the loser retries with the next number.
   */
  private async insertNumbered(accountId: number, values: Record<string, unknown>): Promise<RentalOffer> {
    const year = Number(riyadhToday().slice(0, 4));
    const prefix = offerPrefix(year);
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await this.db.select({ number: rentalOffersTable.number }).from(rentalOffersTable)
        .where(and(eq(rentalOffersTable.userId, accountId), like(rentalOffersTable.number, `${prefix}%`)));
      const next = (existing as Array<{ number: string }>).reduce((m, r) => Math.max(m, offerSeq(r.number, prefix)), 0) + 1 + attempt;
      try {
        const [row] = await this.db.insert(rentalOffersTable)
          .values({ ...values, userId: accountId, number: formatOfferNumber(year, next) } as any)
          .returning();
        return row as RentalOffer;
      } catch (err: any) {
        if (err?.code !== "23505" && err?.cause?.code !== "23505") throw err;
      }
    }
    throw new BadRequestException("تعذّر إصدار رقم للعرض، حاول مجدداً · Could not allocate an offer number, try again");
  }
}

@Module({ controllers: [RentalOffersController] })
export class RentalOffersModule {}
