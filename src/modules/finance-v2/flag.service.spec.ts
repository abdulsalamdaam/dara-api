import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FinanceFlagService, FlagUnavailableError } from "./flag.service";
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
    assert.deepEqual(await f.state(1), { on: true, mode: "manager", ledgerStartedAt: null });
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
});
