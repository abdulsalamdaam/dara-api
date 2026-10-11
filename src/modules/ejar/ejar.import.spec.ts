/**
 * Ejar Import v2 — POST /ejar/import.
 *
 * The import builds the local record from a SAVED lookup plus what the user
 * completed. It must never call Ejar, must refuse without a saved lookup, and
 * must only ever link records that belong to the caller's account.
 *
 * The first block drives EjarImportService against the in-memory store with a
 * recording runner (no database). The last block runs the real writer inside
 * a rolled-back transaction and is skipped when DATABASE_URL is unset.
 */
import { afterEach, after, before, beforeEach, describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { eq, and } from "drizzle-orm";
import {
  db, getPool, contractsTable, propertiesTable, unitsTable, ownersTable, tenantsTable, paymentsTable,
  contractUnitsTable, usersTable, lookupsTable,
} from "@dara/database";

import {
  CN, UUID, world, httpError, invoicesFor, detailsFor, individualDetails, fixture, contractsFor, PROPERTY_UUID, UNIT_UUID,
} from "./__tests__/lookup-harness";
import { EjarImportService, EjarImportRunner, type EjarImportRunnerLike } from "./ejar.import.service";
import { DrizzleEjarLookupStore } from "./ejar.lookup.store";
import type { ImportPlan, ImportResult } from "./ejar.import.writer";
import { mapEjarToContract } from "./ejar.map";
import { computeRequired, mapLookup } from "./ejar.lookup.map";
import type { EjarBody, JsonApiResource } from "./ejar.types";

const USER = { id: 1 } as never;

class RecordingRunner implements EjarImportRunnerLike {
  plans: ImportPlan[] = [];
  async run(ownerId: number, plan: ImportPlan): Promise<ImportResult> {
    this.plans.push(plan);
    return { contractId: 500, propertyId: 1, unitIds: [1], landlordId: 1, deedId: null, tenantId: 1, installmentsCreated: 2, created: ["contract"], linked: [] };
  }
}

const baseBody = () => ({
  contract_number: CN,
  landlord: {},
  tenant: {},
  property: { new: { name: "عقار تجريبي", propertyTypeId: 1, usageId: 2, city: "riyadh" } },
  unit: { new: { unitNumber: "A-1", unitTypeId: 5 } },
});

describe("POST /ejar/import (service)", () => {
  let w: ReturnType<typeof world>;
  let runner: RecordingRunner;
  let svc: EjarImportService;

  const seed = (details: unknown = detailsFor(CN), accountId = 1) =>
    w.store.saveLookup({ accountId, contractNumber: CN, ejarUuid: UUID, invoicesBody: invoicesFor(CN), detailsBody: details as never, lookedUpBy: 1 });

  beforeEach(() => {
    w = world();
    w.setRespond((url) => { throw new Error(`the import called Ejar: ${url}`); });
    runner = new RecordingRunner();
    svc = new EjarImportService(w.store, runner);
  });
  afterEach(() => {
    assert.equal(w.calls.length, 0, "the import never calls Ejar");
    w.restore();
  });

  it("builds the plan from the saved lookup without calling Ejar", async () => {
    await seed();
    const res = await svc.import(USER, baseBody());
    assert.equal(res.contractId, 500);
    const plan = runner.plans[0];
    assert.equal(plan.contractNumber, CN);

    // Parties: the organizations as Ejar named them, the representatives as agents.
    assert.ok(!("existingId" in plan.landlord));
    const ll = (plan.landlord as { party: any; rep: any });
    assert.equal(ll.party.name, "شركة تجريبية للتطوير");
    assert.equal(ll.party.registrationNumber, "1010000002");
    assert.equal(ll.party.partyType, "organization");
    assert.equal(ll.party.unifiedNumber, null, "never lands in the VAT-number column");
    assert.equal(ll.rep.name, "محمد تجريبي");
    assert.equal(ll.rep.isRepresentative, true);
    assert.equal((plan.tenant as { party: any }).party.registrationNumber, "1010000001");

    // Property/unit come from what the user typed; they are not Ejar data.
    const prop = (plan.property as { create: ImportPlan["property"] extends infer _ ? any : never }).create;
    assert.equal(prop.p.name, "عقار تجريبي");
    assert.deepEqual(prop.overrides, { typeLookupId: 1, typeOther: null, usageLookupId: 2, cityLookupId: 6, ejarSource: null });
    const unit = (plan.unit as { create: any }).create;
    assert.equal(unit.u.unitNumber, "A-1");
    assert.equal(unit.overrides.typeLookupId, 5);
    assert.equal(unit.overrides.status, "rented");

    // Contract: Ejar's dates, its invoices as the custom schedule, the deposit from Details.
    const c = plan.contract;
    assert.equal(c.startDate, "2026-11-16");
    assert.equal(c.endDate, "2029-11-15");
    assert.equal(c.status, "active");
    assert.equal(c.signingDate, "2026-07-30");
    assert.deepEqual(c.customSchedule, [{ dueDate: "2026-11-26", amount: "34500" }, { dueDate: "2027-05-26", amount: "34500" }]);
    assert.equal(c.depositAmount, "6000");
    assert.equal(c.monthlyRent, String(Math.round((60000 / 36) * 1e6) / 1e6), "total rent over 36 months, ex-VAT");
    assert.equal(c.vatFallback, true, "commercial contract → 15% when usage cannot decide (the writer applies usage first)");
    assert.equal(plan.invoices.length, 2);
    assert.ok(plan.invoices.every((i) => i.number), "the Ejar invoice numbers travel to the attach step");
  });

  it("refuses without a saved lookup (409)", async () => {
    const { status, body } = await httpError(svc.import(USER, baseBody()));
    assert.equal(status, 409);
    assert.equal(body.code, "no_lookup");
    assert.equal(runner.plans.length, 0);
  });

  it("another account's saved lookup does not count", async () => {
    await seed(detailsFor(CN), 2);
    const { status } = await httpError(svc.import(USER, baseBody()));
    assert.equal(status, 409);
  });

  it("refuses a contract that is already imported (409)", async () => {
    await seed();
    w.store.imported.set(`1:${CN}`, 77);
    const { status, body } = await httpError(svc.import(USER, baseBody()));
    assert.equal(status, 409);
    assert.equal(body.code, "already_imported");
    assert.equal(body.contractId, 77);
  });

  it("rejects a bad contract number before anything else (400)", async () => {
    const { status } = await httpError(svc.import(USER, { ...baseBody(), contract_number: "x1" }));
    assert.equal(status, 400);
  });

  it("rejects existingIds that belong to another account", async () => {
    await seed();
    w.store.owners.push({ id: 11, accountId: 2, name: "x", idNumber: null });
    w.store.tenants.push({ id: 21, accountId: 2, name: "x", nationalId: null });
    w.store.properties.push({ id: 31, accountId: 2, ownerId: null, usageLookupId: 2 });
    w.store.units.push({ id: 41, propertyId: 31, unitNumber: "1", usageLookupId: null });
    for (const [section, id] of [["property", 31], ["unit", 41]] as const) {
      const body: any = baseBody();
      body[section] = { existingId: id };
      if (section === "unit") body.property = { existingId: 31 };
      const { status, body: err } = await httpError(svc.import(USER, body));
      assert.equal(status, 404, section);
      assert.equal(err.code, "not_in_account");
    }
    assert.equal(runner.plans.length, 0);
  });

  it("rejects a picked unit that is not on the picked property", async () => {
    await seed();
    w.store.properties.push({ id: 31, accountId: 1, ownerId: null, usageLookupId: 2 }, { id: 32, accountId: 1, ownerId: null, usageLookupId: 2 });
    w.store.units.push({ id: 41, propertyId: 32, unitNumber: "1", usageLookupId: null });
    const { status } = await httpError(svc.import(USER, { ...baseBody(), property: { existingId: 31 }, unit: { existingId: 41 } }));
    assert.equal(status, 400);
  });

  it("refuses to link an existing landlord or tenant, even the account's own (400)", async () => {
    await seed(individualDetails());
    w.store.owners.push({ id: 11, accountId: 1, name: "مؤجر", idNumber: "1000000001" });
    w.store.tenants.push({ id: 21, accountId: 1, name: "مستأجر", nationalId: "2000000002" });
    for (const [section, id] of [["landlord", 11], ["tenant", 21]] as const) {
      const { status, body } = await httpError(svc.import(USER, { ...baseBody(), [section]: { existingId: id } }));
      assert.equal(status, 400, section);
      assert.equal(body.code, "invalid_field");
      assert.equal(body.key, `${section}.existingId`);
    }
    assert.equal(runner.plans.length, 0);
  });

  it("links the account's own property and unit; parties are new records from Ejar + what was typed", async () => {
    await seed(individualDetails());
    w.store.properties.push({ id: 31, accountId: 1, ownerId: 11, usageLookupId: 3 });
    w.store.units.push({ id: 41, propertyId: 31, unitNumber: "1", usageLookupId: null });
    await svc.import(USER, {
      contract_number: CN, landlord: { idNumber: "1000000001" }, tenant: { idNumber: "2000000002" },
      property: { existingId: 31 }, unit: { existingId: 41 },
    });
    const plan = runner.plans[0];
    assert.equal((plan.landlord as { party: any }).party.name, "فهد تجريبي");
    assert.equal((plan.landlord as { party: any }).party.idNumber, "1000000001");
    assert.deepEqual(plan.property, { existingId: 31 });
    assert.deepEqual(plan.unit, { existingId: 41 });
    assert.equal(plan.contract.vatFallback, false, "residential contract → exempt");
    assert.equal(plan.contract.depositAmount, null, "a zero deposit is no deposit");
  });

  it("individual parties need an ID number typed (400 missing_fields)", async () => {
    await seed(individualDetails());
    const { status, body } = await httpError(svc.import(USER, baseBody()));
    assert.equal(status, 400);
    assert.equal(body.code, "missing_fields");
    assert.deepEqual([...body.missing].sort(), ["landlord.idNumber", "tenant.idNumber"]);
  });

  it("typed ID numbers are validated like a manual record's", async () => {
    await seed(individualDetails());
    const bad = await httpError(svc.import(USER, { ...baseBody(), landlord: { idNumber: "123" }, tenant: { idNumber: "2000000002" } }));
    assert.equal(bad.status, 400);
    await svc.import(USER, {
      ...baseBody(),
      landlord: { idNumber: "1000000001", phone: "0500000000", email: "Landlord@Example.com" },
      tenant: { idNumber: "2000000002" },
    });
    const ll = (runner.plans[0].landlord as { party: any }).party;
    assert.equal(ll.idNumber, "1000000001");
    assert.equal(ll.phone, "500000000", "stored in the canonical bare form");
    assert.equal(ll.email, "landlord@example.com");
    assert.equal(ll.raw.id_number, undefined, "a typed ID is not Ejar data, so it does not lock");
  });

  it("a Details snapshot: a new property and unit need name, type, city and number, type", async () => {
    await seed();
    const { status, body } = await httpError(svc.import(USER, { contract_number: CN, landlord: {}, tenant: {} }));
    assert.equal(status, 400);
    // Usage follows Ejar's contract type (commercial), so it is not asked for.
    assert.deepEqual([...body.missing].sort(), [
      "property.city", "property.name", "property.propertyTypeId", "unit.unitNumber", "unit.unitTypeId",
    ]);
  });

  it("a lookup id from the wrong category is refused", async () => {
    await seed();
    const body: any = baseBody();
    body.property.new.propertyTypeId = 5; // a unit_type id
    const { status, body: err } = await httpError(svc.import(USER, body));
    assert.equal(status, 400);
    assert.equal(err.key, "property.propertyTypeId");
  });

  it("an unknown city is refused; a city lookup id or Arabic label is accepted", async () => {
    await seed();
    const body: any = baseBody();
    body.property.new.city = "Atlantis";
    assert.equal((await httpError(svc.import(USER, body))).status, 400);
    body.property.new.city = 6;
    await svc.import(USER, body);
    body.property.new.city = "الرياض";
    await svc.import(USER, body);
    assert.equal(runner.plans.length, 2);
  });

  it("a mixed-use property needs the unit's usage, which then decides VAT", async () => {
    await seed();
    const body: any = baseBody();
    body.property.new.usageId = 4; // mixed
    const { body: err } = await httpError(svc.import(USER, body));
    assert.deepEqual(err.missing, ["unit.usageId"]);
    body.unit.new.usageId = 3; // families
    await svc.import(USER, body);
    assert.equal((runner.plans[0].unit as { create: any }).create.overrides.usageLookupId, 3);
  });

  it("VAT is never asked and a client-sent vatEnabled is ignored", async () => {
    await seed(individualDetails()); // residential
    w.store.properties.push({ id: 31, accountId: 1, ownerId: null, usageLookupId: null }); // usage cannot decide
    const body: any = {
      ...baseBody(), landlord: { idNumber: "1000000001" }, tenant: { idNumber: "2000000002" },
      property: { existingId: 31 }, contract: { vatEnabled: true },
    };
    await svc.import(USER, body);
    const c = runner.plans[0].contract as Record<string, unknown>;
    assert.equal(c.vatFallback, false, "residential → exempt, whatever the client sent");
    assert.equal("vatEnabled" in c, false);
  });

  it("required[] has no contract.vatEnabled any more", () => {
    const keys = computeRequired(mapLookup(invoicesFor(CN), detailsFor(CN))).map((r) => r.key);
    assert.ok(!keys.includes("contract.vatEnabled"));
    assert.ok(!keys.some((k) => k.startsWith("contract.")));
  });

  it("a new unit number that already exists on the picked property is a 409", async () => {
    await seed();
    w.store.properties.push({ id: 31, accountId: 1, ownerId: null, usageLookupId: 2 });
    w.store.units.push({ id: 41, propertyId: 31, unitNumber: "A-1", usageLookupId: null });
    const { status, body } = await httpError(svc.import(USER, { ...baseBody(), property: { existingId: 31 } }));
    assert.equal(status, 409);
    assert.equal(body.unitId, 41);
  });

  it("a locked account may not import a contract it is not a party to", async () => {
    await seed();
    w.store.scopes[1] = { locked: true, idNumber: "7000000009" };
    const { status } = await httpError(svc.import(USER, baseBody()));
    assert.equal(status, 403);
    w.store.scopes[1] = { locked: true, idNumber: "1010000001" };
    await svc.import(USER, baseBody());
    assert.equal(runner.plans.length, 1);
  });

  it("fees chosen on the confirm step are passed through for the writer to sanitise", async () => {
    await seed();
    const fees = [{ id: "f1", typeKey: "maintenance", name: "صيانة", amount: "500", recurrence: "one_time" }];
    await svc.import(USER, { ...baseBody(), additionalFees: fees });
    assert.deepEqual(runner.plans[0].additionalFees, fees);
  });
});

describe("POST /ejar/import from a Get Contracts snapshot", () => {
  let w: ReturnType<typeof world>;
  let runner: RecordingRunner;
  let svc: EjarImportService;
  const seed = (list: unknown = contractsFor(CN)) =>
    w.store.saveLookup({ accountId: 1, contractNumber: CN, ejarUuid: UUID, invoicesBody: invoicesFor(CN), detailsBody: null, contractsBody: list as never, lookedUpBy: 1 });

  beforeEach(() => {
    w = world();
    w.setRespond((url) => { throw new Error(`the import called Ejar: ${url}`); });
    runner = new RecordingRunner();
    svc = new EjarImportService(w.store, runner);
  });
  afterEach(() => {
    assert.equal(w.calls.length, 0, "the import never calls Ejar");
    w.restore();
  });

  it("needs nothing typed: property, unit and parties come from Ejar with their IDs", async () => {
    await seed();
    await svc.import(USER, { contract_number: CN });
    const plan = runner.plans[0];
    const ll = (plan.landlord as { party: any; rep: any });
    assert.equal(ll.party.partyType, "organization");
    assert.equal(ll.party.registrationNumber, "1010000002");
    assert.equal(ll.party.unifiedNumber, "300000000000003", "the real VAT number goes to tax_number");
    assert.equal(ll.party.phone, "500000001", "canonical phone, as the manual forms store it");
    assert.equal(ll.party.email, "lessor@example.invalid");
    assert.equal(ll.rep.idNumber, "1000000003");
    const tn = (plan.tenant as { party: any }).party;
    assert.equal(tn.idNumber, "1000000004");
    assert.equal(tn.phone, "500000004");
    assert.equal(tn.email, "tenant@example.invalid");
    assert.equal(tn.raw.id_number, "1000000004", "Ejar's ID is Ejar data, so it locks");

    const prop = (plan.property as { create: any }).create;
    assert.equal(prop.p.ejarId, PROPERTY_UUID, "reused by Ejar UUID in upsertProperty");
    assert.equal(prop.p.name, "برج تجريبي");
    assert.equal(prop.p.propertyType, "building", "mapped by EJAR_PROPERTY_TYPE in upsertProperty");
    assert.equal(prop.p.regionKey, "riyadh");
    assert.equal(prop.raw.property_id, PROPERTY_UUID);
    assert.deepEqual(prop.overrides, { usageLookupId: 2, cityLookupId: 6 }, "usage from the contract type, city from the region; ejar_source stays");

    const unit = (plan.unit as { ejar: any }).ejar;
    assert.deepEqual(unit.units, [{ ejarId: UNIT_UUID, unitNumber: "S-01", unitType: "shop" }]);
    assert.deepEqual(unit.raw[UNIT_UUID], { id: UNIT_UUID, unit_number: "S-01", unit_type: "shop" });
    assert.deepEqual(unit.linkIds, []);
    assert.equal(unit.overrides.status, "rented");

    assert.equal(plan.contract.depositAmount, "6000");
    assert.equal(plan.contract.vatFallback, true);
    assert.equal(plan.contract.status, "active");
    assert.equal(plan.contract.customSchedule.length, 2, "the schedule is still Ejar's invoices");
    assert.equal((plan.contract.ejarRaw as any).lookupSource, "contracts");
  });

  it("the user's input fills gaps but never overrides what Ejar said", async () => {
    const list = contractsFor(CN);
    list.data[0].attributes.units[0].unit_type = "spaceship";
    list.data[0].attributes.tenants[0].id_number = null;
    await seed(list);
    const { body: err } = await httpError(svc.import(USER, { contract_number: CN }));
    assert.deepEqual([...err.missing].sort(), ["tenant.idNumber", "unit.unitTypeId"]);
    await svc.import(USER, {
      contract_number: CN,
      landlord: { idNumber: "1999999999", phone: "0599999999" },
      tenant: { idNumber: "2000000002" },
      property: { new: { name: "اسم آخر", district: "حي تجريبي" } },
      unit: { new: { unitTypeId: 5 } },
    });
    const plan = runner.plans[0];
    assert.equal((plan.tenant as { party: any }).party.idNumber, "2000000002", "a gap Ejar left is filled");
    assert.equal((plan.landlord as { party: any }).party.phone, "500000001", "Ejar's phone stands");
    const prop = (plan.property as { create: any }).create;
    assert.equal(prop.p.name, "برج تجريبي", "Ejar's name stands");
    assert.equal(prop.p.district, "حي تجريبي", "a field Ejar does not have is filled");
    assert.equal((plan.unit as { ejar: any }).ejar.overrides.typeLookupId, 5);
  });

  it("an existing property with the same unit number links that unit instead of duplicating it", async () => {
    await seed();
    w.store.properties.push({ id: 31, accountId: 1, ownerId: null, usageLookupId: 2 });
    w.store.units.push({ id: 41, propertyId: 31, unitNumber: "S-01", usageLookupId: null });
    await svc.import(USER, { contract_number: CN, property: { existingId: 31 } });
    const plan = runner.plans[0];
    assert.deepEqual(plan.property, { existingId: 31 });
    assert.deepEqual((plan.unit as { ejar: any }).ejar.linkIds, [41]);
    assert.deepEqual((plan.unit as { ejar: any }).ejar.units, []);
  });

  it("a property and unit already in the account (by Ejar UUID) need nothing", async () => {
    await seed();
    w.store.properties.push({ id: 31, accountId: 1, ownerId: null, usageLookupId: 2, ejarId: PROPERTY_UUID, name: "x" });
    w.store.units.push({ id: 41, propertyId: 31, unitNumber: "S-01", usageLookupId: null, ejarId: UNIT_UUID });
    await svc.import(USER, { contract_number: CN });
    const unit = (runner.plans[0].unit as { ejar: any }).ejar;
    assert.equal(unit.units.length, 1, "upsertUnits finds it by Ejar UUID under the property");
    assert.deepEqual(unit.linkIds, []);
  });

  it("a landlord existingId is refused here too, even for the account's own record", async () => {
    await seed();
    w.store.owners.push({ id: 12, accountId: 1, name: "مؤجر", idNumber: "1010000002" });
    const { status, body } = await httpError(svc.import(USER, { contract_number: CN, landlord: { existingId: 12 } }));
    assert.equal(status, 400);
    assert.equal(body.key, "landlord.existingId");
  });
});

test("legacy mapper: a party list of only representatives does not file someone as their own agent", () => {
  // Kept from the pre-v2 import: ejar.map is still the reader of the
  // GetRentalContracts shape. 5 of 2120 UAT contracts list lessors with no
  // plain `lessor` role; there the representative IS the only party.
  const raw = JSON.parse(JSON.stringify(fixture("contract-with-representatives"))) as JsonApiResource;
  const attrs = raw.attributes as Record<string, unknown>;
  attrs.lessors = (attrs.lessors as Array<Record<string, unknown>>).filter((l) => l.role === "lessor_representative");
  const p = mapEjarToContract({ contract: raw, propertiesBody: fixture("properties") as EjarBody, unitsBody: fixture("units") as EjarBody });
  assert.equal(p.parties.lessors.length, 1);
  assert.equal(p.parties.lessors[0].isRepresentative, true);
  assert.equal(p.contract.landlordName, p.parties.lessors[0].name);
});

/* ── Against a real database, always rolled back ── */

const HAS_DB = !!process.env.DATABASE_URL;
class Rollback extends Error {}
async function inRollback<T>(fn: (tx: never) => Promise<T>): Promise<T> {
  let out!: T;
  try {
    await db.transaction(async (tx) => { out = await fn(tx as never); throw new Rollback(); });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

describe("POST /ejar/import (database, rolled back)", { skip: !HAS_DB && "DATABASE_URL not set" }, () => {
  let userId = 0;
  before(async () => {
    const [u] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
    userId = u?.id ?? 0;
  });
  after(async () => { await getPool().end(); });

  const lookupId = async (tx: typeof db, category: string, key?: string) =>
    (await tx.select({ id: lookupsTable.id }).from(lookupsTable)
      .where(key ? and(eq(lookupsTable.category, category), eq(lookupsTable.key, key)) : eq(lookupsTable.category, category))
      .limit(1))[0]?.id;

  it("writes the whole hierarchy and the Ejar schedule", async () => {
    assert.ok(userId, "needs at least one user row");
    const n = "10000000777";
    const out = await inRollback(async (tx) => {
      const t = tx as never as typeof db;
      const store = new DrizzleEjarLookupStore(t as never);
      store.getLookup = async () => ({
        id: 1, accountId: userId, contractNumber: n, ejarUuid: UUID, invoicesBody: invoicesFor(n), detailsBody: detailsFor(n),
        lookedUpBy: userId, createdAt: new Date(),
      });
      store.findImported = async () => null;
      store.scope = async () => ({ locked: false, idNumber: null });
      const svc = new EjarImportService(store, new EjarImportRunner(t as never));
      const res = await svc.import({ id: userId } as never, {
        contract_number: n, landlord: {}, tenant: {},
        property: { new: {
          name: "TEST-EJAR-V2", propertyTypeId: await lookupId(t, "property_type"),
          usageId: await lookupId(t, "property_usage", "commercial"), city: await lookupId(t, "city"),
        } },
        unit: { new: { unitNumber: "TEST-1", unitTypeId: await lookupId(t, "unit_type") } },
      });
      const one = async (table: any, id: number | null) => (id ? (await t.select().from(table).where(eq(table.id, id)).limit(1))[0] : null);
      return {
        res,
        contract: await one(contractsTable, res.contractId) as any,
        property: await one(propertiesTable, res.propertyId) as any,
        unit: await one(unitsTable, res.unitIds[0]) as any,
        landlord: await one(ownersTable, res.landlordId) as any,
        tenant: await one(tenantsTable, res.tenantId) as any,
        links: await t.select().from(contractUnitsTable).where(eq(contractUnitsTable.contractId, res.contractId)),
        payments: await t.select().from(paymentsTable).where(eq(paymentsTable.contractId, res.contractId)),
      };
    });
    assert.ok(out.res.created.includes("contract"));
    assert.equal(out.landlord.idNumber, "1010000002");
    assert.equal(out.landlord.type, "company");
    assert.equal(out.landlord.ejarSource, "ejar");
    assert.equal(out.tenant.nationalId, "1010000001");
    assert.equal(out.property.name, "TEST-EJAR-V2");
    assert.equal(out.property.ejarSource, null, "typed in by the user, so nothing locks");
    assert.equal(out.property.ownerId, out.landlord.id, "the wizard reads the landlord from the property");
    assert.equal(out.unit.unitNumber, "TEST-1");
    assert.equal(out.links.length, 1);
    assert.equal(out.contract.ejarSource, "ejar");
    assert.equal(out.contract.paymentFrequency, "custom");
    assert.equal(out.contract.vatEnabled, true);
    assert.equal(String(out.contract.depositAmount), "6000.00");
    assert.equal(out.contract.tenantName, "شركة تجريبية للقهوة");
    assert.equal(out.contract.landlordRepName, "محمد تجريبي");
    const rent = out.payments.filter((p: any) => String(p.description ?? "").startsWith("فاتورة إيجار"));
    assert.equal(out.payments.length, 2, "one installment per Ejar invoice");
    assert.equal(rent.length, 2, "both carry the Ejar invoice identity");
  });

  it("from a Get Contracts snapshot: property, unit and parties from Ejar, locked as Ejar data; re-import reuses them", async () => {
    assert.ok(userId, "needs at least one user row");
    const out = await inRollback(async (tx) => {
      const t = tx as never as typeof db;
      const store = new DrizzleEjarLookupStore(t as never);
      const snap = (n: string) => ({
        id: 1, accountId: userId, contractNumber: n, ejarUuid: UUID, invoicesBody: invoicesFor(n), detailsBody: null,
        contractsBody: (() => { const b = contractsFor(n); return b; })(), lookedUpBy: userId, createdAt: new Date(),
      });
      store.findImported = async () => null;
      store.scope = async () => ({ locked: false, idNumber: null });
      const svc = new EjarImportService(store, new EjarImportRunner(t as never));
      store.getLookup = async (_a, n) => snap(n);
      const first = await svc.import({ id: userId } as never, { contract_number: "10000000881" });
      const second = await svc.import({ id: userId } as never, { contract_number: "10000000882" });
      const one = async (table: any, id: number | null) => (id ? (await t.select().from(table).where(eq(table.id, id)).limit(1))[0] : null);
      return {
        first, second,
        property: await one(propertiesTable, first.propertyId) as any,
        unit: await one(unitsTable, first.unitIds[0]) as any,
        landlord: await one(ownersTable, first.landlordId) as any,
        tenant: await one(tenantsTable, first.tenantId) as any,
        contract: await one(contractsTable, first.contractId) as any,
        payments: await t.select().from(paymentsTable).where(eq(paymentsTable.contractId, first.contractId)),
      };
    });
    assert.equal(out.property.ejarId, PROPERTY_UUID);
    assert.equal(out.property.name, "برج تجريبي");
    assert.equal(out.property.ejarSource, "ejar");
    assert.ok(out.property.typeLookupId, "building → apartment_building lookup");
    assert.ok(out.property.usageLookupId, "commercial contract → commercial usage");
    assert.ok(out.property.cityLookupId, "region riyadh → city riyadh");
    assert.ok(String(out.property.mapUrl).includes("24.7,46.6"));
    assert.equal(out.property.ownerId, out.landlord.id);
    assert.equal(out.unit.ejarId, UNIT_UUID);
    assert.equal(out.unit.unitNumber, "S-01");
    assert.ok(out.unit.typeLookupId, "shop → unit_type shop");
    assert.equal(out.landlord.idNumber, "1010000002");
    assert.equal(out.landlord.type, "company");
    assert.equal(out.landlord.taxNumber, "300000000000003");
    assert.equal(out.landlord.phone, "500000001");
    assert.equal(out.landlord.originalOwnerIdNumber, "1000000003", "the representative, with Ejar's ID");
    assert.equal(out.tenant.nationalId, "1000000004");
    assert.equal(out.tenant.email, "tenant@example.invalid");
    assert.equal(out.contract.tenantIdNumber, "1000000004");
    assert.equal(out.contract.vatEnabled, true);
    assert.equal(String(out.contract.depositAmount), "6000.00");
    assert.equal(out.payments.length, 2);
    // The second contract on the same Ejar property/unit/parties reuses all of them.
    assert.equal(out.second.propertyId, out.first.propertyId);
    assert.deepEqual(out.second.unitIds, out.first.unitIds);
    assert.equal(out.second.landlordId, out.first.landlordId);
    assert.equal(out.second.tenantId, out.first.tenantId);
    assert.deepEqual(out.second.created, ["contract"]);
  });
});
