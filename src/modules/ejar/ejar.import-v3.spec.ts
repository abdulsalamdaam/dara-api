/**
 * Ejar Import v3 — the production Get Contracts shape, mapped into the import,
 * and the landlord CR at the inquiry.
 *
 * `lookup-contracts-prod.json` mirrors, key for key and type for type, the
 * Get Contracts body production Balady returned on 27 Oct 2026 (plaza, one
 * shop, an organization lessor with an individual representative, the same
 * for the tenant, bi-annual, auto-renewing). Every value in it is invented —
 * names, CRs, IDs, phones, UUIDs — except the coordinates, region and
 * amounts, which carry no personal data.
 *
 * The CR rules (plan-features.ts ejarLandlordCrRule):
 *  - عقاري (basic): landlord_cr required; it must match a lessor (CR, unified
 *    number or national ID) or the contract's company_cr_number. Missing or
 *    malformed is refused before any call; a mismatch is refused after the
 *    calls (they were spent and count) and nothing is saved.
 *  - Offices / Companies: optional — contract number alone; a CR sent anyway
 *    is checked the same way.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { STG, world, httpError, baladyOk, baladyErr, fixture } from "./__tests__/lookup-harness";
import { mapLookup, landlordCrMatches, lessorIdentifiers } from "./ejar.lookup.map";
import { EjarImportService, type EjarImportRunnerLike } from "./ejar.import.service";
import type { ImportPlan, ImportResult } from "./ejar.import.writer";
import { ejarLandlordCrRule } from "../../common/plan-features";

const N = "20000000001";
const U = "22222222-3333-4444-8555-666666666666";
const PROP = "22222222-3333-4444-8555-777777777777";
const UNIT = "22222222-3333-4444-8555-888888888888";
const LESSOR_CR = "1010999001";
const LESSOR_UNIFIED = "7009990001";
const COMPANY_CR = "2050999003";
const TENANT_CR = "1010999002";
const LESSOR_REP_ID = "1000000101";
const WRONG_CR = "1010999999";

const USER = { id: 1 } as never;
const DAY = 86_400_000;
const period = (packagePlan: string) => ({
  packagePlan, billingCycle: "yearly",
  subscriptionStartedAt: new Date(Date.now() - DAY), subscriptionEndsAt: new Date(Date.now() + 300 * DAY),
});

/** A Balady staging world that knows contract N in the production shape. */
function prodWorld() {
  const w = world();
  w.store.lookupRows.push({ id: 8, category: "property_type", key: "plaza" });
  w.setRespond((url) => {
    if (url === `${STG}/v1/ejar-services/contracts/${N}/invoices`) return baladyOk(fixture("lookup-invoices-prod"));
    const list = url.match(/\/v1\/ejar-services\/contracts\?(.*)$/);
    if (list && new URLSearchParams(list[1]).get("contract_ids") === U) return baladyOk(fixture("lookup-contracts-prod"));
    if (/\/invoices$/.test(url)) return baladyErr(400, "E1.11", "رقم العقد غير صحيح");
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

let w: ReturnType<typeof prodWorld>;
afterEach(() => w?.restore());

describe("mapping the production Get Contracts shape", () => {
  const m = () => mapLookup(fixture("lookup-invoices-prod"), null, fixture("lookup-contracts-prod"), N);

  it("property: name, type, Ejar id, region, unit count and the exact coordinates", () => {
    assert.deepEqual(m().property, {
      ejarId: PROP,
      name: "مجمع النخيل التجاري",
      type: "plaza",
      region: { key: "riyadh", nameAr: "الرياض", nameEn: "Riyadh" },
      latitude: 24.93113797,
      longitude: 46.64426996,
      mapsUrl: "https://www.google.com/maps?q=24.93113797,46.64426996",
      unitCount: 1,
    });
  });

  it("units: every field of units[], verbatim in raw", () => {
    assert.deepEqual(m().units, [{
      ejarId: UNIT, unitNumber: "SH-01", unitType: "shop", floor: null, area: null, rooms: null, usage: null,
      raw: { id: UNIT, unit_type: "shop", unit_number: "SH-01" },
    }]);
  });

  it("lessors: the organization (no role key) is the lessor, the individual its representative", () => {
    const { lessor, lessorRepresentative } = m().parties;
    assert.equal(lessor?.role, "lessor");
    assert.equal(lessor?.kind, "organization");
    assert.equal(lessor?.name, "شركة المؤجر التجريبية");
    assert.equal(lessor?.crNumber, LESSOR_CR);
    assert.equal(lessor?.unifiedNumber, LESSOR_UNIFIED);
    assert.equal(lessor?.organizationType, "commercial");
    assert.equal(lessorRepresentative?.kind, "individual");
    assert.equal(lessorRepresentative?.idType, "national_id");
    assert.equal(lessorRepresentative?.idNumber, LESSOR_REP_ID);
    assert.equal(lessorRepresentative?.phone, "+966500000101");
    assert.equal(lessorRepresentative?.email, "lessor-rep@example.invalid");
    assert.equal(lessorRepresentative?.vatNumber, null, "vat: 0 is not a VAT number");
  });

  it("tenants: the organization and its representative", () => {
    const { tenant, tenantRepresentative, others } = m().parties;
    assert.equal(tenant?.kind, "organization");
    assert.equal(tenant?.crNumber, TENANT_CR);
    assert.equal(tenant?.unifiedNumber, "7009990002");
    assert.equal(tenantRepresentative?.idNumber, "1000000102");
    assert.equal(tenantRepresentative?.phone, "+966500000102");
    assert.deepEqual(others, []);
  });

  it("contract: type, dates, value, frequency, deposit, Ejar fee, renewal, sublease, unified number, broker", () => {
    const c = m().contract;
    assert.equal(c.source, "contracts");
    assert.equal(c.ejarId, U);
    assert.equal(c.contractNumber, N);
    assert.equal(c.contractType, "commercial");
    assert.equal(c.status, "registered");
    assert.equal(c.startDate, "2026-11-16");
    assert.equal(c.endDate, "2029-11-15");
    assert.equal(c.registeredAt, "2026-07-30");
    assert.equal(c.totalValue, 238125);
    assert.equal(c.paymentFrequency, "bi-annual");
    assert.equal(c.securityDeposit, 6350);
    assert.equal(c.ejarFee, 1000);
    assert.equal(c.autoRenewal, true);
    assert.equal(c.subleaseAllowed, false);
    assert.equal(c.unifiedNumber, "7009990003");
    assert.equal(c.companyCrNumber, COMPANY_CR);
    assert.equal(c.periodDays, 1095);
    assert.equal(c.daysRemaining, 1116);
    assert.equal(c.installmentValue, null);
    assert.deepEqual(c.broker, { name: "وسيط عقاري تجريبي", nationalId: "1000000091" });
  });

  it("installments come from the Invoices schedule", () => {
    const { invoices, financial } = m();
    assert.equal(invoices.length, 6);
    assert.deepEqual(invoices.map((i) => i.dueDate), ["2026-11-26", "2027-05-26", "2027-11-26", "2028-05-26", "2028-11-26", "2029-05-26"]);
    assert.equal(financial.invoiceTotal, 238122);
    assert.equal(financial.recurringPayment?.en, "Bi-Annual");
  });

  it("lessor identifiers: lessor CR, unified number and company_cr_number — never a representative or the tenant", () => {
    const ids = lessorIdentifiers(m());
    assert.deepEqual([...ids].sort(), [LESSOR_CR, COMPANY_CR, LESSOR_UNIFIED].sort());
    assert.equal(landlordCrMatches(m(), LESSOR_CR), true);
    assert.equal(landlordCrMatches(m(), "١٠١٠٩٩٩٠٠١"), true, "Arabic-Indic digits");
    assert.equal(landlordCrMatches(m(), COMPANY_CR), true);
    assert.equal(landlordCrMatches(m(), LESSOR_REP_ID), false);
    assert.equal(landlordCrMatches(m(), TENANT_CR), false);
    assert.equal(landlordCrMatches(m(), ""), false);
  });

  it("an individual lessor matches on the national ID", () => {
    const list = fixture("lookup-contracts-prod");
    list.data[0].attributes.lessors = [{ vat: 0, name: "فرد تجريبي", role: "lessor", type: "individual", id_type: "national_id", id_number: "1077700002" }];
    list.data[0].attributes.company_cr_number = null;
    const mm = mapLookup(fixture("lookup-invoices-prod"), null, list, N);
    assert.equal(landlordCrMatches(mm, "1077700002"), true);
    assert.equal(landlordCrMatches(mm, LESSOR_CR), false);
  });
});

describe("the import from the production shape", () => {
  it("carries the location, the property/unit raw, the parties and every contract term into the plan", async () => {
    w = prodWorld();
    await w.svc.lookup(USER, { contract_number: N });
    const calls = w.calls.length;
    const runner = new RecordingRunner();
    await new EjarImportService(w.store, runner).import(USER, { contract_number: N });
    assert.equal(w.calls.length, calls, "the import never calls Ejar");
    const plan = runner.plans[0];

    const prop = (plan.property as { create: any }).create;
    assert.equal(prop.p.latitude, 24.93113797);
    assert.equal(prop.p.longitude, 46.64426996, "the writer turns these into map_url ?q=LAT,LNG");
    assert.equal(prop.p.name, "مجمع النخيل التجاري");
    assert.equal(prop.p.propertyType, "plaza");
    assert.equal(prop.p.regionKey, "riyadh");
    assert.equal(prop.p.ejarId, PROP);
    assert.equal(prop.raw.unit_count, 1);
    assert.equal(prop.raw.latitude, 24.93113797);

    const unit = (plan.unit as { ejar: any }).ejar;
    assert.deepEqual(unit.units, [{ ejarId: UNIT, unitNumber: "SH-01", unitType: "shop", floor: null, area: null, rooms: null, unitUsage: null }]);
    assert.deepEqual(unit.raw[UNIT], { id: UNIT, unit_type: "shop", unit_number: "SH-01" });

    const ll = plan.landlord as { party: any; rep: any };
    assert.equal(ll.party.partyType, "organization");
    assert.equal(ll.party.registrationNumber, LESSOR_CR);
    assert.equal(ll.rep.idNumber, LESSOR_REP_ID);
    assert.equal(ll.rep.phone, "500000101", "canonical phone");
    const tn = plan.tenant as { party: any; rep: any };
    assert.equal(tn.party.registrationNumber, TENANT_CR);
    assert.equal(tn.rep.idNumber, "1000000102");

    const c = plan.contract;
    assert.equal(c.startDate, "2026-11-16");
    assert.equal(c.endDate, "2029-11-15");
    assert.equal(c.depositAmount, "6350");
    assert.equal(c.autoRenewal, true);
    assert.equal(c.subleaseAllowed, false);
    assert.equal(c.ejarFee, "1000");
    assert.equal(c.brokerName, "وسيط عقاري تجريبي");
    assert.equal(c.brokerIdNumber, "1000000091");
    assert.equal(c.vatFallback, true, "commercial → rent VAT when usage cannot decide");
    assert.equal(c.customSchedule.length, 6, "installments are Ejar's invoices");
    assert.equal(c.customSchedule[0].amount, "39687");
    assert.equal(c.ejarRaw?.unifiedNumber, "7009990003");
    assert.equal(c.ejarRaw?.companyCrNumber, COMPANY_CR);
    assert.equal(c.ejarRaw?.periodDays, 1095);
    assert.equal(c.ejarRaw?.totalValue, 238125);
  });
});

describe("the landlord CR at the inquiry", () => {
  it("the plan rule: عقاري requires it, Offices / Companies (and unknown → Offices) do not", () => {
    assert.equal(ejarLandlordCrRule("basic"), "required");
    assert.equal(ejarLandlordCrRule("professional"), "optional");
    assert.equal(ejarLandlordCrRule("enterprise"), "optional");
    assert.equal(ejarLandlordCrRule("broker"), "optional");
    assert.equal(ejarLandlordCrRule(null), "optional");
  });

  it("عقاري without a CR: 400 landlord_cr_required, nothing sent, nothing spent", async () => {
    w = prodWorld();
    w.store.plans[1] = period("basic");
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: N }));
    assert.equal(status, 400);
    assert.equal(body.code, "landlord_cr_required");
    assert.match(body.message, /السجل التجاري/);
    assert.equal(w.calls.length, 0);
  });

  it("عقاري with a malformed CR: 400 landlord_cr_invalid, nothing sent", async () => {
    w = prodWorld();
    w.store.plans[1] = period("basic");
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: N, landlord_cr: "12345" }));
    assert.equal(status, 400);
    assert.equal(body.code, "landlord_cr_invalid");
    assert.equal(w.calls.length, 0);
  });

  it("عقاري with the lessor's CR: the lookup goes through and is saved", async () => {
    w = prodWorld();
    w.store.plans[1] = period("basic");
    const res = await w.svc.lookup(USER, { contract_number: N, landlord_cr: LESSOR_CR });
    assert.deepEqual(res.landlordCr, { rule: "required", matched: true });
    assert.equal(res.property?.latitude, 24.93113797);
    assert.equal(w.store.lookups.size, 1);
  });

  it("عقاري with company_cr_number also matches", async () => {
    w = prodWorld();
    w.store.plans[1] = period("basic");
    const res = await w.svc.lookup(USER, { contract_number: N, landlord_cr: COMPANY_CR });
    assert.equal(res.landlordCr.matched, true);
  });

  it("عقاري with a CR that is not the lessor's: 422 in Arabic, the calls count, nothing saved", async () => {
    w = prodWorld();
    w.store.plans[1] = period("basic");
    const before = (await w.svc.customerBudget(1)).remaining!;
    for (const cr of [WRONG_CR, TENANT_CR, LESSOR_REP_ID]) {
      const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: N, landlord_cr: cr }));
      assert.equal(status, 422, cr);
      assert.equal(body.code, "landlord_cr_mismatch");
      assert.match(body.message, /لا يطابق المؤجر/);
    }
    assert.equal(w.dataCalls().length, 6, "two calls per attempt were sent");
    assert.equal(w.store.lookups.size, 0, "nothing is saved on a mismatch");
    assert.equal((await w.svc.customerBudget(1)).remaining, before - 3, "each spent lookup counts");
  });

  it("a saved lookup (cache) still checks the CR, without a call", async () => {
    w = prodWorld();
    w.store.plans[1] = period("basic");
    await w.svc.lookup(USER, { contract_number: N, landlord_cr: LESSOR_CR });
    const sent = w.calls.length;
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: N, landlord_cr: WRONG_CR }));
    assert.equal(status, 422);
    assert.equal(body.code, "landlord_cr_mismatch");
    const missing = await httpError(w.svc.lookup(USER, { contract_number: N }));
    assert.equal(missing.status, 400);
    const ok = await w.svc.lookup(USER, { contract_number: N, landlord_cr: LESSOR_CR });
    assert.equal(ok.source, "cache");
    assert.equal(w.calls.length, sent, "no call for any of them");
  });

  it("Offices: the contract number alone is enough", async () => {
    w = prodWorld();
    w.store.plans[1] = period("professional");
    const res = await w.svc.lookup(USER, { contract_number: N });
    assert.deepEqual(res.landlordCr, { rule: "optional", matched: null });
    assert.equal(res.parties.lessor?.crNumber, LESSOR_CR);
  });

  it("Offices / Companies: a CR sent anyway is still checked", async () => {
    w = prodWorld();
    w.store.plans[1] = period("enterprise");
    const { status } = await httpError(w.svc.lookup(USER, { contract_number: N, landlord_cr: WRONG_CR }));
    assert.equal(status, 422);
    const res = await w.svc.lookup(USER, { contract_number: N, landlord_cr: LESSOR_UNIFIED });
    assert.equal(res.landlordCr.matched, true);
  });

  it("the import re-checks it on عقاري: missing 400, wrong 422, right imports", async () => {
    w = prodWorld();
    w.store.plans[1] = period("basic");
    await w.svc.lookup(USER, { contract_number: N, landlord_cr: LESSOR_CR });
    const runner = new RecordingRunner();
    const svc = new EjarImportService(w.store, runner);
    const sent = w.calls.length;
    assert.equal((await httpError(svc.import(USER, { contract_number: N }))).body.code, "landlord_cr_required");
    const wrong = await httpError(svc.import(USER, { contract_number: N, landlord_cr: WRONG_CR }));
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.code, "landlord_cr_mismatch");
    assert.equal(runner.plans.length, 0, "nothing written");
    await svc.import(USER, { contract_number: N, landlord_cr: LESSOR_CR });
    assert.equal(runner.plans.length, 1);
    assert.equal(w.calls.length, sent, "the import never calls Ejar");
  });

  it("the import on Offices needs no CR", async () => {
    w = prodWorld();
    w.store.plans[1] = period("professional");
    await w.svc.lookup(USER, { contract_number: N });
    const runner = new RecordingRunner();
    await new EjarImportService(w.store, runner).import(USER, { contract_number: N });
    assert.equal(runner.plans.length, 1);
  });
});
