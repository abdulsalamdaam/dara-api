import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Optional, Param, Post, UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { and, eq, isNull, sql } from "drizzle-orm";
import { accountLimitAddonsTable, subscriptionPaymentsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard, type AuthUser } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { effectiveLimits } from "../../common/limits";
import { fetchMoyasarInvoice, isMoyasarConfigured } from "../../common/moyasar";
import { lookupConfig, windowBounds } from "../ejar/ejar.budget";
import { ejarLookupUsage } from "../ejar/ejar.usage";
import { ejarEnabledFor } from "../ejar/ejar.access";
import { activateFromPaidRow, evidenceFromInvoice, verifyMoyasarPaid } from "../subscription/subscription.module";
import { SubscriptionInvoiceService } from "../subscription/subscription-invoice.service";
import { LimitsService } from "./limits.service";
import { LIMITS_BILLING_PORT, type LimitsBillingPort } from "./limits-billing.port";
import type { AddonView, CatalogItem, EffectiveLimit } from "./limits.types";

export interface MyLimitsView {
  limits: EffectiveLimit[];
  addons: AddonView[];
  /** Offers / pending add-ons to pay, and admin grants not yet acknowledged — the banner's items. */
  notices: AddonView[];
  /** Always empty: add-ons are created by the admin only, nothing is sold self-serve. */
  catalog: CatalogItem[];
  ejar: { enabled: boolean; gateway: { limit: number; window: string; remaining: number } };
}

/**
 * The customer's side of account limits: what the account has and the
 * add-ons waiting on it. Add-ons are created by the ADMIN only (free grant,
 * invoice or offer) — there is no self-serve purchase. A customer can pay an
 * admin-issued offered / pending add-on (the ACCOUNT HOLDER only, like
 * `POST /me/subscription/pay`) and dismiss notices. Reading needs
 * SUBSCRIPTION_MANAGE.
 */
@ApiTags("limits")
@ApiBearerAuth("user-jwt")
@Controller("me/limits")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MeLimitsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly limits: LimitsService,
    @Inject(LIMITS_BILLING_PORT) private readonly billing: LimitsBillingPort,
    @Optional() private readonly invoices?: SubscriptionInvoiceService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  async myLimits(@CurrentUser() user: AuthUser): Promise<MyLimitsView> {
    const accountId = scopeId(user);
    const now = new Date();
    const cfg = lookupConfig(process.env);
    const { start } = windowBounds(cfg.window, now);
    const [limits, addons, unacked, enabled, usage] = await Promise.all([
      effectiveLimits(this.db, accountId, { now }),
      this.limits.addonViews(accountId),
      this.db.select({ id: accountLimitAddonsTable.id }).from(accountLimitAddonsTable)
        .where(and(eq(accountLimitAddonsTable.accountId, accountId), isNull(accountLimitAddonsTable.acknowledgedAt))),
      ejarEnabledFor(this.db, accountId, user.id),
      ejarLookupUsage(this.db, start, accountId),
    ]);
    const open = new Set(unacked.map((r) => r.id));
    const notices = addons.filter((a) => open.has(a.id) && isNotice(a, now));
    const gatewayUsed = Math.max(usage.invoices, usage.contracts, usage.details);
    return {
      limits,
      addons,
      notices,
      catalog: [],
      ejar: { enabled, gateway: { limit: cfg.limit, window: cfg.window, remaining: Math.max(0, cfg.limit - gatewayUsed) } },
    };
  }

  /**
   * Pay an admin-issued offered / pending add-on. Hands back its open checkout when the
   * invoice is still payable; opens a fresh one when it is not. When Moyasar
   * says the invoice was already paid (missed webhook) the add-on is activated
   * and `alreadyPaid` returned with no URL.
   */
  @Post("addons/:id/pay")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  async pay(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<{ url: string | null; alreadyPaid?: true }> {
    const accountId = this.assertHolder(user);
    const addonId = Number(id);
    if (!Number.isInteger(addonId) || addonId <= 0) throw new BadRequestException("invalid add-on id");
    const [addon] = await this.db.select().from(accountLimitAddonsTable)
      .where(and(eq(accountLimitAddonsTable.id, addonId), eq(accountLimitAddonsTable.accountId, accountId))).limit(1);
    if (!addon || addon.source === "self_serve") throw new NotFoundException("Add-on not found");
    if (addon.status !== "offered" && addon.status !== "pending_payment") {
      throw new BadRequestException(`هذه الإضافة ليست بانتظار الدفع · Add-on is ${addon.status}`);
    }
    if (addon.offerExpiresAt && new Date(addon.offerExpiresAt) <= new Date()) {
      throw new BadRequestException("انتهت مدة العرض · This offer has expired");
    }

    if (addon.paymentId != null) {
      const [row] = await this.db.select().from(subscriptionPaymentsTable)
        .where(and(eq(subscriptionPaymentsTable.id, addon.paymentId), eq(subscriptionPaymentsTable.userId, accountId))).limit(1);
      if (row?.status === "paid") return { url: null, alreadyPaid: true };
      if (row?.status === "pending" && row.moyasarInvoiceId && isMoyasarConfigured()) {
        const inv = await fetchMoyasarInvoice(row.moyasarInvoiceId).catch(() => null);
        const st = String(inv?.status || "").toLowerCase();
        if (st === "paid") {
          const ev = evidenceFromInvoice(inv!);
          if (verifyMoyasarPaid(row, ev).ok) {
            await activateFromPaidRow(this.db, row, { moyasarPaymentId: ev.paymentId, paidAt: ev.paidAt }, this.invoices);
            return { url: null, alreadyPaid: true };
          }
          throw new BadRequestException("الدفعة قيد المراجعة، تواصل مع الدعم · This payment needs review; contact support");
        }
        if (st === "initiated" && row.paymentUrl) {
          if (addon.status === "offered") await this.markPending(addon.id);
          return { url: row.paymentUrl };
        }
      }
      // Not payable any more: close the old row before opening a new one.
      await this.billing.cancelAddonPayment(addon).catch(() => undefined);
    }

    if (!isMoyasarConfigured()) throw new BadRequestException("بوابة الدفع غير مُهيأة بعد. يرجى المحاولة لاحقاً.");
    const payment = await this.billing.createAddonPayment(addon);
    if (!payment.paymentId || !payment.payUrl) throw new BadRequestException("تعذّر إنشاء فاتورة الدفع، حاول لاحقاً");
    await this.db.update(accountLimitAddonsTable)
      .set({ paymentId: payment.paymentId, ...(addon.status === "offered" ? { status: "pending_payment" as const } : {}) })
      .where(eq(accountLimitAddonsTable.id, addon.id));
    return { url: payment.payUrl };
  }

  /** Dismiss a notice (the banner). Any user with SUBSCRIPTION_MANAGE on the account. */
  @Post("notices/:id/ack")
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  async ack(@CurrentUser() user: AuthUser, @Param("id") id: string): Promise<{ ok: true }> {
    const accountId = scopeId(user);
    const addonId = Number(id);
    if (!Number.isInteger(addonId) || addonId <= 0) throw new BadRequestException("invalid id");
    const [row] = await this.db.update(accountLimitAddonsTable)
      .set({ acknowledgedAt: sql`coalesce(${accountLimitAddonsTable.acknowledgedAt}, now())` })
      .where(and(eq(accountLimitAddonsTable.id, addonId), eq(accountLimitAddonsTable.accountId, accountId)))
      .returning({ id: accountLimitAddonsTable.id });
    if (!row) throw new NotFoundException("Notice not found");
    return { ok: true };
  }

  private async markPending(addonId: number) {
    await this.db.update(accountLimitAddonsTable).set({ status: "pending_payment" })
      .where(and(eq(accountLimitAddonsTable.id, addonId), eq(accountLimitAddonsTable.status, "offered")));
  }

  /** Only the account holder pays (not an employee). Returns the account id. */
  private assertHolder(user: AuthUser): number {
    if (user.ownerUserId) throw new ForbiddenException("صلاحية الدفع لصاحب الحساب فقط · Only the account holder can pay");
    return user.id;
  }
}

/**
 * A banner item: an offer or checkout waiting for payment (and not past its
 * expiry), or an add-on an admin granted / invoiced-and-activated that is
 * running now.
 */
function isNotice(a: AddonView, now: Date): boolean {
  if (a.status === "offered" || a.status === "pending_payment") {
    return !a.offerExpiresAt || new Date(a.offerExpiresAt) > now;
  }
  if (a.status === "active" && a.source !== "self_serve") {
    return !a.endsAt || new Date(a.endsAt) > now;
  }
  return false;
}
