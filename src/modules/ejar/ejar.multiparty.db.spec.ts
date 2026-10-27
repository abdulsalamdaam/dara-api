/**
 * Ejar multi-party import against a real schema (FV2_TEST_DATABASE_URL,
 * localhost only): the REAL runner + writer write exactly one landlord and
 * one tenant — the chosen main ones — and keep the other principals on the
 * contract as `co_parties` only. A co-landlord never becomes an owners row,
 * so the عقاري landlord cap (1) is not touched by it. Synthetic data only.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../finance-v2/__tests__/with-db";
import { STG, world, baladyOk, fixture } from "./__tests__/lookup-harness";
import { EjarImportRunner, EjarImportService, type EjarImportRunnerLike } from "./ejar.import.service";
import type { ImportPlan, ImportResult } from "./ejar.import.writer";

const N = "20000000001";
const U = "22222222-3333-4444-8555-666666666666";
const OFFICE = 7201;
const AQARI = 7202;

async function planFor(account: number, body: Record<string, unknown>, pin?: { role: "landlord"; idNumber: string }): Promise<ImportPlan> {
  const w = world();
  w.store.lookupRows.push({ id: 8, category: "property_type", key: "plaza" });
  if (pin) w.store.partyChecks[account] = pin;
  try {
    w.setRespond((url) => {
      if (url === `${STG}/v1/ejar-services/contracts/${N}/invoices`) return baladyOk(fixture("lookup-invoices-prod"));
      const list = url.match(/\/v1\/ejar-services\/contracts\?(.*)$/);
      if (list && new URLSearchParams(list[1]).get("contract_ids") === U) return baladyOk(fixture("lookup-contracts-multiparty"));
      throw new Error(`unexpected fetch ${url}`);
    });
    const user = { id: account } as never;
    await w.svc.lookup(user, { contract_number: N });
    let plan: ImportPlan | null = null;
    const recorder: EjarImportRunnerLike = { run: async (_o, p): Promise<ImportResult> => { plan = p; return {} as ImportResult; } };
    await new EjarImportService(w.store, recorder).import(user, { contract_number: N, ...body });
    return plan!;
  } finally {
    w.restore();
  }
}

describe("Ejar multi-party import (database)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let db: any;
  before(async () => {
    t = await withDb({ legacy: "full", migrate: false });
    db = drizzle(t.pool, { schema });
    await t.pool.query(
      `insert into users (id, email, password_hash, name, user_type, package_plan) values
        ($1, 'ejar-multi-office@example.test', 'x', 'Synthetic Office', 'company', 'professional'),
        ($2, 'ejar-multi-aqari@example.test', 'x', 'Synthetic Aqari', 'individual', 'basic')`,
      [OFFICE, AQARI],
    );
    for (const [id, category, key] of [
      [1, "property_type", "apartment_building"], [2, "property_usage", "commercial"], [3, "property_usage", "families"],
      [4, "property_usage", "mixed"], [5, "unit_type", "shop"], [6, "city", "riyadh"], [7, "property_usage", "individuals"],
      [8, "property_type", "plaza"],
    ] as const) {
      await t.pool.query(`insert into lookups (id, category, key, label_ar, label_en) values ($1, $2, $3, $3, $3)`, [id, category, key]);
    }
  });
  after(async () => { await t?.drop(); });

  const count = async (table: "owners" | "tenants", account: number) =>
    (await t.pool.query(`select count(*)::int as n from ${table} where user_id = $1 and deleted_at is null`, [account])).rows[0].n as number;

  it("Office, 2nd lessor + 2nd tenant as main: one landlord, one tenant, the others only in co_parties", async () => {
    const plan = await planFor(OFFICE, { landlord: { mainIndex: 1 }, tenant: { mainIndex: 1 } });
    const res = await new EjarImportRunner(db).run(OFFICE, plan);

    const owners = (await t.pool.query(`select id, id_number, name from owners where user_id = $1`, [OFFICE])).rows;
    assert.deepEqual(owners.map((o: any) => o.id_number), ["2000000302"], "only the main landlord is a record");
    const tenants = (await t.pool.query(`select national_id from tenants where user_id = $1`, [OFFICE])).rows;
    assert.deepEqual(tenants.map((r: any) => r.national_id), ["1000000303"], "only the main tenant is a record");

    const { rows: [c] } = await t.pool.query(
      `select tenant_id, landlord_id_number, co_parties from contracts where id = $1`, [res.contractId],
    );
    assert.equal(c.tenant_id, res.tenantId);
    assert.equal(c.landlord_id_number, "2000000302");
    assert.deepEqual(c.co_parties.map((p: any) => [p.role, p.idNumber ?? p.crNumber, p.referenceOnly]), [
      ["co_landlord", "1000000301", true],
      ["co_tenant", "1010999002", true],
    ]);
    // Nothing anywhere else names a co-party as a landlord or tenant.
    const leak = await t.pool.query(
      `select 1 from owners where id_number in ('1000000301', '1010999002')
        union all select 1 from tenants where national_id in ('1000000301', '1010999002')`,
    );
    assert.equal(leak.rows.length, 0);
  });

  it("re-import is still refused once (409 already_imported)", async () => {
    const plan = await planFor(OFFICE, {});
    await assert.rejects(new EjarImportRunner(db).run(OFFICE, plan), (e: any) => e?.getStatus?.() === 409 && e.getResponse().code === "already_imported");
    assert.equal(await count("owners", OFFICE), 1);
  });

  it("عقاري at its one-landlord cap: its own lessor (Ejar's 2nd) is the main one, the co-owner is not counted", async () => {
    await t.pool.query(
      `insert into owners (user_id, name, type, id_number, status, is_account_holder) values ($1, 'Synthetic Own Landlord', 'individual', '2000000302', 'active', true)`,
      [AQARI],
    );
    const plan = await planFor(AQARI, {}, { role: "landlord", idNumber: "2000000302" });
    const res = await new EjarImportRunner(db).run(AQARI, plan);
    assert.equal(await count("owners", AQARI), 1, "still exactly one landlord: the co-owner is not a record");
    const own = (await t.pool.query(`select id from owners where user_id = $1 and is_account_holder`, [AQARI])).rows[0];
    assert.equal(res.landlordId, own.id, "linked to the account's own landlord");
    const { rows: [c] } = await t.pool.query(`select co_parties from contracts where id = $1`, [res.contractId]);
    assert.deepEqual(c.co_parties.filter((p: any) => p.role === "co_landlord").map((p: any) => p.idNumber), ["1000000301"]);
  });
});
