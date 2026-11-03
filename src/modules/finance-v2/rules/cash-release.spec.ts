/**
 * E35C — cash-basis rent release (0094, customer accounting notes 3 Nov 2026).
 * Synthetic figures only (public repo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cashRelease } from "./installments";
import { runRule, CHARGE_STATE_RULES } from "./index";
import { totals } from "./lines";
import type { InstallmentFacts } from "./facts";
import type { PostState } from "./types";

const P = 41;
const facts = (settledGross: string, extra: Partial<InstallmentFacts> = {}): InstallmentFacts => ({
  date: "2026-10-05", treatment: "principal", dims: { ownerId: 1, propertyId: 2, unitId: 3, tenantId: 4, contractId: 5 },
  paymentId: P, gross: "1150.00", category: "S", rate: 15, nature: "rent", usage: "commercial", deferRent: true, settledGross, ...extra,
} as InstallmentFacts);
// Charged 1,150 gross: 1,000 net booked to 2131.
const state = (unreleased: number, booked = 100_000): PostState => ({
  charges: { [P]: { generation: 1, chargedBy: "due", documentId: null, amount: 115_000, vatAmount: 15_000, vatBase: 100_000, entryId: 9, category: "S" } },
  vatBooked: {}, baseBooked: {}, unreleased: { [P]: unreleased }, urBooked: { [P]: booked }, writtenOff: [],
});
const urDr = (r: ReturnType<typeof cashRelease>) => r.lines.filter((l: any) => "sys" in l.account && l.account.sys === "unearned_rent").reduce((s, l: any) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);

describe("E35C cash-basis release", () => {
  it("releases the paid share of what 2131 booked, balanced", () => {
    const r = cashRelease(facts("575.00"), state(100_000)); // half paid
    assert.equal(r.skip, undefined);
    assert.equal(urDr(r), 50_000, "Dr 2131 500.00");
    const t = totals(r.lines);
    assert.equal(t.debit, t.credit);
  });

  it("only the difference from what was already released (monthly or cash)", () => {
    const r = cashRelease(facts("1150.00"), state(30_000)); // 700 released already, fully paid now
    assert.equal(urDr(r), 30_000);
  });

  it("pulls revenue back after a refund", () => {
    const r = cashRelease(facts("230.00"), state(0)); // all released, only 20% still paid
    assert.equal(urDr(r), -80_000, "Cr 2131 800.00");
    const t = totals(r.lines);
    assert.equal(t.debit, t.credit);
  });

  it("nothing to do when it already matches; never more than booked", () => {
    assert.equal(cashRelease(facts("575.00"), state(50_000)).skip, "nothing_to_release");
    assert.equal(urDr(cashRelease(facts("99999.00"), state(100_000))), 100_000, "paid above gross caps at the whole");
  });

  it("skips what is not principal rent, or not charged", () => {
    assert.equal(cashRelease(facts("575.00", { treatment: "agent" }), state(100_000)).skip, "agent_not_deferred");
    assert.equal(cashRelease(facts("575.00", { nature: "fee" }), state(100_000)).skip, "nothing_to_release");
    assert.equal(cashRelease(facts("575.00"), { ...state(100_000), charges: {} }).skip, "not_charged");
  });

  it("is a registered, charge-state rule", () => {
    assert.ok(CHARGE_STATE_RULES.has("E35C"));
    assert.equal(urDr(runRule({ rule: "E35C", facts: facts("1150.00"), paymentIds: [P] } as any, state(100_000))), 100_000);
  });
});
