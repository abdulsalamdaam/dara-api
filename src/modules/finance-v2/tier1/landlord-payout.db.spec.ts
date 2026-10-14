import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "../__tests__/legacy-env";
import { riyadhToday } from "../dates";
import { LandlordPayoutsService } from "./landlord-payouts.service";
import { StatementsService } from "../reports/statements.service";

/**
 * «تحويل للمؤجر» (accountant, 15 Oct 2026) on the real legacy route against a
 * throwaway Postgres. Synthetic data only.
 *
 * Manager mode with the mandatory trust account (1114, trust routing on). The
 * agent landlord's tenant pays 3,000 in cash — under trust routing that lands
 * in 1114 — so the landlord's dues (2121) are 3,000 (collected-basis
 * commission: nothing is deducted before the month-end run). Paying him with
 * no "paid from" must post Dr 2121 / Cr 1114 and issue a PV- voucher.
 */
const U = 6411;
const OTHER = 6412;
const today = riyadhToday();
const firstOf = (monthsFromNow: number) => {
  const [y, m] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + monthsFromNow, 1)).toISOString().slice(0, 10);
};
const lastOf = (monthsFromNow: number) => {
  const d = new Date(`${firstOf(monthsFromNow + 1)}T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};
const tomorrow = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "contracts.view", "contracts.write"];
const user = { ...userOf(U), permissions: PERMS };

async function drain(env: LegacyEnv, u = U) {
  await env.recognizer.runAccount(u);
  for (let i = 0; i < 12; i++) {
    const r = await env.worker.runAccount(u);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

describe("fv2 landlord payout: trust by default, PV- voucher, idempotent (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let svc: LandlordPayoutsService;
  let first: any;
  const count = async (t: string) => (await env.q(`select count(*)::int as n from ${t} where user_id = $1`, [U]))[0].n;
  const linesOf = async (payoutId: number) => (await env.q(
    `select a.code, l.debit::text as debit, l.credit::text as credit from journal_entries e join journal_lines l on l.entry_id = e.id
       join accounts a on a.id = l.account_id
      where e.user_id = $1 and e.source_type = 'landlord_payout' and e.source_id = $2 and e.event = 'created' order by l.line_no`, [U, payoutId]))
    .map((l: any) => `${l.code} ${Number(l.debit) ? "Dr" : "Cr"} ${Number(l.debit) || Number(l.credit)}`);
  const due = async () => (await env.reports.accounting(user)).landlordDues.find((d: any) => d.ownerId === s.agent)?.remaining;

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, U);
    await enableV2(env, U, "manager");
    svc = new LandlordPayoutsService(env.t.pool as any, env.engine);
    const [trust] = await env.q(`select b.id, a.code from bank_accounts b join accounts a on a.id = b.gl_account_id where b.user_id = $1 and b.is_trust and b.is_default`, [U]);
    assert.equal(trust?.code, "1114", "Manager mode seeds the trust account on 1114");
    const c: any = await env.contracts.create(user, {
      unitIds: [s.unitA1], tenantId: s.tenant, tenantName: "Synthetic Tenant",
      startDate: firstOf(0), endDate: lastOf(11), monthlyRent: "3000", paymentFrequency: "monthly", vatEnabled: false,
    });
    const [p] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date limit 1`, [c.id]);
    await env.payments.addCollection(user, String(p.id), { amount: "3000", collectedDate: today, method: "cash" });
    await drain(env);
  });

  after(async () => { await env?.t.drop(); });

  it("the dues start at 3,000 and the rent sits in trust (1114)", async () => {
    assert.equal(await due(), 3000);
    const [t] = await env.q(`select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id where l.user_id = $1 and a.code = '1114'`, [U]);
    assert.equal(t.b, "3000.00");
  });

  it("refuses more than the net due (409 PAYOUT_EXCEEDS_DUE) without allowAdvance; nothing written, no number used", async () => {
    const over: any = await attempt(() => env.reports.createPayout(user, { ownerId: s.agent, amount: "3000.01", method: "bank_transfer", transferDate: today }));
    assert.equal(over.status, 409);
    assert.equal(over.body.error, "PAYOUT_EXCEEDS_DUE");
    assert.equal(over.body.netDue, "3000.00");
    assert.deepEqual([await count("landlord_payouts"), await count("finance_payout_vouchers"), await count("finance_payout_meta")], [0, 0, 0]);
  });

  it("refuses a future date and a foreign / unknown paid-from account (400/404), nothing written", async () => {
    const fut: any = await attempt(() => env.reports.createPayout(user, { ownerId: s.agent, amount: 10, transferDate: tomorrow }));
    assert.deepEqual([fut.status, fut.body.error], [400, "FUTURE_DATE"]);
    const nob: any = await attempt(() => env.reports.createPayout(user, { ownerId: s.agent, amount: 10, transferDate: today, bankAccountId: 999999 }));
    assert.deepEqual([nob.status, nob.body.error], [404, "BANK_ACCOUNT_NOT_FOUND"]);
    const badAmt: any = await attempt(() => env.reports.createPayout(user, { ownerId: s.agent, amount: "10.005", transferDate: today }));
    assert.equal(badAmt.status, 400);
    assert.equal(await count("landlord_payouts"), 0);
  });

  it("Manager mode, no paid-from: PV-000001; the voucher previews then shows the posted Dr 2121 / Cr 1114", async () => {
    first = await env.reports.createPayout(user, {
      ownerId: s.agent, amount: "1200.50", transferDate: today, method: "bank_transfer", reference: "TRX-1", notes: "October", requestId: "req-payout-0001",
    });
    assert.equal(first.voucherNumber, "PV-000001");
    assert.equal(first.amount, "1200.50");
    assert.equal(first.replayed, false);
    assert.equal(first.bankAccountId, null, "nothing chosen: the engine's default (trust) applies");

    const pre = await svc.voucher(U, first.id);
    assert.equal(pre.entry?.posted, false, "not posted yet: the preview");
    assert.deepEqual(pre.entry?.lines.map((l) => `${l.code} ${l.side} ${l.amount}`), ["2121 debit 1200.50", "1114 credit 1200.50"]);

    await drain(env);
    assert.deepEqual(await linesOf(first.id), ["2121 Dr 1200.5", "1114 Cr 1200.5"]);
    const v = await svc.voucher(U, first.id);
    assert.equal(v.number, "PV-000001");
    assert.equal(v.entry?.posted, true);
    assert.ok(v.entry?.entryNo);
    assert.deepEqual(v.entry?.lines.map((l) => `${l.code} ${l.side} ${l.amount}`), ["2121 debit 1200.50", "1114 credit 1200.50"]);
    assert.deepEqual([v.date, v.amount, v.method, v.reference, v.notes, v.treatment], [today, "1200.50", "bank_transfer", "TRX-1", "October", "agent"]);
    assert.equal(v.landlord.id, s.agent);
    assert.equal(v.landlord.name, "Synthetic Landlord A");
    assert.equal(v.paidFrom?.glCode, "1114");
    assert.equal(v.paidFrom?.isTrust, true);
    assert.equal(await due(), 1799.5);
  });

  it("the same requestId returns the first payout (also when sent twice at once); one row, one number", async () => {
    const again: any = await env.reports.createPayout(user, { ownerId: s.agent, amount: "1200.50", transferDate: today, requestId: "req-payout-0001" });
    assert.deepEqual([again.id, again.voucherNumber, again.replayed], [first.id, "PV-000001", true]);
    const body = { ownerId: s.agent, amount: "100", transferDate: today, method: "cash", requestId: "req-payout-0002" };
    const [a, b]: any[] = await Promise.all([env.reports.createPayout(user, body), env.reports.createPayout(user, body)]);
    assert.equal(a.id, b.id);
    assert.equal(a.voucherNumber, "PV-000002");
    assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
    assert.deepEqual([await count("landlord_payouts"), await count("finance_payout_vouchers")], [2, 2]);
    const bad: any = await attempt(() => env.reports.createPayout(user, { ...body, requestId: "x" }));
    assert.equal(bad.status, 400);
  });

  it("the payout is on the landlord statement (كشف حساب المؤجر) with its PV- number", async () => {
    await drain(env);
    const st: any = await new StatementsService(env.t.pool as any).landlordStatement(U, { ownerId: String(s.agent), lang: "ar" });
    const rows = st.lines.filter((l: any) => l.type === "payout");
    assert.deepEqual(rows.map((l: any) => [l.documentNumber, l.debit, l.method]), [["PV-000001", "1200.50", "bank_transfer"], ["PV-000002", "100.00", "cash"]]);
    assert.equal(st.summary.payouts, "-1300.50");
  });

  it("the voucher is scoped: another account (also on v2) gets 404, so does an unknown id", async () => {
    await seedAccount(env, OTHER);
    await enableV2(env, OTHER, "manager");
    for (const [scope, id] of [[OTHER, first.id], [U, 999999]]) {
      const r: any = await attempt(() => svc.voucher(scope, id));
      assert.equal(r.status, 404, `${scope}/${id}`);
    }
  });

  it("the account holder (principal) is not paid from trust: Dr 3400 drawings / Cr the default bank, never refused as above due", async () => {
    const r: any = await env.reports.createPayout(user, { ownerId: s.holder, amount: 50, transferDate: today, method: "bank_transfer" });
    assert.equal(r.voucherNumber, "PV-000003");
    await drain(env);
    const ls = await linesOf(r.id);
    assert.equal(ls[0], "3400 Dr 50");
    assert.notEqual(ls[1], "1114 Cr 50");
    const v = await svc.voucher(U, r.id);
    assert.equal(v.treatment, "principal");
    assert.equal(v.paidFrom?.isTrust, false);
  });

  it("a deleted payout reverses as before; its voucher says deleted and keeps its number", async () => {
    const r: any = await env.reports.createPayout(user, { ownerId: s.agent, amount: 10, transferDate: today });
    await drain(env);
    await env.reports.deletePayout(user, String(r.id));
    await drain(env);
    const v = await svc.voucher(U, r.id);
    assert.deepEqual([v.number, v.deleted], ["PV-000004", true]);
    const [e] = await env.q(`select status from journal_entries where user_id = $1 and source_type = 'landlord_payout' and source_id = $2 and event = 'created'`, [U, r.id]);
    assert.equal(e.status, "reversed");
  });

  it("flag off: the legacy response, no voucher, no v2 rows", async () => {
    const off = 6413;
    const so = await seedAccount(env, off);
    const r: any = await env.reports.createPayout({ ...userOf(off), permissions: PERMS }, { ownerId: so.agent, amount: 999, method: "cash", transferDate: today, requestId: "req-payout-off1" });
    assert.equal(r.amount, "999.00");
    assert.equal(r.voucherNumber, undefined);
    assert.equal((await env.q(`select count(*)::int as n from finance_payout_vouchers where user_id = $1`, [off]))[0].n, 0);
    assert.equal((await env.q(`select count(*)::int as n from finance_payout_meta where user_id = $1`, [off]))[0].n, 0);
  });
  it("two payouts racing past the net due: exactly one is paid, the other 409 (the dues are re-counted under the lock)", async () => {
    assert.equal(await due(), 1699.5);
    const body = (k: string) => ({ ownerId: s.agent, amount: "1000", transferDate: today, requestId: `req-race-${k}-0001` });
    const rs: any[] = await Promise.all([attempt(() => env.reports.createPayout(user, body("a"))), attempt(() => env.reports.createPayout(user, body("b")))]);
    assert.equal(rs.filter((r) => r?.voucherNumber).length, 1);
    assert.deepEqual(rs.filter((r) => r?.status === 409).map((r) => [r.body.error, r.body.netDue]), [["PAYOUT_EXCEEDS_DUE", "699.50"]]);
    assert.equal(await due(), 699.5);
  });

  it("as many payouts at once as the pool has connections all finish (the dues report never runs under the lock)", async () => {
    const max = (env.t.pool as any).options.max as number;
    const all = Promise.all(Array.from({ length: max }, (_, i) =>
      attempt(() => env.reports.createPayout(user, { ownerId: s.agent, amount: "1", transferDate: today, requestId: `req-starve-${i}-0001` }))));
    const r = await Promise.race([all.then(() => "done"), new Promise((ok) => setTimeout(() => ok("starved"), 10_000).unref())]);
    assert.equal(r, "done");
    assert.equal(await due(), 699.5 - max);
  });
});
