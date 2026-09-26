import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { apportion, bucketOf, netBoxes, percentOf, remainingOf, vatBoxes, type VatAgg } from "./sub-math";

/** DESIGN §11.1: aging buckets and VAT boxes, hand-computed, no DB. */

describe("fv2 aging buckets (§7.6)", () => {
  it("the due date is day 0; each edge falls in the lower bucket; 91+ is 90+", () => {
    const cases: Array<[number, string]> = [
      [-1, "notDue"], [-400, "notDue"], [0, "d0_30"], [30, "d0_30"], [31, "d31_60"], [60, "d31_60"],
      [61, "d61_90"], [90, "d61_90"], [91, "d90p"], [3650, "d90p"],
    ];
    for (const [d, b] of cases) assert.equal(bucketOf(d), b, `day ${d}`);
    assert.throws(() => bucketOf(1.5));
  });

  it("part-paid: 6,900 with 3,000 collected ages 3,900 (neither excluded nor counted in full)", () => {
    assert.equal(remainingOf(690_000, 300_000), 390_000);
    // An invoice of 4,600 less a 230 credit note and 1,000 + 500 collected.
    assert.equal(remainingOf(460_000, 23_000, 100_000, 50_000), 287_000);
    // A negative (refund) collection makes a refunded part owed again.
    assert.equal(remainingOf(500_000, 500_000, -100_000), 100_000);
  });
});

describe("fv2 VAT return boxes (§7.5)", () => {
  const r = (x: Partial<VatAgg> & Pick<VatAgg, "taxRole" | "category">): VatAgg => ({ docClass: null, reversal: false, base: 0, amount: 0, ...x });
  // Sales: invoice S 10,000 / 1,500; credit note S −1,000 / −150; debit note S 200 / 30; advance S 1,000 / 150;
  // zero-rated 4,000; exempt 6,000 with a −500 charge cancellation; out of scope 700.
  // Purchases: S recoverable 2,000 / 300, a reversed revision −400 / −60; S non-recoverable 1,000 / 150;
  // Z 800; E 900; O 250.
  const rows: VatAgg[] = [
    r({ taxRole: "output", category: "S", docClass: "invoice", base: 1_000_000, amount: 150_000 }),
    r({ taxRole: "output", category: "S", docClass: "credit", base: -100_000, amount: -15_000 }),
    r({ taxRole: "output", category: "S", docClass: "debit", base: 20_000, amount: 3_000 }),
    r({ taxRole: "output", category: "S", docClass: "advance", base: 100_000, amount: 15_000 }),
    r({ taxRole: "output", category: "Z", docClass: "invoice", base: 400_000, amount: 400_000 }),
    r({ taxRole: "output", category: "E", docClass: "charge", base: 600_000, amount: 600_000 }),
    r({ taxRole: "output", category: "E", docClass: "charge_cancel", base: -50_000, amount: -50_000 }),
    r({ taxRole: "output", category: "O", docClass: "other", base: 70_000, amount: 70_000 }),
    r({ taxRole: "input", category: "S", docClass: "expense", base: 200_000, amount: 30_000 }),
    r({ taxRole: "input", category: "S", docClass: "expense", reversal: true, base: -40_000, amount: -6_000 }),
    r({ taxRole: "input_nonrecoverable", category: "S", docClass: "expense", base: 100_000, amount: 15_000 }),
    r({ taxRole: "input", category: "Z", docClass: "expense", base: 80_000, amount: 80_000 }),
    r({ taxRole: "input_nonrecoverable", category: "E", docClass: "expense", base: 90_000, amount: 90_000 }),
    r({ taxRole: "input_nonrecoverable", category: "O", docClass: "expense", base: 25_000, amount: 25_000 }),
  ];

  it("every box, amount / adjustment / VAT", () => {
    const b = vatBoxes(rows);
    const by = (n: number) => { const x = b.boxes.find((y) => y.box === n)!; return [x.amount, x.adjustment, x.vat]; };
    assert.deepEqual(by(1), [1_100_000, -80_000, 153_000]);   // 10,000 + 1,000 | −1,000 + 200 | 1,500 − 150 + 30 + 150
    assert.deepEqual(by(2), [0, 0, 0]);
    assert.deepEqual(by(3), [400_000, 0, null]);
    assert.deepEqual(by(4), [0, 0, null]);
    assert.deepEqual(by(5), [600_000, -50_000, null]);
    assert.deepEqual(by(6), [2_100_000, -130_000, 153_000]);
    assert.deepEqual(by(7), [200_000, -40_000, 24_000]);      // Z net lines never count as VAT
    assert.deepEqual(by(10), [80_000, 0, null]);
    assert.deepEqual(by(11), [90_000, 0, null]);
    assert.deepEqual(by(12), [370_000, -40_000, 24_000]);
    assert.deepEqual(b.outOfScopeSales, { amount: 70_000, adjustment: 0 });
    assert.deepEqual(b.outOfScopePurchases, { amount: 25_000, adjustment: 0 });
    assert.deepEqual(b.nonRecoverable, { base: 100_000, vat: 15_000 });
    assert.deepEqual(netBoxes(b.outputVat, b.inputVatBooked, 1_000, 500), { box13: 129_000, box16: 129_500 });
  });

  it("the apportionment adjustment lands in box 7 and 12 VAT", () => {
    const b = vatBoxes(rows, 2_500);
    assert.equal(b.boxes.find((x) => x.box === 7)!.vat, 26_500);
    assert.equal(b.boxes.find((x) => x.box === 12)!.vat, 26_500);
    assert.equal(b.inputVatBooked, 24_000);
  });
});

describe("fv2 input VAT apportionment (§8.2(b))", () => {
  it("overheads at taxable / (taxable + exempt), the adjustment = target − booked", () => {
    const a = apportion({ method: "direct_plus_ratio", taxable: 1_000_000, exempt: 3_000_000, overheadVat: 36_000, overheadBookedRecoverable: 6_000 });
    assert.deepEqual(a, { applies: true, reason: null, ratioPercent: "25.00", recoverableAtRatio: 9_000, adjustment: 3_000 });
    // Already posted at the ratio: nothing more to adjust.
    assert.equal(apportion({ method: "direct_plus_ratio", taxable: 1, exempt: 3, overheadVat: 36_000, overheadBookedRecoverable: 9_000 }).adjustment, 0);
    // Rounding is half-up in halalas: 100.01 × 1/3 = 33.34 (33.336…).
    assert.equal(apportion({ method: "direct_plus_ratio", taxable: 1, exempt: 2, overheadVat: 10_001, overheadBookedRecoverable: 0 }).recoverableAtRatio, 3_334);
  });

  it("does not apply with direct_only, with one kind of supply, or with no overhead VAT", () => {
    const base = { taxable: 100, exempt: 100, overheadVat: 1_000, overheadBookedRecoverable: 400 };
    assert.deepEqual([apportion({ ...base, method: "direct_only" }).reason, apportion({ ...base, method: "direct_only" }).adjustment], ["direct_only", 0]);
    assert.equal(apportion({ ...base, method: "direct_plus_ratio", exempt: 0 }).reason, "single_kind_of_supply");
    assert.equal(apportion({ ...base, method: "direct_plus_ratio", taxable: 0 }).reason, "single_kind_of_supply");
    assert.equal(apportion({ ...base, method: "direct_plus_ratio", taxable: 0, exempt: 0 }).reason, "no_supplies");
    assert.equal(apportion({ ...base, method: "direct_plus_ratio", overheadVat: 0 }).reason, "no_overhead_vat");
  });

  it("percentages are exact to two decimals", () => {
    assert.equal(percentOf(24_600, 32_600), "75.46");
    assert.equal(percentOf(2, 3), "66.67");
    assert.equal(percentOf(1, 0), null);
  });
});
