import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { liveStatus, riyadhToday, SETTLED_STATUSES } from "./payment-status";

/**
 * The bug these lock in: nothing ever WRITES 'overdue' to payments.status, so
 * anything reading the stored column reported zero overdue installments
 * forever — the "متأخرة" tab, the dashboard counter and the mobile summary all
 * did. The status has to be derived from the due date every time it is read.
 */

const dayOffset = (n: number): string => {
  const d = new Date(`${riyadhToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe("liveStatus", () => {
  it("reports an unpaid installment past its due date as overdue", () => {
    assert.equal(liveStatus("pending", dayOffset(-1)), "overdue");
    assert.equal(liveStatus("pending", dayOffset(-400)), "overdue");
  });

  it("reports a future installment as pending", () => {
    assert.equal(liveStatus("pending", dayOffset(1)), "pending");
  });

  it("treats the due date itself as not yet overdue", () => {
    // Due today means due today — a tenant has until close of business.
    assert.equal(liveStatus("pending", riyadhToday()), "pending");
  });

  it("never re-derives a settled status, however old the due date", () => {
    for (const s of SETTLED_STATUSES) {
      assert.equal(liveStatus(s, dayOffset(-400)), s, s);
    }
  });

  it("leaves a row with no due date on its stored value", () => {
    assert.equal(liveStatus("pending", null), "pending");
    assert.equal(liveStatus("pending", undefined), "pending");
  });

  it("ignores a timestamp suffix on the due date", () => {
    assert.equal(liveStatus("pending", `${dayOffset(-1)}T00:00:00.000Z`), "overdue");
  });

  it("never returns the stored 'overdue' as a real state — it is always derived", () => {
    // A legacy row that somehow holds 'overdue' but is due in the future is
    // reported as pending: the due date is the authority, not the column.
    assert.equal(liveStatus("overdue", dayOffset(30)), "pending");
  });
});

describe("riyadhToday", () => {
  it("formats as YYYY-MM-DD so it compares with the date column as a string", () => {
    assert.match(riyadhToday(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("riyadhToday", () => {
  it("is the Riyadh calendar date, not UTC's, between 00:00 and 03:00 Riyadh", () => {
    // 01:30 Riyadh on 20 Oct = 22:30 UTC on 19 Oct. Vouchers, collections and
    // notes stamped at that hour used to carry the 19th.
    assert.equal(riyadhToday(new Date("2026-10-19T22:30:00Z")), "2026-10-20");
  });

  it("matches UTC once Riyadh and UTC share a date", () => {
    assert.equal(riyadhToday(new Date("2026-10-20T12:00:00Z")), "2026-10-20");
    assert.equal(riyadhToday(new Date("2026-10-20T20:59:59Z")), "2026-10-20");
    assert.equal(riyadhToday(new Date("2026-10-20T21:00:00Z")), "2026-10-21");
  });
});
