import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { fv2DbSkip } from "./__tests__/with-db";
import { enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { BackfillService } from "./backfill/backfill.service";
import { LedgerStartService } from "./ledger-start.service";
import { FinanceSetupService } from "./setup.service";
import { ChartService } from "./chart.service";
import { PeriodsService } from "./periods.service";
import { FinanceV2AdminService } from "./admin.service";
import { LedgerResetService } from "./ledger-reset.service";

/**
 * Admin "reset ledger & change accounting mode" against a real (throwaway,
 * local) Postgres and the real legacy routes. Synthetic rows only.
 *
 *  U1: Owner mode (as an account enabled before its third-party landlord was
 *      added), history posted live; reset to Manager, then the backfill.
 *  U2: another account with its own ledger: must be untouched.
 *  U3: an account with blockers (a closed period, an issued payout voucher).
 */
const U1 = 6201, U2 = 6202, U3 = 6203;
const TODAY = "2026-07-15";
const ADMIN = 1;
const reason = "Account manages other landlords; rebuild in manager mode";

async function history(env: LegacyEnv, s: Seed, U: number) {
  const user = userOf(U);
  const c: any = await env.contracts.create(user, {
    unitIds: [s.unitA1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: "2026-01-01", endDate: "2026-12-31",
    monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false, landlordName: "Synthetic Landlord A",
  });
  const [p] = await env.q(`select id from payments where contract_id = $1 and due_date = '2026-03-01' and deleted_at is null order by id limit 1`, [c.id]);
  await env.payments.addCollection(user, String(p.id), { amount: "1000", collectedDate: "2026-03-05", method: "cash" });
  for (let i = 0; i < 5; i++) {
    await env.recognizer.runAccount(U, TODAY);
    for (let j = 0; j < 20; j++) {
      const r = await env.worker.runAccount(U);
      if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
    }
  }
}

const count = async (env: LegacyEnv, table: string, U: number, col = "user_id") =>
  Number((await env.q(`select count(*)::int as n from ${table} where ${col} = $1`, [U]))[0].n);

/** Σ debit − Σ credit on the landlord-payable accounts (2121/2122) for one account. */
const payable = async (env: LegacyEnv, U: number) => Number((await env.q(
  `select coalesce(sum(l.credit - l.debit), 0)::numeric as b from journal_lines l join accounts a on a.id = l.account_id
    where l.user_id = $1 and a.system_key in ('landlord_payable', 'landlord_payable_uncollected')`, [U]))[0].b);

describe("finance v2 ledger reset & mode change (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let reset: LedgerResetService;
  let backfill: BackfillService;
  let u2Before: { entries: number; lines: number; outbox: number };

  before(async () => {
    env = await legacyEnv("wired");
    const s1 = await seedAccount(env, U1);
    const s2 = await seedAccount(env, U2);
    await seedAccount(env, U3);

    await enableV2(env, U1, "owner");
    await history(env, s1, U1);
    await enableV2(env, U2, "manager");
    await history(env, s2, U2);
    await enableV2(env, U3, "manager");
    await env.q(`update fiscal_periods set status = 'closed' where user_id = $1 and fiscal_year = 2026 and period_no = 1`, [U3]);
    await env.q(`insert into finance_payout_vouchers (payout_id, user_id, number) values (990001, $1, 'PV-000001')`, [U3]);
    for (const U of [U1, U2]) {
      await env.q(`insert into finance_control_runs (user_id, as_of, trigger) values ($1, $2, 'nightly')`, [U, TODAY]);
    }

    const setup = new FinanceSetupService(new ChartService(env.t.pool), new PeriodsService(env.t.pool));
    const admin = new FinanceV2AdminService(env.t.pool, env.flag, setup);
    reset = new LedgerResetService(env.t.pool, env.flag, setup, admin, env.worker);
    backfill = new BackfillService(env.t.pool, env.engine, env.worker, new LedgerStartService(env.flag, env.worker), env.recognizer, setup);
    u2Before = { entries: await count(env, "journal_entries", U2), lines: await count(env, "journal_lines", U2), outbox: await count(env, "ledger_outbox", U2) };
  });

  after(async () => { await env?.t.drop(); });

  it("the Owner-mode history posted the third-party landlord's rent as own income (no landlord payable)", async () => {
    assert.ok((await count(env, "journal_entries", U1)) > 0);
    assert.equal(await payable(env, U1), 0);
    assert.ok((await payable(env, U2)) > 0, "the Manager-mode account holds the same rent for the landlord");
  });

  it("preview: counts what would be deleted, no blockers, trust account to create", async () => {
    const p = await reset.preview(U1, "manager");
    assert.equal(p.canReset, true, JSON.stringify(p.blockers));
    assert.equal(p.current.accountingMode, "owner");
    assert.equal(p.modeChanges, true);
    assert.equal(p.willDelete.journalEntries, await count(env, "journal_entries", U1));
    assert.equal(p.willDelete.journalLines, await count(env, "journal_lines", U1));
    assert.equal(p.willDelete.controlRuns, 1);
    assert.equal(p.trust.required, true);
    assert.equal(p.trust.exists, false, "an Owner-mode enable has no trust account");
  });

  it("preview: Owner mode is blocked by its precondition", async () => {
    const p = await reset.preview(U2, "owner");
    assert.ok(p.blockers.some((b) => b.code === "OWNER_MODE_PRECONDITION"), JSON.stringify(p.blockers));
  });

  it("refuses an unknown mode, a short reason, and a confirmation that is not the account id", async () => {
    await assert.rejects(reset.preview(U1, "landlord"), BadRequestException);
    await assert.rejects(reset.reset(ADMIN, U1, { accountingMode: "manager", reason: "abc", confirm: String(U1) }), BadRequestException);
    await assert.rejects(reset.reset(ADMIN, U1, { accountingMode: "manager", reason, confirm: String(U2) }), /CONFIRM_MISMATCH|account id/);
    await assert.rejects(reset.reset(ADMIN, U1, { accountingMode: "manager", reason }), BadRequestException);
  });

  it("refuses with blockers and changes nothing", async () => {
    const p = await reset.preview(U3, "manager");
    assert.deepEqual(p.blockers.map((b) => b.code).sort(), ["PAYOUT_VOUCHERS", "PERIODS_CLOSED"]);
    const before = await count(env, "journal_entries", U3);
    await assert.rejects(reset.reset(ADMIN, U3, { accountingMode: "manager", reason, confirm: String(U3) }), (err: any) => {
      assert.ok(err instanceof ConflictException);
      assert.deepEqual((err.getResponse() as any).blockers.map((b: any) => b.code).sort(), ["PAYOUT_VOUCHERS", "PERIODS_CLOSED"]);
      return true;
    });
    assert.equal(await count(env, "journal_entries", U3), before);
    assert.equal(await count(env, "finance_settings_events", U3, "account_user_id"), 0);
  });

  it("resets U1 only: derived ledger gone, mode Manager, ledger not started, trust account, history written", async () => {
    const p = await reset.preview(U1, "manager");
    const r: any = await reset.reset(ADMIN, U1, { accountingMode: "manager", reason, confirm: String(U1) });
    assert.equal(r.reset, true);
    assert.equal(r.previousMode, "owner");
    assert.equal(r.accountingMode, "manager");
    assert.deepEqual(r.deleted, p.willDelete);
    assert.equal(r.settings.ledgerStartedAt, null);
    assert.equal(r.settings.accountingMode, "manager");
    assert.equal(r.settings.enabled, true, "the flag is kept");
    assert.equal(r.settings.agencyCollectionsToTrust, true);

    for (const t of ["journal_entries", "journal_lines", "ledger_outbox", "finance_installment_charges", "finance_installment_vat_points", "finance_control_runs"]) {
      assert.equal(await count(env, t, U1), 0, t);
    }
    assert.ok((await count(env, "accounts", U1)) > 0, "the chart is kept");
    assert.ok((await count(env, "fiscal_periods", U1)) > 0, "the periods are kept");
    const [trust] = await env.q(`select id from bank_accounts where user_id = $1 and kind = 'bank' and is_trust and is_default and is_active`, [U1]);
    assert.ok(trust, "Manager mode's default trust account");

    // the other account is untouched
    assert.deepEqual(
      { entries: await count(env, "journal_entries", U2), lines: await count(env, "journal_lines", U2), outbox: await count(env, "ledger_outbox", U2) },
      u2Before);
    assert.equal(await count(env, "finance_control_runs", U2), 1);

    const ev = await env.q(`select actor_user_id, field, old_value, new_value, reason from finance_settings_events where account_user_id = $1 and field in ('ledger_reset','accounting_mode') order by id`, [U1]);
    assert.deepEqual(ev.map((e: any) => e.field), ["ledger_reset", "accounting_mode"]);
    assert.ok(ev.every((e: any) => e.actor_user_id === ADMIN && e.reason === reason));
    assert.equal(ev[0].old_value.accountingMode, "owner");
    assert.equal(ev[0].new_value.deleted.journalEntries, p.willDelete.journalEntries);
    assert.deepEqual([ev[1].old_value, ev[1].new_value], ["owner", "manager"]);
    const [audit] = await env.q(`select * from audit_logs where owner_user_id = $1 and path like '%/reset-ledger'`, [U1]);
    assert.equal(audit.actor_user_id, ADMIN);
  });

  it("the backfill afterwards re-posts the history in Manager mode, balanced; a second run adds nothing", async () => {
    const dry = await backfill.run({ userId: U1, actorUserId: ADMIN, mode: "full", dryRun: true, today: TODAY });
    assert.equal(dry.failed.length, 0, JSON.stringify(dry.failed.slice(0, 3)));
    assert.equal(await count(env, "journal_entries", U1), 0, "a dry run writes no entries");
    const real = await backfill.run({ userId: U1, actorUserId: ADMIN, mode: "full", dryRun: false, today: TODAY });
    assert.equal(real.failed.length, 0, JSON.stringify(real.failed.slice(0, 3)));
    assert.equal(real.pending, 0);
    assert.equal(real.totals.debit, real.totals.credit);
    assert.ok((await count(env, "journal_entries", U1)) > 0);
    assert.ok((await payable(env, U1)) > 0, "the third-party landlord's rent is now held for the landlord");
    const [s] = await env.q(`select ledger_started_at from finance_settings where account_user_id = $1`, [U1]);
    assert.ok(s.ledger_started_at, "the real run starts the ledger");
    const again = await backfill.run({ userId: U1, actorUserId: ADMIN, mode: "full", dryRun: false, today: TODAY });
    assert.equal(again.events.new, 0);
  });

  it("the toggle still refuses a plain mode change on the rebuilt ledger", async () => {
    const setup = new FinanceSetupService(new ChartService(env.t.pool), new PeriodsService(env.t.pool));
    const admin = new FinanceV2AdminService(env.t.pool, env.flag, setup);
    await assert.rejects(admin.toggle(ADMIN, U1, { enabled: true, accountingMode: "owner", reason }), /cannot change after the first posting|Owner mode/);
  });
});
