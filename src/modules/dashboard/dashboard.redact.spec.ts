import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canSeePaymentFigures, hiddenPaymentFigures } from "./dashboard.module";
import { homeMay } from "../mobile-landlord/mobile-landlord.module";

/**
 * GET /dashboard/summary and /landlord/me/summary are open to every login (the
 * home screens), but their money figures are payments.view data. The Oct 2026
 * RBAC QA pass found a customer-service employee reading the account's
 * collected / pending / overdue totals there while /payments refused them.
 */
describe("dashboard money needs payments.view", () => {
  it("is shown only with payments.view", () => {
    assert.equal(canSeePaymentFigures({ permissions: ["payments.view"] }), true);
    assert.equal(canSeePaymentFigures({ permissions: ["tenants.view", "maintenance.view"] }), false);
    assert.equal(canSeePaymentFigures({ permissions: null }), false);
  });
  it("hidden figures are null (not zero) and flagged", () => {
    const h = hiddenPaymentFigures();
    for (const k of ["monthlyRevenue", "collectedTotal", "pendingDue", "overduePaymentsCount", "overdueAmount", "revenueByMonth"] as const) {
      assert.equal(h[k], null, k);
    }
    assert.equal(h.paymentFiguresHidden, true);
  });
});

describe("landlord-app home screen: per-kind gating", () => {
  it("an owner-mobile token sees everything (narrowed by data instead)", () => {
    assert.equal(homeMay({ ownerScopeId: 5, permissions: [] }, "payments.view"), true);
  });
  it("a portal login needs the matching permission", () => {
    assert.equal(homeMay({ ownerScopeId: null, permissions: ["tenants.view"] }, "payments.view"), false);
    assert.equal(homeMay({ ownerScopeId: null, permissions: ["payments.view"] }, "payments.view"), true);
  });
});
