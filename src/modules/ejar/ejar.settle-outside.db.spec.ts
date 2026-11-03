/**
 * Ejar import — the landlord marks installments "settled outside the platform"
 * although Ejar does not report them paid, with an optional payment date
 * (customer request, 3 Nov 2026). Same throwaway-schema harness as
 * ejar.import-once.db.spec.ts: the REAL service builds the plan and the REAL
 * runner + writer persist it. Every value is synthetic (public repo).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../finance-v2/__tests__/with-db";
import { STG, world, baladyOk, fixture } from "./__tests__/lookup-harness";
import { EjarImportRunner, EjarImportService, type EjarImportRunnerLike } from "./ejar.import.service";
import type { ImportPlan, ImportResult } from "./ejar.import.writer";
import { settledOutsideChoices, settledOutsideDate } from "../../common/external-settlement";
import { riyadhToday } from "../../common/payment-status";

const N = "20000000001";
const U = "22222222-3333-4444-8555-666666666666";
const ACCOUNT = 7102;

async function planFor(body: Record<string, unknown>): Promise<ImportPlan> {
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
    await new EjarImportService(w.store, recorder).import(user, { contract_number: N, ...body });
    return plan!;
  } finally {
    w.restore();
  }
}

describe("settled-outside choices (parsing)", () => {
  it("keeps one entry per invoice, drops junk, checks the date shape", () => {
    assert.deepEqual(settledOutsideChoices([{ invoiceId: "a", paidDate: "2026-01-05" }, { invoiceId: "a", paidDate: null }, { nope: 1 }, null, "x"]),
      [{ invoiceId: "a", paidDate: null }]);
    assert.deepEqual(settledOutsideChoices("x"), []);
    assert.throws(() => settledOutsideChoices([{ invoiceId: "a", paidDate: "2026-02-30" }]));
  });
  it("a blank date is the due date; a future one is refused", () => {
    assert.equal(settledOutsideDate(null, "2025-03-01"), "2025-03-01");
    assert.equal(settledOutsideDate("2025-02-20", "2025-03-01"), "2025-02-20");
    assert.equal(settledOutsideDate(null, "2099-01-01"), riyadhToday(), "paid ahead: today");
    const next = new Date(`${riyadhToday()}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    assert.throws(() => settledOutsideDate(next.toISOString().slice(0, 10), "2025-03-01"), (e: any) => e?.getResponse?.().key === "paidDate");
    assert.throws(() => settledOutsideChoices([{ invoiceId: "a", paidDate: next.toISOString().slice(0, 10) }]), "the import refuses it up front");
  });
});

describe("Ejar import: the landlord's own settled-outside marks (database)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let db: any;
  before(async () => {
    t = await withDb({ legacy: "full", migrate: false });
    db = drizzle(t.pool, { schema });
    await t.pool.query(
      `insert into users (id, email, password_hash, name, user_type) values ($1, 'ejar-settle@example.test', 'x', 'Synthetic Office', 'company')`,
      [ACCOUNT],
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

  it("marks only the chosen rent rows, with the date given or the due date", async () => {
    const probe = await planFor({});
    const unpaid = probe.invoices.filter((i) => !/paid|مدفوع/i.test(String(i.status ?? "")) || /unpaid|غير/i.test(String(i.status ?? "")));
    assert.ok(unpaid.length >= 2, `the fixture has unpaid invoices (${probe.invoices.map((i) => i.status).join(", ")})`);
    const [a, b] = unpaid;
    const plan = await planFor({ settledOutside: [{ invoiceId: a.id, paidDate: "2025-01-02" }, { invoiceId: b.id }, { invoiceId: "not-an-invoice" }] });
    assert.equal(plan.settledOutside?.length, 3);
    const res = await new EjarImportRunner(db).run(ACCOUNT, plan);

    const { rows } = await t.pool.query(
      `select due_date::text as due, status::text as status, paid_date::text as paid, description from payments where contract_id = $1 order by due_date, id`,
      [res.contractId],
    );
    const settled = rows.filter((r) => r.status === "settled_external");
    const due = (inv: { dueDate: string | null }) => String(inv.dueDate).slice(0, 10);
    const rowA = settled.find((r) => r.due === due(a));
    const rowB = settled.find((r) => r.due === due(b));
    assert.equal(rowA?.paid, "2025-01-02", "the date the landlord gave");
    assert.equal(rowB?.paid, due(b) < riyadhToday() ? due(b) : riyadhToday(), "blank → its due date, or today when it is not due yet");
    assert.ok(settled.every((r) => /^فاتورة إيجار/.test(r.description ?? "")), "only rent rows — the services fee on the same date stays open");
    const ejarPaid = probe.invoices.length - unpaid.length;
    assert.equal(settled.length, 2 + ejarPaid, "the two chosen + what Ejar reported paid, nothing else");
  });
});
