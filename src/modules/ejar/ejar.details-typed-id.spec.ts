/**
 * Ejar lookup — the Details fallback on a pinned account (عقاري / tenant plan).
 *
 * Get Contracts can answer count 0 for a contract Ejar holds (prod 8 Nov 2026:
 * an active contract whose company tenant had not approved it), and the
 * lookup falls back to Details. Details names an individual party without its
 * ID number, so the pin cannot be checked against Ejar's answer. Instead of
 * refusing the user's own contract (party_mismatch), the lookup goes through
 * with `typedIdRequired` and the import requires the typed national ID to be
 * the account's stored one.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { CN, world, httpError, individualDetails } from "./__tests__/lookup-harness";
import { EjarImportService, type EjarImportRunnerLike } from "./ejar.import.service";
import type { ImportPlan, ImportResult } from "./ejar.import.writer";

const USER = { id: 1 } as never;
const OWN_ID = "1000000001";
const TENANT_ID = "2000000002";

class RecordingRunner implements EjarImportRunnerLike {
  plans: ImportPlan[] = [];
  async run(_ownerId: number, plan: ImportPlan): Promise<ImportResult> {
    this.plans.push(plan);
    return { contractId: 500, propertyId: 1, unitIds: [1], landlordId: 1, deedId: null, tenantId: 1, installmentsCreated: 2, created: ["contract"], linked: [] };
  }
}

const body = (landlordId: string | undefined, tenantId: string | undefined = TENANT_ID) => ({
  contract_number: CN,
  landlord: landlordId === undefined ? {} : { idNumber: landlordId },
  tenant: tenantId === undefined ? {} : { idNumber: tenantId },
  property: { new: { name: "عقار تجريبي", propertyTypeId: 1, usageId: 2, city: "riyadh" } },
  unit: { new: { unitNumber: "A-1", unitTypeId: 5 } },
});

/** Get Contracts lists nothing; Details answers with individuals and no IDs. */
function fallbackWorld() {
  const w = world();
  w.listOnly();
  w.details.set(CN, individualDetails(CN));
  return w;
}

let w: ReturnType<typeof fallbackWorld>;
afterEach(() => w?.restore());

describe("Details fallback on a pinned account: the typed ID must be the account's own", () => {
  const pin = (role: "landlord" | "tenant", idNumber: string) => { w.store.partyChecks[1] = { role, idNumber }; };

  it("عقاري: the lookup goes through (3 calls), saved, flagged typedIdRequired, the landlord ID asked", async () => {
    w = fallbackWorld();
    pin("landlord", OWN_ID);
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(w.dataCalls().length, 3, "Invoices + Get Contracts (empty) + Details");
    assert.deepEqual(res.partyCheck, { role: "landlord", idNumber: OWN_ID, matched: null, typedIdRequired: true });
    assert.equal(w.store.lookups.size, 1);
    assert.ok(res.required.some((r) => r.key === "landlord.idNumber" && r.required));
  });

  it("عقاري: another ID, or none, is refused 422 and nothing is written; the right one imports", async () => {
    w = fallbackWorld();
    pin("landlord", OWN_ID);
    await w.svc.lookup(USER, { contract_number: CN });
    w.setRespond((url) => { throw new Error(`the import called Ejar: ${url}`); });
    const runner = new RecordingRunner();
    const svc = new EjarImportService(w.store, runner);
    for (const typed of ["1000000009", undefined]) {
      const { status, body: err } = await httpError(svc.import(USER, body(typed)));
      assert.equal(status, 422, String(typed));
      assert.equal(err.code, "party_mismatch");
      assert.equal(err.typed, true);
      assert.match(err.message, /لا يطابق هوية المؤجر/);
    }
    assert.equal(runner.plans.length, 0);
    await svc.import(USER, body(OWN_ID));
    assert.equal(runner.plans.length, 1);
    assert.equal((runner.plans[0].landlord as { party: any }).party.idNumber, OWN_ID);
  });

  it("tenant plan: the tenant side is checked the same way", async () => {
    w = fallbackWorld();
    pin("tenant", TENANT_ID);
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.equal(res.partyCheck.typedIdRequired, true);
    w.setRespond((url) => { throw new Error(`the import called Ejar: ${url}`); });
    const runner = new RecordingRunner();
    const svc = new EjarImportService(w.store, runner);
    const wrong = await httpError(svc.import(USER, body(OWN_ID, "2000000009")));
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.role, "tenant");
    await svc.import(USER, body(OWN_ID, TENANT_ID));
    assert.equal(runner.plans.length, 1);
  });

  it("Offices / Companies: unpinned — no typed-ID rule", async () => {
    w = fallbackWorld();
    const res = await w.svc.lookup(USER, { contract_number: CN });
    assert.deepEqual(res.partyCheck, { role: null, idNumber: null, matched: null });
  });
});
