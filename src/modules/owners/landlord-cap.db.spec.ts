import "reflect-metadata";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../finance-v2/__tests__/with-db";
import { OwnersModule } from "./owners.module";
import { ImportModule } from "../import/import.module";
import { PackageModule } from "../package/package.module";
import { EjarImportRunner } from "../ejar/ejar.import.service";
import type { ImportPlan } from "../ejar/ejar.import.writer";

/**
 * عقاري (basic) holds exactly one landlord (CONTRACT2 §5), on every path that
 * writes an owners row — the REAL controllers / import runner against a
 * throwaway Postgres schema. Synthetic data only (public repo).
 */
const ctl = (mod: unknown) => (Reflect as any).getMetadata("controllers", mod)[0];
const userOf = (id: number, ownerUserId: number | null = null) => ({ id, ownerUserId, email: `cap-${id}@example.test`, role: "user", permissions: [] }) as any;

const BASIC = 8801;      // basic, one landlord (its own)
const EMPTY = 8802;      // basic, no landlord yet
const OVER = 8803;       // basic, grandfathered with three landlords
const PRO = 8804;        // professional
const EMP = 8805;        // employee of BASIC
const NOID = 8806;       // basic, own landlord row has no ID number

async function caught(p: Promise<unknown>): Promise<{ status: number; body: any } | null> {
  try { await p; return null; } catch (e: any) {
    if (typeof e?.getStatus === "function") return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
}

const party = (name: string, idNumber: string | null) => ({
  group: "lessor", role: null, isRepresentative: false, name, partyType: "individual", idType: null,
  idNumber, phone: null, email: null, unifiedNumber: null, registrationNumber: null, organizationType: null, vat: null,
}) as any;

const plan = (cn: string, lessor: any): ImportPlan => ({
  contractNumber: cn,
  landlord: { party: lessor, rep: null },
  tenant: { party: { ...party(`Synthetic Tenant ${cn}`, `2${cn.padStart(9, "0")}`), group: "tenant" }, rep: null },
  property: { create: { p: { name: `Synthetic Property ${cn}` }, overrides: { ejarSource: null }, deed: null } },
  unit: { create: { u: { unitNumber: "1" }, overrides: { ejarSource: null, status: "rented" } } },
  contract: {
    startDate: "2026-01-01", endDate: "2026-12-31", status: "active", signingDate: null, monthlyRent: "1000",
    customSchedule: [], frequencyHint: "monthly", depositAmount: null, vatFallback: false, notes: null, ejarRaw: null,
  },
  additionalFees: [],
  invoices: [],
});

describe("landlord cap — every owners-writing path", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let db: any;
  let owners: any, bulk: any, pkg: any, runner: EjarImportRunner;
  const q = async (sql: string, p: unknown[] = []) => (await t.pool.query(sql, p)).rows;
  const count = async (table: string, u: number) => Number((await q(`select count(*)::int c from ${table} where user_id = $1 and deleted_at is null`, [u]))[0].c);

  before(async () => {
    t = await withDb({ legacy: "full", migrate: false });
    db = drizzle(t.pool, { schema });
    owners = new (ctl(OwnersModule))(db, {} as never);
    bulk = new (ctl(ImportModule))(db);
    pkg = new (ctl(PackageModule))(db);
    runner = new EjarImportRunner(db);
    const user = (id: number, plan: string, ownerUserId: number | null = null) =>
      q(`insert into users (id, email, password_hash, name, package_plan, owner_user_id) values ($1, $2, 'x', 'Synthetic', $3, $4)`,
        [id, `cap-${id}@example.test`, plan, ownerUserId]);
    await user(BASIC, "basic"); await user(EMPTY, "basic"); await user(OVER, "basic"); await user(PRO, "professional");
    await user(EMP, "broker", BASIC); await user(NOID, "basic");
    const owner = (u: number, name: string, id: string | null, holder = false) =>
      q(`insert into owners (user_id, name, id_number, is_account_holder) values ($1, $2, $3, $4)`, [u, name, id, holder]);
    await owner(BASIC, "Synthetic Self", "1000000001", true);
    for (const i of [1, 2, 3]) await owner(OVER, `Synthetic Old ${i}`, `100000001${i}`, i === 1);
    await owner(NOID, "Synthetic Nameonly", null, true);
    // a soft-deleted row never counts
    await q(`insert into owners (user_id, name, deleted_at) values ($1, 'Synthetic Deleted', now())`, [EMPTY]);
  });
  after(async () => { await t?.drop(); });

  it("POST /owners: the first landlord is allowed, the second refused with the exact body", async () => {
    await owners.create(userOf(EMPTY), { name: "Synthetic First", isDraft: true });
    const r = await caught(owners.create(userOf(EMPTY), { name: "Synthetic Second", isDraft: true }));
    assert.equal(r?.status, 403);
    assert.deepEqual(Object.keys(r!.body).sort(), ["code", "limit", "message", "requiredPlan", "statusCode"]);
    assert.equal(r!.body.code, "PLAN_LIMIT_LANDLORDS");
    assert.equal(r!.body.requiredPlan, "professional");
    assert.equal(r!.body.limit, 1);
    assert.equal(await count("owners", EMPTY), 1);
  });

  it("an employee of a basic account is held to the OWNER's cap", async () => {
    const r = await caught(owners.create(userOf(EMP, BASIC), { name: "Synthetic Via Employee", isDraft: true }));
    assert.equal(r?.body?.code, "PLAN_LIMIT_LANDLORDS");
    assert.equal(await count("owners", BASIC), 1);
  });

  it("an account already over the cap keeps its rows but cannot add", async () => {
    const r = await caught(owners.create(userOf(OVER), { name: "Synthetic Fourth", isDraft: true }));
    assert.equal(r?.body?.code, "PLAN_LIMIT_LANDLORDS");
    assert.equal(await count("owners", OVER), 3);
  });

  it("professional is unlimited", async () => {
    for (const i of [1, 2, 3]) await owners.create(userOf(PRO), { name: `Synthetic Pro ${i}`, isDraft: true });
    assert.equal(await count("owners", PRO), 3);
  });

  it("bulk import: a row with the existing landlord imports, a new landlord's row is refused whole", async () => {
    const res = await bulk.bulk(userOf(BASIC), { rows: [
      { owner_name: "Synthetic Self", owner_id_number: "1000000001", property_name: "Synthetic Bulk A" },
      { owner_name: "Synthetic Stranger", owner_id_number: "1777777777", property_name: "Synthetic Bulk B" },
    ] });
    assert.equal(res.results[0].status, "ok");
    assert.deepEqual(res.results[0].linked, ["owner"]);
    assert.equal(res.results[1].status, "error");
    assert.equal(res.results[1].code, "PLAN_LIMIT_LANDLORDS");
    assert.match(res.results[1].messages[0], /المكاتب العقارية/);
    assert.equal(await count("owners", BASIC), 1);
    assert.equal((await q(`select count(*)::int c from properties where user_id = $1 and name = 'Synthetic Bulk B'`, [BASIC]))[0].c, 0, "nothing of the refused row");
  });

  it("Ejar import: the account's own landlord (same ID) is reused and the contract imports", async () => {
    const r = await runner.run(BASIC, plan("90001", party("Synthetic Self (Ejar spelling)", "1000000001")));
    assert.ok(r.contractId);
    assert.ok(r.linked.includes("landlord"));
    assert.equal(await count("owners", BASIC), 1);
  });

  it("Ejar import: a different landlord at the cap is refused before anything is written", async () => {
    const before = { props: await count("properties", BASIC), tenants: await count("tenants", BASIC) };
    const r = await caught(runner.run(BASIC, plan("90002", party("Synthetic Stranger", "1666666666"))));
    assert.equal(r?.status, 403);
    assert.equal(r?.body?.code, "PLAN_LIMIT_LANDLORDS");
    assert.equal(r?.body?.limit, 1);
    assert.match(r?.body?.message, /مؤجر هذا العقد/);
    assert.equal(await count("owners", BASIC), 1);
    assert.equal(await count("properties", BASIC), before.props);
    assert.equal(await count("tenants", BASIC), before.tenants);
    assert.equal((await q(`select count(*)::int c from contracts where user_id = $1 and contract_number = '90002'`, [BASIC]))[0].c, 0);
  });

  it("Ejar import at the cap: the own row without an ID number is matched by name and gains the ID", async () => {
    const r = await runner.run(NOID, plan("90003", party("Synthetic  Nameonly", "1555555555")));
    assert.ok(r.contractId);
    const rows = await q(`select id_number from owners where user_id = $1 and deleted_at is null`, [NOID]);
    assert.deepEqual(rows.map((x: any) => x.id_number), ["1555555555"]);
  });

  it("Ejar import on an unlimited plan still creates a new landlord", async () => {
    const before = await count("owners", PRO);
    await runner.run(PRO, plan("90004", party("Synthetic Pro Stranger", "1444444444")));
    assert.equal(await count("owners", PRO), before + 1);
  });

  it("GET /me/package exposes the cap as `limits` (and plan.maxLandlords / usage.landlords agree)", async () => {
    const p = await pkg.myPackage(userOf(EMP, BASIC));
    assert.deepEqual(p.limits.landlords, { used: 1, limit: 1, canAdd: false, over: false });
    assert.equal(p.plan.maxLandlords, 1);
    assert.equal(p.usage.landlords, 1);
    assert.deepEqual(p.limits.users, { used: 2, limit: 2, canAdd: false, over: false });
    // basic, unknown cycle → monthly → floor(90 / 12) = 7 Ejar lookups for the period.
    assert.deepEqual(p.limits.ejarLookups, { used: 0, limit: 7, canAdd: true, over: false, resetsAt: null });
    assert.equal(p.ejarEnabled, true);
    const pro = await pkg.myPackage(userOf(PRO));
    assert.equal(pro.limits.landlords.limit, null);
    assert.equal(pro.limits.users.limit, 4);
  });

  it("account limits: an active landlord add-on lets basic add one more; an override down marks it over", async () => {
    await q(`insert into account_limit_addons (account_id, limit_key, quantity, period, status, activation, source, starts_at)
             values ($1, 'landlords', 1, 'subscription_period', 'active', 'immediate', 'admin_free', now() - interval '1 minute')`, [EMPTY]);
    await owners.create(userOf(EMPTY), { name: "Synthetic Via Addon", isDraft: true });
    assert.equal(await count("owners", EMPTY), 2);
    const r = await caught(owners.create(userOf(EMPTY), { name: "Synthetic Past Addon", isDraft: true }));
    assert.equal(r?.body?.limit, 2, "the 403 reports the effective limit");

    await q(`insert into account_limit_overrides (account_id, limit_key, value, note) values ($1, 'landlords', 0, 'synthetic')`, [EMPTY]);
    const p = await pkg.myPackage(userOf(EMPTY));
    assert.deepEqual(p.limits.landlords, { used: 2, limit: 1, canAdd: false, over: true }, "override 0 + add-on 1; nothing deleted");
    assert.equal(p.plan.maxLandlords, 1, "plan.max* stays the package base");
    assert.equal(await count("owners", EMPTY), 2);
  });

  it("an account switched off Ejar reads ejarEnabled: false", async () => {
    await q(`insert into account_limit_overrides (account_id, limit_key, value, note) values ($1, 'ejar.enabled', 0, 'synthetic')`, [PRO]);
    assert.equal((await pkg.myPackage(userOf(PRO))).ejarEnabled, false);
  });
});
