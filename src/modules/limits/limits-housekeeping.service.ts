import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { accountLimitAddonsTable, subscriptionPaymentsTable, type AccountLimitAddon } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { effectiveLimit, isLimitKey } from "../../common/limits";
import { fetchMoyasarInvoice, isMoyasarConfigured } from "../../common/moyasar";
import { activateFromPaidRow, evidenceFromInvoice, verifyMoyasarPaid } from "../subscription/subscription.module";
import { SubscriptionInvoiceService } from "../subscription/subscription-invoice.service";
import { LIMITS_BILLING_PORT, type LimitsBillingPort } from "./limits-billing.port";
import { LimitsService } from "./limits.service";
import { LimitsEmailNotifier } from "./limits-notifier.service";

const HOUR_MS = 60 * 60 * 1000;
/** First run shortly after boot, then hourly. */
const FIRST_RUN_MS = 2 * 60 * 1000;

export interface HousekeepingResult {
  expired: number[];
  cancelled: number[];
  /** Stale offers whose invoice turned out paid (missed webhook) — activated instead of cancelled. */
  activated: number[];
}

/**
 * Hourly add-on housekeeping:
 *  - an ACTIVE add-on past `ends_at` becomes `expired` (+ `addon_expiry`
 *    event, + email to the account holder). The gates already stopped counting
 *    it at `ends_at` (active is evaluated at read time); this makes it visible.
 *  - an OFFERED / PENDING_PAYMENT add-on past `offer_expires_at` is cancelled
 *    (+ `addon_cancel` event) and its Moyasar invoice voided — unless that
 *    invoice was in fact paid (a missed webhook), in which case it is activated.
 *
 * Kill switch: LIMITS_HOUSEKEEPING_DISABLED=1.
 */
@Injectable()
export class LimitsHousekeepingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("LimitsHousekeeping");
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly limits: LimitsService,
    @Inject(LIMITS_BILLING_PORT) private readonly billing: LimitsBillingPort,
    @Optional() private readonly notifier?: LimitsEmailNotifier,
    @Optional() private readonly invoices?: SubscriptionInvoiceService,
  ) {}

  static disabled(): boolean {
    return process.env.LIMITS_HOUSEKEEPING_DISABLED === "1";
  }

  onModuleInit(): void {
    if (LimitsHousekeepingService.disabled()) return;
    this.first = setTimeout(() => void this.tick(), FIRST_RUN_MS);
    this.first.unref?.();
    this.timer = setInterval(() => void this.tick(), HOUR_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.runOnce();
      if (r.expired.length || r.cancelled.length || r.activated.length) {
        this.log.log(`expired ${r.expired.length}, cancelled ${r.cancelled.length}, activated ${r.activated.length}`);
      }
    } catch (err: any) {
      if (err?.code !== "42P01") this.log.warn(`housekeeping failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass. One add-on's failure never stops the others. */
  async runOnce(now = new Date()): Promise<HousekeepingResult> {
    const out: HousekeepingResult = { expired: [], cancelled: [], activated: [] };

    const ended = await this.db.select().from(accountLimitAddonsTable).where(and(
      eq(accountLimitAddonsTable.status, "active"),
      isNotNull(accountLimitAddonsTable.endsAt),
      lte(accountLimitAddonsTable.endsAt, now),
    ));
    for (const a of ended) {
      try {
        if (await this.expire(a, now)) out.expired.push(a.id);
      } catch (err: any) {
        this.log.warn(`expiring add-on ${a.id} failed: ${err?.message ?? err}`);
      }
    }

    const stale = await this.db.select().from(accountLimitAddonsTable).where(and(
      inArray(accountLimitAddonsTable.status, ["offered", "pending_payment"]),
      isNotNull(accountLimitAddonsTable.offerExpiresAt),
      lte(accountLimitAddonsTable.offerExpiresAt, now),
    ));
    for (const a of stale) {
      try {
        if (await this.paidMeanwhile(a)) { out.activated.push(a.id); continue; }
        await this.limits.cancelAddon(a.accountId, a.id, "انتهت مدة العرض دون دفع · Offer expired unpaid", { userId: null, kind: "system" });
        out.cancelled.push(a.id);
      } catch (err: any) {
        this.log.warn(`cancelling stale add-on ${a.id} failed: ${err?.message ?? err}`);
      }
    }
    return out;
  }

  /** active → expired, with the effective limit just before and after `ends_at`. */
  private async expire(a: AccountLimitAddon, now: Date): Promise<boolean> {
    if (!isLimitKey(a.limitKey)) return false;
    const key = a.limitKey;
    const endedAt = new Date(a.endsAt!);
    const done = await this.db.transaction(async (raw) => {
      const tx = raw as unknown as Drizzle;
      await tx.execute(sql`select id from users where id = ${a.accountId} for update`);
      const before = (await effectiveLimit(tx, a.accountId, key, new Date(endedAt.getTime() - 1))).effective;
      const [row] = await tx.update(accountLimitAddonsTable).set({ status: "expired" })
        .where(and(eq(accountLimitAddonsTable.id, a.id), eq(accountLimitAddonsTable.status, "active")))
        .returning({ id: accountLimitAddonsTable.id });
      if (!row) return false;
      const after = (await effectiveLimit(tx, a.accountId, key, now)).effective;
      await this.limits.recordEvent(tx, {
        accountId: a.accountId, actor: { userId: null, kind: "system" }, source: "addon_expiry", limitKey: key,
        oldValue: before, newValue: after, addonId: a.id, paymentId: a.paymentId ?? null,
        meta: { endsAt: endedAt.toISOString(), quantity: a.quantity },
      });
      return true;
    });
    if (done && this.notifier) {
      try { await this.notifier.addonExpired(a); } catch (err: any) {
        this.log.warn(`expiry email for add-on ${a.id} failed: ${err?.message ?? err}`);
      }
    }
    return done;
  }

  /** Before cancelling a stale offer: was its invoice paid and the webhook missed? Then activate it. */
  private async paidMeanwhile(a: AccountLimitAddon): Promise<boolean> {
    if (a.paymentId == null || !isMoyasarConfigured()) return false;
    const [row] = await this.db.select().from(subscriptionPaymentsTable)
      .where(and(eq(subscriptionPaymentsTable.id, a.paymentId), eq(subscriptionPaymentsTable.kind, "addon"))).limit(1);
    if (!row || row.status !== "pending" || !row.moyasarInvoiceId) return false;
    const inv = await fetchMoyasarInvoice(row.moyasarInvoiceId).catch(() => null);
    if (String(inv?.status || "").toLowerCase() !== "paid") return false;
    const ev = evidenceFromInvoice(inv!);
    if (!verifyMoyasarPaid(row, ev).ok) return false;
    await activateFromPaidRow(this.db, row, { moyasarPaymentId: ev.paymentId, paidAt: ev.paidAt }, this.invoices);
    return true;
  }
}
