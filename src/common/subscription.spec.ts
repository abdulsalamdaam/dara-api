import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveSubscription, GRACE_DAYS, nextEndDate, renewalPeriodStart } from "./subscription";

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

describe("nextEndDate", () => {
  it("adds 1, 3 or 12 months by cycle", () => {
    const from = new Date("2026-01-15T00:00:00Z");
    assert.equal(nextEndDate("monthly", from).toISOString().slice(0, 10), "2026-02-15");
    assert.equal(nextEndDate("quarterly", from).toISOString().slice(0, 10), "2026-04-15");
    assert.equal(nextEndDate("yearly", from).toISOString().slice(0, 10), "2027-01-15");
  });
});

/**
 * "Do grace period and increase — not waive the amount." Grace is time to pay
 * late, not free time: a renewal continues from the OLD end date, never from
 * the day the money arrived, and the price stays the full plan price.
 */
describe("renewalPeriodStart — grace days are billed, never given away", () => {
  const oldEnd = new Date("2026-10-01T00:00:00Z");
  const paidWindow = (paidAt: Date) =>
    renewalPeriodStart({ storedStatus: "active", subscriptionEndsAt: oldEnd, isTrial: false, paidAt });

  it("paid inside grace → the new window starts at the old end (1 Oct + 3 months = 1 Jan, not 5 Jan)", () => {
    const paidAt = new Date("2026-10-05T09:30:00Z");
    assert.equal(deriveSubscription({ storedStatus: "active", subscriptionEndsAt: oldEnd, now: paidAt }).status, "grace");
    const start = paidWindow(paidAt);
    assert.equal(start.toISOString(), oldEnd.toISOString());
    assert.equal(nextEndDate("quarterly", start).toISOString(), "2027-01-01T00:00:00.000Z");
  });

  it("paid on the last moment of grace still starts at the old end", () => {
    const paidAt = new Date(oldEnd.getTime() + GRACE_DAYS * DAY);
    assert.equal(paidWindow(paidAt).toISOString(), oldEnd.toISOString());
  });

  it("paid early (still active) → stacks on the old end, unused days are not lost", () => {
    assert.equal(paidWindow(new Date("2026-09-20T00:00:00Z")).toISOString(), oldEnd.toISOString());
  });

  it("paid after grace (locked) → the grace days used are billed, the locked days are not", () => {
    const paidAt = new Date("2026-11-30T00:00:00Z");
    assert.equal(deriveSubscription({ storedStatus: "active", subscriptionEndsAt: oldEnd, now: paidAt }).status, "locked");
    const start = paidWindow(paidAt);
    assert.equal(start.getTime(), paidAt.getTime() - GRACE_DAYS * DAY);
    assert.ok(start > oldEnd);
  });

  it("never starts later than the payment, at any offset — grace can never be credited back", () => {
    for (let d = -40; d <= 120; d += 0.5) {
      const paidAt = new Date(oldEnd.getTime() + d * DAY);
      const start = paidWindow(paidAt);
      assert.ok(start <= paidAt || d < 0, `day ${d}`);
      // While grace lasts the old end is kept exactly.
      if (d <= GRACE_DAYS) assert.equal(start.getTime(), Math.max(oldEnd.getTime(), paidAt.getTime() - GRACE_DAYS * DAY), `day ${d}`);
    }
  });

  it("trial, never-paid and open-ended accounts start fresh at the payment (they had no grace)", () => {
    const paidAt = new Date("2026-10-05T00:00:00Z");
    assert.equal(renewalPeriodStart({ storedStatus: "active", subscriptionEndsAt: oldEnd, isTrial: true, paidAt }).toISOString(), paidAt.toISOString());
    assert.equal(renewalPeriodStart({ storedStatus: "pending_payment", subscriptionEndsAt: oldEnd, paidAt }).toISOString(), paidAt.toISOString());
    assert.equal(renewalPeriodStart({ storedStatus: "active", subscriptionEndsAt: null, paidAt }).toISOString(), paidAt.toISOString());
  });
});
