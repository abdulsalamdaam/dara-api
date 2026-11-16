import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { usersTable, subscriptionPaymentsTable, paymentMethodsTable, type PaymentMethod } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { resolvePackage, isPayablePlan, purchasableCycle, planPrice, CYCLE_LABEL_AR } from "../../common/packages";
import { deriveSubscription } from "../../common/subscription";
import {
  isMoyasarConfigured, isMoyasarTestMode, moyasarPublishableKey, moyasarAppTag,
  fetchMoyasarPayment, findMoyasarPayment, chargeMoyasarToken, fetchMoyasarToken, deleteMoyasarToken,
  type MoyasarPaymentFull,
} from "../../common/moyasar";
import { EmailService } from "../email/email.service";
import { AppLogService } from "../../common/logging/app-log.service";
import { SubscriptionInvoiceService } from "./subscription-invoice.service";
import { activateFromPaidRow, evidenceFromPayment, resolvePaySelection, sharedGroupCharge, verifyMoyasarPaid } from "./subscription.module";

/**
 * Recurring subscription billing with Moyasar tokens (migration 0097).
 *
 *   checkout   the first payment, made in-app with Moyasar.js and
 *              `save_card: true`. Confirmed server-side (GET /v1/payments/:id)
 *              — never on the browser's redirect alone — then the token is
 *              saved, the subscription activated and the renewal scheduled.
 *   renewal    the hourly job (RecurringBillingScheduler) charges the saved
 *              token when `users.next_billing_at` passes.
 *   dunning    a failed charge → past_due, retried on day 1, 3 and 7 after the
 *              period end, with an "update your card" email each time. After
 *              the last failure nothing more is tried; the account locks when
 *              the existing 15-day grace ends (common/subscription.ts).
 *
 * Double-charge protection, in layers:
 *   1. one renewal row per (account, period end) — a unique index; a second
 *      job run's INSERT loses and does nothing;
 *   2. the row is claimed (`processing`) by a conditional UPDATE before any
 *      call to Moyasar, so a retry of a failed attempt is taken by one runner;
 *   3. every attempt carries a Moyasar `given_id` stored BEFORE the call;
 *      Moyasar answers a repeated id with the existing payment. A run that
 *      died mid-call leaves `processing` + that id, and the next run looks the
 *      payment up by it instead of charging again.
 *
 * Flags (env):
 *   BILLING_TOKENIZATION_ENABLED=true  in-app checkout + saved cards
 *   BILLING_AUTORENEW_ENABLED=true     the hourly renewal job
 *   BILLING_APPLEPAY_RECURRING=true    keep Apple Pay tokens for renewals
 *   BILLING_EMAIL_ALLOWLIST=a@x,b@y    renewal emails only to these (staging)
 *   MOYASAR_PUBLISHABLE_KEY            the browser form's key (pk_…)
 */

export const RETRY_DAYS = [1, 3, 7] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A `processing` row older than this was left by a run that died mid-call. */
export const STALE_PROCESSING_MS = 15 * 60 * 1000;
const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || "https://app.dara-sa.com").replace(/\/$/, "");

const flag = (k: string) => String(process.env[k] || "").toLowerCase() === "true";
export const tokenizationEnabled = () => flag("BILLING_TOKENIZATION_ENABLED") && isMoyasarConfigured() && !!moyasarPublishableKey();
export const autoRenewEnabled = () => flag("BILLING_AUTORENEW_ENABLED");
export const applePayRecurringEnabled = () => flag("BILLING_APPLEPAY_RECURRING");

type Row = typeof subscriptionPaymentsTable.$inferSelect;

export type RenewOutcome =
  | { status: "paid"; paymentRowId: number; moyasarPaymentId: string }
  | { status: "failed"; paymentRowId: number; reason: string; final: boolean; nextRetryAt: Date | null }
  | { status: "card_unusable"; reason: string }
  | { status: "in_flight"; paymentRowId: number }
  | { status: "pending_unknown"; paymentRowId: number; reason: string }
  | { status: "skipped"; reason: string };

/** "Visa •••• 1111" — what an email or the UI calls a saved card. */
export function cardLabel(m: Pick<PaymentMethod, "type" | "brand" | "last4"> | null | undefined): string | null {
  if (!m) return null;
  if (m.type === "applepay") return `Apple Pay${m.last4 ? ` •••• ${m.last4}` : ""}`;
  const known: Record<string, string> = { visa: "Visa", master: "Mastercard", mastercard: "Mastercard", mada: "mada", amex: "Amex", unionpay: "UnionPay" };
  const b = (m.brand || "").toLowerCase();
  const brand = known[b] ?? (m.brand ? m.brand.charAt(0).toUpperCase() + m.brand.slice(1) : "Card");
  return `${brand}${m.last4 ? ` •••• ${m.last4}` : ""}`;
}

/** When the next automatic retry is due after `failures` failed attempts, or null when there is none left. */
export function nextRetryAt(periodEnd: Date, failures: number, now = new Date()): Date | null {
  const days = RETRY_DAYS[failures - 1];
  if (days == null) return null;
  const at = new Date(periodEnd.getTime() + days * DAY_MS);
  // A charge that runs late (the job was off, or an admin ran it by hand) must
  // still leave a gap before the next try.
  return at.getTime() > now.getTime() ? at : new Date(now.getTime() + DAY_MS);
}

function last4From(masked?: string | null): string | null {
  const m = String(masked || "").match(/(\d{4})\s*$/);
  return m ? m[1] : null;
}

function tokenType(sourceType?: string | null): PaymentMethod["type"] {
  return sourceType === "applepay" ? "applepay" : sourceType === "samsungpay" ? "samsungpay" : "card";
}

@Injectable()
export class RecurringBillingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly invoices: SubscriptionInvoiceService,
    @Optional() private readonly email?: EmailService,
    @Optional() private readonly appLog?: AppLogService,
  ) {}

  /* ── Read ──────────────────────────────────────────────────────────── */

  /** The saved card + renewal schedule for the billing page. */
  async overview(ownerId: number) {
    const [u] = await this.db.select().from(usersTable).where(eq(usersTable.id, ownerId));
    if (!u) throw new NotFoundException("Account not found");
    const method = await this.defaultMethod(ownerId, u.defaultPaymentMethodId);
    return {
      enabled: tokenizationEnabled(),
      publishableKey: tokenizationEnabled() ? moyasarPublishableKey() : null,
      testMode: isMoyasarTestMode(),
      applePay: applePayRecurringEnabled(),
      autoRenew: !!u.autoRenew,
      billingState: u.billingState ?? "ok",
      failedAttempts: u.billingFailedAttempts ?? 0,
      nextBillingAt: u.nextBillingAt ?? null,
      paymentMethod: method && method.status !== "deleted"
        ? {
          id: method.id, type: method.type, brand: method.brand, last4: method.last4,
          expMonth: method.expMonth, expYear: method.expYear, status: method.status, label: cardLabel(method),
        }
        : null,
    };
  }

  private async defaultMethod(ownerId: number, id?: number | null): Promise<PaymentMethod | null> {
    if (!id) return null;
    const [m] = await this.db.select().from(paymentMethodsTable)
      .where(and(eq(paymentMethodsTable.id, id), eq(paymentMethodsTable.userId, ownerId), isNull(paymentMethodsTable.deletedAt)));
    return m ?? null;
  }

  /* ── Checkout (first payment, saves the card) ──────────────────────── */

  /**
   * Open an in-app checkout: a pending `checkout` row, and what the Moyasar.js
   * form needs to charge it. The form itself (in the browser, publishable key)
   * makes the payment; `complete` then confirms it with Moyasar.
   */
  async startCheckout(user: AuthUser, body: any) {
    if (!tokenizationEnabled()) throw new BadRequestException({ code: "TOKENIZATION_DISABLED", message: "الدفع داخل التطبيق غير مفعّل" });
    const { ownerId, plan, cycle, amount, shared } = await resolvePaySelection(this.db, user, body);

    // One open checkout per account: an earlier one the user abandoned is closed
    // — unless Moyasar says it was actually paid, in which case it is settled now.
    const open = await this.db.select().from(subscriptionPaymentsTable)
      .where(and(
        eq(subscriptionPaymentsTable.userId, ownerId),
        eq(subscriptionPaymentsTable.chargeType, "checkout"),
        eq(subscriptionPaymentsTable.status, "pending"),
      ));
    for (const p of open) {
      if (p.moyasarPaymentId) {
        const r = await this.finalizeRow(p, p.moyasarPaymentId).catch(() => null);
        if (r?.status === "paid") return { alreadyPaid: true, paymentId: p.id };
      }
      await this.db.update(subscriptionPaymentsTable).set({ status: "cancelled" })
        .where(and(eq(subscriptionPaymentsTable.id, p.id), eq(subscriptionPaymentsTable.status, "pending")));
    }

    const planLabel = resolvePackage(plan).labelAr;
    const description = shared && shared.extras > 0
      ? `اشتراك دارا — ${planLabel} الموحدة لـ ${shared.extras + 1} حسابات (${CYCLE_LABEL_AR[cycle]})`
      : `اشتراك دارا — ${planLabel} (${CYCLE_LABEL_AR[cycle]})`;
    const [row] = await this.db.insert(subscriptionPaymentsTable).values({
      userId: ownerId, plan, billingCycle: cycle, amount: amount.toFixed(2), currency: "SAR", status: "pending",
      chargeType: "checkout",
      description: shared && shared.extras > 0
        ? `اشتراك باقة «${planLabel}» الموحدة — ${CYCLE_LABEL_AR[cycle]} — تشمل ${shared.extras + 1} حسابات مرتبطة`
        : null,
    }).returning();

    return {
      paymentId: row!.id,
      amount,
      amountHalalas: Math.round(amount * 100),
      currency: "SAR",
      description,
      publishableKey: moyasarPublishableKey(),
      callbackUrl: `${APP_PUBLIC_URL}/dashboard/settings?section=billing&checkout=${row!.id}`,
      metadata: { subscriptionPaymentId: String(row!.id), userId: String(ownerId), plan, cycle, app: moyasarAppTag() },
      methods: ["creditcard", "applepay"],
      saveCard: true,
    };
  }

  /**
   * The browser reports the Moyasar payment id as soon as Moyasar.js creates
   * it (`on_completed`, before 3DS), so the webhook and `complete` can find it.
   * Recorded only — nothing is trusted or activated here.
   */
  async recordCheckoutPayment(user: AuthUser, rowId: number, paymentId: string) {
    const row = await this.ownCheckoutRow(user, rowId);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(paymentId || ""))) throw new BadRequestException("رقم عملية الدفع غير صالح");
    if (row.status !== "pending") return { ok: true, status: row.status };
    await this.db.update(subscriptionPaymentsTable).set({ moyasarPaymentId: paymentId })
      .where(and(eq(subscriptionPaymentsTable.id, row.id), eq(subscriptionPaymentsTable.status, "pending")));
    return { ok: true };
  }

  /** The user is back from the form (or 3DS): confirm with Moyasar and activate. */
  async completeCheckout(user: AuthUser, rowId: number, paymentId?: string | null) {
    const row = await this.ownCheckoutRow(user, rowId);
    const pid = paymentId || row.moyasarPaymentId;
    if (!pid) throw new BadRequestException("لا توجد عملية دفع لهذا الطلب");
    if (row.moyasarPaymentId && paymentId && row.moyasarPaymentId !== paymentId) {
      throw new BadRequestException("عملية الدفع لا تخص هذا الطلب");
    }
    return this.finalizeRow(row, pid);
  }

  private async ownCheckoutRow(user: AuthUser, rowId: number): Promise<Row> {
    if (user.ownerUserId) throw new BadRequestException("صلاحية الدفع لصاحب الحساب فقط");
    if (!Number.isInteger(rowId) || rowId <= 0) throw new BadRequestException("رقم الدفعة غير صالح");
    const [row] = await this.db.select().from(subscriptionPaymentsTable)
      .where(and(eq(subscriptionPaymentsTable.id, rowId), eq(subscriptionPaymentsTable.userId, user.id), eq(subscriptionPaymentsTable.chargeType, "checkout")));
    if (!row) throw new NotFoundException("الدفعة غير موجودة");
    return row;
  }

  /** Fetch the payment from Moyasar and settle the row on what it says. */
  private async finalizeRow(row: Row, paymentId: string) {
    const p = await fetchMoyasarPayment(paymentId);
    return this.applyVerifiedPayment(row, p);
  }

  /**
   * A payment Moyasar itself reported (fetched with our secret key, or a
   * webhook whose shared secret proved the sender) for a `checkout` or
   * `renewal` row. Checked against the row (amount, currency, metadata,
   * environment) before anything is marked paid. Idempotent.
   */
  async applyVerifiedPayment(row: Row, p: MoyasarPaymentFull): Promise<{ status: string; activated?: boolean; reason?: string; autoRenew?: boolean }> {
    const ev = evidenceFromPayment(p as any);
    if (ev.status !== "paid") {
      if (ev.status === "failed" && row.chargeType === "checkout" && row.status === "pending") {
        await this.db.update(subscriptionPaymentsTable)
          .set({ status: "failed", failureReason: String(p.source?.message || "failed").slice(0, 300), moyasarPaymentId: p.id })
          .where(and(eq(subscriptionPaymentsTable.id, row.id), eq(subscriptionPaymentsTable.status, "pending")));
      }
      return { status: ev.status || "unknown", reason: p.source?.message ?? undefined };
    }
    const check = verifyMoyasarPaid(row, ev);
    if (!check.ok) {
      this.appLog?.record({
        level: "error", event: "moyasar_paid_unverified", context: "RecurringBilling", userId: row.userId,
        message: `subscription payment ${row.id}: Moyasar payment ${p.id} is paid but does not match the row — not activated`,
        meta: { paymentId: row.id, moyasarPaymentId: p.id, reason: check.reason },
      });
      return { status: "mismatch", reason: check.reason };
    }

    let autoRenew: boolean | undefined;
    // Save the card BEFORE activating, so the renewal schedule set below sees it.
    if (row.chargeType === "checkout" && p.source?.token) {
      autoRenew = await this.saveToken(row.userId, p.source.token, p.source, !!p.live);
    }
    const won = await activateFromPaidRow(this.db, row, { moyasarPaymentId: p.id, paidAt: ev.paidAt }, this.invoices);
    await this.scheduleNext(row.userId);
    return { status: "paid", activated: won, autoRenew };
  }

  /**
   * Keep the token from a paid checkout as the account's default payment
   * method. Returns whether automatic renewal is now on. An Apple Pay token is
   * kept only when BILLING_APPLEPAY_RECURRING is on (see the caveat in
   * DARA-NOTES) — otherwise the account renews by paying again by hand.
   */
  private async saveToken(userId: number, tokenId: string, source: MoyasarPaymentFull["source"], live: boolean): Promise<boolean> {
    const type = tokenType(source?.type);
    if (type !== "card" && !applePayRecurringEnabled()) return false;
    const tok = await fetchMoyasarToken(tokenId).catch(() => null);
    const [existing] = await this.db.select().from(paymentMethodsTable).where(eq(paymentMethodsTable.moyasarTokenId, tokenId));
    if (existing && existing.userId !== userId) {
      this.appLog?.record({ level: "error", event: "payment_method_foreign_token", context: "RecurringBilling", userId, message: `token already belongs to account ${existing.userId}`, meta: { tokenId } });
      return false;
    }
    const fields = {
      type,
      brand: tok?.brand ?? source?.company ?? null,
      last4: tok?.last_four ?? last4From(source?.number),
      expMonth: tok?.month != null ? Number(tok.month) || null : null,
      expYear: tok?.year != null ? Number(tok.year) || null : null,
      name: tok?.name ?? source?.name ?? null,
      // A paid payment's token is active; trust Moyasar's word when we have it.
      status: tok?.status ?? "active",
      live,
    };
    const id = existing
      ? (await this.db.update(paymentMethodsTable).set({ ...fields, deletedAt: null }).where(eq(paymentMethodsTable.id, existing.id)).returning())[0]!.id
      : (await this.db.insert(paymentMethodsTable).values({ userId, moyasarTokenId: tokenId, ...fields }).returning())[0]!.id;
    await this.makeDefault(userId, id);
    const [u] = await this.db.select({ billingState: usersTable.billingState }).from(usersTable).where(eq(usersTable.id, userId));
    // Paying again after cancelling turns renewal back on: the user just chose to pay with a saved card.
    await this.db.update(usersTable).set({ autoRenew: true, billingState: u?.billingState === "past_due" ? "past_due" : "ok" }).where(eq(usersTable.id, userId));
    return true;
  }

  /** `id` becomes the default; every other saved method of the account is removed (Moyasar + here). */
  private async makeDefault(userId: number, id: number) {
    const others = await this.db.select().from(paymentMethodsTable)
      .where(and(eq(paymentMethodsTable.userId, userId), ne(paymentMethodsTable.id, id), isNull(paymentMethodsTable.deletedAt)));
    await this.db.update(paymentMethodsTable).set({ isDefault: true }).where(eq(paymentMethodsTable.id, id));
    await this.db.update(usersTable).set({ defaultPaymentMethodId: id }).where(eq(usersTable.id, userId));
    for (const o of others) await this.removeMethod(o);
  }

  private async removeMethod(m: PaymentMethod) {
    try { await deleteMoyasarToken(m.moyasarTokenId); } catch (err) {
      // Not fatal: the token is unusable to us once it is off the account, and
      // Moyasar invalidates it when the card expires. Logged for a retry by hand.
      this.appLog?.record({ level: "warn", event: "moyasar_token_delete_failed", context: "RecurringBilling", userId: m.userId, message: "could not delete a Moyasar token", error: err, meta: { paymentMethodId: m.id } });
    }
    await this.db.update(paymentMethodsTable).set({ status: "deleted", isDefault: false, deletedAt: new Date() }).where(eq(paymentMethodsTable.id, m.id));
  }

  /**
   * Set `next_billing_at` from the account's state: the end of the paid window
   * when renewal is on and a usable card is saved; nothing otherwise. Resets
   * the failure count — called after a successful payment.
   */
  private async scheduleNext(userId: number) {
    const [u] = await this.db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!u) return;
    const m = await this.defaultMethod(userId, u.defaultPaymentMethodId);
    // `initiated`: the token of a payment that just settled can lag a moment;
    // the charge re-checks it with Moyasar before using it.
    const on = !!u.autoRenew && !!m && (m.status === "active" || m.status === "initiated") && u.billingState !== "canceled";
    await this.db.update(usersTable).set({
      nextBillingAt: on && u.subscriptionEndsAt ? u.subscriptionEndsAt : null,
      billingFailedAttempts: 0,
      billingState: u.billingState === "canceled" ? "canceled" : "ok",
    }).where(eq(usersTable.id, userId));
  }

  /* ── Manage card ───────────────────────────────────────────────────── */

  /**
   * Replace the saved card with a token the browser created with
   * POST /v1/tokens (publishable key; Moyasar verifies the card with a 1 SAR
   * authorization it voids). The token must be `active` before it replaces
   * anything; the old token is then deleted at Moyasar.
   */
  async replaceCard(user: AuthUser, tokenId: string) {
    if (user.ownerUserId) throw new BadRequestException("صلاحية الدفع لصاحب الحساب فقط");
    if (!tokenizationEnabled()) throw new BadRequestException({ code: "TOKENIZATION_DISABLED", message: "الدفع داخل التطبيق غير مفعّل" });
    if (!/^token_[A-Za-z0-9]{8,80}$/.test(String(tokenId || ""))) throw new BadRequestException("رمز البطاقة غير صالح");
    const userId = user.id;
    const tok = await fetchMoyasarToken(tokenId).catch(() => null);
    if (!tok) throw new BadRequestException("تعذّر التحقق من البطاقة");
    if (tok.status !== "active") throw new BadRequestException({ code: "TOKEN_NOT_ACTIVE", message: "لم يكتمل التحقق من البطاقة بعد" });
    const [existing] = await this.db.select().from(paymentMethodsTable).where(eq(paymentMethodsTable.moyasarTokenId, tokenId));
    if (existing && existing.userId !== userId) throw new BadRequestException("رمز البطاقة غير صالح");
    const fields = {
      type: "card" as const, brand: tok.brand ?? null, last4: tok.last_four ?? null,
      expMonth: tok.month != null ? Number(tok.month) || null : null,
      expYear: tok.year != null ? Number(tok.year) || null : null,
      name: tok.name ?? null, status: "active", live: !isMoyasarTestMode(), deletedAt: null,
    };
    const id = existing
      ? (await this.db.update(paymentMethodsTable).set(fields).where(eq(paymentMethodsTable.id, existing.id)).returning())[0]!.id
      : (await this.db.insert(paymentMethodsTable).values({ userId, moyasarTokenId: tokenId, ...fields }).returning())[0]!.id;
    await this.makeDefault(userId, id);

    const [u] = await this.db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (u && u.billingState !== "canceled") {
      // A new card while a renewal is owed (past due, or the period already
      // ended): charge it on the next run instead of waiting for a retry day.
      const owed = u.subscriptionEndsAt && new Date(u.subscriptionEndsAt).getTime() <= Date.now();
      // A new card starts a fresh dunning run: the old card's failures neither
      // keep the "update your card" warning up nor count against this one.
      await this.db.update(usersTable).set({
        autoRenew: true,
        nextBillingAt: owed ? new Date() : (u.subscriptionEndsAt ?? null),
        billingState: "ok",
        billingFailedAttempts: 0,
      }).where(eq(usersTable.id, userId));
    }
    return this.overview(userId);
  }

  /** Remove the saved card. Automatic renewal stops; the paid window runs to its end. */
  async removeCard(user: AuthUser) {
    if (user.ownerUserId) throw new BadRequestException("صلاحية الدفع لصاحب الحساب فقط");
    const methods = await this.db.select().from(paymentMethodsTable)
      .where(and(eq(paymentMethodsTable.userId, user.id), isNull(paymentMethodsTable.deletedAt)));
    for (const m of methods) await this.removeMethod(m);
    await this.db.update(usersTable).set({ defaultPaymentMethodId: null, autoRenew: false, nextBillingAt: null }).where(eq(usersTable.id, user.id));
    return this.overview(user.id);
  }

  /** Stop renewals. The paid window runs to its end; `deleteCard` also removes the token. */
  async cancel(user: AuthUser, deleteCard: boolean) {
    if (user.ownerUserId) throw new BadRequestException("صلاحية الدفع لصاحب الحساب فقط");
    await this.db.update(usersTable).set({ autoRenew: false, billingState: "canceled", nextBillingAt: null, billingFailedAttempts: 0 })
      .where(eq(usersTable.id, user.id));
    if (deleteCard) return this.removeCard(user);
    return this.overview(user.id);
  }

  /** Turn renewals back on with the saved card. */
  async resume(user: AuthUser) {
    if (user.ownerUserId) throw new BadRequestException("صلاحية الدفع لصاحب الحساب فقط");
    const [u] = await this.db.select().from(usersTable).where(eq(usersTable.id, user.id));
    const m = await this.defaultMethod(user.id, u?.defaultPaymentMethodId);
    if (!u || !m || m.status !== "active") throw new BadRequestException({ code: "NO_CARD", message: "أضف بطاقة لتفعيل التجديد التلقائي" });
    const owed = u.subscriptionEndsAt && new Date(u.subscriptionEndsAt).getTime() <= Date.now();
    await this.db.update(usersTable).set({
      autoRenew: true, billingState: "ok", billingFailedAttempts: 0,
      nextBillingAt: owed ? new Date() : (u.subscriptionEndsAt ?? null),
    }).where(eq(usersTable.id, user.id));
    return this.overview(user.id);
  }

  /* ── Renewal job ───────────────────────────────────────────────────── */

  /** Every account whose renewal is due, one at a time. Returns per-account outcomes. */
  async runDue(now = new Date(), limit = 100): Promise<Array<{ userId: number; outcome: RenewOutcome }>> {
    const due = await this.db.select({ id: usersTable.id }).from(usersTable)
      .where(and(
        eq(usersTable.autoRenew, true),
        lte(usersTable.nextBillingAt, now),
        ne(usersTable.billingState, "canceled"),
        isNull(usersTable.deletedAt),
      ))
      .orderBy(usersTable.nextBillingAt)
      .limit(limit);
    const out: Array<{ userId: number; outcome: RenewOutcome }> = [];
    for (const { id } of due) {
      try {
        out.push({ userId: id, outcome: await this.renewOne(id, { now }) });
      } catch (err) {
        this.appLog?.record({ level: "error", event: "renewal_crashed", context: "RecurringBilling", userId: id, message: "renewal threw — left for the next run", error: err });
        out.push({ userId: id, outcome: { status: "skipped", reason: "error" } });
      }
    }
    return out;
  }

  /**
   * Renew one account now. `force` (the admin "renew now" button) charges
   * even when the period has not ended or renewal is off — for end-to-end
   * testing; the new window still stacks on the old end, so nothing is lost.
   */
  async renewOne(userId: number, opts: { now?: Date; force?: boolean } = {}): Promise<RenewOutcome> {
    const now = opts.now ?? new Date();
    if (!isMoyasarConfigured()) return { status: "skipped", reason: "moyasar_not_configured" };
    const [u] = await this.db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!u) return { status: "skipped", reason: "no_account" };
    if (!opts.force) {
      if (!u.autoRenew || u.billingState === "canceled") return { status: "skipped", reason: "auto_renew_off" };
      if (!u.nextBillingAt || new Date(u.nextBillingAt).getTime() > now.getTime()) return { status: "skipped", reason: "not_due" };
    }
    if (!u.subscriptionEndsAt) return { status: "skipped", reason: "no_period" };
    const renewalOf = new Date(u.subscriptionEndsAt);
    const plan = u.packagePlan;
    const cycle = purchasableCycle(u.billingCycle);
    if (!isPayablePlan(plan)) {
      await this.db.update(usersTable).set({ nextBillingAt: null }).where(eq(usersTable.id, userId));
      return { status: "skipped", reason: "plan_not_payable" };
    }
    const shared = await sharedGroupCharge(this.db, userId, plan, cycle);
    const amount = shared ? shared.charged : planPrice(plan, cycle);
    if (!amount || amount <= 0) return { status: "skipped", reason: "no_amount" };

    const method = await this.defaultMethod(userId, u.defaultPaymentMethodId);

    // 1. Claim this period's renewal row (or the retry of a failed one).
    const claim = await this.claim(userId, renewalOf, { plan, cycle, amount, methodId: method?.id ?? null, description: shared && shared.extras > 0 ? `اشتراك باقة «${resolvePackage(plan).labelAr}» الموحدة — ${CYCLE_LABEL_AR[cycle]} — تشمل ${shared.extras + 1} حسابات مرتبطة` : null }, now);
    if (claim.kind === "paid") {
      await this.scheduleNext(userId);
      return { status: "skipped", reason: "already_paid" };
    }
    if (claim.kind === "busy") return { status: "in_flight", paymentRowId: claim.row.id };
    let row = claim.row;

    // 2. Recovery: an earlier run died mid-call with this given_id — look it up first.
    if (claim.kind === "recover") {
      const existing = await findMoyasarPayment(row.moyasarGivenId!).catch(() => undefined);
      if (existing === undefined) {
        await this.release(row, "processing");
        return { status: "pending_unknown", paymentRowId: row.id, reason: "moyasar_unreachable" };
      }
      if (existing) return this.settleCharge(u, row, method, existing, amount, renewalOf, now);
      // Never created at Moyasar: charge below with the same given_id.
    }

    // 3. Is the card still chargeable?
    const unusable = await this.unusableReason(method);
    if (unusable) {
      await this.db.update(subscriptionPaymentsTable).set({ status: "failed", failureReason: unusable }).where(eq(subscriptionPaymentsTable.id, row.id));
      await this.cardUnusable(u, method, amount, unusable);
      return { status: "card_unusable", reason: unusable };
    }

    // 4. Charge, idempotently.
    let p: MoyasarPaymentFull;
    try {
      p = await chargeMoyasarToken({
        givenId: row.moyasarGivenId!,
        token: method!.moyasarTokenId,
        amountSar: amount,
        description: `تجديد اشتراك دارا — ${resolvePackage(plan).labelAr} (${CYCLE_LABEL_AR[cycle]})`,
        callbackUrl: `${APP_PUBLIC_URL}/dashboard/settings?section=billing`,
        metadata: { subscriptionPaymentId: String(row.id), userId: String(userId), plan, cycle, app: moyasarAppTag(), kind: "renewal" },
      });
    } catch (err) {
      // We do not know whether Moyasar charged. The row stays `processing` with
      // its given_id; the next run (after STALE_PROCESSING_MS) looks it up.
      this.appLog?.record({ level: "error", event: "renewal_charge_unknown", context: "RecurringBilling", userId, message: "token charge failed without a payment — will look it up by given_id", error: err, meta: { paymentRowId: row.id, givenId: row.moyasarGivenId } });
      return { status: "pending_unknown", paymentRowId: row.id, reason: "charge_error" };
    }
    return this.settleCharge(u, row, method, p, amount, renewalOf, now);
  }

  /**
   * Claim the renewal row for (account, period end): insert it, or take over
   * a failed one for the next attempt, or a `processing` one an earlier run
   * abandoned. Exactly one runner gets `fresh`/`retry`/`recover` for a row.
   */
  private async claim(userId: number, renewalOf: Date, v: { plan: string; cycle: string; amount: number; methodId: number | null; description: string | null }, now: Date):
    Promise<{ kind: "fresh" | "retry" | "recover"; row: Row } | { kind: "busy"; row: Row } | { kind: "paid"; row: Row }> {
    const givenId = randomUUID();
    const inserted = await this.db.insert(subscriptionPaymentsTable).values({
      userId, plan: v.plan, billingCycle: v.cycle, amount: v.amount.toFixed(2), currency: "SAR",
      status: "processing", chargeType: "renewal", renewalOf, moyasarGivenId: givenId, attempt: 1,
      paymentMethodId: v.methodId, description: v.description,
    }).onConflictDoNothing().returning();
    if (inserted[0]) return { kind: "fresh", row: inserted[0] };

    const [row] = await this.db.select().from(subscriptionPaymentsTable)
      .where(and(eq(subscriptionPaymentsTable.userId, userId), eq(subscriptionPaymentsTable.chargeType, "renewal"), eq(subscriptionPaymentsTable.renewalOf, renewalOf)));
    if (!row) throw new Error("renewal row vanished after a conflicting insert");
    if (row.status === "paid") return { kind: "paid", row };
    if (row.status === "processing") {
      const stale = now.getTime() - new Date(row.updatedAt).getTime() > STALE_PROCESSING_MS;
      if (!stale) return { kind: "busy", row };
      // Take the abandoned row over — conditionally, so two recoverers cannot both win.
      const [took] = await this.db.update(subscriptionPaymentsTable).set({ updatedAt: now })
        // "still stale" rather than "updated_at = what we read": JS dates are
        // milliseconds, Postgres keeps microseconds, so equality never matches.
        .where(and(eq(subscriptionPaymentsTable.id, row.id), eq(subscriptionPaymentsTable.status, "processing"), lt(subscriptionPaymentsTable.updatedAt, new Date(now.getTime() - STALE_PROCESSING_MS))))
        .returning();
      return took ? { kind: "recover", row: took } : { kind: "busy", row };
    }
    // failed (or cancelled by hand): the next attempt, with a NEW given_id — the
    // old one is a payment Moyasar already declined.
    const [took] = await this.db.update(subscriptionPaymentsTable).set({
      status: "processing", moyasarGivenId: givenId, attempt: sql`${subscriptionPaymentsTable.attempt} + 1`,
      amount: v.amount.toFixed(2), plan: v.plan, billingCycle: v.cycle, paymentMethodId: v.methodId, failureReason: null, moyasarPaymentId: null,
    }).where(and(eq(subscriptionPaymentsTable.id, row.id), ne(subscriptionPaymentsTable.status, "processing"), ne(subscriptionPaymentsTable.status, "paid")))
      .returning();
    return took ? { kind: "retry", row: took } : { kind: "busy", row };
  }

  private async release(row: Row, status: "processing" | "failed") {
    await this.db.update(subscriptionPaymentsTable).set({ status }).where(eq(subscriptionPaymentsTable.id, row.id));
  }

  /** Why `m` cannot be charged right now, or null. Refreshes the token status from Moyasar. */
  private async unusableReason(m: PaymentMethod | null): Promise<string | null> {
    if (!m || m.status === "deleted") return "no_card";
    if (m.type !== "card" && !applePayRecurringEnabled()) return "applepay_not_recurring";
    const tok = await fetchMoyasarToken(m.moyasarTokenId).catch(() => null);
    if (tok && tok.status !== m.status) {
      await this.db.update(paymentMethodsTable).set({ status: tok.status }).where(eq(paymentMethodsTable.id, m.id));
    }
    const status = tok?.status ?? m.status;
    // A token lookup that failed is not proof the card is bad: try the charge.
    if (status !== "active") return `token_${status}`;
    return null;
  }

  /** Record Moyasar's answer to a renewal charge. */
  private async settleCharge(u: typeof usersTable.$inferSelect, row: Row, method: PaymentMethod | null, p: MoyasarPaymentFull, amount: number, renewalOf: Date, now: Date): Promise<RenewOutcome> {
    const status = String(p.status || "").toLowerCase();
    if (status === "paid") {
      const r = await this.applyVerifiedPayment(row, p);
      if (r.status === "paid") return { status: "paid", paymentRowId: row.id, moyasarPaymentId: p.id };
      // Paid at Moyasar but not provably this row — a human must look; never retry-charge it.
      await this.db.update(subscriptionPaymentsTable).set({ status: "failed", failureReason: `unverified:${r.reason}`, moyasarPaymentId: p.id }).where(eq(subscriptionPaymentsTable.id, row.id));
      await this.db.update(usersTable).set({ nextBillingAt: null }).where(eq(usersTable.id, u.id));
      return { status: "failed", paymentRowId: row.id, reason: `unverified:${r.reason}`, final: true, nextRetryAt: null };
    }

    // initiated = the issuer wants 3DS (`transaction_url`): the job cannot
    // complete that, the user has to pay by hand. No automatic retry.
    const needsAction = status === "initiated";
    const reason = needsAction ? "requires_3ds" : String(p.source?.message || status || "failed").slice(0, 300);
    await this.db.update(subscriptionPaymentsTable).set({ status: "failed", failureReason: reason, moyasarPaymentId: p.id })
      .where(eq(subscriptionPaymentsTable.id, row.id));

    // Apple Pay renewals are not documented by Moyasar: a failure falls back to asking for a card.
    if (method && method.type !== "card") {
      await this.cardUnusable(u, method, amount, `applepay_failed:${reason}`);
      return { status: "failed", paymentRowId: row.id, reason, final: true, nextRetryAt: null };
    }

    const failures = (u.billingFailedAttempts ?? 0) + 1;
    const retryAt = needsAction ? null : nextRetryAt(renewalOf, failures, now);
    const final = retryAt == null;
    await this.db.update(usersTable).set({ billingState: "past_due", billingFailedAttempts: failures, nextBillingAt: retryAt })
      .where(eq(usersTable.id, u.id));
    this.appLog?.record({ level: "warn", event: "renewal_failed", context: "RecurringBilling", userId: u.id, message: `renewal attempt ${failures} failed: ${reason}`, meta: { paymentRowId: row.id, final, retryAt } });
    await this.notify(u, { reason: needsAction ? "action_required" : "charge_failed", amount, final, nextRetryAt: retryAt, cardLabel: cardLabel(method) });
    return { status: "failed", paymentRowId: row.id, reason, final, nextRetryAt: retryAt };
  }

  /** The saved card cannot be charged: stop automatic attempts and ask for a new card. */
  private async cardUnusable(u: typeof usersTable.$inferSelect, method: PaymentMethod | null, amount: number, reason: string) {
    await this.db.update(usersTable).set({ billingState: "past_due", nextBillingAt: null }).where(eq(usersTable.id, u.id));
    this.appLog?.record({ level: "warn", event: "renewal_card_unusable", context: "RecurringBilling", userId: u.id, message: `renewal skipped: ${reason}`, meta: { paymentMethodId: method?.id ?? null } });
    await this.notify(u, { reason: "card_unusable", amount, final: true, nextRetryAt: null, cardLabel: cardLabel(method) });
  }

  private async notify(u: typeof usersTable.$inferSelect, payload: Parameters<EmailService["sendRenewalCardAction"]>[2]) {
    if (!this.email || !u.email) return;
    // Staging is a copy of production: renewal emails go only to the allowlist there.
    const allow = String(process.env.BILLING_EMAIL_ALLOWLIST || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allow.length && !allow.includes(u.email.toLowerCase())) {
      this.appLog?.record({ level: "warn", event: "renewal_email_suppressed", context: "RecurringBilling", userId: u.id, message: "renewal email not sent: address not on BILLING_EMAIL_ALLOWLIST" });
      return;
    }
    const sub = deriveSubscription({ storedStatus: u.subscriptionStatus, subscriptionEndsAt: u.subscriptionEndsAt, isTrial: u.subscriptionIsTrial });
    try {
      await this.email.sendRenewalCardAction(u.email, u.name || "", { ...payload, lockAt: sub.graceUntil });
    } catch (err) {
      this.appLog?.record({ level: "error", event: "renewal_email_failed", context: "RecurringBilling", userId: u.id, message: "could not send the renewal email", error: err });
    }
  }

  /** Admin view: the most recent renewal rows of an account. */
  async recentRenewals(userId: number) {
    return this.db.select().from(subscriptionPaymentsTable)
      .where(and(eq(subscriptionPaymentsTable.userId, userId), ne(subscriptionPaymentsTable.chargeType, "invoice")))
      .orderBy(desc(subscriptionPaymentsTable.createdAt)).limit(20);
  }
}
