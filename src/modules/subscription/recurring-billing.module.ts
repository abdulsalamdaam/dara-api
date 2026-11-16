import { Body, Controller, Delete, Get, Injectable, Logger, Module, Param, Post, UseGuards, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../common/guards/roles.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { SubscriptionModule, registerTokenPaymentHandler } from "./subscription.module";
import { RecurringBillingService, autoRenewEnabled } from "./recurring-billing.service";

/**
 * Saved card + in-app checkout (recurring billing, migration 0097). Same
 * `/me/subscription` prefix as the hosted-invoice endpoints; every route that
 * moves money or changes the card is the account holder's only.
 */
@ApiTags("subscription")
@ApiBearerAuth("user-jwt")
@Controller("me/subscription")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RecurringBillingController {
  constructor(private readonly billing: RecurringBillingService) {}

  /** The saved card, renewal schedule and whether in-app checkout is on. */
  @Get("payment-method")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  overview(@CurrentUser() user: AuthUser) {
    return this.billing.overview(scopeId(user));
  }

  /** Open an in-app checkout (Moyasar.js, save_card) for `{ plan?, cycle? }`. */
  @Post("checkout")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  checkout(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.billing.startCheckout(user, body);
  }

  /** Moyasar.js created the payment (`on_completed`): remember its id. Trusted for nothing. */
  @Post("checkout/:id/payment")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  recordPayment(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    return this.billing.recordCheckoutPayment(user, Number(id), String(body?.paymentId || ""));
  }

  /** Back from the form / 3DS: confirm with Moyasar (GET /v1/payments/:id) and activate. */
  @Post("checkout/:id/complete")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  complete(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    return this.billing.completeCheckout(user, Number(id), body?.paymentId ? String(body.paymentId) : null);
  }

  /** Replace the saved card with a verified Moyasar token `{ tokenId }`. */
  @Post("payment-method")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  replace(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.billing.replaceCard(user, String(body?.tokenId || ""));
  }

  /** Remove the saved card (renewals stop). */
  @Delete("payment-method")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  remove(@CurrentUser() user: AuthUser) {
    return this.billing.removeCard(user);
  }

  /** Stop automatic renewal `{ deleteCard? }`. The paid period runs to its end. */
  @Post("cancel")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  cancel(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.billing.cancel(user, body?.deleteCard === true);
  }

  /** Turn automatic renewal back on with the saved card. */
  @Post("resume")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  resume(@CurrentUser() user: AuthUser) {
    return this.billing.resume(user);
  }
}

/**
 * Platform admin: run one account's renewal now (end-to-end testing), and
 * see its checkout / renewal rows. `scripts/renew-one.ts` calls the first.
 */
@ApiTags("admin")
@ApiBearerAuth("user-jwt")
@Controller("admin/billing")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class RecurringBillingAdminController {
  constructor(private readonly billing: RecurringBillingService) {}

  @Post("renew/:userId")
  renewNow(@Param("userId") userId: string) {
    return this.billing.renewOne(Number(userId), { force: true });
  }

  @Post("run-due")
  runDue() {
    return this.billing.runDue();
  }

  @Get("renewals/:userId")
  renewals(@Param("userId") userId: string) {
    return this.billing.recentRenewals(Number(userId));
  }
}

const HOUR_MS = 60 * 60 * 1000;
const BOOT_DELAY_MS = 2 * 60 * 1000;

/**
 * The hourly renewal run. Off unless BILLING_AUTORENEW_ENABLED=true. Running
 * twice at once (two instances, an overlap with a manual run) is safe — the
 * per-period claim in RecurringBillingService is what prevents double charges;
 * the `ticking` guard only saves work inside one process.
 */
@Injectable()
export class RecurringBillingScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("RecurringBilling");
  private timer: NodeJS.Timeout | null = null;
  private boot: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly billing: RecurringBillingService) {}

  onModuleInit(): void {
    registerTokenPaymentHandler((row, payment) => this.billing.applyVerifiedPayment(row, payment));
    if (!autoRenewEnabled()) {
      this.logger.log("renewal job off (BILLING_AUTORENEW_ENABLED is not true)");
      return;
    }
    this.boot = setTimeout(() => void this.tick(), BOOT_DELAY_MS);
    this.boot.unref?.();
    this.timer = setInterval(() => void this.tick(), HOUR_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    registerTokenPaymentHandler(null);
    if (this.timer) clearInterval(this.timer);
    if (this.boot) clearTimeout(this.boot);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const out = await this.billing.runDue();
      if (out.length) {
        const by = out.reduce<Record<string, number>>((a, o) => { a[o.outcome.status] = (a[o.outcome.status] ?? 0) + 1; return a; }, {});
        this.logger.log(`renewal run: ${JSON.stringify(by)}`);
      }
    } catch (err: any) {
      this.logger.error(`renewal run failed: ${err?.message || err}`);
    } finally {
      this.ticking = false;
    }
  }
}

@Module({
  imports: [SubscriptionModule],
  controllers: [RecurringBillingController, RecurringBillingAdminController],
  providers: [RecurringBillingService, RecurringBillingScheduler],
})
export class RecurringBillingModule {}
