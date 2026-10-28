/**
 * Ejar import — one contract per account + contract number, even when the
 * Import button is double-clicked (QA 27 Oct 2026, bug 2), and a refused
 * lookup's call-log bodies are withheld in the real table (bug 1).
 *
 * Runs on a throwaway schema (FV2_TEST_DATABASE_URL, localhost only — see
 * finance-v2/__tests__/with-db.ts) with the full legacy schema and the REAL
 * runner + writer. The plan is built by the real EjarImportService from a
 * saved lookup in memory. Every value is synthetic (public repo).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../finance-v2/__tests__/with-db";
import { STG, world, baladyOk, fixture } from "./__tests__/lookup-harness";
import { EjarImportRunner, EjarImportService, type EjarImportRunnerLike } from "./ejar.import.service";
import type { ImportPlan, ImportResult } from "./ejar.import.writer";
import { DrizzleEjarLookupStore } from "./ejar.lookup.store";
import { EjarLogService } from "./ejar.log.service";

const N = "20000000001";
const U = "22222222-3333-4444-8555-666666666666";
const ACCOUNT = 7101;

async function planFor(): Promise<ImportPlan> {
  const w = world();
  w.store.lookupRows.push({ id: 8, category: "property_type", key: "plaza" });
  try {
    w.setRespond((url) => {
      if (url === `${STG}/v1/ejar-services/contracts/${N}/invoices`) return baladyOk(fixture("lookup-invoices-prod"));
      const list = url.match(/\/v1\/ejar-services\/contracts\?(.*)$/);
      if (list && new URLSearchParams(list[1]).get("contract_ids") === U) return baladyOk(fixture("lookup-contracts-prod"));
      throw new Error(`unexpected fetch ${url}`);
    });
    const user = { id: ACCOUNT } as never;
    await w.svc.lookup(user, { contract_number: N });
    let plan: ImportPlan | null = null;
    const recorder: EjarImportRunnerLike = {
      run: async (_o: number, p: ImportPlan): Promise<ImportResult> => { plan = p; return {} as ImportResult; },
    };
    await new EjarImportService(w.store, recorder).import(user, { contract_number: N });
    return plan!;
  } finally {
    w.restore();
  }
}

describe("Ejar import: a double click writes one contract (database)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let db: any;
  before(async () => {
    t = await withDb({ legacy: "full", migrate: false });
    db = drizzle(t.pool, { schema });
    await t.pool.query(
      `insert into users (id, email, password_hash, name, user_type) values ($1, 'ejar-once@example.test', 'x', 'Synthetic Office', 'company')`,
      [ACCOUNT],
    );
    // The in-memory store's lookup options, under the same ids, so the plan's lookup FKs resolve.
    for (const [id, category, key] of [
      [1, "property_type", "apartment_building"], [2, "property_usage", "commercial"], [3, "property_usage", "families"],
      [4, "property_usage", "mixed"], [5, "unit_type", "shop"], [6, "city", "riyadh"], [7, "property_usage", "individuals"],
      [8, "property_type", "plaza"],
    ] as const) {
      await t.pool.query(`insert into lookups (id, category, key, label_ar, label_en) values ($1, $2, $3, $3, $3)`, [id, category, key]);
    }
  });
  after(async () => { await t?.drop(); });

  it("two concurrent imports of the same contract: one 201, one 409 already_imported, one contract", async () => {
    const plan = await planFor();
    const runner = new EjarImportRunner(db);
    const results = await Promise.allSettled([runner.run(ACCOUNT, plan), runner.run(ACCOUNT, plan)]);
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<ImportResult>[];
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1, "exactly one import succeeds");
    assert.equal(bad.length, 1);
    const err = bad[0].reason as { getStatus?: () => number; getResponse?: () => any };
    assert.equal(err.getStatus?.(), 409, `a duplicate is a 409, not a 500 (${String(bad[0].reason)})`);
    assert.equal(err.getResponse?.().code, "already_imported");
    assert.equal(err.getResponse?.().contractId, ok[0].value.contractId, "and names the contract the first one wrote");

    const { rows } = await t.pool.query(`select id, monthly_rent::text as rent from contracts where user_id = $1`, [ACCOUNT]);
    assert.equal(rows.length, 1, "one contract");
    const props = await t.pool.query(`select count(*)::int as n from properties where user_id = $1`, [ACCOUNT]);
    assert.equal(props.rows[0].n, 1, "the loser's property/unit/parties rolled back with it");
    const pays = await t.pool.query(
      `select description, amount::text as amount, vat_enabled from payments where contract_id = $1 order by due_date, description nulls first`, [rows[0].id]);
    // One schedule: Ejar's 6 bills (39,687 each here), each split into its
    // rent and the extra Ejar bills on top, which carry no VAT (ejar.rent.ts).
    const services = pays.rows.filter((p) => p.description === "مبالغ إضافية من إيجار");
    const rent = pays.rows.filter((p) => p.description !== "مبالغ إضافية من إيجار");
    assert.equal(pays.rows.length, 12, "one schedule");
    assert.equal(rent.length, 6);
    assert.equal(services.length, 6);
    assert.ok(rent.every((p) => p.vat_enabled === true), "rent carries the VAT");
    assert.ok(services.every((p) => p.amount === "3174.50" && p.vat_enabled === false), "services carry none");
    const sum = pays.rows.reduce((s, p) => s + Number(p.amount), 0);
    assert.equal(Math.round(sum * 100) / 100, 6 * 39687, "rent + services = Ejar's bills");
    assert.equal(Number(rows[0].rent), 5291.67, "rent is Ejar's 63,500 a year");
  });

  it("a third import after the first committed is a 409 too", async () => {
    const plan = await planFor();
    await assert.rejects(new EjarImportRunner(db).run(ACCOUNT, plan), (e: any) => e?.getStatus?.() === 409 && e.getResponse().code === "already_imported");
  });

  it("a refused lookup's call-log rows come back withheld from GET /ejar/logs/:id", async () => {
    const { rows: [row] } = await t.pool.query(
      `insert into ejar_api_logs (user_id, env, endpoint, method, url, status, response_body)
       values ($1, 'balady-replay', 'getRentalContracts', 'GET', 'https://example.invalid', 200, '{"name":"Synthetic Secret Party"}') returning id`,
      [ACCOUNT],
    );
    await new DrizzleEjarLookupStore(db).withholdLogBodies([row.id], "party_mismatch");
    const got = await new EjarLogService(db).get(row.id, ACCOUNT);
    assert.deepEqual(got?.responseBody, { withheld: "party_mismatch" });
    assert.equal(got?.bodyTruncated, true);
    assert.ok(!JSON.stringify(got).includes("Synthetic Secret Party"));
  });
});
