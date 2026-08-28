import { Injectable, Inject, BadRequestException, NotFoundException, UnauthorizedException, ForbiddenException, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { companiesTable, emailOtpTokensTable, loginLogsTable, ownersTable, rolesTable, tenantsTable, usersTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import type { TenantPayload } from "../../common/guards/tenant-auth.guard";
import { TwilioVerifyService } from "../twilio/twilio-verify.service";
import { PhoneOtpService, smsBypassEnabled, DEV_BYPASS_CODE } from "../sms/phone-otp.service";
import { qaBypassEnabled, EMAIL_OTP_BYPASS_CODE } from "../../common/qa-bypass";
import { EmailService } from "../email/email.service";
import { ROLE_PRESETS, ALL_PERMISSIONS } from "../../common/permissions";
import { isPackagePlan, planAllowedForUserType, planUserTypeError } from "../../common/packages";
import { hashEmailVerifyToken, newEmailVerifyOtp, verifyEmailOtpCode, EMAIL_VERIFY_OTP_TTL_MIN } from "../../common/email-verification";

const MAX_FAILED = 5;

/**
 * The canonical stored form of a Saudi mobile is the bare 9-digit core,
 * `5XXXXXXXX` — see `saudiPhone()` in `common/validation.ts`, which every
 * controller write path funnels through, and the one-off backfill in
 * `db/sql/2026_08_phone_bare_9_digits.sql`.
 *
 * Historical rows are NOT all in that form (+966502907100, 966502907100,
 * 0502907100), and a caller can type any of them. To match regardless, reduce
 * the input to its 9-digit core and return every stored variant for an IN()
 * lookup. **`core` itself is in the set** — that is what makes a row stored in
 * the new canonical form findable when the user types `0502907100` or
 * `+966502907100`. Do not drop it: tenant OTP login (`tenantRequestOtp` /
 * `tenantVerifyOtp`), landlord phone-OTP login (`userPhone*Otp`,
 * `findOwnerByLoginPhone`) and password reset all depend on this one set.
 */
function phoneCore(raw: string): string {
  let d = (raw || "").replace(/\D/g, "");
  if (d.startsWith("966")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return d; // e.g. 502907100
}
function phoneVariants(raw: string): string[] {
  const core = phoneCore(raw);
  // Canonical form first, then the three legacy ones, then the untouched input
  // (which covers a number that is not a Saudi mobile at all).
  const set = new Set<string>([core, `+966${core}`, `966${core}`, `0${core}`, (raw || "").trim()]);
  return [...set].filter(Boolean);
}
/**
 * The canonical stored form of a phone, or the value untouched when it is not a
 * Saudi mobile. Mirrors `saudiPhone()` in `common/validation.ts` but never
 * throws — registration has always accepted whatever it was given.
 */
function canonicalPhone(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const core = phoneCore(trimmed);
  return /^5\d{8}$/.test(core) ? core : trimmed;
}
/** Email-OTP code lifetime — drives the DB expiry, the email text, and the
 *  expiresInMinutes returned to the client (the login screen's timer). */
const EMAIL_OTP_TTL_MIN = 2;
const EMAIL_OTP_MAX_ATTEMPTS = 5;
/** Minimum gap before another login OTP can be requested (per IP / email). */
const OTP_RESEND_COOLDOWN_MIN = 2;


@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly jwt: JwtService,
    private readonly twilio: TwilioVerifyService,
    private readonly phoneOtp: PhoneOtpService,
    private readonly email: EmailService,
  ) {}

  private device(ua: string | undefined): string {
    if (!ua) return "Desktop";
    if (/mobile|android|iphone|ipad/i.test(ua)) return "Mobile";
    if (/tablet/i.test(ua)) return "Tablet";
    return "Desktop";
  }

  private async recordLogin(userId: number | null, email: string, status: "success" | "failed", ip: string, ua?: string) {
    await this.db.insert(loginLogsTable).values({
      userId,
      email,
      status,
      ip,
      device: this.device(ua),
    });
  }

  /* ── User token ── */
  signUserToken(payload: { id: number; email: string; role: AuthUser["role"]; tokenVersion: number }): string {
    return this.jwt.sign(
      { id: payload.id, email: payload.email, role: payload.role, kind: "user", tv: payload.tokenVersion },
    );
  }

  /* ── Owner token ──
   * Owners (rows in ownersTable, added via the web "landlord section") log in
   * by phone on the mobile app and see ONLY their own data. The token carries
   * the managing account's user id as `id` (so scopeId resolves the account)
   * plus the `ownerId` to narrow the scope to that single owner. Owners have
   * no tokenVersion, so `tv` is omitted. */
  signOwnerToken(payload: { ownerId: number; accountUserId: number }): string {
    return this.jwt.sign(
      { id: payload.accountUserId, ownerId: payload.ownerId, role: "owner", kind: "owner" },
    );
  }

  /* ── Tenant token ── */
  signTenantToken(payload: { id: number; phone: string; tokenVersion: number }): string {
    const claims: TenantPayload = { id: payload.id, phone: payload.phone, kind: "tenant", tv: payload.tokenVersion };
    return this.jwt.sign(claims);
  }

  /* ── User: email/password login (DISABLED — kept for future) ───────
   *
   * The product has switched to email-OTP 2FA as the primary login flow.
   * The bcrypt-based password block below is intentionally left in place,
   * commented out, so it can be re-enabled later by uncommenting + wiring
   * the route back into auth.controller.ts.
   *
   * The TS compiler still parses this body, so we keep the signature live
   * but throw a clear error if anything calls it. When bringing it back,
   * just delete the throw and uncomment the original logic.
   * ─────────────────────────────────────────────────────────────── */
  async login(_input: { email: string; password: string }, _ctx: { ip: string; ua?: string }): Promise<never> {
    throw new BadRequestException(
      "Password login is disabled. Use POST /auth/email-otp/request followed by /auth/email-otp/verify.",
    );

    /* ORIGINAL PASSWORD LOGIN — uncomment to re-enable
    const { email, password } = input;
    if (!email || !password) throw new BadRequestException("Email and password required");

    let user;
    try {
      [user] = await this.db.select().from(usersTable).where(and(eq(usersTable.email, email.toLowerCase()), isNull(usersTable.deletedAt)));
    } catch (err: any) {
      console.error("[auth.login] DB query failed:", err);
      throw err;
    }
    if (!user) {
      await this.recordLogin(null, email.toLowerCase(), "failed", ctx.ip, ctx.ua);
      throw new UnauthorizedException("بريد إلكتروني أو كلمة مرور غير صحيحة");
    }

    const adminRoles = ["super_admin", "admin"];
    if (!adminRoles.includes(user.role)) {
      if (user.accountStatus === "pending") {
        throw new ForbiddenException({ error: "حسابك قيد المراجعة، يرجى انتظار موافقة المشرف", code: "PENDING" });
      }
      if (user.accountStatus === "rejected") {
        throw new ForbiddenException({ error: "تم رفض طلب تسجيلك. تواصل مع الدعم للمزيد من المعلومات", code: "REJECTED" });
      }
    }

    if (!user.isActive) throw new UnauthorizedException("الحساب غير مفعّل. تواصل مع الدعم");

    if (user.failedLoginAttempts >= MAX_FAILED) {
      await this.recordLogin(user.id, user.email, "failed", ctx.ip, ctx.ua);
      throw new HttpException(
        { error: `تم تجاوز الحد المسموح به (${MAX_FAILED}).`, code: "LOCKED" },
        423 as HttpStatus,
      );
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      const newFailed = user.failedLoginAttempts + 1;
      await this.db.update(usersTable).set({ failedLoginAttempts: newFailed }).where(eq(usersTable.id, user.id));
      await this.recordLogin(user.id, user.email, "failed", ctx.ip, ctx.ua);
      const remaining = MAX_FAILED - newFailed;
      if (remaining > 0) {
        throw new UnauthorizedException(`بريد أو كلمة مرور غير صحيحة. تبقى ${remaining}.`);
      }
      throw new HttpException({ error: "Account locked.", code: "LOCKED" }, 423 as HttpStatus);
    }

    await this.db.update(usersTable)
      .set({
        loginCount: sql`${usersTable.loginCount} + 1`,
        lastLoginAt: new Date(),
        failedLoginAttempts: 0,
      })
      .where(eq(usersTable.id, user.id));

    await this.recordLogin(user.id, user.email, "success", ctx.ip, ctx.ua);

    const token = this.signUserToken({ id: user.id, email: user.email, role: user.role, tokenVersion: user.tokenVersion ?? 0 });
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role, isActive: user.isActive, accountStatus: user.accountStatus, phone: user.phone, company: user.company, loginCount: (user.loginCount ?? 0) + 1, lastLoginAt: new Date(), createdAt: user.createdAt } };
    */
  }

  /* ── User: email-OTP login (current primary) ───────────────────── */

  /**
   * Generate a fresh 6-digit code, store its bcrypt hash, and email it.
   * Always responds the same way to avoid leaking which emails exist.
   * Throttling is enforced at the controller layer (OtpThrottlerGuard).
   */
  async requestEmailOtp(input: { email: string }, ctx: { ip: string; ua?: string }): Promise<{ success: true; message: string; expiresInMinutes: number }> {
    const email = (input.email || "").trim().toLowerCase();
    if (!email) throw new BadRequestException("البريد الإلكتروني مطلوب");

    // Join the role row so we know whether the user is an admin without
    // selecting a now-removed `users.role` column.
    const [user] = await this.db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        isActive: usersTable.isActive,
        accountStatus: usersTable.accountStatus,
        roleKey: rolesTable.key,
        ownerUserId: usersTable.ownerUserId,
        emailVerified: usersTable.emailVerified,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .where(and(eq(usersTable.email, email), isNull(usersTable.deletedAt)));

    // Product decision: surface a clear "not registered" error instead of
    // silently no-oping. This trades a small enumeration risk (an attacker
    // can probe which emails exist) for a much better UX — users who mistype
    // or use the wrong email get told immediately instead of waiting forever
    // for a code that never arrives.
    if (!user) {
      throw new NotFoundException({
        error: "هذا البريد الإلكتروني غير مسجّل. الرجاء إنشاء حساب جديد.",
        code: "NOT_REGISTERED",
      });
    }

    // Mirror the password-flow account-status checks so suspended users
    // can't bypass moderation by switching to email OTP.
    const isAdminRole = user.roleKey === "super_admin" || user.roleKey === "admin";
    if (!isAdminRole) {
      if (user.accountStatus === "pending") {
        throw new ForbiddenException({ error: "حسابك قيد المراجعة، يرجى انتظار موافقة المشرف", code: "PENDING" });
      }
      if (user.accountStatus === "rejected") {
        throw new ForbiddenException({ error: "تم رفض طلب تسجيلك. تواصل مع الدعم للمزيد من المعلومات", code: "REJECTED" });
      }
      // Employees can't log in until they verify their email.
      if (user.ownerUserId != null && !user.emailVerified) {
        throw new ForbiddenException({ error: "يرجى تأكيد بريدك الإلكتروني أولاً عبر الرابط المُرسَل إليك", code: "EMAIL_NOT_VERIFIED" });
      }
    }
    if (!user.isActive) throw new UnauthorizedException("الحساب غير مفعّل. تواصل مع الدعم");

    // OTP send cooldown — block requesting another code within
    // EMAIL_OTP_TTL_MIN minutes from the same IP (or the same email). This
    // closes the OTP-flooding gap and is enforced in the DB so it can't be
    // bypassed by an in-memory throttler reset / restart.
    const cooldownMs = OTP_RESEND_COOLDOWN_MIN * 60_000;
    const since = new Date(Date.now() - cooldownMs);
    const senderMatch = ctx.ip
      ? or(eq(emailOtpTokensTable.email, email), eq(emailOtpTokensTable.ip, ctx.ip))
      : eq(emailOtpTokensTable.email, email);
    const [recent] = await this.db
      .select({ createdAt: emailOtpTokensTable.createdAt })
      .from(emailOtpTokensTable)
      .where(and(gt(emailOtpTokensTable.createdAt, since), senderMatch))
      .orderBy(desc(emailOtpTokensTable.createdAt))
      .limit(1);
    if (recent) {
      const waitSec = Math.max(1, Math.ceil((recent.createdAt.getTime() + cooldownMs - Date.now()) / 1000));
      throw new HttpException(
        {
          error: `الرجاء الانتظار ${waitSec} ثانية قبل طلب رمز جديد · Please wait ${waitSec}s before requesting another code.`,
          code: "OTP_COOLDOWN",
          retryAfter: waitSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = await bcrypt.hash(code, 8);
    const expiresAt = new Date(Date.now() + EMAIL_OTP_TTL_MIN * 60_000);

    await this.db.insert(emailOtpTokensTable).values({
      email,
      codeHash,
      expiresAt,
      ip: ctx.ip,
      userAgent: ctx.ua?.slice(0, 400) ?? null,
    });

    const sent = await this.email.sendLoginOtp(email, code, EMAIL_OTP_TTL_MIN);
    if (!sent) {
      // Don't leak the failure details to the caller, but log so we know.
      new Logger("AuthService").error(`OTP email send failed for ${email}`);
    }
    return { success: true, message: "تم إرسال رمز الدخول إلى بريدك الإلكتروني.", expiresInMinutes: EMAIL_OTP_TTL_MIN };
  }

  async verifyEmailOtp(input: { email: string; code: string }, ctx: { ip: string; ua?: string }) {
    const email = (input.email || "").trim().toLowerCase();
    const code = (input.code || "").trim();
    if (!email || !code) throw new BadRequestException("البريد الإلكتروني والرمز مطلوبان");

    const now = new Date();

    // ── QA BYPASS (armed by env, off in production) ───────────────────
    // Accepts the fixed code for any registered email so QA can log in without
    // waiting for the real emailed OTP: it skips the token lookup, the attempt
    // count and the bcrypt check entirely — a full authentication bypass.
    //
    // It used to be unconditional, with a `TODO: remove before production` that
    // never happened, so every account on the live API could be entered with a
    // six-character constant. It is now armed by the same flag the phone-OTP
    // bypass has always used, and that flag is "false" on production.
    //
    // The code still works normally when the bypass is off: a real OTP that
    // happens to be this value falls through to the checks below like any other.
    const isTestBypass = code === EMAIL_OTP_BYPASS_CODE && qaBypassEnabled();
    if (isTestBypass) {
      new Logger("AuthService").warn(`[QA_BYPASS] email OTP accepted for ${email} without a token`);
    }

    if (!isTestBypass) {
      const [token] = await this.db
        .select()
        .from(emailOtpTokensTable)
        .where(and(
          eq(emailOtpTokensTable.email, email),
          gt(emailOtpTokensTable.expiresAt, now),
          isNull(emailOtpTokensTable.consumedAt),
        ))
        .orderBy(desc(emailOtpTokensTable.createdAt))
        .limit(1);

      if (!token) {
        await this.recordLogin(null, email, "failed", ctx.ip, ctx.ua);
        throw new UnauthorizedException("الرمز غير صحيح أو منتهي الصلاحية");
      }

      if ((token.attempts ?? 0) >= EMAIL_OTP_MAX_ATTEMPTS) {
        await this.db.update(emailOtpTokensTable)
          .set({ consumedAt: now })
          .where(eq(emailOtpTokensTable.id, token.id));
        throw new UnauthorizedException("تم تجاوز عدد المحاولات. اطلب رمزاً جديداً.");
      }

      const ok = await bcrypt.compare(code, token.codeHash);
      if (!ok) {
        await this.db.update(emailOtpTokensTable)
          .set({ attempts: (token.attempts ?? 0) + 1 })
          .where(eq(emailOtpTokensTable.id, token.id));
        await this.recordLogin(null, email, "failed", ctx.ip, ctx.ua);
        throw new UnauthorizedException("الرمز غير صحيح");
      }

      // Burn the token so the same code can't be reused.
      await this.db.update(emailOtpTokensTable)
        .set({ consumedAt: now })
        .where(eq(emailOtpTokensTable.id, token.id));
    }

    // Pull the user joined with their role + company so the response carries
    // both. Neither `role` nor `company` exists on the users table anymore.
    const [user] = await this.db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        isActive: usersTable.isActive,
        accountStatus: usersTable.accountStatus,
        phone: usersTable.phone,
        loginCount: usersTable.loginCount,
        tokenVersion: usersTable.tokenVersion,
        createdAt: usersTable.createdAt,
        companyId: usersTable.companyId,
        roleId: usersTable.roleId,
        roleKey: rolesTable.key,
        companyName: companiesTable.name,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
      .where(and(eq(usersTable.email, email), isNull(usersTable.deletedAt)));
    if (!user) {
      await this.recordLogin(null, email, "failed", ctx.ip, ctx.ua);
      throw new UnauthorizedException("الحساب غير موجود");
    }

    await this.db.update(usersTable)
      .set({
        loginCount: sql`${usersTable.loginCount} + 1`,
        lastLoginAt: now,
        failedLoginAttempts: 0,
      })
      .where(eq(usersTable.id, user.id));
    await this.recordLogin(user.id, user.email, "success", ctx.ip, ctx.ua);

    const roleKey = user.roleKey ?? "user";
    const tokenStr = this.signUserToken({ id: user.id, email: user.email, role: roleKey, tokenVersion: user.tokenVersion ?? 0 });
    return {
      token: tokenStr,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: roleKey,
        isActive: user.isActive,
        accountStatus: user.accountStatus,
        phone: user.phone,
        company: user.companyName,
        companyId: user.companyId,
        roleId: user.roleId,
        loginCount: (user.loginCount ?? 0) + 1,
        lastLoginAt: now,
        createdAt: user.createdAt,
      },
    };
  }

  /**
   * Register a new user.
   *
   * The product is currently passwordless (email-OTP). Password is accepted
   * but optional — when omitted we store an unguessable random hash so the
   * row stays well-formed. If/when password login is re-enabled, users can
   * set a real password via a future "set password" flow.
   */
  async register(input: { email: string; password?: string; name: string; phone?: string; company?: string; companyName?: string; commercialReg?: string; userType?: "individual" | "company"; desiredPackagePlan?: string; desiredBillingCycle?: string }) {
    const { email, password, name, phone } = input;
    const userType = input.userType === "company" ? "company" : "individual";
    // The plan/cycle the user picked on the landing page — shown to the admin
    // before approval so they assign the package the user actually wants.
    const desiredPackagePlan = isPackagePlan(input.desiredPackagePlan) ? input.desiredPackagePlan : null;
    // Some plans are restricted to companies (see PackageDef.requiresUserType).
    // Reject rather than silently downgrade: the user chose a plan and a price
    // on the landing page, and quietly giving them a different one would only
    // surface as a surprise on the invoice.
    if (desiredPackagePlan && !planAllowedForUserType(desiredPackagePlan, userType)) {
      throw new BadRequestException(planUserTypeError(desiredPackagePlan));
    }
    const desiredBillingCycle = input.desiredBillingCycle === "yearly" ? "yearly" : input.desiredBillingCycle === "monthly" ? "monthly" : null;
    if (!email || !name) throw new BadRequestException("الاسم والبريد الإلكتروني مطلوبة");
    // A company account is two things: the person signing up and the entity
    // they sign up for. `name` is the person; the company needs its own name
    // or the account has nothing to invoice, contract or brand under. The old
    // signature accepted `company` and then dropped it on the floor.
    const companyName = String(input.companyName ?? input.company ?? "").trim();
    if (userType === "company" && !companyName) {
      throw new BadRequestException({
        error: "COMPANY_NAME_REQUIRED",
        message: "اسم المنشأة مطلوب لحسابات الشركات",
      });
    }
    // A company is identified by its commercial registration: it is what a tax
    // invoice must carry, what a record reconciles against in Ejar, and — for
    // the tenant package — the key every Ejar lookup is scoped by
    // (ejar.scope.ts fails closed without it). Required for EVERY company
    // account, not just the tenant package: an account created without one had
    // no path to fill it that the settings form actually enforced.
    // `assertCompanyCommercialReg` keeps it non-empty from then on.
    const commercialReg = String(input.commercialReg ?? "").trim();
    const needsCr = userType === "company";
    if (needsCr && !/^\d{10}$/.test(commercialReg)) {
      throw new BadRequestException({
        error: "COMMERCIAL_REG_REQUIRED",
        message: "رقم السجل التجاري (10 أرقام) مطلوب لحسابات المنشآت",
      });
    }

    const existing = await this.db.select().from(usersTable).where(and(eq(usersTable.email, email.toLowerCase()), isNull(usersTable.deletedAt)));
    // Carries a machine code alongside the message so the client can attach the
    // error to the email field itself instead of string-matching Arabic.
    if (existing.length > 0) {
      throw new BadRequestException({
        error: "EMAIL_TAKEN",
        message: "البريد الإلكتروني مسجّل مسبقاً",
      });
    }

    // Role for the account holder. An individual gets the plain "user" role;
    // the person registering a company IS its General Manager, so they get
    // that role — the highest employee preset, seeded from EMPLOYEE_PRESETS.
    // Both rows are seeded by the boot migration, so they always exist; the
    // fallback protects against an unconfigured DB.
    const roleKey = userType === "company" ? "general" : "user";
    const [roleRow] = await this.db
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .where(and(eq(rolesTable.key, roleKey), isNull(rolesTable.companyId)))
      .limit(1);
    const [fallbackRoleRow] = roleRow ? [roleRow] : await this.db
      .select({ id: rolesTable.id })
      .from(rolesTable)
      .where(and(eq(rolesTable.key, "user"), isNull(rolesTable.companyId)))
      .limit(1);

    // The company is a row of its own so employees added later can be scoped
    // to it, and so the name can be shown wherever the account appears.
    let companyId: number | null = null;
    if (userType === "company") {
      const [company] = await this.db
        .insert(companiesTable)
        .values({ name: companyName, commercialReg: commercialReg || null })
        .returning({ id: companiesTable.id });
      companyId = company?.id ?? null;
    }

    const effectivePassword = password && password.length >= 6
      ? password
      : `otp-only-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const passwordHash = await bcrypt.hash(effectivePassword, 10);
    // Email-verification OTP — the user enters the 6-digit code before the
    // admin approves. Only the bcrypt hash is stored, with a short expiry.
    const otp = await newEmailVerifyOtp();
    const [user] = await this.db.insert(usersTable).values({
      email: email.toLowerCase(),
      passwordHash,
      name,
      isActive: false,
      accountStatus: "pending",
      // Store the canonical 9-digit form (`saudiPhone()` in common/validation.ts)
      // so a registered landlord's number joins and matches like every other
      // phone in the DB. Registration has never rejected a malformed number and
      // still does not: anything that is not a Saudi mobile is kept verbatim.
      phone: canonicalPhone(phone),
      roleId: fallbackRoleRow?.id ?? null,
      companyId,
      userType,
      desiredPackagePlan,
      desiredBillingCycle,
      emailVerified: false,
      emailVerifyTokenHash: otp.codeHash,
      emailVerifyExpiresAt: otp.expiresAt,
    }).returning();

    void this.email.sendVerifyOtp(user!.email, user!.name, otp.code, EMAIL_VERIFY_OTP_TTL_MIN, false);

    return {
      pending: true,
      message: "تم استلام طلب التسجيل. أرسلنا رمز تأكيد إلى بريدك الإلكتروني — أدخله لتأكيد بريدك، ثم سيقوم المشرف بمراجعة الحساب وتفعيله.",
      user: { id: user!.id, email: user!.email, name: user!.name, accountStatus: user!.accountStatus },
    };
  }

  /** Verify an email-verification OTP code (email + 6-digit code). */
  async verifyEmailWithOtp(email: string, code: string) {
    const e = (email || "").trim().toLowerCase();
    const c = (code || "").trim();
    if (!e || !c) throw new BadRequestException("البريد الإلكتروني والرمز مطلوبان");
    const [user] = await this.db.select().from(usersTable)
      .where(and(eq(usersTable.email, e), isNull(usersTable.deletedAt)));
    if (!user) throw new BadRequestException({ error: "الرمز غير صحيح أو منتهي الصلاحية", code: "INVALID_CODE" });
    if (user.emailVerified) {
      return { success: true, alreadyVerified: true, message: "تم تأكيد بريدك الإلكتروني مسبقاً" };
    }
    if (!user.emailVerifyTokenHash || !user.emailVerifyExpiresAt
        || new Date(user.emailVerifyExpiresAt).getTime() < Date.now()) {
      throw new BadRequestException({ error: "انتهت صلاحية الرمز. اطلب رمزاً جديداً", code: "EXPIRED_CODE" });
    }
    const ok = await verifyEmailOtpCode(c, user.emailVerifyTokenHash);
    if (!ok) throw new BadRequestException({ error: "الرمز غير صحيح", code: "INVALID_CODE" });
    await this.db.update(usersTable)
      .set({ emailVerified: true, emailVerifiedAt: new Date(), emailVerifyTokenHash: null, emailVerifyExpiresAt: null })
      .where(eq(usersTable.id, user.id));
    return { success: true, alreadyVerified: false, message: "تم تأكيد بريدك الإلكتروني بنجاح" };
  }

  /** Verify an email-verification token (from the link). */
  async verifyEmail(token: string) {
    const t = (token || "").trim();
    if (!t) throw new BadRequestException("رابط غير صالح");
    const tokenHash = hashEmailVerifyToken(t);
    const [user] = await this.db.select().from(usersTable)
      .where(and(eq(usersTable.emailVerifyTokenHash, tokenHash), isNull(usersTable.deletedAt)));
    if (!user) throw new BadRequestException({ error: "رابط التأكيد غير صالح أو تم استخدامه مسبقاً", code: "INVALID_TOKEN" });
    if (user.emailVerified) {
      return { success: true, alreadyVerified: true, message: "تم تأكيد بريدك الإلكتروني مسبقاً" };
    }
    if (user.emailVerifyExpiresAt && new Date(user.emailVerifyExpiresAt).getTime() < Date.now()) {
      throw new BadRequestException({ error: "انتهت صلاحية رابط التأكيد. اطلب رابطاً جديداً", code: "EXPIRED_TOKEN" });
    }
    await this.db.update(usersTable)
      .set({ emailVerified: true, emailVerifiedAt: new Date(), emailVerifyTokenHash: null, emailVerifyExpiresAt: null })
      .where(eq(usersTable.id, user.id));
    return { success: true, alreadyVerified: false, message: "تم تأكيد بريدك الإلكتروني بنجاح" };
  }

  /** Re-issue + resend a verification link to an email (public). */
  async resendVerification(email: string) {
    const e = (email || "").trim().toLowerCase();
    if (!e) throw new BadRequestException("البريد الإلكتروني مطلوب");
    const [user] = await this.db.select().from(usersTable)
      .where(and(eq(usersTable.email, e), isNull(usersTable.deletedAt)));
    // Don't reveal whether the email exists.
    if (!user) return { success: true };
    if (user.emailVerified) return { success: true, alreadyVerified: true };
    const otp = await newEmailVerifyOtp();
    await this.db.update(usersTable)
      .set({ emailVerifyTokenHash: otp.codeHash, emailVerifyExpiresAt: otp.expiresAt })
      .where(eq(usersTable.id, user.id));
    void this.email.sendVerifyOtp(user.email, user.name, otp.code, EMAIL_VERIFY_OTP_TTL_MIN, user.ownerUserId != null);
    return { success: true };
  }

  /**
   * Permissions for the current user. Both the role key and the permission
   * list come from the joined `roles` row — no per-user override anymore.
   */
  async permissionsForUser(userId: number) {
    const [row] = await this.db
      .select({
        roleKey: rolesTable.key,
        roleLabelAr: rolesTable.labelAr,
        roleLabelEn: rolesTable.labelEn,
        permissions: rolesTable.permissions,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .where(eq(usersTable.id, userId));
    if (!row) throw new UnauthorizedException("User not found");
    return {
      role: row.roleKey ?? "user",
      roleLabel: row.roleLabelAr ?? row.roleLabelEn ?? null,
      permissions: row.permissions ?? [],
      catalog: ALL_PERMISSIONS,
      presets: ROLE_PRESETS,
    };
  }

  /* ── User: profile ── */
  async me(userId: number) {
    const [row] = await this.db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        isActive: usersTable.isActive,
        accountStatus: usersTable.accountStatus,
        phone: usersTable.phone,
        loginCount: usersTable.loginCount,
        lastLoginAt: usersTable.lastLoginAt,
        createdAt: usersTable.createdAt,
        companyId: usersTable.companyId,
        roleId: usersTable.roleId,
        roleKey: rolesTable.key,
        companyName: companiesTable.name,
        // Needed by the client to tell a company account from an individual —
        // e.g. so onboarding prefills a landlord with the COMPANY's name
        // rather than the signed-in person's.
        userType: usersTable.userType,
        ownerUserId: usersTable.ownerUserId,
        packagePlan: usersTable.packagePlan,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .leftJoin(companiesTable, eq(usersTable.companyId, companiesTable.id))
      .where(eq(usersTable.id, userId));
    if (!row) throw new UnauthorizedException("User not found");
    // Employees inherit the owner account's subscription package.
    let packagePlan = row.packagePlan;
    if (row.ownerUserId) {
      const [owner] = await this.db
        .select({ p: usersTable.packagePlan })
        .from(usersTable)
        .where(eq(usersTable.id, row.ownerUserId));
      packagePlan = owner?.p ?? packagePlan;
    }
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.roleKey ?? "user",
      isActive: row.isActive,
      accountStatus: row.accountStatus,
      phone: row.phone,
      company: row.companyName,
      companyId: row.companyId,
      roleId: row.roleId,
      packagePlan,
      loginCount: row.loginCount,
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
    };
  }

  /* ── User: logout (revokes all current sessions for this user) ── */
  async logoutUser(userId: number) {
    await this.db.update(usersTable)
      .set({ tokenVersion: sql`${usersTable.tokenVersion} + 1` })
      .where(eq(usersTable.id, userId));
    return { success: true, message: "تم تسجيل الخروج. تم إنهاء جميع الجلسات." };
  }

  /* ── User: change own password (while logged in) ── */
  async changePassword(userId: number, currentPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 6) {
      throw new BadRequestException("كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل");
    }
    const [user] = await this.db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!user) throw new UnauthorizedException("User not found");

    // Verify the current password before allowing a change.
    const ok = await bcrypt.compare(currentPassword || "", user.passwordHash);
    if (!ok) throw new BadRequestException("كلمة المرور الحالية غير صحيحة");

    const passwordHash = await bcrypt.hash(newPassword, 10);
    // The current session keeps working — tokenVersion is left untouched so
    // the user isn't logged out by changing their own password.
    await this.db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, userId));
    return { success: true, message: "تم تغيير كلمة المرور بنجاح" };
  }

  /* ── User: forgot/reset password via Twilio Verify OTP ── */
  async forgotPassword(input: { identifier: string; channel?: "sms" | "email" | "call" | "whatsapp" }) {
    const id = input.identifier.trim();
    if (!id) throw new BadRequestException("البريد الإلكتروني أو رقم الجوال مطلوب");

    const isEmail = id.includes("@");
    const channel = input.channel || (isEmail ? "email" : "sms");

    const [user] = isEmail
      ? await this.db.select().from(usersTable).where(and(eq(usersTable.email, id.toLowerCase()), isNull(usersTable.deletedAt)))
      // Phone lookup goes through the variant set, not an equality test: the
      // stored form is now the bare 9 digits and the user types 05…/+966….
      : await this.db.select().from(usersTable)
          .where(and(inArray(usersTable.phone, phoneVariants(id)), isNull(usersTable.deletedAt)))
          .orderBy(desc(usersTable.isActive), asc(usersTable.id))
          .limit(1);

    // Always respond the same way to avoid leaking which accounts exist.
    if (!user) {
      return { success: true, message: "إذا كان الحساب مسجّلاً، فقد أرسلنا لك رمز التحقق." };
    }

    const target = isEmail ? user.email : (user.phone || id);
    // SMS goes through Taqnyat like every other text we send; the email
    // channel is left on Twilio Verify because that is where it already was
    // and password login is disabled anyway (see `login` above).
    if (channel === "sms") await this.phoneOtp.start(target, "user");
    else await this.twilio.start(target, channel);
    return { success: true, message: "تم إرسال رمز التحقق. أدخله لإكمال إعادة تعيين كلمة المرور." };
  }

  async resetPassword(input: { identifier: string; code: string; newPassword: string; channel?: "sms" | "email" | "call" | "whatsapp" }) {
    const { identifier, code, newPassword } = input;
    if (!identifier || !code || !newPassword) throw new BadRequestException("جميع الحقول مطلوبة");
    if (newPassword.length < 6) throw new BadRequestException("كلمة المرور قصيرة جداً");

    const isEmail = identifier.includes("@");
    const channel = input.channel || (isEmail ? "email" : "sms");

    const [user] = isEmail
      ? await this.db.select().from(usersTable).where(and(eq(usersTable.email, identifier.toLowerCase()), isNull(usersTable.deletedAt)))
      // Same variant lookup as forgotPassword, with the same deterministic
      // ordering — duplicate phone numbers exist, so request and verify must
      // agree on which identity they picked.
      : await this.db.select().from(usersTable)
          .where(and(inArray(usersTable.phone, phoneVariants(identifier)), isNull(usersTable.deletedAt)))
          .orderBy(desc(usersTable.isActive), asc(usersTable.id))
          .limit(1);
    if (!user) throw new BadRequestException("بيانات غير صحيحة");

    const target = isEmail ? user.email : (user.phone || identifier);
    const ok = channel === "sms"
      ? await this.phoneOtp.check(target, code, "user")
      : await this.twilio.check(target, code, channel);
    if (!ok) throw new BadRequestException("رمز التحقق غير صحيح أو منتهي الصلاحية");

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.db.update(usersTable)
      .set({
        passwordHash,
        failedLoginAttempts: 0,
        tokenVersion: sql`${usersTable.tokenVersion} + 1`,
      })
      .where(eq(usersTable.id, user.id));

    return { success: true, message: "تم إعادة تعيين كلمة المرور بنجاح. سجّل الدخول مجدداً." };
  }

  /* ── Tenant: phone OTP login ──
   *
   * Real Twilio Verify SMS. The only way to skip it is the environment flag
   * TWILIO_DEV_BYPASS=true (staging/QA), which accepts DEV_BYPASS_CODE for any
   * active tenant and sends nothing. It is deliberately env-driven rather than
   * hardcoded: a code-level bypass ships to production the moment someone
   * forgets to flip it back, which is exactly what happened before.
   */

  async tenantRequestOtp(input: { phone: string; channel?: "sms" | "call" | "whatsapp" }, ctx?: { ip: string; ua?: string }) {
    const raw = (input.phone || "").trim();
    if (!raw) throw new BadRequestException("رقم الجوال مطلوب");
    const phone = this.phoneOtp.normalizePhone(raw);
    const [tenant] = await this.db.select().from(tenantsTable).where(inArray(tenantsTable.phone, phoneVariants(raw)));
    // Answer honestly instead of the old generic "if the number is registered
    // we sent a code". That reply hid the truth from the only people it
    // mattered to: the app pushed every caller to the code screen, no SMS ever
    // arrived, and there was nothing on screen to explain why. It does reveal
    // whether a number is registered — an accepted trade for a login the user
    // can actually get through.
    if (!tenant) {
      throw new NotFoundException({
        code: "PHONE_NOT_REGISTERED",
        error: "هذا الرقم غير مسجّل لدينا. تأكد من الرقم أو تواصل مع المؤجر لتسجيلك.",
        message: "هذا الرقم غير مسجّل لدينا. تأكد من الرقم أو تواصل مع المؤجر لتسجيلك.",
      });
    }
    if (tenant.status !== "active") {
      throw new ForbiddenException({
        code: "ACCOUNT_INACTIVE",
        error: "الحساب غير نشط حالياً. تواصل مع المؤجر لتفعيله.",
        message: "الحساب غير نشط حالياً. تواصل مع المؤجر لتفعيله.",
      });
    }

    await this.phoneOtp.start(phone, "tenant", ctx?.ip);
    return { success: true, message: "تم إرسال رمز التحقق إلى جوالك." };
  }

  async tenantVerifyOtp(input: { phone: string; code: string; channel?: "sms" | "call" | "whatsapp" }, ctx: { ip: string; ua?: string }) {
    const raw = (input.phone || "").trim();
    const code = (input.code || "").trim();
    if (!raw || !code) throw new BadRequestException("رقم الجوال والرمز مطلوبان");
    const phone = this.phoneOtp.normalizePhone(raw);

    const [tenant] = await this.db.select().from(tenantsTable).where(inArray(tenantsTable.phone, phoneVariants(raw)));
    if (!tenant || tenant.status !== "active") {
      await this.recordLogin(null, phone, "failed", ctx.ip, ctx.ua);
      throw new UnauthorizedException("بيانات غير صحيحة");
    }

    const ok = await this.phoneOtp.check(phone, code, "tenant");
    if (!ok) {
      await this.recordLogin(null, phone, "failed", ctx.ip, ctx.ua);
      throw new UnauthorizedException("رمز التحقق غير صحيح");
    }

    await this.db.update(tenantsTable)
      .set({ lastLoginAt: new Date() })
      .where(eq(tenantsTable.id, tenant.id));

    await this.recordLogin(null, phone, "success", ctx.ip, ctx.ua);

    const token = this.signTenantToken({ id: tenant.id, phone: tenant.phone || phone, tokenVersion: tenant.tokenVersion ?? 0 });
    return {
      token,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        phone: tenant.phone,
        email: tenant.email,
        type: tenant.type,
        status: tenant.status,
      },
    };
  }

  /* ── Landlord (USER) phone-OTP login for the mobile app ──
   * Mirrors the tenant phone flow but resolves a USER by phone and returns a
   * USER JWT (kind "user"), so landlords use the same phone+OTP experience.
   * Uses the same real-SMS path as the tenant flow (TWILIO_DEV_BYPASS aside). */
  /**
   * Find an active owner (landlord, added via the web) whose EFFECTIVE login
   * phone matches the given raw number. The effective login phone is:
   *   isRepresentative === false → owners.phone
   *   isRepresentative === true  → owners.originalOwnerPhone (the actual owner;
   *                                the main phone then belongs to the agent/وكيل)
   * Returns the first match or undefined.
   */
  private async findOwnerByLoginPhone(raw: string) {
    const variants = phoneVariants(raw);
    const [owner] = await this.db.select().from(ownersTable).where(and(
      or(
        and(eq(ownersTable.isRepresentative, false), inArray(ownersTable.phone, variants)),
        and(eq(ownersTable.isRepresentative, true), inArray(ownersTable.originalOwnerPhone, variants)),
      ),
      eq(ownersTable.status, "active"),
      isNull(ownersTable.deletedAt),
    ));
    return owner;
  }

  /** Verify a landlord phone OTP (Taqnyat-backed, dev bypass aware). */
  private async checkPhoneCode(phone: string, code: string): Promise<boolean> {
    return this.phoneOtp.check(phone, code, "user");
  }

  async userPhoneRequestOtp(input: { phone: string }, ctx?: { ip: string; ua?: string }) {
    const raw = (input.phone || "").trim();
    if (!raw) throw new BadRequestException("رقم الجوال مطلوب");
    // A phone number is NOT unique across users (registration allows a
    // duplicate), so an unordered `[user]` picked an arbitrary identity — and
    // request/verify could disagree about who is logging in. Prefer an active
    // row, then the oldest id, so the choice is stable and matches verify.
    const [user] = await this.db.select({ id: usersTable.id, isActive: usersTable.isActive })
      .from(usersTable).where(and(inArray(usersTable.phone, phoneVariants(raw)), isNull(usersTable.deletedAt)))
      .orderBy(desc(usersTable.isActive), asc(usersTable.id))
      .limit(1);
    const owner = user && user.isActive ? null : await this.findOwnerByLoginPhone(raw);
    if (!user && !owner) {
      throw new NotFoundException({
        code: "PHONE_NOT_REGISTERED",
        error: "هذا الرقم غير مسجّل لدينا. تأكد من الرقم أو تواصل مع الدعم.",
        message: "هذا الرقم غير مسجّل لدينا. تأكد من الرقم أو تواصل مع الدعم.",
      });
    }
    // A row exists but is switched off — say so rather than sending a code that
    // could never complete a login.
    if (user && !user.isActive && !owner) {
      throw new ForbiddenException({
        code: "ACCOUNT_INACTIVE",
        error: "الحساب غير نشط حالياً. تواصل مع الدعم لتفعيله.",
        message: "الحساب غير نشط حالياً. تواصل مع الدعم لتفعيله.",
      });
    }
    await this.phoneOtp.start(raw, "user", ctx?.ip);
    return { success: true, message: "تم إرسال رمز التحقق إلى جوالك." };
  }

  async userPhoneVerifyOtp(input: { phone: string; code: string }, ctx: { ip: string; ua?: string }) {
    const raw = (input.phone || "").trim();
    const code = (input.code || "").trim();
    if (!raw || !code) throw new BadRequestException("رقم الجوال والرمز مطلوبان");
    const phone = this.phoneOtp.normalizePhone(raw);

    const [user] = await this.db
      .select({
        id: usersTable.id, email: usersTable.email, name: usersTable.name, phone: usersTable.phone,
        isActive: usersTable.isActive, accountStatus: usersTable.accountStatus,
        tokenVersion: usersTable.tokenVersion, roleId: usersTable.roleId, ownerUserId: usersTable.ownerUserId,
        roleKey: rolesTable.key,
      })
      .from(usersTable).leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .where(and(inArray(usersTable.phone, phoneVariants(raw)), isNull(usersTable.deletedAt)))
      // Duplicate phone numbers exist, so this lookup must be deterministic:
      // an active row wins, ties break on the oldest id. Without the ORDER BY
      // the DB could hand back an inactive duplicate, and the fall-through
      // below would then log the caller in as a *different* identity (an
      // owner/landlord with a different scope).
      .orderBy(desc(usersTable.isActive), asc(usersTable.id))
      .limit(1);
    if (!user || !user.isActive) {
      // No matching user — fall back to an owner (landlord) login by phone.
      const owner = await this.findOwnerByLoginPhone(raw);
      if (owner) {
        if (!(await this.checkPhoneCode(phone, code))) {
          await this.recordLogin(null, phone, "failed", ctx.ip, ctx.ua);
          throw new UnauthorizedException("رمز التحقق غير صحيح");
        }
        await this.recordLogin(null, phone, "success", ctx.ip, ctx.ua);
        const effectiveEmail = owner.isRepresentative ? owner.originalOwnerEmail : owner.email;
        const effectivePhone = owner.isRepresentative ? owner.originalOwnerPhone : owner.phone;
        const token = this.signOwnerToken({ ownerId: owner.id, accountUserId: owner.userId });
        return { token, user: { id: owner.id, name: owner.name, email: effectiveEmail, phone: effectivePhone, role: "owner" } };
      }
      await this.recordLogin(null, phone, "failed", ctx.ip, ctx.ua);
      throw new UnauthorizedException("بيانات غير صحيحة");
    }
    if (!(await this.checkPhoneCode(phone, code))) {
      await this.recordLogin(user.id, phone, "failed", ctx.ip, ctx.ua);
      throw new UnauthorizedException("رمز التحقق غير صحيح");
    }
    await this.db.update(usersTable).set({ lastLoginAt: new Date(), failedLoginAttempts: 0 }).where(eq(usersTable.id, user.id));
    await this.recordLogin(user.id, user.email, "success", ctx.ip, ctx.ua);
    const roleKey = user.roleKey ?? "user";
    const token = this.signUserToken({ id: user.id, email: user.email, role: roleKey, tokenVersion: user.tokenVersion ?? 0 });
    return { token, user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: roleKey } };
  }

  async tenantMe(tenantId: number) {
    const [tenant] = await this.db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    if (!tenant) throw new NotFoundException("Tenant not found");
    return {
      id: tenant.id,
      name: tenant.name,
      phone: tenant.phone,
      email: tenant.email,
      type: tenant.type,
      status: tenant.status,
      address: tenant.address,
      lastLoginAt: tenant.lastLoginAt,
    };
  }

  async tenantLogout(tenantId: number) {
    await this.db.update(tenantsTable)
      .set({ tokenVersion: sql`${tenantsTable.tokenVersion} + 1` })
      .where(eq(tenantsTable.id, tenantId));
    return { success: true, message: "تم تسجيل الخروج." };
  }
}
