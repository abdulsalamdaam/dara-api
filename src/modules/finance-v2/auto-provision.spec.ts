import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dryRunIsClean, fv2AutoProvisionDisabled, FinanceV2AutoProvisionService } from "./auto-provision.service";
import { setFv2EntitlementHandler, signalFv2Entitlement } from "./auto-provision-signal";
import { FinanceV2StatusController } from "./controllers/status.controller";

/** Finance v2 auto-provisioning: the pure parts (the DB behaviour is in auto-provision.db.spec.ts). */
describe("finance v2 auto-provisioning (unit)", () => {
  const sum = (o: Partial<{ failed: any[]; pending: number; debit: string; credit: string }>) => ({
    failed: o.failed ?? [], pending: o.pending ?? 0, totals: { debit: o.debit ?? "100.00", credit: o.credit ?? "100.00" },
  });

  it("a dry run is clean only when balanced with 0 failed and 0 pending", () => {
    assert.deepEqual(dryRunIsClean(sum({})), { clean: true, why: "" });
    assert.equal(dryRunIsClean(sum({ debit: "0", credit: "0.00" })).clean, true, "an empty history is clean");
    assert.match(dryRunIsClean(sum({ failed: [{}] })).why, /1 failed/);
    assert.match(dryRunIsClean(sum({ pending: 2 })).why, /2 pending/);
    assert.match(dryRunIsClean(sum({ debit: "100.00", credit: "99.99" })).why, /unbalanced/);
  });

  it("kill switches: FINANCE_V2_AUTO_PROVISION_DISABLED=1 or the worker switch", () => {
    assert.equal(fv2AutoProvisionDisabled({}), false);
    assert.equal(fv2AutoProvisionDisabled({ FINANCE_V2_AUTO_PROVISION_DISABLED: "1" }), true);
    assert.equal(fv2AutoProvisionDisabled({ FINANCE_V2_WORKER_DISABLED: "1" }), true);
    assert.equal(fv2AutoProvisionDisabled({ FINANCE_V2_AUTO_PROVISION_DISABLED: "0" }), false);
  });

  it("the legacy-side signal never throws: no handler, bad ids, a throwing handler", () => {
    setFv2EntitlementHandler(null);
    signalFv2Entitlement(5, "spec");
    const seen: Array<[number, string]> = [];
    setFv2EntitlementHandler((id, t) => { seen.push([id, t]); });
    signalFv2Entitlement(null, "spec");
    signalFv2Entitlement(0, "spec");
    signalFv2Entitlement(7, "admin_approve");
    assert.deepEqual(seen, [[7, "admin_approve"]]);
    setFv2EntitlementHandler(() => { throw new Error("boom"); });
    assert.doesNotThrow(() => signalFv2Entitlement(7, "spec"));
    setFv2EntitlementHandler(null);
  });

  it("a service that was never started (kill switch) ignores signals; one that was, queues them once", async () => {
    const calls: number[] = [];
    const svc = new FinanceV2AutoProvisionService({} as any, {} as any, {} as any, {} as any);
    (svc as any).ensure = async (id: number) => { calls.push(id); return { accountUserId: id, outcome: "not_eligible", provisioned: false }; };
    svc.signal(3, "spec");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [], "inactive: no-op");

    const prev = process.env.FINANCE_V2_WORKER_DISABLED;
    delete process.env.FINANCE_V2_WORKER_DISABLED;
    delete process.env.FINANCE_V2_AUTO_PROVISION_DISABLED;
    try {
      svc.onModuleInit();
      signalFv2Entitlement(3, "spec");
      signalFv2Entitlement(3, "spec");      // already queued: joins nothing
      svc.signal(4, "status", 60_000);
      svc.signal(4, "status", 60_000);      // memoised
      await (svc as any).chain;
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(calls, [3, 4]);
    } finally {
      svc.onModuleDestroy();
      if (prev !== undefined) process.env.FINANCE_V2_WORKER_DISABLED = prev;
    }
    signalFv2Entitlement(5, "spec");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [3, 4], "the handler is removed on destroy");
  });

  it("/status keeps its shape and nudges only an entitled account that is still off", async () => {
    const nudged: number[] = [];
    const auto = { signal: (id: number) => nudged.push(id) } as any;
    const flagWith = (s: any) => ({ state: async () => s }) as any;
    const req = (id: number) => ({ user: { id, ownerScopeId: null, ownerUserId: null, role: "user", permissions: [] } }) as any;
    const off = await new FinanceV2StatusController(flagWith({ on: false, flagOn: false, planLocked: false }), auto).status(req(11));
    assert.deepEqual(off, { enabled: false, planLocked: false, requiredPlan: null });
    await new FinanceV2StatusController(flagWith({ on: false, flagOn: false, planLocked: true }), auto).status(req(12));
    await new FinanceV2StatusController(flagWith({ on: true, flagOn: true, planLocked: false, mode: "manager", ledgerStartedAt: null }), auto).status(req(13));
    await new FinanceV2StatusController(flagWith({ on: false, flagOn: true, planLocked: true }), auto).status(req(14));
    assert.deepEqual(nudged, [11]);
  });
});
