/**
 * Rent revenue basis (0094, customer accounting notes 3 Nov 2026): an account
 * on 'cash' books rent to 2131 when due and releases it to revenue only as it
 * is received (E35C); switching restates. Real controllers, recognizer and
 * posting worker against a throwaway Postgres. Synthetic data only (public repo).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { enableV2, legacyEnv, seedAccount, userOf, withoutTrust, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { riyadhToday } from "./dates";
import { FinanceSettingsService } from "./settings.service";

const U = 7811;
const today = riyadhToday();
const monthStart = (back: number) => {
  const [y, m] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 - back, 1)).toISOString().slice(0, 10);
};
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "contracts.view", "contracts.write"];
const user = { ...userOf(U), permissions: PERMS };

describe("rent revenue basis: cash releases rent as it is received", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let pays: number[];
  let settings: FinanceSettingsService;

  const drain = async () => {
    for (let i = 0; i < 20; i++) {
      const r = await env.worker.runAccount(U);
      if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
    }
  };
  const settle = async () => {
    await env.recognizer.runAccount(U, today);
    await drain();
    await env.recognizer.runAccount(U, today); // releases need the charges posted first
    await drain();
  };
  /** Rent revenue and unearned rent on the contract's installments, in SAR. */
  const figures = async () => {
    const [r] = await env.q(
      `select coalesce(sum(case when a.type = 'revenue' then l.credit - l.debit end), 0)::float8 as revenue,
              coalesce(sum(case when a.system_key = 'unearned_rent' then l.credit - l.debit end), 0)::float8 as unearned
         from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
        where l.user_id = $1 and l.payment_id = any($2::int[])`,
      [U, pays],
    );
    return { revenue: Math.round(r.revenue * 100) / 100, unearned: Math.round(r.unearned * 100) / 100 };
  };

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, U);
    await enableV2(env, U, "manager");
    await withoutTrust(env, U);
    env.hooks.recognizer = env.recognizer;
    settings = new FinanceSettingsService(env.t.pool as any, undefined, env.flag, env.recognizer);
    // The account holder's own unit (principal), 1,000 a month, no VAT, four months already due.
    const c: any = await env.contracts.create(user, {
      unitIds: [s.unitH1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: monthStart(4),
      endDate: new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) + 6, 0)).toISOString().slice(0, 10),
      monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false,
    });
    pays = (await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date, id`, [c.id])).map((r: any) => Number(r.id));
  });
  after(async () => { await env?.t.drop(); });

  it("accrual (default): past months are released month by month, nothing collected", async () => {
    await settle();
    const f = await figures();
    assert.ok(f.revenue > 0, `straight line released something (${f.revenue})`);
    assert.equal((await env.q(`select count(*)::int n from ledger_outbox where user_id = $1 and status = 'failed'`, [U]))[0].n, 0);
  });

  it("switching to cash restates: revenue = what was received (nothing yet)", async () => {
    await env.payments.addCollection(user, String(pays[0]), { amount: "1000", collectedDate: monthStart(4), method: "cash", receiptNumber: "CB-1" });
    await env.payments.addCollection(user, String(pays[1]), { amount: "400", collectedDate: monthStart(3), method: "cash", receiptNumber: "CB-2" });
    await settings.patch(U, U, { rentRevenueBasis: "cash", reason: "synthetic: customer wants cash basis" });
    await drain();
    await settle();
    const f = await figures();
    assert.equal(f.revenue, 1400, "1,000 + 400 received");
    const charged = (await env.q(`select count(*)::int n from finance_installment_charges where user_id = $1 and payment_id = any($2::int[]) and reversed_at is null`, [U, pays]))[0].n;
    assert.equal(f.unearned, charged * 1000 - 1400, "the rest waits in 2131");
    assert.equal((await settings.get(U)).rentRevenueBasis, "cash");
  });

  it("a collection releases its share straight away (hook), settled-outside releases the whole", async () => {
    await env.payments.addCollection(user, String(pays[1]), { amount: "600", collectedDate: monthStart(2), method: "cash", receiptNumber: "CB-3" });
    await new Promise((r) => setTimeout(r, 2500)); // the hook runs 1.5 s after the caller's transaction
    await drain();
    assert.equal((await figures()).revenue, 2000, "the hook released the 600 without waiting for the nightly run");
    await env.payments.settleExternal(user, String(pays[2]), {});
    await new Promise((r) => setTimeout(r, 2500));
    await drain();
    await settle();
    assert.equal((await figures()).revenue, 3000);
    assert.equal((await env.q(`select count(*)::int n from ledger_outbox where user_id = $1 and event like 'release:%' and created_at > now() - interval '1 minute' and status = 'pending'`, [U]))[0].n, 0, "no monthly release queued under cash");
  });

  it("a repeat run posts nothing more; the ledger stays balanced", async () => {
    const before = await figures();
    await settle();
    assert.deepEqual(await figures(), before);
    const [b] = await env.q(`select coalesce(sum(debit - credit), 0)::text as d from journal_lines where user_id = $1`, [U]);
    assert.equal(Number(b.d), 0);
    assert.equal((await env.q(`select count(*)::int n from ledger_outbox where user_id = $1 and status = 'failed'`, [U]))[0].n, 0);
  });

  it("back to accrual: the monthly releases resume, never below what cash released", async () => {
    const cash = await figures();
    await settings.patch(U, U, { rentRevenueBasis: "accrual", reason: "synthetic: back to straight line" });
    await settle();
    const f = await figures();
    assert.ok(f.unearned >= 0, `2131 never negative (${f.unearned})`);
    assert.ok(f.revenue >= cash.revenue - 0.01, `${f.revenue} >= ${cash.revenue}`);
    assert.equal((await env.q(`select count(*)::int n from ledger_outbox where user_id = $1 and status = 'failed'`, [U]))[0].n, 0);
  });
});
