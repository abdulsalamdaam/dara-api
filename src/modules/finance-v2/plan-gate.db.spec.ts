import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip, withDb, type TestDb } from "./__tests__/with-db";
import { FinanceFlagService, fv2PlanEntitledSql } from "./flag.service";
import { PostingWorker } from "./posting-worker.service";

/**
 * The plan gate against a real (throwaway, local) Postgres: the flag service
 * and the job queries read the same answer — stored flag AND a plan with
 * `accounting` — and a plan change never writes the stored flag. Synthetic rows only.
 */
describe("finance v2 plan gate (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let flag: FinanceFlagService;
  const ids: Record<string, number> = {};
  const q = (sql: string, p: unknown[] = []) => t.pool.query(sql, p);

  before(async () => {
    t = await withDb();
    flag = new FinanceFlagService(t.pool as any);
    for (const plan of ["basic", "tenant", "professional", "enterprise", "broker"]) {
      const id = (await q(`insert into users (email, name, package_plan) values ($1, 'Synthetic', $2) returning id`, [`${plan}@example.test`, plan])).rows[0].id;
      ids[plan] = id;
      await q(`insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode, enabled_at, ledger_started_at) values ($1, true, 'manager', now(), now())`, [id]);
      await q(`insert into ledger_outbox (user_id, source_type, source_id, event, occurred_on, payload) values ($1, 'payment', 1, 'charged', current_date, '{}'::jsonb)`, [id]);
    }
    // No settings row at all, on a locked plan.
    ids.bare = (await q(`insert into users (email, name, package_plan) values ('bare@example.test', 'Synthetic', 'basic') returning id`)).rows[0].id;
  });
  after(async () => t?.drop());

  const entitled = ["professional", "enterprise", "broker"];
  const locked = ["basic", "tenant"];

  it("the flag service: effective off on basic/tenant, stored flag reported as on", async () => {
    for (const p of entitled) assert.equal(await flag.isOn(ids[p]), true, p);
    for (const p of locked) {
      const s = await flag.stateStrict(ids[p]);
      assert.equal(s.on, false, p);
      assert.equal(s.flagOn, true, p);
      assert.equal(s.planLocked, true, p);
    }
    const bare = await flag.state(ids.bare);
    assert.equal(bare.on, false);
    assert.equal(bare.planLocked, true);
  });

  it("the job predicate picks exactly the accounts the flag service reads as on", async () => {
    const r = await q(`select account_user_id as id from finance_settings where finance_v2_enabled and ${fv2PlanEntitledSql("finance_settings.account_user_id")} order by 1`);
    assert.deepEqual(r.rows.map((x: any) => Number(x.id)), entitled.map((p) => ids[p]).sort((a, b) => a - b));
  });

  it("the posting worker skips plan-locked accounts", async () => {
    const worker = new PostingWorker(t.pool as any, null as any, null as any);
    const due = (await worker.dueAccounts()).sort((a, b) => a - b);
    assert.deepEqual(due, entitled.map((p) => ids[p]).sort((a, b) => a - b));
  });

  it("downgrade then upgrade: the stored flag is untouched and comes back", async () => {
    const id = ids.professional;
    await q(`update users set package_plan = 'basic' where id = $1`, [id]);
    flag.invalidate(id);
    assert.equal(await flag.isOn(id), false);
    assert.equal((await q(`select finance_v2_enabled as e from finance_settings where account_user_id = $1`, [id])).rows[0].e, true);
    await q(`update users set package_plan = 'professional' where id = $1`, [id]);
    flag.invalidate(id);
    assert.equal(await flag.isOn(id), true);
  });
});
