import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { coerceTrialSettings, normalizeTrialDays, trialView, DEFAULT_TRIAL_DAYS, TRIAL_SETTING_KEY } from "./trial";

/**
 * The trial length reaches the database from an admin request body, so it is
 * the one number here a customer-facing consequence hangs off: too small and
 * an approved account is locked out the same day, too large and we have given
 * away a free subscription. Absent/empty must read as "not asked for" (the
 * field is optional on approval and on the package change), never as zero.
 */
describe("normalizeTrialDays", () => {
  it("returns null when no trial was asked for", () => {
    for (const raw of [null, undefined, ""]) {
      assert.equal(normalizeTrialDays(raw), null, String(raw));
    }
  });

  it("treats non-positive and unparseable values as no trial, not as an error", () => {
    // A 400 here would make `trialDays: 0` — which the admin UI can easily send
    // for an empty field — fail an approval that should simply grant nothing.
    for (const raw of [0, -1, -365, "abc", NaN, {}, []]) {
      assert.equal(normalizeTrialDays(raw), null, String(raw));
    }
  });

  it("accepts both ends of the 1..365 range", () => {
    assert.equal(normalizeTrialDays(1), 1);
    assert.equal(normalizeTrialDays(365), 365);
    assert.equal(normalizeTrialDays(DEFAULT_TRIAL_DAYS), 14);
  });

  it("floors a fractional length rather than storing a partial day", () => {
    // The window is computed as days × 86_400_000; a fraction would end the
    // trial mid-afternoon for no stated reason.
    assert.equal(normalizeTrialDays(14.9), 14);
    assert.equal(normalizeTrialDays("30.5"), 30);
  });

  it("accepts a numeric string — JSON bodies and query strings both arrive as text", () => {
    assert.equal(normalizeTrialDays("14"), 14);
  });

  it("rejects anything past a year", () => {
    // 366 is the first value that is a free subscription rather than a trial.
    assert.throws(() => normalizeTrialDays(366), /مدة التجربة/);
    assert.throws(() => normalizeTrialDays(100000), /مدة التجربة/);
  });
});

/**
 * `coerceTrialSettings` reads untyped jsonb on the registration-approval path.
 * Approving an account must not fail because a settings row is malformed, so
 * every one of these has to yield a usable object instead of throwing.
 */
describe("coerceTrialSettings", () => {
  it("defaults to 14 days, enabled", () => {
    assert.deepEqual(coerceTrialSettings(null), { days: 14, enabled: true });
    assert.equal(DEFAULT_TRIAL_DAYS, 14);
  });

  it("survives every shape a bad or absent row can take", () => {
    for (const garbage of [null, undefined, {}, { days: "x" }, { days: -3 }, { days: 0 }, "trial", 42, [], [14], true]) {
      const out = coerceTrialSettings(garbage);
      assert.equal(typeof out.days, "number", JSON.stringify(garbage));
      assert.ok(out.days >= 1 && out.days <= 365, JSON.stringify(garbage));
      assert.equal(typeof out.enabled, "boolean", JSON.stringify(garbage));
    }
  });

  it("never throws on a stored value past the ceiling", () => {
    // The ceiling is a request-validation rule. A row that somehow holds 9999
    // must degrade to the default, not 500 every approval from then on.
    assert.deepEqual(coerceTrialSettings({ days: 9999, enabled: true }), { days: 14, enabled: true });
  });

  it("keeps a valid stored setting verbatim, including a disabled trial", () => {
    assert.deepEqual(coerceTrialSettings({ days: 30, enabled: false }), { days: 30, enabled: false });
    // `enabled` is the switch that withdraws the offer; only a real boolean
    // may flip it, or a stray "false" string would silently disable trials.
    assert.equal(coerceTrialSettings({ days: 30, enabled: "false" }).enabled, true);
  });

  it("fills in each half independently", () => {
    assert.deepEqual(coerceTrialSettings({ days: 7 }), { days: 7, enabled: true });
    assert.deepEqual(coerceTrialSettings({ enabled: false }), { days: 14, enabled: false });
  });

  it("stores under a stable key — changing it silently resets every deployment's setting", () => {
    assert.equal(TRIAL_SETTING_KEY, "trial");
  });
});

/**
 * What the portal renders on the trial banner. Both fields are null for a paid
 * window on purpose: `subscription_ends_at` exists either way, and a paid
 * account showing "3 days remaining" reads as an account about to be cut off.
 */
describe("trialView", () => {
  const now = new Date("2026-01-10T12:00:00Z");

  it("reports nothing when the window is not a trial", () => {
    assert.deepEqual(
      trialView(false, new Date("2026-02-01T00:00:00Z"), now),
      { trialEndsAt: null, trialDaysRemaining: null },
    );
  });

  it("reports nothing when there is no window at all", () => {
    // pending_payment accounts carry null dates; a trial flag without a date
    // would otherwise produce NaN days.
    for (const endsAt of [null, undefined, "", "not-a-date"]) {
      assert.deepEqual(trialView(true, endsAt, now), { trialEndsAt: null, trialDaysRemaining: null }, String(endsAt));
    }
  });

  it("counts whole days up, so a trial ending later today still shows 1", () => {
    assert.equal(trialView(true, new Date("2026-01-10T23:00:00Z"), now).trialDaysRemaining, 1);
    assert.equal(trialView(true, new Date("2026-01-24T12:00:00Z"), now).trialDaysRemaining, 14);
  });

  it("floors an expired trial at zero rather than going negative", () => {
    // Past the end the account is in grace, which `deriveSubscription` owns.
    // A negative countdown here would render as "-4 days remaining".
    assert.equal(trialView(true, new Date("2026-01-06T12:00:00Z"), now).trialDaysRemaining, 0);
  });
});
