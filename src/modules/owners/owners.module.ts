import { Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, ne, isNull, or, ilike, count, asc, desc } from "drizzle-orm";
import { ownersTable, contractsTable, ownerNotificationsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { assertNationalAddress } from "../../common/national-address";
import { scopeId } from "../../common/scope";
import { listQuerySchema } from "../../common/pagination";
import { assertWithinQuota } from "../../common/quota";
import { EmailService } from "../email/email.service";
import { sendExpoPush } from "../../common/push";
import { IsInt, IsString, IsNotEmpty, IsOptional } from "class-validator";
import { Type } from "class-transformer";

/** An owner's effective contact applies the representative (وكيل) precedence:
 *  when isRepresentative is true the original-owner fields hold the real
 *  contact, so messaging must use those. */
function effectiveOwnerContact(o: { isRepresentative: boolean; email: string | null; phone: string | null; originalOwnerEmail: string | null; originalOwnerPhone: string | null; }) {
  return {
    email: o.isRepresentative ? o.originalOwnerEmail : o.email,
    phone: o.isRepresentative ? o.originalOwnerPhone : o.phone,
  };
}

const FIELDS = [
  "name", "shortName", "type", "status", "idNumber", "phone", "email", "iban",
  "managementFeePercent", "taxNumber", "address",
  "postalCode", "additionalNumber", "buildingNumber", "notes",
  // Representative (وكيل) fields — added in Phase 4 of the asset-tree redesign.
  "isRepresentative", "representativeDocUrl",
  "originalOwnerName", "originalOwnerIdNumber", "originalOwnerPhone", "originalOwnerEmail",
  // Structured national address (العنوان الوطني). The legacy free-text `address`
  // column is still updatable above for backwards compat.
  "nationalAddressCity", "nationalAddressDistrict", "nationalAddressStreet",
  "isDraft",
  // Default landlord — newly-created properties auto-link to this one.
  "isDefault",
] as const;

@ApiTags("owners")
@ApiBearerAuth("user-jwt")
@Controller("owners")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class OwnersController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly email: EmailService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.OWNERS_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const usePaginated = rawQuery && (rawQuery.page != null || rawQuery.pageSize != null || rawQuery.search != null);
    const q = listQuerySchema.parse(rawQuery ?? {});
    const owner = scopeId(user);

    const baseWhere = and(eq(ownersTable.userId, owner), isNull(ownersTable.deletedAt));
    const where = q.search
      ? and(baseWhere, or(
          ilike(ownersTable.name, `%${q.search}%`),
          ilike(ownersTable.idNumber, `%${q.search}%`),
          ilike(ownersTable.phone, `%${q.search}%`),
          ilike(ownersTable.email, `%${q.search}%`),
        ))
      : baseWhere;

    const sortFn = q.order === "asc" ? asc : desc;
    let rowsQ = this.db.select().from(ownersTable).where(where).orderBy(sortFn(ownersTable.createdAt)).$dynamic();
    if (usePaginated) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow] = await Promise.all([
      rowsQ,
      usePaginated
        ? this.db.select({ total: count() }).from(ownersTable).where(where)
        : Promise.resolve([{ total: 0 }]),
    ]);
    if (!usePaginated) return rows;
    return { data: rows, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.OWNERS_WRITE)
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    if (!body.name) throw new BadRequestException("الاسم مطلوب");
    assertNationalAddress(body);
    // Enforce the subscription package's landlord quota.
    await assertWithinQuota(this.db, scopeId(user), "landlords");
    const wantsDefault = Boolean(body.isDefault ?? false);
    // Only one default landlord per account: clear any existing flag before
    // inserting the new default so the partial unique index never clashes.
    if (wantsDefault) {
      await this.db.update(ownersTable).set({ isDefault: false })
        .where(and(eq(ownersTable.userId, scopeId(user)), eq(ownersTable.isDefault, true)));
    }
    const [owner] = await this.db.insert(ownersTable).values({
      userId: scopeId(user),
      name: body.name,
      shortName: body.shortName ?? null,
      type: body.type || "individual",
      idNumber: body.idNumber ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      iban: body.iban ?? null,
      managementFeePercent: body.managementFeePercent ? String(body.managementFeePercent) : null,
      taxNumber: body.taxNumber ?? null,
      address: body.address ?? null,
      postalCode: body.postalCode ?? null,
      additionalNumber: body.additionalNumber ?? null,
      buildingNumber: body.buildingNumber ?? null,
      notes: body.notes ?? null,
      // Representative + national-address columns (Phase 4). All nullable
      // except isRepresentative, which defaults to false.
      isRepresentative: Boolean(body.isRepresentative ?? false),
      representativeDocUrl: body.representativeDocUrl ?? null,
      originalOwnerName: body.originalOwnerName ?? null,
      originalOwnerIdNumber: body.originalOwnerIdNumber ?? null,
      originalOwnerPhone: body.originalOwnerPhone ?? null,
      originalOwnerEmail: body.originalOwnerEmail ?? null,
      nationalAddressCity: body.nationalAddressCity ?? null,
      nationalAddressDistrict: body.nationalAddressDistrict ?? null,
      nationalAddressStreet: body.nationalAddressStreet ?? null,
      isDraft: Boolean(body.isDraft ?? false),
      isDefault: wantsDefault,
      isDemo: "false",
    }).returning();
    return owner;
  }

  /** Email the landlord a nudge to download the mobile app. Uses the
   *  representative-aware effective email. */
  @Post(":id/app-reminder")
  @RequirePermissions(PERMISSIONS.OWNERS_WRITE)
  async appReminder(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const oid = parseInt(id, 10);
    const [owner] = await this.db.select().from(ownersTable)
      .where(and(eq(ownersTable.id, oid), eq(ownersTable.userId, scopeId(user)), isNull(ownersTable.deletedAt)));
    if (!owner) throw new NotFoundException("غير موجود");
    const { email } = effectiveOwnerContact(owner);
    if (!email) throw new BadRequestException("لا يوجد بريد إلكتروني لهذا المؤجر · This landlord has no email on file");
    const sent = await this.email.sendAppDownloadReminder(email, owner.name);
    return { sent };
  }

  @Patch(":ownerId")
  @RequirePermissions(PERMISSIONS.OWNERS_WRITE)
  async update(@CurrentUser() user: AuthUser, @Param("ownerId") ownerId: string, @Body() body: any) {
    const id = parseInt(ownerId, 10);
    const [prior] = await this.db.select({ name: ownersTable.name }).from(ownersTable)
      .where(and(eq(ownersTable.id, id), eq(ownersTable.userId, scopeId(user)), isNull(ownersTable.deletedAt)));
    const updateData: Record<string, unknown> = {};
    for (const f of FIELDS) if (body[f] !== undefined) updateData[f] = body[f];
    // Promoting this landlord to default? Clear the flag on every other row
    // first (single default per account) so the target update can't clash.
    if (body.isDefault === true) {
      await this.db.update(ownersTable).set({ isDefault: false })
        .where(and(eq(ownersTable.userId, scopeId(user)), eq(ownersTable.isDefault, true), ne(ownersTable.id, id)));
    }
    const [owner] = await this.db.update(ownersTable).set(updateData)
      .where(and(eq(ownersTable.id, id), eq(ownersTable.userId, scopeId(user)), isNull(ownersTable.deletedAt)))
      .returning();
    if (!owner) throw new NotFoundException("Owner not found");

    // Propagate a renamed landlord to the contract snapshots. Contracts have no
    // direct landlord FK (the name is captured from the property's owner at
    // creation), so we match the previous name within the account.
    if (body.name !== undefined && prior?.name && owner.name !== prior.name) {
      await this.db.update(contractsTable).set({ landlordName: owner.name })
        .where(and(eq(contractsTable.landlordName, prior.name), eq(contractsTable.userId, scopeId(user))));
    }
    return owner;
  }

  @Delete(":ownerId")
  @RequirePermissions(PERMISSIONS.OWNERS_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param("ownerId") ownerId: string) {
    const id = parseInt(ownerId, 10);
    const [target] = await this.db.select({ isDefault: ownersTable.isDefault }).from(ownersTable)
      .where(and(eq(ownersTable.id, id), eq(ownersTable.userId, scopeId(user)), isNull(ownersTable.deletedAt)));
    if (!target) throw new NotFoundException("Landlord not found");
    // The default landlord (and the sole landlord) represent the account
    // holder — they can't be deleted.
    const [{ cnt }] = await this.db.select({ cnt: count() }).from(ownersTable)
      .where(and(eq(ownersTable.userId, scopeId(user)), isNull(ownersTable.deletedAt)));
    if (target.isDefault || Number(cnt) <= 1) {
      throw new BadRequestException("لا يمكن حذف حساب المؤجر الذي يمثّل حسابك. يمكنك تعيين مؤجر افتراضي آخر أو إضافة مؤجر آخر أولاً.");
    }
    await this.db.update(ownersTable).set({ deletedAt: new Date() } as any)
      .where(and(eq(ownersTable.id, id), eq(ownersTable.userId, scopeId(user)), isNull(ownersTable.deletedAt)));
    return { success: true };
  }
}

/* ─────────────── Send a notification to one of the account's landlords ─────────────── */

class SendOwnerNotificationDto {
  // Global ValidationPipe has whitelist:true — every field must be decorated
  // or it gets stripped.
  @Type(() => Number)
  @IsInt()
  ownerId!: number;

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

@ApiTags("owner-notifications")
@ApiBearerAuth("user-jwt")
@Controller("owner-notifications")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class OwnerNotificationsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /** Notifications the account has sent to its landlords (newest first). */
  @Get()
  @RequirePermissions(PERMISSIONS.OWNERS_VIEW)
  async list(@CurrentUser() user: AuthUser) {
    return this.db
      .select({
        id: ownerNotificationsTable.id,
        ownerId: ownerNotificationsTable.ownerId,
        title: ownerNotificationsTable.title,
        body: ownerNotificationsTable.body,
        type: ownerNotificationsTable.type,
        readAt: ownerNotificationsTable.readAt,
        createdAt: ownerNotificationsTable.createdAt,
        ownerName: ownersTable.name,
      })
      .from(ownerNotificationsTable)
      .leftJoin(ownersTable, eq(ownerNotificationsTable.ownerId, ownersTable.id))
      .where(and(
        eq(ownerNotificationsTable.userId, scopeId(user)),
        isNull(ownerNotificationsTable.deletedAt),
      ))
      .orderBy(desc(ownerNotificationsTable.createdAt));
  }

  /** Send a notification to one of the account's landlords. */
  @Post()
  @RequirePermissions(PERMISSIONS.OWNERS_WRITE)
  async send(@CurrentUser() user: AuthUser, @Body() body: SendOwnerNotificationDto) {
    const ownerId = Number(body?.ownerId);
    const title = body?.title?.toString().trim();
    const text = body?.body?.toString().trim();
    if (!ownerId || !title || !text) {
      throw new BadRequestException("المؤجر والعنوان والنص مطلوبة");
    }

    // The owner must belong to this account's scope.
    const [owner] = await this.db
      .select({ id: ownersTable.id, fcmToken: ownersTable.fcmToken })
      .from(ownersTable)
      .where(and(
        eq(ownersTable.id, ownerId),
        eq(ownersTable.userId, scopeId(user)),
        isNull(ownersTable.deletedAt),
      ));
    if (!owner) throw new NotFoundException("المؤجر غير موجود");

    const [row] = await this.db.insert(ownerNotificationsTable).values({
      userId: scopeId(user),
      ownerId,
      title,
      body: text,
      type: body?.type?.toString().trim() || "custom",
    }).returning();

    // Deliver an actual push to the landlord's device (fire-and-forget).
    if (owner.fcmToken) {
      void sendExpoPush([{
        to: owner.fcmToken,
        title,
        body: text,
        data: { type: row!.type, notificationId: row!.id },
      }]);
    }
    return { ...row, pushed: !!owner.fcmToken };
  }
}

@Module({ controllers: [OwnersController, OwnerNotificationsController] })
export class OwnersModule {}
