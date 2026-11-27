import { test } from "node:test";
import assert from "node:assert/strict";
import { dhamenRef, rowIdFromRef, verifyDhamenPaid } from "./dhamen-billing.module";
import { dhamenCustomerIdentifier } from "../../common/dhamen";

test("references round-trip and stay within Dhamen's 50 chars", () => {
  const ref = dhamenRef(12345);
  assert.ok(ref.length <= 50);
  assert.equal(rowIdFromRef(ref), 12345);
});

test("a reference of another environment or shape is not ours", () => {
  assert.equal(rowIdFromRef("DARA-P-5-0011aabb"), null);
  assert.equal(rowIdFromRef("DARA-S-5"), null);
  assert.equal(rowIdFromRef("DARA-S-99999999999-0011aabb"), null);
  assert.equal(rowIdFromRef(""), null);
});

test("customer identifier is ≤ 12 chars and environment-prefixed", () => {
  const id = dhamenCustomerIdentifier(79);
  assert.equal(id, "S000000079");
  assert.ok(id.length <= 12);
});

const row = { amount: "5.75", gatewayRef: "DARA-S-1-0011aabb" };
const paid = { paymentReferenceId: "DARA-S-1-0011aabb", amount: 5.75, paymentStatus: 1, paymentStatusDetail: 3 };

test("only a paid status of exactly this row and amount verifies", () => {
  assert.deepEqual(verifyDhamenPaid(row, paid), { ok: true });
  assert.equal(verifyDhamenPaid(row, null).ok, false);
  assert.equal(verifyDhamenPaid(row, { ...paid, amount: 5.7 }).reason, "amount_mismatch");
  assert.equal(verifyDhamenPaid(row, { ...paid, paymentReferenceId: "DARA-S-2-0011aabb" }).reason, "reference_mismatch");
  assert.equal(verifyDhamenPaid(row, { ...paid, paymentStatus: 0, paymentStatusDetail: 1 }).ok, false);
  assert.equal(verifyDhamenPaid(row, { ...paid, paymentStatusDetail: 9 }).ok, false);
  assert.equal(verifyDhamenPaid(row, { ...paid, refundPayments: [{ requestId: "r", amount: 1 }] }).reason, "refunded");
});
