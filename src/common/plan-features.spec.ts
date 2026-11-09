import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ForbiddenException } from "@nestjs/common";
import {
  FEATURE_REQUIRED_PLAN, LOCKED_OPS_REPORTS, PLAN_FEATURE_KEYS, PlanUpgradeRequiredException,
  planAccountingGrantable, planAllowsCommission, planFeatures, planHasFeature, planKeysAccountingGrantable, planKeysWithout,
  planUpgradeRequiredBody,
} from "./plan-features";

describe("plan features (pricing table → enforcement)", () => {
  it("tenant and basic (عقاري) unlock nothing", () => {
    assert.deepEqual(planFeatures("tenant"), []);
    assert.deepEqual(planFeatures("basic"), []);
    for (const f of PLAN_FEATURE_KEYS) {
      assert.equal(planHasFeature("tenant", f), false);
      assert.equal(planHasFeature("basic", f), false);
    }
  });

  it("professional and enterprise unlock everything", () => {
    for (const p of ["professional", "enterprise"]) assert.deepEqual(planFeatures(p), ["accounting", "advanced_reports", "rental_offers"]);
  });

  it("null / unknown resolve to DEFAULT_PACKAGE (professional): unlocked; broker (column default) follows professional", () => {
    for (const p of [null, undefined, "", "nope"]) assert.equal(planHasFeature(p, "accounting"), true, String(p));
    assert.equal(planHasFeature("broker", "advanced_reports"), true);
  });

  it("returns a fresh array each time", () => {
    const a = planFeatures("professional");
    a.pop();
    assert.equal(planFeatures("professional").length, 3);
  });

  it("custom_reports is withdrawn on every plan — never advertised", () => {
    assert.ok(!(PLAN_FEATURE_KEYS as string[]).includes("custom_reports"));
    for (const p of ["tenant", "basic", "professional", "enterprise", "broker", null]) {
      assert.ok(!(planFeatures(p) as string[]).includes("custom_reports"), String(p));
    }
  });

  it("the required plan is professional", () => assert.equal(FEATURE_REQUIRED_PLAN, "professional"));

  it("locks exactly the six analysis reports", () => {
    assert.deepEqual(Object.keys(LOCKED_OPS_REPORTS).sort(), [
      "contract_movement", "defaulting_tenants", "landlord_portfolio", "occupancy_trend", "property_performance", "tenant_payment_behavior",
    ]);
    for (const f of Object.values(LOCKED_OPS_REPORTS)) assert.equal(f, "advanced_reports");
  });

  it("planKeysWithout lists stored keys (incl. legacy aliases) that lack the feature", () => {
    assert.deepEqual(planKeysWithout("accounting"), ["basic", "tenant"]);
  });

  it("the 403 body", () => {
    const b = planUpgradeRequiredBody("advanced_reports", { kpis: [] });
    assert.equal(b.statusCode, 403);
    assert.equal(b.code, "PLAN_UPGRADE_REQUIRED");
    assert.equal(b.feature, "advanced_reports");
    assert.equal(b.requiredPlan, "professional");
    assert.match(b.message, /المكاتب العقارية/);
    assert.deepEqual(b.teaser, { kpis: [] });
    const e = new PlanUpgradeRequiredException("accounting");
    assert.ok(e instanceof ForbiddenException);
    assert.equal(e.getStatus(), 403);
    assert.equal((e.getResponse() as any).teaser, null);
  });
});

describe("accounting on request (admin grant)", () => {
  it("is grantable on عقاري only", () => {
    assert.equal(planAccountingGrantable("basic"), true);
    for (const p of ["tenant", "professional", "enterprise", "broker", null]) assert.equal(planAccountingGrantable(p), false, String(p));
    assert.deepEqual(planKeysAccountingGrantable(), ["basic"]);
  });

  it("a grant on عقاري adds accounting and nothing else", () => {
    assert.deepEqual(planFeatures("basic", true), ["accounting"]);
    assert.equal(planHasFeature("basic", "accounting", true), true);
    assert.equal(planHasFeature("basic", "advanced_reports", true), false);
    assert.equal(planHasFeature("basic", "rental_offers", true), false);
  });

  it("a grant never brings commission (that stays an Offices/Companies activity)", () => {
    assert.equal(planAllowsCommission("basic"), false);
  });

  it("a grant is ignored on tenant, and changes nothing on plans that already have accounting", () => {
    assert.deepEqual(planFeatures("tenant", true), []);
    assert.deepEqual(planFeatures("professional", true), ["accounting", "advanced_reports", "rental_offers"]);
  });
});
