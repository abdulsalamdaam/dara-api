import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { subscriptionPaymentsTable, usersTable, type AccountLimitAddon } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { chargedVatRate } from "../../common/packages";
import { amountInclVat, type CatalogEntry } from "../../common/addon-catalog";
import { LIMIT_KEYS, isLimitKey } from "../../common/limits";
import { cancelMoyasarInvoice, createMoyasarInvoice, fetchMoyasarInvoice } from "../../common/moyasar";
import { AddonCatalogService } from "./addon-catalog.service";
import type { AddonPaymentResult, LimitsBillingPort } from "./limits-billing.port";

const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || "https://app.dara-sa.com").replace(/\/$/, "");

/**
 * Whole calendar months from `now` to `endsAt`, rounded UP, at least 1 — what
 * a per-month seat add-on is charged for. No end date (legacy open-ended
 * subscription) → 1.
 */
export function remainingMonths(endsAt: Date | string | null | undefined, now = new Date()): number {
  if (!endsAt) return 1;
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime()) || end <= now) return 1;
  let m = (end.getUTCFullYear() - now.getUTCFullYear()) * 12 + (end.getUTCMonth() - now.getUTCMonth());
  const probe = (k: number) => {
    const d = new Date(now);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + k);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d;
  };
  if (m < 0) m = 0;
  while (probe(m) < end) m++;
  while (m > 1 && probe(m - 1) >= end) m--;
  return Math.max(1, m);
}

export interface AddonCharge {
  /** Before VAT. */
  net: number;
  /** VAT-inclusive — what Moyasar charges and the invoice totals to. */
  total: number;
  vatRate: number | null;
  /** Months charged for (subscription_period add-ons); 1 for one-off. */
  months: number;
}

/**
 * The charge for an add-on. `priceSar` (before VAT) is the price of the
 * add-on's whole quantity — the catalog's per-pack price × packs, or the
 * admin's figure. A `subscription_period` add-on (seats) is priced PER MONTH
 * and charged for the rest of the paid period: × remainingMonths (ceil, min 1).
 * VAT via chargedVatRate(), to the halala.
 */
export function addonCharge(
  addon: Pick<AccountLimitAddon, "priceSar" | "period">, subscriptionEndsAt: Date | string | null, now = new Date(),
  vatRate: number | null = chargedVatRate(),
): AddonCharge | null {
  if (addon.priceSar == null) return null;
  const price = Number(addon.priceSar);
  if (!Number.isFinite(price) || price < 0) return null;
  const months = addon.period === "subscription_period" ? remainingMonths(subscriptionEndsAt, now) : 1;
  const net = Math.round(price * months * 100) / 100;
  return { net, total: amountInclVat(net, vatRate)!, vatRate, months };
}

/** How an Ejar lookups add-on reads to the customer (no count). */
export const EJAR_ADDON_LABEL_AR = "عمليات إيجار إضافية";
export const EJAR_ADDON_LABEL_EN = "Additional Ejar lookups";

/** The invoice line for an add-on: "مستخدم إضافي × 2 — 3 أشهر". */
export function addonDescription(addon: Pick<AccountLimitAddon, "limitKey" | "quantity" | "period">, item: CatalogEntry | null, months: number): string {
  const key = isLimitKey(addon.limitKey) ? addon.limitKey : null;
  let label: string;
  // An Ejar pack never states its lookup count — the customer is not told
  // how many lookups the account has (admins see it on the add-on itself).
  if (key === "ejar_lookups") label = EJAR_ADDON_LABEL_AR;
  else if (item && item.quantity > 0 && addon.quantity % item.quantity === 0) {
    const packs = addon.quantity / item.quantity;
    label = packs === 1 ? item.labelAr : `${item.labelAr} × ${packs}`;
  } else {
    label = `${key ? LIMIT_KEYS[key].labelAr : addon.limitKey} +${addon.quantity}`;
  }
  if (addon.period === "subscription_period") {
    label += ` — ${months === 1 ? "شهر واحد" : months === 2 ? "شهران" : months <= 10 ? `${months} أشهر` : `${months} شهرًا`}`;
  }
  return `إضافة على الباقة: ${label}`;
}

/**
 * LIMITS_BILLING_PORT: opens and cancels the Moyasar invoice of an add-on.
 *
 * A kind='addon' `subscription_payments` row is inserted (plan/cycle copied
 * from the account so nothing reading "the latest paid row" mistakes it for
 * a plan change; `description` is the invoice line), then a hosted invoice
 * with metadata `{subscriptionPaymentId, userId, kind:'addon', addonId}` and
 * the same return URLs as a subscription payment. The webhook and /sync
 * confirm it exactly like a plan payment; `activateFromPaidRow` branches on
 * `kind` and only activates the add-on.
 */
@Injectable()
export class LimitsBillingService implements LimitsBillingPort {
  private readonly log = new Logger("LimitsBilling");

  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly catalog: AddonCatalogService,
  ) {}

  async createAddonPayment(addon: AccountLimitAddon): Promise<AddonPaymentResult> {
    const [acct] = await this.db.select({
      packagePlan: usersTable.packagePlan, billingCycle: usersTable.billingCycle, subscriptionEndsAt: usersTable.subscriptionEndsAt,
    }).from(usersTable).where(eq(usersTable.id, addon.accountId)).limit(1);
    if (!acct) throw new Error(`account ${addon.accountId} not found`);
    const charge = addonCharge(addon, addon.endsAt ?? acct.subscriptionEndsAt ?? null);
    if (!charge) throw new Error(`add-on ${addon.id} has no price`);
    if (charge.total <= 0) throw new Error(`add-on ${addon.id} costs nothing — grant it free instead`);
    const item = addon.catalogKey ? await this.catalog.find(addon.catalogKey) : null;
    const description = addonDescription(addon, item, charge.months);

    const [row] = await this.db.insert(subscriptionPaymentsTable).values({
      userId: addon.accountId,
      plan: acct.packagePlan ?? "basic",
      billingCycle: acct.billingCycle ?? "yearly",
      amount: charge.total.toFixed(2),
      currency: "SAR",
      status: "pending",
      kind: "addon",
      addonId: addon.id,
      description,
    }).returning();

    try {
      const invoice = await createMoyasarInvoice({
        amountSar: charge.total,
        description: `دارا — ${description}`,
        callbackUrl: `${APP_PUBLIC_URL}/dashboard/settings?section=billing&paid=1`,
        successUrl: `${APP_PUBLIC_URL}/dashboard/settings?section=billing&paid=1`,
        backUrl: `${APP_PUBLIC_URL}/dashboard/settings?section=billing`,
        metadata: { subscriptionPaymentId: String(row!.id), userId: String(addon.accountId), kind: "addon", addonId: String(addon.id) },
      });
      await this.db.update(subscriptionPaymentsTable)
        .set({ moyasarInvoiceId: invoice.id, paymentUrl: invoice.url })
        .where(eq(subscriptionPaymentsTable.id, row!.id));
      return { paymentId: row!.id, payUrl: invoice.url };
    } catch (err) {
      // No invoice → the row can never be paid; close it rather than leave a dangling "pending".
      await this.db.update(subscriptionPaymentsTable).set({ status: "cancelled" })
        .where(eq(subscriptionPaymentsTable.id, row!.id));
      throw err;
    }
  }

  async cancelAddonPayment(addon: AccountLimitAddon): Promise<void> {
    if (addon.paymentId == null) return;
    const [row] = await this.db.select().from(subscriptionPaymentsTable)
      .where(and(eq(subscriptionPaymentsTable.id, addon.paymentId), eq(subscriptionPaymentsTable.kind, "addon")))
      .limit(1);
    if (!row || row.status !== "pending") return;
    if (row.moyasarInvoiceId) {
      try { await cancelMoyasarInvoice(row.moyasarInvoiceId); } catch (err: any) {
        // Already cancelled at Moyasar, or not configured — non-fatal, like pay().
        // But if it was PAID meanwhile, leave the row pending: the webhook or
        // /sync then activates what the customer paid for.
        this.log.warn(`add-on ${addon.id}: cancelling Moyasar invoice ${row.moyasarInvoiceId} failed: ${err?.message || err}`);
        const inv = await fetchMoyasarInvoice(row.moyasarInvoiceId).catch(() => null);
        if (String(inv?.status || "").toLowerCase() === "paid") return;
      }
    }
    await this.db.update(subscriptionPaymentsTable).set({ status: "cancelled" })
      .where(and(eq(subscriptionPaymentsTable.id, row.id), eq(subscriptionPaymentsTable.status, "pending")));
  }
}
