import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { TenantAuthGuard } from "../../common/guards/tenant-auth.guard";
import { OtpThrottlerGuard } from "../../common/throttler";
import { clientIp, clientUserAgent } from "../../common/client-ip";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { CurrentTenant } from "../../common/decorators/current-tenant.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import type { TenantPayload } from "../../common/guards/tenant-auth.guard";
import {
  LoginDto,
  RegisterDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
  TenantOtpStartDto,
  TenantOtpVerifyDto,
  EmailOtpRequestDto,
  EmailOtpVerifyDto,
} from "./auth.dto";

/**
 * The caller's identity for a login attempt, as `AuthService` wants it.
 *
 * The IP extraction used to live here, read `x-forwarded-for[0]`, and was
 * therefore recording Cloudflare's edge address for every login in
 * `login_logs`. It now comes from `common/client-ip`, which is the single
 * definition — the same one the throttler keys its buckets on. The return
 * shape is unchanged so no caller had to move.
 */
function clientCtx(req: Request): { ip: string; ua: string | undefined } {
  return { ip: clientIp(req), ua: clientUserAgent(req) ?? undefined };
}

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /* ── User: password login (DISABLED, kept for re-enable) ──────── */
  // Hits AuthService.login which currently throws — the route stays mounted
  // so a frontend that hasn't migrated yet receives a clear 400 instead of
  // a silent 404. To re-enable: uncomment the body in AuthService.login.
  @Post("login")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseGuards(OtpThrottlerGuard)
  login(@Body() body: LoginDto, @Req() req: Request) {
    return this.auth.login(body, clientCtx(req));
  }

  /* ── User: email-OTP login (current primary) ──────────────────── */
  // Send a 6-digit code to the user's email. Tracker is per (IP+email) via
  // OtpThrottlerGuard so distinct emails don't share buckets. Limits are
  // intentionally generous — we want users who mistype to retry without
  // friction. Brute-force is also rate-limited by the per-token attempts
  // counter in AuthService (5 wrong codes burns the token).
  @Post("email-otp/request")
  @HttpCode(200)
  @Throttle({
    short: { limit: 5,  ttl: 60_000   },  // 5 / minute per (IP+email)
    long:  { limit: 30, ttl: 3600_000 },  // 30 / hour  per (IP+email)
  })
  @UseGuards(OtpThrottlerGuard)
  emailOtpRequest(@Body() body: EmailOtpRequestDto, @Req() req: Request) {
    return this.auth.requestEmailOtp(body, clientCtx(req));
  }

  // Verify the code. 10 attempts per 5 min per (IP+email). The token row
  // also burns after 5 wrong attempts (handled inside AuthService).
  @Post("email-otp/verify")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  @UseGuards(OtpThrottlerGuard)
  emailOtpVerify(@Body() body: EmailOtpVerifyDto, @Req() req: Request) {
    return this.auth.verifyEmailOtp(body, clientCtx(req));
  }

  // Registration is cheap but still rate-limited per IP.
  @Post("register")
  @Throttle({ default: { limit: 5, ttl: 3600_000 } })
  register(@Body() body: RegisterDto) {
    return this.auth.register(body);
  }

  // Confirm an email-verification token (from the link in the email — legacy).
  @Post("verify-email")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 3600_000 } })
  verifyEmail(@Body() body: { token?: string }) {
    return this.auth.verifyEmail(body?.token ?? "");
  }

  // Confirm an email with the 6-digit OTP code (email + code).
  @Post("verify-email-otp")
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 3600_000 } })
  verifyEmailOtp(@Body() body: { email?: string; code?: string }) {
    return this.auth.verifyEmailWithOtp(body?.email ?? "", body?.code ?? "");
  }

  // Re-send a verification link (public; doesn't reveal account existence).
  @Post("resend-verification")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 3600_000 } })
  resendVerification(@Body() body: { email?: string }) {
    return this.auth.resendVerification(body?.email ?? "");
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  /** Effective permission keys for the logged-in user. */
  @Get("me/permissions")
  @UseGuards(JwtAuthGuard)
  myPermissions(@CurrentUser() user: AuthUser) {
    return this.auth.permissionsForUser(user.id);
  }

  @Post("logout")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  logout(@CurrentUser() user: AuthUser) {
    return this.auth.logoutUser(user.id);
  }

  /** Change the logged-in user's own password. */
  @Post("me/change-password")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 3600_000 } })
  @UseGuards(JwtAuthGuard)
  changePassword(@CurrentUser() user: AuthUser, @Body() body: ChangePasswordDto) {
    return this.auth.changePassword(user.id, body.currentPassword ?? "", body.newPassword);
  }

  /* ── User: forgot/reset password (OTP-based) ── */
  // OTP-send endpoints: 1 per minute and 5 per hour per (IP + identifier).
  @Post("forgot-password")
  @HttpCode(200)
  @Throttle({
    short: { limit: 1, ttl: 60_000 },
    long:  { limit: 5, ttl: 3600_000 },
  })
  @UseGuards(OtpThrottlerGuard)
  forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.auth.forgotPassword(body);
  }

  // OTP-check: 5 attempts per 5 min per (IP + identifier) — brute-force shield.
  @Post("reset-password")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @UseGuards(OtpThrottlerGuard)
  resetPassword(@Body() body: ResetPasswordDto) {
    return this.auth.resetPassword(body);
  }

  /* ── Tenant: phone OTP login ── */
  // OTP-send (Twilio cost) — 3 per minute and 15 per hour per (IP + phone).
  // Generous enough that a tenant retrying after a missed SMS, or coming back
  // through the flow a couple of times in a session, doesn't hit a 429. The
  // mobile client also enforces a 60s client-side cooldown on the resend
  // button, and Twilio Verify has its own upstream limits, so this layer can
  // afford to be lenient.
  @Post("tenant/request-otp")
  @HttpCode(200)
  @Throttle({
    short: { limit: 3,  ttl: 60_000 },
    long:  { limit: 15, ttl: 3600_000 },
  })
  @UseGuards(OtpThrottlerGuard)
  tenantRequestOtp(@Body() body: TenantOtpStartDto, @Req() req: Request) {
    return this.auth.tenantRequestOtp(body, clientCtx(req));
  }

  // OTP-check — 15 attempts per 5 min per (IP + phone). Brute-force is also
  // bounded by the code itself: 5 wrong tries burns the row (PhoneOtpService),
  // and it expires in 10 minutes either way.
  @Post("tenant/verify-otp")
  @HttpCode(200)
  @Throttle({ default: { limit: 15, ttl: 300_000 } })
  @UseGuards(OtpThrottlerGuard)
  tenantVerifyOtp(@Body() body: TenantOtpVerifyDto, @Req() req: Request) {
    return this.auth.tenantVerifyOtp(body, clientCtx(req));
  }

  // Landlord (USER) phone-OTP login for the mobile app — same phone+OTP UX as
  // the tenant, but returns a user JWT.
  @Post("user/phone-otp/request")
  @HttpCode(200)
  @Throttle({ short: { limit: 3, ttl: 60_000 }, long: { limit: 15, ttl: 3600_000 } })
  @UseGuards(OtpThrottlerGuard)
  userPhoneRequestOtp(@Body() body: { phone?: string }, @Req() req: Request) {
    return this.auth.userPhoneRequestOtp({ phone: body?.phone ?? "" }, clientCtx(req));
  }

  @Post("user/phone-otp/verify")
  @HttpCode(200)
  @Throttle({ default: { limit: 15, ttl: 300_000 } })
  @UseGuards(OtpThrottlerGuard)
  userPhoneVerifyOtp(@Body() body: { phone?: string; code?: string }, @Req() req: Request) {
    return this.auth.userPhoneVerifyOtp({ phone: body?.phone ?? "", code: body?.code ?? "" }, clientCtx(req));
  }

  @Get("tenant/me")
  @UseGuards(TenantAuthGuard)
  tenantMe(@CurrentTenant() tenant: TenantPayload) {
    return this.auth.tenantMe(tenant.id);
  }

  @Post("tenant/logout")
  @HttpCode(200)
  @UseGuards(TenantAuthGuard)
  tenantLogout(@CurrentTenant() tenant: TenantPayload) {
    return this.auth.tenantLogout(tenant.id);
  }
}
