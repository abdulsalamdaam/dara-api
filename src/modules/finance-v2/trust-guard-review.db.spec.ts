import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { riyadhToday } from "./dates";
import { PeriodsService } from "./periods.service";
import { JournalRepository } from "./journal.repository";
import { AccountTransferService } from "./tier1/account-transfer.service";
import { trustAvailability } from "./trust-guard";

/** Review regressions for trust-guard.ts (synthetic data only): see each case. */

const U = 6491;
const today = riyadhToday();
const firstOf = (n: number) => { const [y, m] = today.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10); };
const lastOf = (n: number) => { const d = new Date(`${firstOf(n + 1)}T00:00:00Z`); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "contracts.view", "contracts.write", "contracts.delete"];
const user = { ...userOf(U), permissions: PERMS };

async function drain(env: LegacyEnv, u: number) {
  await env.recognizer.runAccount(u);
  for (let i = 0; i < 12; i++) { const r = await env.worker.runAccount(u); if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break; }
}

describe("fv2 trust guard: rows that may never post, replay, races, contract end (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv; let s: Seed; let transfers: AccountTransferService; let trustId: number; let officeId: number; let contractId: number;
  const avail = async () => (await trustAvailability(env.t.pool as any, U)).accounts.find((a) => a.glCode === "1114")!;
  before(async () => {
    env = await legacyEnv("wired"); s = await seedAccount(env, U); await enableV2(env, U, "manager");
    const periods = new PeriodsService(env.t.pool);
    transfers = new AccountTransferService(env.t.pool as any, new JournalRepository(periods), periods);
    trustId = Number((await env.q(`select id from bank_accounts where user_id = $1 and is_trust and is_default`, [U]))[0].id);
    officeId = Number((await env.q(`select b.id from bank_accounts b join accounts a on a.id = b.gl_account_id where b.user_id = $1 and a.code = '1113'`, [U]))[0].id);
    const c: any = await env.contracts.create(user, { unitIds: [s.unitA1], tenantId: s.tenant, tenantName: "T", startDate: firstOf(0), endDate: lastOf(11), monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false });
    contractId = c.id;
  });
  after(async () => { await env?.t.drop(); });

  it("E: collect right after contract create (nothing drained) counts", async () => {
    const [p] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date limit 1`, [contractId]);
    await env.payments.addCollection(user, String(p.id), { amount: "1000", collectedDate: today, method: "cash" });
    const a = await avail();
    assert.equal(a.available, "1000.00");
    const r: any = await attempt(() => env.reports.createPayout(user, { ownerId: s.agent, amount: "1000", transferDate: today, method: "bank_transfer", requestId: "probe-replay-1" }));
    assert.ok(r.voucherNumber, JSON.stringify(r));
    const again: any = await attempt(() => env.reports.createPayout(user, { ownerId: s.agent, amount: "1000", transferDate: today, method: "bank_transfer", requestId: "probe-replay-1" }));
    assert.ok(again.voucherNumber, "replay is not refused: " + JSON.stringify(again));
    await drain(env, U);
    assert.equal((await avail()).available, "0.00");
  });

  it("A: a collection that keeps failing to post (pending, retrying) is not money to pay out", async () => {
    const [p] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null and due_date >= $2 order by due_date limit 1`, [contractId, firstOf(1)]);
    await env.payments.addCollection(user, String(p.id), { amount: "1000", collectedDate: today, method: "cash" });
    await env.q(`update ledger_outbox set attempts = 3, last_error = 'boom', next_attempt_at = now() + interval '1 hour' where user_id = $1 and status = 'pending'`, [U]);
    const a = await avail();
    await env.q(`update ledger_outbox set attempts = 0, last_error = null, next_attempt_at = now() where user_id = $1 and status = 'pending'`, [U]);
    await drain(env, U);
    assert.equal(a.available, "0.00", "a retrying inflow should not be spendable");
  });

  it("B: a FAILED reversal of a posted payout gives nothing back", async () => {
    assert.equal((await avail()).available, "1000.00");
    const r: any = await env.reports.createPayout(user, { ownerId: s.agent, amount: "600", transferDate: today, method: "bank_transfer" });
    await drain(env, U);
    assert.equal((await avail()).available, "400.00");
    await env.reports.deletePayout(user, String(r.id));
    const rows = await env.q(`select id, event, status, attempts, blocked_on, last_error, next_attempt_at > now() as later from ledger_outbox where user_id = $1 and status = 'pending'`, [U]);
    await env.q(`update ledger_outbox set status = 'failed', attempts = 8 where user_id = $1 and status = 'pending'`, [U]);
    const a = await avail();
    assert.equal(a.available, "400.00", "failed reversal of a payout must not count as money back");
  });

  it("C: mixed concurrent outflows + worker: no deadlock, no 500", async () => {
    await env.q(`update ledger_outbox set status = 'pending', attempts = 0, next_attempt_at = now() where user_id = $1 and status = 'failed'`, [U]);
    await drain(env, U);
    await transfers.create(U, user, { fromBankAccountId: officeId, toBankAccountId: trustId, amount: "5000" });
    const ops: Array<Promise<any>> = [];
    for (let i = 0; i < 6; i++) {
      ops.push(attempt(() => env.reports.createPayout(user, { ownerId: s.agent, amount: "300", transferDate: today, method: "bank_transfer", allowAdvance: true })));
      ops.push(attempt(() => transfers.create(U, user, { fromBankAccountId: trustId, toBankAccountId: officeId, amount: "300" })));
      ops.push(env.worker.runAccount(U).catch((e: any) => ({ status: 500, body: String(e) })));
    }
    const res = await Promise.all(ops);
    const bad = res.filter((x: any) => x && x.status && x.status !== 409);
    assert.deepEqual(bad, []);
  });

  it("G: terminate refunding deposit + advance + installments: guard's required == actual trust outflow", async () => {
    const G = 6492;
    const seed = await seedAccount(env, G); await enableV2(env, G, "manager");
    const gu = { ...userOf(G), permissions: PERMS };
    const c: any = await env.contracts.create(gu, { unitIds: [seed.unitA1], tenantId: seed.tenant, tenantName: "T", startDate: firstOf(0), endDate: lastOf(11),
      monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false, depositAmount: "700", depositStatus: "collected", depositMethod: "bank_transfer", depositDueDate: today });
    const ps = await env.q(`select id, description from payments where contract_id = $1 and deleted_at is null order by due_date`, [c.id]);
    const inst = ps.filter((p: any) => p.description !== "تأمين (وديعة)");
    await env.payments.addCollection(gu, String(inst[0].id), { amount: "1000", collectedDate: today, method: "cash" });
    await env.payments.addCollection(gu, String(inst[1].id), { amount: "400", collectedDate: today, method: "cash" });
    await drain(env, G);
    const bal = async () => (await env.q(`select coalesce(sum(l.debit - l.credit),0)::text as b from journal_lines l join accounts a on a.id = l.account_id where l.user_id = $1 and a.code = '1114'`, [G]))[0].b;
    const before = await bal();
    { // empty trust
      const t = Number((await env.q(`select id from bank_accounts where user_id = $1 and is_trust and is_default`, [G]))[0].id);
      const o = Number((await env.q(`select b.id from bank_accounts b join accounts a on a.id = b.gl_account_id where b.user_id = $1 and a.code = '1113'`, [G]))[0].id);
      await transfers.create(G, gu, { fromBankAccountId: t, toBankAccountId: o, amount: before });
    }
    const body = { mode: "cancelled", deposit: "refund", advance: "refund", installments: "refund", refundMethod: "bank_transfer",
      dispositions: inst.slice(1).map((p: any) => ({ paymentId: Number(p.id), action: "cancel" })) };
    const r: any = await attempt(() => env.contracts.terminate(gu, String(c.id), body));
    const ok: any = await attempt(() => env.contracts.terminate(gu, String(c.id), { ...body, allowTrustOverdraw: true }));
    await drain(env, G);
    const after = await bal();
    assert.equal(r.body?.required, (0 - Number(after)).toFixed(2));
  });
});
