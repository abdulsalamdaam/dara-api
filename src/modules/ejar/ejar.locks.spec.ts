/**
 * Field locking for Ejar-imported records.
 *
 * The rule under test: lock what Ejar supplied, leave what it did not, and
 * never lock a manually created record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeEjarLocks } from "./ejar.locks";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "__fixtures__", `${name}.json`), "utf8"));

/** The real GetProperties attributes an import snapshots into ejar_raw. */
const propertyRaw = () => fixture("properties").data[0].attributes as Record<string, unknown>;
const unitRaw = () => fixture("units").data[0].attributes as Record<string, unknown>;

test("a manually created record is never locked", () => {
  assert.deepEqual(computeEjarLocks("property", { ejarSource: null, ejarRaw: null }), { isEjar: false, locked: [] });
  // Even with a payload present — provenance is what decides.
  assert.deepEqual(
    computeEjarLocks("property", { ejarSource: null, ejarRaw: propertyRaw() }),
    { isEjar: false, locked: [] },
  );
});

test("property: Ejar-supplied fields lock, absent ones stay editable", () => {
  const { isEjar, locked } = computeEjarLocks("property", { ejarSource: "ejar", ejarRaw: propertyRaw() });
  assert.equal(isEjar, true);

  // Present in the real payload.
  for (const f of ["name", "type", "usageType", "city", "region", "district", "street", "postalCode", "deedNumber", "yearBuilt", "mapUrl"]) {
    assert.ok(locked.includes(f), `${f} is supplied by Ejar and must be locked`);
  }
  // The UAT property has null elevator_count / parking_count / compound_name,
  // so those remain the user's to fill.
  for (const f of ["elevators", "parkings", "compoundName"]) {
    assert.ok(!locked.includes(f), `${f} is empty in the payload and must stay editable`);
  }
});

test("unit: meters and dimensions Ejar left null stay editable", () => {
  const { locked } = computeEjarLocks("unit", { ejarSource: "ejar", ejarRaw: unitRaw() });
  for (const f of ["unitNumber", "type", "floor", "area", "bedrooms", "rentPrice", "parkingSpaces"]) {
    assert.ok(locked.includes(f), `${f} must be locked`);
  }
  // width/height/length, the meters, direction and finishing are all null in
  // the UAT unit.
  for (const f of ["unitWidth", "unitHeight", "unitLength", "waterMeter", "gasMeter", "electricityMeter", "direction", "finishing"]) {
    assert.ok(!locked.includes(f), `${f} is null in the payload and must stay editable`);
  }
});

test("false and 0 count as supplied values, not as empty", () => {
  // include_mezzanine is `false` and number_of_parking_lots is 0 on the real
  // unit — Ejar stated them, so they are not gaps to fill.
  const { locked } = computeEjarLocks("unit", { ejarSource: "ejar", ejarRaw: unitRaw() });
  assert.ok(locked.includes("hasMezzanine"), "an explicit false is still a value");
  assert.ok(locked.includes("parkingSpaces"), "an explicit 0 is still a value");
});

test("party records lock name and identity but not what Ejar omitted", () => {
  const individual = { name: "مرزوق", type: "individual", id_number: "1051133120", phone_number: "+966551231145", email: "a@b.c" };
  const { locked } = computeEjarLocks("tenant", { ejarSource: "ejar", ejarRaw: individual });
  assert.deepEqual([...locked].sort(), ["email", "name", "nationalId", "phone", "type"].sort());
  // No unified_number on an individual, so the tax number stays editable.
  assert.ok(!locked.includes("taxNumber"));

  // An organization carries a registration + unified number instead.
  const org = { name: "Corwin Inc", type: "organization", registration_number: "2030955236", unified_number: "7030955236" };
  const orgLocks = computeEjarLocks("tenant", { ejarSource: "ejar", ejarRaw: org }).locked;
  assert.ok(orgLocks.includes("nationalId"), "registration_number also locks the ID field");
  assert.ok(orgLocks.includes("taxNumber"));
  assert.ok(!orgLocks.includes("phone"), "no phone in the payload — still editable");
});

test("deed: the fields the import writes are locked", () => {
  const raw = { title_deed_number: "3265555514", title_deed_type: "paper_title_deed", owners: [{ name: "x" }] };
  const { locked } = computeEjarLocks("deed", { ejarSource: "ejar", ejarRaw: raw });
  assert.deepEqual([...locked].sort(), ["deedNumber", "deedOwners", "deedType"]);

  // A deed Ejar gave no owners for keeps that list editable.
  const noOwners = computeEjarLocks("deed", { ejarSource: "ejar", ejarRaw: { ...raw, owners: [] } }).locked;
  assert.ok(!noOwners.includes("deedOwners"));
});
