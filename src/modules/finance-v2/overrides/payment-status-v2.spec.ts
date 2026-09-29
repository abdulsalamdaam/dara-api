import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { liveStatus } from "../../../common/payment-status";
import { liveStatusV2 } from "../../../common/payment-status-v2";

/** DESIGN §9 E4: one overdue definition; part-paid past due is overdue, with the remaining amount. */
describe("fv2 E4 liveStatusV2", () => {
  const today = "2026-09-26";
  const yesterday = "2026-09-25";
  it("a part-paid installment past due is overdue with its remaining (legacy keeps it partially_paid)", () => {
    assert.deepEqual(liveStatusV2({ amount: "6900", dueDate: yesterday, status: "partially_paid" }, "3000", today), { status: "overdue", remaining: "3900.00" });
    assert.equal(liveStatus("partially_paid", yesterday), "partially_paid", "legacy pinned");
  });
  it("paid without money is paid_unverified and never overdue", () => {
    assert.equal(liveStatusV2({ amount: "6900", dueDate: "2026-01-01", status: "paid" }, "0", today).status, "paid_unverified");
  });
  it("settled when collections cover the amount; pending / partially_paid before due; cancelled and external first", () => {
    assert.equal(liveStatusV2({ amount: "6900", dueDate: yesterday, status: "pending" }, "6900", today).status, "paid");
    assert.equal(liveStatusV2({ amount: "6900", dueDate: today, status: "pending" }, "0", today).status, "pending", "due today is not yet overdue");
    assert.equal(liveStatusV2({ amount: "6900", dueDate: "2026-10-01", status: "partially_paid" }, "100", today).status, "partially_paid");
    assert.equal(liveStatusV2({ amount: "6900", dueDate: yesterday, status: "cancelled" }, "0", today).status, "cancelled");
    assert.equal(liveStatusV2({ amount: "6900", dueDate: yesterday, status: "settled_external" }, "0", today).status, "settled_external");
    assert.equal(liveStatusV2({ amount: "6900", dueDate: yesterday, status: "pending" }, "0", today, "6900").status, "written_off");
  });
});
