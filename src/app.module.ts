import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { OtpThrottlerGuard } from "./common/throttler";

import { DatabaseModule } from "./database/database.module";
import { TwilioModule } from "./modules/twilio/twilio.module";
import { SmsModule } from "./modules/sms/sms.module";
import { EmailModule } from "./modules/email/email.module";
import { UploadsModule } from "./modules/uploads/uploads.module";
import { HealthModule } from "./modules/health/health.module";
import { AuthModule } from "./modules/auth/auth.module";
import { StatsModule } from "./modules/stats/stats.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { MobileLandlordModule } from "./modules/mobile-landlord/mobile-landlord.module";
import { DeedsModule } from "./modules/deeds/deeds.module";
import { PropertiesModule } from "./modules/properties/properties.module";
import { UnitsModule } from "./modules/units/units.module";
import { ContractsModule } from "./modules/contracts/contracts.module";
import { EjarModule } from "./modules/ejar/ejar.module";
import { ImportModule } from "./modules/import/import.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { BillingModule } from "./modules/billing/billing.module";
import { AdminModule } from "./modules/admin/admin.module";
import { ProfileModule } from "./modules/profile/profile.module";
import { OwnersModule } from "./modules/owners/owners.module";
import { TenantsModule } from "./modules/tenants/tenants.module";
import { MaintenanceModule } from "./modules/maintenance/maintenance.module";
import { FacilitiesModule } from "./modules/facilities/facilities.module";
import { CampaignsModule } from "./modules/campaigns/campaigns.module";
import { SupportModule } from "./modules/support/support.module";
import { TenantPortalModule } from "./modules/tenant-portal/tenant-portal.module";
import { ContactModule } from "./modules/contact/contact.module";
import { TeamModule } from "./modules/team/team.module";
import { InvoiceModule } from "./modules/invoice/invoice.module";
import { CompaniesModule } from "./modules/companies/companies.module";
import { LookupsModule } from "./modules/lookups/lookups.module";
import { PaymentConfirmationsModule } from "./modules/payment-confirmations/payment-confirmations.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { PackageModule } from "./modules/package/package.module";
import { SubscriptionModule } from "./modules/subscription/subscription.module";
import { AuditModule } from "./modules/audit/audit.module";
import { ReportsModule } from "./modules/reports/reports.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    /**
     * Global per-IP rate limit. Per-route limits (esp. OTP) are layered on top
     * via @Throttle() and the OtpThrottlerGuard with a per-(IP+target) tracker.
     */
    ThrottlerModule.forRoot([
      { name: "short",  ttl: 1000,    limit: 20  },     // burst: 20 req/sec
      { name: "medium", ttl: 60_000,  limit: 120 },     // sustained: 120 req/min
      { name: "long",   ttl: 3600_000, limit: 2000 },   // 2000 req/hour
    ]),
    DatabaseModule,
    TwilioModule,
    SmsModule,
    EmailModule,
    UploadsModule,
    HealthModule,
    AuthModule,
    StatsModule,
    DashboardModule,
    MobileLandlordModule,
    DeedsModule,
    PropertiesModule,
    UnitsModule,
    ContractsModule,
    EjarModule,
    ImportModule,
    PaymentsModule,
    BillingModule,
    PaymentConfirmationsModule,
    NotificationsModule,
    AdminModule,
    ProfileModule,
    OwnersModule,
    TenantsModule,
    MaintenanceModule,
    FacilitiesModule,
    CampaignsModule,
    SupportModule,
    TenantPortalModule,
    ContactModule,
    TeamModule,
    InvoiceModule,
    CompaniesModule,
    LookupsModule,
    PackageModule,
    SubscriptionModule,
    AuditModule,
    ReportsModule,
  ],
  providers: [
    // OtpThrottlerGuard extends ThrottlerGuard with two improvements: (1) it
    // honors the OTP_DEV_BYPASS env flag, (2) for OTP-style requests it tracks
    // per (IP + email/phone/identifier) instead of per-IP only. It's a strict
    // superset for non-OTP routes (falls back to IP-only tracking when no
    // identifier is in the body).
    { provide: APP_GUARD, useClass: OtpThrottlerGuard },
  ],
})
export class AppModule {}
