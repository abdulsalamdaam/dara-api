import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fromHalalas, toHalalas } from "./money";

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
});
