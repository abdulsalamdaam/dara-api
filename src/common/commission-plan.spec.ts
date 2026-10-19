import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ForbiddenException } from "@nestjs/common";
import {
  COMMISSION_LOCK_MESSAGE_AR, CommissionNotInPlanException, assertPlanAllowsCommission, planAllowsCommission,
} from "./plan-features";
import { assertScopeAllowsCommission, createCommissionV2, scopeAllowsCommission } from "../modules/finance-v2/commission";
import type { Sql } from "../modules/finance-v2/hooks/sql";

/** A Sql double: answers the plan lookup and records every other statement. */
function fakeSql(plan: string | null) {
  const seen: string[] = [];
  const q: Sql = {
    async rows(text: string) {
      seen.push(text);
      if (/from users where id = \$1/.test(text)) return [{ package_plan: plan }] as any;
      return [];
    },
    async exec(text: string) { seen.push(text); return 0; },
  };
  return { q, seen };
}

describe("planAllowsCommission — commission (COM-) is Offices/Companies only", () => {
  it("عقاري (basic) and tenant never issue commission", () => {
    assert.equal(planAllowsCommission("basic"), false);
    assert.equal(planAllowsCommission("tenant"), false);
  });

  it("professional / enterprise do; null, unknown and the broker default follow professional", () => {
    for (const p of ["professional", "enterprise", "broker", null, undefined, "", "nope"]) {
      assert.equal(planAllowsCommission(p), true, String(p));
    }
  });

  it("the refusal is the plan-gate 403 with an Arabic message", () => {
    assert.throws(() => assertPlanAllowsCommission("basic"), (e: any) => {
      assert.ok(e instanceof CommissionNotInPlanException);
      assert.ok(e instanceof ForbiddenException);
      const body = e.getResponse() as any;
      assert.equal(body.statusCode, 403);
      assert.equal(body.code, "PLAN_UPGRADE_REQUIRED");
      assert.equal(body.requiredPlan, "professional");
      assert.equal(body.message, COMMISSION_LOCK_MESSAGE_AR);
      return true;
    });
    assert.doesNotThrow(() => assertPlanAllowsCommission("professional"));
  });
});

describe("Finance v2 commission paths read the account holder's plan", () => {
  it("scopeAllowsCommission / assertScopeAllowsCommission", async () => {
    assert.equal(await scopeAllowsCommission(fakeSql("basic").q, 7), false);
    assert.equal(await scopeAllowsCommission(fakeSql("enterprise").q, 7), true);
    await assert.rejects(assertScopeAllowsCommission(fakeSql("basic").q, 7), CommissionNotInPlanException);
    await assertScopeAllowsCommission(fakeSql(null).q, 7);
  });

  it("createCommissionV2 writes nothing on عقاري (after a downgrade, whatever the fee %)", async () => {
    const { q, seen } = fakeSql("basic");
    const id = await createCommissionV2(q, 7, { id: 1, number: "INV-000001", contractId: 3, paymentId: 5, paymentIds: [5], dueDate: null });
    assert.equal(id, null);
    assert.equal(seen.length, 1, "only the plan lookup ran");
    assert.ok(!seen.some((s) => /insert/i.test(s)));
  });
});
