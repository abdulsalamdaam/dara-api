import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv } from "./__tests__/legacy-env";
import { riyadhToday } from "./dates";
import { PeriodsService } from "./periods.service";
import { JournalRepository } from "./journal.repository";
import { ManualJournalsService } from "./manual-journals.service";
import { FinanceSettingsService } from "./settings.service";

/**
 * Second-person approval for large manual journals (accountant notes, 27 Nov 2026, note 18; 0102): a setting in the
 * finance settings — on + amount — under which the preparer of a manual journal at or above the amount cannot
 * approve it, the account holder included. Off: the existing rules (the holder approves his own). Synthetic data only.
 */
const today = riyadhToday();
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "contracts.view", "contracts.write", "contracts.delete"];

describe("fv2 manual journals: second-person approval above an amount (real Postgres)", { skip: fv2DbSkip }, () => {
  const M = 6471; // the account holder, with an employee E who can approve
  const E = 6472;
  const S = 6473; // a one-person account
  let env: LegacyEnv;
  let mj: ManualJournalsService;
  let settings: FinanceSettingsService;
  const acc: Record<number, Record<string, number>> = {};
  const holder = { ...userOf(M), permissions: [...PERMS, "settings.write"] } as any;
  const emp = { ...userOf(E), ownerUserId: M, role: "accountant", permissions: PERMS } as any;
  const L = (u: number, code: string, side: "d" | "c", amt: string) => ({ accountId: acc[u][code], debit: side === "d" ? amt : "0", credit: side === "c" ? amt : "0" });
  const plain = (u: number, amt: string) => [L(u, "5290", "d", amt), L(u, "1113", "c", amt)];
  const err = async (p: Promise<unknown>) => { const r: any = await attempt(() => p); return [r.status, r.body?.error]; };
  const draft = async (u: number, who: any, amt: string) => {
    const d: any = await mj.create(u, who, { entryDate: today, memo: "تسوية", lines: plain(u, amt) });
    await mj.submit(u, who, d.id);
    return d.id as number;
  };

  before(async () => {
    env = await legacyEnv("wired");
    await seedAccount(env, M);
    await enableV2(env, M, "manager");
    await seedAccount(env, S);
    await enableV2(env, S, "owner");
    const role = Number((await env.q(`insert into roles (key, label_ar, label_en, permissions) values ('accountant', 'محاسب', 'Accountant', $1::jsonb) returning id`, [JSON.stringify(PERMS)]))[0].id);
    await env.q(`insert into users (id, email, password_hash, name, owner_user_id, role_id) values ($1, $2, 'x', 'Synthetic Accountant', $3, $4)`, [E, `fv2-emp-${E}@example.test`, M, role]);
    const periods = new PeriodsService(env.t.pool);
    mj = new ManualJournalsService(env.t.pool, new JournalRepository(periods), periods);
    settings = new FinanceSettingsService(env.t.pool);
    for (const u of [M, S]) acc[u] = Object.fromEntries((await env.q(`select code, id from accounts where user_id = $1`, [u])).map((r: any) => [r.code, Number(r.id)]));
  });
  after(async () => { await env?.t.drop(); });

  it("off by default: the holder approves his own journal of any size, as before", async () => {
    const s: any = await settings.get(M);
    assert.equal(s.manualJournalSecondApproval, false);
    assert.equal(s.manualJournalSecondApprovalMin, "0.00");
    assert.equal(s.manualJournalApprovers, 2);
    assert.equal(s.manualJournalSecondApproverAvailable, true);
    assert.ok(s.editable.includes("manualJournalSecondApproval") && s.editable.includes("manualJournalSecondApprovalMin"));
    const id = await draft(M, holder, "6000");
    assert.equal((await mj.approve(M, holder, id) as any).status, "posted");
  });

  it("a one-person account cannot turn it on (409 SECOND_APPROVER_REQUIRED) and is told why", async () => {
    const s: any = await settings.get(S);
    assert.equal(s.manualJournalApprovers, 1);
    assert.equal(s.manualJournalSecondApproverAvailable, false);
    const r: any = await attempt(() => settings.patch(S, S, { manualJournalSecondApproval: true, manualJournalSecondApprovalMin: "5000", reason: "Synthetic: four eyes" }));
    assert.deepEqual([r.status, r.body.error], [409, "SECOND_APPROVER_REQUIRED"]);
    assert.match(r.body.message, /مستخدماً آخر/);
    assert.equal((await settings.get(S) as any).manualJournalSecondApproval, false, "nothing changed");
  });

  it("validates the amount", async () => {
    for (const v of ["-1", "abc", "1.234", true]) {
      assert.deepEqual(await err(settings.patch(M, M, { manualJournalSecondApprovalMin: v, reason: "Synthetic: bad amount" })), [400, "BAD_VALUE"], String(v));
    }
  });

  it("on at 5,000: at or above it the preparer — the holder included — cannot approve (403 SECOND_APPROVAL_REQUIRED); another approver can", async () => {
    const s: any = await settings.patch(M, M, { manualJournalSecondApproval: true, manualJournalSecondApprovalMin: "5000", reason: "Synthetic: four eyes" });
    assert.equal(s.manualJournalSecondApproval, true);
    assert.equal(s.manualJournalSecondApprovalMin, "5000.00");
    const ev = await env.q(`select field, new_value from finance_settings_events where account_user_id = $1 and field like 'manual_journal_second%' order by id`, [M]);
    assert.deepEqual(ev.map((e: any) => [e.field, e.new_value]), [["manual_journal_second_approval", true], ["manual_journal_second_approval_min", "5000.00"]]);
    // Re-sending the same values changes nothing.
    await settings.patch(M, M, { manualJournalSecondApproval: true, manualJournalSecondApprovalMin: "5000.00", reason: "Synthetic: same again" });
    assert.equal((await env.q(`select count(*)::int n from finance_settings_events where account_user_id = $1 and field like 'manual_journal_second%'`, [M]))[0].n, 2);

    const big = await draft(M, holder, "5000");
    const r: any = await attempt(() => mj.approve(M, holder, big));
    assert.deepEqual([r.status, r.body.error], [403, "SECOND_APPROVAL_REQUIRED"]);
    assert.match(r.body.message, /يعتمده مستخدم آخر/);
    assert.equal((await mj.get(M, big)).status, "submitted");
    assert.equal((await mj.approve(M, emp, big) as any).status, "posted");

    // Below the amount: unchanged (the holder approves his own).
    const small = await draft(M, holder, "4999.99");
    assert.equal((await mj.approve(M, holder, small) as any).status, "posted");
  });

  it("the employee who prepared it cannot approve it; nor can one who only edited or submitted it", async () => {
    const id = await draft(M, emp, "7000");
    // An employee never approved his own draft (the existing rule answers first).
    assert.deepEqual(await err(mj.approve(M, emp, id)), [403, "SAME_APPROVER"]);
    assert.equal((await mj.approve(M, holder, id) as any).status, "posted");

    const d: any = await mj.create(M, holder, { entryDate: today, memo: "تسوية", lines: plain(M, "8000") });
    await mj.update(M, emp, d.id, { memo: "تسوية بعد المراجعة" });
    await mj.submit(M, emp, d.id);
    assert.deepEqual(await err(mj.approve(M, emp, d.id)), [403, "SECOND_APPROVAL_REQUIRED"]);
    assert.deepEqual(await err(mj.approve(M, holder, d.id)), [403, "SECOND_APPROVAL_REQUIRED"]);
  });

  it("turned off again: the holder approves his own large journal", async () => {
    await settings.patch(M, M, { manualJournalSecondApproval: false, reason: "Synthetic: back off" });
    const id = await draft(M, holder, "9000");
    assert.equal((await mj.approve(M, holder, id) as any).status, "posted");
  });
});
