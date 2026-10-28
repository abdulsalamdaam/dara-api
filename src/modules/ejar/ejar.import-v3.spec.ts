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
import { mapLookup, partyMatches, lessorIdentifiers, tenantIdentifiers } from "./ejar.lookup.map";
import { EjarImportService, type EjarImportRunnerLike } from "./ejar.import.service";
import type { ImportPlan, ImportResult } from "./ejar.import.writer";
import { ejarPartyRole } from "../../common/plan-features";

const N = "20000000001";
const U = "22222222-3333-4444-8555-666666666666";
const PROP = "22222222-3333-4444-8555-777777777777";
const UNIT = "22222222-3333-4444-8555-888888888888";
const LESSOR_CR = "1010999001";
const LESSOR_UNIFIED = "7009990001";
const COMPANY_CR = "2050999003";
const TENANT_CR = "1010999002";
const LESSOR_REP_ID = "1000000101";
const TENANT_REP_ID = "1000000102";

const USER = { id: 1 } as never;

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
    assert.deepEqual([...lessorIdentifiers(m())].sort(), [LESSOR_CR, COMPANY_CR, LESSOR_UNIFIED].sort());
    assert.equal(partyMatches(m(), "landlord", LESSOR_CR), true);
    assert.equal(partyMatches(m(), "landlord", "١٠١٠٩٩٩٠٠١"), true, "Arabic-Indic digits");
    assert.equal(partyMatches(m(), "landlord", COMPANY_CR), true);
    assert.equal(partyMatches(m(), "landlord", LESSOR_REP_ID), false);
    assert.equal(partyMatches(m(), "landlord", TENANT_CR), false);
    assert.equal(partyMatches(m(), "landlord", ""), false);
  });

  it("tenant identifiers: the tenant's CR and unified number — never its representative, the lessor or company_cr_number", () => {
    assert.deepEqual([...tenantIdentifiers(m())].sort(), [TENANT_CR, "7009990002"].sort());
    assert.equal(partyMatches(m(), "tenant", TENANT_CR), true);
    assert.equal(partyMatches(m(), "tenant", TENANT_REP_ID), false);
    assert.equal(partyMatches(m(), "tenant", LESSOR_CR), false);
    assert.equal(partyMatches(m(), "tenant", COMPANY_CR), false);
  });

  it("an individual lessor matches on the national ID", () => {
    const list = fixture("lookup-contracts-prod");
    list.data[0].attributes.lessors = [{ vat: 0, name: "فرد تجريبي", role: "lessor", type: "individual", id_type: "national_id", id_number: "1077700002" }];
    list.data[0].attributes.company_cr_number = null;
    const mm = mapLookup(fixture("lookup-invoices-prod"), null, list, N);
    assert.equal(partyMatches(mm, "landlord", "1077700002"), true);
    assert.equal(partyMatches(mm, "landlord", LESSOR_CR), false);
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
    // Each 39,687.50 bill less its 3,175 of general services, which import as their own fee (ejar.rent.ts).
    assert.equal(c.customSchedule[0].amount, "36512.5");
    assert.equal(c.ejarRaw?.unifiedNumber, "7009990003");
    assert.equal(c.ejarRaw?.companyCrNumber, COMPANY_CR);
    assert.equal(c.ejarRaw?.periodDays, 1095);
    assert.equal(c.ejarRaw?.totalValue, 238125);
  });
});

describe("the inquiry is pinned to the account's own stored ID (عقاري: its landlord; tenant plan: itself)", () => {
  const pin = (role: "landlord" | "tenant", idNumber: string | null) => { w.store.partyChecks[1] = { role, idNumber }; };

  it("the plan rule: عقاري → landlord, tenant → tenant, Offices / Companies (and unknown → Offices) → none", () => {
    assert.equal(ejarPartyRole("basic"), "landlord");
    assert.equal(ejarPartyRole("tenant"), "tenant");
    assert.equal(ejarPartyRole("professional"), null);
    assert.equal(ejarPartyRole("enterprise"), null);
    assert.equal(ejarPartyRole("broker"), null);
    assert.equal(ejarPartyRole(null), null);
  });

  for (const role of ["landlord", "tenant"] as const) {
    it(`${role}: no ID on the account's record → 409 party_id_missing in Arabic, nothing sent`, async () => {
      w = prodWorld();
      pin(role, null);
      const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: N }));
      assert.equal(status, 409);
      assert.equal(body.code, "party_id_missing");
      assert.equal(body.role, role);
      assert.match(body.message, /أكمل بيانات/);
      assert.equal(w.calls.length, 0);
    });
  }

  it("landlord: the stored lessor CR matches — the lookup goes through and is saved", async () => {
    w = prodWorld();
    pin("landlord", LESSOR_CR);
    const res = await w.svc.lookup(USER, { contract_number: N });
    assert.deepEqual(res.partyCheck, { role: "landlord", idNumber: LESSOR_CR, matched: true });
    assert.equal(res.property?.latitude, 24.93113797);
    assert.equal(w.store.lookups.size, 1);
  });

  it("landlord: company_cr_number also matches", async () => {
    w = prodWorld();
    pin("landlord", COMPANY_CR);
    assert.equal((await w.svc.lookup(USER, { contract_number: N })).partyCheck.matched, true);
  });

  it("a client-sent CR is ignored: only the stored record counts", async () => {
    w = prodWorld();
    pin("landlord", TENANT_CR);
    const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: N, landlord_cr: LESSOR_CR } as never));
    assert.equal(status, 422);
    assert.equal(body.code, "party_mismatch");
  });

  it("landlord: not the lessor → 422 in Arabic, the calls count, nothing saved", async () => {
    w = prodWorld();
    w.store.plans[1] = { packagePlan: "basic", billingCycle: "yearly", subscriptionStartedAt: new Date(Date.now() - 86_400_000), subscriptionEndsAt: new Date(Date.now() + 300 * 86_400_000) };
    const before = (await w.svc.customerBudget(1)).remaining!;
    for (const id of [TENANT_CR, LESSOR_REP_ID, "1010999999"]) {
      pin("landlord", id);
      const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: N }));
      assert.equal(status, 422, id);
      assert.equal(body.code, "party_mismatch");
      assert.equal(body.role, "landlord");
      assert.match(body.message, /لا يخص المؤجر/);
    }
    assert.equal(w.dataCalls().length, 6, "two calls per attempt were sent");
    assert.equal(w.store.lookups.size, 0, "nothing is saved on a mismatch");
    assert.equal((await w.svc.customerBudget(1)).remaining, before - 3, "each spent lookup counts");
  });

  it("tenant: the stored CR is the contract's tenant → through", async () => {
    w = prodWorld();
    pin("tenant", TENANT_CR);
    const res = await w.svc.lookup(USER, { contract_number: N });
    assert.deepEqual(res.partyCheck, { role: "tenant", idNumber: TENANT_CR, matched: true });
  });

  it("tenant: the lessor's CR, or the tenant's representative, is not the tenant → 422, nothing saved", async () => {
    w = prodWorld();
    for (const id of [LESSOR_CR, TENANT_REP_ID]) {
      pin("tenant", id);
      const { status, body } = await httpError(w.svc.lookup(USER, { contract_number: N }));
      assert.equal(status, 422);
      assert.equal(body.code, "party_mismatch");
      assert.equal(body.role, "tenant");
      assert.match(body.message, /لا يخصك/);
    }
    assert.equal(w.store.lookups.size, 0);
  });

  it("a saved lookup (cache) is re-checked against the record as it is now, without a call", async () => {
    w = prodWorld();
    pin("landlord", LESSOR_CR);
    await w.svc.lookup(USER, { contract_number: N });
    const sent = w.calls.length;
    pin("landlord", TENANT_CR); // the landlord record was edited
    const { status } = await httpError(w.svc.lookup(USER, { contract_number: N }));
    assert.equal(status, 422);
    pin("landlord", LESSOR_CR);
    assert.equal((await w.svc.lookup(USER, { contract_number: N })).source, "cache");
    assert.equal(w.calls.length, sent, "no call for either");
  });

  it("Offices / Companies: unpinned — the contract number alone", async () => {
    w = prodWorld();
    const res = await w.svc.lookup(USER, { contract_number: N });
    assert.deepEqual(res.partyCheck, { role: null, idNumber: null, matched: null });
  });

  it("the import re-checks the stored record: missing 409, changed 422, right imports", async () => {
    w = prodWorld();
    pin("landlord", LESSOR_CR);
    await w.svc.lookup(USER, { contract_number: N });
    const runner = new RecordingRunner();
    const svc = new EjarImportService(w.store, runner);
    const sent = w.calls.length;
    pin("landlord", null);
    assert.equal((await httpError(svc.import(USER, { contract_number: N }))).body.code, "party_id_missing");
    pin("landlord", TENANT_CR);
    const wrong = await httpError(svc.import(USER, { contract_number: N }));
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.code, "party_mismatch");
    assert.equal(runner.plans.length, 0, "nothing written");
    pin("landlord", LESSOR_CR);
    await svc.import(USER, { contract_number: N });
    assert.equal(runner.plans.length, 1);
    assert.equal(w.calls.length, sent, "the import never calls Ejar");
  });

  it("the import on a tenant account checks the tenant side", async () => {
    w = prodWorld();
    pin("tenant", TENANT_CR);
    await w.svc.lookup(USER, { contract_number: N });
    const runner = new RecordingRunner();
    await new EjarImportService(w.store, runner).import(USER, { contract_number: N });
    assert.equal(runner.plans.length, 1);
  });
});
