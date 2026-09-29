import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareEvents, rankOf, type PlannedEvent } from "./extract";
import { vatPeriodOf, BackfillService } from "./backfill.service";
import { parseVatPeriod } from "../vat-returns.service";
import { guardEnv, parseArgs } from "../../../../scripts/finance-v2-backfill";

const ev = (occurredOn: string, code: string, sourceId: number, extra: Partial<PlannedEvent> = {}): PlannedEvent => ({
  sourceType: "x", sourceId, event: code, occurredOn, payload: { facts: { date: occurredOn } } as any,
  rank: rankOf(code), sourceCreatedAt: "2026-01-01 00:00:00+00", sub: code === "reversal" ? 9 : 0, code, ...extra,
});

describe("fv2 backfill ordering (§6.4)", () => {
  it("sorts by date, then rank: documents, due charges, settlements, deposits, collections, notes, commission, refunds, conversions, expenses, releases", () => {
    const order = ["E01", "E02", "E33", "E09", "E03", "E06", "E15", "E04", "E12", "E18", "E35"];
    const shuffled = [...order].reverse().map((c, i) => ev("2026-03-01", c, i + 1));
    assert.deepEqual(shuffled.sort(compareEvents).map((e) => e.code), order);
  });

  it("an earlier date always wins over rank; within a rank the older source first; a collection before its advance VAT", () => {
    const a = ev("2026-03-02", "E01", 1);
    const b = ev("2026-03-01", "E35", 2);
    const c1 = ev("2026-03-05", "E03", 7, { sourceCreatedAt: "2026-03-05 10:00:00+00" });
    const c0 = ev("2026-03-05", "E03", 9, { sourceCreatedAt: "2026-03-05 09:00:00+00" });
    const v = ev("2026-03-05", "E34", 9, { sourceCreatedAt: "2026-03-05 09:00:00+00", sub: 1 });
    assert.deepEqual([a, v, c1, c0, b].sort(compareEvents).map((e) => `${e.code}#${e.sourceId}`), ["E35#2", "E01#1", "E03#9", "E34#9", "E03#7"]);
  });

  it("a reversal sorts after the event it reverses on the same day", () => {
    const orig = ev("2026-04-01", "E18", 5);
    const rev = ev("2026-04-01", "reversal", 5);
    assert.deepEqual([rev, orig].sort(compareEvents).map((e) => e.code), ["E18", "reversal"]);
  });
});

describe("fv2 backfill helpers", () => {
  it("VAT periods: calendar quarter or month", () => {
    assert.deepEqual(vatPeriodOf("2026-05-17", "quarterly"), { from: "2026-04-01", to: "2026-06-30" });
    assert.deepEqual(vatPeriodOf("2026-02-10", "monthly"), { from: "2026-02-01", to: "2026-02-28" });
    assert.deepEqual(parseVatPeriod("2026-Q4"), { key: "2026-Q4", from: "2026-10-01", to: "2026-12-31" });
    assert.deepEqual(parseVatPeriod("2028-02"), { key: "2028-02", from: "2028-02-01", to: "2028-02-29" });
    assert.throws(() => parseVatPeriod("2026-Q5"));
  });

  it("request parsing: dry run by default; cutover needs a date; modes validated", () => {
    assert.equal(BackfillService.parseRequest(1, 2, {}).dryRun, true);
    assert.equal(BackfillService.parseRequest(1, 2, { dryRun: false }).dryRun, false);
    assert.throws(() => BackfillService.parseRequest(1, 2, { mode: "cutover" }));
    assert.throws(() => BackfillService.parseRequest(1, 2, { mode: "full", cutover: "2026-01-01" }));
    assert.throws(() => BackfillService.parseRequest(1, 2, { mode: "sideways" }));
    assert.equal(BackfillService.parseRequest(1, 2, { mode: "cutover", cutover: "2026-04-01" }).cutover, "2026-04-01");
  });

  it("CLI: DATABASE_URL must be explicit, API_PORT 4000 refused, flags parsed", () => {
    assert.throws(() => guardEnv({}), /DATABASE_URL/);
    assert.throws(() => guardEnv({ DATABASE_URL: "postgres://u@db.example:5432/x", API_PORT: "4000" }), /4000/);
    assert.equal(guardEnv({ DATABASE_URL: "postgres://u@localhost:55432/x" }).host, "localhost:55432/x");
    assert.deepEqual(parseArgs(["--account", "7", "--dry-run", "--mode", "catchup"]), { account: "7", "dry-run": true, mode: "catchup" });
    assert.throws(() => parseArgs(["--account"]));
  });
});
