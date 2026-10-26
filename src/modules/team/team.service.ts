import {
  Inject,
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import bcrypt from "bcryptjs";
import { eq, and, asc, count, desc, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { rolesTable, usersTable, type User } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { EmailService } from "../email/email.service";
import { newEmailVerifyToken } from "../../common/email-verification";
import { resolvePackage } from "../../common/packages";
import { employeeCount } from "../../common/quota";
import { resolveLimit } from "../../common/limit-core";
import { addonAvailable } from "../../common/addon-catalog";
import { assertEmailAvailable, emailTakenException, isEmailUniqueViolation, normalizeEmail } from "../../common/user-email";
import { listQuerySchema, wantsPagination } from "../../common/pagination";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { EMPLOYEE_PRESET_KEYS, exceeding, knownPermissions, teamCeiling } from "../../common/rbac";

/** Who is acting, whose team it is, and the most they may grant. */
type TeamCtx = { actor: AuthUser; scope: number; holder: User; ceiling: Set<string>; isHolder: boolean };

/**
 * What a team endpoint may hand back about a user row. Beyond the password
 * hash, the row also carries the email-verification token hash + its expiry
 * (whoever holds the hash's plaintext can activate the account) and
 * `tokenVersion` (the session-invalidation counter). None of those are the
 * caller's business, and they were being returned verbatim by createEmployee
 * and the update endpoints.
 */
type Public = Omit<
  User,
  "passwordHash" | "emailVerifyTokenHash" | "emailVerifyExpiresAt" | "tokenVersion"
>;

function strip(u: User): Public {
  const {
    passwordHash: _ph,
    emailVerifyTokenHash: _evth,
    emailVerifyExpiresAt: _eve,
    tokenVersion: _tv,
    ...rest
  } = u;
  return rest;
}

/**
 * Team management.
 *
 * The legacy approach stored a copy of the role permissions on each user
 * row (`users.permissions`). Now every user is linked to a `roles` row by
 * `role_id` and the role row is the source of truth for permissions +
 * label. To grant an employee a different permission set, point them at a
 * different role.
 *
 * The five built-in employee presets (general / accountant / propertyManager
 * / collector / assistant) are seeded as system roles by the boot migration
 * — `rolePresets()` reads them straight from the DB so adding a new preset
 * is a one-line SQL change.
 */
@Injectable()
export class TeamService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly email: EmailService,
  ) {}

  /**
   * Resolve the acting manager and the team they manage.
   *
   * Access is by permission (`team.manage`, checked by the controller's
   * PermissionsGuard), and the TEAM is the account's: `scopeId`, not the
   * caller's own id. An employee holding `team.manage` (a General Manager)
   * therefore manages the account's team, never a team of their own — and
   * whatever they grant is clamped to what they hold (`teamCeiling`).
   *
   * Owner-mobile tokens never reach here (JwtAuthGuard refuses them), and are
   * refused again explicitly: one resolves to the managing account's id, and
   * used to be able to run every endpoint below as the account holder.
   */
  private async ctx(actor: AuthUser): Promise<TeamCtx> {
    if (!actor || actor.ownerScopeId != null || actor.role === "owner") {
      throw new ForbiddenException("Forbidden");
    }
    const scope = actor.ownerUserId ?? actor.id;
    const [holder] = await this.db.select().from(usersTable)
      .where(and(eq(usersTable.id, scope), isNull(usersTable.deletedAt)));
    if (!holder) throw new NotFoundException("Actor not found");
    return { actor, scope, holder, ceiling: teamCeiling(actor), isHolder: actor.ownerUserId == null };
  }

  /**
   * The employee being acted on: a live member of THIS account's team, not the
   * caller themselves, and — when the caller is an employee — no stronger
   * than the caller. The account holder is never a target: their
   * `ownerUserId` is NULL, so it can never equal the scope.
   */
  private async target(c: TeamCtx, employeeId: number): Promise<User> {
    const [emp] = await this.db.select().from(usersTable)
      .where(and(eq(usersTable.id, employeeId), isNull(usersTable.deletedAt)));
    if (!emp || emp.ownerUserId == null || emp.ownerUserId !== c.scope) throw new NotFoundException("Employee not found");
    if (emp.id === c.actor.id) throw new ForbiddenException("You cannot change your own team membership or role");
    if (!c.isHolder) {
      const perms = await this.rolePermissions(emp.roleId);
      const over = exceeding(perms, c.ceiling);
      if (over.length) throw new ForbiddenException(`This member holds permissions you do not: ${over.join(", ")}`);
    }
    return emp;
  }

  private async rolePermissions(roleId: number | null | undefined): Promise<string[]> {
    if (roleId == null) return [];
    const [r] = await this.db.select({ permissions: rolesTable.permissions }).from(rolesTable).where(eq(rolesTable.id, roleId));
    return (r?.permissions as string[] | undefined) ?? [];
  }

  /**
   * An employee's role must be stated, never inferred. The fallback used to be
   * "user" — the account-owner role, 40 permissions including deletes and
   * subscription management — so an omitted or misspelled `preset` field was
   * silently whitelisted away and handed the new employee owner-level rights.
   *
   * And it must be an EMPLOYEE preset. The lookup used to accept any system
   * role key, so `preset: "super_admin"` linked a customer's new employee to
   * the platform super-admin role — SuperAdminGuard trusts the key — and the
   * customer chose that employee's password. The preset's permissions must
   * also fit inside the caller's ceiling.
   */
  private async resolvePresetRoleId(c: TeamCtx, presetKey: string | undefined | null): Promise<number> {
    const key = presetKey?.trim();
    if (!key || !EMPLOYEE_PRESET_KEYS.includes(key)) throw new BadRequestException(`Unknown role preset: ${presetKey}`);
    const [r] = await this.db
      .select({ id: rolesTable.id, permissions: rolesTable.permissions })
      .from(rolesTable)
      .where(and(eq(rolesTable.key, key), isNull(rolesTable.companyId), isNull(rolesTable.deletedAt)))
      .limit(1);
    if (!r) throw new BadRequestException(`Unknown role preset: ${presetKey}`);
    const over = exceeding((r.permissions as string[]) ?? [], c.ceiling);
    if (over.length) throw new ForbiddenException(`You cannot grant permissions you do not hold: ${over.join(", ")}`);
    return r.id;
  }

  /**
   * The account's team: the owner plus every employee under them.
   *
   * `search` (name / email / phone) and `role` (one or a comma-separated set of
   * role keys) and `isActive` are applied in SQL. The settings screen filtered
   * both in the browser over the whole team, which is fine for five people and
   * wrong for a managing office with two hundred - and it made the "active"
   * tile count only the employees that had been fetched.
   *
   * Pagination is opt-in via `page`/`pageSize`/`paginated`; without them the
   * bare array the settings screen already reads is returned unchanged.
   */
  async listEmployees(user: AuthUser, rawQuery?: any) {
    const { scope } = await this.ctx(user);

    const paged = wantsPagination(rawQuery);
    const q = listQuerySchema.parse(rawQuery ?? {});

    const conds: any[] = [
      // The account holder is part of the team, not outside it: on a company
      // account they ARE the General Manager, and a team screen that omitted
      // them showed an org with no one at the top. Flagged as `isOwner` below
      // so the UI can render them without the remove/downgrade actions - the
      // service refuses those anyway, since an owner has no ownerUserId to
      // match.
      or(eq(usersTable.ownerUserId, scope), eq(usersTable.id, scope)),
      isNull(usersTable.deletedAt),
    ];
    if (q.search) {
      conds.push(or(
        ilike(usersTable.name, `%${q.search}%`),
        ilike(usersTable.email, `%${q.search}%`),
        ilike(usersTable.phone, `%${q.search}%`),
      ));
    }
    const roleKeys = typeof rawQuery?.role === "string" && rawQuery.role.trim() && rawQuery.role !== "all"
      ? rawQuery.role.split(",").map((x: string) => x.trim()).filter(Boolean) : undefined;
    if (roleKeys?.length) conds.push(inArray(rolesTable.key, roleKeys));
    if (rawQuery?.isActive === "1" || rawQuery?.isActive === "true") conds.push(eq(usersTable.isActive, true));
    else if (rawQuery?.isActive === "0" || rawQuery?.isActive === "false") conds.push(eq(usersTable.isActive, false));
    const where = and(...conds);

    // Join the role so the UI gets the live role key, label and the
    // effective permission list (permissions live on the role row).
    let rowsQ = this.db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        phone: usersTable.phone,
        isActive: usersTable.isActive,
        accountStatus: usersTable.accountStatus,
        emailVerified: usersTable.emailVerified,
        emailVerifiedAt: usersTable.emailVerifiedAt,
        ownerUserId: usersTable.ownerUserId,
        roleId: usersTable.roleId,
        lastLoginAt: usersTable.lastLoginAt,
        createdAt: usersTable.createdAt,
        role: rolesTable.key,
        roleLabel: rolesTable.labelAr,
        permissions: rolesTable.permissions,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .where(where)
      // Owner first, then oldest employee first. This was a JS sort after the
      // fetch - which cannot survive paging, since page 2 would have sorted its
      // own slice and put a second "owner" at its top. Expressed in SQL as a
      // leading boolean key instead: `owner_user_id IS NULL` is TRUE for the
      // account holder, and DESC puts TRUE first. `id` is the final tiebreak on
      // a non-unique `created_at`.
      .orderBy(
        desc(sql`${usersTable.ownerUserId} is null`),
        asc(usersTable.createdAt),
        asc(usersTable.id),
      )
      .$dynamic();
    if (paged) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow, activeRow] = await Promise.all([
      rowsQ,
      paged ? this.db.select({ total: count() }).from(usersTable)
        .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
        .where(where) : Promise.resolve([{ total: 0 }]),
      // "Active members" counted by the database over the same team, minus the
      // isActive filter itself so the tile keeps its number while the list is
      // narrowed to one state.
      paged ? this.db.select({ isActive: usersTable.isActive, cnt: count() }).from(usersTable)
        .where(and(
          or(eq(usersTable.ownerUserId, scope), eq(usersTable.id, scope)),
          isNull(usersTable.deletedAt),
        ))
        .groupBy(usersTable.isActive) : Promise.resolve([]),
    ]);

    const data = rows.map((r) => ({ ...r, isOwner: r.ownerUserId == null }));
    if (!paged) return data;
    let active = 0;
    let inactive = 0;
    for (const r of activeRow as Array<{ isActive: boolean; cnt: number }>) {
      if (r.isActive) active = Number(r.cnt); else inactive = Number(r.cnt);
    }
    return {
      data,
      page: q.page,
      pageSize: q.pageSize,
      total: Number(totalRow[0]?.total ?? 0),
      stats: { active, inactive },
    };
  }

  async createEmployee(
    user: AuthUser,
    input: { name: string; email: string; phone?: string; password?: string; preset?: string },
  ): Promise<Public> {
    const c = await this.ctx(user);

    const email = normalizeEmail(input.email);
    if (!email) throw new BadRequestException("Email is required");

    // Team-member cap driven by the owner account's subscription package.
    // The plan must be read from the OWNER, not the actor: an employee with
    // team-manage permission carries no packagePlan of its own, so
    // resolvePackage(actor.packagePlan) fell back to the default plan and
    // enforced the wrong seat limit — too few or too many depending on what the
    // account actually pays for. The seat count was already owner-scoped.
    //
    // The cap is the EFFECTIVE seat limit (common/limits.ts): the plan's
    // maxUsers, replaced by an admin override, plus active seat add-ons.
    const ownerId = c.scope;
    const pkg = resolvePackage(c.holder.packagePlan);
    const seatLimit = await resolveLimit(this.db, ownerId, "users", pkg.maxUsers);
    const used = await employeeCount(this.db, ownerId);
    if (seatLimit != null && used >= seatLimit) {
      throw new BadRequestException({
        statusCode: 400,
        // The web keys off `code`; `addonAvailable` says a seat add-on is for
        // sale, so it can offer one next to "upgrade".
        code: "PLAN_LIMIT_USERS",
        limit: seatLimit,
        used,
        addonAvailable: await addonAvailable(this.db, "users"),
        message:
          `لقد بلغت الحد الأقصى لباقتك (${seatLimit} مستخدم). لإضافة المزيد يرجى ترقية الباقة. ` +
          `· Your ${pkg.labelEn} plan allows up to ${seatLimit} team members.`,
      });
    }

    // One email, one account (common/user-email.ts) — across every account,
    // case-insensitive, and a soft-deleted user still owns its address (the
    // old live-only check let that through to a raw unique-violation 500).
    await assertEmailAvailable(this.db, email);

    const roleId = await this.resolvePresetRoleId(c, input.preset);

    // Password is optional — the app logs in via email-OTP. When none is
    // given, store an unguessable random hash.
    const effectivePassword = input.password && input.password.length >= 6
      ? input.password
      : `otp-only-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const passwordHash = await bcrypt.hash(effectivePassword, 10);
    // Employees activate their account by clicking the verification link we
    // email them (no OTP code) before they can log in.
    const verify = newEmailVerifyToken();
    const [created] = await this.db
      .insert(usersTable)
      .values({
        email,
        passwordHash,
        name: input.name.trim() || email.split("@")[0]!,
        isActive: true,
        accountStatus: "active",
        phone: input.phone?.trim() || null,
        // The ACCOUNT's employee, whoever created them: an employee under an
        // employee would sit outside every scope check.
        ownerUserId: c.scope,
        // Inherit the owning user's company so employees see the same data scope.
        companyId: c.holder.companyId ?? null,
        roleId,
        emailVerified: false,
        emailVerifyTokenHash: verify.tokenHash,
        emailVerifyExpiresAt: verify.expiresAt,
      })
      .returning()
      .catch((err: unknown) => {
        if (isEmailUniqueViolation(err)) throw emailTakenException();
        throw err;
      });
    void this.email.sendVerifyEmail(created!.email, created!.name, verify.token, true);
    return strip(created!);
  }

  /** Re-send the email-verification link to an employee. */
  async resendEmployeeVerification(user: AuthUser, employeeId: number): Promise<{ success: boolean; alreadyVerified?: boolean }> {
    const c = await this.ctx(user);
    const emp = await this.target(c, employeeId);
    if (emp.emailVerified) return { success: true, alreadyVerified: true };
    const verify = newEmailVerifyToken();
    await this.db.update(usersTable)
      .set({ emailVerifyTokenHash: verify.tokenHash, emailVerifyExpiresAt: verify.expiresAt })
      .where(eq(usersTable.id, employeeId));
    void this.email.sendVerifyEmail(emp.email, emp.name, verify.token, true);
    return { success: true };
  }

  async updateEmployee(
    user: AuthUser,
    employeeId: number,
    patch: { name?: string; phone?: string; preset?: string; isActive?: boolean },
  ): Promise<Public> {
    const c = await this.ctx(user);
    // Soft-deleted rows are gone as far as the API is concerned — matching
    // deleteEmployee, which already 404s on them instead of touching them.
    const emp = await this.target(c, employeeId);

    const updates: Partial<typeof usersTable.$inferInsert> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.phone !== undefined) updates.phone = patch.phone || null;
    if (patch.isActive !== undefined) {
      updates.isActive = patch.isActive;
      // Deactivation ends live sessions now, not at the next request's
      // isActive check alone — so a re-activation cannot revive an old token.
      if (patch.isActive === false && emp.isActive) updates.tokenVersion = (emp.tokenVersion ?? 0) + 1;
    }
    if (patch.preset !== undefined) {
      updates.roleId = await this.resolvePresetRoleId(c, patch.preset);
    }
    if (Object.keys(updates).length === 0) throw new BadRequestException("Nothing to update");

    const [updated] = await this.db
      .update(usersTable)
      .set(updates)
      .where(eq(usersTable.id, employeeId))
      .returning();
    return strip(updated!);
  }

  /**
   * Set an employee's exact permission list. Permissions live on `roles`,
   * so this maintains a dedicated company-scoped role per employee
   * (`emp_custom_<id>`) and points the employee at it — letting an owner
   * grant or remove individual permissions without touching the shared
   * preset roles.
   */
  async updateEmployeePermissions(user: AuthUser, employeeId: number, permissions: string[]): Promise<Public> {
    const c = await this.ctx(user);
    await this.target(c, employeeId);

    // Catalog keys only, and only what the caller may grant. This stored the
    // request's strings verbatim — `admin.users`, `admin.roles`, anything —
    // and the guard reads permissions straight off this row.
    const clean: string[] = knownPermissions(Array.isArray(permissions) ? permissions : []);
    const over = exceeding(clean, c.ceiling);
    if (over.length) throw new ForbiddenException(`You cannot grant permissions you do not hold: ${over.join(", ")}`);
    const key = `emp_custom_${employeeId}`;
    const companyId = c.holder.companyId ?? null;

    const [existingRole] = await this.db
      .select()
      .from(rolesTable)
      .where(and(
        eq(rolesTable.key, key),
        companyId == null ? isNull(rolesTable.companyId) : eq(rolesTable.companyId, companyId),
      ))
      .limit(1);

    let roleId: number;
    if (existingRole) {
      await this.db.update(rolesTable).set({ permissions: clean }).where(eq(rolesTable.id, existingRole.id));
      roleId = existingRole.id;
    } else {
      const [created] = await this.db
        .insert(rolesTable)
        .values({ key, labelAr: "صلاحيات مخصصة", labelEn: "Custom permissions", permissions: clean, isSystem: false, companyId })
        .returning();
      roleId = created!.id;
    }

    const [updated] = await this.db.update(usersTable).set({ roleId }).where(eq(usersTable.id, employeeId)).returning();
    return strip(updated!);
  }

  async resetEmployeePassword(user: AuthUser, employeeId: number, newPassword: string): Promise<{ ok: true }> {
    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException("Password must be at least 6 characters");
    }
    const c = await this.ctx(user);
    const emp = await this.target(c, employeeId);

    const passwordHash = await bcrypt.hash(newPassword, 10);
    // Bumping tokenVersion invalidates any active session — the employee will
    // be forced to log in again with the new password.
    await this.db
      .update(usersTable)
      .set({ passwordHash, tokenVersion: (emp.tokenVersion ?? 0) + 1, failedLoginAttempts: 0 })
      .where(eq(usersTable.id, employeeId));
    return { ok: true };
  }

  async deleteEmployee(user: AuthUser, employeeId: number): Promise<{ ok: true }> {
    const c = await this.ctx(user);
    const emp = await this.target(c, employeeId);

    // Soft delete and bump tokenVersion to invalidate any active session.
    await this.db.update(usersTable)
      .set({ deletedAt: new Date(), isActive: false, tokenVersion: (emp.tokenVersion ?? 0) + 1 })
      .where(eq(usersTable.id, employeeId));
    return { ok: true };
  }

  /** Returns the seeded employee-preset roles for the team UI dropdown. */
  async rolePresets(user?: AuthUser) {
    const employeePresetKeys = EMPLOYEE_PRESET_KEYS;
    const ceiling = user ? teamCeiling(user) : null;
    const rows = await this.db
      .select({
        id: rolesTable.key,
        labelAr: rolesTable.labelAr,
        labelEn: rolesTable.labelEn,
        permissions: rolesTable.permissions,
      })
      .from(rolesTable)
      .where(and(isNull(rolesTable.companyId)))
      .orderBy(asc(rolesTable.id));
    // `assignable`: whether THIS caller may hand the preset out (an employee
    // manager cannot grant more than they hold). Additive field.
    return rows
      .filter((r) => employeePresetKeys.includes(r.id))
      .map((r) => ({ ...r, assignable: ceiling ? exceeding((r.permissions as string[]) ?? [], ceiling).length === 0 : true }));
  }
}
