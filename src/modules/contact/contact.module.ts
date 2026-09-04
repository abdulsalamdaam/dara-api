import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Module, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import type { Request } from "express";
import { contactSubmissionsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../common/guards/roles.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { OtpThrottlerGuard } from "../../common/throttler";
import { clientIp, clientUserAgent } from "../../common/client-ip";
import { EmailService } from "../email/email.service";
import {
  listQuerySchema, parseDateBound, wantsPagination,
} from "../../common/pagination";

class CreateContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  source?: string;
}

class UpdateContactDto {
  @IsOptional()
  @IsIn(["new", "read", "in_progress", "resolved", "spam"])
  status?: "new" | "read" | "in_progress" | "resolved" | "spam";

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  responseNotes?: string;
}

/* ── Public submit (rate-limited per IP+identifier) ─────────────── */
@ApiTags("contact")
@Controller("public/contact")
class PublicContactController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly email: EmailService,
  ) {}

  @Post()
  @HttpCode(201)
  @Throttle({
    short: { limit: 1, ttl: 60_000 },     // 1 / minute per (IP+email)
    long:  { limit: 5, ttl: 3600_000 },   // 5 / hour per (IP+email)
  })
  @UseGuards(OtpThrottlerGuard)
  async submit(@Body() body: CreateContactDto, @Req() req: Request) {
    if (!body.email && !body.phone) {
      throw new BadRequestException("الرجاء إدخال البريد الإلكتروني أو رقم الجوال للتواصل");
    }

    // One definition of "who is calling", shared with the throttler and the
    // auth controller — `common/client-ip`. Reading `x-forwarded-for[0]` here
    // meant every contact submission recorded Cloudflare's edge IP.
    const ip = clientIp(req);
    const userAgent = clientUserAgent(req);

    const [row] = await this.db.insert(contactSubmissionsTable).values({
      name: body.name?.trim() || null,
      email: body.email?.trim().toLowerCase() || null,
      phone: body.phone?.trim() || null,
      description: body.description.trim(),
      source: body.source?.trim() || "landing-contact",
      status: "new",
      ip,
      userAgent,
    }).returning();

    const payload = {
      id: row!.id,
      name: row!.name,
      email: row!.email,
      phone: row!.phone,
      description: row!.description,
      source: row!.source,
    };
    void this.email.sendContactReceived(payload);
    // If the submitter left an email, send them an acknowledgment so they
    // know the message went through. No-op when only a phone was given.
    if (row!.email) void this.email.sendContactAck(row!.email, payload);

    return {
      success: true,
      id: row!.id,
      message: "شكراً لتواصلك معنا. سيقوم فريقنا بالرد عليك قريباً.",
    };
  }
}

/* ── Admin tracking ─────────────────────────────────────────────── */
@ApiTags("admin")
@ApiBearerAuth("user-jwt")
@Controller("admin/contact-submissions")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
class AdminContactController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /**
   * Contact submissions from the landing page.
   *
   * `status` was already applied in SQL; `search` and the `from`/`to` window
   * are now too, and pagination is opt-in via `page`/`pageSize`/`paginated`.
   * Without them the bare array the admin tab reads is returned as before.
   */
  @Get()
  async list(@Query() rawQuery: any) {
    const paged = wantsPagination(rawQuery);
    const q = listQuerySchema.parse(rawQuery ?? {});

    const conds: any[] = [];
    const status = typeof rawQuery?.status === "string" ? rawQuery.status : undefined;
    if (status && status !== "all") conds.push(eq(contactSubmissionsTable.status, status as any));
    if (q.search) {
      conds.push(or(
        ilike(contactSubmissionsTable.name, `%${q.search}%`),
        ilike(contactSubmissionsTable.email, `%${q.search}%`),
        ilike(contactSubmissionsTable.phone, `%${q.search}%`),
        ilike(contactSubmissionsTable.description, `%${q.search}%`),
      ));
    }
    const from = parseDateBound(rawQuery?.from);
    const to = parseDateBound(rawQuery?.to);
    if (from) conds.push(gte(contactSubmissionsTable.createdAt, new Date(`${from}T00:00:00.000Z`)));
    if (to) conds.push(lte(contactSubmissionsTable.createdAt, new Date(`${to}T23:59:59.999Z`)));
    const where = conds.length ? and(...conds) : undefined;

    const dir = q.order === "asc" ? asc : desc;
    let rowsQ = this.db.select().from(contactSubmissionsTable)
      .where(where)
      // `id` tiebreak: two submissions can share a `created_at`, and paging on
      // it alone would repeat one and drop another.
      .orderBy(dir(contactSubmissionsTable.createdAt), dir(contactSubmissionsTable.id))
      .$dynamic();
    if (paged) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow] = await Promise.all([
      rowsQ,
      paged ? this.db.select({ total: count() }).from(contactSubmissionsTable).where(where)
            : Promise.resolve([{ total: 0 }]),
    ]);
    if (!paged) return rows;
    return { data: rows, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0) };
  }

  /**
   * Per-status badge counts.
   *
   * One grouped query. This used to SELECT every submission and run six
   * `.filter().length` passes over the result - the whole table fetched to
   * produce six integers. `total` is included so the "all" badge stops being a
   * client-side sum of the others (which silently omitted any status the
   * hard-coded list did not name).
   */
  @Get("counts")
  async counts() {
    const rows = await this.db
      .select({ status: contactSubmissionsTable.status, cnt: count() })
      .from(contactSubmissionsTable)
      .groupBy(contactSubmissionsTable.status);
    const out = { total: 0, new: 0, read: 0, in_progress: 0, resolved: 0, spam: 0 } as Record<string, number>;
    for (const r of rows as Array<{ status: string; cnt: number }>) {
      out[r.status] = Number(r.cnt);
      out.total += Number(r.cnt);
    }
    return out;
  }

  @Patch(":id")
  async update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: UpdateContactDto) {
    const sid = parseInt(id, 10);
    const updateData: Record<string, unknown> = {};
    if (body.status !== undefined) {
      updateData.status = body.status;
      if (body.status === "resolved") {
        updateData.resolvedAt = new Date();
        updateData.resolvedById = user.id;
      }
    }
    if (body.responseNotes !== undefined) updateData.responseNotes = body.responseNotes;
    if (Object.keys(updateData).length === 0) throw new BadRequestException("لا توجد حقول للتحديث");

    const [row] = await this.db.update(contactSubmissionsTable).set(updateData)
      .where(eq(contactSubmissionsTable.id, sid)).returning();
    if (!row) throw new NotFoundException("Submission not found");
    return row;
  }
}

@Module({ controllers: [PublicContactController, AdminContactController] })
export class ContactModule {}
