import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activityOf, arColumn, CASH_LINES, daysFrom, depositAmount, depositColumn, depositState, lineOfCounter, lineOfRule, pct, type Counter } from "./acct-math";

const c = (systemKey: string | null, type: string, code: string, net: number): Counter => ({ systemKey, type, code, net });

describe("accountant reports: classification (pure)", () => {
  it("cash-flow lines by posting rule", () => {
    assert.equal(lineOfRule("E03", [], 100, false), "tenant_receipts");
    assert.equal(lineOfRule("E33", [], 100, false), "ejar_settlements");
    assert.equal(lineOfRule("E04", [c("tenant_receivable", "asset", "1121", -100)], -100, false), "tenant_refunds");
    assert.equal(lineOfRule("E04", [c("deposits_held", "liability", "2141", -100)], -100, false), "deposits_refunded");
    assert.equal(lineOfRule("E09C", [], 100, false), "deposits_received");
    assert.equal(lineOfRule("E09C", [], -100, false), "deposits_refunded");
    assert.equal(lineOfRule("E09C", [], -100, true), "deposits_received", "a reversed receipt stays on the receipts line");
    assert.equal(lineOfRule("E19", [c("landlord_payable", "liability", "2121", -5)], -5, false), "landlord_payouts");
    assert.equal(lineOfRule("E19", [c("owner_drawings", "equity", "3400", -5)], -5, false), "drawings", "Owner mode: a payout is drawings");
    assert.equal(lineOfRule("E28", [], 1, false), null);
    assert.equal(lineOfRule(null, [], 1, false), null);
  });

  it("cash-flow lines by counter-account", () => {
    assert.equal(lineOfCounter(c("output_vat", "liability", "2151", -500)), "vat");
    assert.equal(lineOfCounter(c("vat_settlement", "liability", "2152", -500)), "vat");
    assert.equal(lineOfCounter(c(null, "asset", "1222", -3000)), "investing");
    assert.equal(lineOfCounter(c(null, "liability", "2180", 5000)), "borrowings");
    assert.equal(lineOfCounter(c(null, "liability", "2320", 5000)), "borrowings");
    assert.equal(lineOfCounter(c("capital", "equity", "3100", 5000)), "capital");
    assert.equal(lineOfCounter(c("opening_balance_equity", "equity", "3900", 5000)), "opening_balances");
    assert.equal(lineOfCounter(c(null, "expense", "5220", -10)), "expenses_paid");
    assert.equal(lineOfCounter(c("deposits_held", "liability", "2141", 10)), "deposits_received");
    assert.equal(lineOfCounter(c("deposits_held", "liability", "2141", -10)), "deposits_refunded");
    assert.equal(lineOfCounter(c("misc_revenue", "revenue", "4390", 10)), "other_operating");
    for (const a of ["operating", "investing", "financing"] as const) for (const l of CASH_LINES[a]) assert.equal(activityOf(l), a);
    assert.equal(activityOf("internal_transfer"), null);
  });

  it("receivable columns: billed, collected, adjustment", () => {
    for (const r of ["E01", "E02", "E05", "E06", "E07", "E08", "E17", "E34"]) assert.equal(arColumn(r), "billed", r);
    for (const r of ["E03", "E04", "E20", "E33", "E12B"]) assert.equal(arColumn(r), "collected", r);
    for (const r of ["E24", "E21", "E28", null]) assert.equal(arColumn(r), "adjustment", String(r));
  });

  it("deposit columns follow the rule; a reversal is classified as the line it mirrors", () => {
    assert.equal(depositColumn("E09", true, false), "received");
    assert.equal(depositColumn("E09", false, true), "received");
    assert.equal(depositColumn("E09C", false, false), "refunded");
    assert.equal(depositColumn("E09C", false, true), "received");
    assert.equal(depositColumn("E10", false, false), "refunded");
    assert.equal(depositColumn("E11", false, false), "forfeited");
    assert.equal(depositColumn("E12", false, false), "converted");
    assert.equal(depositColumn("E12B", false, false), "applied");
    assert.equal(depositColumn("E28", true, false), "other");
    assert.equal(depositAmount("received", 0, 500), 500);
    assert.equal(depositAmount("received", 500, 0), -500, "a reversed receipt lowers received");
    assert.equal(depositAmount("refunded", 300, 0), 300);
  });

  it("deposit state", () => {
    const s = (required: number, received: number, refunded: number, deducted: number, balance: number) => depositState({ required, received, refunded, deducted, balance });
    assert.equal(s(0, 0, 0, 0, 0), "none");
    assert.equal(s(100, 0, 0, 0, 0), "not_collected");
    assert.equal(s(100, 100, 0, 0, 100), "held");
    assert.equal(s(100, 100, 40, 0, 60), "partially_released");
    assert.equal(s(100, 100, 100, 0, 0), "refunded");
    assert.equal(s(100, 100, 0, 100, 0), "forfeited");
    assert.equal(s(100, 100, 60, 40, 0), "settled");
  });

  it("percentages and days", () => {
    assert.equal(pct(5130000, 5405000), "94.91");
    assert.equal(pct(2, 3), "66.67");
    assert.equal(pct(1, 0), null);
    assert.equal(pct(-1, 3), "-33.33");
    assert.equal(daysFrom("2026-03-31", "2026-12-31"), 275);
    assert.equal(daysFrom("2026-03-31", "2027-01-31"), 306);
  });
});
