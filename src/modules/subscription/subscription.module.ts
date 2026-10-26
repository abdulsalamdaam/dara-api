import { BadRequestException, Body, Controller, Get, Inject, Module, NotFoundException, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, desc, eq, ne } from "drizzle-orm";
import { usersTable, subscriptionPaymentsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { resolvePackage, planPrice, planPriceTable, isPayablePlan, isPackagePlan, isBillingCycle, parseCycle, purchasableCycle, CYCLE_LABEL_AR, planAllowedForUserType, planUserTypeError, type BillingCycle } from "../../common/packages";
import { deriveSubscription, nextEndDate, renewalPeriodStart } from "../../common/subscription";
import { planFeatures } from "../../common/plan-features";
import { trialView } from "../../common/trial";
import { createMoyasarInvoice, fetchMoyasarInvoice, cancelMoyasarInvoice, isMoyasarConfigured, type MoyasarInvoice, type MoyasarPayment } from "../../common/moyasar";
import { InvoiceModule } from "../invoice/invoice.module";
import { SubscriptionInvoiceService } from "./subscription-invoice.service";
import { AppLogService } from "../../common/logging/app-log.service";
import type { Response } from "express";
import { signalFv2Entitlement } from "../finance-v2/auto-provision-signal";
import { activateAddonFromPaidRow } from "./addon-activation";

const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || "https://app.dara-sa.com").replace(/\/$/, "");

type SubscriptionPaymentRow = typeof subscriptionPaymentsTable.$inferSelect;

/**
 * What Moyasar says happened, reduced to the facts a payment row is checked
 * against. Built either from an invoice we fetched ourselves
 * (`evidenceFromInvoice`) or from a webhook payload whose sender the shared
 * secret proved (`evidenceFromPayment`).
 */
export interface MoyasarPaidEvidence {
  status: string;
  /** Halalas. */
  amount: number;
  currency: string;
  invoiceId: string | null;
  metadata: Record<string, any> | null;
  paymentId: string | null;
  /** When the money actually moved, if Moyasar says. */
  paidAt: Date | null;
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * An invoice counts as paid only when Moyasar says so AND it carries a settled
 * payment for the full invoice amount (not authorized-only, not refunded).
 * The invoice's own `status` is not enough on its own: it is the one field
 * that has to be true, not the only one.
 */
export function evidenceFromInvoice(inv: MoyasarInvoice): MoyasarPaidEvidence {
  const invAmount = Number(inv.amount);
  const settled = (inv.payments ?? []).find((p) =>
    String(p?.status || "").toLowerCase() === "paid" &&
    Number(p?.amount) === invAmount &&
    !(Number(p?.refunded) > 0));
  const invStatus = String(inv.status || "").toLowerCase();
  return {
    status: invStatus === "paid" && settled ? "paid" : invStatus === "paid" ? "paid_without_settled_payment" : invStatus,
    amount: invAmount,
    currency: String(inv.currency || "").toUpperCase(),
    invoiceId: inv.id ?? null,
    metadata: inv.metadata ?? null,
    paymentId: settled?.id ?? null,
    paidAt: parseDate(settled?.created_at),
  };
}

/** A payment object straight from a webhook body (trusted only after the secret check). */
export function evidenceFromPayment(p: Partial<MoyasarPayment> & Record<string, any>): MoyasarPaidEvidence {
  const status = String(p?.status || "").toLowerCase();
  return {
    status: status === "paid" && Number(p?.refunded) > 0 ? "refunded" : status,
    amount: Number(p?.amount),
    currency: String(p?.currency || "").toUpperCase(),
    invoiceId: p?.invoice_id ?? null,
    metadata: p?.metadata ?? null,
    paymentId: p?.id ?? null,
    paidAt: parseDate(p?.created_at),
  };
}

/**
 * Is this evidence a successful payment OF THIS ROW? Status alone is not: the
 * amount and currency must be what the row asked for, and the Moyasar invoice
 * and metadata must point back at this row and this account. Staging and
 * production share one Moyasar account, so a paid invoice that belongs to the
 * other environment's row with the same id is a real, paid, and wrong match.
 */
export function verifyMoyasarPaid(
  row: Pick<SubscriptionPaymentRow, "id" | "userId" | "amount" | "currency" | "moyasarInvoiceId">,
  ev: MoyasarPaidEvidence,
): { ok: boolean; reason?: string } {
  if (ev.status !== "paid") return { ok: false, reason: `not_paid:${ev.status || "unknown"}` };
  const expected = Math.round(Number(row.amount) * 100);
  if (!Number.isFinite(ev.amount) || ev.amount !== expected) return { ok: false, reason: "amount_mismatch" };
  if (ev.currency !== String(row.currency || "SAR").toUpperCase()) return { ok: false, reason: "currency_mismatch" };
  if (row.moyasarInvoiceId) {
    if (ev.invoiceId !== row.moyasarInvoiceId) return { ok: false, reason: "invoice_mismatch" };
  }
  const meta = ev.metadata ?? {};
  const metaRow = meta.subscriptionPaymentId != null ? String(meta.subscriptionPaymentId) : null;
  const metaUser = meta.userId != null ? String(meta.userId) : null;
  if (metaRow != null && metaRow !== String(row.id)) return { ok: false, reason: "metadata_mismatch" };
  if (metaUser != null && metaUser !== String(row.userId)) return { ok: false, reason: "metadata_mismatch" };
  // A row with no Moyasar invoice on file can only be tied to a payment by
  // metadata naming both the row AND its account.
  if (!row.moyasarInvoiceId && (metaRow == null || metaUser == null)) return { ok: false, reason: "no_reference" };
  return { ok: true };
}

/**
 * Mark a payment row paid and open/renew its owner's subscription — ONLY for a
 * row whose payment has already been verified (`verifyMoyasarPaid`). Shared by
 * the webhook (normal path) and the pay endpoint (self-heal, when a user
 * re-clicks Pay after an already-paid invoice whose webhook was missed).
 *
 * Idempotent across callers: the paid transition is a conditional UPDATE, so
 * when the webhook and the pay endpoint race on the same row exactly one of
 * them wins, and only the winner activates and emails the invoice. Returns
 * whether this call was the one that marked the row paid.
 */
export async function activateFromPaidRow(
  db: Drizzle,
  row: SubscriptionPaymentRow,
  paid: { moyasarPaymentId?: string | null; paidAt?: Date | null } = {},
  invoices?: SubscriptionInvoiceService,
): Promise<boolean> {
  // An account-limit add-on payment activates the add-on and NOTHING else —
  // never the plan, the cycle or the subscription period below.
  if (row.kind === "addon") return activateAddonFromPaidRow(db, row, paid, invoices);
  if (row.status === "paid") return false;
  const [claimed] = await db.update(subscriptionPaymentsTable)
    .set({ status: "paid", paidAt: paid.paidAt ?? new Date(), moyasarPaymentId: paid.moyasarPaymentId ?? row.moyasarPaymentId ?? null })
    .where(and(eq(subscriptionPaymentsTable.id, row.id), ne(subscriptionPaymentsTable.status, "paid")))
    .returning({ id: subscriptionPaymentsTable.id });
  // Somebody else (the webhook, or a second click) already marked it paid,
  // activated the account and sent the invoice. Doing it again would email a
  // second "paid" invoice and restart the period.
  if (!claimed) return false;
  const cycle = parseCycle(row.billingCycle);
  // The new window continues from the old end (grace days are billed, never
  // given away) — see `renewalPeriodStart`. Judged at the moment of payment,
  // so a webhook that lands late does not push the customer past grace.
  const [acct] = await db.select({
    subscriptionStatus: usersTable.subscriptionStatus,
    subscriptionEndsAt: usersTable.subscriptionEndsAt,
    subscriptionIsTrial: usersTable.subscriptionIsTrial,
  }).from(usersTable).where(eq(usersTable.id, row.userId));
  const start = renewalPeriodStart({
    storedStatus: acct?.subscriptionStatus,
    subscriptionEndsAt: acct?.subscriptionEndsAt,
    isTrial: acct?.subscriptionIsTrial,
    paidAt: paid.paidAt ?? new Date(),
  });
  const end = nextEndDate(cycle, start);
  await db.update(usersTable).set({
    packagePlan: row.plan,
    billingCycle: cycle,
    // Payment confirmed → the desired selection is now the live plan.
    desiredPackagePlan: null,
    desiredBillingCycle: null,
    subscriptionStatus: "active",
    subscriptionStartedAt: start,
    subscriptionEndsAt: end,
    // Paid — whatever free/trial window it replaces, this one is not a trial.
    // `trialConsumedAt` is deliberately NOT touched: it records that the
    // account had its one free trial, which paying does not undo.
    subscriptionIsTrial: false,
  }).where(eq(usersTable.id, row.userId));

  // Issue the tax invoice and email it. Deliberately NOT awaited: this spawns
  // headless Chrome, and the caller is either a Moyasar webhook — which retries
  // the whole delivery if we are slow to answer — or a user waiting on a
  // redirect. The subscription is already active by the time this starts, and
  // every failure inside is logged and swallowed.
  if (invoices) {
    void invoices.issueAndEmail(db, row.id, { start, end });
  }
  // Finance v2 is on by default for plans that include accounting: queue the
  // automatic provisioning (webhook, pay self-heal and /sync all land here).
  // Fire-and-forget; it never throws and never delays this response.
  signalFv2Entitlement(row.userId, "subscription_paid");
  return true;
}

@ApiTags("subscription")
@ApiBearerAuth("user-jwt")
@Controller("me/subscription")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SubscriptionController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly invoices: SubscriptionInvoiceService,
    private readonly appLog?: AppLogService,
  ) {}

  /** Subscription status + payment history for the current account. */
  @Get()
  async mySubscription(@CurrentUser() user: AuthUser) {
    const ownerId = scopeId(user);
    const [owner] = await this.db.select().from(usersTable).where(eq(usersTable.id, ownerId));
    const cycle = parseCycle(owner?.billingCycle);
    const sub = deriveSubscription({ storedStatus: owner?.subscriptionStatus, subscriptionEndsAt: owner?.subscriptionEndsAt, isTrial: owner?.subscriptionIsTrial });
    const trial = trialView(!!owner?.subscriptionIsTrial, owner?.subscriptionEndsAt);
    const payments = await this.db.select().from(subscriptionPaymentsTable)
      .where(eq(subscriptionPaymentsTable.userId, ownerId))
      .orderBy(desc(subscriptionPaymentsTable.createdAt));
    // The single open invoice the user can resume (if any) — lets the UI offer
    // "Continue payment" instead of minting a fresh link on every click.
    // Subscription rows only: an add-on's open invoice is paid from the
    // limits card, never offered as "Continue payment" for the plan.
    const open = payments.find((p) => p.kind !== "addon" && p.status === "pending" && !!p.paymentUrl);
    return {
      plan: resolvePackage(owner?.packagePlan).key,
      // What the plan unlocks (common/plan-features.ts) — the same list /auth/me carries as `planFeatures`.
      features: planFeatures(owner?.packagePlan),
      billingCycle: cycle,
      // What the next payment costs — a monthly account renews quarterly.
      amountDue: planPrice(owner?.packagePlan, purchasableCycle(cycle)),
      // Every payable plan × cycle, so the checkout shows the amount that
      // will actually be charged rather than a copy of the price list.
      prices: planPriceTable(),
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
      // Every row carries `kind` ('subscription' | 'addon'), `addonId` and
      // `description` (the add-on's line text) straight from the table.
      payments: payments.map((p) => ({ ...p, kind: p.kind ?? "subscription", addonId: p.addonId ?? null, description: p.description ?? null })),
    };
  }

  /**
   * The tax invoice for one subscription payment, as a PDF.
   *
   * Rendered on demand rather than served from storage: the document is a pure
   * function of the payment row plus the buyer's registration details, so a
   * re-render always reproduces the file that was emailed. Scoped to the
   * caller's own account — the row id alone must never be enough to read
   * somebody else's invoice.
   */
  @Get("payments/:id/invoice.pdf")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  async paymentInvoicePdf(@CurrentUser() user: AuthUser, @Param("id") id: string, @Res() res: Response) {
    const ownerId = scopeId(user);
    const rowId = Number(id);
    if (!Number.isInteger(rowId) || rowId <= 0) throw new BadRequestException("رقم الدفعة غير صالح");

    const [row] = await this.db.select().from(subscriptionPaymentsTable)
      .where(and(eq(subscriptionPaymentsTable.id, rowId), eq(subscriptionPaymentsTable.userId, ownerId)));
    if (!row) throw new NotFoundException("الدفعة غير موجودة");
    if (row.status !== "paid") throw new BadRequestException("لا تصدر فاتورة إلا بعد تأكيد الدفع");

    const buyer = await this.invoices.loadBuyer(this.db, ownerId);
    const pdf = await this.invoices.renderPdf(row, buyer);
    const name = row.invoiceNumber || `SUB-${String(row.id).padStart(6, "0")}`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.pdf"`);
    res.setHeader("Content-Length", String(pdf.length));
    res.end(pdf);
  }

  /**
   * Confirm the account's open payments with Moyasar directly.
   *
   * Activation normally rides on the webhook, but a webhook can miss — on
   * staging it is registered against production, so a staging payment never
   * hears back. The web calls this when the user returns from the checkout
   * (and when the billing page shows a pending row): each recent pending
   * invoice is fetched from Moyasar and, only when it is provably this row's
   * full settled payment (`verifyMoyasarPaid`), activated exactly as the
   * webhook would. Nothing is marked paid on the invoice's word alone.
   */
  @Post("sync")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  async sync(@CurrentUser() user: AuthUser) {
    const ownerId = scopeId(user);
    if (!isMoyasarConfigured()) return { activated: 0 };
    const DAY = 24 * 60 * 60 * 1000;
    // Add-on invoices stay payable for the 14-day offer window; subscription ones a week.
    const since = (p: SubscriptionPaymentRow) => new Date(Date.now() - (p.kind === "addon" ? 15 : 7) * DAY);
    const pendings = (await this.db.select().from(subscriptionPaymentsTable)
      .where(and(eq(subscriptionPaymentsTable.userId, ownerId), eq(subscriptionPaymentsTable.status, "pending")))
      .orderBy(desc(subscriptionPaymentsTable.createdAt)))
      .filter((p) => p.moyasarInvoiceId && new Date(p.createdAt) >= since(p));
    let activated = 0;
    for (const p of pendings) {
      const inv = await fetchMoyasarInvoice(p.moyasarInvoiceId!).catch(() => null);
      if (String(inv?.status || "").toLowerCase() !== "paid") continue;
      const ev = evidenceFromInvoice(inv!);
      const check = verifyMoyasarPaid(p, ev);
      if (!check.ok) {
        this.appLog?.record({
          level: "error",
          event: "moyasar_paid_unverified",
          message: `subscription payment ${p.id}: Moyasar invoice is paid but does not match the row — not activated`,
          context: "SubscriptionSync",
          userId: p.userId,
          meta: { paymentId: p.id, invoiceId: p.moyasarInvoiceId, reason: check.reason },
        });
        continue;
      }
      if (await activateFromPaidRow(this.db, p, { moyasarPaymentId: ev.paymentId, paidAt: ev.paidAt }, this.invoices)) activated++;
      // Add-on rows are independent of each other and of the plan: keep walking.
      if (p.kind === "addon") continue;
      // One paid invoice is the live subscription; older pending rows stay for the pay path to close.
      break;
    }
    return { activated };
  }

  /**
   * Start a subscription payment. Optionally switches the plan/cycle first
   * (the "upgrade" path), then creates a Moyasar hosted invoice and returns
   * its payment URL. Only the account owner (not an employee) may pay.
   */
  @Post("pay")
  @RequirePermissions(PERMISSIONS.SUBSCRIPTION_MANAGE)
  async pay(@CurrentUser() user: AuthUser, @Body() body: any) {
    if (user.ownerUserId) throw new BadRequestException("صلاحية الدفع لصاحب الحساب فقط");
    const ownerId = user.id;
    const [owner] = await this.db.select().from(usersTable).where(eq(usersTable.id, ownerId));
    if (!owner) throw new BadRequestException("Account not found");

    // Optional plan/cycle switch (upgrade or change cycle).
    let plan = owner.packagePlan;
    // Monthly is no longer sold: an account still on it renews quarterly.
    let cycle = purchasableCycle(owner.billingCycle);
    if (body?.plan && isPackagePlan(body.plan)) plan = body.plan;
    if (isBillingCycle(body?.cycle)) cycle = purchasableCycle(body.cycle);

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
    // Subscription rows only: an open add-on invoice is a separate purchase
    // and must never be cancelled by paying for the plan.
    const pendings = await this.db.select().from(subscriptionPaymentsTable)
      .where(and(
        eq(subscriptionPaymentsTable.userId, ownerId),
        eq(subscriptionPaymentsTable.status, "pending"),
        eq(subscriptionPaymentsTable.kind, "subscription"),
      ))
      .orderBy(desc(subscriptionPaymentsTable.createdAt));

    let reuse: typeof pendings[number] | null = null;
    for (const p of pendings) {
      const inv = p.moyasarInvoiceId
        ? await fetchMoyasarInvoice(p.moyasarInvoiceId).catch(() => null)
        : null;
      const invStatus = String(inv?.status || "").toLowerCase();
      if (invStatus === "paid") {
        // Moyasar calls an earlier invoice paid but its webhook never landed.
        // This runs when the user OPENS a payment, so it must not take the
        // invoice's word alone: the settled payment, amount, currency and
        // metadata must all be this row's before anything is marked paid or a
        // "paid" invoice is emailed.
        const ev = evidenceFromInvoice(inv!);
        const check = verifyMoyasarPaid(p, ev);
        if (!check.ok) {
          // Paid at Moyasar but not provably THIS payment. Leave the row as it
          // is (never cancel a paid invoice's row) and flag it for a human.
          this.appLog?.record({
            level: "error",
            event: "moyasar_paid_unverified",
            message: `subscription payment ${p.id}: Moyasar invoice is paid but does not match the row — not activated`,
            context: "SubscriptionPay",
            userId: p.userId,
            meta: { paymentId: p.id, invoiceId: p.moyasarInvoiceId, reason: check.reason },
          });
          continue;
        }
        await activateFromPaidRow(this.db, p, { moyasarPaymentId: ev.paymentId, paidAt: ev.paidAt }, this.invoices);
        // No `url`: that link is a checkout page Moyasar now shows as PAID, and
        // redirecting a user who asked to pay onto it reads as "you were
        // charged". The client reports the confirmed earlier payment instead.
        return {
          paymentId: p.id, invoiceId: p.moyasarInvoiceId, alreadyPaid: true,
          plan: p.plan, billingCycle: p.billingCycle, amount: Number(p.amount), paidAt: ev.paidAt,
        };
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
      description: `اشتراك دارا — ${planLabel} (${CYCLE_LABEL_AR[cycle]})`,
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
export class SubscriptionWebhookController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly invoices: SubscriptionInvoiceService,
    private readonly appLog: AppLogService,
  ) {}

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
    // What Moyasar says happened; every row match below is checked against it.
    let evidence: MoyasarPaidEvidence | null = null;

    // "Don't trust the payload alone" was the intent; the code only managed it
    // when an invoice id happened to be present. Without one, `paid` came
    // straight out of an anonymous request body — so a POST carrying
    // {"data":{"status":"paid","metadata":{"subscriptionPaymentId":N}}}
    // activated that subscription. Nothing else on this route authenticates.
    if (invoiceId && isMoyasarConfigured()) {
      try {
        const inv = await fetchMoyasarInvoice(invoiceId);
        evidence = evidenceFromInvoice(inv);
        paid = evidence.status === "paid";
        verified = true;
      } catch (err) {
        // A transient Moyasar failure must not become an unverified
        // activation. Moyasar retries; answering "not verified" is the safe
        // half of that trade.
        //
        // But it must not be SILENT. This is the money path: swallowing the
        // error here is indistinguishable, from outside, from a webhook that
        // was never delivered — and the symptom (a user who paid, closed the
        // tab and was never activated) surfaces days later as a support
        // ticket with nothing to look at. Moyasar's dashboard is no help
        // either: it records the 2xx as "delivered successfully".
        this.appLog.record({
          level: "error",
          event: "moyasar_webhook_verify_failed",
          message: "could not verify a Moyasar invoice — refusing to activate on the payload alone",
          context: "MoyasarWebhook",
          error: err,
          meta: { invoiceId, eventPaymentId, metaPaymentId },
        });
      }
    }
    if (!verified) {
      // The shared secret is the only other thing that can prove the sender.
      if (expected && body?.secret_token === expected) {
        evidence = evidenceFromPayment(data);
        paid = evidence.status === "paid";
      } else {
        console.error("[moyasar] webhook REFUSED: payload could not be verified", {
          hasInvoiceId: !!invoiceId, moyasarConfigured: isMoyasarConfigured(),
        });
        this.appLog.record({
          level: "error",
          event: "moyasar_webhook_refused",
          message: "webhook refused: payload could not be verified",
          context: "MoyasarWebhook",
          // No `secret_token` and no payload body: the redactor would strip
          // the token anyway, and there is nothing in the body worth the risk.
          meta: {
            reason: "unverified",
            hasInvoiceId: !!invoiceId,
            moyasarConfigured: isMoyasarConfigured(),
            secretConfigured: !!expected,
            metaPaymentId: metaPaymentId ?? null,
          },
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
    // An invoice we verified with Moyasar identifies its row by that invoice
    // id and nothing else. Falling back to `metadata.subscriptionPaymentId`
    // here is how a paid invoice from the OTHER environment (staging and
    // production share one Moyasar account) would mark an unrelated customer's
    // row paid and email them a "paid" invoice.
    if (!row && metaPaymentId != null && !(verified && invoiceId)) {
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

    // Paid, but paid for THIS row? Amount, currency, invoice and metadata.
    const check = verifyMoyasarPaid(row, evidence!);
    if (!check.ok) {
      this.appLog.record({
        level: "error",
        event: "moyasar_webhook_mismatch",
        message: `paid event does not match subscription payment ${row.id} — not activated`,
        context: "MoyasarWebhook",
        userId: row.userId,
        meta: { paymentId: row.id, invoiceId: invoiceId ?? null, eventPaymentId: eventPaymentId ?? null, reason: check.reason },
      });
      return { ok: true, ignored: true, reason: check.reason };
    }

    // Mark paid + activate/renew (window continues from the old end — see
    // `renewalPeriodStart` — one cycle long, clear pending).
    // A second delivery, or the pay endpoint's self-heal racing this one, loses
    // the conditional update and sends nothing.
    const won = await activateFromPaidRow(
      this.db, row, { moyasarPaymentId: evidence!.paymentId ?? eventPaymentId ?? null, paidAt: evidence!.paidAt }, this.invoices,
    );

    return won ? { ok: true, activated: true } : { ok: true, already: true };
  }
}

@Module({
  // InvoiceModule for PdfService (headless Chrome); EmailService is global.
  imports: [InvoiceModule],
  controllers: [SubscriptionController, SubscriptionWebhookController],
  providers: [SubscriptionInvoiceService],
  // Exported for the admin re-issue endpoint (`AdminModule`).
  exports: [SubscriptionInvoiceService],
})
export class SubscriptionModule {}
