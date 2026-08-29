import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Module, NotFoundException, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { sendExpoPush } from "../../common/push";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, isNotNull, lte, notInArray, or, sql, sum } from "drizzle-orm";
import { usersTable, propertiesTable, unitsTable, contractsTable, paymentsTable, loginLogsTable, tenantsTable, rolesTable, companiesTable, ownersTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../common/guards/roles.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { seedDemoData } from "./demo-seed";
import { ALL_PERMISSIONS, ROLE_PRESETS, STAFF_ROLE_KEYS } from "../../common/permissions";
import {
  listQuerySchema, parseDateBound, parseEnumList, wantsPagination,
} from "../../common/pagination";
import { EmailService } from "../email/email.service";
import { isPackagePlan, planAllowedForUserType, planUserTypeError, type PackagePlan } from "../../common/packages";
import { newEmailVerifyToken } from "../../common/email-verification";
import { EjarModule } from "../ejar/ejar.module";
import { AdminCustomerOverviewController } from "./customer-overview.controller";
import { EjarPolicyService, type ManualAddOverride } from "../ejar/ejar.policy.service";
import { TaqnyatService } from "../sms/taqnyat.service";

/**
 * Subscription window: starts now; ends after `trialDays`, or at the given
 * date, or +1 year. `trialDays` wins over an explicit date so the admin UI can
 * offer "30 days" without also having to compute and send the date.
 */
function subscriptionWindow(opts?: { endsAtIso?: string; trialDays?: number }): { startedAt: Date; endsAt: Date } {
  const startedAt = new Date();
  const days = normalizeTrialDays(opts?.trialDays);
  if (days != null) {
    return { startedAt, endsAt: new Date(startedAt.getTime() + days * 86_400_000) };
  }
  let endsAt: Date;
  if (opts?.endsAtIso) {
    const d = new Date(opts.endsAtIso);
    endsAt = isNaN(d.getTime()) ? new Date(new Date().setFullYear(startedAt.getFullYear() + 1)) : d;
  } else {
    endsAt = new Date(new Date().setFullYear(startedAt.getFullYear() + 1));
  }
  return { startedAt, endsAt };
}

/** Trial length in whole days, or null when none was asked for. */
function normalizeTrialDays(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  // A year of "trial" is a free subscription; anything past that is a typo.
  if (n > 365) throw new BadRequestException("مدة التجربة يجب أن تكون بين 1 و 365 يوماً");
  return n;
}

/**
 * The plan an admin action should apply, or a 400.
 *
 * Precedence: an explicit choice → the plan the user picked when registering →
 * `basic`. An explicit choice that is not a real plan key is REJECTED rather
 * than quietly replaced: the admin's dropdown used to be able to send a legacy
 * value ("broker"), which failed `isPackagePlan`, fell through to the default,
 * and granted a package nobody had selected — with a success toast.
 */
function resolveAdminPlan(requested: unknown, desired: string | null | undefined): PackagePlan {
  if (requested != null && requested !== "") {
    const asked = String(requested);
    if (!isPackagePlan(asked)) {
      throw new BadRequestException(`باقة غير معروفة: ${asked}`);
    }
    return asked;
  }
  if (isPackagePlan(desired)) return desired;
  return "basic";
}

/**
 * `isCustomerAccount` as a WHERE clause.
 *
 * The JS predicate in `common/permissions.ts` stays the definition; this is the
 * same rule expressed for the database, because these lists used to SELECT
 * every user row and then filter with it in memory. That is fine at today's
 * size and wrong the moment it is paged: page 1 of a paginated query would be
 * filtered down to whatever of its 25 rows happened to be customers, and the
 * count beside it would have been counting staff and employees too.
 *
 * Topology, not role key: no owner above the row, and not Dara staff. A NULL
 * role key is a customer (`NOT IN` is NULL-valued in SQL, so it is spelled out
 * rather than left to three-valued logic).
 */
const isCustomerAccountSql = and(
  isNull(usersTable.ownerUserId),
  or(isNull(rolesTable.key), notInArray(rolesTable.key, STAFF_ROLE_KEYS as unknown as string[])),
);

@ApiTags("admin")
@ApiBearerAuth("user-jwt")
@Controller("admin")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
class AdminController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly email: EmailService,
    private readonly ejarPolicy: EjarPolicyService,
    private readonly sms: TaqnyatService,
  ) {}

  /**
   * Manual-record-creation policy. Everything is meant to come through Ejar, so
   * the Add buttons are off by default and come back automatically when the
   * gateway is down. This lets a super-admin force either state regardless —
   * precedence is admin override > health > default (disabled).
   */
  @Get("manual-add")
  async getManualAdd() {
    return this.ejarPolicy.getPolicy();
  }

  @Put("manual-add")
  async setManualAdd(@Body() body: { override?: ManualAddOverride }) {
    const v = body?.override;
    if (v !== "auto" && v !== "force_enabled" && v !== "force_disabled") {
      throw new BadRequestException("override must be auto | force_enabled | force_disabled");
    }
    await this.ejarPolicy.setOverride(v);
    return this.ejarPolicy.getPolicy();
  }

  /** Re-run the Ejar connectivity probe now instead of waiting for the hour. */
  @Post("manual-add/recheck")
  async recheckEjar() {
    await this.ejarPolicy.refreshHealth();
    return this.ejarPolicy.getPolicy();
  }

  /**
   * SMS gateway health: account status, remaining credit and the sender names
   * approved on the account. Costs nothing (no message is sent) and is the
   * fastest answer to "why did the OTP not arrive" — an expired account, an
   * empty balance and an unapproved sender all look identical from the app.
   */
  @Get("sms/status")
  async smsStatus() {
    const [balance, senders] = await Promise.all([this.sms.balance(), this.sms.senders()]);
    const configuredSender = process.env.TAQNYAT_SENDER || null;
    return {
      provider: "taqnyat",
      configured: this.sms.isConfigured(),
      sender: configuredSender,
      senderApproved: configuredSender
        ? senders.senders.some((x) => x.senderName === configuredSender && String(x.status ?? "").toLowerCase() !== "inactive")
        : false,
      devBypass: process.env.SMS_DEV_BYPASS === "true" || process.env.TWILIO_DEV_BYPASS === "true",
      balance,
      senders: senders.senders,
    };
  }

  /**
   * Platform-wide admin figures.
   *
   * Every number here is a database aggregate. It used to SELECT the whole
   * users table, the whole contracts table and the whole payments table and
   * reduce them in JavaScript - three unbounded scans dragged across the wire
   * to produce a dozen scalars, on a dashboard that is opened constantly.
   *
   * "Companies" = customer accounts (see `isCustomerAccountSql`); internal
   * staff rows are excluded. `monthlyRevenue` is money actually collected this
   * month; `monthlyRecurring` is the sum of active contracts' monthly rent.
   */
  @Get("stats")
  async stats() {
    const now = new Date();
    const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    // The six months ending with the current one, oldest first.
    const months = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
      return { key: monthKey(d), label: d.toLocaleDateString("ar-SA", { month: "short" }) };
    });
    const earliest = `${months[0]!.key}-01`;

    const [
      userRows, companyRows, propRow, unitRow, contractRows, paidRows, dueRow, monthRows,
    ] = await Promise.all([
      this.db.select({ isActive: usersTable.isActive, cnt: count() })
        .from(usersTable).groupBy(usersTable.isActive),
      this.db.select({ isActive: usersTable.isActive, cnt: count() })
        .from(usersTable)
        .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
        .where(isCustomerAccountSql)
        .groupBy(usersTable.isActive),
      this.db.select({ c: count() }).from(propertiesTable),
      this.db.select({ c: count() }).from(unitsTable),
      // Count and monthly-rent sum per status in one pass, so `activeContracts`
      // and `monthlyRecurring` come from the same scan as `totalContracts`.
      this.db.select({ status: contractsTable.status, cnt: count(), rent: sum(contractsTable.monthlyRent) })
        .from(contractsTable).groupBy(contractsTable.status),
      this.db.select({ amount: sum(paymentsTable.amount) })
        .from(paymentsTable).where(eq(paymentsTable.status, "paid")),
      this.db.select({ amount: sum(paymentsTable.amount) })
        .from(paymentsTable).where(inArray(paymentsTable.status, ["pending", "overdue"])),
      // Collected per month for the last six months. `paid_date` is a date
      // column stored as YYYY-MM-DD, so its first seven characters are the
      // month key - grouped in SQL rather than by scanning every payment row
      // six times in JavaScript.
      this.db.select({
        // `paid_date` is a DATE, and Postgres has no substring(date, int, int) —
        // the JS this replaced called startsWith on the string form. to_char
        // does the same job without the implicit cast that never existed.
        month: sql<string>`to_char(${paymentsTable.paidDate}, 'YYYY-MM')`.as("month"),
        amount: sum(paymentsTable.amount),
      })
        .from(paymentsTable)
        .where(and(
          eq(paymentsTable.status, "paid"),
          isNotNull(paymentsTable.paidDate),
          gte(paymentsTable.paidDate, earliest),
        ))
        .groupBy(sql`1`),
    ]);

    const tally = (rows: Array<{ isActive: boolean; cnt: number }>) => {
      let total = 0;
      let active = 0;
      for (const r of rows) {
        total += Number(r.cnt);
        if (r.isActive) active += Number(r.cnt);
      }
      return { total, active };
    };
    const users = tally(userRows as Array<{ isActive: boolean; cnt: number }>);
    const companies = tally(companyRows as Array<{ isActive: boolean; cnt: number }>);

    let totalContracts = 0;
    let activeContracts = 0;
    let monthlyRecurring = 0;
    for (const r of contractRows as Array<{ status: string; cnt: number; rent: string | null }>) {
      totalContracts += Number(r.cnt);
      if (r.status === "active") {
        activeContracts = Number(r.cnt);
        monthlyRecurring = Number(r.rent ?? 0);
      }
    }

    const byMonth = new Map<string, number>();
    for (const r of monthRows as Array<{ month: string | null; amount: string | null }>) {
      if (r.month) byMonth.set(r.month, Number(r.amount ?? 0));
    }
    const monthlyData = months.map((m) => ({ month: m.label, revenue: byMonth.get(m.key) ?? 0 }));

    return {
      totalCompanies: companies.total,
      activeCompanies: companies.active,
      totalUsers: users.total,
      activeUsers: users.active,
      totalProperties: Number(propRow[0]?.c ?? 0),
      totalUnits: Number(unitRow[0]?.c ?? 0),
      totalContracts,
      activeContracts,
      monthlyRevenue: byMonth.get(monthKey(now)) ?? 0,
      monthlyRecurring,
      collectedTotal: Number((paidRows[0] as { amount: string | null })?.amount ?? 0),
      pendingDue: Number((dueRow[0] as { amount: string | null })?.amount ?? 0),
      monthlyData,
    };
  }

  /**
   * Customer accounts ("companies").
   *
   * Two things used to happen in JavaScript here and both now happen in SQL:
   * the `isCustomerAccount` topology test (see `isCustomerAccountSql`), and the
   * admin tab's own search box, which was filtering the fetched array. `total`
   * is the database's count of matching accounts.
   *
   * The six per-account counts were six queries PER ROW - a 7N+1 that grew with
   * the customer base. They are six grouped sub-queries now, each scanning its
   * table once and joined by account id, so the cost no longer depends on how
   * many accounts are on the page.
   *
   * Pagination is opt-in (`page`/`pageSize`/`paginated`/`search`) so the
   * existing bare-array caller keeps working.
   */
  @Get("companies")
  async companies(@Query() rawQuery: any) {
    const paged = wantsPagination(rawQuery, ["search"]);
    const q = listQuerySchema.parse(rawQuery ?? {});

    const conds: any[] = [isCustomerAccountSql];
    if (q.search) {
      conds.push(or(
        ilike(usersTable.name, `%${q.search}%`),
        ilike(usersTable.email, `%${q.search}%`),
        ilike(usersTable.phone, `%${q.search}%`),
        ilike(companiesTable.name, `%${q.search}%`),
      ));
    }
    if (rawQuery?.isActive === "1" || rawQuery?.isActive === "true") conds.push(eq(usersTable.isActive, true));
    else if (rawQuery?.isActive === "0" || rawQuery?.isActive === "false") conds.push(eq(usersTable.isActive, false));
    const plans = typeof rawQuery?.plan === "string" && rawQuery.plan.trim()
      ? rawQuery.plan.split(",").map((x: string) => x.trim()).filter(Boolean) : undefined;
    if (plans?.length) conds.push(inArray(usersTable.packagePlan, plans as any));
    const where = and(...conds);

    const dir = q.order === "asc" ? asc : desc;
    let rowsQ = this.db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        isActive: usersTable.isActive,
        phone: usersTable.phone,
        createdAt: usersTable.createdAt,
        packagePlan: usersTable.packagePlan,
        roleKey: rolesTable.key,
        ownerUserId: usersTable.ownerUserId,
        companyName: companiesTable.name,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
      // The row query was built without this while the count query had it, so
      // every filter — search, active, plan, and the customer-account test —
      // applied to the total and to nothing else. The list came back unfiltered
      // under a filtered count, which also produced pages past the last one.
      .where(where)
      // Ordering was left entirely to the database before, which is
      // non-deterministic and would have made paging shuffle rows. Newest
      // account first, `id` as the tiebreak.
      .orderBy(dir(usersTable.createdAt), dir(usersTable.id))
      .$dynamic();
    if (paged) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow] = await Promise.all([
      rowsQ,
      paged ? this.db.select({ total: count() })
        .from(usersTable)
        .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
        .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
        .where(where) : Promise.resolve([{ total: 0 }]),
    ]);

    const ids = rows.map((r) => r.id);
    const counts = await this.accountCounts(ids);
    const data = rows.map((user) => {
      const c = counts.get(user.id);
      return {
        id: user.id,
        name: user.companyName || user.name,
        email: user.email,
        role: user.roleKey,
        isActive: user.isActive,
        phone: user.phone,
        plan: user.roleKey === "demo" ? "تجريبي" : "مجاني",
        propertiesCount: c?.properties ?? 0,
        unitsCount: c?.units ?? 0,
        contractsCount: c?.contracts ?? 0,
        employeesCount: c?.employees ?? 0,
        landlordsCount: c?.landlords ?? 0,
        tenantsCount: c?.tenants ?? 0,
        createdAt: user.createdAt,
      };
    });
    if (!paged) return data;
    return { data, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0) };
  }

  /**
   * Properties / units / contracts / employees / landlords / tenants per
   * account, for the given account ids, in six grouped queries rather than six
   * per row.
   */
  private async accountCounts(ids: number[]) {
    const out = new Map<number, {
      properties: number; units: number; contracts: number;
      employees: number; landlords: number; tenants: number;
    }>();
    if (ids.length === 0) return out;
    for (const id of ids) out.set(id, { properties: 0, units: 0, contracts: 0, employees: 0, landlords: 0, tenants: 0 });

    const [props, units, contracts, employees, landlords, tenants] = await Promise.all([
      this.db.select({ k: propertiesTable.userId, c: count() }).from(propertiesTable)
        .where(inArray(propertiesTable.userId, ids)).groupBy(propertiesTable.userId),
      this.db.select({ k: propertiesTable.userId, c: count() }).from(unitsTable)
        .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
        .where(inArray(propertiesTable.userId, ids)).groupBy(propertiesTable.userId),
      this.db.select({ k: contractsTable.userId, c: count() }).from(contractsTable)
        .where(inArray(contractsTable.userId, ids)).groupBy(contractsTable.userId),
      this.db.select({ k: usersTable.ownerUserId, c: count() }).from(usersTable)
        .where(and(inArray(usersTable.ownerUserId, ids), isNull(usersTable.deletedAt)))
        .groupBy(usersTable.ownerUserId),
      this.db.select({ k: ownersTable.userId, c: count() }).from(ownersTable)
        .where(and(inArray(ownersTable.userId, ids), isNull(ownersTable.deletedAt)))
        .groupBy(ownersTable.userId),
      this.db.select({ k: tenantsTable.userId, c: count() }).from(tenantsTable)
        .where(and(inArray(tenantsTable.userId, ids), isNull(tenantsTable.deletedAt)))
        .groupBy(tenantsTable.userId),
    ]);
    const apply = (rows: Array<{ k: number | null; c: number }>, field: keyof NonNullable<ReturnType<typeof out.get>>) => {
      for (const r of rows) {
        if (r.k == null) continue;
        const e = out.get(r.k);
        if (e) e[field] = Number(r.c);
      }
    };
    apply(props, "properties");
    apply(units, "units");
    apply(contracts, "contracts");
    apply(employees, "employees");
    apply(landlords, "landlords");
    apply(tenants, "tenants");
    return out;
  }

  /**
   * GET /admin/companies/:id/members
   * Everyone linked to a customer account: its employees (sub-users), the
   * landlords (owners) it manages, and its tenants — so the admin can see the
   * full picture behind each account, not just the account owner.
   */
  @Get("companies/:id/members")
  async companyMembers(@Param("id") id: string) {
    const uid = parseInt(id, 10);
    const [employees, landlords, tenants] = await Promise.all([
      this.db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, phone: usersTable.phone, isActive: usersTable.isActive, role: rolesTable.key, createdAt: usersTable.createdAt })
        .from(usersTable).leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
        .where(and(eq(usersTable.ownerUserId, uid), isNull(usersTable.deletedAt))).orderBy(desc(usersTable.createdAt)),
      this.db.select({ id: ownersTable.id, name: ownersTable.name, type: ownersTable.type, phone: ownersTable.phone, email: ownersTable.email, taxNumber: ownersTable.taxNumber, createdAt: ownersTable.createdAt })
        .from(ownersTable).where(and(eq(ownersTable.userId, uid), isNull(ownersTable.deletedAt))).orderBy(desc(ownersTable.createdAt)),
      this.db.select({ id: tenantsTable.id, name: tenantsTable.name, phone: tenantsTable.phone, email: tenantsTable.email, taxNumber: tenantsTable.taxNumber, status: tenantsTable.status, createdAt: tenantsTable.createdAt })
        .from(tenantsTable).where(and(eq(tenantsTable.userId, uid), isNull(tenantsTable.deletedAt))).orderBy(desc(tenantsTable.createdAt)),
    ]);
    return { employees, landlords, tenants };
  }

  @Patch("companies/:id")
  async updateCompany(@CurrentUser() admin: AuthUser, @Param("id") id: string, @Body() body: any) {
    const uid = parseInt(id, 10);
    if (uid === admin.id) throw new BadRequestException("لا يمكن تعديل حسابك الخاص");
    const updateData: Record<string, unknown> = {};
    if (body.isActive !== undefined) updateData.isActive = body.isActive;
    const [user] = await this.db.update(usersTable).set(updateData).where(eq(usersTable.id, uid)).returning();
    if (!user) throw new NotFoundException("Not found");
    return { success: true, id: user.id, isActive: user.isActive };
  }

  @Delete("companies/:id")
  async deleteCompany(@CurrentUser() admin: AuthUser, @Param("id") id: string) {
    const uid = parseInt(id, 10);
    if (uid === admin.id) throw new BadRequestException("لا يمكن حذف حسابك الخاص");
    const [user] = await this.db.delete(usersTable).where(eq(usersTable.id, uid)).returning();
    if (!user) throw new NotFoundException("Not found");
    return { success: true };
  }

  /**
   * "Admin Users" = Dara internal team (super_admin + admin only).
   * Customer landlords (role='user' or 'demo') live under /admin/companies.
   * This separation keeps the company team panel decoupled from customer data.
   */
  /**
   * "Admin Users" = Dara internal team (super_admin + admin only).
   * Customer landlords live under /admin/companies.
   *
   * The staff test and the tab's search are both SQL now; they were a
   * `rows.filter()` over every user row in the system followed by a
   * per-row property count (an N+1). `total` is the database's count.
   */
  @Get("users")
  async users(@Query() rawQuery: any) {
    const paged = wantsPagination(rawQuery, ["search"]);
    const q = listQuerySchema.parse(rawQuery ?? {});

    const conds: any[] = [inArray(rolesTable.key, STAFF_ROLE_KEYS as unknown as string[])];
    if (q.search) {
      conds.push(or(
        ilike(usersTable.name, `%${q.search}%`),
        ilike(usersTable.email, `%${q.search}%`),
        ilike(companiesTable.name, `%${q.search}%`),
      ));
    }
    if (rawQuery?.isActive === "1" || rawQuery?.isActive === "true") conds.push(eq(usersTable.isActive, true));
    else if (rawQuery?.isActive === "0" || rawQuery?.isActive === "false") conds.push(eq(usersTable.isActive, false));
    // The "locked" badge on this tab is `failedLoginAttempts >= 5`; offered as
    // a filter so the admin can pull up locked accounts without scanning.
    if (rawQuery?.locked === "1" || rawQuery?.locked === "true") conds.push(gte(usersTable.failedLoginAttempts, 5));
    const where = and(...conds);

    // Oldest-first is this list's long-standing default; `?order=desc` flips it.
    const dir = rawQuery?.order === "desc" ? desc : asc;
    let rowsQ = this.db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        isActive: usersTable.isActive,
        phone: usersTable.phone,
        loginCount: usersTable.loginCount,
        lastLoginAt: usersTable.lastLoginAt,
        failedLoginAttempts: usersTable.failedLoginAttempts,
        createdAt: usersTable.createdAt,
        roleKey: rolesTable.key,
        ownerUserId: usersTable.ownerUserId,
        companyName: companiesTable.name,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
      .where(where)
      .orderBy(dir(usersTable.createdAt), dir(usersTable.id))
      .$dynamic();
    if (paged) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow] = await Promise.all([
      rowsQ,
      paged ? this.db.select({ total: count() })
        .from(usersTable)
        .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
        .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
        .where(where) : Promise.resolve([{ total: 0 }]),
    ]);

    // One grouped query instead of one per row.
    const ids = rows.map((r) => r.id);
    const propCounts = new Map<number, number>();
    if (ids.length) {
      const grouped = await this.db.select({ k: propertiesTable.userId, c: count() })
        .from(propertiesTable).where(inArray(propertiesTable.userId, ids)).groupBy(propertiesTable.userId);
      for (const r of grouped) propCounts.set(r.k, Number(r.c));
    }

    const data = rows.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.roleKey,
      isActive: user.isActive,
      phone: user.phone,
      company: user.companyName,
      propertiesCount: propCounts.get(user.id) ?? 0,
      loginCount: user.loginCount ?? 0,
      lastLoginAt: user.lastLoginAt,
      failedLoginAttempts: user.failedLoginAttempts ?? 0,
      createdAt: user.createdAt,
    }));
    if (!paged) return data;
    return { data, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0) };
  }

  /**
   * Login history.
   *
   * This endpoint had the exact bug this whole change exists to remove: it
   * fetched the newest `limit` rows and THEN applied `?status=` to them in
   * JavaScript. Asking for failed logins returned "the failures among the last
   * 100 attempts", not "the last 100 failures" - so on a busy day the failures
   * tab could come back nearly empty precisely when it mattered most. `status`
   * and `search` are part of the query now, and the three tiles above the table
   * come back as `stats`, counted by the database, instead of being derived in
   * the browser from a second unfiltered fetch of the same capped list.
   *
   * `limit` still works and still returns a bare array; `page`/`pageSize`/
   * `paginated` switch to the standard envelope.
   */
  @Get("login-history")
  async loginHistory(@Query() rawQuery: any) {
    const paged = wantsPagination(rawQuery);
    const q = listQuerySchema.parse(rawQuery ?? {});

    const conds: any[] = [];
    const statuses = typeof rawQuery?.status === "string" && rawQuery.status.trim() && rawQuery.status !== "all"
      ? rawQuery.status.split(",").map((x: string) => x.trim()).filter(Boolean) : undefined;
    if (q.search) {
      conds.push(or(
        ilike(loginLogsTable.email, `%${q.search}%`),
        ilike(loginLogsTable.ip, `%${q.search}%`),
        ilike(loginLogsTable.device, `%${q.search}%`),
        ilike(usersTable.name, `%${q.search}%`),
      ));
    }
    const from = parseDateBound(rawQuery?.from);
    const to = parseDateBound(rawQuery?.to);
    if (from) conds.push(gte(loginLogsTable.createdAt, new Date(`${from}T00:00:00.000Z`)));
    if (to) conds.push(lte(loginLogsTable.createdAt, new Date(`${to}T23:59:59.999Z`)));
    // The tiles show all / success / failed side by side, so they must ignore
    // the status tab - but they DO honour the search box and the date window,
    // otherwise they would describe a different set from the table below them.
    const statsWhere = conds.length ? and(...conds) : undefined;
    if (statuses?.length) conds.push(inArray(loginLogsTable.status, statuses));
    const where = conds.length ? and(...conds) : undefined;

    const rowsQ = this.db
      .select({
        id: loginLogsTable.id,
        userId: loginLogsTable.userId,
        email: loginLogsTable.email,
        status: loginLogsTable.status,
        ip: loginLogsTable.ip,
        device: loginLogsTable.device,
        createdAt: loginLogsTable.createdAt,
        userName: usersTable.name,
      })
      .from(loginLogsTable)
      .leftJoin(usersTable, eq(loginLogsTable.userId, usersTable.id))
      .where(where)
      // `id` tiebreak - a burst of attempts shares a `created_at`.
      .orderBy(desc(loginLogsTable.createdAt), desc(loginLogsTable.id))
      .$dynamic();

    if (!paged) {
      const limit = Math.min(Math.max(1, parseInt(rawQuery?.limit || "100", 10) || 100), 500);
      return rowsQ.limit(limit);
    }

    const [rows, totalRow, statusRows] = await Promise.all([
      rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize),
      this.db.select({ total: count() })
        .from(loginLogsTable)
        .leftJoin(usersTable, eq(loginLogsTable.userId, usersTable.id))
        .where(where),
      this.db.select({ status: loginLogsTable.status, cnt: count() })
        .from(loginLogsTable)
        .leftJoin(usersTable, eq(loginLogsTable.userId, usersTable.id))
        .where(statsWhere)
        .groupBy(loginLogsTable.status),
    ]);
    const byStatus: Record<string, number> = {};
    let all = 0;
    for (const r of statusRows as Array<{ status: string; cnt: number }>) {
      byStatus[r.status] = Number(r.cnt);
      all += Number(r.cnt);
    }
    return {
      data: rows,
      page: q.page,
      pageSize: q.pageSize,
      total: Number(totalRow[0]?.total ?? 0),
      stats: { all, byStatus },
    };
  }

  @Patch("users/:userId/unlock")
  async unlock(@Param("userId") userId: string) {
    const id = parseInt(userId, 10);
    const [user] = await this.db.update(usersTable).set({ failedLoginAttempts: 0 }).where(eq(usersTable.id, id)).returning();
    if (!user) throw new NotFoundException("Not found");
    return { success: true, id: user.id };
  }

  @Patch("users/:userId/force-logout")
  async forceLogout(@Param("userId") userId: string) {
    const id = parseInt(userId, 10);
    const [user] = await this.db.update(usersTable)
      .set({ tokenVersion: sql`${usersTable.tokenVersion} + 1` })
      .where(eq(usersTable.id, id))
      .returning();
    if (!user) throw new NotFoundException("Not found");
    return { success: true, id: user.id, tokenVersion: user.tokenVersion };
  }

  @Patch("tenants/:tenantId/force-logout")
  async forceLogoutTenant(@Param("tenantId") tenantId: string) {
    const id = parseInt(tenantId, 10);
    const [tenant] = await this.db.update(tenantsTable)
      .set({ tokenVersion: sql`${tenantsTable.tokenVersion} + 1` })
      .where(eq(tenantsTable.id, id))
      .returning();
    if (!tenant) throw new NotFoundException("Not found");
    return { success: true, id: tenant.id, tokenVersion: tenant.tokenVersion };
  }

  /**
   * Send a test push notification to a tenant via Expo Push API.
   * Body: { title?: string, body?: string, data?: object }
   */
  @Post("tenants/:tenantId/push-test")
  async pushTest(@Param("tenantId") tenantId: string, @Body() body: { title?: string; body?: string; data?: Record<string, unknown> }) {
    const id = parseInt(tenantId, 10);
    const [tenant] = await this.db.select({
      id: tenantsTable.id,
      name: tenantsTable.name,
      fcmToken: tenantsTable.fcmToken,
      fcmPlatform: tenantsTable.fcmPlatform,
    }).from(tenantsTable).where(eq(tenantsTable.id, id));

    if (!tenant) throw new NotFoundException("Tenant not found");
    if (!tenant.fcmToken) throw new BadRequestException("لا يوجد رمز إشعارات لهذا المستأجر. يجب أن يسجّل دخوله على التطبيق أولاً ويوافق على الإشعارات.");

    const result = await sendExpoPush([{
      to: tenant.fcmToken,
      title: body.title || "دارا",
      body: body.body || `مرحباً ${tenant.name}، هذه رسالة تجريبية.`,
      data: body.data || { type: "test" },
    }]);

    return {
      success: result.ok,
      tenant: { id: tenant.id, name: tenant.name, platform: tenant.fcmPlatform },
      expo: result.response,
    };
  }

  @Patch("users/:userId")
  async updateUser(@CurrentUser() admin: AuthUser, @Param("userId") userId: string, @Body() body: any) {
    const id = parseInt(userId, 10);
    if (id === admin.id) throw new BadRequestException("لا يمكن تعديل حسابك الخاص");
    const updateData: Record<string, unknown> = {};
    if (body.isActive !== undefined) updateData.isActive = body.isActive;
    if (body.name !== undefined) updateData.name = body.name;

    // Role assignment is by role *key* (e.g. "user", "admin", "accountant")
    // — we look up the system role row and link via role_id. The legacy
    // role/roleLabel/permissions columns no longer exist on users.
    if (body.role !== undefined && typeof body.role === "string") {
      const [r] = await this.db.select({ id: rolesTable.id })
        .from(rolesTable)
        .where(and(eq(rolesTable.key, body.role), isNull(rolesTable.companyId)))
        .limit(1);
      if (!r) throw new BadRequestException(`Unknown role: ${body.role}`);
      updateData.roleId = r.id;
    }

    const [user] = await this.db.update(usersTable).set(updateData).where(eq(usersTable.id, id)).returning();
    if (!user) throw new NotFoundException("Not found");
    const [r] = user.roleId ? await this.db.select({ key: rolesTable.key, labelAr: rolesTable.labelAr, permissions: rolesTable.permissions }).from(rolesTable).where(eq(rolesTable.id, user.roleId)) : [null];
    return {
      id: user.id,
      isActive: user.isActive,
      role: r?.key ?? null,
      roleLabel: r?.labelAr ?? null,
      permissions: r?.permissions ?? [],
    };
  }

  @Get("permissions/catalog")
  permissionsCatalog() {
    return { catalog: ALL_PERMISSIONS, presets: ROLE_PRESETS };
  }

  @Delete("users/:userId")
  async deleteUser(@CurrentUser() admin: AuthUser, @Param("userId") userId: string) {
    const id = parseInt(userId, 10);
    if (id === admin.id) throw new BadRequestException("لا يمكن حذف حسابك الخاص");
    const [user] = await this.db.delete(usersTable).where(eq(usersTable.id, id)).returning();
    if (!user) throw new NotFoundException("Not found");
    return { success: true };
  }

  /**
   * Registrations awaiting (or past) approval.
   *
   * `status`, `search` and `userType` all resolve in SQL. Both the
   * `isCustomerAccount` topology test and the status filter used to run over
   * the fetched array, and the admin tab's search box was a third filter on top
   * - so "search" meant "search what has already been downloaded".
   *
   * Pagination is opt-in; the tab's existing `?status=pending` call still gets
   * a bare array.
   */
  @Get("registrations")
  async registrations(@Query() rawQuery: any) {
    const paged = wantsPagination(rawQuery);
    const q = listQuerySchema.parse(rawQuery ?? {});
    const status = typeof rawQuery?.status === "string" && rawQuery.status ? rawQuery.status : "all";

    const conds: any[] = [isCustomerAccountSql];
    if (status !== "all") conds.push(eq(usersTable.accountStatus, status as any));
    if (q.search) {
      conds.push(or(
        ilike(usersTable.name, `%${q.search}%`),
        ilike(usersTable.email, `%${q.search}%`),
        ilike(usersTable.phone, `%${q.search}%`),
        ilike(companiesTable.name, `%${q.search}%`),
      ));
    }
    const userTypes = typeof rawQuery?.userType === "string" && rawQuery.userType.trim()
      ? rawQuery.userType.split(",").map((x: string) => x.trim()).filter(Boolean) : undefined;
    if (userTypes?.length) conds.push(inArray(usersTable.userType, userTypes as any));
    const from = parseDateBound(rawQuery?.from);
    const to = parseDateBound(rawQuery?.to);
    if (from) conds.push(gte(usersTable.createdAt, new Date(`${from}T00:00:00.000Z`)));
    if (to) conds.push(lte(usersTable.createdAt, new Date(`${to}T23:59:59.999Z`)));
    const where = and(...conds);

    let rowsQ = this.db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        phone: usersTable.phone,
        accountStatus: usersTable.accountStatus,
        isActive: usersTable.isActive,
        createdAt: usersTable.createdAt,
        packagePlan: usersTable.packagePlan,
        desiredPackagePlan: usersTable.desiredPackagePlan,
        desiredBillingCycle: usersTable.desiredBillingCycle,
        subscriptionStatus: usersTable.subscriptionStatus,
        subscriptionEndsAt: usersTable.subscriptionEndsAt,
        subscriptionIsTrial: usersTable.subscriptionIsTrial,
        userType: usersTable.userType,
        emailVerified: usersTable.emailVerified,
        emailVerifiedAt: usersTable.emailVerifiedAt,
        roleKey: rolesTable.key,
        ownerUserId: usersTable.ownerUserId,
        companyName: companiesTable.name,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
      .where(where)
      // Oldest registration first (the queue is worked front to back), `id` as
      // the tiebreak on a non-unique `created_at`.
      .orderBy(asc(usersTable.createdAt), asc(usersTable.id))
      .$dynamic();
    if (paged) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow] = await Promise.all([
      rowsQ,
      paged ? this.db.select({ total: count() })
        .from(usersTable)
        .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
        .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
        .where(where) : Promise.resolve([{ total: 0 }]),
    ]);

    const data = rows.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      company: u.companyName,
      role: u.roleKey,
      accountStatus: u.accountStatus,
      isActive: u.isActive,
      packagePlan: u.packagePlan,
      desiredPackagePlan: u.desiredPackagePlan,
      desiredBillingCycle: u.desiredBillingCycle,
      subscriptionStatus: u.subscriptionStatus,
      subscriptionEndsAt: u.subscriptionEndsAt,
      isTrial: u.subscriptionIsTrial,
      userType: u.userType,
      emailVerified: u.emailVerified,
      emailVerifiedAt: u.emailVerifiedAt,
      createdAt: u.createdAt,
    }));
    if (!paged) return data;
    return { data, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0) };
  }

  /**
   * The sidebar's pending-registrations badge, polled every 60 seconds.
   *
   * Counted by the database. It used to SELECT every user row in the system,
   * apply `isCustomerAccount` in JavaScript and return the array length -
   * a full table scan across the wire, once a minute, per open admin tab.
   */
  @Get("registrations/pending-count")
  async pendingCount() {
    const [row] = await this.db
      .select({ c: count() })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .where(and(isCustomerAccountSql, eq(usersTable.accountStatus, "pending")));
    return { count: Number(row?.c ?? 0) };
  }

  /**
   * Ensure an individual-owner account has its single landlord record —
   * the account holder is his own sole landlord. Idempotent.
   */
  private async ensureSoleLandlord(user: typeof usersTable.$inferSelect) {
    const [existing] = await this.db.select({ id: ownersTable.id })
      .from(ownersTable)
      .where(and(eq(ownersTable.userId, user.id), isNull(ownersTable.deletedAt)))
      .limit(1);
    if (existing) return;
    await this.db.insert(ownersTable).values({
      userId: user.id,
      name: user.name,
      type: "individual",
      phone: user.phone ?? null,
      email: user.email,
      status: "active",
    });
  }

  /**
   * Approve a registration, on a package the admin picks.
   *
   * Two outcomes:
   *  - default → account is active but the subscription is `pending_payment`;
   *    the user lands on the pay screen and the package they PAY for wins.
   *  - `trialDays` / `grantWithoutPayment` / `subscriptionEndsAt` → the admin
   *    grants the window outright: the chosen package is live immediately, no
   *    payment required, and the pay screen is skipped.
   *
   * When the window is granted, the user's own landing-page selection is
   * cleared. Leaving it set meant the pay screen (and any later "continue
   * payment" nudge) still advertised the plan they asked for rather than the
   * one the admin actually gave them.
   */
  @Patch("registrations/:id/approve")
  async approve(@Param("id") id: string, @Body() body: { packagePlan?: string; subscriptionEndsAt?: string; grantWithoutPayment?: boolean; trialDays?: number } | undefined) {
    const uid = parseInt(id, 10);
    const [existing] = await this.db.select({ desiredPlan: usersTable.desiredPackagePlan, desiredCycle: usersTable.desiredBillingCycle, userType: usersTable.userType })
      .from(usersTable).where(eq(usersTable.id, uid));
    if (!existing) throw new NotFoundException("User not found");
    const plan = resolveAdminPlan(body?.packagePlan, existing.desiredPlan);
    // Company-only plans stay company-only even when an admin assigns them —
    // approval is the other door into `users.package_plan`.
    if (!planAllowedForUserType(plan, existing.userType)) {
      throw new BadRequestException(planUserTypeError(plan));
    }
    const cycle = existing.desiredCycle === "yearly" ? "yearly" : "monthly";

    const trialDays = normalizeTrialDays(body?.trialDays);
    const manualGrant = trialDays != null || !!body?.subscriptionEndsAt || !!body?.grantWithoutPayment;
    const win = manualGrant ? subscriptionWindow({ endsAtIso: body?.subscriptionEndsAt, trialDays: trialDays ?? undefined }) : null;
    const [user] = await this.db.update(usersTable)
      .set({
        accountStatus: "active", isActive: true, packagePlan: plan, billingCycle: cycle,
        subscriptionStatus: manualGrant ? "active" : "pending_payment",
        subscriptionStartedAt: manualGrant ? win!.startedAt : null,
        subscriptionEndsAt: manualGrant ? win!.endsAt : null,
        subscriptionIsTrial: manualGrant && trialDays != null,
        // A granted window is the decision — don't leave a stale "wanted plan"
        // behind to reappear on the billing screen.
        desiredPackagePlan: manualGrant ? null : existing.desiredPlan,
        desiredBillingCycle: manualGrant ? null : existing.desiredCycle,
      })
      .where(eq(usersTable.id, uid))
      .returning();
    if (!user) throw new NotFoundException("User not found");
    // Fire-and-forget the approval notice — must not block the API response.
    void this.email.sendRegistrationApproved(user.email, user.name);
    return {
      success: true, id: user.id, accountStatus: user.accountStatus, packagePlan: plan,
      subscriptionStatus: user.subscriptionStatus, subscriptionEndsAt: user.subscriptionEndsAt,
      trialDays: trialDays ?? null, granted: manualGrant,
    };
  }

  /**
   * Change a user's subscription package (and renew the window) at any time.
   * Accepts the same `trialDays` shorthand as approval, and activates the
   * subscription — an admin granting a package by hand is granting access, so
   * leaving the account on `pending_payment` would hand it the paywall
   * instead of the package.
   */
  @Patch("users/:userId/package")
  async changePackage(@Param("userId") userId: string, @Body() body: { packagePlan?: string; subscriptionEndsAt?: string; trialDays?: number }) {
    const id = parseInt(userId, 10);
    const [target] = await this.db.select({ userType: usersTable.userType, desiredPlan: usersTable.desiredPackagePlan })
      .from(usersTable).where(eq(usersTable.id, id));
    if (!target) throw new NotFoundException("User not found");
    const plan = resolveAdminPlan(body?.packagePlan, target.desiredPlan);
    if (!planAllowedForUserType(plan, target.userType)) {
      throw new BadRequestException(planUserTypeError(plan));
    }
    const trialDays = normalizeTrialDays(body?.trialDays);
    const win = subscriptionWindow({ endsAtIso: body?.subscriptionEndsAt, trialDays: trialDays ?? undefined });
    const [user] = await this.db.update(usersTable)
      .set({
        packagePlan: plan,
        subscriptionStatus: "active",
        subscriptionStartedAt: win.startedAt,
        subscriptionEndsAt: win.endsAt,
        subscriptionIsTrial: trialDays != null,
        desiredPackagePlan: null,
        desiredBillingCycle: null,
      })
      .where(eq(usersTable.id, id))
      .returning();
    if (!user) throw new NotFoundException("User not found");
    return { success: true, id: user.id, packagePlan: plan, subscriptionEndsAt: win.endsAt, trialDays: trialDays ?? null };
  }

  /** Re-send the email-verification link to a pending registrant. */
  @Post("registrations/:id/resend-verification")
  async resendVerification(@Param("id") id: string) {
    const uid = parseInt(id, 10);
    const [user] = await this.db.select().from(usersTable)
      .where(and(eq(usersTable.id, uid), isNull(usersTable.deletedAt)));
    if (!user) throw new NotFoundException("User not found");
    if (user.emailVerified) return { success: true, alreadyVerified: true };
    const verify = newEmailVerifyToken();
    await this.db.update(usersTable)
      .set({ emailVerifyTokenHash: verify.tokenHash, emailVerifyExpiresAt: verify.expiresAt })
      .where(eq(usersTable.id, uid));
    void this.email.sendVerifyEmail(user.email, user.name, verify.token, user.ownerUserId != null);
    return { success: true };
  }

  @Patch("registrations/:id/reject")
  async reject(@Param("id") id: string, @Body() body: { reason?: string } | undefined) {
    const uid = parseInt(id, 10);
    const [user] = await this.db.update(usersTable)
      .set({ accountStatus: "rejected", isActive: false })
      .where(eq(usersTable.id, uid))
      .returning();
    if (!user) throw new NotFoundException("User not found");
    void this.email.sendRegistrationRejected(user.email, user.name, body?.reason ?? null);
    return { success: true, id: user.id, accountStatus: user.accountStatus };
  }

  @Post("demo/reset")
  async demoReset() {
    const [demoUser] = await this.db.select().from(usersTable).where(eq(usersTable.email, "demo@platform.com"));
    if (!demoUser) throw new NotFoundException("Demo user not found");
    const demoUserId = demoUser.id;
    await this.db.delete(paymentsTable).where(eq(paymentsTable.userId, demoUserId));
    await this.db.delete(contractsTable).where(eq(contractsTable.userId, demoUserId));
    await this.db.delete(unitsTable).where(
      sql`${unitsTable.propertyId} IN (SELECT id FROM properties WHERE user_id = ${demoUserId})`
    );
    await this.db.delete(propertiesTable).where(eq(propertiesTable.userId, demoUserId));
    await seedDemoData(this.db, demoUserId);
    return { success: true, message: "تم إعادة ضبط بيانات الحساب التجريبي" };
  }
}

/**
 * `AdminCustomerOverviewController` lives in its own file — this one is
 * already long enough — but it is the same admin surface, behind the same
 * `JwtAuthGuard` + `SuperAdminGuard` pair as everything above, and the
 * account lists here (`GET /admin/companies`, `GET /admin/users`) are what
 * link into it: both already carry the account's `id` on every row.
 */
@Module({ imports: [EjarModule], controllers: [AdminController, AdminCustomerOverviewController] })
export class AdminModule {}
