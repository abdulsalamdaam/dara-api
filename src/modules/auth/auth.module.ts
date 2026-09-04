import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { TenantAuthGuard } from "../../common/guards/tenant-auth.guard";
import { TwilioModule } from "../twilio/twilio.module";
import { SmsModule } from "../sms/sms.module";

/** Anything shorter than this is not a signing key for a production API. */
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * The signing key for every session in the product — landlord, employee,
 * tenant and owner-mobile alike.
 *
 * It used to fall back to the literal `"milkia-dev-secret"` when `JWT_SECRET`
 * was unset. `dara-api` is a PUBLIC GitHub repository, so that constant was
 * world-readable: anyone could mint a token for any user id and the guard
 * would verify it. A missing environment variable was therefore not a
 * misconfiguration that degraded something — it was a total authentication
 * bypass, and one that leaves no trace, because every request it produces
 * looks exactly like a legitimate login.
 *
 * So there is no default. A container without a real secret refuses to boot
 * and says why, which is loud, immediate and impossible to run past.
 */
function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.trim().length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET is required and must be at least ${MIN_JWT_SECRET_LENGTH} characters. ` +
        `Generate one with \`openssl rand -hex 64\` and set it in the environment. ` +
        `There is deliberately no default: this key authenticates every session in the product ` +
        `and this repository is public.`,
    );
  }
  return secret;
}

@Module({
  imports: [
    TwilioModule,
    SmsModule,
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: jwtSecret(),
        // Endless tokens — revocation is handled per-user via tokenVersion bumps.
        signOptions: {},
      }),
      global: true,
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, TenantAuthGuard],
  exports: [AuthService, JwtAuthGuard, TenantAuthGuard],
})
export class AuthModule {}
