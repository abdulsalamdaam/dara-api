import { BadRequestException, Body, Controller, Get, Inject, Module, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, desc, eq } from "drizzle-orm";
import { usersTable, subscriptionPaymentsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { resolvePackage, planPrice, isPayablePlan, isPackagePlan, planAllowedForUserType, planUserTypeError, type BillingCycle } from "../../common/packages";
import { deriveSubscription } from "../../common/subscription";
import { trialView } from "../../common/trial";
import { createMoyasarInvoice, fetchMoyasarInvoice, cancelMoyasarInvoice, isMoyasarConfigured } from "../../common/moyasar";

const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || "https://app.dara-sa.net").replace(/\/$/, "");

/** Open / renew the subscription window for `cycle` starting now. */
function nextEndDate(cycle: BillingCycle, from = new Date()): Date {
  const d = new Date(from);
  if (cycle === "yearly") d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

type SubscriptionPaymentRow = typeof subscriptionPaymentsTable.$inferSelect;

/**
 * Mark a pending payment row paid and open/renew its owner's subscription.
 * Shared by the webhook (normal path) and the pay endpoint (defensive, when a
 * user re-clicks Pay after an already-paid invoice whose webhook was missed).
 * No-op if the row is already paid.
 */
async function activateFromPaidRow(db: Drizzle, row: SubscriptionPaymentRow, moyasarPaymentId?: string | null): Promise<void> {
  if (row.status === "paid") return;
  await db.update(subscriptionPaymentsTable)
    .set({ status: "paid", paidAt: new Date(), moyasarPaymentId: moyasarPaymentId ?? row.moyasarPaymentId ?? null })
    .where(eq(subscriptionPaymentsTable.id, row.id));
  const cycle = (row.billingCycle === "yearly" ? "yearly" : "monthly") as BillingCycle;
  const now = new Date();
  await db.update(usersTable).set({
    packagePlan: row.plan,
    billingCycle: cycle,
    // Payment confirmed → the desired selection is now the live plan.
    desiredPackagePlan: null,
    desiredBillingCycle: null,
    subscriptionStatus: "active",
    subscriptionStartedAt: now,
    subscriptionEndsAt: nextEndDate(cycle, now),
    // Paid — whatever free/trial window it replaces, this one is not a trial.
    // `trialConsumedAt` is deliberately NOT touched: it records that the
    // account had its one free trial, which paying does not undo.
    subscriptionIsTrial: false,
  }).where(eq(usersTable.id, row.userId));
}

@ApiTags("subscription")
@ApiBearerAuth("user-jwt")
@Controller("me/subscription")
@UseGuards(JwtAuthGuard)
class SubscriptionController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /** Subscription status + payment history for the current account. */
  @Get()
  async mySubscription(@CurrentUser() user: AuthUser) {
    const ownerId = scopeId(user);
    const [owner] = await this.db.select().from(usersTable).where(eq(usersTable.id, ownerId));
    const cycle = (owner?.billingCycle === "yearly" ? "yearly" : "monthly") as BillingCycle;
    const sub = deriveSubscription({ storedStatus: owner?.subscriptionStatus, subscriptionEndsAt: owner?.subscriptionEndsAt });
    const trial = trialView(!!owner?.subscriptionIsTrial, owner?.subscriptionEndsAt);
    const payments = await this.db.select().from(subscriptionPaymentsTable)
      .where(eq(subscriptionPaymentsTable.userId, ownerId))
      .orderBy(desc(subscriptionPaymentsTable.createdAt));
    // The single open invoice the user can resume (if any) — lets the UI offer
    // "Continue payment" instead of minting a fresh link on every click.
    const open = payments.find((p) => p.status === "pending" && !!p.paymentUrl);
    return {
      plan: resolvePackage(owner?.packagePlan).key,
      billingCycle: cycle,
      amountDue: planPrice(owner?.packagePlan, cycle),
      payable: isPayablePlan(owner?.packagePlan),
      moyasarConfigured: isMoyasarConfigured(),
      pendingPayment: open
        ? { id: open.id, plan: open.plan, billingCycle: open.billingCycle, amount: Number(open.amount), url: open.paymentUrl, createdAt: open.createdAt }
        : null,
      status: sub.status,
      isTrial: !!owner?.subscriptionIsTrial,
      // Null unless a trial is running — see `trialView`.
      trialEndsAt: trial.trialEndsAt,
      trialDaysRemaining: trial.trialDaysRemaining,
      needsPayment: sub.needsPayment,
      locked: sub.locked,
      graceUntil: sub.graceUntil,
      daysUntilLock: sub.daysUntilLock,
      subscriptionStartedAt: owner?.subscriptionStartedAt ?? null,
      subscriptionEndsAt: owner?.subscriptionEndsAt ?? null,
      payments,
    };
  }

  /**
   * Start a subscription payment. Optionally switches the plan/cycle first
   * (the "upgrade" path), then creates a Moyasar hosted invoice and returns
   * its payment URL. Only the account owner (not an employee) may pay.
   */
  @Post("pay")
  async pay(@CurrentUser() user: AuthUser, @Body() body: any) {
    if (user.ownerUserId) throw new BadRequestException("صلاحية الدفع لصاحب الحساب فقط");
    const ownerId = user.id;
    const [owner] = await this.db.select().from(usersTable).where(eq(usersTable.id, ownerId));
    if (!owner) throw new BadRequestException("Account not found");

    // Optional plan/cycle switch (upgrade or change cycle).
    let plan = owner.packagePlan;
    let cycle = (owner.billingCycle === "yearly" ? "yearly" : "monthly") as BillingCycle;
    if (body?.plan && isPackagePlan(body.plan)) plan = body.plan;
    if (body?.cycle === "monthly" || body?.cycle === "yearly") cycle = body.cycle;

    // Some plans are sold to one account type only (e.g. the Tenants plan is
    // for companies). This is the 4th path that ends up writing
    // `users.package_plan` (via the webhook) — enforce the same restriction the
    // registration / admin-approval / admin-change paths do, or an individual
    // account could buy a company-only plan straight from the billing screen.
    if (!planAllowedForUserType(plan, owner.userType)) {
      throw new BadRequestException(planUserTypeError(plan));
    }

    if (!isPayablePlan(plan)) throw new BadRequestException("هذه الباقة تُسعّر عند الطلب — تواصل مع المبيعات");
    const amount = planPrice(plan, cycle);
    if (!amount || amount <= 0) throw new BadRequestException("تعذّر تحديد قيمة الاشتراك");

    // Record the chosen plan/cycle as the DESIRED selection only — do NOT touch
    // the live package yet. The pending payment row below carries the choice,
    // and the webhook applies it once payment is actually confirmed. This stops
    // a click on "Pay" from upgrading/switching a user who never paid.
    await this.db.update(usersTable).set({ desiredPackagePlan: plan, desiredBillingCycle: cycle }).where(eq(usersTable.id, ownerId));

    if (!isMoyasarConfigured()) {
      throw new BadRequestException("بوابة الدفع غير مُهيأة بعد. يرجى المحاولة لاحقاً.");
    }

    // Reuse-or-replace: an account keeps at most ONE open invoice. Walk every
    // pending row (not just the latest — old ones can pile up), reuse a still-
    // open invoice that matches this exact selection, and supersede the rest.
    const pendings = await this.db.select().from(subscriptionPaymentsTable)
      .where(and(eq(subscriptionPaymentsTable.userId, ownerId), eq(subscriptionPaymentsTable.status, "pending")))
      .orderBy(desc(subscriptionPaymentsTable.createdAt));

    let reuse: typeof pendings[number] | null = null;
    for (const p of pendings) {
      const invStatus = p.moyasarInvoiceId
        ? await fetchMoyasarInvoice(p.moyasarInvoiceId).then((i) => String(i.status || "").toLowerCase()).catch(() => "")
        : "";
      if (invStatus === "paid") {
        // Already paid but the webhook hasn't landed — activate now and return.
        await activateFromPaidRow(this.db, p);
        return { paymentId: p.id, url: p.paymentUrl, invoiceId: p.moyasarInvoiceId, alreadyPaid: true };
      }
      const sameSelection = p.plan === plan && p.billingCycle === cycle && Number(p.amount) === amount;
      if (!reuse && invStatus === "initiated" && sameSelection) {
        // First (newest) still-open invoice for the same selection → reuse it.
        reuse = p;
        continue;
      }
      // Anything else (different selection, duplicate, failed/expired/unknown) →
      // void the Moyasar invoice (best-effort) and close the local row.
      if (p.moyasarInvoiceId) { try { await cancelMoyasarInvoice(p.moyasarInvoiceId); } catch { /* already paid/cancelled — non-fatal */ } }
      await this.db.update(subscriptionPaymentsTable)
        .set({ status: invStatus === "failed" ? "failed" : "cancelled" })
        .where(eq(subscriptionPaymentsTable.id, p.id));
    }
    if (reuse) {
      // Same plan/cycle and still payable → hand back the SAME link.
      return { paymentId: reuse.id, url: reuse.paymentUrl, invoiceId: reuse.moyasarInvoiceId, reused: true };
    }

    // Record a fresh pending payment, then create the Moyasar invoice referencing it.
    const [row] = await this.db.insert(subscriptionPaymentsTable).values({
      userId: ownerId, plan, billingCycle: cycle, amount: amount.toFixed(2), currency: "SAR", status: "pending",
    }).returning();

    const planLabel = resolvePackage(plan).labelAr;
    const invoice = await createMoyasarInvoice({
      amountSar: amount,
      description: `اشتراك دارا — ${planLabel} (${cycle === "yearly" ? "سنوي" : "شهري"})`,
      callbackUrl: `${APP_PUBLIC_URL}/dashboard/settings?section=billing&paid=1`,
      successUrl: `${APP_PUBLIC_URL}/dashboard/settings?section=billing&paid=1`,
      backUrl: `${APP_PUBLIC_URL}/dashboard/settings?section=billing`,
      metadata: { subscriptionPaymentId: String(row!.id), userId: String(ownerId), plan, cycle },
    });

    await this.db.update(subscriptionPaymentsTable)
      .set({ moyasarInvoiceId: invoice.id, paymentUrl: invoice.url })
      .where(eq(subscriptionPaymentsTable.id, row!.id));

    return { paymentId: row!.id, url: invoice.url, invoiceId: invoice.id };
  }
}

/**
 * Moyasar webhook (public — no JWT). Moyasar POSTs payment/invoice events;
 * we re-fetch the invoice to verify it's really paid, then activate/renew the
 * owner's subscription. Idempotent: a second call for an already-paid row is a
 * no-op.
 */
@ApiTags("subscription")
@Controller("subscription")
class SubscriptionWebhookController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  @Post("webhook")
  async webhook(@Body() body: any, @Req() _req: any) {
    // Optional shared-secret guard (set MOYASAR_WEBHOOK_SECRET + configure it
    // in the Moyasar dashboard).
    const expected = process.env.MOYASAR_WEBHOOK_SECRET;
    if (expected && body?.secret_token && body.secret_token !== expected) {
      // Was a bare `{ok:false}` with a 2xx, so Moyasar recorded a successful
      // delivery and the payment silently never activated — invisible from
      // both ends. Log it, and say so in the body.
      console.error("[moyasar] webhook REJECTED: secret_token mismatch", {
        expectedLen: expected.length,
        receivedLen: String(body.secret_token).length,
        hint: "the value in the Moyasar dashboard must equal MOYASAR_WEBHOOK_SECRET exactly",
      });
      return { ok: false, error: "secret_token_mismatch" };
    }
    if (expected && !body?.secret_token) {
      // Warning-only meant the guard could be walked straight past by simply
      // omitting the field — on a route that activates a paid subscription.
      console.error("[moyasar] webhook REJECTED: secret_token missing but one is configured");
      return { ok: false, error: "secret_token_missing" };
    }

    // Extract the invoice id from the various event shapes Moyasar may send.
    const data = body?.data ?? body ?? {};
    // `data.id` is the PAYMENT id on a payment event, NOT the invoice id.
    // Falling back to it made the lookup below search moyasar_invoice_id for a
    // payment id, which never matches: the handler returned 200 with
    // `unmatched`, so Moyasar logged a success while the row stayed pending
    // and the user was left on the plan-selection screen forever.
    const invoiceId: string | undefined =
      data.invoice_id || data?.invoice?.id || data?.metadata?.invoice_id;
    // Kept separately so it can be matched on and stored, not confused above.
    const eventPaymentId: string | undefined = data?.id;
    const metaPaymentId = data?.metadata?.subscriptionPaymentId;

    let paid = false;
    let verified = false;
    let paymentId: string | undefined = eventPaymentId;

    // "Don't trust the payload alone" was the intent; the code only managed it
    // when an invoice id happened to be present. Without one, `paid` came
    // straight out of an anonymous request body — so a POST carrying
    // {"data":{"status":"paid","metadata":{"subscriptionPaymentId":N}}}
    // activated that subscription. Nothing else on this route authenticates.
    if (invoiceId && isMoyasarConfigured()) {
      try {
        const inv = await fetchMoyasarInvoice(invoiceId);
        paid = String(inv.status).toLowerCase() === "paid";
        verified = true;
      } catch {
        // A transient Moyasar failure must not become an unverified
        // activation. Moyasar retries; answering "not verified" is the safe
        // half of that trade.
      }
    }
    if (!verified) {
      // The shared secret is the only other thing that can prove the sender.
      if (expected && body?.secret_token === expected) {
        paid = String(data?.status || "").toLowerCase() === "paid";
      } else {
        console.error("[moyasar] webhook REFUSED: payload could not be verified", {
          hasInvoiceId: !!invoiceId, moyasarConfigured: isMoyasarConfigured(),
        });
        return { ok: false, error: "unverified" };
      }
    }
    if (!paid) return { ok: true, ignored: true };

    // Locate the pending subscription_payment row.
    // Try every identifier the event can carry, rather than one and give up.
    let row: typeof subscriptionPaymentsTable.$inferSelect | undefined;
    if (invoiceId) {
      [row] = await this.db.select().from(subscriptionPaymentsTable)
        .where(eq(subscriptionPaymentsTable.moyasarInvoiceId, invoiceId));
    }
    if (!row && metaPaymentId != null) {
      // The metadata is attacker-controllable on this unauthenticated route:
      // a non-numeric value used to become NaN and blow up in the driver (500).
      // Anything that isn't a real row id now falls through to the same clean
      // `unmatched` answer a valid-but-unknown id already gets.
      // Exact digits only, and inside int4 — "3.7" used to resolve to row 3,
      // and a 13-digit value passed the safe-integer test and then overflowed
      // in the driver, 500ing an unauthenticated route.
      const raw = String(metaPaymentId).trim();
      const metaRowId = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
      if (Number.isInteger(metaRowId) && metaRowId > 0 && metaRowId <= 2147483647) {
        [row] = await this.db.select().from(subscriptionPaymentsTable)
          .where(eq(subscriptionPaymentsTable.id, metaRowId));
      }
    }
    if (!row && eventPaymentId) {
      // A payment event whose invoice_id we never saw: the payment id may
      // already be recorded from an earlier event.
      [row] = await this.db.select().from(subscriptionPaymentsTable)
        .where(eq(subscriptionPaymentsTable.moyasarPaymentId, eventPaymentId));
    }
    if (!row) {
      // Never silently 200 an unmatched paid event — that is how a real
      // payment goes missing with nothing to show for it.
      console.error("[moyasar] paid event matched no subscription_payment row", {
        invoiceId, eventPaymentId, metaPaymentId,
      });
      return { ok: true, unmatched: true };
    }
    if (row.status === "paid") return { ok: true, already: true };

    // Mark paid + activate/renew (start now, end one cycle later, clear pending).
    await activateFromPaidRow(this.db, row, paymentId ?? null);

    return { ok: true, activated: true };
  }
}

@Module({ controllers: [SubscriptionController, SubscriptionWebhookController] })
export class SubscriptionModule {}
