import { Module } from "@nestjs/common";
import { AdminLimitsController } from "./admin-limits.controller";
import { MeLimitsController } from "./me-limits.controller";
import { AddonCatalogService } from "./addon-catalog.service";
import { LimitsService } from "./limits.service";
import { LIMITS_BILLING_PORT, LIMITS_NOTIFIER } from "./limits-billing.port";
import { LimitsBillingService } from "./limits-billing.service";
import { LimitsEmailNotifier } from "./limits-notifier.service";
import { LimitsHousekeepingService } from "./limits-housekeeping.service";
import { LimitsReachedService } from "./limits-reached.service";
import { SubscriptionModule } from "../subscription/subscription.module";

/**
 * Account limits: admin overrides, add-ons, the per-account Ejar switch
 * (common/limits.ts holds the effective-limit math every gate reads), the
 * customer routes (/me/limits…), add-on billing through Moyasar
 * (LimitsBillingService), the emails (LimitsEmailNotifier), the hourly
 * housekeeping and the `limit_reached` audit event at a refusing gate.
 * Add-ons are created by the admin only; customers pay and acknowledge them.
 *
 * SubscriptionModule provides SubscriptionInvoiceService, which activation
 * outside the webhook (pay self-heal, housekeeping) issues the invoice with.
 */
@Module({
  imports: [SubscriptionModule],
  controllers: [AdminLimitsController, MeLimitsController],
  providers: [
    LimitsService,
    AddonCatalogService,
    LimitsBillingService,
    LimitsEmailNotifier,
    LimitsHousekeepingService,
    LimitsReachedService,
    { provide: LIMITS_BILLING_PORT, useExisting: LimitsBillingService },
    { provide: LIMITS_NOTIFIER, useExisting: LimitsEmailNotifier },
  ],
  exports: [LimitsService, AddonCatalogService],
})
export class LimitsModule {}
