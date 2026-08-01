import { Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Patch, Post, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, isNull } from "drizzle-orm";
import { campaignsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";

const FIELDS = ["name", "targetUnits", "channel", "budget", "leads", "conversions", "status", "startDate", "endDate", "notes"] as const;

@ApiTags("campaigns")
@ApiBearerAuth("user-jwt")
@Controller("campaigns")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class CampaignsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CAMPAIGNS_VIEW)
  list(@CurrentUser() user: AuthUser) {
    return this.db.select().from(campaignsTable).where(and(eq(campaignsTable.userId, scopeId(user)), isNull(campaignsTable.deletedAt))).orderBy(campaignsTable.createdAt);
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
      status: body.status || "نشطة",
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
    for (const f of FIELDS) if (body[f] !== undefined) updateData[f] = body[f];
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
