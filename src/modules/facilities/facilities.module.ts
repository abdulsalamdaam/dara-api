import { Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Patch, Post, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, isNull } from "drizzle-orm";
import { facilitiesTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";

const FIELDS = ["name", "propertyName", "type", "status", "lastMaintenance", "nextMaintenance", "monthlyOpex", "notes"] as const;

@ApiTags("facilities")
@ApiBearerAuth("user-jwt")
@Controller("facilities")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class FacilitiesController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  @Get()
  @RequirePermissions(PERMISSIONS.FACILITIES_VIEW)
  list(@CurrentUser() user: AuthUser) {
    return this.db.select().from(facilitiesTable).where(and(eq(facilitiesTable.userId, scopeId(user)), isNull(facilitiesTable.deletedAt))).orderBy(facilitiesTable.createdAt);
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
