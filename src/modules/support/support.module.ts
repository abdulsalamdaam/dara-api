import { Body, Controller, ForbiddenException, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { supportTicketsTable, supportMessagesTable, usersTable, companiesTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { EmailModule } from "../email/email.module";
import { EmailService } from "../email/email.service";
import { likeContains, listQuerySchema, parseEnumList, wantsPagination } from "../../common/pagination";

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

  /**
   * Support tickets - the admin console sees every account's, a customer sees
   * only their own.
   *
   * `status` (open|closed) and `search` are applied in SQL. The admin tab was
   * filtering both in the browser over the full ticket table, which is the
   * usual trap: it works until there are more tickets than one response, and
   * then the search quietly only searches what was fetched.
   *
   * Pagination is opt-in (`page`/`pageSize`/`paginated`) so the existing
   * bare-array callers keep working.
   */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const paged = wantsPagination(rawQuery);
    const q = listQuerySchema.parse(rawQuery ?? {});
    const admin = this.isAdmin(user);
    const dir = q.order === "asc" ? asc : desc;

    /**
     * The newest message on each ticket, as ONE lateral sub-query (message and
     * time together) rather than two correlated ones that each walked the
     * ticket's messages. It was a per-ticket round trip before that.
     */
    const lastMsg = this.db
      .select({ message: supportMessagesTable.message, at: supportMessagesTable.createdAt })
      .from(supportMessagesTable)
      .where(eq(supportMessagesTable.ticketId, supportTicketsTable.id))
      .orderBy(desc(supportMessagesTable.createdAt), desc(supportMessagesTable.id))
      .limit(1)
      .as("last_msg");

    const conds: any[] = [];
    if (!admin) conds.push(eq(supportTicketsTable.userId, user.id));
    const statuses = parseEnumList(rawQuery?.status, ["open", "closed"] as const);
    if (q.search) {
      const like = likeContains(q.search);
      conds.push(admin
        ? or(
            ilike(usersTable.name, like),
            ilike(usersTable.email, like),
            ilike(companiesTable.name, like),
            sql`exists (select 1 from ${supportMessagesTable} where ${supportMessagesTable.ticketId} = ${supportTicketsTable.id} and ${supportMessagesTable.message} ilike ${like})`,
          )
        : sql`exists (select 1 from ${supportMessagesTable} where ${supportMessagesTable.ticketId} = ${supportTicketsTable.id} and ${supportMessagesTable.message} ilike ${like})`);
    }
    // The tab badges count the same set as the table minus the status filter,
    // so they honour the search (they counted every ticket before: a search
    // with no results still read "Open 30").
    const statsWhere = conds.length ? and(...conds) : undefined;
    if (statuses) conds.push(inArray(supportTicketsTable.status, statuses));
    const where = conds.length ? and(...conds) : undefined;

    let rowsQ = this.db
      .select({
        id: supportTicketsTable.id,
        userId: supportTicketsTable.userId,
        status: supportTicketsTable.status,
        createdAt: supportTicketsTable.createdAt,
        updatedAt: supportTicketsTable.updatedAt,
        userName: usersTable.name,
        userEmail: usersTable.email,
        userCompany: companiesTable.name,
        lastMessage: lastMsg.message,
        lastMessageAt: lastMsg.at,
      })
      .from(supportTicketsTable)
      .leftJoin(usersTable, eq(supportTicketsTable.userId, usersTable.id))
      .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
      .leftJoinLateral(lastMsg, sql`true`)
      .where(where)
      // `id` tiebreak - `updated_at` moves on every reply and two tickets
      // replied to in the same instant would otherwise order arbitrarily.
      .orderBy(dir(supportTicketsTable.updatedAt), dir(supportTicketsTable.id))
      .$dynamic();
    if (paged) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow, statusRows] = await Promise.all([
      rowsQ,
      paged ? this.db.select({ total: count() })
        .from(supportTicketsTable)
        .leftJoin(usersTable, eq(supportTicketsTable.userId, usersTable.id))
        .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
        .where(where) : Promise.resolve([{ total: 0 }]),
      // Open/closed counts for the tab badges, over the same set minus the
      // status filter itself.
      paged ? this.db.select({ status: supportTicketsTable.status, cnt: count() })
        .from(supportTicketsTable)
        .leftJoin(usersTable, eq(supportTicketsTable.userId, usersTable.id))
        .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
        .where(statsWhere)
        .groupBy(supportTicketsTable.status) : Promise.resolve([]),
    ]);
    if (!paged) return rows;
    const byStatus: Record<string, number> = {};
    for (const r of statusRows as Array<{ status: string; cnt: number }>) byStatus[r.status] = Number(r.cnt);
    return {
      data: rows,
      page: q.page,
      pageSize: q.pageSize,
      total: Number(totalRow[0]?.total ?? 0),
      stats: { byStatus },
    };
  }

  @Get("open-count")
  async openCount(@CurrentUser() user: AuthUser) {
    if (!this.isAdmin(user)) return { count: 0 };
    // Counted by the database. This used to SELECT every open ticket and
    // return `rows.length` - the right number, paid for by dragging the whole
    // open queue across the wire to produce it.
    const [row] = await this.db.select({ c: count() }).from(supportTicketsTable)
      .where(eq(supportTicketsTable.status, "open"));
    return { count: Number(row?.c ?? 0) };
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
    const status = body?.status;
    if (status !== "open" && status !== "closed") throw new BadRequestException("status must be open or closed");
    const [row] = await this.db.update(supportTicketsTable).set({ status, updatedAt: new Date() })
      .where(eq(supportTicketsTable.id, tid)).returning();
    if (!row) throw new NotFoundException("التذكرة غير موجودة");
    return row;
  }
}

@Module({ imports: [EmailModule], controllers: [SupportController] })
export class SupportModule {}
