import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fv2DbSkip } from "../finance-v2/__tests__/with-db";
import { enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "../finance-v2/__tests__/legacy-env";
import { BackfillService } from "../finance-v2/backfill/backfill.service";
import { LedgerStartService } from "../finance-v2/ledger-start.service";
import { FinanceV2AdminService } from "../finance-v2/admin.service";
import { LedgerResetService } from "../finance-v2/ledger-reset.service";
import { ModeMigrationService } from "../finance-v2/mode-migration.service";
import { FinanceV2AutoProvisionService } from "../finance-v2/auto-provision.service";
import { planCommission } from "../finance-v2/commission";
import { commissionSettings } from "../finance-v2/commission-run";
import { sqlOf } from "../finance-v2/hooks/sql";
import { riyadhToday } from "../finance-v2/dates";
import { PropertiesModule } from "../properties/properties.module";
import { SubscriptionController, activateFromPaidRow } from "../subscription/subscription.module";
import { PlanTransitionService } from "./plan-transition.service";
import { setModeMigrationHandler, setOwnerModeConflictHandler, setPlanChangeHandler, setPlanGuardHandler } from "./plan-transition-signal";

/**
 * Plan transitions against a real (throwaway, local) Postgres schema and the real legacy routes (§7 test matrix).
 * Synthetic rows only (public repo). Nothing reaches ZATCA (billing's submission is stubbed in legacy-env), Moyasar
 * (the pay guard refuses before any call; activateFromPaidRow is called directly) or anyone's inbox.
 */
const MIGRATION_0090 = join(__dirname, "../../../db/drizzle/0090_plan_transitions.sql");
const TODAY = riyadhToday();
const ADMIN = 1;

const T1 = 9501, T3 = 9502, T4 = 9503, T6 = 9504, T14 = 9505, T9 = 9506, T12 = 9507, T12B = 9508, T8 = 9509, T18 = 9510, T2 = 9511, T19 = 9512;

const ctl = (mod: unknown) => (Reflect as any).getMetadata("controllers", mod)[0];

async function contractOn(env: LegacyEnv, U: number, unitId: number, landlordName: string, collect = true) {
  const user = userOf(U);
  const c: any = await env.contracts.create(user, {
    unitIds: [unitId], tenantId: (await env.q(`select id from tenants where user_id = $1 limit 1`, [U]))[0].id, tenantName: "Synthetic Tenant",
    startDate: "2026-01-01", endDate: "2026-12-31", monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false, landlordName,
  });
  await env.q(`update contracts set status = 'active' where id = $1`, [c.id]);
  if (collect) {
    const [p] = await env.q(`select id from payments where contract_id = $1 and due_date = '2026-03-01' and deleted_at is null order by id limit 1`, [c.id]);
    await env.payments.addCollection(user, String(p.id), { amount: "1000", collectedDate: "2026-03-05", method: "cash" });
  }
  return Number(c.id);
}

async function post(env: LegacyEnv, U: number) {
  for (let i = 0; i < 3; i++) {
    await env.recognizer.runAccount(U, TODAY);
    for (let j = 0; j < 30; j++) {
      const r = await env.worker.runAccount(U);
      if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
    }
  }
}

const setPlan = (env: LegacyEnv, U: number, plan: string) => env.q(`update users set package_plan = $2 where id = $1`, [U, plan]).then(() => env.flag.invalidate(U));
const n = async (env: LegacyEnv, sql: string, p: unknown[]) => Number((await env.q(sql, p))[0].n);
const settingsOf = async (env: LegacyEnv, U: number) => (await env.q(`select * from finance_settings where account_user_id = $1`, [U]))[0];
const tb = async (env: LegacyEnv, U: number) => (await env.q(
  `select coalesce(sum(debit), 0)::text as d, coalesce(sum(credit), 0)::text as c from journal_lines where user_id = $1`, [U]))[0];
const zatcaHash = async (env: LegacyEnv) => (await env.q(
  `select md5(coalesce(string_agg(id || number || total || coalesce(zatca_status,'') || coalesce(items::text,''), ',' order by id), '')) as h
     from simple_invoices where zatca_status is not null`))[0].h;

describe("plan transitions (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let svc: PlanTransitionService;
  let migration: ModeMigrationService;
  let auto: FinanceV2AutoProvisionService;
  let reset: LedgerResetService;
  let props: any;
  let subs: any;
  const seeds = new Map<number, Seed>();

  before(async () => {
    process.env.PLAN_TRANSITION_SWEEP_DISABLED = "1";
    env = await legacyEnv("wired");
    await env.t.apply(MIGRATION_0090);
    const pool = env.t.pool;
    const admin = new FinanceV2AdminService(pool, env.flag, env.setup);
    reset = new LedgerResetService(pool, env.flag, env.setup, admin, env.worker);
    const backfill = new BackfillService(pool, env.engine, env.worker, new LedgerStartService(env.flag, env.worker), env.recognizer, env.setup);
    migration = new ModeMigrationService(pool, env.flag, reset, backfill, env.worker);
    auto = new FinanceV2AutoProvisionService(pool, env.flag, env.setup, backfill, migration);
    svc = new PlanTransitionService(pool, env.db, migration, reset, env.flag);
    migration.onModuleInit();
    svc.onModuleInit();
    props = new (ctl(PropertiesModule))(env.db);
    subs = new SubscriptionController(env.db, {} as any);

    for (const U of [T1, T3, T4, T6, T14, T9, T12, T12B, T8, T18, T2, T19]) seeds.set(U, await seedAccount(env, U));
    // The real boot runs 0090 after the accounts exist: its baseline gives each one an `initial` row.
    await env.t.apply(MIGRATION_0090);
  });

  after(async () => {
    svc?.onModuleDestroy();
    migration?.onModuleDestroy();
    setPlanChangeHandler(null); setPlanGuardHandler(null); setModeMigrationHandler(null); setOwnerModeConflictHandler(null);
    await env?.t.drop();
  });

  it("0090 baseline: one initial row per account, idempotent, commission_from null", async () => {
    const rows = await env.q(`select direction, source, status, commission_from from account_plan_changes where account_user_id = $1`, [T1]);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].direction, rows[0].source, rows[0].status, rows[0].commission_from], ["initial", "backfill", "done", null]);
  });

  it("T1: basic, no ledger → professional: recorded upgrade, Manager mode provisioned and started, commission from today", async () => {
    const s = seeds.get(T1)!;
    await setPlan(env, T1, "basic");
    await contractOn(env, T1, s.unitH1, "Synthetic Holder");
    await setPlan(env, T1, "professional");
    const rec = await svc.record(T1, { from: "basic", to: "professional", source: "admin_package_change", actorUserId: ADMIN });
    assert.equal(rec.direction, "upgrade");
    const first = await svc.apply(rec.id);
    assert.equal(first.status, "pending", "waits for the automatic provisioning");
    const prov = await auto.ensure(T1, "admin_package_change");
    assert.equal(prov.outcome, "started", JSON.stringify(prov));
    const r = await svc.apply(rec.id);
    const by = Object.fromEntries(r.steps.map((x) => [x.key, x]));
    assert.equal(by.accounting.status, "done");
    assert.equal(by.mode_migration.detail?.outcome, "not_needed");
    assert.equal(by.commission_from.detail?.commissionFrom, TODAY);
    assert.ok(["done", "attention"].includes(r.status), r.status);
    const fs = await settingsOf(env, T1);
    assert.equal(fs.accounting_mode, "manager");
    assert.ok(fs.ledger_started_at);
    assert.equal(await n(env, `select count(*)::int n from bank_accounts where user_id = $1 and is_trust`, [T1]), 1);
    const t = await tb(env, T1);
    assert.equal(t.d, t.c);
    const [row] = await env.q(`select to_char(commission_from,'YYYY-MM-DD') d, actor_user_id from account_plan_changes where id = $1`, [rec.id]);
    assert.equal(row.d, TODAY);
    assert.equal(row.actor_user_id, ADMIN);
    const [audit] = await env.q(`select action from audit_logs where owner_user_id = $1 and action = 'plan_change'`, [T1]);
    assert.ok(audit, "an audit row under the account");
  });

  it("T2: a paid subscription records source=subscription_paid with the payment id (no Moyasar, no email)", async () => {
    await setPlan(env, T2, "basic");
    const [pay] = await env.q(
      `insert into subscription_payments (user_id, plan, billing_cycle, amount, status, kind) values ($1, 'professional', 'quarterly', '100', 'pending', 'subscription') returning *`,
      [T2]);
    const row = { ...pay, userId: pay.user_id, billingCycle: pay.billing_cycle, moyasarPaymentId: null, kind: "subscription" };
    assert.equal(await activateFromPaidRow(env.db, row as any, { paidAt: new Date() }), true);
    let ch: any = null;
    for (let i = 0; i < 100 && !ch; i++) {
      [ch] = await env.q(`select * from account_plan_changes where account_user_id = $1 and source = 'subscription_paid'`, [T2]);
      if (!ch) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(ch, "recorded by the signal");
    assert.equal(ch.direction, "upgrade");
    assert.equal(ch.from_plan, "basic");
    assert.equal(ch.subscription_payment_id, pay.id);
  });

  it("T3 + T20: Owner-mode ledger, no blockers → upgrade archives it, rebuilds in Manager mode and starts it; ZATCA rows untouched", async () => {
    const s = seeds.get(T3)!;
    await setPlan(env, T3, "professional");
    await enableV2(env, T3, "owner");
    await contractOn(env, T3, s.unitH1, "Synthetic Holder");
    await post(env, T3);
    await env.q(`insert into simple_invoices (user_id, number, type, kind, status, items, subtotal, total, zatca_status) values ($1, 'INV-990001', 'invoice', 'rent', 'confirmed', '[]', '1000', '1000', 'reported')`, [T3]);
    await setPlan(env, T3, "basic");
    const before = await n(env, `select count(*)::int n from journal_entries where user_id = $1`, [T3]);
    assert.ok(before > 0);
    const z0 = await zatcaHash(env);
    const ids0 = (await env.q(`select id from journal_entries where user_id = $1 order by id`, [T3])).map((r: any) => r.id);

    await setPlan(env, T3, "professional");
    const rec = await svc.record(T3, { from: "basic", to: "professional", source: "admin_package_change", actorUserId: ADMIN });
    const r = await svc.apply(rec.id);
    const by = Object.fromEntries(r.steps.map((x) => [x.key, x]));
    assert.equal(by.accounting.detail?.outcome, "owner_mode");
    assert.equal(by.mode_migration.status, "done", JSON.stringify(by.mode_migration));
    assert.equal(by.mode_migration.detail?.outcome, "migrated");
    const fs = await settingsOf(env, T3);
    assert.equal(fs.accounting_mode, "manager");
    assert.ok(fs.ledger_started_at, "the real backfill started the ledger again");
    const [arch] = await env.q(`select * from finance_ledger_archives where account_user_id = $1`, [T3]);
    assert.equal(Number(arch.plan_change_id), rec.id);
    assert.equal(arch.counts.journalEntries, before);
    assert.deepEqual(arch.journal_entries.map((e: any) => String(e.id)), ids0.map(String));
    const after = await n(env, `select count(*)::int n from journal_entries where user_id = $1`, [T3]);
    assert.ok(after > 0);
    const t = await tb(env, T3);
    assert.equal(t.d, t.c, "balanced");
    assert.equal(await n(env, `select count(*)::int n from bank_accounts where user_id = $1 and is_trust`, [T3]), 1);
    const ev = (await env.q(`select field from finance_settings_events where account_user_id = $1 order by id`, [T3])).map((e: any) => e.field);
    assert.ok(ev.includes("mode_migration") && ev.includes("ledger_reset") && ev.includes("accounting_mode"), ev.join(","));
    assert.ok((await env.q(`select 1 from audit_logs where owner_user_id = $1 and action = 'ledger_mode_migration'`, [T3])).length);
    assert.equal(await zatcaHash(env), z0, "T20: ZATCA-seen documents unchanged");

    // T7: restore puts the Owner ledger back with the same ids and totals.
    const listed = await svc.list(T3);
    assert.equal(listed.data[0].archive?.id, Number(arch.id));
    await assert.rejects(svc.restoreLedger(rec.id, ADMIN, { reason: "no", confirm: String(T3) }), /REASON_REQUIRED|reason/);
    await assert.rejects(svc.restoreLedger(rec.id, ADMIN, { reason: "Customer asked to keep Owner mode", confirm: "1" }), /CONFIRM_MISMATCH|account id/);
    const res: any = await svc.restoreLedger(rec.id, ADMIN, { reason: "Customer asked to keep Owner mode", confirm: String(T3) });
    assert.equal(res.restored, true);
    const ids1 = (await env.q(`select id from journal_entries where user_id = $1 order by id`, [T3])).map((r: any) => r.id);
    assert.deepEqual(ids1, ids0, "same entry ids");
    assert.equal(res.counts.debit, arch.counts.debit, "same totals");
    assert.equal(res.counts.journalLines, arch.counts.journalLines);
    const fs2 = await settingsOf(env, T3);
    assert.equal(fs2.accounting_mode, "owner");
    assert.ok(fs2.ledger_started_at);
    const [arch2] = await env.q(`select restored_at, restored_by from finance_ledger_archives where id = $1`, [arch.id]);
    assert.ok(arch2.restored_at);
    assert.equal(arch2.restored_by, ADMIN);
    assert.equal(await zatcaHash(env), z0, "T20 after the restore");
    const ch = await svc.get(rec.id);
    assert.equal(ch.status, "attention", "a restored change stays visible to the admin");
    // Restored once; a second restore has nothing left.
    await assert.rejects(svc.restoreLedger(rec.id, ADMIN, { reason: "Customer asked to keep Owner mode", confirm: String(T3) }), /RESTORE_BLOCKED|no archived ledger/);
  });

  it("T8: restore is refused while the rebuilt ledger has a blocker (a closed period)", async () => {
    const s = seeds.get(T8)!;
    await setPlan(env, T8, "professional");
    await enableV2(env, T8, "owner");
    await contractOn(env, T8, s.unitH1, "Synthetic Holder");
    await post(env, T8);
    await setPlan(env, T8, "basic");
    await setPlan(env, T8, "professional");
    const rec = await svc.record(T8, { from: "basic", to: "professional", source: "admin_package_change" });
    const r = await svc.apply(rec.id);
    assert.equal(r.steps.find((x) => x.key === "mode_migration")?.detail?.outcome, "migrated");
    await env.q(`update fiscal_periods set status = 'closed' where user_id = $1 and fiscal_year = 2026 and period_no = 1`, [T8]);
    await assert.rejects(svc.restoreLedger(rec.id, ADMIN, { reason: "Customer asked to keep Owner mode", confirm: String(T8) }), (err: any) => {
      const b = err.getResponse();
      assert.equal(err.getStatus(), 409);
      assert.equal(b.code, "RESTORE_BLOCKED");
      assert.ok(b.blockers.some((x: any) => x.code === "PERIODS_CLOSED"));
      return true;
    });
    assert.equal((await settingsOf(env, T8)).accounting_mode, "manager", "nothing changed");
  });

  it("T4: Owner mode with a blocker → nothing changes, the step is blocked, the queue and the customer see it", async () => {
    const s = seeds.get(T4)!;
    await setPlan(env, T4, "professional");
    await enableV2(env, T4, "owner");
    await contractOn(env, T4, s.unitH1, "Synthetic Holder");
    await post(env, T4);
    await env.q(`update fiscal_periods set status = 'closed' where user_id = $1 and fiscal_year = 2026 and period_no = 1`, [T4]);
    await setPlan(env, T4, "basic");
    const before = await n(env, `select count(*)::int n from journal_entries where user_id = $1`, [T4]);
    await setPlan(env, T4, "professional");
    const rec = await svc.record(T4, { from: "basic", to: "professional", source: "admin_package_change" });
    const r = await svc.apply(rec.id);
    assert.equal(r.status, "blocked");
    const step = r.steps.find((x) => x.key === "mode_migration")!;
    assert.equal(step.status, "blocked");
    assert.ok((step.detail?.blockers as any[]).some((b) => b.code === "PERIODS_CLOSED"));
    assert.equal((await settingsOf(env, T4)).accounting_mode, "owner");
    assert.equal(await n(env, `select count(*)::int n from journal_entries where user_id = $1`, [T4]), before);
    assert.equal(await n(env, `select count(*)::int n from finance_ledger_archives where account_user_id = $1`, [T4]), 0);
    const q = await svc.queue("blocked");
    assert.ok(q.data.some((x) => x.id === rec.id && x.account?.email));
    const latest = await svc.latest(T4);
    assert.equal(latest.change?.status, "blocked");
    assert.equal(latest.checklist.find((x) => x.key === "accounting_ready")?.status, "blocked");
    const again = await svc.retry(rec.id, ADMIN, { reason: "Checked with the accountant" });
    assert.equal(again.status, "blocked", "a retry inspects again");
    const p = await svc.preview(T4, "enterprise", "admin");
    assert.equal(p.direction, "lateral");
  });

  it("T6: an account an admin switched off stays off; the step says so", async () => {
    await setPlan(env, T6, "basic");
    await env.q(`insert into finance_settings_events (account_user_id, actor_user_id, field, old_value, new_value, reason) values ($1, $2, 'finance_v2_enabled', 'null', 'false', 'opt out')`, [T6, ADMIN]);
    await setPlan(env, T6, "professional");
    const rec = await svc.record(T6, { from: "basic", to: "professional", source: "admin_package_change" });
    const r = await svc.apply(rec.id);
    assert.equal(r.status, "attention");
    assert.equal(r.steps.find((x) => x.key === "accounting")?.detail?.outcome, "skipped_admin_off");
    assert.equal(r.steps.find((x) => x.key === "mode_migration")?.status, "skipped");
    assert.equal(await settingsOf(env, T6), undefined);
    const p = await svc.preview(T6, "enterprise", "customer");
    assert.equal(p.accounting.after, "off");
  });

  it("T14/T15/T13/T17: client money in trust — preview refuses the downgrade, the customer gets 409, the admin can force it", async () => {
    const s = seeds.get(T14)!;
    await setPlan(env, T14, "professional");
    await enableV2(env, T14, "manager");
    await contractOn(env, T14, s.unitA1, "Synthetic Landlord A");
    await post(env, T14);
    const p = await svc.preview(T14, "basic", "customer");
    assert.equal(p.direction, "downgrade");
    assert.deepEqual(p.features.lost.sort(), ["accounting", "advanced_reports", "rental_offers"]);
    assert.equal(p.allowed, false);
    assert.equal(p.code, "DOWNGRADE_NEEDS_SUPPORT");
    assert.ok(p.reasons.includes("third_party_landlords"));
    assert.ok(p.clientMoney && Number(p.clientMoney.trust) > 0, JSON.stringify(p.clientMoney));
    assert.equal(p.accounting.before, "on");
    assert.equal(p.accounting.after, "locked");
    assert.equal(p.limits.landlords.limitAfter, 1);
    assert.equal(p.limits.landlords.over, true);

    // Customer pay → 409 before anything is written (T14).
    await assert.rejects(subs.pay(userOf(T14), { plan: "basic", cycle: "quarterly" }), (err: any) => {
      assert.equal(err.getStatus(), 409);
      assert.equal(err.getResponse().code, "DOWNGRADE_NEEDS_SUPPORT");
      assert.equal(err.getResponse().preview.allowed, false);
      return true;
    });
    const [u] = await env.q(`select package_plan, desired_package_plan from users where id = $1`, [T14]);
    assert.deepEqual([u.package_plan, u.desired_package_plan], ["professional", null]);
    assert.equal(await n(env, `select count(*)::int n from subscription_payments where user_id = $1`, [T14]), 0);

    // Admin: refused without force, allowed with force + reason (T15).
    await assert.rejects(svc.guard(T14, "basic", "admin", {}), /DOWNGRADE_NEEDS_SUPPORT|force/);
    await assert.rejects(svc.guard(T14, "basic", "admin", { force: true, reason: "no" }), /force/);
    await svc.guard(T14, "basic", "admin", { force: true, reason: "Customer closed the office" });
    await setPlan(env, T14, "basic");
    const rec = await svc.record(T14, { from: "professional", to: "basic", source: "admin_package_change", reason: "Customer closed the office", forced: true });
    const r = await svc.apply(rec.id);
    const snap = r.steps.find((x) => x.key === "downgrade_snapshot")!;
    assert.equal(snap.status, "done");
    assert.equal(snap.detail?.forced, true);
    assert.ok(Number(snap.detail?.trust) > 0);
    assert.equal(r.status, "done");
    const st = await env.flag.state(T14);
    assert.equal(st.planLocked, true, "accounting is plan-locked, the ledger is kept");
    assert.ok((await n(env, `select count(*)::int n from journal_entries where user_id = $1`, [T14])) > 0);

    // T16: re-upgrade — a new change row, mode unchanged.
    await setPlan(env, T14, "professional");
    const up = await svc.record(T14, { from: "basic", to: "professional", source: "admin_package_change" });
    assert.notEqual(up.id, rec.id);
    const r2 = await svc.apply(up.id);
    assert.equal(r2.steps.find((x) => x.key === "mode_migration")?.detail?.outcome, "not_needed");
    assert.equal((await settingsOf(env, T14)).accounting_mode, "manager");

    // T13: Manager mode, a third-party landlord's rent into a non-trust bank → 409.
    const [pay] = await env.q(`select p.id from payments p where p.contract_id in (select id from contracts where user_id = $1) and p.status <> 'paid' and p.deleted_at is null order by p.due_date limit 1`, [T14]);
    const [op] = await env.q(`select id from bank_accounts where user_id = $1 and kind = 'bank' and not is_trust limit 1`, [T14]);
    await assert.rejects(env.payments.addCollection(userOf(T14), String(pay.id), { amount: "100", collectedDate: TODAY, method: "bank_transfer", bankAccountId: op.id }),
      (err: any) => { assert.equal(err.getStatus(), 409); assert.equal(err.getResponse().error, "FINANCE_V2_TRUST_REQUIRED"); return true; });

    // T17: professional → enterprise is lateral: recorded, no ledger work.
    await setPlan(env, T14, "enterprise");
    const lat = await svc.record(T14, { from: "professional", to: "enterprise", source: "admin_package_change" });
    assert.equal(lat.direction, "lateral");
    const r3 = await svc.apply(lat.id);
    assert.deepEqual(r3.steps.map((x) => x.key), ["caches"]);
    assert.equal(r3.status, "done");
  });

  it("T9/T10: no commission on rent due before the upgrade; the collected run floors at the upgrade month", async () => {
    const s = seeds.get(T9)!;
    await setPlan(env, T9, "professional");
    await enableV2(env, T9, "manager");
    const cid = await contractOn(env, T9, s.unitA1, "Synthetic Landlord A", false);
    await env.q(
      `insert into account_plan_changes (account_user_id, from_plan, to_plan, from_features, to_features, direction, source, status, commission_from)
       values ($1, 'basic', 'professional', '[]', '["accounting","advanced_reports","rental_offers"]', 'upgrade', 'admin_package_change', 'done', '2026-06-15')`, [T9]);
    const pays = await env.q(`select id, to_char(due_date,'YYYY-MM-DD') d from payments where contract_id = $1 and deleted_at is null order by due_date`, [cid]);
    const early = pays.find((p: any) => p.d === "2026-06-01")!.id;
    const late = pays.find((p: any) => p.d === "2026-07-01")!.id;
    const q = sqlOf(env.t.pool as any);
    assert.equal(await planCommission(q, T9, { contractId: cid, paymentIds: [early] }), null, "due before the upgrade");
    const ok = await planCommission(q, T9, { contractId: cid, paymentIds: [late] });
    assert.ok(ok && Number(ok.net) > 0, JSON.stringify(ok));
    // Legacy (flag-off) pairing: the same rule.
    const legacy = await env.billing.maybeCreateCommissionInvoice(T9, { number: "INV-T9-1", paymentIds: [early], dueDate: "2026-06-01" }, cid);
    assert.equal(legacy, null);
    const legacyOk = await env.billing.maybeCreateCommissionInvoice(T9, { number: "INV-T9-2", paymentIds: [late], dueDate: "2026-07-01" }, cid);
    assert.ok(legacyOk?.number?.startsWith("COM-"));
    const cs = await commissionSettings(q, T9);
    assert.ok(cs && cs.collectedFrom >= "2026-06-01", JSON.stringify(cs));
  });

  it("T11: a fee on the holder's own property is 400 COMMISSION_ON_OWN_LANDLORD; a re-send passes", async () => {
    const s = seeds.get(T9)!;
    await assert.rejects(props.update(userOf(T9), String(s.propH), { managementFeePercent: "5" }), (err: any) => {
      assert.equal(err.getStatus(), 400);
      assert.equal(err.getResponse().code, "COMMISSION_ON_OWN_LANDLORD");
      return true;
    });
    await env.q(`update properties set management_fee_percent = 5 where id = $1`, [s.propH]); // a stale value from before
    await props.update(userOf(T9), String(s.propH), { managementFeePercent: "5", name: "Synthetic Villa" });
    // Legacy pairing skips a holder-owned property even with a stale fee.
    const cid = await contractOn(env, T9, s.unitH1, "Synthetic Holder", false);
    const [late] = await env.q(`select id from payments where contract_id = $1 and due_date = '2026-07-01'`, [cid]);
    assert.equal(await env.billing.maybeCreateCommissionInvoice(T9, { number: "INV-T9-3", paymentIds: [late.id] }, cid), null);
  });

  it("T12: Owner mode + a third-party landlord on a property with an active contract — migrates when entitled, 409 when not", async () => {
    const s = seeds.get(T12)!;
    await setPlan(env, T12, "professional");
    await enableV2(env, T12, "owner");
    await contractOn(env, T12, s.unitH1, "Synthetic Holder");
    await post(env, T12);
    const out = await props.update(userOf(T12), String(s.propH), { ownerId: s.agent });
    assert.equal(out.ownerId, s.agent);
    assert.equal((await settingsOf(env, T12)).accounting_mode, "manager", "migrated, then allowed");

    const b = seeds.get(T12B)!;
    await setPlan(env, T12B, "professional");
    await enableV2(env, T12B, "owner");
    await contractOn(env, T12B, b.unitH1, "Synthetic Holder");
    await post(env, T12B);
    await setPlan(env, T12B, "basic");
    await assert.rejects(props.update(userOf(T12B), String(b.propH), { ownerId: b.agent }), (err: any) => {
      assert.equal(err.getStatus(), 409);
      assert.equal(err.getResponse().code, "OWNER_MODE_THIRD_PARTY");
      return true;
    });
    const [p] = await env.q(`select owner_id from properties where id = $1`, [b.propH]);
    assert.equal(p.owner_id, b.holder, "unchanged");
    const q = await svc.queue("attention,blocked");
    assert.ok(q.data.some((x) => x.accountUserId === T12B && x.source === "owner_mode_guard"));
    // A property with no active contract, or the holder itself, is never refused.
    await props.update(userOf(T12B), String(b.propA), { ownerId: b.holder });
  });

  it("T18: two migrations at once → one migration, one archive", async () => {
    const s = seeds.get(T18)!;
    await setPlan(env, T18, "professional");
    await enableV2(env, T18, "owner");
    await contractOn(env, T18, s.unitH1, "Synthetic Holder");
    await post(env, T18);
    const [a, b] = await Promise.all([migration.maybeMigrate(T18, "one"), migration.maybeMigrate(T18, "two")]);
    const outs = [a.outcome, b.outcome].sort();
    assert.ok(outs.includes("migrated"), outs.join(","));
    assert.ok(outs.filter((o) => o === "migrated").length === 1, outs.join(","));
    assert.equal(await n(env, `select count(*)::int n from finance_ledger_archives where account_user_id = $1`, [T18]), 1);
  });

  it("T19: the sweep records a plan written without a signal", async () => {
    await setPlan(env, T19, "enterprise");
    const r = await svc.sweep();
    assert.ok(r.recorded >= 1);
    const [row] = await env.q(`select * from account_plan_changes where account_user_id = $1 and source = 'sweep'`, [T19]);
    assert.ok(row);
    assert.equal(row.to_plan, "enterprise");
    assert.equal(row.status, "done");
    const again = await svc.sweep();
    assert.equal((await env.q(`select id from account_plan_changes where account_user_id = $1 and source = 'sweep'`, [T19])).length, 1, JSON.stringify(again));
  });

  it("latest: the checklist after an upgrade into accounting", async () => {
    const l = await svc.latest(T1);
    assert.equal(l.change?.direction, "upgrade");
    const keys = l.checklist.map((x) => x.key);
    assert.deepEqual(keys, ["accounting_ready", "review_property_landlords", "set_commission", "move_client_money", "record_past_payouts"]);
    assert.equal(l.checklist[0].done, true);
    assert.ok(l.showUntil);
  });
});
