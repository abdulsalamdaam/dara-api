import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { BackfillService } from "./backfill/backfill.service";
import { LedgerStartService } from "./ledger-start.service";
import { FinanceSetupService } from "./setup.service";
import { ChartService } from "./chart.service";
import { PeriodsService } from "./periods.service";
import { FinanceV2AutoProvisionService } from "./auto-provision.service";
import { riyadhToday } from "./dates";

/**
 * Documents issued before an account's accounting was on go into the books
 * (account holder, 2026-10-20). The staging case: a started ledger whose plan
 * was downgraded (accounting effectively off — the hooks enqueue nothing),
 * documents confirmed meanwhile, then an upgrade. The catch-up
 * (FinanceV2AutoProvisionService.catchUp, run by the upgrade trigger, the
 * admin route and the CLI) posts them through the existing `catchup` backfill.
 * Real legacy routes, throwaway local Postgres, synthetic rows only.
 */
const P = 7101;
const today = riyadhToday();
const firstOf = (monthsFromNow: number) => {
  const [y, m] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + monthsFromNow, 1)).toISOString().slice(0, 10);
};
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "contracts.view", "contracts.write"];
const userFor = (u: number) => ({ ...userOf(u), permissions: PERMS });
const customer = { name: "Synthetic Customer Y", type: "individual", email: "1000071011@example.test", phone: "0500000009", idNumber: "1000071011" };

describe("finance v2 catch-up: documents issued while accounting was off reach the ledger (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let backfill: BackfillService;
  let auto: FinanceV2AutoProvisionService;
  const ids = { inv: 0, crn: 0, dbn: 0, col: 0, counted: 0, skipped: 0 };
  const q = (sql: string, p: unknown[] = []) => env.q(sql, p);
  const n = async (sql: string, p: unknown[] = [P]) => Number((await q(sql, p))[0].n);
  const snapshot = async () => ({
    entries: await n(`select count(*) n from journal_entries where user_id = $1`),
    outbox: await n(`select count(*) n from ledger_outbox where user_id = $1`),
    runs: await n(`select count(*) n from finance_backfill_runs where user_id = $1`),
    events: await n(`select count(*) n from finance_settings_events where account_user_id = $1`),
  });
  const setPlan = async (plan: string) => {
    await q(`update users set package_plan = $2 where id = $1`, [P, plan]);
    env.flag.invalidate(P);
  };

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, P);
    // The account holder can issue its own documents (as billing-docs.db.spec.ts links it).
    await q(
      `insert into zatca_credentials (user_id, owner_id, active_environment, seller_name, seller_vat_number, seller_street, seller_building_no,
         seller_district, seller_city, seller_postal_zone, serial_number, organization_identifier, organization_unit_name, location_address,
         industry_category, common_name, sandbox_private_key_enc, sandbox_binary_security_token, sandbox_secret_enc, sandbox_cert_pem)
       select user_id, $2, active_environment, 'Synthetic Holder', '310000000000003', seller_street, seller_building_no, seller_district, seller_city,
         seller_postal_zone, serial_number, '310000000000003', organization_unit_name, location_address, industry_category, common_name,
         sandbox_private_key_enc, sandbox_binary_security_token, sandbox_secret_enc, sandbox_cert_pem
         from zatca_credentials where user_id = $1 and owner_id = $3`, [P, s.holder, s.agent]);
    await enableV2(env, P, "manager");
    const periods = new PeriodsService(env.t.pool);
    backfill = new BackfillService(env.t.pool, env.engine, env.worker, new LedgerStartService(env.flag, env.worker), env.recognizer,
      new FinanceSetupService(new ChartService(env.t.pool), periods));
    auto = new FinanceV2AutoProvisionService(env.t.pool, env.flag, env.setup, backfill);

    // ── The plan stops including accounting (an Aqari-like plan): effectively off, the stored flag untouched ──
    await setPlan("basic");
    assert.equal(await env.flag.isOn(P), false);
    const u = userFor(P);
    const inv: any = await env.billing.create(u, {
      type: "invoice", issueDate: today, client: customer,
      items: [{ description: "خدمة", quantity: 1, unitPrice: 1000, amount: 1000, vat: true }], total: 1150,
    });
    const invAp: any = await env.billing.approve(u, String(inv.id), { confirmations: { tenantNoVat: true } });
    const crn: any = await env.billing.create(u, {
      type: "credit", billingReference: invAp.number ?? inv.number, issueDate: today, client: customer,
      items: [{ description: "خصم", quantity: 1, unitPrice: 100, amount: 100, vat: true }], total: 115,
    });
    await env.billing.approve(u, String(crn.id), {});
    const dbn: any = await env.billing.create(u, {
      type: "debit", billingReference: invAp.number ?? inv.number, issueDate: today, client: customer,
      items: [{ description: "مطالبة إضافية", quantity: 1, unitPrice: 200, amount: 200, vat: true }], total: 230,
    });
    await env.billing.approve(u, String(dbn.id), {});
    await env.billing.collect(u, String(inv.id), { method: "cash", paidDate: today });
    Object.assign(ids, { inv: Number(inv.id), crn: Number(crn.id), dbn: Number(dbn.id) });
    ids.col = Number((await q(`select id from payment_collections where invoice_id = $1`, [inv.id]))[0].id);
    // Two contracts with installments already due: one counts its outside-platform rows, one SKIPS them (0084).
    const contract = (unitId: number, mode: "count" | "skip") => env.contracts.create(u, {
      unitIds: [unitId], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(-4), endDate: firstOf(8),
      monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false, settledExternalUntil: firstOf(-2), externalSettlementMode: mode,
    });
    ids.counted = Number((await contract(s.unitA1, "count")).id);
    ids.skipped = Number((await contract(s.unitA2, "skip")).id);
  });
  after(async () => { await env?.t.drop(); });

  it("while the plan keeps accounting off, nothing about those documents is queued or posted", async () => {
    const r = await q(`select count(*)::int n from ledger_outbox where user_id = $1 and source_type in ('simple_invoice','payment_collection','payment')`, [P]);
    assert.equal(r[0].n, 0);
  });

  it("an automatic catch-up needs the plan; the sweep and /status never run it", async () => {
    const before = await snapshot();
    assert.equal((await auto.catchUp(P, "spec", { automatic: true })).outcome, "not_eligible");
    await setPlan("professional"); // entitled again (the upgrade)
    assert.equal((await auto.ensure(P, "sweep")).outcome, "not_eligible");
    assert.equal((await auto.ensure(P, "status")).outcome, "not_eligible");
    assert.deepEqual(await snapshot(), before);
  });

  it("dry run lists what would be posted — documents, the receipt and due installments, never a SKIP contract's external rows — and writes nothing", async () => {
    const before = await snapshot();
    const r = await auto.catchUp(P, "spec", { dryRun: true });
    assert.equal(r.outcome, "would_post");
    assert.equal(r.missing, r.planned.length);
    const has = (t: string, id: number, ev: string) => r.planned.some((p) => p.sourceType === t && p.sourceId === id && p.event === ev);
    assert.ok(has("simple_invoice", ids.inv, "confirmed"), "the invoice");
    assert.ok(has("simple_invoice", ids.crn, "confirmed"), "the credit note");
    assert.ok(has("simple_invoice", ids.dbn, "confirmed"), "the debit note");
    assert.ok(r.planned.some((p) => p.sourceType === "payment_collection" && p.sourceId === ids.col), "the receipt");

    const pays = await q(`select id, status::text as status, contract_id from payments where contract_id = any($1::int[]) and due_date < $2::date and deleted_at is null`,
      [[ids.counted, ids.skipped], today]);
    const of = (cid: number, st?: string) => pays.filter((p: any) => Number(p.contract_id) === cid && (!st || p.status === st)).map((p: any) => Number(p.id));
    assert.ok(of(ids.counted, "settled_external").length > 0, "fixture: counted external rows exist");
    for (const id of of(ids.counted, "settled_external")) assert.ok(has("payment", id, "settled_external"), `counted external row ${id} is settled (E33)`);
    const skippedExt = of(ids.skipped, "settled_external");
    assert.ok(skippedExt.length > 0, "fixture: skipped external rows exist");
    assert.ok(!r.planned.some((p) => p.sourceType === "payment" && skippedExt.includes(p.sourceId)), "a SKIP contract's external rows stay out");
    for (const p of r.planned) assert.ok(p.rule && p.date, JSON.stringify(p));

    assert.deepEqual(await snapshot(), before, "a dry run writes nothing, not even a backfill-runs row");
  });

  it("a catch-up on a cutover ledger keeps to its go-live date (history before it is in the opening)", async () => {
    await q(`update finance_settings set ledger_go_live_date = $2::date + 400 where account_user_id = $1`, [P, today]);
    try {
      assert.equal((await auto.catchUp(P, "spec", { dryRun: true })).outcome, "up_to_date");
      const before = await n(`select count(*) n from journal_entries where user_id = $1`);
      const run = await backfill.run({ userId: P, actorUserId: 0, mode: "catchup", dryRun: false, allowLate: true });
      assert.equal(run.events.new, 0, "the real catchup run adds nothing before go-live either");
      assert.equal(await n(`select count(*) n from journal_entries where user_id = $1`), before);
    } finally {
      await q(`update finance_settings set ledger_go_live_date = null where account_user_id = $1`, [P]);
    }
  });

  it("the upgrade trigger posts them at their own dates; the books balance", async () => {
    const r = await auto.ensure(P, "subscription_paid");
    assert.equal(r.outcome, "caught_up", JSON.stringify(r));
    assert.ok(r.realRunId);
    const posted = async (t: string, id: number, ev: string) =>
      (await q(`select status from ledger_outbox where user_id = $1 and source_type = $2 and source_id = $3 and event = $4`, [P, t, id, ev]))[0]?.status;
    for (const id of [ids.inv, ids.crn, ids.dbn]) assert.equal(await posted("simple_invoice", id, "confirmed"), "posted", `document ${id}`);
    assert.equal(await posted("payment_collection", ids.col, "collected"), "posted");
    assert.equal(await n(`select count(*) n from ledger_outbox where user_id = $1 and status in ('pending','failed')`), 0);
    const [tb] = await q(`select coalesce(sum(debit - credit), 0)::text as d from journal_lines where user_id = $1`, [P]);
    assert.equal(tb.d, "0.00");
    const skipped = await q(`select p.id from payments p where p.contract_id = $1 and p.status::text = 'settled_external'`, [ids.skipped]);
    assert.equal(await n(`select count(*) n from ledger_outbox where user_id = $1 and source_type = 'payment' and source_id = any($2::int[])`,
      [P, skipped.map((x: any) => Number(x.id))]), 0, "a SKIP contract's external rows are still out");
    const [ev] = await q(`select actor_user_id, new_value from finance_settings_events where account_user_id = $1 and field = 'catch_up' order by id desc limit 1`, [P]);
    assert.equal(ev.actor_user_id, 0);
    assert.equal(ev.new_value.outcome, "caught_up");
    assert.equal(ev.new_value.trigger, "subscription_paid");
  });

  it("is idempotent: a second trigger, an admin catch-up or a repair run posts nothing twice and writes nothing", async () => {
    const before = await snapshot();
    assert.equal((await auto.ensure(P, "subscription_paid")).outcome, "up_to_date");
    const r = await auto.catchUp(P, "admin", { actorUserId: 1 });
    assert.equal(r.outcome, "up_to_date");
    assert.equal(r.missing, 0);
    assert.deepEqual(await snapshot(), before);
    const run = await backfill.run({ userId: P, actorUserId: 0, mode: "catchup", dryRun: false, allowLate: true, origin: "repair" });
    assert.equal(run.events.new, 0);
    assert.equal(await n(`select count(*) n from journal_entries where user_id = $1`), before.entries);
  });

  it("an admin can catch up a plan-locked account; nothing happens on a ledger that never started", async () => {
    await setPlan("basic");
    assert.equal((await auto.catchUp(P, "admin", { dryRun: true, actorUserId: 1 })).outcome, "up_to_date");
    await setPlan("professional");
    await q(`insert into users (id, email, password_hash, name, user_type) values (7102, 'p2@example.test', 'x', 'Synthetic', 'company')`);
    assert.equal((await auto.catchUp(7102, "admin", { dryRun: true, actorUserId: 1 })).outcome, "not_eligible");
  });
});
