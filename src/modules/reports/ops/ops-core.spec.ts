import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OpsParamError, addDays, agingBucket, collectedOf, completionDate, contractStatusAt, daysBetween, daysOverdue, expiryBucket,
  inForceOn, instStatus, isIsoDate, lastOfMonth, monthsIn, occupancyDay, occupiedUnits, pct, remainingOf, resolveParams,
  riyadhDate, riyadhToday, type ContractLike, type Installment,
} from "./ops-core";

const inst = (o: Partial<Installment>): Installment => ({
  id: 1, contractId: 1, amount: 1000, dueDate: "2026-09-01", paidDate: null, status: "pending", collections: [], ...o,
});
const lease = (o: Partial<ContractLike>): ContractLike => ({
  id: 1, status: "active", startDate: "2026-01-01", endDate: "2026-12-31", endedOn: null, unitIds: [1], ...o,
});

describe("aging buckets", () => {
  it("day 0 is not overdue; edges land in the lower bucket", () => {
    assert.equal(agingBucket(0), null);
    assert.equal(agingBucket(-3), null);
    assert.equal(agingBucket(1), "d1_30");
    assert.equal(agingBucket(30), "d1_30");
    assert.equal(agingBucket(31), "d31_60");
    assert.equal(agingBucket(60), "d31_60");
    assert.equal(agingBucket(61), "d61_90");
    assert.equal(agingBucket(90), "d61_90");
    assert.equal(agingBucket(91), "d90_plus");
  });
  it("expiry buckets include day 0", () => {
    assert.deepEqual([0, 30, 31, 60, 61, 90, 91].map(expiryBucket), ["d0_30", "d0_30", "d31_60", "d31_60", "d61_90", "d61_90", "d90_plus"]);
  });
});

describe("dates", () => {
  it("validates real calendar dates only", () => {
    assert.equal(isIsoDate("2026-02-28"), true);
    assert.equal(isIsoDate("2026-02-30"), false);
    assert.equal(isIsoDate("2026-2-3"), false);
    assert.equal(isIsoDate(20260101), false);
    // Date.UTC maps years 0–99 onto the 1900s; such dates are refused, not shrunk.
    assert.equal(isIsoDate("0001-01-01"), false);
    assert.equal(isIsoDate("1899-12-31"), false);
    assert.equal(isIsoDate("9999-12-31"), false);
    assert.equal(isIsoDate("1900-01-01"), true);
  });
  it("day arithmetic is calendar based", () => {
    assert.equal(daysBetween("2026-01-31", "2026-03-01"), 29);
    assert.equal(addDays("2024-02-28", 1), "2024-02-29");
    assert.equal(lastOfMonth("2024-02-10"), "2024-02-29");
    assert.equal(lastOfMonth("2026-12-05"), "2026-12-31");
  });
  it("months are clipped to the window", () => {
    assert.deepEqual(monthsIn("2026-01-15", "2026-03-10"), [
      { ym: "2026-01", start: "2026-01-15", end: "2026-01-31" },
      { ym: "2026-02", start: "2026-02-01", end: "2026-02-28" },
      { ym: "2026-03", start: "2026-03-01", end: "2026-03-10" },
    ]);
    assert.equal(monthsIn("2025-11-01", "2026-10-14").length, 12);
  });
  it("Riyadh today is UTC+3: 22:30 UTC is already tomorrow in Riyadh", () => {
    assert.equal(riyadhDate(new Date("2026-10-13T22:30:00Z")), "2026-10-14");
    assert.equal(riyadhDate(new Date("2026-10-13T20:59:00Z")), "2026-10-13");
    assert.match(riyadhToday(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("param defaults", () => {
  const today = "2026-10-14";
  it("last12 = first of the month 11 months back → today; asOf = today; days = 90", () => {
    const p = resolveParams({}, { dates: "last12", today });
    assert.deepEqual([p.from, p.to, p.asOf, p.days, p.ownerId, p.propertyId, p.status], ["2025-11-01", "2026-10-14", "2026-10-14", 90, null, null, null]);
  });
  it("thisMonth = the current calendar month", () => {
    const p = resolveParams({}, { dates: "thisMonth", today });
    assert.deepEqual([p.from, p.to], ["2026-10-01", "2026-10-31"]);
  });
  it("explicit values win and are validated", () => {
    const p = resolveParams({ from: "2026-01-01", to: "2026-02-01", asOf: "2026-01-15", ownerId: "7", propertyId: "9", days: "30" }, { dates: "last12", today });
    assert.deepEqual([p.from, p.to, p.asOf, p.ownerId, p.propertyId, p.days], ["2026-01-01", "2026-02-01", "2026-01-15", 7, 9, 30]);
    for (const bad of [{ from: "2026-13-01" }, { from: "2026-03-01", to: "2026-02-01" }, { ownerId: "abc" }, { ownerId: "-1" }, { propertyId: "1.5" }, { days: "0" }, { status: "nope" }]) {
      assert.throws(() => resolveParams(bad, { dates: "last12", today, statuses: ["paid"] }), OpsParamError, JSON.stringify(bad));
    }
    assert.equal(resolveParams({ status: "all" }, { dates: "none", today, statuses: ["paid"] }).status, null);
  });
});

describe("installment money", () => {
  it("partial payment: collected = collected amount, outstanding = amount − collected", () => {
    const i = inst({ status: "partially_paid", collections: [{ date: "2026-09-05", amount: 400 }] });
    assert.equal(collectedOf(i), 400);
    assert.equal(remainingOf(i), 600);
    assert.equal(completionDate(i), null);
    assert.equal(instStatus(i), "partial");
  });
  it("collected as of a date ignores later money", () => {
    const i = inst({ status: "paid", paidDate: "2026-09-20", collections: [{ date: "2026-09-05", amount: 400 }, { date: "2026-09-20", amount: 600 }] });
    assert.equal(collectedOf(i, "2026-09-10"), 400);
    assert.equal(remainingOf(i, "2026-09-10"), 600);
    assert.equal(collectedOf(i), 1000);
    assert.equal(completionDate(i), "2026-09-20");
  });
  it("paid with no collection rows counts as collected on its paid date (or due date)", () => {
    assert.equal(collectedOf(inst({ status: "paid", paidDate: "2026-09-03" })), 1000);
    assert.equal(completionDate(inst({ status: "paid", paidDate: "2026-09-03" })), "2026-09-03");
    assert.equal(completionDate(inst({ status: "settled_external" })), "2026-09-01");
    assert.equal(collectedOf(inst({ status: "paid", paidDate: "2026-09-03" }), "2026-09-02"), 0);
  });
  it("cancelled installments owe and collect nothing", () => {
    const i = inst({ status: "cancelled" });
    assert.equal(collectedOf(i), 0);
    assert.equal(remainingOf(i), 0);
    assert.equal(daysOverdue(i, "2026-12-01"), 0);
    assert.equal(instStatus(i), "cancelled");
  });
  it("over-collection is capped at the amount", () => {
    assert.equal(collectedOf(inst({ status: "paid", collections: [{ date: "2026-09-01", amount: 1200 }] })), 1000);
  });
  it("overdue is derived from the due date (live status), never stored", () => {
    assert.equal(instStatus(inst({ dueDate: "2000-01-01" })), "overdue");
    assert.equal(instStatus(inst({ dueDate: "2999-01-01" })), "pending");
    assert.equal(daysOverdue(inst({ dueDate: "2026-09-01" }), "2026-10-01"), 30);
    assert.equal(daysOverdue(inst({ dueDate: "2026-10-01" }), "2026-10-01"), 0);
    assert.equal(daysOverdue(inst({ status: "paid", dueDate: "2026-09-01" }), "2026-10-01"), 0);
  });
});

describe("rates", () => {
  it("zero denominator → null, else 1 dp", () => {
    assert.equal(pct(0, 0), null);
    assert.equal(pct(5, 0), null);
    assert.equal(pct(1, 3), 33.3);
    assert.equal(pct(2, 2), 100);
  });
});

describe("contracts and occupancy", () => {
  it("in force between start and end; cancelled/pending never; terminated until its end stamp", () => {
    assert.equal(inForceOn(lease({}), "2026-06-01"), true);
    assert.equal(inForceOn(lease({}), "2027-01-01"), false);
    assert.equal(inForceOn(lease({ status: "cancelled" }), "2026-06-01"), false);
    assert.equal(inForceOn(lease({ status: "pending" }), "2026-06-01"), false);
    assert.equal(inForceOn(lease({ status: "terminated", endedOn: "2026-05-01" }), "2026-04-30"), true);
    assert.equal(inForceOn(lease({ status: "terminated", endedOn: "2026-05-01" }), "2026-05-01"), false);
  });
  it("a stored-active contract past its end reads expired", () => {
    assert.equal(contractStatusAt({ status: "active", endDate: "2026-01-01" }, "2026-02-01"), "expired");
    assert.equal(contractStatusAt({ status: "active", endDate: "2026-03-01" }, "2026-02-01"), "active");
    assert.equal(contractStatusAt({ status: "terminated", endDate: "2026-03-01" }, "2026-02-01"), "terminated");
  });
  it("month end measurement: past months use the last day, the current month uses today", () => {
    const today = "2026-10-14";
    assert.equal(occupancyDay({ ym: "2026-09", start: "2026-09-01", end: "2026-09-30" }, today), "2026-09-30");
    assert.equal(occupancyDay({ ym: "2026-10", start: "2026-10-01", end: "2026-10-14" }, today), "2026-10-14");
    assert.equal(occupancyDay({ ym: "2026-02", start: "2026-02-10", end: "2026-02-20" }, today), "2026-02-28");
  });
  it("a lease ending mid-month does not occupy at month end; one starting on the last day does", () => {
    const cs = [lease({ id: 1, unitIds: [1], endDate: "2026-03-15" }), lease({ id: 2, unitIds: [2], startDate: "2026-03-31" }), lease({ id: 3, unitIds: [3, 4] })];
    assert.deepEqual([...occupiedUnits(cs, "2026-03-31")].sort(), [2, 3, 4]);
    assert.deepEqual([...occupiedUnits(cs, "2026-03-31", new Set([1, 2, 3]))].sort(), [2, 3]);
  });
});

describe("completion with a refund (negative collection)", () => {
  it("paid then partly refunded is open again, not paid on the first day", () => {
    const i = inst({ amount: 300, dueDate: "2026-06-01", status: "partially_paid", collections: [{ date: "2026-06-02", amount: 300 }, { date: "2026-06-10", amount: -150 }] });
    assert.equal(collectedOf(i), 150);
    assert.equal(completionDate(i), null);
  });
  it("refunded then collected again completes on the later day", () => {
    const i = inst({ amount: 300, dueDate: "2026-06-01", status: "paid", collections: [{ date: "2026-05-30", amount: 300 }, { date: "2026-06-03", amount: -300 }, { date: "2026-06-05", amount: 300 }] });
    assert.equal(completionDate(i), "2026-06-05");
  });
});
