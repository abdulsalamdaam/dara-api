import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allocate, fromHalalas, jsonbHalalas, mulDivRound, toHalalas, vatSplit } from "./money";

describe("fv2 money helpers", () => {
  it("parses decimal strings exactly", () => {
    assert.equal(toHalalas("0"), 0);
    assert.equal(toHalalas("0.1"), 10);
    assert.equal(toHalalas("1234.56"), 123456);
    assert.equal(toHalalas("-7.05"), -705);
    assert.equal(toHalalas("999999999999.99"), 99999999999999);
    assert.equal(toHalalas(12.5), 1250);
  });
  it("refuses more than two decimals, exponents and junk", () => {
    for (const bad of ["1.005", "1e3", "", "abc", "1,000", "0.1.2"]) assert.throws(() => toHalalas(bad), bad);
    assert.throws(() => toHalalas(0.1 + 0.2));
  });
  it("round-trips", () => {
    for (const n of [0, 1, 99, 100, 101, 123456, -1, -100, 99999999999999]) assert.equal(toHalalas(fromHalalas(n)), n);
    assert.equal(fromHalalas(5), "0.05");
    assert.equal(fromHalalas(-1250), "-12.50");
    assert.throws(() => fromHalalas(1.5));
  });

  it("VAT split equals the legacy float split for every gross 0.01..100,000.00 (§11.1-k)", () => {
    // The legacy code: round2(gross / 1.15) with round2 = Math.round((n + EPSILON) * 100) / 100.
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    let diffs = 0;
    let first = "";
    for (let g = 1; g <= 10_000_000; g++) {
      const { net, vat } = vatSplit(g);
      const legacy = Math.round(round2(g / 100 / 1.15) * 100);
      if (net !== legacy || net + vat !== g) {
        diffs++;
        first ||= `${fromHalalas(g)}: engine ${net}, legacy ${legacy}`;
      }
    }
    assert.equal(diffs, 0, first);
  });
  it("VAT split: round half up at the .5 halala, symmetric for negatives, rate 0", () => {
    assert.deepEqual(vatSplit(115), { net: 100, vat: 15 });
    assert.deepEqual(vatSplit(690000), { net: 600000, vat: 90000 });
    // 0.23 / 1.15 = 0.2 exactly; 0.01/1.15 = 0.0087 -> 0.01
    assert.deepEqual(vatSplit(1), { net: 1, vat: 0 });
    assert.deepEqual(vatSplit(-690000), { net: -600000, vat: -90000 });
    assert.deepEqual(vatSplit(12345, 0), { net: 12345, vat: 0 });
    assert.deepEqual(vatSplit(99999999999999), { net: 86956521739130, vat: 13043478260869 });
    assert.throws(() => vatSplit(1.5));
  });
  it("allocate splits exactly, remainder to the largest fractions", () => {
    assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(allocate(10, [0, 0]), [0, 10]);
    assert.deepEqual(allocate(-100, [1, 1, 1]), [-34, -33, -33]);
    for (const [t, w] of [[1_000_001, [3, 7, 11]], [5, [1, 1000]], [0, [4, 5]]] as Array<[number, number[]]>) {
      assert.equal(allocate(t, w).reduce((a, b) => a + b, 0), t);
    }
  });
  it("mulDivRound rounds half up exactly", () => {
    assert.equal(mulDivRound(600000, 31, 92), 202174);
    assert.equal(mulDivRound(1, 1, 2), 1);
    assert.equal(mulDivRound(99999999999999, 365, 366), 99726775956283);
  });
  it("jsonb numbers: exact up to 2 decimals, half-up and flagged beyond", () => {
    assert.deepEqual(jsonbHalalas(12.5), { halalas: 1250, rounded: false });
    assert.deepEqual(jsonbHalalas("1.005"), { halalas: 101, rounded: true });
    assert.deepEqual(jsonbHalalas(1.004), { halalas: 100, rounded: true });
    assert.deepEqual(jsonbHalalas("-2.345"), { halalas: -235, rounded: true });
    assert.throws(() => jsonbHalalas("1e5"));
  });
});
