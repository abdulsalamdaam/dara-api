import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveSubscription, GRACE_DAYS } from "./subscription";

const DAY = 86_400_000;
const start = new Date("2026-09-01T00:00:00Z");
const endsAt = new Date(start.getTime() + 14 * DAY);
const at = (days: number) => new Date(endsAt.getTime() + days * DAY);

/**
 * Grace exists so a paying customer whose renewal fails is nagged rather than
 * cut off. A trial has no renewal to fail — it was a fixed offer that ended.
 * If a trial inherited the 15-day grace, a "14-day trial" would hand out 29
 * days of unrestricted access and the landing page would be lying.
 */
describe("deriveSubscription — a trial gets no grace", () => {
  const trial = (now: Date) =>
    deriveSubscription({ storedStatus: "active", subscriptionEndsAt: endsAt, isTrial: true, now });

  it("is active up to the last moment of the trial", () => {
    const s = trial(at(-0.001));
    assert.equal(s.status, "active");
    assert.equal(s.locked, false);
    assert.equal(s.needsPayment, false);
  });

  it("locks the instant the trial ends — never grace", () => {
    for (const d of [0.001, 1, 7, 14, 30]) {
      const s = trial(at(d));
      assert.equal(s.status, "locked", `day ${d}`);
      assert.equal(s.locked, true, `day ${d}`);
      assert.equal(s.needsPayment, true, `day ${d}`);
    }
  });

  it("never reports grace for a trial, at any offset", () => {
    for (let d = -14; d <= 40; d += 0.5) {
      assert.notEqual(trial(at(d)).status, "grace", `day ${d}`);
    }
  });
});

/** The paid path is unchanged — this is the regression guard for that. */
describe("deriveSubscription — a paid window keeps its grace", () => {
  const paid = (now: Date) =>
    deriveSubscription({ storedStatus: "active", subscriptionEndsAt: endsAt, isTrial: false, now });

  it("nags but does not lock inside the grace window", () => {
    for (const d of [0.001, 1, GRACE_DAYS - 1, GRACE_DAYS]) {
      const s = paid(at(d));
      assert.equal(s.status, "grace", `day ${d}`);
      assert.equal(s.locked, false, `day ${d}`);
      assert.equal(s.needsPayment, true, `day ${d}`);
    }
  });

  it("locks once grace is spent", () => {
    assert.equal(paid(at(GRACE_DAYS + 0.001)).status, "locked");
  });

  it("treats an omitted isTrial as a paid window", () => {
    const s = deriveSubscription({ storedStatus: "active", subscriptionEndsAt: endsAt, now: at(1) });
    assert.equal(s.status, "grace");
  });
});
