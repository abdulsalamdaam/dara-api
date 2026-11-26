import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, Injectable, Module,
  NotFoundException, Param, Patch, Post, UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcryptjs";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  accountAccessTable, accountGroupsTable, companiesTable, rolesTable, usersTable, type AccountGroup,
} from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard, type AuthUser } from "../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../common/guards/roles.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { EMPLOYEE_PRESETS, STAFF_ROLE_KEYS } from "../../common/permissions";
import { EMPLOYEE_PRESET_KEYS } from "../../common/rbac";
import {
  isPackagePlan, planAllowedForUserType, planUserTypeError, isBillingCycle, purchasableCycle, resolvePackage,
  listPrice, chargedVatRate,
} from "../../common/packages";
import { assertEmailAvailable, emailTakenException, isEmailUniqueViolation, normalizeEmail } from "../../common/user-email";
import {
  accountRows, extraAccountListPrice, extraAccountYearlyPrice, memberPriceOverride, sharedPriceLines, groupMemberIds, groupOfAccount, resolveActingAccess,
  switchableAccountIds, syncSharedSubscription, sharedPlanMisfit, sharedPlanMisfitMessage,
} from "../../common/linked-accounts";
import { deriveSubscription } from "../../common/subscription";
import { signalFv2Entitlement } from "../finance-v2/auto-provision-signal"; // finance-v2: accountant note 3 — provision a new account at creation

/** Most member accounts a group may hold (primary included). */
export function maxLinkedAccounts(): number {
  const n = Number(process.env.LINKED_ACCOUNTS_MAX);
  return Number.isInteger(n) && n >= 2 ? n : 20;
}

type ActorRow = typeof usersTable.$inferSelect & { roleKey: string | null };

/**
 * Linked accounts — see common/linked-accounts.ts for the model.
 *
 * Everything here acts as the PERSON signed in (`actorUserId ?? id`), never as
 * the account a session happens to be switched into: the primary can manage
 * the group from inside any member account.
 */
@Injectable()
export class LinkedAccountsService {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle, private readonly jwt: JwtService) {}

  private async actorRow(user: AuthUser): Promise<ActorRow> {
    if (!user || user.ownerScopeId != null || user.role === "owner") throw new ForbiddenException("Forbidden");
    const id = user.actorUserId ?? user.id;
    const [row] = await this.db.select({ u: usersTable, roleKey: rolesTable.key }).from(usersTable)
      .leftJoin(rolesTable, eq(rolesTable.id, usersTable.roleId))
      .where(and(eq(usersTable.id, id), isNull(usersTable.deletedAt)));
    if (!row) throw new NotFoundException("User not found");
    return { ...row.u, roleKey: row.roleKey ?? null };
  }

  /** The person may manage a group: an active customer account holder that is its primary (or in no group yet). */
  private async manager(user: AuthUser): Promise<{ actor: ActorRow; group: AccountGroup | null }> {
    const actor = await this.actorRow(user);
    if (actor.ownerUserId != null) throw new ForbiddenException({ code: "LINKED_PRIMARY_ONLY", message: "إدارة الحسابات المرتبطة لصاحب الحساب الرئيسي فقط" });
    if ((STAFF_ROLE_KEYS as readonly string[]).includes(actor.roleKey ?? "") || actor.roleKey === "demo") throw new ForbiddenException("Forbidden");
    const group = await groupOfAccount(this.db, actor.id);
    if (group && group.primaryUserId !== actor.id) {
      throw new ForbiddenException({ code: "LINKED_PRIMARY_ONLY", message: "هذا الحساب مرتبط بحساب رئيسي — الإدارة من الحساب الرئيسي فقط" });
    }
    return { actor, group };
  }

  private async ensureGroup(actor: ActorRow, group: AccountGroup | null): Promise<AccountGroup> {
    if (group) return group;
    const [created] = await this.db.insert(accountGroupsTable).values({ primaryUserId: actor.id })
      .onConflictDoNothing().returning();
    const g = created ?? (await this.db.select().from(accountGroupsTable).where(eq(accountGroupsTable.primaryUserId, actor.id)))[0];
    if (!g) throw new BadRequestException("تعذّر إنشاء مجموعة الحسابات");
    await this.db.update(usersTable).set({ accountGroupId: g.id }).where(eq(usersTable.id, actor.id));
    return g;
  }

  /** Shared-mode price preview for the primary's plan on its cycle (before VAT), priced per account. */
  private async pricing(group: AccountGroup | null, primary: { packagePlan: string; billingCycle: string }, memberCount: number) {
    const cycle = purchasableCycle(primary.billingCycle);
    const base = listPrice(primary.packagePlan, cycle);
    const extra = group ? extraAccountListPrice(group, primary.packagePlan, cycle) : null;
    const extras = Math.max(0, memberCount - 1);
    const lines = group ? await sharedPriceLines(this.db, group, primary.packagePlan, cycle) : [];
    const priced = lines.length > 0 && lines.every((l) => l.list != null);
    return {
      mode: group?.billingMode ?? "separate",
      cycle,
      plan: resolvePackage(primary.packagePlan).key,
      basePrice: lines.find((l) => l.isPrimary)?.list ?? base,
      extraAccounts: extras,
      extraAccountPrice: extra,
      extraAccountYearlyPrice: group ? extraAccountYearlyPrice(group, primary.packagePlan) : null,
      specialPrice: group?.extraAccountPriceYearly != null || lines.some((l) => l.custom),
      perAccount: lines.map((l) => ({ accountId: l.accountId, price: l.list, custom: l.custom })),
      total: priced ? lines.reduce((t, l) => t + l.list!, 0) : (base != null && extra != null ? base + extras * extra : null),
      vatRate: chargedVatRate(),
    };
  }

  /** The group as the signed-in person sees it. */
  async overview(user: AuthUser) {
    const actor = await this.actorRow(user);
    const s = await switchableAccountIds(this.db, actor.id);
    const group = s.groupId ? (await this.db.select().from(accountGroupsTable).where(eq(accountGroupsTable.id, s.groupId)))[0] ?? null : null;
    const isPrimary = actor.ownerUserId == null && (!group || group.primaryUserId === actor.id);
    const canManage = isPrimary && !(STAFF_ROLE_KEYS as readonly string[]).includes(actor.roleKey ?? "") && actor.roleKey !== "demo";
    const memberIds = group ? await groupMemberIds(this.db, group) : [actor.ownerUserId ?? actor.id];
    const visibleIds = canManage ? memberIds : s.ids;
    const rows = await accountRows(this.db, visibleIds);
    const now = new Date();
    const accounts = rows.map((r) => ({
      id: r.id, name: r.name, email: r.email, userType: r.userType, commercialReg: r.commercialReg,
      packagePlan: resolvePackage(r.packagePlan).key, isActive: r.isActive,
      isPrimary: group ? r.id === group.primaryUserId : r.id === actor.id,
      isHome: r.id === s.home,
      current: r.id === (user.ownerUserId ?? user.id),
      onboarded: r.onboardedAt != null,
      subscription: deriveSubscription({ storedStatus: r.subscriptionStatus, subscriptionEndsAt: r.subscriptionEndsAt, now }).status,
      subscriptionEndsAt: r.subscriptionEndsAt,
    }));

    let employees: Array<{ id: number; name: string; email: string; homeAccountId: number; roleKey: string | null; access: Array<{ accountId: number; roleKey: string }> }> = [];
    if (canManage && group) {
      const emps = await this.db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, ownerUserId: usersTable.ownerUserId, roleKey: rolesTable.key })
        .from(usersTable).leftJoin(rolesTable, eq(rolesTable.id, usersTable.roleId))
        .where(and(inArray(usersTable.ownerUserId, memberIds), isNull(usersTable.deletedAt), eq(usersTable.isActive, true)));
      const grants = emps.length ? await this.db.select({ userId: accountAccessTable.userId, accountId: accountAccessTable.accountId, roleKey: rolesTable.key })
        .from(accountAccessTable).innerJoin(rolesTable, eq(rolesTable.id, accountAccessTable.roleId))
        .where(and(eq(accountAccessTable.groupId, group.id), inArray(accountAccessTable.userId, emps.map((e) => e.id)))) : [];
      employees = emps.map((e) => ({
        id: e.id, name: e.name, email: e.email, homeAccountId: e.ownerUserId!, roleKey: e.roleKey ?? null,
        access: grants.filter((g) => g.userId === e.id && memberIds.includes(g.accountId)).map((g) => ({ accountId: g.accountId, roleKey: g.roleKey })),
      }));
    }

    const [primary] = group
      ? await this.db.select({ packagePlan: usersTable.packagePlan, billingCycle: usersTable.billingCycle }).from(usersTable).where(eq(usersTable.id, group.primaryUserId))
      : [{ packagePlan: actor.packagePlan, billingCycle: actor.billingCycle }];
    return {
      group: group ? { id: group.id, name: group.name, primaryUserId: group.primaryUserId, billingMode: group.billingMode } : null,
      isPrimary,
      canManage,
      maxAccounts: maxLinkedAccounts(),
      accounts,
      employees,
      presets: EMPLOYEE_PRESET_KEYS.map((k) => ({ key: k, labelAr: EMPLOYEE_PRESETS[k]!.labelAr, labelEn: EMPLOYEE_PRESETS[k]!.labelEn })),
      billing: await this.pricing(group, primary ?? { packagePlan: actor.packagePlan, billingCycle: actor.billingCycle }, memberIds.length),
    };
  }

  /** A token for working in `accountId` (or back in the person's own account). */
  async switchTo(user: AuthUser, rawAccountId: unknown) {
    const accountId = Number(rawAccountId);
    if (!Number.isInteger(accountId) || accountId <= 0) throw new BadRequestException("الحساب غير صالح");
    const actor = await this.actorRow(user);
    const home = actor.ownerUserId ?? actor.id;
    if (accountId !== home) {
      const access = await resolveActingAccess(this.db, { id: actor.id, ownerUserId: actor.ownerUserId ?? null }, accountId);
      if (!access) throw new ForbiddenException({ code: "ACCOUNT_SWITCH_DENIED", message: "لا تملك صلاحية الدخول إلى هذا الحساب" });
    }
    // Same person, same session: the token keeps the session's `tv` and
    // `loginAt`, so it is signed out by exactly what would sign out the
    // original (logout, a later login elsewhere, force-logout).
    const claims = {
      id: actor.id, email: actor.email, role: actor.roleKey ?? "user", kind: "user" as const, tv: user.tv ?? actor.tokenVersion,
      ...(user.loginAt != null ? { loginAt: user.loginAt } : {}),
      ...(user.ch ? { ch: user.ch } : {}),
      ...(accountId !== home ? { act: accountId } : {}),
    };
    return { token: this.jwt.sign(claims), accountId };
  }

  /** Add a new account under the primary (creating the group on first use). */
  async addAccount(user: AuthUser, body: any) {
    const { actor, group: existing } = await this.manager(user);
    if (!actor.isActive || actor.accountStatus !== "active") throw new ForbiddenException("الحساب الرئيسي غير مفعّل");

    const userType = body?.userType === "company" ? "company" : "individual";
    const name = String(body?.name ?? "").trim();
    const companyName = String(body?.companyName ?? "").trim();
    const commercialReg = String(body?.commercialReg ?? "").trim();
    const email = normalizeEmail(body?.email);
    const phone = String(body?.phone ?? "").trim() || null;
    if (!name) throw new BadRequestException({ code: "NAME_REQUIRED", message: "اسم صاحب الحساب مطلوب" });
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException({ code: "EMAIL_INVALID", message: "البريد الإلكتروني غير صالح" });
    }
    if (userType === "company" && !companyName) throw new BadRequestException({ code: "COMPANY_NAME_REQUIRED", message: "اسم المنشأة مطلوب" });
    if (userType === "company" && !/^\d{10}$/.test(commercialReg)) {
      throw new BadRequestException({ code: "COMMERCIAL_REG_REQUIRED", message: "رقم السجل التجاري (10 أرقام) مطلوب" });
    }
    await assertEmailAvailable(this.db, email);

    const group = await this.ensureGroup(actor, existing);
    const members = await groupMemberIds(this.db, group);
    if (members.length >= maxLinkedAccounts()) {
      throw new BadRequestException({ code: "LINKED_LIMIT", message: `الحد الأعلى ${maxLinkedAccounts()} حسابات في المجموعة` });
    }
    // The same CR twice in one group is a mistake, not a second business.
    if (userType === "company") {
      const dupe = await this.db.select({ id: usersTable.id }).from(usersTable)
        .innerJoin(companiesTable, eq(companiesTable.id, usersTable.companyId))
        .where(and(inArray(usersTable.id, members), eq(companiesTable.commercialReg, commercialReg)));
      if (dupe.length) throw new BadRequestException({ code: "CR_ALREADY_LINKED", message: "هذا السجل التجاري مضاف مسبقاً في حساباتك" });
    }

    // Plan: shared billing → the primary's; separate → the one picked (validated like registration).
    const shared = group.billingMode === "shared";
    let plan = actor.packagePlan;
    if (!shared && isPackagePlan(body?.plan)) plan = body.plan;
    if (!planAllowedForUserType(plan, userType)) throw new BadRequestException(planUserTypeError(plan));
    const cycle = isBillingCycle(body?.cycle) ? purchasableCycle(body.cycle) : purchasableCycle(actor.billingCycle);

    // Separate billing: the new account pays for itself. While the primary is
    // on its free trial the new account shares that same trial window (never a
    // fresh one — a new linked account is not a new customer).
    const now = new Date();
    const primarySub = deriveSubscription({ storedStatus: actor.subscriptionStatus, subscriptionEndsAt: actor.subscriptionEndsAt, isTrial: actor.subscriptionIsTrial, now });
    const shareTrial = !shared && actor.subscriptionIsTrial && primarySub.status === "active" && actor.subscriptionEndsAt != null;

    const roleKey = userType === "company" ? "general" : "user";
    const [roleRow] = await this.db.select({ id: rolesTable.id }).from(rolesTable)
      .where(and(eq(rolesTable.key, roleKey), isNull(rolesTable.companyId))).limit(1);

    const created = await this.db.transaction(async (tx) => {
      let companyId: number | null = null;
      if (userType === "company") {
        const [c] = await tx.insert(companiesTable).values({ name: companyName, commercialReg }).returning({ id: companiesTable.id });
        companyId = c?.id ?? null;
      }
      const passwordHash = await bcrypt.hash(`otp-only-${Math.random().toString(36).slice(2)}-${Date.now()}`, 10);
      const [u] = await tx.insert(usersTable).values({
        email, passwordHash, name, phone,
        isActive: true, accountStatus: "active",
        roleId: roleRow?.id ?? null, companyId, userType,
        accountGroupId: group.id,
        packagePlan: plan,
        billingCycle: cycle,
        ...(shareTrial
          ? { subscriptionStatus: "active", subscriptionStartedAt: now, subscriptionEndsAt: actor.subscriptionEndsAt, subscriptionIsTrial: true, trialConsumedAt: now }
          : { subscriptionStatus: "pending_payment", desiredPackagePlan: plan, desiredBillingCycle: cycle }),
      }).returning({ id: usersTable.id }).catch((err: unknown) => {
        if (isEmailUniqueViolation(err)) throw emailTakenException();
        throw err;
      });
      return u!;
    });
    if (shared) await syncSharedSubscription(this.db, group.primaryUserId);
    signalFv2Entitlement(created.id, "linked_account_create"); // finance-v2: start accounting at creation when the plan includes it (async, never throws)
    return { id: created.id, groupId: group.id };
  }

  /** Rename the group (shown in the switcher). */
  async updateGroup(user: AuthUser, body: any) {
    const { actor, group: existing } = await this.manager(user);
    const group = await this.ensureGroup(actor, existing);
    const name = body?.name == null ? null : String(body.name).trim().slice(0, 120) || null;
    await this.db.update(accountGroupsTable).set({ name }).where(eq(accountGroupsTable.id, group.id));
    return { success: true };
  }

  /** Grant / change an employee's access to a member account. */
  async setAccess(user: AuthUser, body: any) {
    const { actor, group } = await this.manager(user);
    if (!group) throw new BadRequestException("لا توجد حسابات مرتبطة بعد");
    const employeeId = Number(body?.userId);
    const accountId = Number(body?.accountId);
    const preset = String(body?.preset ?? "").trim();
    if (!EMPLOYEE_PRESET_KEYS.includes(preset)) throw new BadRequestException(`Unknown role preset: ${preset}`);
    const members = await groupMemberIds(this.db, group);
    if (!members.includes(accountId)) throw new NotFoundException("الحساب ليس ضمن حساباتك المرتبطة");
    const [emp] = await this.db.select({ id: usersTable.id, ownerUserId: usersTable.ownerUserId }).from(usersTable)
      .where(and(eq(usersTable.id, employeeId), isNull(usersTable.deletedAt)));
    if (!emp || emp.ownerUserId == null || !members.includes(emp.ownerUserId)) throw new NotFoundException("الموظف ليس ضمن حساباتك");
    if (emp.ownerUserId === accountId) throw new BadRequestException("هذا حساب الموظف الأصلي — يُدار من إعدادات الفريق");
    const [role] = await this.db.select({ id: rolesTable.id }).from(rolesTable)
      .where(and(eq(rolesTable.key, preset), isNull(rolesTable.companyId), isNull(rolesTable.deletedAt))).limit(1);
    if (!role) throw new BadRequestException("الدور غير موجود");
    await this.db.insert(accountAccessTable)
      .values({ groupId: group.id, userId: emp.id, accountId, roleId: role.id, grantedBy: actor.id })
      .onConflictDoUpdate({
        target: [accountAccessTable.userId, accountAccessTable.accountId],
        set: { roleId: role.id, groupId: group.id, grantedBy: actor.id, updatedAt: new Date() },
      });
    return { success: true };
  }

  async removeAccess(user: AuthUser, rawUserId: string, rawAccountId: string) {
    const { group } = await this.manager(user);
    if (!group) throw new NotFoundException("Not found");
    await this.db.delete(accountAccessTable).where(and(
      eq(accountAccessTable.groupId, group.id),
      eq(accountAccessTable.userId, Number(rawUserId)),
      eq(accountAccessTable.accountId, Number(rawAccountId)),
    ));
    return { success: true };
  }

  /**
   * Take a member account out of the group. Its data, team and subscription
   * stay exactly as they are — it simply becomes a standalone account again
   * (reachable through its own login only). Employee grants into or out of it
   * are removed.
   */
  async unlink(user: AuthUser, rawAccountId: string) {
    const { group } = await this.manager(user);
    const accountId = Number(rawAccountId);
    if (!group) throw new NotFoundException("Not found");
    if (accountId === group.primaryUserId) throw new BadRequestException("لا يمكن فصل الحساب الرئيسي");
    return unlinkMember(this.db, group, accountId);
  }
}

/** Shared by the customer and admin paths. */
export async function unlinkMember(db: Drizzle, group: AccountGroup, accountId: number) {
  const members = await groupMemberIds(db, group);
  if (!members.includes(accountId)) throw new NotFoundException("الحساب ليس ضمن المجموعة");
  await db.transaction(async (tx) => {
    await tx.update(usersTable).set({ accountGroupId: null }).where(eq(usersTable.id, accountId));
    await tx.delete(accountAccessTable).where(eq(accountAccessTable.accountId, accountId));
    // Its special price belongs to this group only — it does not follow the account out.
    if (group.memberPrices && String(accountId) in group.memberPrices) {
      const [cur] = await tx.select({ memberPrices: accountGroupsTable.memberPrices }).from(accountGroupsTable).where(eq(accountGroupsTable.id, group.id));
      const next = { ...(cur?.memberPrices ?? {}) };
      delete next[String(accountId)];
      await tx.update(accountGroupsTable).set({ memberPrices: next }).where(eq(accountGroupsTable.id, group.id));
    }
    const emps = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.ownerUserId, accountId));
    if (emps.length) await tx.delete(accountAccessTable).where(inArray(accountAccessTable.userId, emps.map((e) => e.id)));
  });
  return { success: true };
}

@ApiTags("linked-accounts")
@ApiBearerAuth("user-jwt")
@Controller("me/linked-accounts")
@UseGuards(JwtAuthGuard)
export class LinkedAccountsController {
  constructor(private readonly svc: LinkedAccountsService) {}

  @Get()
  overview(@CurrentUser() user: AuthUser) { return this.svc.overview(user); }

  @Post("switch")
  @HttpCode(200)
  switchTo(@CurrentUser() user: AuthUser, @Body() body: any) { return this.svc.switchTo(user, body?.accountId); }

  @Post("accounts")
  addAccount(@CurrentUser() user: AuthUser, @Body() body: any) { return this.svc.addAccount(user, body); }

  @Delete("accounts/:id")
  unlink(@CurrentUser() user: AuthUser, @Param("id") id: string) { return this.svc.unlink(user, id); }

  @Patch()
  updateGroup(@CurrentUser() user: AuthUser, @Body() body: any) { return this.svc.updateGroup(user, body); }

  @Post("access")
  @HttpCode(200)
  setAccess(@CurrentUser() user: AuthUser, @Body() body: any) { return this.svc.setAccess(user, body); }

  @Delete("access/:userId/:accountId")
  removeAccess(@CurrentUser() user: AuthUser, @Param("userId") userId: string, @Param("accountId") accountId: string) {
    return this.svc.removeAccess(user, userId, accountId);
  }
}


/**
 * Admin console: see a customer's group, set its billing mode and special
 * price, link an existing account or take one out.
 */
@ApiTags("admin")
@ApiBearerAuth("user-jwt")
@Controller("admin/linked-accounts")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class AdminLinkedAccountsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  private async groupById(id: number): Promise<AccountGroup> {
    const [g] = await this.db.select().from(accountGroupsTable).where(eq(accountGroupsTable.id, id));
    if (!g) throw new NotFoundException("Group not found");
    return g;
  }

  private async view(g: AccountGroup | null, accountId: number) {
    if (!g) return { group: null, accountId };
    const ids = await groupMemberIds(this.db, g);
    const rows = await accountRows(this.db, ids);
    const [p] = await this.db.select({ packagePlan: usersTable.packagePlan, billingCycle: usersTable.billingCycle }).from(usersTable).where(eq(usersTable.id, g.primaryUserId));
    const cycle = purchasableCycle(p?.billingCycle);
    const base = listPrice(p?.packagePlan, cycle);
    const extra = extraAccountListPrice(g, p?.packagePlan, cycle);
    const lines = await sharedPriceLines(this.db, g, p?.packagePlan, cycle);
    const byId = new Map(lines.map((l) => [l.accountId, l]));
    const priced = lines.length > 0 && lines.every((l) => l.list != null);
    return {
      accountId,
      group: {
        id: g.id, name: g.name, primaryUserId: g.primaryUserId, billingMode: g.billingMode,
        extraAccountPriceYearly: g.extraAccountPriceYearly != null ? Number(g.extraAccountPriceYearly) : null,
        defaultExtraAccountPriceYearly: extraAccountYearlyPrice({ extraAccountPriceYearly: null }, p?.packagePlan),
      },
      members: rows.map((r) => {
        const l = byId.get(r.id);
        return {
          ...r, isPrimary: r.id === g.primaryUserId,
          // Yearly before VAT: the admin's special price for this account (null = default), and that default.
          priceYearly: memberPriceOverride(g, r.id), defaultPriceYearly: l?.defaultYearly ?? null,
          cyclePrice: l?.list ?? null,
        };
      }),
      pricing: {
        plan: resolvePackage(p?.packagePlan).key, cycle, basePrice: base, extraAccountPrice: extra, extraAccounts: ids.length - 1,
        total: priced ? lines.reduce((t, l) => t + l.list!, 0) : null,
        perAccount: lines.some((l) => l.custom),
      },
    };
  }

  @Get("by-account/:accountId")
  async byAccount(@Param("accountId") accountId: string) {
    const id = Number(accountId);
    return this.view(await groupOfAccount(this.db, id), id);
  }

  /** Make `primaryUserId` the primary of a new (empty) group. */
  @Post()
  async create(@Body() body: any) {
    const id = Number(body?.primaryUserId);
    const [u] = await this.db.select({ id: usersTable.id, ownerUserId: usersTable.ownerUserId, groupId: usersTable.accountGroupId })
      .from(usersTable).where(and(eq(usersTable.id, id), isNull(usersTable.deletedAt)));
    if (!u || u.ownerUserId != null) throw new BadRequestException("الحساب غير صالح ليكون رئيسياً");
    if (u.groupId != null) return this.view(await groupOfAccount(this.db, id), id);
    const [g] = await this.db.insert(accountGroupsTable).values({ primaryUserId: id }).returning();
    await this.db.update(usersTable).set({ accountGroupId: g!.id }).where(eq(usersTable.id, id));
    return this.view(g!, id);
  }

  /** Billing mode and special price. Switching to shared copies the primary's subscription onto every member. */
  @Patch(":groupId")
  async update(@Param("groupId") groupId: string, @Body() body: any) {
    const g = await this.groupById(Number(groupId));
    const set: Partial<typeof accountGroupsTable.$inferInsert> = {};
    if (body?.billingMode !== undefined) {
      if (body.billingMode !== "separate" && body.billingMode !== "shared") throw new BadRequestException("billingMode: separate | shared");
      set.billingMode = body.billingMode;
    }
    if (body?.extraAccountPriceYearly !== undefined) {
      if (body.extraAccountPriceYearly === null || body.extraAccountPriceYearly === "") set.extraAccountPriceYearly = null;
      else {
        const n = Number(body.extraAccountPriceYearly);
        if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new BadRequestException("السعر غير صالح");
        set.extraAccountPriceYearly = n.toFixed(2);
      }
    }
    if (body?.name !== undefined) set.name = body.name ? String(body.name).trim().slice(0, 120) : null;
    // Per-account special prices: { [accountId]: yearly SAR before VAT | null (back to default) }.
    if (body?.memberPrices !== undefined) {
      if (!body.memberPrices || typeof body.memberPrices !== "object" || Array.isArray(body.memberPrices)) throw new BadRequestException("memberPrices غير صالح");
      const ids = await groupMemberIds(this.db, g);
      const next: Record<string, number> = { ...(g.memberPrices ?? {}) };
      for (const [k, v] of Object.entries(body.memberPrices as Record<string, unknown>)) {
        const id = Number(k);
        if (!ids.includes(id)) throw new BadRequestException(`الحساب ${k} ليس ضمن المجموعة`);
        if (v === null || v === "") { delete next[String(id)]; continue; }
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new BadRequestException("السعر غير صالح");
        next[String(id)] = Math.round(n * 100) / 100;
      }
      set.memberPrices = next;
    }
    if ((set.billingMode ?? g.billingMode) === "shared") {
      const [p] = await this.db.select({ plan: usersTable.packagePlan }).from(usersTable).where(eq(usersTable.id, g.primaryUserId));
      const bad = await sharedPlanMisfit(this.db, g, p?.plan);
      if (bad) throw new BadRequestException({ code: "SHARED_PLAN_MISFIT", message: sharedPlanMisfitMessage(p?.plan, bad.name) });
    }
    if (Object.keys(set).length) await this.db.update(accountGroupsTable).set(set).where(eq(accountGroupsTable.id, g.id));
    const next = await this.groupById(g.id);
    if (next.billingMode === "shared") await syncSharedSubscription(this.db, next.primaryUserId);
    return this.view(next, next.primaryUserId);
  }

  /** Link an existing standalone customer account into the group. */
  @Post(":groupId/members")
  async addMember(@Param("groupId") groupId: string, @Body() body: any) {
    const g = await this.groupById(Number(groupId));
    const id = Number(body?.accountId);
    const [u] = await this.db.select({ id: usersTable.id, ownerUserId: usersTable.ownerUserId, groupId: usersTable.accountGroupId, roleKey: rolesTable.key })
      .from(usersTable).leftJoin(rolesTable, eq(rolesTable.id, usersTable.roleId))
      .where(and(eq(usersTable.id, id), isNull(usersTable.deletedAt)));
    if (!u || u.ownerUserId != null || (STAFF_ROLE_KEYS as readonly string[]).includes(u.roleKey ?? "")) throw new BadRequestException("الحساب غير صالح للربط");
    if (u.groupId != null && u.groupId !== g.id) throw new BadRequestException("الحساب مرتبط بمجموعة أخرى — افصله أولاً");
    const members = await groupMemberIds(this.db, g);
    if (!members.includes(id) && members.length >= maxLinkedAccounts()) throw new BadRequestException("تم بلوغ الحد الأعلى للحسابات");
    if (g.billingMode === "shared") {
      const [p] = await this.db.select({ plan: usersTable.packagePlan }).from(usersTable).where(eq(usersTable.id, g.primaryUserId));
      const bad = await sharedPlanMisfit(this.db, g, p?.plan, [id]);
      if (bad) throw new BadRequestException({ code: "SHARED_PLAN_MISFIT", message: sharedPlanMisfitMessage(p?.plan, bad.name) });
    }
    await this.db.update(usersTable).set({ accountGroupId: g.id }).where(eq(usersTable.id, id));
    if (g.billingMode === "shared") await syncSharedSubscription(this.db, g.primaryUserId);
    return this.view(g, id);
  }

  @Delete(":groupId/members/:accountId")
  async removeMember(@Param("groupId") groupId: string, @Param("accountId") accountId: string) {
    const g = await this.groupById(Number(groupId));
    const id = Number(accountId);
    if (id === g.primaryUserId) {
      // Taking the primary out dissolves the group.
      const ids = await groupMemberIds(this.db, g);
      for (const m of ids.filter((x) => x !== id)) await unlinkMember(this.db, g, m);
      await this.db.update(usersTable).set({ accountGroupId: null }).where(eq(usersTable.id, id));
      await this.db.delete(accountGroupsTable).where(eq(accountGroupsTable.id, g.id));
      return { group: null, accountId: id };
    }
    await unlinkMember(this.db, g, id);
    return this.view(g, g.primaryUserId);
  }
}

@Module({
  controllers: [LinkedAccountsController, AdminLinkedAccountsController],
  providers: [LinkedAccountsService],
  exports: [LinkedAccountsService],
})
export class LinkedAccountsModule {}
