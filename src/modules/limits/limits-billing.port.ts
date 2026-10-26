/**
 * Seams the billing / notification side plugs into (Agent B: Moyasar invoice,
 * SUB- invoice, emails). The core ships no-op defaults so admin grants work
 * end-to-end on their own; an invoiced or offered add-on is created with
 * `payUrl: null` until a real port is bound.
 *
 * Bind a real implementation in LimitsModule:
 *   { provide: LIMITS_BILLING_PORT, useClass: LimitsBillingService }
 *   { provide: LIMITS_NOTIFIER, useClass: LimitsEmailNotifier }
 */
import { Injectable } from "@nestjs/common";
import type { AccountLimitAddon } from "@dara/database";

export const LIMITS_BILLING_PORT = Symbol("LIMITS_BILLING_PORT");
export const LIMITS_NOTIFIER = Symbol("LIMITS_NOTIFIER");

export interface AddonPaymentResult {
  /** subscription_payments.id of the kind='addon' row; null when none was created. */
  paymentId: number | null;
  /** Hosted-invoice URL the customer pays at; null when none. */
  payUrl: string | null;
}

export interface LimitsBillingPort {
  /**
   * Price (+VAT, seats pro-rated) and open a payment for an add-on in status
   * `pending_payment` or `offered`: insert the kind='addon' subscription_payments
   * row and its Moyasar invoice. Called AFTER the add-on row is committed; the
   * service stores the returned paymentId on the add-on.
   */
  createAddonPayment(addon: AccountLimitAddon): Promise<AddonPaymentResult>;
  /** The add-on was cancelled: cancel its pending payment (Moyasar invoice). */
  cancelAddonPayment(addon: AccountLimitAddon): Promise<void>;
}

export interface LimitsChangedNotice {
  accountId: number;
  limitKey: string;
  oldValue: number | null;
  newValue: number | null;
  note: string | null;
  source: string;
  addonId?: number | null;
}

export interface LimitsNotifier {
  /** An effective limit went up or down (admin override, grant, cancel). Email only to the account. */
  limitsChanged(notice: LimitsChangedNotice): Promise<void>;
  /** An add-on was offered / invoiced and waits for payment. */
  addonOffered(addon: AccountLimitAddon, payment: AddonPaymentResult): Promise<void>;
}

/** Default: no payment is created; the add-on keeps payUrl null. */
@Injectable()
export class NoopLimitsBillingPort implements LimitsBillingPort {
  async createAddonPayment(): Promise<AddonPaymentResult> {
    return { paymentId: null, payUrl: null };
  }
  async cancelAddonPayment(): Promise<void> {}
}

/** Default: nothing is sent. */
@Injectable()
export class NoopLimitsNotifier implements LimitsNotifier {
  async limitsChanged(): Promise<void> {}
  async addonOffered(): Promise<void> {}
}
