/**
 * Field-coverage audit for the Ejar mapper.
 *
 * Ejar is the system of record; anything it sends must either land in a typed
 * field of the preview or be reachable through the `ejar_raw` snapshot. This
 * spec walks the REAL UAT payloads in __fixtures__ and fails if a field goes
 * missing on both routes — that is what "nothing is silently dropped" means in
 * practice, and it will catch a future Ejar payload growing a new key.
 *
 * Pure — no database, so it runs everywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapEjarToContract } from "./ejar.map";
import { EJAR_DEED_TYPE, mapEjarValue } from "./ejar.import";
import type { EjarBody, JsonApiResource } from "./ejar.types";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "__fixtures__", `${name}.json`), "utf8"));

function buildPreview() {
  return mapEjarToContract({
    contract: fixture("contract") as JsonApiResource,
    nationalAddress: fixture("national-address") as EjarBody,
    financial: fixture("financial") as EjarBody,
    invoices: fixture("invoices") as EjarBody,
    propertiesBody: fixture("properties") as EjarBody,
    unitsBody: fixture("units") as EjarBody,
  });
}

/** Every attribute key the fixture endpoint actually returns. */
function attrKeys(body: EjarBody): string[] {
  const data = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
  return Object.keys(data[0]?.attributes ?? {});
}

test("contract: every GetRentalContracts attribute is mapped or snapshotted", () => {
  const preview = buildPreview();
  const keys = Object.keys((fixture("contract") as JsonApiResource).attributes ?? {});
  assert.ok(keys.length > 25, "fixture should carry the full contract attribute set");
  for (const k of keys) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(preview.raw.contract ?? {}, k),
      `contract attribute "${k}" is missing from raw.contract`,
    );
  }
});

test("property: every GetProperties attribute is mapped or snapshotted", () => {
  const preview = buildPreview();
  for (const k of attrKeys(fixture("properties") as EjarBody)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(preview.raw.property ?? {}, k),
      `property attribute "${k}" is missing from raw.property`,
    );
  }
});

test("unit: every GetUnits attribute is mapped or snapshotted", () => {
  const preview = buildPreview();
  const unitRaws = Object.values(preview.raw.units);
  assert.equal(unitRaws.length, 1, "the fixture contract has exactly one unit");
  for (const k of attrKeys(fixture("units") as EjarBody)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(unitRaws[0], k),
      `unit attribute "${k}" is missing from raw.units`,
    );
  }
});

test("the business-critical fields land in typed preview fields, not only raw", () => {
  const p = buildPreview();

  // Contract facts
  assert.equal(p.contractInfo.contractNumber, "10712337384");
  assert.equal(p.contractInfo.contractType, "residential");
  assert.equal(p.contractInfo.autoRenewal, "true");
  assert.ok(p.contractInfo.periodDays, "period must be mapped");
  assert.ok(p.contractInfo.brokerName, "broker_name must be mapped");
  assert.ok(p.activities.length > 0, "contract_activities must be mapped");

  // Parties — both sides, with the raw object kept for ejar_raw
  assert.ok(p.parties.tenants.length >= 1);
  assert.ok(p.parties.lessors.length >= 1);
  assert.ok(p.parties.tenants[0].name && p.parties.tenants[0].idNumber);
  assert.ok(p.parties.lessors[0].name && p.parties.lessors[0].idNumber);
  assert.ok(p.parties.tenants[0].raw && Object.keys(p.parties.tenants[0].raw).length > 0);
  assert.ok(p.parties.brokers.length >= 1, "broker must be surfaced as a party");

  // Property — the fields the user called out plus the address block
  assert.equal(p.property.yearBuilt, "2000", "building_year must be mapped");
  assert.equal(p.property.district, "الياسمين");
  assert.equal(p.property.city, "الرياض");
  assert.equal(p.property.regionKey, "riyadh", "region key drives the region lookup");
  assert.equal(p.property.deedNumber, "3265555514");
  assert.equal(p.property.deedType, "paper_title_deed");
  assert.ok(p.property.address);
  assert.ok(p.property.owners.length > 0, "property owners must be mapped");
  // Encrypted GetProperties columns must not be surfaced as data.
  assert.deepEqual(p.property.unifiedNumbers, [], "encrypted unified_numbers are dropped");

  // Unit
  const u = p.units[0];
  assert.equal(u.unitNumber, "2003-89");
  assert.equal(u.area, "440");
  assert.equal(u.rooms, "5");
  assert.equal(u.floor, "40");
  assert.equal(u.deedNumber, "3265555514");
  assert.ok(u.owners.length > 0, "unit owners must be mapped");
  assert.deepEqual(u.unifiedNumbers, ["7005319798", "7023417145"], "plain unit numbers survive");

  // Invoices — full identity, not just amount + due date
  assert.ok(p.invoices.length > 0);
  const inv = p.invoices[0];
  assert.ok(inv.number, "sequence_number must be mapped");
  assert.ok(inv.dueDate && inv.issueDate && inv.lateDate);
  assert.ok(inv.remaining != null && inv.status);

  // Financials
  assert.ok(p.financial.totalRentAmount, "total_rent_amount must be mapped");
  assert.ok(p.financial.paymentFrequency);

  // National address
  assert.ok(p.nationalAddress.latitude && p.nationalAddress.longitude);
});

test("Ejar deed types map onto the seeded deed_type lookup keys", () => {
  // Keys must match the lookups table exactly, otherwise an imported deed shows
  // a blank dropdown.
  const VALID = new Set(["electronic", "paper", "hojjat_esthkam", "real_estate_registry"]);
  for (const [ejarValue, key] of Object.entries(EJAR_DEED_TYPE)) {
    assert.ok(VALID.has(key), `${ejarValue} maps to "${key}", which is not a deed_type option`);
  }

  // The value the UAT fixtures actually carry.
  assert.equal(mapEjarValue(EJAR_DEED_TYPE, "paper_title_deed"), "paper");
  assert.equal(mapEjarValue(EJAR_DEED_TYPE, "electronic_title_deed"), "electronic");
  assert.equal(mapEjarValue(EJAR_DEED_TYPE, "hojjat_esthkam"), "hojjat_esthkam");
  assert.equal(mapEjarValue(EJAR_DEED_TYPE, "real_estate_registry_title_deed"), "real_estate_registry");
  assert.equal(mapEjarValue(EJAR_DEED_TYPE, "PAPER_TITLE_DEED"), "paper", "matching is case-insensitive");

  // Unknown types must NOT be forced into a real option — the import keeps them
  // verbatim as a custom ("Other") value instead of mislabelling the deed.
  assert.equal(mapEjarValue(EJAR_DEED_TYPE, "some_future_ejar_type"), null);
});
