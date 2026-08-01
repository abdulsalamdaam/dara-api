import {
  BadRequestException, Body, Controller, Get, Inject, Module, NotFoundException,
  Param, Patch, Post, UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, desc, eq, isNull } from "drizzle-orm";
import { notificationsTable, tenantsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { TenantAuthGuard, type TenantPayload } from "../../common/guards/tenant-auth.guard";
import { CurrentTenant } from "../../common/decorators/current-tenant.decorator";
import { sendExpoPush } from "../../common/push";
import { IsInt, IsString, IsNotEmpty, IsOptional } from "class-validator";
import { Type } from "class-transformer";

/* ─────────────── Tenant side — read ─────────────── */

@ApiTags("tenant-portal")
@ApiBearerAuth("tenant-jwt")
@Controller("tenant/me/notifications")
@UseGuards(TenantAuthGuard)
export class TenantNotificationsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /** The tenant's notification inbox, newest first. */
  @Get()
  async list(@CurrentTenant() tenant: TenantPayload) {
    return this.db
      .select({
        id: notificationsTable.id,
        title: notificationsTable.title,
        body: notificationsTable.body,
        type: notificationsTable.type,
        readAt: notificationsTable.readAt,
        createdAt: notificationsTable.createdAt,
      })
      .from(notificationsTable)
      .where(and(
        eq(notificationsTable.tenantId, tenant.id),
        isNull(notificationsTable.deletedAt),
      ))
      .orderBy(desc(notificationsTable.createdAt));
  }

  /** Mark one notification as read. */
  @Patch(":id/read")
  async markRead(@CurrentTenant() tenant: TenantPayload, @Param("id") id: string) {
    const [row] = await this.db.update(notificationsTable)
      .set({ readAt: new Date() })
      .where(and(
        eq(notificationsTable.id, parseInt(id, 10)),
        eq(notificationsTable.tenantId, tenant.id),
        isNull(notificationsTable.readAt),
      ))
      .returning();
    return row ?? { ok: true };
  }

  /** Mark every unread notification as read. */
  @Post("read-all")
  async markAllRead(@CurrentTenant() tenant: TenantPayload) {
    await this.db.update(notificationsTable)
      .set({ readAt: new Date() })
      .where(and(
        eq(notificationsTable.tenantId, tenant.id),
        isNull(notificationsTable.readAt),
      ));
    return { ok: true };
  }
}

/* ─────────────── Landlord side — send ─────────────── */

class SendNotificationDto {
  // Global ValidationPipe has whitelist:true — every field must be decorated
  // or it gets stripped (which previously left the body empty → 400).
  @Type(() => Number)
  @IsInt()
  tenantId!: number;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsNotEmpty()
  body!: string;

  @IsOptional()
  @IsString()
  type?: string;
}

@ApiTags("notifications")
@ApiBearerAuth("user-jwt")
@Controller("notifications")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class NotificationsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /** Notifications the landlord has sent (newest first). */
  @Get()
  @RequirePermissions(PERMISSIONS.TENANTS_VIEW)
  async list(@CurrentUser() user: AuthUser) {
    return this.db
      .select({
        id: notificationsTable.id,
        tenantId: notificationsTable.tenantId,
        title: notificationsTable.title,
        body: notificationsTable.body,
        type: notificationsTable.type,
        readAt: notificationsTable.readAt,
        createdAt: notificationsTable.createdAt,
        tenantName: tenantsTable.name,
      })
      .from(notificationsTable)
      .leftJoin(tenantsTable, eq(notificationsTable.tenantId, tenantsTable.id))
      .where(and(
        eq(notificationsTable.userId, scopeId(user)),
        isNull(notificationsTable.deletedAt),
      ))
      .orderBy(desc(notificationsTable.createdAt));
  }

  /** Send a notification to one of the landlord's tenants. */
  @Post()
  @RequirePermissions(PERMISSIONS.TENANTS_WRITE)
  async send(@CurrentUser() user: AuthUser, @Body() body: SendNotificationDto) {
    const tenantId = Number(body?.tenantId);
    const title = body?.title?.toString().trim();
    const text = body?.body?.toString().trim();
    if (!tenantId || !title || !text) {
      throw new BadRequestException("المستأجر والعنوان والنص مطلوبة");
    }

    // The tenant must belong to this landlord's scope.
    const [tenant] = await this.db
      .select({ id: tenantsTable.id, fcmToken: tenantsTable.fcmToken })
      .from(tenantsTable)
      .where(and(
        eq(tenantsTable.id, tenantId),
        eq(tenantsTable.userId, scopeId(user)),
        isNull(tenantsTable.deletedAt),
      ));
    if (!tenant) throw new NotFoundException("المستأجر غير موجود");

    const [row] = await this.db.insert(notificationsTable).values({
      userId: scopeId(user),
      tenantId,
      title,
      body: text,
      type: body?.type?.toString().trim() || "custom",
    }).returning();

    // Deliver an actual push to the tenant's device (fire-and-forget).
    if (tenant.fcmToken) {
      void sendExpoPush([{
        to: tenant.fcmToken,
        title,
        body: text,
        data: { type: row!.type, notificationId: row!.id },
      }]);
    }
    return { ...row, pushed: !!tenant.fcmToken };
  }
}

@Module({
  controllers: [TenantNotificationsController, NotificationsController],
})
export class NotificationsModule {}
