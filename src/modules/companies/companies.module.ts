import { BadRequestException, Body, Controller, Get, Inject, Module, NotFoundException, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { and, eq, isNull } from "drizzle-orm";
import { companiesTable, usersTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";

class CompanyDto {
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(80)  commercialReg?: string;
  @IsOptional() @IsString() @MaxLength(40)  vatNumber?: string;
  @IsOptional() @IsString() @MaxLength(40)  taxNumber?: string;
  @IsOptional() @IsString() @MaxLength(200) officialEmail?: string;
  @IsOptional() @IsString() @MaxLength(40)  companyPhone?: string;
  @IsOptional() @IsString() @MaxLength(200) website?: string;
  @IsOptional() @IsString() @MaxLength(80)  city?: string;
  @IsOptional() @IsString() @MaxLength(80)  region?: string;
  @IsOptional() @IsString() @MaxLength(80)  district?: string;
  @IsOptional() @IsString() @MaxLength(120) street?: string;
  @IsOptional() @IsString() @MaxLength(20)  buildingNumber?: string;
  @IsOptional() @IsString() @MaxLength(20)  postalCode?: string;
  @IsOptional() @IsString() @MaxLength(20)  additionalNumber?: string;
  @IsOptional() @IsString() @MaxLength(400) address?: string;
  /** MinIO object key from the uploads service. NEVER store a public URL here. */
  @IsOptional() @IsString() @MaxLength(400) logoKey?: string;
  @IsOptional() @IsString() @MaxLength(2000) bio?: string;
}

const COMPANY_FIELDS = [
  "name", "commercialReg", "vatNumber", "taxNumber", "officialEmail", "companyPhone",
  "website", "city", "region", "district", "street", "buildingNumber",
  "postalCode", "additionalNumber", "address", "logoKey", "bio",
] as const;

/**
 * Each top-level user (landlord/admin) is linked to exactly one company.
 * Employees inherit their owning user's company via the FK chain. The
 * controller always operates on `scopeId(user)` so an employee editing
 * "their" company actually edits the parent's company.
 */
@ApiTags("companies")
@ApiBearerAuth("user-jwt")
@Controller("companies")
@UseGuards(JwtAuthGuard)
class CompaniesController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /** Read the company linked to the current user (or its parent for employees). */
  @Get("me")
  async myCompany(@CurrentUser() user: AuthUser) {
    const ownerId = scopeId(user);
    const [owner] = await this.db
      .select({ companyId: usersTable.companyId })
      .from(usersTable)
      .where(and(eq(usersTable.id, ownerId), isNull(usersTable.deletedAt)));
    if (!owner?.companyId) return null;
    const [c] = await this.db
      .select()
      .from(companiesTable)
      .where(and(eq(companiesTable.id, owner.companyId), isNull(companiesTable.deletedAt)));
    return c ?? null;
  }

  /**
   * Create a company for the current user when they don't have one yet.
   * Idempotent for the "already linked" case — returns the existing company.
   */
  @Post("me")
  async createMyCompany(@CurrentUser() user: AuthUser, @Body() body: CompanyDto) {
    const ownerId = scopeId(user);
    const [owner] = await this.db.select().from(usersTable).where(and(eq(usersTable.id, ownerId), isNull(usersTable.deletedAt)));
    if (!owner) throw new NotFoundException("user not found");

    if (owner.companyId) {
      const [existing] = await this.db.select().from(companiesTable).where(eq(companiesTable.id, owner.companyId));
      if (existing) return existing;
    }

    if (!body.name?.trim()) throw new BadRequestException("اسم الشركة مطلوب");
    const values: Record<string, unknown> = {};
    for (const f of COMPANY_FIELDS) if ((body as any)[f] !== undefined) values[f] = (body as any)[f];

    const [row] = await this.db.insert(companiesTable).values(values as any).returning();
    await this.db.update(usersTable).set({ companyId: row!.id }).where(eq(usersTable.id, ownerId));
    return row;
  }

  /** Update fields of the company that the current user is linked to. */
  @Patch("me")
  async updateMyCompany(@CurrentUser() user: AuthUser, @Body() body: Partial<CompanyDto>) {
    const ownerId = scopeId(user);
    const [owner] = await this.db.select({ companyId: usersTable.companyId }).from(usersTable).where(eq(usersTable.id, ownerId));
    if (!owner?.companyId) throw new NotFoundException("لا توجد شركة مرتبطة بهذا المستخدم. أنشئها أولاً عبر POST /companies/me.");

    const updateData: Record<string, unknown> = {};
    for (const f of COMPANY_FIELDS) if ((body as any)[f] !== undefined) updateData[f] = (body as any)[f];
    if (Object.keys(updateData).length === 0) throw new BadRequestException("لا توجد حقول للتحديث");

    const [row] = await this.db
      .update(companiesTable)
      .set(updateData)
      .where(and(eq(companiesTable.id, owner.companyId), isNull(companiesTable.deletedAt)))
      .returning();
    if (!row) throw new NotFoundException("الشركة غير موجودة");
    return row;
  }
}

@Module({ controllers: [CompaniesController] })
export class CompaniesModule {}
