import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addDays, ancestors, depths, fyStartOf, monthsIn, previousRange, rollUp, sides } from "./core-math";

describe("finance v2 core report helpers", () => {
  it("previousRange: whole months shift by months, other ranges by days", () => {
    assert.deepEqual(previousRange("2026-02-01", "2026-02-28"), { from: "2026-01-01", to: "2026-01-31" });
    assert.deepEqual(previousRange("2026-03-01", "2026-03-31"), { from: "2026-02-01", to: "2026-02-28" });
    assert.deepEqual(previousRange("2026-04-01", "2026-06-30"), { from: "2026-01-01", to: "2026-03-31" });
    assert.deepEqual(previousRange("2026-01-01", "2026-12-31"), { from: "2025-01-01", to: "2025-12-31" });
    assert.deepEqual(previousRange("2024-03-01", "2024-03-31"), { from: "2024-02-01", to: "2024-02-29" });
    // 10 days → the 10 days before
    assert.deepEqual(previousRange("2026-02-11", "2026-02-20"), { from: "2026-02-01", to: "2026-02-10" });
    assert.deepEqual(previousRange("2026-01-05", "2026-01-05"), { from: "2026-01-04", to: "2026-01-04" });
  });

  it("fyStartOf follows the fiscal start month", () => {
    assert.equal(fyStartOf("2026-02-15", 1), "2026-01-01");
    assert.equal(fyStartOf("2026-02-15", 4), "2025-04-01");
    assert.equal(fyStartOf("2026-04-01", 4), "2026-04-01");
    assert.equal(fyStartOf("2026-12-31", 7), "2026-07-01");
  });

  it("addDays and monthsIn", () => {
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addDays("2025-12-31", 1), "2026-01-01");
    assert.deepEqual(monthsIn("2025-11-15", "2026-02-01"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
    assert.deepEqual(monthsIn("2026-02-01", "2026-02-28"), ["2026-02"]);
  });

  it("sides puts a signed balance in the debit or the credit column", () => {
    assert.deepEqual(sides(123456), { debit: "1234.56", credit: "0.00" });
    assert.deepEqual(sides(-5), { debit: "0.00", credit: "0.05" });
    assert.deepEqual(sides(0), { debit: "0.00", credit: "0.00" });
  });

  it("rollUp sums leaves into every ancestor; depths and ancestors follow parent ids", () => {
    const nodes = [
      { id: 1, parentId: null }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }, { id: 4, parentId: 2 }, { id: 5, parentId: 1 },
    ];
    const r = rollUp(nodes, new Map([[3, [100, 1]], [4, [250, 2]], [5, [-50, 0]]]), 2);
    assert.deepEqual(r.get(2), [350, 3]);
    assert.deepEqual(r.get(1), [300, 3]);
    assert.deepEqual(r.get(5), [-50, 0]);
    assert.equal(depths(nodes).get(3), 2);
    assert.deepEqual(ancestors(nodes, 4), [2, 1]);
  });
});
