import { Body, Controller, ForbiddenException, Get, Inject, Module, NotFoundException, Param, Patch, Post, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { desc, eq } from "drizzle-orm";
import { supportTicketsTable, supportMessagesTable, usersTable, companiesTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { EmailModule } from "../email/email.module";
import { EmailService } from "../email/email.service";

@ApiTags("support")
@ApiBearerAuth("user-jwt")
@Controller("support/tickets")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class SupportController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly email: EmailService,
  ) {}

  private isAdmin(user: AuthUser) {
    return user.role === "super_admin" || user.role === "admin";
  }

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    if (this.isAdmin(user)) {
      const tickets = await this.db
        .select({
          id: supportTicketsTable.id,
          userId: supportTicketsTable.userId,
          status: supportTicketsTable.status,
          createdAt: supportTicketsTable.createdAt,
          updatedAt: supportTicketsTable.updatedAt,
          userName: usersTable.name,
          userEmail: usersTable.email,
          userCompany: companiesTable.name,
        })
        .from(supportTicketsTable)
        .leftJoin(usersTable, eq(supportTicketsTable.userId, usersTable.id))
        .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
        .orderBy(desc(supportTicketsTable.updatedAt));

      return Promise.all(tickets.map(async (t) => {
        const [lastMsg] = await this.db.select().from(supportMessagesTable)
          .where(eq(supportMessagesTable.ticketId, t.id))
          .orderBy(desc(supportMessagesTable.createdAt))
          .limit(1);
        return { ...t, lastMessage: lastMsg?.message ?? null, lastMessageAt: lastMsg?.createdAt ?? null };
      }));
    }

    return this.db.select().from(supportTicketsTable)
      .where(eq(supportTicketsTable.userId, user.id))
      .orderBy(desc(supportTicketsTable.updatedAt));
  }

  @Get("open-count")
  async openCount(@CurrentUser() user: AuthUser) {
    if (!this.isAdmin(user)) return { count: 0 };
    const rows = await this.db.select().from(supportTicketsTable).where(eq(supportTicketsTable.status, "open"));
    return { count: rows.length };
  }

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    if (!body.message?.trim()) throw new BadRequestException("الرسالة مطلوبة");
    const [ticket] = await this.db.insert(supportTicketsTable).values({ userId: user.id, status: "open" }).returning();
    const [msg] = await this.db.insert(supportMessagesTable).values({
      ticketId: ticket!.id,
      senderId: user.id,
      senderRole: "user",
      message: body.message.trim(),
    }).returning();
    return { ticket, message: msg };
  }

  @Get(":id/messages")
  async messages(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const tid = parseInt(id, 10);
    const [ticket] = await this.db.select().from(supportTicketsTable).where(eq(supportTicketsTable.id, tid));
    if (!ticket) throw new NotFoundException("التذكرة غير موجودة");
    if (!this.isAdmin(user) && ticket.userId !== user.id) throw new ForbiddenException("غير مصرح");
    const messages = await this.db.select().from(supportMessagesTable)
      .where(eq(supportMessagesTable.ticketId, tid)).orderBy(supportMessagesTable.createdAt);
    return { ticket, messages };
  }

  @Post(":id/messages")
  async sendMessage(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    const tid = parseInt(id, 10);
    if (!body.message?.trim()) throw new BadRequestException("الرسالة مطلوبة");
    const [ticket] = await this.db.select().from(supportTicketsTable).where(eq(supportTicketsTable.id, tid));
    if (!ticket) throw new NotFoundException("التذكرة غير موجودة");
    if (!this.isAdmin(user) && ticket.userId !== user.id) throw new ForbiddenException("غير مصرح");

    const senderRole = this.isAdmin(user) ? "admin" : "user";
    const [msg] = await this.db.insert(supportMessagesTable).values({
      ticketId: tid,
      senderId: user.id,
      senderRole,
      message: body.message.trim(),
    }).returning();
    await this.db.update(supportTicketsTable).set({ updatedAt: new Date() }).where(eq(supportTicketsTable.id, tid));

    // When the team (admin) replies, email the ticket owner so they don't have
    // to keep the portal open. Best-effort — never blocks the reply.
    if (senderRole === "admin") {
      try {
        const [owner] = await this.db.select({ email: usersTable.email, name: usersTable.name })
          .from(usersTable).where(eq(usersTable.id, ticket.userId));
        if (owner?.email) void this.email.sendSupportReply(owner.email, owner.name || "", tid, body.message.trim());
      } catch { /* email is best-effort */ }
    }
    return msg;
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.SUPPORT_RESPOND)
  async updateStatus(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    if (!this.isAdmin(user)) throw new ForbiddenException("غير مصرح");
    const tid = parseInt(id, 10);
    const [row] = await this.db.update(supportTicketsTable).set({ status: body.status, updatedAt: new Date() })
      .where(eq(supportTicketsTable.id, tid)).returning();
    if (!row) throw new NotFoundException("التذكرة غير موجودة");
    return row;
  }
}

@Module({ imports: [EmailModule], controllers: [SupportController] })
export class SupportModule {}
