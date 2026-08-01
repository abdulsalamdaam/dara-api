import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Module, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Request } from "express";
import { contactSubmissionsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../common/guards/roles.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { OtpThrottlerGuard } from "../../common/throttler";
import { EmailService } from "../email/email.service";

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

    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.socket?.remoteAddress
      || "unknown";
    const userAgent = (req.headers["user-agent"] as string)?.slice(0, 400) || null;

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

  @Get()
  async list(@Query("status") status?: string) {
    if (status && status !== "all") {
      return this.db.select().from(contactSubmissionsTable)
        .where(eq(contactSubmissionsTable.status, status as any))
        .orderBy(desc(contactSubmissionsTable.createdAt));
    }
    return this.db.select().from(contactSubmissionsTable).orderBy(desc(contactSubmissionsTable.createdAt));
  }

  @Get("counts")
  async counts() {
    const all = await this.db.select().from(contactSubmissionsTable);
    return {
      total: all.length,
      new: all.filter(r => r.status === "new").length,
      read: all.filter(r => r.status === "read").length,
      in_progress: all.filter(r => r.status === "in_progress").length,
      resolved: all.filter(r => r.status === "resolved").length,
      spam: all.filter(r => r.status === "spam").length,
    };
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
