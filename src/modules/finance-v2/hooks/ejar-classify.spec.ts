import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ejarInvoiceDescription, installmentNature, mapEjarStatusLegacy, mapEjarStatusV2, matchEjarInvoices,
} from "./classify";

/**
 * Ejar import classification (FINANCE-V2-FIX-LIST items 1 and 9; test-plan §8
 * issues 11a, 11b, 11i). Pure: no database. Synthetic values only.
 */
describe("finance v2: Ejar import classification", () => {
  it("11b: 'مدفوعة جزئياً' / 'Partially paid' is a partial payment, never fully paid", () => {
    assert.deepEqual(mapEjarStatusV2({ status: "مدفوعة جزئياً", amount: "3000", remaining: "1000" }),
      { status: null, reported: "partially_paid", reportedAmount: "2000.00" });
    assert.deepEqual(mapEjarStatusV2({ status: "Partially paid", amount: "3000", remaining: "1000" }),
      { status: null, reported: "partially_paid", reportedAmount: "2000.00" });
    // The wording says partial but Ejar gave no remaining: partial, with nothing we can count as settled.
    assert.deepEqual(mapEjarStatusV2({ status: "مدفوعة جزئياً", amount: "3000", remaining: null }),
      { status: null, reported: "partially_paid", reportedAmount: null });
    // "Paid" wording with money still remaining is a partial payment of what was paid.
    assert.deepEqual(mapEjarStatusV2({ status: "مدفوعة", amount: "3000", remaining: "500" }),
      { status: null, reported: "partially_paid", reportedAmount: "2500.00" });
    // Unchanged: fully paid, and unpaid.
    assert.deepEqual(mapEjarStatusV2({ status: "مدفوعة", amount: "3000", remaining: "0" }),
      { status: "settled_external", reported: "paid", reportedAmount: "3000.00" });
    assert.deepEqual(mapEjarStatusV2({ status: "غير مدفوعة", amount: "3000", remaining: "3000" }),
      { status: null, reported: null, reportedAmount: null });
  });

  it("11b (flag off): the legacy status mapping says partially_paid for the partial wording", () => {
    assert.equal(mapEjarStatusLegacy({ status: "مدفوعة جزئياً", amount: "3000", remaining: "1000" }), "partially_paid");
    assert.equal(mapEjarStatusLegacy({ status: "مدفوعة جزئياً", amount: "3000", remaining: null }), "partially_paid");
    assert.equal(mapEjarStatusLegacy({ status: "مدفوعة", amount: "3000", remaining: "0" }), "paid");
    assert.equal(mapEjarStatusLegacy({ status: "متأخرة", amount: "3000", remaining: "1000" }), "partially_paid");
    assert.equal(mapEjarStatusLegacy({ status: "غير مدفوعة", amount: "3000", remaining: "3000" }), null);
  });

  it("11i: an Ejar invoice with a date but no number still stamps a RENT description", () => {
    const d = ejarInvoiceDescription({ number: null, issueDate: "2026-07-25", lateDate: null });
    assert.ok(d.startsWith("فاتورة إيجار"), d);
    assert.equal(installmentNature(d), "rent");
    assert.equal(ejarInvoiceDescription({ number: "EJ-INV-A2", issueDate: "2026-07-25", lateDate: "2026-08-05" }),
      "فاتورة إيجار رقم EJ-INV-A2 — تاريخ الإصدار 2026-07-25 — تاريخ التأخر 2026-08-05");
    // Rows imported before this fix carry the date-only stamp: still rent.
    assert.equal(installmentNature("تاريخ الإصدار 2026-07-25"), "rent");
    assert.equal(installmentNature("تاريخ الإصدار 2026-07-25 — تاريخ التأخر 2026-08-05"), "rent");
    assert.equal(installmentNature("رسوم خدمات"), "fee");
  });

  it("11a: invoices match rent rows only (never a fee row on the same due date), each invoice once", () => {
    const rows = [
      { id: 1, dueDate: "2026-07-01", description: null },
      { id: 2, dueDate: "2026-07-01", description: "رسوم خدمات" },
      { id: 3, dueDate: "2026-08-01", description: null },
      { id: 4, dueDate: "2026-09-01", description: null },
    ];
    const invoices = [
      { number: "A1", dueDate: "2026-07-01", amount: "3000", remaining: "0", status: "مدفوعة" },
      { number: "A2", dueDate: "2026-08-01T00:00:00Z", amount: "3000", remaining: "1000", status: "متأخرة" },
      { number: "DUP", dueDate: "2026-08-01", amount: "3000", remaining: "0", status: "مدفوعة" },
    ];
    const m = matchEjarInvoices(rows, invoices);
    assert.deepEqual(m.map((x) => [x.row.id, x.inv.number]), [[1, "A1"], [3, "A2"]]);
  });
});
