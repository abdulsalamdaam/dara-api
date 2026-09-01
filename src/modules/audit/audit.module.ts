import {
  CallHandler, Controller, ExecutionContext, ForbiddenException, Get, Inject,
  Injectable, Module, NestInterceptor, Query, UseGuards,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import type { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or } from "drizzle-orm";
import { auditLogsTable, usersTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import {
  listQuerySchema, parseDateBound, parseEnumList, parseIdList, wantsPagination,
} from "../../common/pagination";

/**
 * Records every successful update/delete request in `audit_logs`, so an
 * owner can review what their employees changed. One global interceptor
 * covers all modules — no per-controller wiring needed.
 */
@Injectable()
class AuditInterceptor implements NestInterceptor {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const method: string = req?.method ?? "";
    return next.handle().pipe(tap(() => {
      if (method !== "PATCH" && method !== "PUT" && method !== "DELETE") return;
      const user = req?.user as AuthUser | undefined;
      if (!user?.id) return; // unauthenticated / tenant routes — skip
      const url: string = String(req.originalUrl ?? req.url ?? "").split("?")[0];
      if (url.includes("/audit")) return;
      const parts = url.replace(/^\/api\//, "").replace(/^\//, "").split("/").filter(Boolean);
      const entity = parts[0] || "unknown";
      const entityId = [...parts].reverse().find((p) => /^\d+$/.test(p)) ?? null;
      // Fire-and-forget — auditing must never break or slow the response.
      this.db.insert(auditLogsTable).values({
        ownerUserId: user.ownerUserId ?? user.id,
        actorUserId: user.id,
        action: method === "DELETE" ? "delete" : "update",
        entity,
        entityId,
        method,
        path: url,
      }).catch((e) => console.error("[audit] log failed:", e));
    }));
  }
}

@ApiTags("audit")
@ApiBearerAuth("user-jwt")
@Controller("audit")
@UseGuards(JwtAuthGuard)
class AuditController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /**
   * The account's audit trail - own + employees' update/delete actions.
   *
   * This is the one list where "just take the newest 200" is most obviously
   * not enough: an audit trail exists to be searched backwards, and a capped
   * query answers every question about last month with silence. Filters are
   * therefore all applied in SQL - `search` (entity / path / actor name or
   * email), `entity`, `action` (update|delete), `actorId`, and a `from`/`to`
   * date window - and pagination walks the whole history rather than a cap.
   *
   * The legacy `limit` parameter still works and still returns a bare array,
   * so the existing settings screen is untouched; sending `page`/`pageSize`/
   * `paginated` switches to `{ data, page, pageSize, total }`.
   */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    if (user.ownerUserId) throw new ForbiddenException("Only the account owner can view the audit log");
    const paged = wantsPagination(rawQuery, ["search", "entity", "action", "actorId", "from", "to"]);
    const q = listQuerySchema.parse(rawQuery ?? {});

    const conds: any[] = [eq(auditLogsTable.ownerUserId, user.id)];
    if (q.search) {
      conds.push(or(
        ilike(auditLogsTable.entity, `%${q.search}%`),
        ilike(auditLogsTable.path, `%${q.search}%`),
        ilike(auditLogsTable.entityId, `%${q.search}%`),
        ilike(usersTable.name, `%${q.search}%`),
        ilike(usersTable.email, `%${q.search}%`),
      ));
    }
    const entities = typeof rawQuery?.entity === "string" && rawQuery.entity.trim()
      ? rawQuery.entity.split(",").map((x: string) => x.trim()).filter(Boolean) : undefined;
    if (entities?.length) conds.push(inArray(auditLogsTable.entity, entities));
    const actions = parseEnumList(rawQuery?.action, ["update", "delete"] as const);
    if (actions) conds.push(inArray(auditLogsTable.action, actions));
    const actorIds = parseIdList(rawQuery?.actorId) ?? parseIdList(rawQuery?.actorIds);
    if (actorIds) conds.push(inArray(auditLogsTable.actorUserId, actorIds));
    const from = parseDateBound(rawQuery?.from);
    const to = parseDateBound(rawQuery?.to);
    if (from) conds.push(gte(auditLogsTable.createdAt, new Date(`${from}T00:00:00.000Z`)));
    if (to) conds.push(lte(auditLogsTable.createdAt, new Date(`${to}T23:59:59.999Z`)));
    const where = and(...conds);

    const dir = q.order === "asc" ? asc : desc;
    let rowsQ = this.db
      .select({
        id: auditLogsTable.id,
        action: auditLogsTable.action,
        entity: auditLogsTable.entity,
        entityId: auditLogsTable.entityId,
        method: auditLogsTable.method,
        path: auditLogsTable.path,
        createdAt: auditLogsTable.createdAt,
        actorId: auditLogsTable.actorUserId,
        actorName: usersTable.name,
        actorEmail: usersTable.email,
      })
      .from(auditLogsTable)
      .leftJoin(usersTable, eq(auditLogsTable.actorUserId, usersTable.id))
      .where(where)
      // `id` tiebreak - one request can write several audit rows in the same
      // instant, and without it those rows shuffle between page requests.
      .orderBy(dir(auditLogsTable.createdAt), dir(auditLogsTable.id))
      .$dynamic();

    if (!paged) {
      // Legacy shape: `?limit=` (default 200, hard cap 500) returning an array.
      const limit = Math.min(500, Math.max(1, parseInt(rawQuery?.limit ?? "200", 10) || 200));
      return rowsQ.limit(limit);
    }

    const [rows, totalRow] = await Promise.all([
      rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize),
      // Same join in the count - `search` reaches the actor's name through it.
      this.db.select({ total: count() })
        .from(auditLogsTable)
        .leftJoin(usersTable, eq(auditLogsTable.actorUserId, usersTable.id))
        .where(where),
    ]);
    return { data: rows, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0) };
  }
}

@Module({
  controllers: [AuditController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AuditModule {}
