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
