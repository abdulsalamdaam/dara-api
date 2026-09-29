import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { periodFor, periodsOfFiscalYear } from "./dates";

describe("fv2 fiscal periods", () => {
  it("calendar fiscal year", () => {
    assert.deepEqual(periodFor("2026-02-14"), { fiscalYear: 2026, periodNo: 2, startsOn: "2026-02-01", endsOn: "2026-02-28" });
    assert.deepEqual(periodFor("2028-02-29"), { fiscalYear: 2028, periodNo: 2, startsOn: "2028-02-01", endsOn: "2028-02-29" });
    assert.equal(periodFor("2026-12-31").endsOn, "2026-12-31");
  });
  it("a fiscal year starting in July is labelled by its first calendar year", () => {
    assert.deepEqual(periodFor("2026-06-30", 7), { fiscalYear: 2025, periodNo: 12, startsOn: "2026-06-01", endsOn: "2026-06-30" });
    assert.deepEqual(periodFor("2026-07-01", 7), { fiscalYear: 2026, periodNo: 1, startsOn: "2026-07-01", endsOn: "2026-07-31" });
  });
  it("twelve contiguous months per fiscal year", () => {
    const ps = periodsOfFiscalYear(2026, 7);
    assert.equal(ps.length, 12);
    assert.equal(ps[0].startsOn, "2026-07-01");
    assert.equal(ps[11].endsOn, "2027-06-30");
    ps.forEach((p, i) => assert.equal(p.periodNo, i + 1));
  });
});
