import { BadRequestException } from "@nestjs/common";

/**
 * The free trial every package ships with.
 *
 * A trial is not a separate product: it is an ordinary subscription window
 * flagged `users.subscription_is_trial`, so nothing downstream has to
 * special-case it. What lives here is the policy around that window — how long
 * it runs by default, where the admin's override is stored, and the two
 * coercions that guard the only two ways a number reaches it: an admin request
 * body, and whatever JSON the settings row happens to hold.
 */

/** Days of free access a newly approved account gets unless an admin says otherwise. */
export const DEFAULT_TRIAL_DAYS = 14;

/** The `app_settings.key` the trial policy is stored under. */
export const TRIAL_SETTING_KEY = "trial";

export interface TrialSettings {
  /** Whole days the granted window runs for. */
  days: number;
  /**
   * When false, approval grants nothing and the account lands on the pay
   * screen — the pre-trial behaviour, kept reachable so the offer can be
   * withdrawn without a deploy.
   */
  enabled: boolean;
}

/**
 * Trial length in whole days, or null when none was asked for.
 *
 * Absent, empty and non-positive all read as "no trial requested" rather than
 * an error: the field is optional on every request that accepts it. Only an
 * over-long value is rejected outright — a year of "trial" is a free
 * subscription, and anything past it is a typo, not a decision.
 */
export function normalizeTrialDays(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 365) throw new BadRequestException("مدة التجربة يجب أن تكون بين 1 و 365 يوماً");
  return n;
}

/**
 * Read the stored settings blob into a usable shape.
 *
 * `app_settings.value` is untyped jsonb written by an admin endpoint that may
 * be older or newer than this code, so it is treated as hostile input: any
 * field that is missing, the wrong type or out of range falls back to the
 * default rather than propagating. This is called on the registration-approval
 * path, where throwing would break approvals over a malformed settings row —
 * so it never throws, not even on a stored value past the 365-day ceiling.
 */
export function coerceTrialSettings(value: unknown): TrialSettings {
  const fallback: TrialSettings = { days: DEFAULT_TRIAL_DAYS, enabled: true };
  if (value == null || typeof value !== "object" || Array.isArray(value)) return fallback;
  const raw = value as Record<string, unknown>;
  let days = fallback.days;
  try {
    days = normalizeTrialDays(raw.days) ?? fallback.days;
  } catch {
    // Over the ceiling. `normalizeTrialDays` throws for a request body; a
    // stored row is not a request, and the default is the safer answer.
    days = fallback.days;
  }
  return { days, enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled };
}

/**
 * What the app shows about a trial in progress: when it ends, and how many
 * days are left.
 *
 * Both are null when the current window is not a trial — a paid subscription
 * has an end date too, and reporting it as `trialEndsAt` would make every paid
 * account look like it is about to lose access. The remaining count is floored
 * at 0 rather than going negative: an expired trial has "0 days left", and the
 * grace/locked story is `deriveSubscription`'s to tell, not this one's.
 *
 * Derived from the same window everything else reads, so there is nothing
 * extra to keep in step.
 */
export function trialView(
  isTrial: boolean,
  subscriptionEndsAt: Date | string | null | undefined,
  now: Date = new Date(),
): { trialEndsAt: Date | null; trialDaysRemaining: number | null } {
  if (!isTrial || !subscriptionEndsAt) return { trialEndsAt: null, trialDaysRemaining: null };
  const endsAt = new Date(subscriptionEndsAt);
  if (isNaN(endsAt.getTime())) return { trialEndsAt: null, trialDaysRemaining: null };
  const days = Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000);
  return { trialEndsAt: endsAt, trialDaysRemaining: Math.max(0, days) };
}
