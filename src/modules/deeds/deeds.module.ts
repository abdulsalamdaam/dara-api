import {
  Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param,
  Patch, Post, BadRequestException, ConflictException, UseGuards, Query,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, isNull, desc, asc, ilike, or, sql, count } from "drizzle-orm";
import { z } from "zod/v4";
import { deedsTable, propertiesTable } from "@dara/database";
import { attachLookupLabels } from "../../common/lookups-resolve";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";

/**
 * Deeds (الصكوك) — property title documents.
 *
 * Top of the hierarchy: Deed → Property → Unit → Contract.
 * Each deed legally backs at most one property (1:1, enforced via the
 * unique index on properties.deed_id in the schema). Soft-deletes follow
 * the same convention as the rest of the codebase.
 */

const deedCreateSchema = z.object({
  deedNumber: z.string().trim().min(1, "رقم الصك مطلوب · Deed number is required"),
  // "electronic" | "paper" | any custom ("Other") value the user types.
  deedType: z.string().trim().min(1).default("electronic"),
  // documentUrl holds either a full URL or — most often — the MinIO object
  // key returned by FileUpload (e.g. "deeds/123/abc.pdf"). Both are valid
  // payloads. We don't enforce .url() here because object keys aren't URLs.
  documentUrl: z.string().trim().min(1).optional().nullable(),
  documentName: z.string().trim().optional().nullable(),
  ownerId: z.coerce.number().int().positive().max(2147483647).optional().nullable(),
  ownerNationalId: z.string().trim().optional().nullable(),
  // Co-owners named on the deed document. Optional; a row with no name is
  // dropped so an empty form line never persists as a blank owner.
  deedOwners: z
    .array(z.object({
      name: z.string().trim().min(1),
      idNumber: z.string().trim().optional().nullable(),
    }))
    .optional()
    .nullable()
    .transform((v) => (v == null ? v : v.filter((o) => o.name.trim() !== ""))),
  issueDate: z.coerce.date().optional().nullable(),
  issueDateHijri: z.string().trim().optional().nullable(),
  copyDate: z.coerce.date().optional().nullable(),
  registryNumber: z.string().trim().optional().nullable(),
  issuingAuthority: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
});
type DeedCreateInput = z.infer<typeof deedCreateSchema>;

const deedUpdateSchema = deedCreateSchema.partial();

/** Pagination + search query params shared with the rest of the API. */
const listQuerySchema = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  search:   z.string().trim().optional(),
  sort:     z.enum(["createdAt", "deedNumber", "deedType"]).default("createdAt"),
  order:    z.enum(["asc", "desc"]).default("desc"),
});

@ApiTags("deeds")
@ApiBearerAuth("user-jwt")
@Controller("deeds")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class DeedsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  @Get()
  @RequirePermissions(PERMISSIONS.DEEDS_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const q = listQuerySchema.parse(rawQuery);
    const owner = scopeId(user);

    const baseWhere = and(eq(deedsTable.userId, owner), isNull(deedsTable.deletedAt));
    const where = q.search
      ? and(baseWhere, or(
          ilike(deedsTable.deedNumber, `%${q.search}%`),
          ilike(deedsTable.issuingAuthority, `%${q.search}%`),
          ilike(deedsTable.notes, `%${q.search}%`),
        ))
      : baseWhere;

    const sortCol = q.sort === "deedNumber" ? deedsTable.deedNumber
                  : q.sort === "deedType"   ? deedsTable.deedType
                  : deedsTable.createdAt;
    const sortFn = q.order === "asc" ? asc : desc;

    const [rows, [{ total }]] = await Promise.all([
      this.db.select({
        id: deedsTable.id,
        deedNumber: deedsTable.deedNumber,
        deedType: deedsTable.deedType,
        documentUrl: deedsTable.documentUrl,
        documentName: deedsTable.documentName,
        ownerId: deedsTable.ownerId,
        ownerNationalId: deedsTable.ownerNationalId,
        issueDate: deedsTable.issueDate,
        issueDateHijri: deedsTable.issueDateHijri,
        copyDate: deedsTable.copyDate,
        registryNumber: deedsTable.registryNumber,
        issuingAuthority: deedsTable.issuingAuthority,
        notes: deedsTable.notes,
        createdAt: deedsTable.createdAt,
        // Inline the linked property (1:1) so the table can render it without
        // an N+1 round-trip per row.
        propertyId: propertiesTable.id,
        propertyName: propertiesTable.name,
      })
      .from(deedsTable)
      .leftJoin(propertiesTable, and(eq(propertiesTable.deedId, deedsTable.id), isNull(propertiesTable.deletedAt)))
      .where(where)
      .orderBy(sortFn(sortCol))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),

      this.db.select({ total: count() }).from(deedsTable).where(where),
    ]);

    return { data: rows, page: q.page, pageSize: q.pageSize, total: Number(total) };
  }

  @Get(":deedId")
  @RequirePermissions(PERMISSIONS.DEEDS_VIEW)
  async getOne(@CurrentUser() user: AuthUser, @Param("deedId") deedId: string) {
    const id = parseInt(deedId, 10);
    // Bounded to int4: an id past 2^31 passed the integer test and then
    // overflowed in the driver, turning a bad request into a 500.
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
      throw new BadRequestException("معرف الصك غير صالح · Invalid deed id");
    }

    const [deed] = await this.db.select().from(deedsTable)
      .where(and(eq(deedsTable.id, id), eq(deedsTable.userId, scopeId(user)), isNull(deedsTable.deletedAt)));
    if (!deed) throw new NotFoundException("الصك غير موجود · Deed not found");

    // Property linkage (1:1) — null if no property has been associated yet.
    const [property] = await this.db.select({
      id: propertiesTable.id,
      name: propertiesTable.name,
      cityLookupId: propertiesTable.cityLookupId,
      district: propertiesTable.district,
    })
    .from(propertiesTable)
    .where(and(eq(propertiesTable.deedId, deed.id), isNull(propertiesTable.deletedAt)));
    if (property) await attachLookupLabels(this.db, [property as any], [{ idField: "cityLookupId", out: "city", mode: "labelAr" }]);

    return { ...deed, property: property ?? null };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.DEEDS_WRITE)
  async create(@CurrentUser() user: AuthUser, @Body() rawBody: any) {
    const body = this.parseOrThrow(deedCreateSchema, rawBody);
    const owner = scopeId(user);

    // Pre-check uniqueness to return a clean Arabic+English message instead
    // of leaking the Postgres unique-constraint error.
    const [existing] = await this.db.select({ id: deedsTable.id }).from(deedsTable)
      .where(and(eq(deedsTable.userId, owner), eq(deedsTable.deedNumber, body.deedNumber), isNull(deedsTable.deletedAt)));
    if (existing) throw new ConflictException("رقم الصك مستخدم مسبقاً · Deed number already exists");

    const [deed] = await this.db.insert(deedsTable).values({
      userId: owner,
      deedNumber: body.deedNumber,
      deedType: body.deedType,
      documentUrl: body.documentUrl ?? null,
      documentName: body.documentName ?? null,
      ownerId: body.ownerId ?? null,
      ownerNationalId: body.ownerNationalId ?? null,
      deedOwners: body.deedOwners ?? null,
      issueDate: body.issueDate ?? null,
      issueDateHijri: body.issueDateHijri ?? null,
      copyDate: body.copyDate ?? null,
      registryNumber: body.registryNumber ?? null,
      issuingAuthority: body.issuingAuthority ?? null,
      notes: body.notes ?? null,
      isDemo: false,
    }).returning();
    return deed;
  }

  @Patch(":deedId")
  @RequirePermissions(PERMISSIONS.DEEDS_WRITE)
  async update(@CurrentUser() user: AuthUser, @Param("deedId") deedId: string, @Body() rawBody: any) {
    const id = parseInt(deedId, 10);
    // Bounded to int4: an id past 2^31 passed the integer test and then
    // overflowed in the driver, turning a bad request into a 500.
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
      throw new BadRequestException("معرف الصك غير صالح · Invalid deed id");
    }
    const body = this.parseOrThrow(deedUpdateSchema, rawBody);
    const owner = scopeId(user);

    // If renaming, re-check uniqueness.
    if (body.deedNumber) {
      const [clash] = await this.db.select({ id: deedsTable.id }).from(deedsTable)
        .where(and(
          eq(deedsTable.userId, owner),
          eq(deedsTable.deedNumber, body.deedNumber),
          isNull(deedsTable.deletedAt),
        ));
      if (clash && clash.id !== id) {
        throw new ConflictException("رقم الصك مستخدم مسبقاً · Deed number already exists");
      }
    }

    const updateData: Record<string, unknown> = {};
    for (const k of Object.keys(body) as Array<keyof DeedCreateInput>) {
      if (body[k] !== undefined) updateData[k] = body[k];
    }
    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException("لا توجد حقول للتعديل · No fields to update");
    }

    const [deed] = await this.db.update(deedsTable).set(updateData as any)
      .where(and(eq(deedsTable.id, id), eq(deedsTable.userId, owner), isNull(deedsTable.deletedAt)))
      .returning();
    if (!deed) throw new NotFoundException("الصك غير موجود · Deed not found");
    return deed;
  }

  @Delete(":deedId")
  @RequirePermissions(PERMISSIONS.DEEDS_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param("deedId") deedId: string) {
    const id = parseInt(deedId, 10);
    // Bounded to int4: an id past 2^31 passed the integer test and then
    // overflowed in the driver, turning a bad request into a 500.
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
      throw new BadRequestException("معرف الصك غير صالح · Invalid deed id");
    }

    const owner = scopeId(user);

    // Block delete while a property still links to this deed. Better to ask
    // the user to unlink first than to silently leave a property's deed_id
    // pointing at a tombstone (the FK is `ON DELETE SET NULL` for safety,
    // but we want the loud version at the API layer).
    //
    // Scoped to the caller: unscoped, deleting SOMEONE ELSE'S linked deed
    // answered 409 instead of 404, which confirmed that deed id exists on
    // another account. Out-of-scope ids now fall through to the 404 below.
    const [linkedProperty] = await this.db.select({ id: propertiesTable.id })
      .from(propertiesTable)
      .where(and(
        eq(propertiesTable.deedId, id),
        eq(propertiesTable.userId, owner),
        isNull(propertiesTable.deletedAt),
      ));
    if (linkedProperty) {
      throw new ConflictException("لا يمكن حذف الصك لأنه مرتبط بعقار · Cannot delete: deed is linked to a property");
    }

    const [deleted] = await this.db.update(deedsTable).set({ deletedAt: new Date() } as any)
      .where(and(eq(deedsTable.id, id), eq(deedsTable.userId, owner), isNull(deedsTable.deletedAt)))
      .returning({ id: deedsTable.id });
    if (!deleted) throw new NotFoundException("الصك غير موجود · Deed not found");
    return { success: true, message: "تم الحذف بنجاح · Deleted successfully" };
  }

  /** Zod-validate with a bilingual error message; throws BadRequestException. */
  private parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    const path = issue.path.join(".");
    throw new BadRequestException({
      message: issue.message,
      field: path || undefined,
      // Surface all issues so the frontend can map them to fields.
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
}

@Module({ controllers: [DeedsController] })
export class DeedsModule {}
