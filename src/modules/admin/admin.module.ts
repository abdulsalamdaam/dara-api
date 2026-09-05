import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Module, NotFoundException, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { sendExpoPush } from "../../common/push";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, isNotNull, lte, notInArray, or, sql, sum } from "drizzle-orm";
import { usersTable, propertiesTable, unitsTable, contractsTable, paymentsTable, loginLogsTable, tenantsTable, rolesTable, companiesTable, ownersTable, subscriptionPaymentsTable, appLogsTable } from "@dara/database";
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
import { TrialSettingsService } from "./trial-settings.service";
import { normalizeTrialDays } from "../../common/trial";
import { TranslationService } from "../translation/translation.service";

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
 * A `from` / `to` bound for the log list.
 *
 * `parseDateBound` accepts only `YYYY-MM-DD`, which is right for a login
 * history and too coarse here — the interesting window when chasing an
 * incident is minutes wide, not a day. So a full ISO timestamp is accepted
 * too, and a bare date still widens to the whole day in UTC the way every
 * other list does.
 */
function parseLogBound(raw: unknown, edge: "start" | "end"): Date | undefined {
  const day = parseDateBound(raw);
  if (day) return new Date(`${day}T${edge === "start" ? "00:00:00.000Z" : "23:59:59.999Z"}`);
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const d = new Date(raw.trim());
  return isNaN(d.getTime()) ? undefined : d;
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
    private readonly trialSettings: TrialSettingsService,
    private readonly translations: TranslationService,
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

  /**
   * The free trial every package ships with: how many days it runs, and
   * whether it is offered at all. Platform-wide — a trial is a property of the
   * offer, not of a customer — and read on every registration approval.
   */
  @Get("settings/trial")
  async getTrialSettings() {
    return this.trialSettings.getTrialSettings();
  }

  @Patch("settings/trial")
  async setTrialSettings(@Body() body: { days?: number; enabled?: boolean } | undefined) {
    const current = await this.trialSettings.getTrialSettings();
    let days = current.days;
    if (body?.days !== undefined) {
      // `normalizeTrialDays` reads absent/empty/non-positive as "no trial
      // asked for", which is a valid answer on an approval but not here —
      // this endpoint sets the length, so there is nothing to fall back to.
      const asked = normalizeTrialDays(body.days);
      if (asked == null) throw new BadRequestException("مدة التجربة يجب أن تكون بين 1 و 365 يوماً");
      days = asked;
    }
    let enabled = current.enabled;
    if (body?.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        throw new BadRequestException("قيمة تفعيل التجربة المجانية يجب أن تكون صحيحة أو خاطئة");
      }
      enabled = body.enabled;
    }
    return this.trialSettings.setTrialSettings({ days, enabled });
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
      // The calendar is pinned rather than left to resolve. CLDR's default for
      // ar-SA is islamic-umalqura, which would label these six Gregorian
      // buckets with Hijri months that do not line up with them; both Node 22
      // in the container and the dev machine happen to resolve `gregory`
      // today, so this changes nothing now and stops an ICU build from
      // changing it later.
      return { key: monthKey(d), label: d.toLocaleDateString("ar-SA-u-ca-gregory", { month: "short" }) };
    });
    const earliest = `${months[0]!.key}-01`;

    const [
      userRows, companyRows, propRow, unitRow, contractRows,
      subPaidRows, subPendingRows, monthRows, mrrRes, rentPaidRows, rentDueRows,
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
      // Revenue on this dashboard is DARA's revenue — what customers pay us for
      // their subscription — not the rent flowing through the platform. These
      // three used to read `payments`, i.e. tenants' rent installments, which
      // made "الإيرادات" a number about the landlords' money rather than ours
      // and put a figure in the millions where the true one is in the tens of
      // thousands. `payments` is still summed below, under names that say what
      // it is (rent volume), so nothing that wanted it has lost it.
      this.db.select({ amount: sum(subscriptionPaymentsTable.amount) })
        .from(subscriptionPaymentsTable).where(eq(subscriptionPaymentsTable.status, "paid")),
      this.db.select({ amount: sum(subscriptionPaymentsTable.amount) })
        .from(subscriptionPaymentsTable).where(eq(subscriptionPaymentsTable.status, "pending")),
      // Subscription revenue per month for the last six months, keyed in the
      // same Riyadh calendar the rest of the product reports in — paid_at is a
      // timestamptz, so without the shift a payment taken late on the last
      // evening of a month lands in the next one.
      this.db.select({
        month: sql<string>`to_char(${subscriptionPaymentsTable.paidAt} at time zone 'Asia/Riyadh', 'YYYY-MM')`.as("month"),
        amount: sum(subscriptionPaymentsTable.amount),
      })
        .from(subscriptionPaymentsTable)
        .where(and(
          eq(subscriptionPaymentsTable.status, "paid"),
          isNotNull(subscriptionPaymentsTable.paidAt),
          gte(sql`(${subscriptionPaymentsTable.paidAt} at time zone 'Asia/Riyadh')::date`, sql`${earliest}::date`),
        ))
        .groupBy(sql`1`),
      // True MRR: every account's latest paid subscription, each normalised to
      // a month (a yearly plan contributes a twelfth). Summing the raw amounts
      // would let one annual payment read as a month's income.
      this.db.execute(sql`
        select coalesce(sum(
          case when latest.billing_cycle = 'yearly' then latest.amount / 12.0 else latest.amount end
        ), 0) as mrr
        from (
          select distinct on (sp.user_id) sp.user_id, sp.amount, sp.billing_cycle
          from ${subscriptionPaymentsTable} sp
          join ${usersTable} u on u.id = sp.user_id
          where sp.status = 'paid' and u.is_active = true and u.deleted_at is null
          order by sp.user_id, sp.paid_at desc nulls last, sp.id desc
        ) latest
      `),
      // Rent moving through the platform. Not our revenue — reported separately
      // so the two can never be mistaken for one another again.
      this.db.select({ amount: sum(paymentsTable.amount) })
        .from(paymentsTable).where(eq(paymentsTable.status, "paid")),
      this.db.select({ amount: sum(paymentsTable.amount) })
        .from(paymentsTable).where(inArray(paymentsTable.status, ["pending", "overdue"])),
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
    // The monthly rent under management. This is NOT the platform's MRR — it
    // was being returned as `monthlyRecurring` and rendered on the
    // subscriptions tab as our MRR, which overstated it by several orders of
    // magnitude. It keeps its own name now.
    let rentUnderManagement = 0;
    for (const r of contractRows as Array<{ status: string; cnt: number; rent: string | null }>) {
      totalContracts += Number(r.cnt);
      if (r.status === "active") {
        activeContracts = Number(r.cnt);
        rentUnderManagement = Number(r.rent ?? 0);
      }
    }
    const mrrRows = (mrrRes as unknown as { rows?: Array<{ mrr: string | number | null }> }).rows
      ?? (mrrRes as unknown as Array<{ mrr: string | number | null }>);
    const monthlyRecurring = Number(mrrRows?.[0]?.mrr ?? 0);

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
      // Dara's own revenue, from subscription payments.
      monthlyRevenue: byMonth.get(monthKey(now)) ?? 0,
      monthlyRecurring,
      collectedTotal: Number((subPaidRows[0] as { amount: string | null })?.amount ?? 0),
      pendingDue: Number((subPendingRows[0] as { amount: string | null })?.amount ?? 0),
      monthlyData,
      // Rent moving through the platform — a measure of scale, not income.
      rentUnderManagement,
      rentCollectedTotal: Number((rentPaidRows[0] as { amount: string | null })?.amount ?? 0),
      rentOutstandingTotal: Number((rentDueRows[0] as { amount: string | null })?.amount ?? 0),
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

  /**
   * `GET /admin/logs` — the application log, after the fact.
   *
   * This is the point of `app_logs`: an unhandled 500 used to print a stack to
   * the container's stdout and die with the container, so by the time a
   * customer reported the problem there was nothing left to read. Every row
   * here carries the request id the client was handed back in `x-request-id`,
   * so a screenshot of a failed request is enough to find the exact stack.
   *
   * Same wire shape as `login-history` and every other list: `limit` returns a
   * bare array, `page`/`pageSize`/`paginated` return
   * `{ data, page, pageSize, total }`, and `total` is the database's count for
   * the same WHERE rather than the size of the page.
   *
   * Filters compose: `?level=error&from=2026-09-01` and
   * `?requestId=<uuid>` are the two that actually get used — the first to see
   * what broke today, the second to reconstruct one request end to end.
   */
  @Get("logs")
  async logs(@Query() rawQuery: any) {
    const paged = wantsPagination(rawQuery, ["q"]);
    const query = listQuerySchema.parse(rawQuery ?? {});

    const conds: any[] = [];

    const levels = parseEnumList(rawQuery?.level, ["error", "warn", "log", "debug", "verbose"] as const);
    if (levels?.length) conds.push(inArray(appLogsTable.level, levels as string[]));

    const event = typeof rawQuery?.event === "string" ? rawQuery.event.trim() : "";
    if (event) conds.push(eq(appLogsTable.event, event));

    const requestId = typeof rawQuery?.requestId === "string" ? rawQuery.requestId.trim() : "";
    if (requestId) conds.push(eq(appLogsTable.requestId, requestId));

    // Bounded to int4 for the same reason `parseIdList` is: an id past 2^31
    // reaches the driver and comes back as a 500 rather than an empty page.
    const userIdRaw = String(rawQuery?.userId ?? "").trim();
    if (/^[0-9]+$/.test(userIdRaw)) {
      const uid = Number(userIdRaw);
      if (uid > 0 && uid <= 2147483647) conds.push(eq(appLogsTable.userId, uid));
    }

    // A prefix match, not an exact one: the useful question is "everything
    // under /api/simple-invoices", not one exact path with its ids in it.
    const path = typeof rawQuery?.path === "string" ? rawQuery.path.trim() : "";
    if (path) conds.push(ilike(appLogsTable.path, `${path}%`));

    const statusRaw = String(rawQuery?.status ?? "").trim();
    if (/^[0-9]{3}$/.test(statusRaw)) conds.push(eq(appLogsTable.status, Number(statusRaw)));
    // `status=5xx` — the class, which is what anyone actually wants.
    else if (/^[1-5]xx$/i.test(statusRaw)) {
      const lo = Number(statusRaw[0]) * 100;
      conds.push(and(gte(appLogsTable.status, lo), lte(appLogsTable.status, lo + 99)));
    }

    const from = parseLogBound(rawQuery?.from, "start");
    const to = parseLogBound(rawQuery?.to, "end");
    if (from) conds.push(gte(appLogsTable.createdAt, from));
    if (to) conds.push(lte(appLogsTable.createdAt, to));

    const q = (typeof rawQuery?.q === "string" ? rawQuery.q : query.search ?? "").trim();
    if (q) {
      conds.push(or(
        ilike(appLogsTable.message, `%${q}%`),
        ilike(appLogsTable.error, `%${q}%`),
        ilike(appLogsTable.path, `%${q}%`),
        ilike(appLogsTable.event, `%${q}%`),
      ));
    }

    const where = conds.length ? and(...conds) : undefined;

    const rowsQ = this.db
      .select()
      .from(appLogsTable)
      // `id` tiebreak — a burst of rows from one request shares a
      // `created_at` to the millisecond, and without it they shuffle between
      // page requests.
      .orderBy(desc(appLogsTable.createdAt), desc(appLogsTable.id))
      .where(where)
      .$dynamic();

    if (!paged) {
      const limit = Math.min(Math.max(1, parseInt(rawQuery?.limit || "100", 10) || 100), 500);
      return rowsQ.limit(limit);
    }

    const [rows, totalRow] = await Promise.all([
      rowsQ.limit(query.pageSize).offset((query.page - 1) * query.pageSize),
      this.db.select({ total: count() }).from(appLogsTable).where(where),
    ]);
    return {
      data: rows,
      page: query.page,
      pageSize: query.pageSize,
      total: Number(totalRow[0]?.total ?? 0),
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
   * Every package now ships with a free trial, so approval GRANTS by default
   * rather than sending the account straight to the paywall — the length comes
   * from the platform trial policy (14 days out of the box, editable at
   * `PATCH /admin/settings/trial`).
   *
   * Three outcomes, in precedence order:
   *  - `trialDays` / `grantWithoutPayment` / `subscriptionEndsAt` → the admin
   *    overrides the policy and grants the window himself. These keep winning:
   *    an explicit decision must never be silently replaced by the default.
   *  - trial enabled and never consumed → the configured trial is granted:
   *    active, `subscription_is_trial`, and `trial_consumed_at` stamped.
   *  - `noTrial: true`, trial already consumed, the offer switched off, or the
   *    account was not actually pending → the pre-trial behaviour: active
   *    account, `pending_payment` subscription, no window. The account lands
   *    on the pay screen and the package it PAYS for wins.
   *
   * `noTrial` exists because "no trial" was otherwise unsayable. Absent, empty
   * and zero all normalise to null, which is how the admin says nothing — so
   * without a distinct token, an admin who deliberately picked "no trial" sent
   * a body indistinguishable from one who expressed no opinion, and got the
   * 14-day default plus a burnt `trial_consumed_at` for his trouble.
   *
   * `trial_consumed_at` is what makes the second case a one-time offer. The
   * `subscription_is_trial` flag is cleared by the first payment, so without a
   * separate stamp a customer who paid, then had his package changed, then was
   * re-approved would collect a new free window every time.
   *
   * When a window is granted, the user's own landing-page selection is
   * cleared. Leaving it set meant the pay screen (and any later "continue
   * payment" nudge) still advertised the plan they asked for rather than the
   * one the admin actually gave them.
   */
  @Patch("registrations/:id/approve")
  async approve(@Param("id") id: string, @Body() body: { packagePlan?: string; subscriptionEndsAt?: string; grantWithoutPayment?: boolean; trialDays?: number; noTrial?: boolean } | undefined) {
    const uid = parseInt(id, 10);
    const [existing] = await this.db.select({
      desiredPlan: usersTable.desiredPackagePlan, desiredCycle: usersTable.desiredBillingCycle,
      userType: usersTable.userType, trialConsumedAt: usersTable.trialConsumedAt,
      accountStatus: usersTable.accountStatus,
    })
      .from(usersTable).where(eq(usersTable.id, uid));
    if (!existing) throw new NotFoundException("User not found");
    const plan = resolveAdminPlan(body?.packagePlan, existing.desiredPlan);
    // Company-only plans stay company-only even when an admin assigns them —
    // approval is the other door into `users.package_plan`.
    if (!planAllowedForUserType(plan, existing.userType)) {
      throw new BadRequestException(planUserTypeError(plan));
    }
    const cycle = existing.desiredCycle === "yearly" ? "yearly" : "monthly";

    const askedTrialDays = normalizeTrialDays(body?.trialDays);
    // An explicit instruction from the admin — any of the three — turns the
    // automatic trial off. He is stating the window himself.
    const explicitOverride = askedTrialDays != null || !!body?.subscriptionEndsAt || !!body?.grantWithoutPayment;
    const policy = await this.trialSettings.getTrialSettings();
    // Only a registration coming out of the queue gets the welcome trial.
    // Re-approving an account that is already live must never overwrite its
    // window — paid or otherwise — with a fresh 14 free days.
    const isPendingRegistration = existing.accountStatus === "pending";
    const autoTrialDays =
      !explicitOverride && !body?.noTrial && policy.enabled
      && isPendingRegistration && existing.trialConsumedAt == null
        ? policy.days
        : null;
    const trialDays = askedTrialDays ?? autoTrialDays;
    const manualGrant = trialDays != null || !!body?.subscriptionEndsAt || !!body?.grantWithoutPayment;
    const win = manualGrant ? subscriptionWindow({ endsAtIso: body?.subscriptionEndsAt, trialDays: trialDays ?? undefined }) : null;
    const isTrial = trialDays != null;
    const [user] = await this.db.update(usersTable)
      .set({
        accountStatus: "active", isActive: true, packagePlan: plan, billingCycle: cycle,
        subscriptionStatus: manualGrant ? "active" : "pending_payment",
        subscriptionStartedAt: manualGrant ? win!.startedAt : null,
        subscriptionEndsAt: manualGrant ? win!.endsAt : null,
        subscriptionIsTrial: isTrial,
        // Burn the one free trial. The first stamp is kept if there already is
        // one: this column is the date the account's trial was used, and an
        // admin re-granting one by hand does not rewrite that history.
        trialConsumedAt: isTrial ? (existing.trialConsumedAt ?? win!.startedAt) : existing.trialConsumedAt,
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
      trialDays: trialDays ?? null, granted: manualGrant, isTrial,
    };
  }

  /**
   * Change a user's subscription package (and renew the window) at any time.
   * Accepts the same `trialDays` shorthand as approval, and activates the
   * subscription — an admin granting a package by hand is granting access, so
   * leaving the account on `pending_payment` would hand it the paywall
   * instead of the package.
   *
   * Unlike approval, this never grants a trial on its own. The automatic trial
   * is a one-time welcome, and a package change is something that happens to
   * an account repeatedly — auto-granting here would hand out an unlimited
   * supply of free windows to anyone whose plan is adjusted. An explicit
   * `trialDays` is still honoured (the admin is deciding), and it burns the
   * trial the same way approval does.
   *
   * It also LEAVES AN EXISTING WINDOW ALONE. This used to rebuild the window
   * unconditionally — `now → now + 1 year`, active, `is_trial = false` — on
   * every call, so changing the plan of a customer who was mid-trial cleared
   * the trial and handed him a free year, and changing the plan of a customer
   * who had PAID replaced his paid window with an unpaid one and destroyed his
   * renewal date. Neither was ever intended: the endpoint is called "change
   * package", and a plan change is not a billing decision.
   *
   * So the window is now touched in exactly two cases: the admin stated it
   * (`trialDays` / `subscriptionEndsAt`), or there is no window to keep — the
   * `pending_payment` account the fallback was written for, which would
   * otherwise be handed the paywall instead of the package it was just given.
   */
  @Patch("users/:userId/package")
  async changePackage(@Param("userId") userId: string, @Body() body: { packagePlan?: string; subscriptionEndsAt?: string; trialDays?: number }) {
    const id = parseInt(userId, 10);
    const [target] = await this.db.select({
      userType: usersTable.userType, desiredPlan: usersTable.desiredPackagePlan,
      trialConsumedAt: usersTable.trialConsumedAt,
      subscriptionStatus: usersTable.subscriptionStatus,
      subscriptionEndsAt: usersTable.subscriptionEndsAt,
    })
      .from(usersTable).where(eq(usersTable.id, id));
    if (!target) throw new NotFoundException("User not found");
    const plan = resolveAdminPlan(body?.packagePlan, target.desiredPlan);
    if (!planAllowedForUserType(plan, target.userType)) {
      throw new BadRequestException(planUserTypeError(plan));
    }
    const trialDays = normalizeTrialDays(body?.trialDays);
    const stated = trialDays != null || !!body?.subscriptionEndsAt;
    // "Nothing to keep" is a window that does not exist, not one that expired:
    // an expired window is still the customer's billing history, and silently
    // replacing it with a fresh free year is the bug this guards against.
    const hasWindow = target.subscriptionStatus !== "pending_payment" && target.subscriptionEndsAt != null;
    const win = stated || !hasWindow
      ? subscriptionWindow({ endsAtIso: body?.subscriptionEndsAt, trialDays: trialDays ?? undefined })
      : null;
    const [user] = await this.db.update(usersTable)
      .set({
        packagePlan: plan,
        ...(win
          ? {
              subscriptionStatus: "active" as const,
              subscriptionStartedAt: win.startedAt,
              subscriptionEndsAt: win.endsAt,
              subscriptionIsTrial: trialDays != null,
              // Same one-time stamp as approval: an explicit trial counts.
              trialConsumedAt: trialDays != null ? (target.trialConsumedAt ?? win.startedAt) : target.trialConsumedAt,
            }
          : {}),
        desiredPackagePlan: null,
        desiredBillingCycle: null,
      })
      .where(eq(usersTable.id, id))
      .returning();
    if (!user) throw new NotFoundException("User not found");
    return {
      success: true, id: user.id, packagePlan: plan,
      subscriptionEndsAt: user.subscriptionEndsAt,
      trialDays: trialDays ?? null,
      isTrial: user.subscriptionIsTrial,
      windowChanged: win != null,
    };
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

  /**
   * POST /api/admin/translations/sweep?limit=50
   *
   * Fill in the second language of the free text that has none yet.
   *
   * This is the only way existing data gets a translation: the work is a
   * network call per row, so no migration could do it, and every row written
   * before this layer existed has nothing stored. It is also the retry — a
   * batch that failed against a provider outage is marked `failed` and picked
   * up by the next sweep — and it is what makes the day an `OPENAI_API_KEY` is
   * finally configured a one-request event rather than a re-save of every
   * invoice in the database.
   *
   * Idempotent: text that already has a current translation costs one indexed
   * SELECT and asks the provider nothing, so running this repeatedly is free
   * and interrupting it loses only the rows it had not reached.
   *
   * It also CONVERGES, which is the property that makes calling it repeatedly a
   * plan rather than a loop: a field it has attempted and cannot currently
   * progress is not selected again, so two sweeps in a row with nothing new in
   * between examine nothing the second time. With no key that means one sweep
   * records every source and the next finds nothing — and configuring a key
   * makes all of it outstanding again. The rule in full, and why each clause is
   * there, is on `TranslationService.sweep`.
   *
   * `limit` bounds how many FIELDS are examined (default 50, max 500). It is
   * deliberately modest: with a key configured each outstanding field is a
   * model call, and a limit large enough to matter is a limit large enough to
   * outlive the proxy in front of us. Call it repeatedly instead — the newest
   * rows are always taken first, so the budget is spent on documents somebody
   * might actually open.
   *
   * Behind `SuperAdminGuard` with the rest of this controller: it spends money
   * and reads every account's text.
   */
  @Post("translations/sweep")
  async sweepTranslations(@Body() body: any, @Query("limit") limitQuery?: string) {
    const raw = Number(body?.limit ?? limitQuery ?? 50);
    const limit = Number.isFinite(raw) ? raw : 50;
    return this.translations.sweep(limit);
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
 * The trial policy, readable without a token.
 *
 * The landing page advertises the trial to people who by definition have no
 * account, and the length is now an admin setting rather than a constant. With
 * no public read the marketing copy could only hard-code a number, so an admin
 * moving the trial to 7 days would leave the public site promising 14 — the
 * product quietly lying about its own offer.
 *
 * Nothing here is sensitive: it is the same claim printed on the pricing page.
 * `enabled` is included so the copy can drop the trial line entirely rather
 * than advertise an offer that approval will not grant.
 */
@ApiTags("public")
@Controller("public/trial")
class PublicTrialController {
  constructor(private readonly trialSettings: TrialSettingsService) {}

  @Get()
  async get() {
    return this.trialSettings.getTrialSettings();
  }
}

/**
 * `AdminCustomerOverviewController` lives in its own file — this one is
 * already long enough — but it is the same admin surface, behind the same
 * `JwtAuthGuard` + `SuperAdminGuard` pair as everything above, and the
 * account lists here (`GET /admin/companies`, `GET /admin/users`) are what
 * link into it: both already carry the account's `id` on every row.
 */
@Module({
  imports: [EjarModule],
  controllers: [AdminController, AdminCustomerOverviewController, PublicTrialController],
  providers: [TrialSettingsService],
  exports: [TrialSettingsService],
})
export class AdminModule {}
