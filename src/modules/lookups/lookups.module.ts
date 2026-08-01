import { Body, Controller, Get, Inject, Module, Post, Patch, Delete, Param, Query, BadRequestException, NotFoundException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, or, isNull, asc } from "drizzle-orm";
import { lookupsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";

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

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query("category") category?: string) {
    const companyId = user.companyId ?? null;
    const scope = companyId != null
      ? or(isNull(lookupsTable.companyId), eq(lookupsTable.companyId, companyId))
      : isNull(lookupsTable.companyId);
    const where = category
      ? and(eq(lookupsTable.category, category), eq(lookupsTable.isActive, true), scope)
      : and(eq(lookupsTable.isActive, true), scope);

    const rows = await this.db.select({
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
      .orderBy(asc(lookupsTable.category), asc(lookupsTable.sortOrder), asc(lookupsTable.id));

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
