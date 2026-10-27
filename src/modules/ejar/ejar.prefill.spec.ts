/**
 * "Import all things": whatever Get Contracts returned flows into the review
 * prefilled (or is not asked at all) and into the imported records — even when
 * the client sends blanks.
 *
 * Two shapes, both with invented data (same structure as the anonymized
 * staging seeds 20498373268 / 20499000017):
 *  - A: organization lessor and tenant, each with an individual representative
 *    who carries the phone/email (`lookup-contracts-prod.json`, plaza + shop).
 *  - B: an individual lessor with her own phone/email; an organization tenant
 *    with neither and no representative (building + apartment, residential).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { STG, world, baladyOk, baladyErr, fixture } from "./__tests__/lookup-harness";
import { bareSaudiMobile, computePrefill, computeRequired, mapLookup, partyContact } from "./ejar.lookup.map";
import { EjarImportService, type EjarImportRunnerLike } from "./ejar.import.service";
import type { ImportPlan, ImportResult } from "./ejar.import.writer";

const A = "20000000001";
const A_UUID = "22222222-3333-4444-8555-666666666666";
const B = "20000000002";
const B_UUID = "33333333-4444-4555-8666-777777777777";
const USER = { id: 1 } as never;

/** Shape B: the A body re-cut as a residential building with an individual lessor. */
function contractsB() {
  const body = fixture("lookup-contracts-prod") as any;
  const a = body.data[0].attributes;
  body.data[0].id = B_UUID;
  Object.assign(a, {
    contract_id: B_UUID, contract_number: B, contract_type: "residential",
    property_type: "building", property_name: "عمارة تجريبية سكنية", company_cr_number: null,
    units: [{ id: "33333333-4444-4555-8666-888888888888", unit_type: "apartment", unit_number: "A-12" }],
    lessors: [{
      vat: 0, name: "مؤجرة تجريبية", role: "lessor", type: "individual", email: "Lessor-B@Example.invalid",
      id_type: "national_id", id_number: "1000000201", phone_number: "+966500000201",
    }],
    tenants: [{
      vat: 0, name: "شركة مستأجرة تجريبية", type: "organization", unified_number: "7009990202",
      organization_type: "commercial", registration_number: "1010999202",
    }],
  });
  return body;
}
function invoicesB() {
  const body = JSON.parse(JSON.stringify(fixture("lookup-invoices-prod")).replaceAll(A_UUID, B_UUID).replaceAll(A, B));
  return body;
}

function twoContractWorld() {
  const w = world();
  w.store.lookupRows.push(
    { id: 8, category: "property_type", key: "plaza" },
    { id: 9, category: "unit_type", key: "apartment" },
  );
  w.setRespond((url) => {
    if (url === `${STG}/v1/ejar-services/contracts/${A}/invoices`) return baladyOk(fixture("lookup-invoices-prod"));
    if (url === `${STG}/v1/ejar-services/contracts/${B}/invoices`) return baladyOk(invoicesB());
    const list = url.match(/\/v1\/ejar-services\/contracts\?(.*)$/);
    const id = list ? new URLSearchParams(list[1]).get("contract_ids") : null;
    if (id === A_UUID) return baladyOk(fixture("lookup-contracts-prod"));
    if (id === B_UUID) return baladyOk(contractsB());
    if (/\/invoices$/.test(url)) return baladyErr(400, "E1.11", "رقم العقد غير صحيح");
    throw new Error(`unexpected fetch ${url}`);
  });
  return w;
}

class RecordingRunner implements EjarImportRunnerLike {
  plans: ImportPlan[] = [];
  async run(_ownerId: number, plan: ImportPlan): Promise<ImportResult> {
    this.plans.push(plan);
    return { contractId: 900, propertyId: 1, unitIds: [1], landlordId: 1, deedId: null, tenantId: 1, installmentsCreated: 1, created: ["contract"], linked: [] };
  }
}

let w: ReturnType<typeof twoContractWorld>;
afterEach(() => w?.restore());

describe("bareSaudiMobile / partyContact", () => {
  it("normalises every spelling Ejar uses to 5XXXXXXXX, and leaves a foreign number as sent", () => {
    for (const v of ["+966500000101", "966500000101", "00966500000101", "0500000101", "500000101", "٠٥٠٠٠٠٠١٠١"]) {
      assert.equal(bareSaudiMobile(v), "500000101", v);
    }
    assert.equal(bareSaudiMobile("+447700900123"), "+447700900123");
    assert.equal(bareSaudiMobile(null), null);
    assert.equal(bareSaudiMobile("  "), null);
  });

  it("an organization takes its representative's contact; an individual keeps only its own", () => {
    const a = mapLookup(fixture("lookup-invoices-prod"), null, fixture("lookup-contracts-prod"), A);
    assert.deepEqual(partyContact(a.parties, "landlord"), {
      phone: "500000101", email: "lessor-rep@example.invalid", from: { phone: "representative", email: "representative" },
    });
    assert.equal(partyContact(a.parties, "tenant").phone, "500000102");

    const b = mapLookup(invoicesB(), null, contractsB(), B);
    assert.deepEqual(partyContact(b.parties, "landlord"), {
      phone: "500000201", email: "lessor-b@example.invalid", from: { phone: "party", email: "party" },
    });
    assert.deepEqual(partyContact(b.parties, "tenant"), { phone: null, email: null, from: { phone: null, email: null } });
  });
});

describe("required[] asks only for what Ejar never sends", () => {
  const resolved = { propertyTypeId: 8, usageId: 2, cityId: 6, unitTypeIds: [5] };

  it("A: no property name/type/usage/city and no unit keys; contact offered prefilled from the representative", () => {
    const m = mapLookup(fixture("lookup-invoices-prod"), null, fixture("lookup-contracts-prod"), A);
    const req = computeRequired(m, { resolved });
    assert.deepEqual(req.filter((r) => r.required), []);
    assert.deepEqual(req.filter((r) => r.section === "property").map((r) => r.key),
      ["property.district", "property.address", "property.deedNumber", "property.deedType"]);
    assert.deepEqual(req.filter((r) => r.section === "unit"), []);
    const phone = req.find((r) => r.key === "landlord.phone");
    assert.equal(phone?.required, false);
    assert.match(phone!.reason, /representative/);

    const pf = computePrefill(m, resolved, "الرياض");
    assert.deepEqual(pf.property, { name: "مجمع النخيل التجاري", propertyTypeId: 8, usageId: 2, cityId: 6, city: "الرياض" });
    assert.deepEqual(pf.unit, { unitNumber: "SH-01", unitTypeId: 5, usageId: 2, floor: null, area: null, rooms: null });
    assert.equal(pf.landlord.phone, "500000101");
    assert.equal(pf.tenant.email, "tenant-rep@example.invalid");
  });

  it("B: the lessor's own phone/email are not asked; the tenant's (Ejar sent none) stay optional and empty", () => {
    const m = mapLookup(invoicesB(), null, contractsB(), B);
    const req = computeRequired(m, { resolved: { propertyTypeId: 1, usageId: 7, cityId: 6, unitTypeIds: [9] } });
    assert.ok(!req.some((r) => r.key === "landlord.phone" || r.key === "landlord.email"));
    assert.deepEqual(req.filter((r) => r.section === "tenant").map((r) => [r.key, r.required]), [["tenant.phone", false], ["tenant.email", false]]);
    const pf = computePrefill(m, { propertyTypeId: 1, usageId: 7, cityId: 6, unitTypeIds: [9] }, "الرياض");
    assert.equal(pf.tenant.phone, null);
    assert.equal(pf.unit?.unitTypeId, 9);
  });

  it("an Ejar value that does not resolve is still asked (required, empty)", () => {
    const m = mapLookup(fixture("lookup-invoices-prod"), null, fixture("lookup-contracts-prod"), A);
    const req = computeRequired(m, { resolved: { propertyTypeId: null, usageId: 2, cityId: null, unitTypeIds: [null] } });
    assert.deepEqual(req.filter((r) => r.required).map((r) => r.key).sort(), ["property.city", "property.propertyTypeId", "unit.unitTypeId"]);
    assert.equal(computePrefill(m, { propertyTypeId: null, usageId: 2, cityId: null, unitTypeIds: [null] }).property.city, null);
  });
});

describe("the lookup response carries the prefill; the import fills every record from Ejar", () => {
  it("A: lookup → prefill in option ids and the city label", async () => {
    w = twoContractWorld();
    const res = await w.svc.lookup(USER, { contract_number: A });
    assert.deepEqual(res.prefill.property, { name: "مجمع النخيل التجاري", propertyTypeId: 8, usageId: 2, cityId: 6, city: "الرياض" });
    assert.equal(res.prefill.unit?.unitTypeId, 5);
    assert.deepEqual(res.required.filter((r) => r.required), []);
  });

  it("A: blanks from the client never override Ejar; org contact comes from the representative; unit usage = property usage", async () => {
    w = twoContractWorld();
    await w.svc.lookup(USER, { contract_number: A });
    const runner = new RecordingRunner();
    await new EjarImportService(w.store, runner).import(USER, {
      contract_number: A,
      landlord: { phone: "", email: "" },
      tenant: { phone: "", email: "" },
      property: { new: { name: "", propertyTypeId: "", usageId: "", city: "", district: "", address: "", deedNumber: "", deedType: "" } },
      unit: { new: { unitNumber: "", unitTypeId: "", usageId: "", floor: "", area: "" } },
    });
    const plan = runner.plans[0];
    const prop = (plan.property as { create: any }).create;
    assert.equal(prop.p.name, "مجمع النخيل التجاري");
    assert.equal(prop.p.propertyType, "plaza");
    assert.equal(prop.overrides.usageLookupId, 2, "commercial, from the contract type");
    assert.equal(prop.overrides.cityLookupId, 6, "Riyadh, from the region");
    assert.equal(prop.deed, null, "no deed number typed, none from Ejar");
    const unit = (plan.unit as { ejar: any }).ejar;
    assert.deepEqual(unit.units.map((u: any) => [u.unitNumber, u.unitType]), [["SH-01", "shop"]]);
    assert.equal(unit.overrides.usageLookupId, 2);
    const ll = (plan.landlord as { party: any }).party;
    assert.equal(ll.phone, "500000101");
    assert.equal(ll.email, "lessor-rep@example.invalid");
    const tn = (plan.tenant as { party: any }).party;
    assert.equal(tn.phone, "500000102");
    assert.equal(tn.email, "tenant-rep@example.invalid");
  });

  it("B: the individual lessor's own contact; a typed tenant contact is used; the residential usage reaches the unit", async () => {
    w = twoContractWorld();
    const res = await w.svc.lookup(USER, { contract_number: B });
    assert.deepEqual(res.prefill.property, { name: "عمارة تجريبية سكنية", propertyTypeId: 1, usageId: 7, cityId: 6, city: "الرياض" });
    assert.deepEqual(res.prefill.unit, { unitNumber: "A-12", unitTypeId: 9, usageId: 7, floor: null, area: null, rooms: null });
    const runner = new RecordingRunner();
    await new EjarImportService(w.store, runner).import(USER, {
      contract_number: B,
      landlord: { phone: "0599999999" }, // Ejar's own value wins
      tenant: { phone: "0512345678", email: "ops@example.invalid" },
      property: { new: { district: "النرجس", deedNumber: "310000000001", deedType: "electronic" } },
    });
    const plan = runner.plans[0];
    const ll = (plan.landlord as { party: any }).party;
    assert.equal(ll.idNumber, "1000000201");
    assert.equal(ll.phone, "500000201");
    assert.equal(ll.email, "lessor-b@example.invalid");
    const tn = (plan.tenant as { party: any }).party;
    assert.equal(tn.registrationNumber, "1010999202");
    assert.equal(tn.phone, "512345678");
    assert.equal(tn.email, "ops@example.invalid");
    const prop = (plan.property as { create: any }).create;
    assert.equal(prop.p.name, "عمارة تجريبية سكنية");
    assert.equal(prop.p.propertyType, "building");
    assert.equal(prop.p.district, "النرجس");
    assert.deepEqual(prop.deed, { deedNumber: "310000000001", deedType: "electronic" });
    assert.equal(prop.overrides.usageLookupId, 7);
    assert.equal(prop.overrides.cityLookupId, 6);
    assert.equal((plan.unit as { ejar: any }).ejar.overrides.usageLookupId, 7);
    assert.equal(plan.contract.vatFallback, false, "residential: exempt");
  });
});
