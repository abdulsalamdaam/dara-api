import { CYCLE_MONTHS, type BillingCycle } from "./packages";
/**
 * Subscription status derivation. The stored `subscription_status` is the
 * intent (pending_payment vs active); grace/locked are derived from the dates
 * so the truth stays correct without a cron job.
 *
 * Timeline after a payment:
 *   [start ───────────── endsAt] active
 *                        (endsAt, endsAt+15d] grace  (pay soon or get locked)
 *                        (endsAt+15d, ∞)      locked (settings/usage/pay only)
 *
 * Timeline after a FREE TRIAL — no grace at all:
 *   [start ───────────── endsAt] active
 *                        (endsAt, ∞)          locked (settings/usage/pay only)
 *
 * Grace exists so a paying customer whose renewal fails is nagged rather than
 * cut off. A trial has no renewal to fail: it was a fixed offer that ended. If
 * a trial inherited the 15-day grace, a "14-day trial" would in fact hand out
 * 29 days of unrestricted access, and the number on the landing page would be
 * a lie. So a trial locks the moment it expires.
 */

export const GRACE_DAYS = 15;

export type SubscriptionStatus = "pending_payment" | "active" | "grace" | "locked";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DerivedSubscription {
  status: SubscriptionStatus;
  /** When the account locks (endsAt + 15 days), if applicable. */
  graceUntil: Date | null;
  /** Whole days until the account locks (negative once locked). */
  daysUntilLock: number | null;
  /** Whether the user must pay before they can use the portal. */
  needsPayment: boolean;
  /** Whether the account is restricted to settings/usage/pay. */
  locked: boolean;
}

export function deriveSubscription(input: {
  storedStatus: string | null | undefined;
  subscriptionEndsAt: Date | string | null | undefined;
  /** Whether the CURRENT window is a free trial — it gets no grace period. */
  isTrial?: boolean | null;
  now?: Date;
}): DerivedSubscription {
  const now = input.now ?? new Date();
  const stored = (input.storedStatus || "active") as SubscriptionStatus;

  // Never paid yet — must pay to activate. Not "locked" (they still onboard),
  // but flagged as needing payment.
  if (stored === "pending_payment") {
    return { status: "pending_payment", graceUntil: null, daysUntilLock: null, needsPayment: true, locked: false };
  }

  const endsAt = input.subscriptionEndsAt ? new Date(input.subscriptionEndsAt) : null;
  // Legacy/active with no end date → treat as active indefinitely.
  if (!endsAt) {
    return { status: "active", graceUntil: null, daysUntilLock: null, needsPayment: false, locked: false };
  }

  // A trial's own end IS its deadline; a paid window gets 15 more days.
  const graceUntil = input.isTrial ? endsAt : new Date(endsAt.getTime() + GRACE_DAYS * DAY_MS);
  const daysUntilLock = Math.ceil((graceUntil.getTime() - now.getTime()) / DAY_MS);

  if (now <= endsAt) {
    return { status: "active", graceUntil, daysUntilLock, needsPayment: false, locked: false };
  }
  if (now <= graceUntil) {
    // Past due but within grace — nag to pay; not locked yet.
    return { status: "grace", graceUntil, daysUntilLock, needsPayment: true, locked: false };
  }
  // Grace expired.
  return { status: "locked", graceUntil, daysUntilLock, needsPayment: true, locked: true };
}

/**
 * The end of a subscription window of `cycle` starting at `from`.
 *
 * Shared rather than duplicated because two paths compute it: activation (the
 * window the payment bought) and a retro-issued invoice, which has to
 * reconstruct the window of a payment that was activated before the invoice
 * columns existed.
 */
export function nextEndDate(cycle: BillingCycle, from = new Date()): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + CYCLE_MONTHS[cycle]);
  return d;
}

/**
 * Where the window a renewal payment buys STARTS.
 *
 * Grace is a courtesy to pay late, not free time. A paid window that ran out
 * on 1 Oct and is paid on 5 Oct (inside grace) renews from 1 Oct, so the next
 * window ends on 1 Jan for a quarter — not 5 Jan. Paying early likewise stacks
 * on the old end instead of throwing the unused days away. The amount charged
 * is always the full plan price; this only decides the dates.
 *
 * Once grace is spent the account was locked and had no use of the portal, so
 * the locked days are not billed — but the grace days it DID use are: the new
 * window starts GRACE_DAYS before payment. Hence
 *   start = max(oldEnd, paidAt − GRACE_DAYS).
 *
 * A trial, a never-paid account (`pending_payment`) or one with no end date
 * starts fresh at the payment — none of those had grace to give away.
 */
export function renewalPeriodStart(input: {
  storedStatus: string | null | undefined;
  subscriptionEndsAt: Date | string | null | undefined;
  isTrial?: boolean | null;
  paidAt: Date;
}): Date {
  const paidAt = new Date(input.paidAt);
  if (input.storedStatus === "pending_payment" || input.isTrial || !input.subscriptionEndsAt) return paidAt;
  const oldEnd = new Date(input.subscriptionEndsAt);
  if (isNaN(oldEnd.getTime())) return paidAt;
  const graceFloor = paidAt.getTime() - GRACE_DAYS * DAY_MS;
  return new Date(Math.max(oldEnd.getTime(), graceFloor));
}
