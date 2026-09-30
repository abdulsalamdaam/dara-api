import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../__tests__/with-db";
import { enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "../__tests__/legacy-env";
import { withTx } from "../db";
import { BackfillService, type BackfillSummary } from "./backfill.service";
import { LedgerStartService } from "../ledger-start.service";
import { FinanceSetupService } from "../setup.service";
import { ChartService } from "../chart.service";
import { PeriodsService } from "../periods.service";

/**
 * Step 6 (DESIGN §6, §11.3-b): the backfill against a synthetic company whose
 * history was written through the REAL legacy routes while Finance v2 was off.
 *
 *   LIVE:     the same history with Finance v2 on from the start (hooks,
 *             recognizer and worker posting as it happens);
 *   BACKFILL: history with the flag off, then the switch (ledger not started),
 *             one live event queued meanwhile, then the backfill.
 * The backfilled ledger must balance, match live posting account for
 * account, and a second run must add nothing.
 */
const U = 6101;
const TODAY = "2026-07-15";

async function history(env: LegacyEnv, s: Seed, U: number) {
  const user = userOf(U);
  const pay = async (contractId: number, due: string) =>
    Number((await env.q(`select id from payments where contract_id = $1 and due_date = $2 and deleted_at is null order by id limit 1`, [contractId, due]))[0]?.id);
  const ids: Record<string, number> = {};
  const c1: any = await env.contracts.create(user, {
    unitIds: [s.unitA1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: "2026-01-01", endDate: "2026-12-31",
    monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: true, prepaidRent: "2300", prepaidMethod: "bank_transfer",
    depositAmount: "5000", depositStatus: "collected", depositMethod: "bank_transfer", depositDueDate: "2026-01-01",
    landlordName: "Synthetic Landlord A",
  });
  ids.c1 = c1.id;
  const c2: any = await env.contracts.create(user, {
    unitIds: [s.unitH1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: "2026-01-01", endDate: "2026-12-31",
    monthlyRent: "2000", paymentFrequency: "quarterly", vatEnabled: false, depositAmount: "3000", depositStatus: "pending",
  });
  ids.c2 = c2.id;
  for (const [k, due] of [["p3", "2026-03-01"], ["p4", "2026-04-01"], ["p5", "2026-05-01"]] as const) ids[k] = await pay(c1.id, due);

  await env.payments.addCollection(user, String(ids.p3), { amount: "500", collectedDate: "2026-03-05", method: "cash" });
  const inv: any = await env.billing.create(user, {
    type: "invoice", paymentIds: [ids.p4], issueDate: "2026-03-25",
    items: [{ description: "إيجار", quantity: 1, unitPrice: 1000, amount: 1000, vat: true }], total: 1150,
  });
  ids.inv = inv.id;
  const approved: any = await env.billing.approve(user, String(inv.id), { confirmations: { tenantNoVat: true } });
  ids.com = approved?.commission?.id;
  // Legacy drafts every commission at 15 %; v2 drafts none on an account not linked to ZATCA (§9 E8) and never
  // approves a VAT-bearing one. Both histories approve the same no-VAT document, so live and backfill compare.
  await env.q(`update simple_invoices set total = subtotal, items = jsonb_set(items, '{0,vat}', 'false') where id = $1`, [ids.com]);
  await env.billing.approve(user, String(ids.com), {});
  await env.billing.collect(user, String(ids.com), { paidDate: "2026-03-30" });
  const crn: any = await env.billing.create(user, {
    type: "credit", billingReference: inv.number, issueDate: "2026-03-28",
    items: [{ description: "خصم", quantity: 1, unitPrice: 100, amount: 100, vat: true }], total: 115,
  });
  await env.billing.approve(user, String(crn.id), {});
  await env.billing.collect(user, String(inv.id), { amount: 600, paidDate: "2026-04-02", method: "cash" });
  await env.contracts.collectDeposit(user, String(c2.id), { paidDate: "2026-01-02", method: "cash" });
  await env.billing.createReceiptVoucher(user, { contractId: c2.id, amount: 6500, paidDate: "2026-01-10", countAsCollection: true });
  const e1: any = await env.reports.createExpense(user, { ownerId: s.agent, propertyId: s.propA, category: "صيانة", amount: 200, expenseDate: "2026-03-10" });
  await env.reports.createExpense(user, { ownerId: s.holder, propertyId: s.propH, category: "كهرباء", amount: 115, expenseDate: "not a date" });
  await env.reports.deleteExpense(user, String(e1.id));
  await env.reports.createPayout(user, { ownerId: s.agent, amount: 300, transferDate: "2026-03-15", method: "bank_transfer" });
  // A contract ended with its deposit refunded: the voucher is cancelled, the deposit returned.
  const c3: any = await env.contracts.create(user, {
    unitIds: [s.unitA2], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: "2026-01-01", endDate: "2026-06-30",
    monthlyRent: "500", paymentFrequency: "monthly", vatEnabled: false, depositAmount: "1000", depositStatus: "collected", depositDueDate: "2026-01-01",
  });
  ids.c3 = c3.id;
  await env.contracts.terminate(user, String(c3.id), { mode: "cancelled", deposit: "refund" });
  return ids;
}

/** Σ debit − Σ credit per account code, non-zero only. */
async function balances(env: LegacyEnv, U: number): Promise<Record<string, string>> {
  const rows = await env.q(
    `select a.code, sum(l.debit - l.credit)::text as b from journal_lines l join accounts a on a.id = l.account_id
      where l.user_id = $1 group by a.code having sum(l.debit - l.credit) <> 0 order by a.code`, [U]);
  return Object.fromEntries(rows.map((r: any) => [r.code, r.b]));
}

function backfillOf(env: LegacyEnv): BackfillService {
  const periods = new PeriodsService(env.t.pool);
  return new BackfillService(env.t.pool, env.engine, env.worker, new LedgerStartService(env.flag, env.worker), env.recognizer,
    new FinanceSetupService(new ChartService(env.t.pool), periods));
}

describe("finance v2 backfill (real Postgres, real legacy routes)", { skip: fv2DbSkip }, () => {
  let live: LegacyEnv, bf: LegacyEnv;
  let sBf: Seed;
  let ids: Record<string, number>;
  let backfill: BackfillService;
  let dry: BackfillSummary, first: BackfillSummary, second: BackfillSummary;
  let queuedBefore: number;

  before(async () => {
    [live, bf] = [await legacyEnv("wired"), await legacyEnv("wired")];
    const sLive = await seedAccount(live, U);
    sBf = await seedAccount(bf, U);

    // LIVE: on from the start.
    await enableV2(live, U, "manager");
    const idsLive = await history(live, sLive, U);
    await live.payments.addCollection(userOf(U), String(idsLive.p5), { amount: "1150", collectedDate: "2026-05-03", method: "cash" });
    for (let i = 0; i < 5; i++) {
      await live.recognizer.runAccount(U, TODAY);
      for (let j = 0; j < 20; j++) {
        const r = await live.worker.runAccount(U);
        if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
      }
    }

    // BACKFILL: history with the flag off, then the switch (the ledger has not started), then one live event.
    ids = await history(bf, sBf, U);
    await withTx(bf.t.pool, async (c) => {
      await c.query(`insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode, enabled_at) values ($1, true, 'manager', now())`, [U]);
      await bf.setup.firstEnable(c, U, null);
    });
    bf.flag.invalidate(U);
    await bf.payments.addCollection(userOf(U), String(ids.p5), { amount: "1150", collectedDate: "2026-05-03", method: "cash" });
    queuedBefore = (await bf.q(`select count(*)::int as n from ledger_outbox where user_id = $1`, [U]))[0].n;

    backfill = backfillOf(bf);
    dry = await backfill.run({ userId: U, actorUserId: U, mode: "full", dryRun: true, today: TODAY });
    first = await backfill.run({ userId: U, actorUserId: U, mode: "full", dryRun: false, today: TODAY });
    second = await backfill.run({ userId: U, actorUserId: U, mode: "full", dryRun: false, today: TODAY });
  });

  after(async () => {
    for (const e of [live, bf]) await e?.t.drop();
  });

  it("the live event queued before the backfill waited (the ledger had not started)", () => {
    assert.ok(queuedBefore >= 2, "collection + advance VAT queued");
  });

  it("dry run: reports what it would post, balanced, and writes nothing but its run row", async () => {
    assert.ok(dry.events.new > 20, `new ${dry.events.new}`);
    assert.equal(dry.events.alreadyQueued, queuedBefore);
    assert.ok(dry.entries.count > 20);
    assert.equal(dry.totals.debit, dry.totals.credit);
    assert.deepEqual(dry.failed, []);
    assert.ok(dry.sampleEntries.length > 0 && dry.sampleEntries.length <= 20);
    assert.ok(dry.events.byType.E02 > 0 && dry.events.byType.E01 === 1 && dry.events.byType.E35 > 0, JSON.stringify(dry.events.byType));
    // The dry run's projection equals the real run's result.
    assert.deepEqual(dry.trialBalance, first.trialBalance);
    assert.equal(dry.entries.count, first.entries.count);
  });

  it("real run: every event posts, nothing fails, TB debits = credits, ledger started", async () => {
    assert.deepEqual(first.failed, []);
    assert.equal(first.pending, 0);
    assert.equal(first.totals.debit, first.totals.credit);
    const [t] = await bf.q(`select coalesce(sum(debit - credit), 0)::text as tb, count(distinct entry_id)::int as n from journal_lines where user_id = $1`, [U]);
    assert.equal(t.tb, "0.00");
    assert.equal(t.n, first.entries.count);
    const [s] = await bf.q(`select ledger_started_at is not null as started from finance_settings where account_user_id = $1`, [U]);
    assert.equal(s.started, true);
    const [p] = await bf.q(`select count(*)::int as n from ledger_outbox where user_id = $1 and status in ('pending','failed')`, [U]);
    assert.equal(p.n, 0);
    const [r] = await bf.q(`select count(*)::int as n from finance_backfill_runs where user_id = $1 and status = 'done'`, [U]);
    assert.equal(r.n, 3);
  });

  it("entries carry the ORIGINAL event dates", async () => {
    const rows = await bf.q(
      `select e.source_type, e.event, to_char(e.entry_date,'YYYY-MM-DD') as d, e.origin from journal_entries e where e.user_id = $1 order by e.id`, [U]);
    const inv = rows.find((r: any) => r.source_type === "simple_invoice" && r.event === "confirmed" && r.d === "2026-03-25");
    assert.ok(inv, "the invoice posts at its issue date");
    const col = rows.filter((r: any) => r.source_type === "payment_collection" && r.event === "collected").map((r: any) => r.d);
    assert.ok(col.includes("2026-03-05") && col.includes("2026-04-02") && col.includes("2026-05-03"), col.join(","));
    assert.ok(rows.some((r: any) => r.source_type === "payment" && r.event === "charge" && r.d === "2026-03-01"));
    assert.ok(rows.every((r: any) => r.d <= "2026-12-31"));
    assert.ok(rows.filter((r: any) => r.source_type !== "payment_collection" || r.event !== "collected").some((r: any) => r.origin === "backfill"));
  });

  it("the queue was posted in chronological order (live rows re-sequenced among the backfill rows)", async () => {
    const rows = await bf.q(
      `select id, to_char(occurred_on,'YYYY-MM-DD') as d, origin from ledger_outbox where user_id = $1 and origin in ('backfill','live') order by id`, [U]);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].d <= rows[i].d, `${rows[i - 1].d} > ${rows[i].d} at outbox ${rows[i].id}`);
    assert.ok(rows.some((r: any) => r.origin === "live"));
  });

  it("matches live posting account for account (and the deposits held)", async () => {
    const a = await balances(live, U);
    const b = await balances(bf, U);
    assert.deepEqual(b, a);
    const dep = await bf.q(`select sum(l.credit - l.debit)::text as b from journal_lines l join accounts a on a.id = l.account_id
                              where l.user_id = $1 and a.system_key = 'deposits_held'`, [U]);
    assert.equal(dep[0].b, "8000.00", "5,000 + 3,000 held; the refunded 1,000 is out");
  });

  it("the agent mirror holds (1122 = −2122)", async () => {
    const [m] = await bf.q(
      `select coalesce(sum(case when a.system_key = 'tenant_receivable_agency' then l.debit - l.credit else 0 end), 0)::text as ar,
              coalesce(sum(case when a.system_key = 'landlord_payable_uncollected' then l.credit - l.debit else 0 end), 0)::text as lpu
         from journal_lines l join accounts a on a.id = l.account_id where l.user_id = $1`, [U]);
    assert.equal(m.ar, m.lpu);
  });

  it("warnings: the unparsed expense date is inferred; the returned deposit's refund date is inferred", () => {
    const w = Object.fromEntries(first.warnings.map((x) => [x.code, x.count]));
    assert.ok((w.inferred_date ?? 0) >= 2, JSON.stringify(first.warnings));
  });

  it("second run: re-runnable, posts nothing", async () => {
    assert.equal(second.events.new, 0);
    assert.equal(second.entries.count, 0);
    assert.equal(second.events.alreadyPosted + second.events.alreadyHandled, second.events.total);
    assert.deepEqual(second.trialBalance, first.trialBalance);
  });

  it("a real run leaves an audit_logs row and a settings-history row under the target account; a dry run leaves neither", async () => {
    const audits = await bf.q(`select entity, entity_id, actor_user_id from audit_logs where owner_user_id = $1 and entity = 'finance_v2_backfill' order by id`, [U]);
    assert.deepEqual(audits.map((a: any) => [a.entity_id, a.actor_user_id]), [[String(first.runId), U], [String(second.runId), U]]);
    const hist = await bf.q(`select new_value from finance_settings_events where account_user_id = $1 and field = 'backfill_run' order by id`, [U]);
    assert.deepEqual(hist.map((h: any) => h.new_value.runId), [first.runId, second.runId]);
    const dry = await backfill.run({ userId: U, actorUserId: U, mode: "full", dryRun: true, today: TODAY });
    assert.equal((await bf.q(`select count(*)::int as n from audit_logs where owner_user_id = $1 and entity = 'finance_v2_backfill' and entity_id = $2`, [U, String(dry.runId)]))[0].n, 0);
  });

  it("catch-up repairs a lost enqueue and a lost reversal, and nothing else", async () => {
    const [e] = await bf.q(
      `insert into expenses (user_id, owner_id, property_id, category, amount, expense_date) values ($1, $2, $3, 'صيانة', '40.00', '2026-06-20') returning id`,
      [U, sBf.holder, sBf.propH]);
    const [posted] = await bf.q(`select source_id::int as id from journal_entries where user_id = $1 and source_type = 'expense' and status = 'posted' limit 1`, [U]);
    await bf.q(`update expenses set deleted_at = now() where id = $1`, [posted.id]);
    const before = (await bf.q(`select count(*)::int as n from journal_entries where user_id = $1`, [U]))[0].n;
    const s = await backfill.run({ userId: U, actorUserId: U, mode: "catchup", dryRun: false, today: TODAY });
    assert.equal(s.events.new, 2, JSON.stringify(s.events));
    assert.deepEqual(Object.keys(s.events.byType).sort(), ["E18", "reversal"]);
    assert.deepEqual(s.failed, []);
    const after = (await bf.q(`select count(*)::int as n from journal_entries where user_id = $1`, [U]))[0].n;
    assert.equal(after, before + 2);
    const [orig] = await bf.q(`select status from journal_entries where user_id = $1 and source_type = 'expense' and source_id = $2 and event = 'rev:1'`, [U, posted.id]);
    assert.equal(orig.status, "reversed");
    const [n] = await bf.q(`select count(*)::int as n from journal_entries where user_id = $1 and source_type = 'expense' and source_id = $2`, [U, e.id]);
    assert.equal(n.n, 1);
    const again = await backfill.run({ userId: U, actorUserId: U, mode: "catchup", dryRun: false, today: TODAY });
    assert.equal(again.events.new, 0);
  });

  it("dry run on an account with the flag OFF (no settings, no chart): simulated in a rolled-back transaction", async () => {
    const V = 6102;
    const s = await seedAccount(bf, V);
    await history(bf, s, V);
    const r = await backfill.run({ userId: V, actorUserId: V, mode: "full", dryRun: true, accountingMode: "manager", today: TODAY });
    assert.ok(r.entries.count > 20);
    assert.equal(r.totals.debit, r.totals.credit);
    for (const [table, col] of [["finance_settings", "account_user_id"], ["accounts", "user_id"], ["fiscal_periods", "user_id"], ["ledger_outbox", "user_id"],
      ["journal_entries", "user_id"], ["finance_contract_dims", "user_id"], ["bank_accounts", "user_id"]] as const) {
      const [c] = await bf.q(`select count(*)::int as n from ${table} where ${col} = $1`, [V]);
      assert.equal(c.n, 0, table);
    }
    const [run] = await bf.q(`select dry_run, status from finance_backfill_runs where user_id = $1`, [V]);
    assert.deepEqual([run.dry_run, run.status], [true, "done"]);
  });

  it("preconditions: a real run needs the flag on; closed periods need allowLate", async () => {
    const W = 6103;
    await seedAccount(bf, W);
    await assert.rejects(backfill.run({ userId: W, actorUserId: W, mode: "full", dryRun: false, today: TODAY }), (e: any) => e.getStatus?.() === 409);
    await bf.q(`update fiscal_periods set status = 'closed' where user_id = $1 and starts_on = '2026-01-01'`, [U]);
    try {
      await assert.rejects(backfill.run({ userId: U, actorUserId: U, mode: "catchup", dryRun: true, today: TODAY }),
        (e: any) => e.getResponse?.().error === "PERIODS_CLOSED");
      const ok = await backfill.run({ userId: U, actorUserId: U, mode: "catchup", dryRun: true, allowLate: true, today: TODAY });
      assert.equal(ok.events.new, 0);
    } finally {
      await bf.q(`update fiscal_periods set status = 'open' where user_id = $1 and starts_on = '2026-01-01'`, [U]);
    }
    assert.throws(() => BackfillService.parseRequest(U, U, { mode: "cutover" }), /cutover/);
    assert.equal(BackfillService.parseRequest(U, U, {}).dryRun, true, "dry run is the default");
  });

  it("cutover: the opening proposal from the sub-ledgers at D−1, then only events from D", async () => {
    const X = 6104;
    const s = await seedAccount(bf, X);
    const xi = await history(bf, s, X);
    await withTx(bf.t.pool, async (c) => {
      await c.query(`insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode, enabled_at) values ($1, true, 'manager', now())`, [X]);
      await bf.setup.firstEnable(c, X, null);
    });
    bf.flag.invalidate(X);
    const D = "2026-04-01";
    const r = await backfill.run({ userId: X, actorUserId: X, mode: "cutover", cutover: D, dryRun: false, today: TODAY });
    assert.deepEqual(r.failed, []);
    const prop = r.opening!.proposal!;
    assert.equal(prop.date, "2026-03-31");
    const dr = prop.lines.reduce((a, l) => a + Math.round(Number(l.debit) * 100), 0);
    const cr = prop.lines.reduce((a, l) => a + Math.round(Number(l.credit) * 100), 0);
    assert.equal(dr, cr, "the proposal balances (3900 takes the difference)");
    const depLine = prop.lines.filter((l) => l.code === "2141");
    assert.equal(depLine.reduce((a, l) => a + Math.round(Number(l.credit) * 100) - Math.round(Number(l.debit) * 100), 0), 900000,
      "5,000 + 3,000 + the 1,000 refunded only after D");
    // Nothing before D was posted; the opening is a DRAFT for the user to complete and approve.
    const [early] = await bf.q(`select count(*)::int as n from journal_entries where user_id = $1 and original_date < $2`, [X, D]);
    assert.equal(early.n, 0);
    const [mj] = await bf.q(`select kind, status, to_char(entry_date,'YYYY-MM-DD') as d from manual_journals where id = $1`, [r.opening!.manualJournalId]);
    assert.deepEqual([mj.kind, mj.status, mj.d], ["opening", "draft", "2026-03-31"]);
    const [gl] = await bf.q(`select to_char(ledger_go_live_date,'YYYY-MM-DD') as d from finance_settings where account_user_id = $1`, [X]);
    assert.equal(gl.d, D);
    // The installment invoiced before D is charged in the opening: its later collection books no advance VAT.
    const [m] = await bf.q(`select count(*)::int as n from finance_installment_charges where user_id = $1 and payment_id = $2 and entry_id is null`, [X, xi.p4]);
    assert.equal(m.n, 1);
    // The screen's proposal (GET /opening-balances/proposal) is the same, even after the cutover ran.
    const viaApi = await backfill.proposeOpening(X, D);
    const norm = (ls: any[]) => ls.map((l) => `${l.code}|${l.debit}|${l.credit}|${l.tenantId}|${l.contractId}|${l.paymentId}`).sort();
    assert.deepEqual(norm(viaApi.lines), norm(prop.lines));
    const again = await backfill.run({ userId: X, actorUserId: X, mode: "cutover", cutover: D, dryRun: false, today: TODAY });
    assert.equal(again.events.new, 0);
    const [n] = await bf.q(`select count(*)::int as n from manual_journals where user_id = $1 and kind = 'opening'`, [X]);
    assert.equal(n.n, 1, "no second proposal");
  });
});

/**
 * Phase 5 integration: a seeded synthetic company whose history was written through the real legacy routes with
 * Finance v2 OFF, then switched on and backfilled. The resulting balances are computed by hand below (manager mode,
 * the agent landlord, VAT-able rent), and a second run posts nothing.
 */
describe("finance v2 backfill reproduces hand-computed balances (real Postgres, real legacy routes)", { skip: fv2DbSkip }, () => {
  const V = 6201;
  const TODAY_H = "2026-03-15";
  let env: LegacyEnv;
  let first: BackfillSummary, second: BackfillSummary;

  before(async () => {
    env = await legacyEnv("wired");
    const s = await seedAccount(env, V);
    const user = userOf(V);
    // 1,000 a month + 15 % VAT = 1,150 per installment, agent landlord (5 % fee, no invoice approved → no commission).
    const c: any = await env.contracts.create(user, {
      unitIds: [s.unitA1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: "2026-01-01", endDate: "2026-12-31",
      monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: true,
      depositAmount: "2000", depositStatus: "collected", depositMethod: "bank_transfer", depositDueDate: "2026-01-01",
      landlordName: "Synthetic Landlord A",
    });
    const pay = async (due: string) => Number((await env.q(`select id from payments where contract_id = $1 and due_date = $2`, [c.id, due]))[0].id);
    await env.payments.addCollection(user, String(await pay("2026-01-01")), { amount: "1150", collectedDate: "2026-01-05", method: "cash" });
    await env.payments.addCollection(user, String(await pay("2026-02-01")), { amount: "500", collectedDate: "2026-02-10", method: "cash" });
    await env.reports.createExpense(user, { ownerId: s.agent, propertyId: s.propA, category: "صيانة", amount: 200, expenseDate: "2026-02-15" });
    await env.reports.createPayout(user, { ownerId: s.agent, amount: 700, transferDate: "2026-03-01", method: "bank_transfer" });
    await withTx(env.t.pool, async (cl) => {
      await cl.query(`insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode, enabled_at) values ($1, true, 'manager', now())`, [V]);
      await env.setup.firstEnable(cl, V, null);
    });
    env.flag.invalidate(V);
    const bf = backfillOf(env);
    first = await bf.run({ userId: V, actorUserId: V, mode: "full", dryRun: false, today: TODAY_H });
    second = await bf.run({ userId: V, actorUserId: V, mode: "full", dryRun: false, today: TODAY_H });
  });
  after(async () => { await env?.t.drop(); });

  it("every account equals the hand computation", async () => {
    assert.deepEqual(first.failed, []);
    // Charges due before 15 March: Jan, Feb, Mar = 3 × 1,150 (agent: Dr 1122 / Cr 2122 net 1,000 + VAT 150).
    // Collections (cash): 1,150 + 500 → Dr 1111 / Cr 1122, and 2122 → 2121 for the landlord.
    // Deposit 2,000 by transfer: Dr 1113 / Cr 2141. Landlord's expense 200 and payout 700 from the bank: Dr 2121 / Cr 1113.
    assert.deepEqual(await balances(env, V), {
      "1111": "1650.00",                     // 1,150 + 500
      "1113": "1100.00",                     // 2,000 − 200 − 700
      "1122": "1800.00",                     // 3,450 − 1,650
      "2121": "-750.00",                     // −1,650 + 200 + 700
      "2122": "-1800.00",                    // −3,450 + 1,650 (the mirror of 1122)
      "2141": "-2000.00",
    });
    const [vat] = await env.q(`select sum(l.credit - l.debit)::text as vat, sum(l.vat_base)::text as base from journal_lines l
                                where l.user_id = $1 and l.tax_role = 'output' and l.vat_category = 'S'`, [V]);
    assert.deepEqual([vat.vat, vat.base], ["450.00", "3000.00"], "the landlord's output VAT (seller owner:<id>) on 3 charges");
    const [tb] = await env.q(`select sum(debit)::text as d, sum(credit)::text as c from journal_lines where user_id = $1`, [V]);
    assert.equal(tb.d, tb.c);
  });

  it("a second run posts nothing", () => {
    assert.equal(second.events.new, 0);
    assert.equal(second.entries.count, 0);
    assert.deepEqual(second.trialBalance, first.trialBalance);
  });
});
