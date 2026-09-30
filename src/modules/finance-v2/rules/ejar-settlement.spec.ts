import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { settledExternal } from "./installments";
import { EMPTY_STATE, type PostState } from "./types";
import { liveStatusV2 } from "../../../common/payment-status-v2";

/** E33 for Ejar part payments (issue 11h) and the v2 status that counts them (issue 11c). Pure, synthetic. */
const P = 9001;
const charged = (amount: number): PostState => ({
  ...EMPTY_STATE,
  charges: { [P]: { generation: 1, chargedBy: "due", documentId: null, amount, vatAmount: 0, vatBase: null, entryId: 1 } as any },
});
const facts = (extra: Record<string, unknown> = {}) => ({
  date: "2026-08-01", treatment: "agent" as const, dims: { ownerId: 1, tenantId: 2, contractId: 3 }, warnings: [],
  paymentId: P, gross: "3000.00", category: "O" as const, rate: 0, nature: "rent" as const, deferRent: true, ...extra,
});
const sum = (o: any, side: "debit" | "credit") => o.lines.reduce((t: number, l: any) => t + (l[side] ?? 0), 0);

describe("finance v2: Ejar part settlements", () => {
  it("E33 settles the reported amount only, never more than the charge", () => {
    const part = settledExternal(facts({ amount: "2000.00" }) as any, charged(300_000));
    assert.equal(sum(part, "debit"), 200_000);
    const over = settledExternal(facts({ amount: "5000.00" }) as any, charged(300_000));
    assert.equal(sum(over, "debit"), 300_000);
  });

  it("a later whole settlement deducts what the part settlement already cleared", () => {
    const rest = settledExternal(facts({ settledBefore: "2000.00" }) as any, charged(300_000));
    assert.equal(sum(rest, "credit"), 100_000);
    const whole = settledExternal(facts() as any, charged(300_000));
    assert.equal(sum(whole, "credit"), 300_000);
  });

  it("the v2 status counts what Ejar reported: overdue for the rest when past due, partially_paid before", () => {
    const today = "2026-09-30";
    assert.deepEqual(liveStatusV2({ amount: "3000", dueDate: "2026-08-01", status: "pending" }, "0", today, 0, "2000"),
      { status: "overdue", remaining: "1000.00" });
    assert.deepEqual(liveStatusV2({ amount: "3000", dueDate: "2026-10-01", status: "pending" }, "0", today, 0, "2000"),
      { status: "partially_paid", remaining: "1000.00" });
    assert.equal(liveStatusV2({ amount: "3000", dueDate: "2026-08-01", status: "pending" }, "1000", today, 0, "2000").status, "paid");
  });
});
