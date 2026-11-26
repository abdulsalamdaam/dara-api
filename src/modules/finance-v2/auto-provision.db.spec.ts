import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { legacyEnv, seedAccount, userOf, type LegacyEnv } from "./__tests__/legacy-env";
import { BackfillService, type BackfillRequest, type BackfillSummary } from "./backfill/backfill.service";
import { LedgerStartService } from "./ledger-start.service";
import { FinanceSetupService } from "./setup.service";
import { ChartService } from "./chart.service";
import { PeriodsService } from "./periods.service";
import { FinanceV2AdminService } from "./admin.service";
import { FinanceV2AutoProvisionService } from "./auto-provision.service";
import { COA_TEMPLATE } from "./coa-template";
import { PostingErrorsService } from "./posting-errors.service";

/**
 * Finance v2 ON by default for plan-entitled accounts (auto-provision.service.ts)
 * against a real (throwaway, local) Postgres with the full legacy schema and
 * the real legacy routes. Synthetic rows only.
 */
const TODAY = "2026-07-15";
const reason = "Synthetic: switching it off for the spec";

/** A backfill whose dry runs report a failure (the "not clean" path), real runs untouched. */
class DirtyDryRun extends BackfillService {
  dirty = true;
  override async run(req: BackfillRequest): Promise<BackfillSummary> {
    const s = await super.run(req);
    if (req.dryRun && this.dirty) return { ...s, failed: [{ sourceType: "payment", sourceId: 1, event: "charge", code: "SYNTHETIC", error: "synthetic failure" }] };
    return s;
  }
}

describe("finance v2 auto-provisioning for plan-entitled accounts (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let auto: FinanceV2AutoProvisionService;
  let auto2: FinanceV2AutoProvisionService;
  let dirtyAuto: FinanceV2AutoProvisionService;
  let dirty: DirtyDryRun;
  let admin: FinanceV2AdminService;
  let staff: number;
  const A = 6901, B = 6902, C = 6903, D = 6904, E = 6905, F = 6906;
  const q = (sql: string, p: unknown[] = []) => env.q(sql, p);
  const settings = async (u: number) => (await q(`select * from finance_settings where account_user_id = $1`, [u]))[0];
  const count = async (sql: string, p: unknown[]) => Number((await q(sql, p))[0].n);

  const mkBackfill = (Cls: typeof BackfillService = BackfillService) => {
    const periods = new PeriodsService(env.t.pool);
    return new Cls(env.t.pool, env.engine, env.worker, new LedgerStartService(env.flag, env.worker), env.recognizer,
      new FinanceSetupService(new ChartService(env.t.pool), periods));
  };
  const mkAuto = (bf: BackfillService) => new FinanceV2AutoProvisionService(env.t.pool, env.flag, env.setup, bf);

  /** A contract with past-due installments and one collection, written through the real legacy routes (flag off). */
  async function history(u: number) {
    const s = await seedAccount(env, u);
    const c: any = await env.contracts.create(userOf(u), {
      unitIds: [s.unitH1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: "2026-01-01", endDate: "2026-12-31",
      monthlyRent: "2000", paymentFrequency: "quarterly", vatEnabled: false, depositAmount: "3000", depositStatus: "pending",
    });
    const [p] = await q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date limit 1`, [c.id]);
    await env.payments.addCollection(userOf(u), String(p.id), { amount: "6000", collectedDate: "2026-01-05", method: "cash" });
    return s;
  }

  before(async () => {
    env = await legacyEnv("wired");
    const role = (await q(`insert into roles (key, label_ar, label_en, permissions) values ('super_admin', 'مشرف', 'Super admin', '[]') returning id`))[0].id;
    staff = (await q(`insert into users (email, password_hash, name, role_id) values ('staff@example.test', 'x', 'Staff', $1) returning id`, [role]))[0].id;
    for (const u of [A, B, C, D, E]) await history(u);
    await q(`insert into users (id, email, password_hash, name, user_type, package_plan) values ($1, 'f@example.test', 'x', 'Synthetic F', 'company', 'basic')`, [F]);
    auto = mkAuto(mkBackfill());
    auto2 = mkAuto(mkBackfill());
    dirty = mkBackfill(DirtyDryRun as any) as DirtyDryRun;
    dirtyAuto = mkAuto(dirty);
    admin = new FinanceV2AdminService(env.t.pool, env.flag, env.setup);
  });
  after(async () => { await env?.t.drop(); });

  it("provisions an entitled account exactly as the admin first enable does (Manager mode), then a clean dry run → the real backfill", async () => {
    assert.equal(await env.flag.isOn(A), false);
    const r = await auto.ensure(A, "spec", { today: TODAY });
    assert.equal(r.outcome, "started", JSON.stringify(r));
    assert.equal(r.provisioned, true);

    const s = await settings(A);
    assert.equal(s.finance_v2_enabled, true);
    assert.equal(s.accounting_mode, "manager");
    assert.equal(s.commission_basis, "billed", "a new Manager-mode row starts on the billed basis, as the admin path does");
    assert.equal(s.agency_collections_to_trust, true);
    assert.equal(s.enabled_by, null);
    assert.ok(s.enabled_at && s.ledger_started_at, "enabled and started");
    assert.equal(await count(`select count(*) n from accounts where user_id = $1`, [A]), COA_TEMPLATE.length);
    assert.equal(await count(`select count(*) n from fiscal_periods where user_id = $1`, [A]), 24, "previous + current fiscal year");
    const banks = await q(`select kind, is_trust, is_default from bank_accounts where user_id = $1 order by id`, [A]);
    assert.deepEqual(banks.map((b: any) => [b.kind, b.is_trust]), [["cash", false], ["bank", false], ["bank", true]]);
    // Billed basis (26 Oct 2026): no collected-basis cutover is recorded, so no commission-settings row yet.
    assert.equal(await count(`select count(*) n from finance_commission_settings where account_user_id = $1`, [A]), 0);

    const runs = await q(`select dry_run, status, actor_user_id from finance_backfill_runs where user_id = $1 order by id`, [A]);
    assert.deepEqual(runs.map((x: any) => [x.dry_run, x.status, x.actor_user_id]), [[true, "done", 0], [false, "done", 0]]);
    const [tb] = await q(`select coalesce(sum(debit - credit), 0)::text as d, count(*)::int as n from journal_lines where user_id = $1`, [A]);
    assert.equal(tb.d, "0.00");
    assert.ok(tb.n > 0, "the history posted");
    assert.equal(await count(`select count(*) n from ledger_outbox where user_id = $1 and status in ('pending','failed')`, [A]), 0);

    const ev = await admin.events(A);
    const fields = ev.map((e: any) => [e.field, e.actorUserId]).sort();
    assert.deepEqual(fields, [["accounting_mode", 0], ["auto_provision", 0], ["finance_v2_enabled", 0]]);
    assert.equal(ev.find((e: any) => e.field === "auto_provision").newValue.outcome, "started");
    assert.equal(await env.flag.isOn(A), true, "cache invalidated");

    const row = (await admin.listAccounts()).find((x: any) => x.id === A);
    assert.equal(row.effective, true);
    assert.equal(row.adminOff, false);
    assert.equal(row.autoProvision.outcome, "started");
  });

  it("is idempotent: a second trigger and the sweep do nothing to a started account", async () => {
    const before = await q(`select (select count(*) from accounts where user_id = $1)::int a, (select count(*) from journal_entries where user_id = $1)::int j,
                                   (select count(*) from finance_backfill_runs where user_id = $1)::int r`, [A]);
    // Already started: a trigger only checks for documents the ledger is missing (none) and writes nothing.
    assert.equal((await auto.ensure(A, "spec-again", { today: TODAY })).outcome, "up_to_date");
    assert.equal((await auto.ensure(A, "sweep", { today: TODAY })).outcome, "not_eligible");
    assert.deepEqual((await auto.candidates(A)), []);
    const after = await q(`select (select count(*) from accounts where user_id = $1)::int a, (select count(*) from journal_entries where user_id = $1)::int j,
                                  (select count(*) from finance_backfill_runs where user_id = $1)::int r`, [A]);
    assert.deepEqual(after, before);
  });

  it("two triggers at once (two instances) seed and backfill once", async () => {
    const [r1, r2] = await Promise.all([auto.ensure(B, "spec-1", { today: TODAY }), auto2.ensure(B, "spec-2", { today: TODAY })]);
    const outcomes = [r1.outcome, r2.outcome].sort();
    assert.ok(outcomes.includes("started"), JSON.stringify(outcomes));
    assert.ok(outcomes.every((o) => o === "started" || o === "busy" || o === "not_eligible"), JSON.stringify(outcomes));
    assert.equal([r1, r2].filter((r) => r.provisioned).length, 1);
    assert.equal(await count(`select count(*) n from accounts where user_id = $1`, [B]), COA_TEMPLATE.length);
    assert.equal(await count(`select count(*) n from bank_accounts where user_id = $1`, [B]), 3);
    assert.equal(await count(`select count(*) n from finance_backfill_runs where user_id = $1 and not dry_run`, [B]), 1);
    assert.equal(await count(`select count(*) n from finance_settings_events where account_user_id = $1 and field = 'finance_v2_enabled'`, [B]), 1);
  });

  it("an admin's explicit OFF sticks: no trigger and no sweep turns it back on; the admin can still re-enable", async () => {
    await admin.toggle(staff, B, { enabled: false, reason });
    assert.equal(await env.flag.isOn(B), false);
    assert.equal((await auto.ensure(B, "spec", { today: TODAY })).outcome, "not_eligible");
    assert.ok(!(await auto.candidates(null)).some((c) => c.id === B), "not a sweep candidate");
    assert.equal((await settings(B)).finance_v2_enabled, false);
    assert.equal((await admin.listAccounts()).find((x: any) => x.id === B).adminOff, true);

    const res: any = await admin.toggle(staff, B, { enabled: true, reason: "Synthetic: back on for the spec" });
    assert.equal(res.settings.enabled, true);
    assert.equal(res.settings.accountingMode, "manager", "the mode set automatically is kept");
    assert.equal(await env.flag.isOn(B), true);
  });

  it("an admin OFF on a never-provisioned account is honoured too (opt-out before the sweep)", async () => {
    await admin.toggle(staff, C, { enabled: false, reason });
    assert.equal((await auto.ensure(C, "spec", { today: TODAY })).outcome, "not_eligible");
    assert.equal(await count(`select count(*) n from accounts where user_id = $1`, [C]), 0, "nothing seeded");
  });

  it("an account an ADMIN enabled and never backfilled is started too (accountant note 3: nothing sits queued)", async () => {
    await admin.toggle(staff, E, { enabled: true, accountingMode: "manager", reason: "Synthetic: admin enable" });
    assert.deepEqual((await auto.candidates(E)).map((c) => c.action), ["backfill"]);
    const r = await auto.ensure(E, "admin_enable", { today: TODAY });
    assert.equal(r.outcome, "started", JSON.stringify(r));
    assert.equal(r.provisioned, false, "the admin's provisioning is kept");
    const s = await settings(E);
    assert.ok(s.ledger_started_at);
    assert.equal(s.enabled_by, staff, "still the admin's enable");
    assert.equal(await count(`select count(*) n from ledger_outbox where user_id = $1 and status = 'pending'`, [E]), 0, "nothing left queued");
  });

  it("a ledger an admin reset is still left to the admin (ledger_reset / restore / mode migration hold it)", async () => {
    const G = 6907;
    await q(`insert into users (id, email, password_hash, name, user_type, package_plan) values ($1, 'g@example.test', 'x', 'Synthetic G', 'company', 'professional')`, [G]);
    await admin.toggle(staff, G, { enabled: true, accountingMode: "manager", reason: "Synthetic: admin enable" });
    await q(`insert into finance_settings_events (account_user_id, actor_user_id, field, old_value, new_value, reason)
             values ($1, $2, 'ledger_reset', '{}'::jsonb, '{}'::jsonb, 'Synthetic reset')`, [G, staff]);
    assert.deepEqual(await auto.candidates(G), []);
    assert.equal((await auto.ensure(G, "spec", { today: TODAY })).outcome, "not_eligible");
    assert.equal((await settings(G)).ledger_started_at, null);
  });

  it("عقاري with accounting granted: provisioned in Owner mode with cash-basis rent, and started (accountant note 5)", async () => {
    const H = 6908;
    await q(`insert into users (id, email, password_hash, name, user_type, package_plan) values ($1, 'h@example.test', 'x', 'Synthetic H', 'individual', 'basic')`, [H]);
    assert.equal((await auto.ensure(H, "spec", { today: TODAY })).outcome, "not_eligible", "not entitled before the grant");
    await q(`insert into account_limit_overrides (account_id, limit_key, value, note) values ($1, 'accounting.enabled', 1, 'Synthetic grant')`, [H]);
    const r = await auto.ensure(H, "admin_accounting_grant", { today: TODAY });
    assert.equal(r.outcome, "started", JSON.stringify(r));
    const s = await settings(H);
    assert.equal(s.accounting_mode, "owner");
    assert.equal(s.rent_revenue_basis, "cash");
    assert.ok(s.ledger_started_at);
    assert.equal(await count(`select count(*) n from bank_accounts where user_id = $1 and is_trust`, [H]), 0, "no trust account in Owner mode");
    const ev = await q(`select field, new_value from finance_settings_events where account_user_id = $1 and field in ('accounting_mode', 'rent_revenue_basis') order by id`, [H]);
    assert.deepEqual(ev.map((e: any) => [e.field, e.new_value]), [["accounting_mode", "owner"], ["rent_revenue_basis", "cash"]]);
  });

  it("an admin's first enable of an عقاري account also starts on cash-basis rent; an office account keeps accrual", async () => {
    const I = 6909, J = 6910;
    await q(`insert into users (id, email, password_hash, name, user_type, package_plan) values ($1, 'i@example.test', 'x', 'Synthetic I', 'individual', 'basic'), ($2, 'j@example.test', 'x', 'Synthetic J', 'company', 'professional')`, [I, J]);
    await admin.toggle(staff, I, { enabled: true, accountingMode: "owner", reason: "Synthetic: admin enable" });
    await admin.toggle(staff, J, { enabled: true, accountingMode: "manager", reason: "Synthetic: admin enable" });
    assert.equal((await settings(I)).rent_revenue_basis, "cash");
    assert.equal((await settings(J)).rent_revenue_basis, "accrual");
  });

  it("posting errors say the ledger has not started while events are queued, and «start the ledger» starts it", async () => {
    const K = 6916;
    const errors = new PostingErrorsService(env.t.pool);
    const sd = await seedAccount(env, K);
    await admin.toggle(staff, K, { enabled: true, accountingMode: "manager", reason: "Synthetic: admin enable" });
    // Written with the flag on and the ledger not started: queued, not posted.
    const ct: any = await env.contracts.create(userOf(K), {
      unitIds: [sd.unitH1], tenantId: sd.tenant, tenantName: "Synthetic Tenant", startDate: "2026-01-01", endDate: "2026-12-31",
      monthlyRent: "2000", paymentFrequency: "quarterly", vatEnabled: false, depositAmount: "0",
    });
    const [p1] = await q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date limit 1`, [ct.id]);
    await env.payments.addCollection(userOf(K), String(p1.id), { amount: "6000", collectedDate: "2026-01-05", method: "cash" });
    const before = await errors.list(K);
    assert.equal(before.ledger.started, false);
    assert.ok(before.ledger.pending > 0 && before.ledger.waiting > 0, JSON.stringify(before.ledger));
    assert.equal(before.total, 0, "no errors — but not 'everything posted' either");

    const saved = { a: process.env.FINANCE_V2_AUTO_PROVISION_DISABLED, w: process.env.FINANCE_V2_WORKER_DISABLED };
    delete process.env.FINANCE_V2_AUTO_PROVISION_DISABLED;
    delete process.env.FINANCE_V2_WORKER_DISABLED;
    try {
      const r = await auto.startNow(K);
      assert.equal(r.outcome, "started", JSON.stringify(r));
    } finally {
      if (saved.a !== undefined) process.env.FINANCE_V2_AUTO_PROVISION_DISABLED = saved.a;
      if (saved.w !== undefined) process.env.FINANCE_V2_WORKER_DISABLED = saved.w;
    }
    const after = await errors.list(K);
    assert.equal(after.ledger.started, true);
    assert.ok(after.ledger.lastAttempt?.outcome === "started");
    // The kill switch is honoured.
    if (saved.w !== undefined || saved.a !== undefined) assert.equal((await auto.startNow(K)).outcome, "not_eligible");
  });

  it("an unclean dry run leaves it enabled but NOT started, never posts, and says why", async () => {
    const r = await dirtyAuto.ensure(D, "spec", { today: TODAY });
    assert.equal(r.outcome, "dry_run_not_clean");
    assert.equal(r.provisioned, true);
    const s = await settings(D);
    assert.equal(s.finance_v2_enabled, true);
    assert.equal(s.ledger_started_at, null);
    assert.equal(await count(`select count(*) n from journal_entries where user_id = $1`, [D]), 0, "nothing posted");
    assert.equal(await count(`select count(*) n from finance_backfill_runs where user_id = $1 and not dry_run`, [D]), 0, "no real run");
    const row = (await admin.listAccounts()).find((x: any) => x.id === D);
    assert.equal(row.autoProvision.outcome, "dry_run_not_clean");
    assert.match(row.autoProvision.reason, /1 failed/);
    assert.equal(row.ledgerStartedAt, null);

    // Retried, but not hammered: a trigger right away is throttled; the sweep waits a day.
    assert.equal((await dirtyAuto.ensure(D, "spec", { today: TODAY })).outcome, "throttled");
    assert.deepEqual((await auto.candidates(D)).map((c) => c.action), ["backfill"]);
    assert.ok(!(await auto.sweep()).some((x) => x.accountUserId === D), "the sweep retries at most once a day");

    // Once the dry run is clean, the retry starts the ledger (no second seeding).
    dirty.dirty = false;
    const again = await dirtyAuto.ensure(D, "spec-retry", { today: TODAY, retryMinutes: 0 });
    assert.equal(again.outcome, "started");
    assert.equal(again.provisioned, false);
    assert.ok((await settings(D)).ledger_started_at);
    assert.equal(await count(`select count(*) n from accounts where user_id = $1`, [D]), COA_TEMPLATE.length);
  });

  it("plan gate: a basic account is never provisioned; upgrading makes it a candidate; a downgrade leaves the stored flag alone", async () => {
    assert.equal((await auto.ensure(F, "spec", { today: TODAY })).outcome, "not_eligible");
    assert.equal(await settings(F), undefined);
    await q(`update users set package_plan = 'professional' where id = $1`, [F]);
    assert.equal((await auto.ensure(F, "spec", { today: TODAY })).outcome, "started");
    await q(`update users set package_plan = 'basic' where id = $1`, [F]);
    env.flag.invalidate(F);
    assert.equal(await env.flag.isOn(F), false, "effective off");
    assert.equal((await settings(F)).finance_v2_enabled, true, "stored flag untouched");
    assert.deepEqual(await auto.candidates(F), []);
  });

  it("the sweep provisions only live, entitled customer accounts", async () => {
    const mk = async (id: number, extra: string, vals: unknown[] = []) =>
      q(`insert into users (id, email, password_hash, name, user_type${extra ? ", " + extra.split("=")[0] : ""}) values ($1, $2, 'x', 'Synthetic', 'company'${extra ? ", $3" : ""})`,
        [id, `sweep-${id}@example.test`, ...vals]);
    await mk(6911, "");                                    // entitled (broker → professional): provisioned
    await mk(6912, "account_status=", ["pending"]);        // pending registration: skipped
    await mk(6913, "is_active=", [false]);                 // suspended: skipped
    await mk(6914, "owner_user_id=", [6911]);              // employee: skipped
    await mk(6915, "package_plan=", ["tenant"]);           // plan-locked: skipped
    const r = await auto.sweep();
    const ids = r.map((x) => x.accountUserId);
    assert.ok(ids.includes(6911), JSON.stringify(r));
    for (const x of [6912, 6913, 6914, 6915]) assert.ok(!ids.includes(x), `${x} must be skipped`);
    assert.equal(r.find((x) => x.accountUserId === 6911)!.outcome, "started");
    for (const x of [A, B, C, E, F, 6907]) assert.ok(!ids.includes(x), `${x} is already settled`);
  });
});
