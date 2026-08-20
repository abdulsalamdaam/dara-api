import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { TenantAuthGuard } from "../../common/guards/tenant-auth.guard";
import { TwilioModule } from "../twilio/twilio.module";
import { SmsModule } from "../sms/sms.module";

@Module({
  imports: [
    TwilioModule,
    SmsModule,
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_SECRET ?? "milkia-dev-secret",
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
