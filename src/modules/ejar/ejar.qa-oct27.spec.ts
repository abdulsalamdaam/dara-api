/**
 * Ejar Import v3 — QA round of 27 Oct 2026 (in memory; the DB half is
 * ejar.import-once.db.spec.ts).
 *
 *  1. A refused lookup (party / scope mismatch) carries no contract data:
 *     not in the 422/403 body, not in a cached answer, and not in the
 *     account's call log (the rows' bodies are withheld).
 *  3. The rent is taken from what Ejar bills — the invoices — so the stored
 *     monthly rent, the annual figure, its VAT and the installments agree.
 *     total_rent_amount is the rent per contract year before VAT, not the total.
 *
 * Every value is synthetic (public repo); the commercial shape mirrors the
 * production response key for key (lookup-*-prod fixtures).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { STG, world, httpError, baladyOk, baladyErr, fixture, CN } from "./__tests__/lookup-harness";
import { EjarImportService, type EjarImportRunnerLike } from "./ejar.import.service";
import type { ImportPlan, ImportResult } from "./ejar.import.writer";
import { ejarCycle } from "./ejar.import.writer";
import { mapLookup } from "./ejar.lookup.map";
import { contractMonths, monthlyRentFrom, rentBasis, rentFigures } from "./ejar.rent";

const N = "20000000001";
const U = "22222222-3333-4444-8555-666666666666";
const USER = { id: 1 } as never;
/** Every personal value in the commercial fixture — none may reach a refused account. */
const SECRETS = [
  "شركة المؤجر التجريبية", "ممثل المؤجر التجريبي", "شركة المستأجر التجريبية", "ممثل المستأجر التجريبي",
  "1010999001", "1010999002", "7009990001", "7009990002", "1000000101", "1000000102",
  "+966500000101", "+966500000102", "lessor-rep@example.invalid", "tenant-rep@example.invalid",
];

/** The production-shaped invoices with the real schedule: 5 × 39,687 + 39,690 = 238,125. */
function invoices268() {
  const b = fixture("lookup-invoices-prod");
  const pays = b.included.filter((r: { type: string }) => r.type === "payments");
  pays[pays.length - 1].attributes.invoice_amount = "39690.0";
  pays[pays.length - 1].attributes.invoice_remaining_amount = "39690.0";
  return b;
}

function prodWorld() {
  const w = world();
  w.store.lookupRows.push({ id: 8, category: "property_type", key: "plaza" });
  w.setRespond((url) => {
    if (url === `${STG}/v1/ejar-services/contracts/${N}/invoices`) return baladyOk(invoices268());
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

const leaks = (v: unknown) => SECRETS.filter((s) => JSON.stringify(v).includes(s));

let w: ReturnType<typeof prodWorld>;
afterEach(() => w?.restore());

describe("1 · a refused lookup returns no contract data", () => {
  it("party mismatch (عقاري): the 422 is the code and message only; the call log keeps no body; nothing is saved", async () => {
    w = prodWorld();
    w.store.partyChecks[1] = { role: "landlord", idNumber: "1099999999" };
    const r = await httpError(w.svc.lookup(USER, { contract_number: N }));
    assert.equal(r.status, 422);
    assert.equal(r.body.code, "party_mismatch");
    assert.deepEqual(Object.keys(r.body).sort(), ["budget", "code", "message", "role"]);
    assert.deepEqual(leaks(r.body), [], "no name, ID, phone or email in the refusal");
    assert.equal(w.dataCalls().length, 2, "the calls were spent (and count)");
    assert.equal(w.store.logs.length, 2);
    for (const l of w.store.logs) {
      assert.deepEqual(l.responseBody, { withheld: "party_mismatch" }, `log ${l.id} body withheld`);
      assert.equal(l.bodyTruncated, true, "never a replay source");
    }
    assert.deepEqual(leaks(w.store.logs), [], "GET /ejar/logs/:id has nothing to hand back");
    assert.equal(await w.store.getLookup(1, N), null, "nothing saved for the account to read");
  });

  it("party mismatch (tenant plan) — same", async () => {
    w = prodWorld();
    w.store.partyChecks[1] = { role: "tenant", idNumber: "1099999998" };
    const r = await httpError(w.svc.lookup(USER, { contract_number: N }));
    assert.equal(r.status, 422);
    assert.deepEqual(leaks(r.body), []);
    assert.deepEqual(leaks(w.store.logs), []);
  });

  it("scope mismatch (a locked account): 403 with no data, bodies withheld", async () => {
    w = prodWorld();
    w.store.scopes[1] = { locked: true, idNumber: "7777777777" };
    const r = await httpError(w.svc.lookup(USER, { contract_number: N }));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "scope_mismatch");
    assert.deepEqual(leaks(r.body), []);
    assert.deepEqual(leaks(w.store.logs), []);
    assert.ok(w.store.logs.every((l) => (l.responseBody as { withheld?: string })?.withheld === "scope_mismatch"));
  });

  it("a saved lookup is refused without data once the pin no longer matches (cache path, no call)", async () => {
    w = prodWorld();
    await w.svc.lookup(USER, { contract_number: N });
    const calls = w.dataCalls().length;
    w.store.partyChecks[1] = { role: "landlord", idNumber: "1099999999" };
    const r = await httpError(w.svc.lookup(USER, { contract_number: N }));
    assert.equal(r.status, 422);
    assert.deepEqual(Object.keys(r.body).sort(), ["code", "message", "role"]);
    assert.deepEqual(leaks(r.body), []);
    assert.equal(w.dataCalls().length, calls, "served from the saved lookup, nothing sent");
    // …and the import refuses it the same way.
    const imp = await httpError(new EjarImportService(w.store, new RecordingRunner()).import(USER, { contract_number: N }));
    assert.equal(imp.status, 422);
    assert.deepEqual(leaks(imp.body), []);
  });

  it("a pinned account whose second call fails: the error carries no body and the Invoices body is withheld", async () => {
    w = prodWorld();
    w.store.partyChecks[1] = { role: "landlord", idNumber: "1010999001" };
    w.setRespond((url) => {
      if (url.endsWith(`/contracts/${N}/invoices`)) return baladyOk(invoices268());
      return baladyErr(503, "E503", "unavailable");
    });
    const r = await httpError(w.svc.lookup(USER, { contract_number: N }));
    assert.equal(r.status, 502);
    assert.equal(r.body.log?.responseBody, undefined);
    assert.deepEqual(leaks(w.store.logs), []);
  });

  it("an unpinned account's matching lookup still answers in full (nothing withheld)", async () => {
    w = prodWorld();
    const res = await w.svc.lookup(USER, { contract_number: N });
    assert.equal(res.parties.lessor?.crNumber, "1010999001");
    assert.equal(w.store.withheld.size, 0);
  });

  it("a wrong number's 404 echoes the call log without bodies", async () => {
    w = prodWorld();
    const r = await httpError(w.svc.lookup(USER, { contract_number: "20000000999" }));
    assert.equal(r.status, 404);
    assert.ok(r.body.logs.length >= 1);
    assert.ok(r.body.logs.every((l: Record<string, unknown>) => !("responseBody" in l)));
  });
});

describe("3 · rent from what Ejar bills", () => {
  const m268 = () => mapLookup(invoices268(), null, fixture("lookup-contracts-prod"), N);

  it("20498373268-shape: total_rent_amount (63,500) is per year before VAT; the six invoices are the total", () => {
    const m = m268();
    assert.equal(m.financial.totalRentAmount, 63500);
    assert.equal(m.financial.invoiceTotal, 238125);
    assert.equal(m.contract.totalValue, 238125);
    assert.equal(63500 * 3 * 1.25, 238125, "the schedule is 3 years of 63,500 plus 25% (15% of it VAT)");
  });

  it("commercial (VAT): monthly 5,751.81, annual 69,021.72, annual VAT 10,353.26, VAT over the contract 31,059.78", () => {
    const b = rentBasis(m268());
    assert.deepEqual(b, { gross: 238125, months: 36, annualExVat: 63500 });
    const f = rentFigures(b, true);
    assert.equal(f.monthly, 5751.81);
    assert.equal(f.annual, 69021.72);
    assert.equal(f.annualVat, 10353.26);
    assert.equal(f.totalVat, 31059.78);
    // The installments carry VAT extracted from their VAT-inclusive amounts:
    const instVat = [39687, 39687, 39687, 39687, 39687, 39690].reduce((s, a) => s + (a - a / 1.15), 0);
    assert.equal(Math.round(instVat * 100) / 100, f.totalVat, "header VAT × years = the installments' VAT");
    assert.ok(Math.abs(f.annualVat * 3 - f.totalVat) < 0.05);
    assert.ok(Math.abs((f.annual + f.annualVat) * 3 - 238125) < 1, "annual incl. VAT × 3 years = the schedule");
  });

  it("the import stores that monthly rent, 2 decimals, with the basis for the writer's final VAT verdict", async () => {
    w = prodWorld();
    await w.svc.lookup(USER, { contract_number: N });
    const runner = new RecordingRunner();
    await new EjarImportService(w.store, runner).import(USER, { contract_number: N });
    const c = runner.plans[0].contract;
    assert.equal(c.monthlyRent, "5751.81");
    assert.deepEqual(c.rentBasis, { gross: 238125, months: 36, annualExVat: 63500 });
    assert.equal(c.customSchedule.length, 6, "the installments stay Ejar's invoices as billed");
    assert.equal((c.ejarRaw as { cycle?: string }).cycle, "semi_annual");
  });

  it("the lookup answers the same figures for the review", async () => {
    w = prodWorld();
    const res = await w.svc.lookup(USER, { contract_number: N });
    assert.deepEqual(
      { total: res.rent.total, monthly: res.rent.monthly, annual: res.rent.annual, annualVat: res.rent.annualVat, ejarAnnualRent: res.rent.ejarAnnualRent, vat: res.rent.vat },
      { total: 238125, monthly: 5751.81, annual: 69021.72, annualVat: 10353.26, ejarAnnualRent: 63500, vat: true },
    );
  });

  it("20499000017-shape (one year, residential, 4 × 12,000): 4,000 a month, 48,000 a year, no VAT", () => {
    const b = { gross: 48000, months: contractMonths({ periodDays: 365, startDate: "2026-11-01", endDate: "2027-10-31" }), annualExVat: 48000 };
    assert.equal(b.months, 12);
    const f = rentFigures(b, false);
    assert.equal(f.monthly, 4000);
    assert.equal(f.annual, 48000);
    assert.equal(f.annualVat, 0);
    assert.equal(f.totalVat, 0);
  });

  it("no invoices and no total: total_rent_amount is the annual rent before VAT", () => {
    assert.equal(monthlyRentFrom({ gross: null, months: 36, annualExVat: 63500 }, true), 5291.67);
  });

  it("months: Ejar's period wins over the date span (1095 days → 36, not 1096)", () => {
    assert.equal(contractMonths({ periodDays: 1095, startDate: "2026-11-16", endDate: "2029-11-15" }), 36);
    assert.equal(contractMonths({ periodDays: null, startDate: "2026-11-16", endDate: "2029-11-15" }), 36);
  });
});

describe("7 · Ejar's payment frequency as Dara's cycle", () => {
  it("bi-annual → semi_annual, quarterly → quarterly, monthly, annual; unknown → null", () => {
    const f = (pf: string | null, en: string | null = null) => ejarCycle({ contract: { paymentFrequency: pf }, financial: { recurringPayment: en ? { en, ar: null } : null } });
    assert.equal(f("bi-annual"), "semi_annual");
    assert.equal(f("quarterly"), "quarterly");
    assert.equal(f("monthly"), "monthly");
    assert.equal(f("annually"), "annual");
    assert.equal(f(null, "Bi-Annual"), "semi_annual");
    assert.equal(f(null, "Quarterly"), "quarterly");
    assert.equal(f(null, null), null);
  });
});

describe("4 · the review names the existing landlord / tenant the import will link", () => {
  it("a party with the same ID in the account is reported with its stored contact; a new one is null", async () => {
    w = world();
    w.store.owners.push({ id: 41, accountId: 1, name: "Stored Landlord", idNumber: null, phone: "500000999", email: "stored@example.invalid", isAccountHolder: true });
    const res = await w.svc.lookup(USER, { contract_number: CN });
    // The default fixture's lessor is matched by ID/CR only when the account holds it; here only by name.
    const lessor = res.parties.lessor;
    assert.ok(lessor);
    assert.equal(res.linkedParties.tenant, null);
    w.store.owners[0].name = lessor!.name!;
    w.store.owners[0].idNumber = (lessor!.kind === "organization" ? lessor!.crNumber : lessor!.idNumber) ?? null;
    const again = await w.svc.lookup(USER, { contract_number: CN });
    assert.deepEqual(again.linkedParties.landlord, { id: 41, name: lessor!.name, phone: "500000999", email: "stored@example.invalid", isAccountHolder: true });
  });
});
