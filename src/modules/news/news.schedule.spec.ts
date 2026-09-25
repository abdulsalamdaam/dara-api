import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeNextRunAt, parseDaysOfWeek, zonedToUtc } from "./news.schedule";

const ALL = [0, 1, 2, 3, 4, 5, 6];

describe("computeNextRunAt (Asia/Riyadh, UTC+3)", () => {
  it("returns today's slot when it is still ahead", () => {
    // 2026-09-26 is a Saturday. 03:00Z = 06:00 Riyadh → 07:00 Riyadh = 04:00Z.
    const next = computeNextRunAt(new Date("2026-09-26T03:00:00Z"), "07:00", ALL);
    assert.equal(next?.toISOString(), "2026-09-26T04:00:00.000Z");
  });

  it("rolls to tomorrow once today's slot has passed", () => {
    const next = computeNextRunAt(new Date("2026-09-26T04:00:00Z"), "07:00", ALL); // exactly 07:00 → strictly after
    assert.equal(next?.toISOString(), "2026-09-27T04:00:00.000Z");
  });

  it("uses the Riyadh date, not the UTC date, near midnight", () => {
    // 22:30Z Fri = 01:30 Sat in Riyadh. 02:00 Riyadh Sat is 30 minutes away.
    const next = computeNextRunAt(new Date("2026-09-25T22:30:00Z"), "02:00", ALL);
    assert.equal(next?.toISOString(), "2026-09-25T23:00:00.000Z");
  });

  it("skips to the next allowed weekday", () => {
    // Saturday now; only Sun (0) and Thu (4) allowed → Sunday 27th.
    const next = computeNextRunAt(new Date("2026-09-26T10:00:00Z"), "07:00", [0, 4]);
    assert.equal(next?.toISOString(), "2026-09-27T04:00:00.000Z");
    // Only Thursday → Thu 1 Oct.
    const thu = computeNextRunAt(new Date("2026-09-26T10:00:00Z"), "07:00", [4]);
    assert.equal(thu?.toISOString(), "2026-10-01T04:00:00.000Z");
  });

  it("a single allowed day whose slot just passed → the same weekday next week", () => {
    const next = computeNextRunAt(new Date("2026-09-26T05:00:00Z"), "07:00", [6]);
    assert.equal(next?.toISOString(), "2026-10-03T04:00:00.000Z");
  });

  it("crosses month and year boundaries", () => {
    const next = computeNextRunAt(new Date("2026-12-31T20:00:00Z"), "07:00", ALL); // 23:00 Riyadh 31 Dec
    assert.equal(next?.toISOString(), "2027-01-01T04:00:00.000Z");
  });

  it("returns null for no days or a malformed time", () => {
    assert.equal(computeNextRunAt(new Date(), "07:00", []), null);
    assert.equal(computeNextRunAt(new Date(), "7:00", ALL), null);
    assert.equal(computeNextRunAt(new Date(), "24:00", ALL), null);
  });
});

describe("computeNextRunAt in other zones", () => {
  it("UTC", () => {
    const next = computeNextRunAt(new Date("2026-09-26T08:00:00Z"), "07:00", ALL, "UTC");
    assert.equal(next?.toISOString(), "2026-09-27T07:00:00.000Z");
  });

  it("New York across the DST end (1 Nov 2026)", () => {
    // Before: EDT (UTC-4). 07:00 EDT on Sat 31 Oct = 11:00Z.
    const before = computeNextRunAt(new Date("2026-10-31T05:00:00Z"), "07:00", ALL, "America/New_York");
    assert.equal(before?.toISOString(), "2026-10-31T11:00:00.000Z");
    // After: EST (UTC-5). 07:00 EST on Sun 1 Nov = 12:00Z.
    const after = computeNextRunAt(new Date("2026-10-31T12:00:00Z"), "07:00", ALL, "America/New_York");
    assert.equal(after?.toISOString(), "2026-11-01T12:00:00.000Z");
  });

  it("weekday is judged in the target zone (Tokyo is already tomorrow)", () => {
    // 2026-09-26T20:00Z = Sun 27 05:00 in Tokyo. Only Sunday allowed, 07:00 → 22:00Z Sat.
    const next = computeNextRunAt(new Date("2026-09-26T20:00:00Z"), "07:00", [0], "Asia/Tokyo");
    assert.equal(next?.toISOString(), "2026-09-26T22:00:00.000Z");
  });

  it("zonedToUtc round-trips Riyadh", () => {
    assert.equal(zonedToUtc(2026, 9, 26, 7, 0, "Asia/Riyadh").toISOString(), "2026-09-26T04:00:00.000Z");
  });
});

describe("parseDaysOfWeek", () => {
  it("dedupes, sorts and accepts numeric strings", () => {
    assert.deepEqual(parseDaysOfWeek([3, "1", 1, 0]), [0, 1, 3]);
  });
  it("rejects out-of-range and non-lists", () => {
    assert.equal(parseDaysOfWeek([7]), null);
    assert.equal(parseDaysOfWeek([-1]), null);
    assert.equal(parseDaysOfWeek([1.5]), null);
    assert.equal(parseDaysOfWeek("0,1"), null);
  });
});
