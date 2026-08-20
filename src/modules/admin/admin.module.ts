import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Module, NotFoundException, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { sendExpoPush } from "../../common/push";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { usersTable, propertiesTable, unitsTable, contractsTable, paymentsTable, loginLogsTable, tenantsTable, rolesTable, companiesTable, ownersTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../common/guards/roles.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { seedDemoData } from "./demo-seed";
import { ALL_PERMISSIONS, ROLE_PRESETS, isCustomerAccount } from "../../common/permissions";
import { EmailService } from "../email/email.service";
import { isPackagePlan, planAllowedForUserType, planUserTypeError, type PackagePlan } from "../../common/packages";
import { newEmailVerifyToken } from "../../common/email-verification";
import { EjarModule } from "../ejar/ejar.module";
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

  @Get("stats")
  async stats() {
    // Join the role row so we filter by `roles.key` rather than the dropped
    // `users.role` enum. "Companies" here = customer landlords (user/demo);
    // internal team rows (super_admin/admin) are excluded.
    const allUsers = await this.db
      .select({
        id: usersTable.id,
        isActive: usersTable.isActive,
        roleKey: rolesTable.key,
        ownerUserId: usersTable.ownerUserId,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id));
    const companies = allUsers.filter(isCustomerAccount);
    const [totalProps] = await this.db.select({ count: count() }).from(propertiesTable);
    const [totalUnits] = await this.db.select({ count: count() }).from(unitsTable);
    const [totalContracts] = await this.db.select({ count: count() }).from(contractsTable);
    const contracts = await this.db.select().from(contractsTable);
    const activeContracts = contracts.filter(c => c.status === "active").length;
    const monthlyRecurring = contracts.filter(c => c.status === "active").reduce((s, c) => s + parseFloat(c.monthlyRent), 0);

    const payments = await this.db.select().from(paymentsTable);
    const now = new Date();
    const num = (s: string | null) => parseFloat(s || "0") || 0;
    const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const monthlyData = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const monthName = d.toLocaleDateString("ar-SA", { month: "short" });
      const revenue = payments.filter(p => p.status === "paid" && p.paidDate && p.paidDate.startsWith(key)).reduce((s, p) => s + num(p.amount), 0);
      return { month: monthName, revenue };
    });

    // monthlyRevenue is now actual collected money this month (sum of paid
    // payments whose paidDate falls in the current month). The previous value
    // (sum of active contracts' monthlyRent) is exposed as `monthlyRecurring`.
    const monthlyRevenue = payments
      .filter(p => p.status === "paid" && p.paidDate && p.paidDate.startsWith(currentKey))
      .reduce((s, p) => s + num(p.amount), 0);

    const collectedTotal = payments
      .filter(p => p.status === "paid")
      .reduce((s, p) => s + num(p.amount), 0);

    const pendingDue = payments
      .filter(p => p.status === "pending" || p.status === "overdue")
      .reduce((s, p) => s + num(p.amount), 0);

    return {
      totalCompanies: companies.length,
      activeCompanies: companies.filter(u => u.isActive).length,
      totalUsers: allUsers.length,
      activeUsers: allUsers.filter(u => u.isActive).length,
      totalProperties: totalProps?.count ?? 0,
      totalUnits: totalUnits?.count ?? 0,
      totalContracts: totalContracts?.count ?? 0,
      activeContracts,
      monthlyRevenue,
      monthlyRecurring,
      collectedTotal,
      pendingDue,
      monthlyData,
    };
  }

  @Get("companies")
  async companies() {
    const rows = await this.db
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
      .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id));
    const companies = rows.filter(isCustomerAccount);
    return Promise.all(companies.map(async (user) => {
      const [propCount] = await this.db.select({ count: count() }).from(propertiesTable).where(eq(propertiesTable.userId, user.id));
      const [unitCount] = await this.db.select({ count: count() }).from(unitsTable)
        .innerJoin(propertiesTable, eq(unitsTable.propertyId, propertiesTable.id))
        .where(eq(propertiesTable.userId, user.id));
      const [contractCount] = await this.db.select({ count: count() }).from(contractsTable).where(eq(contractsTable.userId, user.id));
      // Linked people under this account — visible to the admin as counts and
      // drilled into via GET /admin/companies/:id/members.
      const [empCount] = await this.db.select({ count: count() }).from(usersTable)
        .where(and(eq(usersTable.ownerUserId, user.id), isNull(usersTable.deletedAt)));
      const [landlordCount] = await this.db.select({ count: count() }).from(ownersTable)
        .where(and(eq(ownersTable.userId, user.id), isNull(ownersTable.deletedAt)));
      const [tenantCount] = await this.db.select({ count: count() }).from(tenantsTable)
        .where(and(eq(tenantsTable.userId, user.id), isNull(tenantsTable.deletedAt)));
      return {
        id: user.id,
        name: user.companyName || user.name,
        email: user.email,
        role: user.roleKey,
        isActive: user.isActive,
        phone: user.phone,
        plan: user.roleKey === "demo" ? "تجريبي" : "مجاني",
        propertiesCount: Number(propCount?.count ?? 0),
        unitsCount: Number(unitCount?.count ?? 0),
        contractsCount: Number(contractCount?.count ?? 0),
        employeesCount: Number(empCount?.count ?? 0),
        landlordsCount: Number(landlordCount?.count ?? 0),
        tenantsCount: Number(tenantCount?.count ?? 0),
        createdAt: user.createdAt,
      };
    }));
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
  @Get("users")
  async users() {
    const rows = await this.db
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
      .orderBy(usersTable.createdAt);
    const teamOnly = rows.filter(u => u.roleKey === "super_admin" || u.roleKey === "admin");
    return Promise.all(teamOnly.map(async (user) => {
      const [propCount] = await this.db.select({ count: count() }).from(propertiesTable).where(eq(propertiesTable.userId, user.id));
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.roleKey,
        isActive: user.isActive,
        phone: user.phone,
        company: user.companyName,
        propertiesCount: Number(propCount?.count ?? 0),
        loginCount: user.loginCount ?? 0,
        lastLoginAt: user.lastLoginAt,
        failedLoginAttempts: user.failedLoginAttempts ?? 0,
        createdAt: user.createdAt,
      };
    }));
  }

  @Get("login-history")
  async loginHistory(@Query("limit") limitQ?: string, @Query("status") statusQ?: string) {
    const limit = Math.min(parseInt(limitQ || "100", 10), 500);
    const logs = await this.db
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
      .orderBy(desc(loginLogsTable.createdAt))
      .limit(limit);
    return statusQ ? logs.filter(l => l.status === statusQ) : logs;
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

  @Get("registrations")
  async registrations(@Query("status") statusQ?: string) {
    const status = statusQ || "all";
    let rows = await this.db
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
      .orderBy(usersTable.createdAt);
    rows = rows.filter(isCustomerAccount);
    if (status !== "all") rows = rows.filter(u => u.accountStatus === status);
    return rows.map(u => ({
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
  }

  @Get("registrations/pending-count")
  async pendingCount() {
    const rows = await this.db
      .select({ accountStatus: usersTable.accountStatus, roleKey: rolesTable.key, ownerUserId: usersTable.ownerUserId })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id));
    const c = rows.filter(u => isCustomerAccount(u) && u.accountStatus === "pending").length;
    return { count: c };
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

@Module({ imports: [EjarModule], controllers: [AdminController] })
export class AdminModule {}
