/**
 * Contract-number lookup (Task 2).
 *
 * GetRentalContracts is documented as id_number-keyed, so a contract-number
 * lookup has to try filter variants and degrade honestly when none work — the
 * list resource is the only carrier of the parties, property id and unit ids.
 * These tests drive the controller with a stubbed Ejar client so the behaviour
 * is pinned without touching the gateway (which only answers the whitelisted
 * production IP anyway).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EjarController } from "./ejar.module";
import type { EjarBody } from "./ejar.types";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "__fixtures__", `${name}.json`), "utf8"));

const CONTRACT_NO = "10712337384";

/** A GetRentalContracts body containing just the fixture contract. */
const listBody = (): EjarBody => ({ data: [fixture("contract")], meta: { count: 1 } });

type Call = { endpoint: string; params: Record<string, unknown> };

/**
 * Stub client. `answersContractFilter` decides whether the gateway accepts a
 * contract-number filter on GetRentalContracts — i.e. the open question with
 * NHC.
 */
function stubClient(opts: { answersContractFilter: boolean; calls: Call[] }) {
  return {
    request: async (endpoint: string, params: Record<string, unknown>) => {
      opts.calls.push({ endpoint, params });
      const log = { endpoint, params };
      if (endpoint === "getRentalContracts") {
        const filtered = "contract_number" in params || "contract_numbers" in params;
        if (filtered) return { body: opts.answersContractFilter ? listBody() : ({ data: [], meta: { count: 0 } } as EjarBody), log };
        // id_number variant: the fallback candidate — a contract number is not
        // a national ID, so the real gateway returns nothing.
        return { body: { data: [], meta: { count: 0 } } as EjarBody, log };
      }
      if (endpoint === "nationalAddress") return { body: fixture("national-address") as EjarBody, log };
      if (endpoint === "rentalFinancialData") return { body: fixture("financial") as EjarBody, log };
      if (endpoint === "rentalContractInvoices") return { body: fixture("invoices") as EjarBody, log };
      if (endpoint === "getProperties") return { body: fixture("properties") as EjarBody, log };
      if (endpoint === "getUnits") return { body: fixture("units") as EjarBody, log };
      return { body: null, log };
    },
  };
}

const runPreview = async (answersContractFilter: boolean) => {
  const calls: Call[] = [];
  const ctl = new EjarController(null as never, stubClient({ answersContractFilter, calls }) as never, null as never, null as never);
  const res = (await ctl.preview({ id: 1 } as never, { contract_number: CONTRACT_NO })) as never as {
    partiesResolved: boolean; lookupMode: string;
    parties: { tenants: unknown[]; lessors: unknown[] };
    units: unknown[]; invoices: unknown[];
    property: Record<string, unknown>;
    financial: Record<string, unknown>;
    nationalAddress: Record<string, unknown>;
    contract: Record<string, unknown>;
  };
  return { res, calls };
};

test("contract-number lookup: full preview when Ejar accepts the filter", async () => {
  const { res, calls } = await runPreview(true);

  assert.equal(res.lookupMode, "contractNumber");
  assert.equal(res.partiesResolved, true);
  assert.ok(res.parties.tenants.length > 0, "tenant resolved without a national ID");
  assert.ok(res.parties.lessors.length > 0, "landlord resolved without a national ID");
  assert.equal(res.units.length, 1);
  assert.equal(res.property.name, "Test Property 3072036095");
  assert.equal(res.contract.contractNumber, CONTRACT_NO);
  assert.ok(res.invoices.length > 0);

  // It must stop at the first filter that works rather than trying them all.
  const listCalls = calls.filter((c) => c.endpoint === "getRentalContracts");
  assert.equal(listCalls.length, 1, "should not keep probing once a filter succeeds");
  assert.ok("contract_number" in listCalls[0].params);
});

test("contract-number lookup: degrades honestly when Ejar rejects every filter", async () => {
  const { res, calls } = await runPreview(false);

  assert.equal(res.partiesResolved, false, "the client must be told the parties are missing");
  assert.equal(res.parties.tenants.length, 0);
  assert.equal(res.parties.lessors.length, 0);
  assert.equal(res.units.length, 0);

  // The endpoints that ARE keyed by contract number still populate.
  assert.ok(res.financial.totalRentAmount, "financials still resolve by contract number");
  assert.ok(res.invoices.length > 0, "invoices still resolve by contract number");
  assert.ok(res.nationalAddress.latitude, "national address still resolves by contract number");
  assert.equal(res.contract.contractNumber, CONTRACT_NO);

  // Every candidate was tried before giving up.
  const listCalls = calls.filter((c) => c.endpoint === "getRentalContracts");
  assert.equal(listCalls.length, 3, "all filter candidates are attempted");
});

test("national-ID lookup still resolves the contract from the list", async () => {
  const calls: Call[] = [];
  const client = {
    request: async (endpoint: string, params: Record<string, unknown>) => {
      calls.push({ endpoint, params });
      const log = { endpoint, params };
      if (endpoint === "getRentalContracts") {
        return { body: (Number(params["page[number]"]) === 1 ? listBody() : { data: [] }) as EjarBody, log };
      }
      if (endpoint === "nationalAddress") return { body: fixture("national-address") as EjarBody, log };
      if (endpoint === "rentalFinancialData") return { body: fixture("financial") as EjarBody, log };
      if (endpoint === "rentalContractInvoices") return { body: fixture("invoices") as EjarBody, log };
      if (endpoint === "getProperties") return { body: fixture("properties") as EjarBody, log };
      if (endpoint === "getUnits") return { body: fixture("units") as EjarBody, log };
      return { body: null, log };
    },
  };
  const ctl = new EjarController(null as never, client as never, null as never, null as never);
  const res = (await ctl.preview({ id: 1 } as never, { id_number: "1025071984", contract_number: CONTRACT_NO })) as never as {
    partiesResolved: boolean; lookupMode: string; parties: { tenants: unknown[] };
  };
  assert.equal(res.lookupMode, "nationalId");
  assert.equal(res.partiesResolved, true);
  assert.ok(res.parties.tenants.length > 0);
});
