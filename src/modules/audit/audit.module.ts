import {
  CallHandler, Controller, ExecutionContext, ForbiddenException, Get, Inject,
  Injectable, Module, NestInterceptor, Query, UseGuards,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import type { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { and, desc, eq } from "drizzle-orm";
import { auditLogsTable, usersTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";

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

  /** The account's audit trail — own + employees' update/delete actions. */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query("limit") limitQ?: string) {
    if (user.ownerUserId) throw new ForbiddenException("Only the account owner can view the audit log");
    const limit = Math.min(500, Math.max(1, parseInt(limitQ ?? "200", 10) || 200));
    return this.db
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
      .where(and(eq(auditLogsTable.ownerUserId, user.id)))
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(limit);
  }
}

@Module({
  controllers: [AuditController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AuditModule {}
