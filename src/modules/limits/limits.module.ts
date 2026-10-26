import { Module } from "@nestjs/common";
import { AdminLimitsController } from "./admin-limits.controller";
import { AddonCatalogService } from "./addon-catalog.service";
import { LimitsService } from "./limits.service";
import { LIMITS_BILLING_PORT, LIMITS_NOTIFIER, NoopLimitsBillingPort, NoopLimitsNotifier } from "./limits-billing.port";

/**
 * Account limits: admin overrides, add-ons, the per-account Ejar switch
 * (common/limits.ts holds the effective-limit math every gate reads).
 *
 * The customer routes (/me/limits…), billing (LimitsBillingService for
 * LIMITS_BILLING_PORT), housekeeping and emails (LIMITS_NOTIFIER) are added
 * to this module by the billing side; until then the ports are no-ops.
 */
@Module({
  controllers: [AdminLimitsController],
  providers: [
    LimitsService,
    AddonCatalogService,
    { provide: LIMITS_BILLING_PORT, useClass: NoopLimitsBillingPort },
    { provide: LIMITS_NOTIFIER, useClass: NoopLimitsNotifier },
  ],
  exports: [LimitsService, AddonCatalogService],
})
export class LimitsModule {}
