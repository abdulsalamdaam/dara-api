import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpException, HttpStatus, Inject, Injectable, Module, NotFoundException, Optional, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { usersTable, subscriptionPaymentsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { dhamenEnabled } from "../../common/billing-flags";
import { resolvePackage, CYCLE_LABEL_AR } from "../../common/packages";
import {
  DHAMEN_DETAIL, cancelDhamenPayment, createDhamenPayment, dhamenCustomerIdentifier, dhamenSdkUrl,
  fetchDhamenPaymentStatus, isDhamenConfigured, dhamenRef, rowIdFromRef, verifyDhamenPaid,
} from "../../common/dhamen";
export { dhamenRef, rowIdFromRef, verifyDhamenPaid } from "../../common/dhamen";
import { AppLogService } from "../../common/logging/app-log.service";
import { resolvePaySelection } from "./subscription.module";
import { RecurringBillingModule } from "./recurring-billing.module";
import { RecurringBillingService } from "./recurring-billing.service";

/**
 * Subscription payments through Dhamen (Elm) — staging trial, 28 Nov 2026.
 *
 *   checkout   a pending `checkout` row (gateway 'dhamen') + a Dhamen
 *              customer-payment; the browser mounts Dhamen's widget on the
 *              returned invoiceId (card, mada, Apple Pay).
 *   complete   after the widget's onSuccess: ask Dhamen for the status and
 *              activate. The widget's word is never enough.
 *   notify     Dhamen's Notifications API (public). Header credentials prove
 *              the sender; even so a notification is only a cue — the payment
 *              is re-checked with customer-payment-status before activation.
 *
 * Renewals are NOT handled yet: a Dhamen-paid period is renewed by paying
 * again (Dhamen's customer-payment-subsequent is the next step).
 *
 * Env:
 *   BILLING_DHAMEN_ENABLED=true | BILLING_DHAMEN_USERS=12,34   who sees it
 *   DHAMEN_BASE_URL, DHAMEN_APP_ID, DHAMEN_APP_KEY, DHAMEN_CLIENT_ID, DHAMEN_API_VERSION
 *   DHAMEN_NOTIFY_CLIENT_ID, DHAMEN_NOTIFY_SECRET   what Dhamen sends us in
 *                                                    x-dhamen-client-id / x-dhamen-secret
 *   DHAMEN_ENV_TAG   S (staging, default) | P — prefixes our references
 */

const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || "https://app.dara-sa.com").replace(/\/$/, "");
type Row = typeof subscriptionPaymentsTable.$inferSelect;

/** Constant-time compare that tolerates different lengths. */
function sameSecret(given: unknown, expected: string): boolean {
  const a = Buffer.from(String(given ?? ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A field of a notification, whatever its casing (the guide mixes PaymentID / paymentId). */
function pick(o: any, key: string): any {
  if (!o || typeof o !== "object") return undefined;
  const k = Object.keys(o).find((x) => x.toLowerCase() === key.toLowerCase());
  return k ? o[k] : undefined;
}

@Injectable()
export class DhamenBillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly recurring: RecurringBillingService,
    @Optional() private readonly appLog?: AppLogService,
  ) {}

  config(user: AuthUser) {
    const on = !user.ownerUserId && dhamenEnabled(scopeId(user));
    return { enabled: on, sdkUrl: on ? dhamenSdkUrl() : null };
  }

  async startCheckout(user: AuthUser, body: any) {
    if (!dhamenEnabled(user.ownerUserId ?? user.id)) throw new BadRequestException({ code: "DHAMEN_DISABLED", message: "الدفع عبر ضامن غير مفعّل لهذا الحساب" });
    const { ownerId, plan, cycle, amount, shared } = await resolvePaySelection(this.db, user, body);

    // One open Dhamen checkout per account. An earlier one is settled if Dhamen
    // says it was paid after all, otherwise cancelled (here and at Dhamen).
    const open = await this.db.select().from(subscriptionPaymentsTable).where(and(
      eq(subscriptionPaymentsTable.userId, ownerId),
      eq(subscriptionPaymentsTable.gateway, "dhamen"),
      eq(subscriptionPaymentsTable.status, "pending"),
    ));
    for (const p of open) {
      const r = await this.settle(p).catch(() => null);
      if (r?.status === "paid") return { alreadyPaid: true, paymentId: p.id };
      if (p.gatewayRef) await cancelDhamenPayment(p.gatewayRef).catch(() => false);
      await this.db.update(subscriptionPaymentsTable).set({ status: "cancelled" })
        .where(and(eq(subscriptionPaymentsTable.id, p.id), eq(subscriptionPaymentsTable.status, "pending")));
    }

    const planLabel = resolvePackage(plan).labelAr;
    const [row] = await this.db.insert(subscriptionPaymentsTable).values({
      userId: ownerId, plan, billingCycle: cycle, amount: amount.toFixed(2), currency: "SAR", status: "pending",
      chargeType: "checkout", gateway: "dhamen",
      description: shared && shared.extras > 0
        ? `اشتراك باقة «${planLabel}» الموحدة — ${CYCLE_LABEL_AR[cycle]} — تشمل ${shared.extras + 1} حسابات مرتبطة`
        : null,
    }).returning();
    const ref = dhamenRef(row!.id);
    await this.db.update(subscriptionPaymentsTable).set({ gatewayRef: ref }).where(eq(subscriptionPaymentsTable.id, row!.id));

    const [owner] = await this.db.select({ name: usersTable.name, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, ownerId));
    let created;
    try {
      created = await createDhamenPayment({
        paymentReferenceId: ref,
        name: owner?.name || `Dara ${ownerId}`,
        customerIdentifier: dhamenCustomerIdentifier(ownerId),
        amountSar: amount,
        returnUrl: `${APP_PUBLIC_URL}/dashboard/settings?section=billing&dhamen=${row!.id}`,
        expiresInMinutes: 60,
        recurring: true,
      });
    } catch (err) {
      await this.db.update(subscriptionPaymentsTable).set({ status: "failed", failureReason: "dhamen_create_failed" }).where(eq(subscriptionPaymentsTable.id, row!.id));
      this.appLog?.record({ level: "error", event: "dhamen_create_failed", context: "DhamenBilling", userId: ownerId, message: "Dhamen customer-payment failed", error: err, meta: { paymentId: row!.id } });
      throw new BadRequestException({ code: "DHAMEN_CREATE_FAILED", message: "تعذّر بدء الدفع عبر ضامن، حاول مرة أخرى" });
    }
    await this.db.update(subscriptionPaymentsTable).set({ gatewayInvoiceId: created.invoiceId, paymentUrl: created.paymentUrl })
      .where(eq(subscriptionPaymentsTable.id, row!.id));

    return {
      paymentId: row!.id,
      invoiceId: created.invoiceId,
      sdkUrl: dhamenSdkUrl(),
      amount,
      currency: "SAR",
      description: shared && shared.extras > 0
        ? `اشتراك دارا — ${planLabel} الموحدة لـ ${shared.extras + 1} حسابات (${CYCLE_LABEL_AR[cycle]})`
        : `اشتراك دارا — ${planLabel} (${CYCLE_LABEL_AR[cycle]})`,
    };
  }

  /** After the widget's onSuccess (or a return to the page): confirm with Dhamen and activate. */
  async complete(user: AuthUser, rowId: number) {
    if (user.ownerUserId) throw new BadRequestException("صلاحية الدفع لصاحب الحساب فقط");
    if (!Number.isInteger(rowId) || rowId <= 0) throw new BadRequestException("رقم الدفعة غير صالح");
    const [row] = await this.db.select().from(subscriptionPaymentsTable).where(and(
      eq(subscriptionPaymentsTable.id, rowId), eq(subscriptionPaymentsTable.userId, user.id), eq(subscriptionPaymentsTable.gateway, "dhamen"),
    ));
    if (!row) throw new NotFoundException("الدفعة غير موجودة");
    return this.settle(row);
  }

  /**
   * Ask Dhamen about this row and settle it on the answer. Idempotent: the
   * paid transition inside `activateFromPaidRow` is a conditional UPDATE.
   */
  async settle(row: Row): Promise<{ status: string; activated?: boolean; reason?: string; autoRenew?: boolean }> {
    if (row.status === "paid") return { status: "paid", activated: false };
    // A renewal is the renewal job's to settle (dunning, retries, next date).
    if (row.chargeType === "renewal") return this.recurring.settleDhamenRenewalRow(row);
    if (!row.gatewayRef) return { status: "unknown", reason: "no_reference" };
    const s = await fetchDhamenPaymentStatus(row.gatewayRef);
    const check = verifyDhamenPaid(row, s);
    if (check.ok) {
      const r = await this.recurring.applyDhamenPaid(row, s!);
      if (r.activated) this.appLog?.record({ level: "log", event: "dhamen_paid", context: "DhamenBilling", userId: row.userId, message: `subscription payment ${row.id} paid through Dhamen`, meta: { paymentId: row.id, brand: s?.paymentBrand ?? null, rrn: s?.rrn ?? null, autoRenew: r.autoRenew ?? null } });
      return r;
    }
    const detail = Number(s?.paymentStatusDetail);
    if (s && (detail === DHAMEN_DETAIL.REJECTED || detail === DHAMEN_DETAIL.EXPIRED || detail === DHAMEN_DETAIL.CANCELLED) && row.status === "pending") {
      await this.db.update(subscriptionPaymentsTable)
        .set({ status: "failed", failureReason: detail === DHAMEN_DETAIL.EXPIRED ? "dhamen_expired" : detail === DHAMEN_DETAIL.CANCELLED ? "dhamen_cancelled" : "dhamen_rejected" })
        .where(and(eq(subscriptionPaymentsTable.id, row.id), eq(subscriptionPaymentsTable.status, "pending")));
      return { status: "failed" };
    }
    if (s && Number(s.paymentStatus) === 1 && check.reason !== "not_found") {
      // Paid at Dhamen, but not provably this row (amount, refund) — a human must look.
      this.appLog?.record({ level: "error", event: "dhamen_paid_unverified", context: "DhamenBilling", userId: row.userId, message: `subscription payment ${row.id}: Dhamen says paid but it does not match — not activated`, meta: { paymentId: row.id, reason: check.reason } });
      return { status: "mismatch", reason: check.reason };
    }
    return { status: "pending", reason: check.reason };
  }

  /**
   * Dhamen's Notifications API. Returns the body Dhamen expects; throws (→ a
   * non-200) when we could not check a payment of ours, so Dhamen retries.
   */
  async notify(headers: Record<string, any>, body: any) {
    const id = process.env.DHAMEN_NOTIFY_CLIENT_ID || "";
    const secret = process.env.DHAMEN_NOTIFY_SECRET || "";
    // Unconfigured is a refusal, never an open door.
    if (!id || !secret || !sameSecret(headers["x-dhamen-client-id"], id) || !sameSecret(headers["x-dhamen-secret"], secret)) {
      this.appLog?.record({ level: "warn", event: "dhamen_notify_rejected", context: "DhamenBilling", message: "Dhamen notification refused: bad or missing credentials" });
      throw new HttpException({ status: "UNAUTHORIZED" }, HttpStatus.UNAUTHORIZED);
    }
    const header = pick(body, "Header");
    const list: any[] = Array.isArray(pick(body, "Notifications")) ? pick(body, "Notifications") : (pick(body, "NotificationType") ? [body] : []);
    const results: Array<{ notificationId: unknown; type: unknown; outcome: string }> = [];
    let retry = false;
    for (const n of list) {
      const type = String(pick(n, "NotificationType") || "");
      const ref = String(pick(pick(n, "Payment"), "PaymentID") || "");
      const rowId = rowIdFromRef(ref);
      if (!rowId) { results.push({ notificationId: pick(n, "NotificationId"), type, outcome: "ignored" }); continue; }
      const [row] = await this.db.select().from(subscriptionPaymentsTable)
        .where(and(eq(subscriptionPaymentsTable.id, rowId), eq(subscriptionPaymentsTable.gatewayRef, ref)));
      if (!row) { results.push({ notificationId: pick(n, "NotificationId"), type, outcome: "unknown_row" }); continue; }
      try {
        const r = await this.settle(row);
        results.push({ notificationId: pick(n, "NotificationId"), type, outcome: r.status });
      } catch (err) {
        retry = true;
        this.appLog?.record({ level: "error", event: "dhamen_notify_verify_failed", context: "DhamenBilling", userId: row.userId, message: "could not confirm a notified payment with Dhamen — asking for a retry", error: err, meta: { paymentId: row.id, type } });
        results.push({ notificationId: pick(n, "NotificationId"), type, outcome: "error" });
      }
    }
    this.appLog?.record({ level: "log", event: "dhamen_notify", context: "DhamenBilling", message: `Dhamen notification batch: ${results.length} item(s)`, meta: { batchId: pick(header, "BatchId") ?? null, results } });
    if (retry) throw new HttpException({ status: "RETRY" }, HttpStatus.SERVICE_UNAVAILABLE);
    return { responseId: String(pick(header, "BatchId") || `dara-${Date.now()}`), status: "SUCCESS" };
  }
}

/** The account holder's Dhamen checkout. */
@ApiTags("subscription")
@ApiBearerAuth("user-jwt")
@Controller("me/subscription/dhamen")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DhamenBillingController {
  constructor(private readonly dhamen: DhamenBillingService) {}

  /** Whether this account pays through Dhamen, and the widget script. */
  @Get("config")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  config(@CurrentUser() user: AuthUser) {
    return this.dhamen.config(user);
  }

  /** Open a Dhamen payment for `{ plan?, cycle? }`; mount the widget on the returned invoiceId. */
  @Post("checkout")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  checkout(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.dhamen.startCheckout(user, body);
  }

  /** Confirm with Dhamen and activate. Safe to call repeatedly. */
  @Post("checkout/:id/complete")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  complete(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.dhamen.complete(user, Number(id));
  }
}

/** Dhamen → us (public; header credentials). URL given to Dhamen: /api/subscription/dhamen/notify */
@ApiTags("subscription")
@Controller("subscription/dhamen")
export class DhamenNotifyController {
  constructor(private readonly dhamen: DhamenBillingService) {}

  @Post("notify")
  @HttpCode(200)
  notify(@Headers() headers: Record<string, any>, @Body() body: any) {
    if (!isDhamenConfigured()) throw new HttpException({ status: "NOT_CONFIGURED" }, HttpStatus.SERVICE_UNAVAILABLE);
    return this.dhamen.notify(headers, body);
  }
}

@Module({
  imports: [RecurringBillingModule],
  controllers: [DhamenBillingController, DhamenNotifyController],
  providers: [DhamenBillingService],
})
export class DhamenBillingModule {}
