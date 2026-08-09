import { IsEmail, IsIn, IsOptional, IsString, Length, MinLength } from "class-validator";

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

/* ── Email-OTP login (current primary auth) ─────────────────────── */

export class EmailOtpRequestDto {
  @IsEmail()
  email!: string;
}

export class EmailOtpVerifyDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}

export class RegisterDto {
  @IsString()
  name!: string;

  @IsEmail()
  email!: string;

  /**
   * Password is optional. We're currently passwordless (email-OTP); when a
   * password isn't provided the backend stores an unguessable random hash.
   */
  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  /** Legacy alias for companyName — kept so older clients keep working. */
  @IsOptional()
  @IsString()
  company?: string;

  /**
   * The company's own name, required when userType is "company".
   *
   * Must be declared here: the global ValidationPipe runs with
   * `whitelist: true`, so a property missing from the DTO is stripped before
   * the service ever sees it — which is how `company` came to be accepted in
   * the signature and silently discarded.
   */
  @IsOptional()
  @IsString()
  companyName?: string;

  /** Commercial registration (10 digits). Required for the tenant package. */
  @IsOptional()
  @IsString()
  commercialReg?: string;

  /** Account holder type — "individual" | "company". */
  @IsOptional()
  @IsIn(["individual", "company"])
  userType?: "individual" | "company";

  /** Plan + cycle the user picked on the landing page (shown to the admin). */
  @IsOptional()
  @IsString()
  desiredPackagePlan?: string;

  @IsOptional()
  @IsIn(["monthly", "yearly"])
  desiredBillingCycle?: "monthly" | "yearly";
}

export class ForgotPasswordDto {
  @IsString()
  identifier!: string;

  @IsOptional()
  @IsIn(["sms", "call", "whatsapp", "email"])
  channel?: "sms" | "call" | "whatsapp" | "email";
}

export class ResetPasswordDto {
  @IsString()
  identifier!: string;

  @IsString()
  code!: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;

  @IsOptional()
  @IsIn(["sms", "call", "whatsapp", "email"])
  channel?: "sms" | "call" | "whatsapp" | "email";
}

export class TenantOtpStartDto {
  @IsString()
  phone!: string;

  @IsOptional()
  @IsIn(["sms", "call", "whatsapp"])
  channel?: "sms" | "call" | "whatsapp";
}

export class TenantOtpVerifyDto {
  @IsString()
  phone!: string;

  @IsString()
  code!: string;

  @IsOptional()
  @IsIn(["sms", "call", "whatsapp"])
  channel?: "sms" | "call" | "whatsapp";
}

export class ChangePasswordDto {
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;
}
