/**
 * End-to-end persistence check for the Ejar import.
 *
 * Runs the REAL controller against the REAL UAT payloads in __fixtures__ and
 * asserts what actually landed in every table — then rolls the transaction
 * back, so it is safe to point at any database including production.
 *
 * Skipped when DATABASE_URL is unset (unit-test-only environments).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  db, getPool, contractsTable, propertiesTable, unitsTable, ownersTable, deedsTable,
  tenantsTable, paymentsTable, contractUnitsTable, usersTable, lookupsTable,
} from "@oqudk/database";
import { mapEjarToContract } from "./ejar.map";
import { EjarController } from "./ejar.module";
import type { EjarBody, JsonApiResource } from "./ejar.types";

const HAS_DB = !!process.env.DATABASE_URL;

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "__fixtures__", `${name}.json`), "utf8"));

const preview = () =>
  mapEjarToContract({
    contract: fixture("contract") as JsonApiResource,
    nationalAddress: fixture("national-address") as EjarBody,
    financial: fixture("financial") as EjarBody,
    invoices: fixture("invoices") as EjarBody,
    propertiesBody: fixture("properties") as EjarBody,
    unitsBody: fixture("units") as EjarBody,
  });

/** Mirrors the browser's toImportPayload(). */
const payload = (p: ReturnType<typeof preview>, contractNumber: string) => ({
  contract: { ...p.contract, ejarContractNumber: contractNumber, contractNumber },
  property: p.property as never,
  units: p.units as never,
  parties: p.parties,
  contractInfo: p.contractInfo as never,
  invoices: p.invoices,
  raw: p.raw,
});

class Rollback extends Error {}

/**
 * Run `fn` against a transaction that is always rolled back. Returns whatever
 * fn resolved to; nothing survives in the database.
 */
async function inRollback<T>(fn: (tx: never) => Promise<T>): Promise<T> {
  let out!: T;
  try {
    await db.transaction(async (tx) => {
      out = await fn(tx as never);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

let userId = 0;

before(async () => {
  if (!HAS_DB) return;
  const [u] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  userId = u?.id ?? 0;
});

after(async () => {
  // getPool(), not the exported `pool` Proxy — the Proxy has no `set` trap, so
  // end()'s internal `this.ending = true` lands on the empty target and the
  // pool never actually closes, leaving the test process hanging.
  if (HAS_DB) await getPool().end();
});

test("import persists every mapped Ejar field across all six tables", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  assert.ok(userId, "needs at least one user row to scope the import to");
  const p = preview();

  const rows = await inRollback(async (tx) => {
    const ctl = new EjarController(tx as never, null as never, null as never, null as never);
    const res = (await ctl.import({ id: userId } as never, payload(p, "TEST-EJAR-SPEC-1"))) as never as {
      id: number; propertyId: number; unitIds: number[];
      landlordId: number; deedId: number; tenantId: number;
      installmentsCreated: number; created: string[]; linked: string[];
    };
    const one = async (t: never, col: never, id: number) =>
      (await (tx as never as typeof db).select().from(t).where(eq(col, id)).limit(1))[0];
    return {
      res,
      contract: await one(contractsTable as never, contractsTable.id as never, res.id),
      property: await one(propertiesTable as never, propertiesTable.id as never, res.propertyId),
      unit: await one(unitsTable as never, unitsTable.id as never, res.unitIds[0]),
      landlord: await one(ownersTable as never, ownersTable.id as never, res.landlordId),
      deed: await one(deedsTable as never, deedsTable.id as never, res.deedId),
      tenant: await one(tenantsTable as never, tenantsTable.id as never, res.tenantId),
      links: await (tx as never as typeof db).select().from(contractUnitsTable).where(eq(contractUnitsTable.contractId, res.id)),
      payments: await (tx as never as typeof db).select().from(paymentsTable).where(eq(paymentsTable.contractId, res.id)),
    };
  });

  const { res, contract, property, unit, landlord, deed, tenant, links, payments } = rows as never as Record<string, never> & {
    res: { created: string[]; linked: string[]; installmentsCreated: number };
    contract: Record<string, unknown>; property: Record<string, unknown>; unit: Record<string, unknown>;
    landlord: Record<string, unknown>; deed: Record<string, unknown>; tenant: Record<string, unknown>;
    links: unknown[]; payments: Array<Record<string, unknown>>;
  };

  // Every entity in the hierarchy is accounted for — created if new, linked if
  // an earlier import (or a real one made through the app) already produced it.
  // Asserting "all six created" would make this test depend on a pristine
  // database, and it is pointed at a live one.
  assert.deepEqual(
    [...res.created, ...res.linked].sort(),
    ["contract", "deed", "landlord", "property", "tenant", "unit"],
    "every entity in the hierarchy must be created or reused",
  );
  assert.ok(res.created.includes("contract"), "the contract itself is always new");

  // ── Landlord
  assert.equal(landlord.name, "روابي عبدالله محمد السلامه");
  assert.equal(landlord.idNumber, "1082683978");
  assert.equal(landlord.type, "individual");
  assert.equal(landlord.ejarSource, "ejar");
  assert.ok(landlord.ejarRaw, "landlord keeps the verbatim Ejar party");

  // ── Deed
  assert.equal(deed.deedNumber, "3265555514");
  assert.equal(deed.deedType, "paper", "paper_title_deed maps to our deed_type");
  assert.equal(deed.ownerId, landlord.id);
  assert.ok(deed.ejarRaw);
  // Owners printed on the deed come from the Ejar property's owners list, and
  // are distinct from ownerId (the landlord the deed is filed under).
  const deedOwners = deed.deedOwners as Array<{ name: string; idNumber: string | null }> | null;
  assert.ok(Array.isArray(deedOwners) && deedOwners.length > 0, "deed owners must be captured from Ejar");
  assert.equal(deedOwners![0].name, "روابي عبدالله محمد السلامه");
  assert.equal(deedOwners![0].idNumber, "1082683978");

  // ── Property: the field the audit called out, plus address + lookups
  assert.equal(property.yearBuilt, 2000, "building_year must persist");
  assert.equal(property.district, "الياسمين");
  assert.equal(property.street, "رقم 212");
  assert.equal(property.postalCode, "13325");
  assert.equal(property.deedNumber, "3265555514");
  assert.equal(property.deedId, deed.id);
  assert.equal(property.ownerId, landlord.id);
  assert.ok(property.typeLookupId, "property type resolves to a lookup FK");
  assert.ok(property.usageLookupId, "property usage resolves to a lookup FK");
  assert.ok(property.regionLookupId, "region resolves to a lookup FK");
  assert.ok(property.cityLookupId, "city resolves to a lookup FK");
  assert.ok(property.ejarRaw, "property keeps the verbatim GetProperties attributes");
  // Ejar sends coordinates, not a link — the import turns them into the Maps
  // URL the property screen shows.
  assert.match(
    String(property.mapUrl),
    /^https:\/\/www\.google\.com\/maps\?q=24\.8274.*,46\.6371/,
    `map link should be built from the Ejar coordinates, got: ${property.mapUrl}`,
  );

  // ── Unit
  assert.equal(unit.unitNumber, "2003-89");
  assert.equal(unit.floor, 40);
  assert.equal(String(unit.area), "440.00");
  assert.equal(unit.bedrooms, 5);
  assert.equal(unit.parkingSpaces, 0);
  assert.equal(unit.hasMezzanine, false);
  assert.equal(unit.status, "rented", "availability=occupied maps to rented");
  assert.ok(unit.typeLookupId, "unit type resolves to a lookup FK");
  assert.ok(unit.ejarRaw, "unit keeps the verbatim GetUnits attributes");

  // ── Tenant
  assert.equal(tenant.name, "معاذ محمد بن سالم العصيمي");
  assert.equal(tenant.nationalId, "1104100571");
  assert.equal(tenant.ejarSource, "ejar");
  assert.ok(tenant.ejarRaw, "tenant keeps the verbatim Ejar party");

  // ── Contract
  assert.equal(contract.tenantId, tenant.id, "contract links to the tenant row");
  assert.equal(contract.ejarSource, "ejar");
  assert.ok(contract.signingDate, "created_time becomes the signing date");
  assert.ok(contract.ejarRaw, "contract keeps the verbatim Ejar attributes");
  assert.equal(links.length, 1, "the contract is linked to its unit");

  // ── Payments carry the real Ejar invoice identity
  assert.ok(payments.length > 0, "installments are generated");
  assert.equal(payments.length, res.installmentsCreated);
  const stamped = payments.filter((x) => x.receiptNumber);
  assert.ok(stamped.length > 0, "the real Ejar invoice number is stamped on the installment");
  assert.ok(String(stamped[0].description).includes("فاتورة إيجار رقم"));
});

test("the imported deed type is a real deed_type lookup option", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  // The end-to-end link between the import and the Deeds dropdown: whatever the
  // import writes into deeds.deed_type has to be a key the LookupOtherSelect
  // can render, or the field comes up blank on an imported deed.
  const p = preview();
  const deedType = await inRollback(async (tx) => {
    const ctl = new EjarController(tx as never, null as never, null as never, null as never);
    const res = (await ctl.import({ id: userId } as never, payload(p, "TEST-EJAR-DEEDTYPE"))) as never as { deedId: number };
    const [row] = await (tx as never as typeof db).select().from(deedsTable).where(eq(deedsTable.id, res.deedId));
    return (row as { deedType: string }).deedType;
  });

  const options = await db
    .select({ key: lookupsTable.key })
    .from(lookupsTable)
    .where(eq(lookupsTable.category, "deed_type"));
  const keys = options.map((o) => o.key);

  assert.ok(keys.length >= 4, `deed_type lookups must be seeded, found: ${keys.join(", ")}`);
  assert.ok(
    keys.includes(deedType),
    `import wrote deed_type "${deedType}" but the options are: ${keys.join(", ")}`,
  );
});

test("a compound property imports into the shape the property form reads", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  // The UAT fixture property is not in a compound, so drive the true path
  // explicitly: what matters is that the import writes the SAME amenitiesData
  // keys the add/edit form writes and the detail view reads back.
  const p = preview();
  const stored = await inRollback(async (tx) => {
    const ctl = new EjarController(tx as never, null as never, null as never, null as never);
    const body = payload(p, "TEST-EJAR-COMPOUND");
    const res = (await ctl.import({ id: userId } as never, {
      ...body,
      property: { ...(body.property as Record<string, unknown>), partOfCompound: "true", compoundName: "مجمع الياسمين" } as never,
    })) as never as { propertyId: number };
    const [row] = await (tx as never as typeof db).select().from(propertiesTable).where(eq(propertiesTable.id, res.propertyId));
    return (row as { amenitiesData: string | null }).amenitiesData;
  });

  assert.ok(stored, "amenitiesData must be written when Ejar reports a compound");
  const parsed = JSON.parse(stored!) as { inCompound?: boolean; compoundName?: string; counts?: Record<string, number> };
  assert.equal(parsed.inCompound, true);
  assert.equal(parsed.compoundName, "مجمع الياسمين");
  assert.ok(parsed.counts !== undefined, "the facilities block stays alongside it");
});

test("a property with no compound and no facilities writes no amenities blob", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  // The fixture property: part_of_compound false, empty amenities/utilities.
  const p = preview();
  const stored = await inRollback(async (tx) => {
    const ctl = new EjarController(tx as never, null as never, null as never, null as never);
    const res = (await ctl.import({ id: userId } as never, payload(p, "TEST-EJAR-NOCOMPOUND"))) as never as { propertyId: number };
    const [row] = await (tx as never as typeof db).select().from(propertiesTable).where(eq(propertiesTable.id, res.propertyId));
    return (row as { amenitiesData: string | null }).amenitiesData;
  });
  assert.equal(stored, null, "nothing to say means no blob, not an empty one");
});

/** The same preview builder, but from the contract that carries both reps. */
const previewWithReps = () =>
  mapEjarToContract({
    contract: fixture("contract-with-representatives") as JsonApiResource,
    nationalAddress: fixture("national-address") as EjarBody,
    financial: fixture("financial") as EjarBody,
    invoices: fixture("invoices") as EjarBody,
    propertiesBody: fixture("properties") as EjarBody,
    unitsBody: fixture("units") as EjarBody,
  });

test("lessor_representative and tenant_representative are pulled onto the records", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  const p = previewWithReps();

  // The mapper must separate each side into the real party + its agent.
  const lessors = p.parties.lessors;
  const tenants = p.parties.tenants;
  assert.equal(lessors.length, 2, "fixture has a lessor and a lessor_representative");
  assert.equal(tenants.length, 2, "fixture has a tenant and a tenant_representative");
  assert.equal(lessors.find((x) => x.role === "lessor_representative")?.isRepresentative, true);
  assert.equal(tenants.find((x) => x.role === "tenant_representative")?.isRepresentative, true);
  assert.equal(lessors.find((x) => x.role === "lessor")?.isRepresentative, false);

  const rows = await inRollback(async (tx) => {
    const ctl = new EjarController(tx as never, null as never, null as never, null as never);
    const res = (await ctl.import({ id: userId } as never, payload(p, "TEST-EJAR-REPS"))) as never as {
      landlordId: number; tenantId: number; id: number;
    };
    const one = async (t: never, col: never, id: number) =>
      (await (tx as never as typeof db).select().from(t).where(eq(col, id)).limit(1))[0];
    return {
      landlord: await one(ownersTable as never, ownersTable.id as never, res.landlordId),
      tenant: await one(tenantsTable as never, tenantsTable.id as never, res.tenantId),
      contract: await one(contractsTable as never, contractsTable.id as never, res.id),
    };
  });

  const landlord = rows.landlord as Record<string, unknown>;
  const tenant = rows.tenant as Record<string, unknown>;
  const contract = rows.contract as Record<string, unknown>;

  // Landlord row = the real lessor; the agent lands in the wakala block that
  // the owner wizard and details screen already render.
  assert.equal(landlord.name, "هند محمد بن شجاع العتيبي");
  assert.equal(landlord.isRepresentative, true, "the landlord HAS a representative");
  assert.equal(landlord.originalOwnerName, "روابي عبدالله محمد السلامه");
  assert.equal(landlord.originalOwnerIdNumber, "1082683978");
  assert.ok(landlord.originalOwnerPhone, "the agent's phone is carried across");

  // Same shape on the tenant side.
  assert.equal(tenant.name, "فهده غنيم عبدالله الغنيم");
  assert.equal(tenant.isRepresentative, true, "the tenant HAS a representative");
  assert.equal(tenant.originalTenantName, "امجد عبدالمجيد احمد قصاص");
  assert.equal(tenant.originalTenantIdNumber, "1025071984");

  // The contract keeps the tenant's representative in its own columns too.
  assert.equal(contract.repName, "امجد عبدالمجيد احمد قصاص");
  assert.equal(contract.repIdNumber, "1025071984");
  // …and the landlord fields stay the REAL lessor, not the agent.
  assert.equal(contract.landlordName, "هند محمد بن شجاع العتيبي");
});

test("a party list of only representatives does not file someone as their own agent", () => {
  // 5 of 2120 UAT contracts list lessors with no plain `lessor` role. There the
  // representative IS the only party we have, so it must not also be written
  // into the original* block as if it represented itself.
  const raw = JSON.parse(JSON.stringify(fixture("contract-with-representatives"))) as JsonApiResource;
  const attrs = raw.attributes as Record<string, unknown>;
  attrs.lessors = (attrs.lessors as Array<Record<string, unknown>>).filter((l) => l.role === "lessor_representative");

  const p = mapEjarToContract({
    contract: raw,
    propertiesBody: fixture("properties") as EjarBody,
    unitsBody: fixture("units") as EjarBody,
  });
  assert.equal(p.parties.lessors.length, 1);
  assert.equal(p.parties.lessors[0].isRepresentative, true);
  // The flat contract payload still names them as the landlord — they are the
  // only lessor-side party Ejar gave us.
  assert.equal(p.contract.landlordName, p.parties.lessors[0].name);
});

test("re-import reuses every entity instead of duplicating", { skip: !HAS_DB && "DATABASE_URL not set" }, async () => {
  assert.ok(userId, "needs at least one user row");
  const p = preview();

  const { first, second } = await inRollback(async (tx) => {
    const ctl = new EjarController(tx as never, null as never, null as never, null as never);
    const a = (await ctl.import({ id: userId } as never, payload(p, "TEST-EJAR-SPEC-A"))) as never as Record<string, never>;
    const b = (await ctl.import({ id: userId } as never, payload(p, "TEST-EJAR-SPEC-B"))) as never as Record<string, never>;
    return { first: a, second: b };
  });

  const f = first as never as { propertyId: number; unitIds: number[]; landlordId: number; deedId: number; tenantId: number };
  const s = second as never as typeof f & { created: string[]; linked: string[] };

  assert.equal(s.propertyId, f.propertyId);
  assert.equal(s.unitIds[0], f.unitIds[0]);
  assert.equal(s.landlordId, f.landlordId);
  assert.equal(s.deedId, f.deedId);
  assert.equal(s.tenantId, f.tenantId);
  assert.deepEqual(s.created, ["contract"], "only a new contract is created on re-import");
  assert.deepEqual(
    [...s.linked].sort(),
    ["deed", "landlord", "property", "tenant", "unit"],
    "everything else is reused",
  );
});
