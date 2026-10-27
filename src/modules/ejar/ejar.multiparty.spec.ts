/**
 * Ejar multi-party contracts — two or more PRINCIPAL lessors (co-owners) or
 * tenants on one contract, while Dara links one landlord and one tenant.
 *
 *  - The lookup lists the principals (`parties.lessors` / `parties.tenants`,
 *    `principals.{landlord,tenant}`) and the user picks the main one of each
 *    (default: Ejar's first). Representatives are never principals.
 *  - The import links / creates the main one as before; the others go on the
 *    contract as a reference list (`coParties`) — never a landlord / tenant.
 *  - عقاري: the lessor carrying the account landlord's ID is the main one,
 *    preselected and locked; the tenant plan likewise on the tenant side;
 *    Offices / Companies choose freely.
 *
 * `lookup-contracts-multiparty.json` is the production Get Contracts shape
 * with invented parties (public repo): two individual lessors + a lessor
 * representative, an organization tenant + an individual tenant + a tenant
 * representative.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { STG, world, httpError, baladyOk, fixture } from "./__tests__/lookup-harness";
import { coPartiesOf, mapLookup, principalIndexFor, principalsOf, withMain } from "./ejar.lookup.map";
import { EjarImportService, chooseMain, type EjarImportRunnerLike } from "./ejar.import.service";
import { lockedMain } from "./ejar.lookup.service";
import type { ImportPlan, ImportResult } from "./ejar.import.writer";

const N = "20000000001";
const U = "22222222-3333-4444-8555-666666666666";
const LESSOR_1 = "1000000301";
const LESSOR_2 = "2000000302";
const LESSOR_REP = "1000000101";
const TENANT_ORG_CR = "1010999002";
const TENANT_2 = "1000000303";
const TENANT_REP = "1000000102";
const USER = { id: 1 } as never;

function multiWorld() {
  const w = world();
  w.store.lookupRows.push({ id: 8, category: "property_type", key: "plaza" });
  w.setRespond((url) => {
    if (url === `${STG}/v1/ejar-services/contracts/${N}/invoices`) return baladyOk(fixture("lookup-invoices-prod"));
    const list = url.match(/\/v1\/ejar-services\/contracts\?(.*)$/);
    if (list && new URLSearchParams(list[1]).get("contract_ids") === U) return baladyOk(fixture("lookup-contracts-multiparty"));
    throw new Error(`unexpected fetch ${url}`);
  });
  return w;
}

class RecordingRunner implements EjarImportRunnerLike {
  plans: ImportPlan[] = [];
  async run(_ownerId: number, plan: ImportPlan): Promise<ImportResult> {
    this.plans.push(plan);
    return { contractId: 900, propertyId: 1, unitIds: [1], landlordId: 1, deedId: null, tenantId: 1, installmentsCreated: 6, created: ["contract"], linked: [] };
  }
}

const mapped = () => mapLookup(fixture("lookup-invoices-prod"), null, fixture("lookup-contracts-multiparty"), N);
let w: ReturnType<typeof multiWorld> | null = null;
afterEach(() => { w?.restore(); w = null; });

describe("multi-party mapping", () => {
  it("lists every principal in Ejar's order; representatives are never principals", () => {
    const p = mapped().parties;
    assert.deepEqual(p.lessors.map((x) => x.idNumber), [LESSOR_1, LESSOR_2]);
    assert.deepEqual(p.tenants.map((x) => x.crNumber ?? x.idNumber), [TENANT_ORG_CR, TENANT_2]);
    assert.equal(p.lessor?.idNumber, LESSOR_1, "the first principal is the default main one");
    assert.equal(p.tenant?.crNumber, TENANT_ORG_CR);
    assert.equal(p.lessorRepresentative?.idNumber, LESSOR_REP);
    assert.equal(p.tenantRepresentative?.idNumber, TENANT_REP);
    for (const x of [...p.lessors, ...p.tenants]) assert.ok(!/representative/.test(x.role), x.role);
    assert.equal(p.lessors[1].share, 40);
    assert.equal(p.lessors[1].nationality, "EG");
  });

  it("withMain puts the chosen principal in the slot and the others in `others`", () => {
    const m = withMain(mapped(), { landlord: 1, tenant: 1 });
    assert.equal(m.parties.lessor?.idNumber, LESSOR_2);
    assert.equal(m.parties.tenant?.idNumber, TENANT_2);
    assert.equal(m.parties.lessorRepresentative?.idNumber, LESSOR_REP, "the representative stays as it was");
    assert.deepEqual(m.parties.others.map((x) => x.idNumber ?? x.crNumber).sort(), [LESSOR_1, TENANT_ORG_CR].sort());
  });

  it("coPartiesOf: every principal but the main one, reference only, with ID, nationality, contact and share", () => {
    const co = coPartiesOf(mapped().parties, { landlord: 1, tenant: 0 });
    assert.equal(co.length, 2);
    assert.deepEqual(co[0], {
      role: "co_landlord", kind: "individual", name: "مالك أول تجريبي", idType: "national_id", idNumber: LESSOR_1,
      crNumber: null, unifiedNumber: null, vatNumber: null, nationality: "saudi", phone: "500000301",
      email: "co-owner-1@example.invalid", share: null, source: "ejar", referenceOnly: true,
    });
    assert.equal(co[1].role, "co_tenant");
    assert.equal(co[1].idNumber, TENANT_2);
    assert.ok(!co.some((c) => [LESSOR_REP, TENANT_REP].includes(c.idNumber ?? "")), "never a representative");
    assert.deepEqual(coPartiesOf(mapped().parties, { landlord: 0, tenant: 0 }).map((c) => c.idNumber), [LESSOR_2, TENANT_2]);
  });

  it("a single-principal contract has no co-parties", () => {
    const m = mapLookup(fixture("lookup-invoices-prod"), null, fixture("lookup-contracts-prod"), N);
    assert.equal(principalsOf(m.parties, "landlord").length, 1);
    assert.deepEqual(coPartiesOf(m.parties, { landlord: 0, tenant: 0 }), []);
  });

  it("the lock: عقاري → the lessor carrying its ID, tenant plan → the tenant carrying its ID, Offices → none", () => {
    const p = mapped().parties;
    assert.equal(principalIndexFor(p, "landlord", LESSOR_2), 1);
    assert.equal(principalIndexFor(p, "landlord", LESSOR_REP), null, "a representative is never the main one");
    assert.deepEqual(lockedMain(p, { role: "landlord", idNumber: LESSOR_2 }), { landlord: 1, tenant: null });
    assert.deepEqual(lockedMain(p, { role: "tenant", idNumber: TENANT_2 }), { landlord: null, tenant: 1 });
    assert.deepEqual(lockedMain(p, { role: null, idNumber: null }), { landlord: null, tenant: null });
  });

  it("chooseMain: blank → the locked one, else the first; out of range → 400; against the lock → 400 main_party_locked", async () => {
    const p = mapped().parties;
    const none = { landlord: null, tenant: null };
    assert.deepEqual(chooseMain(p, {}, none), { landlord: 0, tenant: 0 });
    assert.deepEqual(chooseMain(p, {}, { landlord: 1, tenant: null }), { landlord: 1, tenant: 0 });
    assert.deepEqual(chooseMain(p, { landlord: { mainIndex: 1 }, tenant: { mainIndex: "1" } }, none), { landlord: 1, tenant: 1 });
    for (const bad of [2, -1, 1.5, "x"]) {
      assert.throws(() => chooseMain(p, { landlord: { mainIndex: bad } }, none), (e: any) => e.getResponse().code === "invalid_field", String(bad));
    }
    assert.throws(() => chooseMain(p, { landlord: { mainIndex: 0 } }, { landlord: 1, tenant: null }),
      (e: any) => e.getResponse().code === "main_party_locked" && e.getResponse().lockedIndex === 1);
  });
});

describe("the lookup offers the choice", () => {
  it("Offices / Companies: both sides offered, Ejar's first by default, nothing locked; options carry contact and required[]", async () => {
    w = multiWorld();
    const res = await w.svc.lookup(USER, { contract_number: N });
    assert.equal(res.principals.landlord.options.length, 2);
    assert.equal(res.principals.tenant.options.length, 2);
    assert.equal(res.principals.landlord.defaultIndex, 0);
    assert.equal(res.principals.landlord.lockedIndex, null);
    assert.equal(res.parties.lessor?.idNumber, LESSOR_1);
    assert.equal(res.principals.landlord.options[1].prefill.phone, "500000302");
    assert.equal(res.principals.landlord.options[1].party.idNumber, LESSOR_2);
    assert.ok(res.principals.landlord.options.every((o) => o.required.every((r) => r.section === "landlord")));
    // The organization tenant's contact is its representative's; the individual's its own.
    assert.equal(res.principals.tenant.options[0].prefill.from.phone, "representative");
    assert.equal(res.principals.tenant.options[1].prefill.from.phone, "party");
  });

  it("عقاري: the lessor carrying the account landlord's ID is preselected and locked — even as Ejar's second", async () => {
    w = multiWorld();
    w.store.partyChecks[1] = { role: "landlord", idNumber: LESSOR_2 };
    const res = await w.svc.lookup(USER, { contract_number: N });
    assert.equal(res.principals.landlord.defaultIndex, 1);
    assert.equal(res.principals.landlord.lockedIndex, 1);
    assert.equal(res.principals.tenant.lockedIndex, null, "the tenant side stays free");
    assert.equal(res.parties.lessor?.idNumber, LESSOR_2, "top-level parties describe the main one");
    assert.equal(res.prefill.landlord.phone, "500000302");
  });

  it("tenant plan: the tenant carrying the account's ID is locked", async () => {
    w = multiWorld();
    w.store.partyChecks[1] = { role: "tenant", idNumber: TENANT_2 };
    const res = await w.svc.lookup(USER, { contract_number: N });
    assert.equal(res.principals.tenant.lockedIndex, 1);
    assert.equal(res.parties.tenant?.idNumber, TENANT_2);
  });
});

describe("the import: main linked or created, the others reference only", () => {
  async function importWith(body: Record<string, unknown>, pin?: { role: "landlord" | "tenant"; idNumber: string }) {
    w = multiWorld();
    if (pin) w.store.partyChecks[1] = pin;
    await w.svc.lookup(USER, { contract_number: N });
    const runner = new RecordingRunner();
    await new EjarImportService(w.store, runner).import(USER, { contract_number: N, ...body });
    return runner.plans[0];
  }

  it("the 2nd lessor and 2nd tenant as main: they are the plan's parties, the 1st ones are co-parties only", async () => {
    const plan = await importWith({ landlord: { mainIndex: 1 }, tenant: { mainIndex: 1 } });
    const ll = plan.landlord as { party: any; rep: any };
    const tn = plan.tenant as { party: any; rep: any };
    assert.equal(ll.party.idNumber, LESSOR_2);
    assert.equal(ll.rep.idNumber, LESSOR_REP, "the representative is handled as before");
    assert.equal(tn.party.idNumber, TENANT_2);
    assert.equal(tn.rep.idNumber, TENANT_REP);
    const co = plan.contract.coParties ?? [];
    assert.deepEqual(co.map((c) => [c.role, c.idNumber ?? c.crNumber]), [["co_landlord", LESSOR_1], ["co_tenant", TENANT_ORG_CR]]);
    assert.ok(co.every((c) => c.referenceOnly === true));
    // The plan's landlord / tenant are exactly one each — a co-party is never one.
    assert.notEqual(ll.party.idNumber, LESSOR_1);
    const others = (plan.contract.ejarRaw?.otherParties ?? []) as Array<{ idNumber: string | null; crNumber: string | null }>;
    assert.deepEqual(others.map((o) => o.idNumber ?? o.crNumber).sort(), [LESSOR_1, TENANT_ORG_CR].sort());
  });

  it("no choice sent: Ejar's first on each side, the second ones as co-parties", async () => {
    const plan = await importWith({});
    assert.equal((plan.landlord as { party: any }).party.idNumber, LESSOR_1);
    assert.deepEqual((plan.contract.coParties ?? []).map((c) => c.idNumber ?? c.crNumber), [LESSOR_2, TENANT_2]);
  });

  it("a representative's position is not a principal: 400, nothing written", async () => {
    w = multiWorld();
    await w.svc.lookup(USER, { contract_number: N });
    const runner = new RecordingRunner();
    const { status, body } = await httpError(new EjarImportService(w.store, runner).import(USER, { contract_number: N, landlord: { mainIndex: 2 } }));
    assert.equal(status, 400);
    assert.equal(body.code, "invalid_field");
    assert.equal(body.key, "landlord.mainIndex");
    assert.equal(runner.plans.length, 0);
  });

  it("عقاري: its own lessor is the main one (blank → it); choosing the other is refused", async () => {
    const pin = { role: "landlord" as const, idNumber: LESSOR_2 };
    const plan = await importWith({}, pin);
    assert.equal((plan.landlord as { party: any }).party.idNumber, LESSOR_2);
    assert.deepEqual((plan.contract.coParties ?? []).filter((c) => c.role === "co_landlord").map((c) => c.idNumber), [LESSOR_1]);
    w!.restore();
    w = multiWorld();
    w.store.partyChecks[1] = pin;
    await w.svc.lookup(USER, { contract_number: N });
    const runner = new RecordingRunner();
    const { status, body } = await httpError(new EjarImportService(w.store, runner).import(USER, { contract_number: N, landlord: { mainIndex: 0 } }));
    assert.equal(status, 400);
    assert.equal(body.code, "main_party_locked");
    assert.equal(runner.plans.length, 0);
  });

  it("tenant plan: its own tenant is the main one; the tenant choice is locked, the landlord choice free", async () => {
    const plan = await importWith({ landlord: { mainIndex: 1 } }, { role: "tenant", idNumber: TENANT_2 });
    assert.equal((plan.tenant as { party: any }).party.idNumber, TENANT_2);
    assert.equal((plan.landlord as { party: any }).party.idNumber, LESSOR_2);
    w!.restore();
    w = multiWorld();
    w.store.partyChecks[1] = { role: "tenant", idNumber: TENANT_2 };
    await w.svc.lookup(USER, { contract_number: N });
    const { body } = await httpError(new EjarImportService(w.store, new RecordingRunner()).import(USER, { contract_number: N, tenant: { mainIndex: 0 } }));
    assert.equal(body.code, "main_party_locked");
  });
});
