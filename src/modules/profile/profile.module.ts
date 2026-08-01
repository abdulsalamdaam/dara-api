import { Body, Controller, Get, Inject, Module, NotFoundException, Patch, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { eq } from "drizzle-orm";
import { companiesTable, rolesTable, usersTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";

/**
 * Profile module is now scoped to **user-level** identity fields only.
 * Company-level fields (legal name, VAT, logo, address, ...) live in their
 * own table and are managed via /api/companies/me. The legacy company-on-user
 * columns are preserved on the schema for the migration window but no longer
 * read or written from this controller.
 */
const USER_PROFILE_FIELDS = {
  id: usersTable.id,
  name: usersTable.name,
  email: usersTable.email,
  phone: usersTable.phone,
  companyId: usersTable.companyId,
  roleId: usersTable.roleId,
  ownerUserId: usersTable.ownerUserId,
  createdAt: usersTable.createdAt,
} as const;

const EDITABLE_USER_FIELDS = ["name", "phone"] as const;

@ApiTags("profile")
@ApiBearerAuth("user-jwt")
@Controller("profile")
@UseGuards(JwtAuthGuard)
class ProfileController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /**
   * Returns the user's own profile. Convenience: includes the linked company
   * (if any) and the resolved role label so the dashboard doesn't need an
   * extra round-trip to render the settings page.
   */
  @Get()
  async get(@CurrentUser() user: AuthUser) {
    const [u] = await this.db.select(USER_PROFILE_FIELDS).from(usersTable).where(eq(usersTable.id, user.id));
    if (!u) throw new NotFoundException("المستخدم غير موجود");

    const company = u.companyId
      ? (await this.db.select().from(companiesTable).where(eq(companiesTable.id, u.companyId)))[0] ?? null
      : null;
    const role = u.roleId
      ? (await this.db.select().from(rolesTable).where(eq(rolesTable.id, u.roleId)))[0] ?? null
      : null;
    // Employees (ownerUserId set) are linked to an owner/company account —
    // surface that account's name so the UI can show "linked to …".
    let linkedOwner: { id: number; name: string; companyName: string | null } | null = null;
    if (u.ownerUserId) {
      const [owner] = await this.db
        .select({ id: usersTable.id, name: usersTable.name, companyId: usersTable.companyId })
        .from(usersTable).where(eq(usersTable.id, u.ownerUserId));
      if (owner) {
        const companyName = owner.companyId
          ? (await this.db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, owner.companyId)))[0]?.name ?? null
          : null;
        linkedOwner = { id: owner.id, name: owner.name, companyName };
      }
    }
    return { ...u, company, role, linkedOwner };
  }

  @Patch()
  async update(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    const updateData: Record<string, unknown> = {};
    for (const k of EDITABLE_USER_FIELDS) {
      if (body[k] !== undefined) updateData[k] = body[k] === "" ? null : body[k];
    }
    if (Object.keys(updateData).length === 0) throw new BadRequestException("لا توجد بيانات للتحديث");
    const [u] = await this.db.update(usersTable).set(updateData).where(eq(usersTable.id, user.id)).returning(USER_PROFILE_FIELDS);
    return u;
  }
}

@Module({ controllers: [ProfileController] })
export class ProfileModule {}
