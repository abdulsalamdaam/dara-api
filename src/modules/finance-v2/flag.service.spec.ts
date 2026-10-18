import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FinanceFlagService, FlagUnavailableError, fv2PlanEntitledSql } from "./flag.service";
import { runWithRequestContext } from "../../common/request-context";

function fakePool(impl: (params: unknown[]) => any) {
  let calls = 0;
  return {
    get calls() { return calls; },
    pool: {
      async query(_sql: string, params: unknown[]) {
        calls++;
        const r = impl(params);
        if (r instanceof Error) throw r;
        return { rows: r ? [r] : [] };
      },
      async connect() { throw new Error("not used"); },
    } as any,
  };
}

const err = (code?: string) => Object.assign(new Error(code ?? "boom"), { code });

describe("FinanceFlagService (DESIGN §1.2)", () => {
  it("a missing row reads off", async () => {
    const f = new FinanceFlagService(fakePool(() => null).pool);
    assert.equal(await f.isOn(1), false);
  });

  it("reads the row", async () => {
    const f = new FinanceFlagService(fakePool(() => ({ on: true, mode: "manager", started: null })).pool);
    assert.deepEqual(await f.state(1), { on: true, mode: "manager", ledgerStartedAt: null, flagOn: true, planLocked: false });
  });

  it("a missing finance_settings table reads off, even strictly (0066 failed at boot)", async () => {
    const f = new FinanceFlagService(fakePool(() => err("42P01")).pool);
    assert.equal(await f.isOn(1), false);
    assert.equal((await f.stateStrict(1)).on, false);
  });

  it("fail-closed: a read error for a never-seen scope reads off; strict throws (v2 routes answer 503)", async () => {
    const f = new FinanceFlagService(fakePool(() => err("57P01")).pool);
    assert.equal(await f.isOn(1), false);
    await assert.rejects(f.stateStrict(1), FlagUnavailableError);
  });

  it("stale-if-error: after the TTL, a failing read returns the last value however old", async () => {
    let fail = false;
    const fp = fakePool(() => (fail ? err("timeout") : { on: true, mode: "owner", started: null }));
    const f = new FinanceFlagService(fp.pool);
    let t = 0;
    f.now = () => t;
    assert.equal(await f.isOn(5), true);
    fail = true;
    t = 10 * 60_000;
    assert.equal(await f.isOn(5), true);
    assert.equal((await f.stateStrict(5)).on, true);
  });

  it("caches for 15 s; invalidate() forces a re-read", async () => {
    let on = false;
    const fp = fakePool(() => ({ on, mode: null, started: null }));
    const f = new FinanceFlagService(fp.pool);
    let t = 0;
    f.now = () => t;
    assert.equal(await f.isOn(9), false);
    on = true;
    t = 14_000;
    assert.equal(await f.isOn(9), false);
    assert.equal(fp.calls, 1);
    f.invalidate(9);
    assert.equal(await f.isOn(9), true);
    on = false;
    t = 40_000;
    assert.equal(await f.isOn(9), false);
  });

  it("is resolved once per request: a flip mid-request is not seen until the next request", async () => {
    let on = false;
    const f = new FinanceFlagService(fakePool(() => ({ on, mode: null, started: null })).pool);
    const ctx = () => ({ requestId: Math.random().toString(), ip: "", userAgent: null, method: "GET", path: "/", startedAt: 0 });
    await runWithRequestContext(ctx(), async () => {
      assert.equal(await f.isOn(3), false);
      on = true;
      f.invalidate(3);
      assert.equal(await f.isOn(3), false);
    });
    await runWithRequestContext(ctx(), async () => {
      assert.equal(await f.isOn(3), true);
    });
  });

  describe("plan gate (common/plan-features.ts): effective = stored flag && plan has accounting", () => {
    for (const plan of ["basic", "tenant"]) {
      it(`${plan}: stored flag on reads off, the stored value is still reported`, async () => {
        const f = new FinanceFlagService(fakePool(() => ({ on: true, mode: "manager", started: new Date(0), plan })).pool);
        const s = await f.state(1);
        assert.equal(s.on, false);
        assert.equal(await f.isOn(1), false);
        assert.equal(await f.resolve(1), false);
        assert.equal(s.flagOn, true);
        assert.equal(s.planLocked, true);
        assert.equal((await f.stateStrict(1)).on, false);
      });
    }
    for (const plan of ["professional", "enterprise", "broker", null, "something-new"]) {
      it(`${plan}: stored flag on reads on`, async () => {
        const f = new FinanceFlagService(fakePool(() => ({ on: true, mode: "manager", started: null, plan })).pool);
        const s = await f.state(1);
        assert.equal(s.on, true);
        assert.equal(s.planLocked, false);
      });
    }
    it("no settings row on a locked plan: off, and planLocked says why the upgrade matters", async () => {
      const f = new FinanceFlagService(fakePool(() => ({ on: null, mode: null, started: null, plan: "basic" })).pool);
      assert.deepEqual(await f.state(1), { on: false, mode: null, ledgerStartedAt: null, flagOn: false, planLocked: true });
    });
    it("a downgrade then an upgrade restores the stored flag (it is never written), within the cache TTL", async () => {
      let plan = "professional";
      const fp = fakePool(() => ({ on: true, mode: "manager", started: null, plan }));
      const f = new FinanceFlagService(fp.pool);
      let t = 0;
      f.now = () => t;
      assert.equal(await f.isOn(2), true);
      plan = "basic";
      t = 16_000;
      assert.equal(await f.isOn(2), false);
      plan = "professional";
      t = 32_000;
      assert.equal(await f.isOn(2), true);
    });
    it("fv2PlanEntitledSql excludes exactly the plan keys without accounting; a null plan stays entitled", () => {
      const sql = fv2PlanEntitledSql("s.account_user_id");
      assert.match(sql, /pu\.id = s\.account_user_id/);
      assert.match(sql, /not in \('basic', 'tenant'\)$/);
      assert.match(sql, /coalesce\(/);
      for (const k of ["professional", "enterprise", "broker"]) assert.ok(!sql.includes(`'${k}'`), k);
    });
  });
});
