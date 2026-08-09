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
  // Contact details are exempt even though Ejar supplied them — see below.
  assert.deepEqual([...locked].sort(), ["name", "nationalId", "type"].sort());
  // No unified_number on an individual, so the tax number stays editable.
  assert.ok(!locked.includes("taxNumber"));

  // An organization carries a registration + unified number instead.
  const org = { name: "Corwin Inc", type: "organization", registration_number: "2030955236", unified_number: "7030955236" };
  const orgLocks = computeEjarLocks("tenant", { ejarSource: "ejar", ejarRaw: org }).locked;
  assert.ok(orgLocks.includes("nationalId"), "registration_number also locks the ID field");
  assert.ok(orgLocks.includes("taxNumber"));
});

test("phone and email stay editable on imported parties, identity does not", () => {
  // Contact details go stale — a tenant changes their number and the landlord
  // must still be able to reach them. Identity fields are the whole point of
  // the lock and must not leak through this exemption.
  const raw = {
    name: "مرزوق", type: "individual", id_number: "1051133120",
    phone_number: "+966551231145", email: "a@b.c", unified_number: "7030955236",
  };
  for (const entity of ["tenant", "landlord"] as const) {
    const { locked } = computeEjarLocks(entity, { ejarSource: "ejar", ejarRaw: raw });
    assert.ok(!locked.includes("phone"), `${entity}: phone must be editable`);
    assert.ok(!locked.includes("email"), `${entity}: email must be editable`);
    assert.ok(locked.includes("name"), `${entity}: name must stay locked`);
    assert.ok(locked.includes("taxNumber"), `${entity}: tax number must stay locked`);
    const idField = entity === "tenant" ? "nationalId" : "idNumber";
    assert.ok(locked.includes(idField), `${entity}: ${idField} must stay locked`);
  }
});

test("phone and email are editable on legacy imports too (no ejar_raw)", () => {
  // Records imported before the snapshot existed fall back to reading columns;
  // the exemption has to apply on that path as well or half the estate stays
  // frozen.
  const row = { ejarSource: "ejar", name: "مرزوق", nationalId: "1051133120", phone: "0551231145", email: "a@b.c" };
  const { locked } = computeEjarLocks("tenant", row);
  assert.ok(!locked.includes("phone"));
  assert.ok(!locked.includes("email"));
  assert.ok(locked.includes("name"), "legacy imports still lock identity");
  assert.ok(locked.includes("nationalId"));
});

test("deed: the fields the import writes are locked", () => {
  const raw = { title_deed_number: "3265555514", title_deed_type: "paper_title_deed", owners: [{ name: "x" }] };
  const { locked } = computeEjarLocks("deed", { ejarSource: "ejar", ejarRaw: raw });
  assert.deepEqual([...locked].sort(), ["deedNumber", "deedOwners", "deedType"]);

  // A deed Ejar gave no owners for keeps that list editable.
  const noOwners = computeEjarLocks("deed", { ejarSource: "ejar", ejarRaw: { ...raw, owners: [] } }).locked;
  assert.ok(!noOwners.includes("deedOwners"));
});

test("records imported before ejar_raw existed still lock, from their values", () => {
  // No snapshot — the fallback reads the row's own columns instead.
  const legacyProperty = {
    ejarSource: "ejar", ejarRaw: null,
    name: "عقار", typeLookupId: 34, cityLookupId: 84, district: "الياسمين",
    street: null, postalCode: null, elevators: null,
  };
  const { isEjar, locked } = computeEjarLocks("property", legacyProperty);
  assert.equal(isEjar, true, "a legacy import must not be treated as manual");
  assert.ok(locked.includes("name"));
  assert.ok(locked.includes("type"));
  assert.ok(locked.includes("city"));
  assert.ok(locked.includes("district"));
  // Columns the import left empty are still the user's to fill.
  assert.ok(!locked.includes("street"));
  assert.ok(!locked.includes("postalCode"));
  assert.ok(!locked.includes("elevators"));
});

test("an empty ejar_raw object falls back rather than locking nothing", () => {
  const { locked } = computeEjarLocks("tenant", {
    ejarSource: "ejar", ejarRaw: {}, name: "مستأجر", nationalId: "1104100571", phone: null,
  });
  assert.deepEqual([...locked].sort(), ["name", "nationalId"]);
});
