import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../finance-v2/__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "../finance-v2/__tests__/legacy-env";
import { riyadhToday } from "../finance-v2/dates";
import { JournalQueryService } from "../finance-v2/journal-query.service";
import { ContractDepositController } from "./contract-deposit.module";

/**
 * TR-5 (deposit after creation) and TR-11 (journal dimension names), on the
 * REAL legacy contract routes against a throwaway Postgres. Synthetic data only.
 *   ON   finance v2 on (manager), hooks wired — every receipt posts E09 to 2141;
 *   OFF  hooks wired, flag off — the same documents, no ledger rows.
 */
const U = 7841;
const today = riyadhToday();
const user = userOf(U);
const plusMonths = (n: number) => {
  const [y, m] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};

async function drain(env: LegacyEnv) {
  for (let i = 0; i < 10; i++) {
    const r = await env.worker.runAccount(U);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

interface Fx { s: Seed; c: number; draft: number; ctl: ContractDepositController }

async function fixtures(env: LegacyEnv): Promise<Fx> {
  const s = await seedAccount(env, U);
  const c: any = await env.contracts.create(user, {
    unitIds: [s.unitA1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: plusMonths(0), endDate: plusMonths(12),
    monthlyRent: "2000", paymentFrequency: "monthly", vatEnabled: false,
  });
  const d: any = await env.contracts.create(user, {
    unitIds: [s.unitA2], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: plusMonths(0), endDate: plusMonths(12),
    monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false, isDraft: true,
  });
  const ctl = new ContractDepositController(env.db);
  ctl.fv2h = env.hooks;
  return { s, c: c.id, draft: d.id, ctl };
}

const held = async (env: LegacyEnv) => {
  const [r] = await env.q(
    `select coalesce(sum(l.credit - l.debit), 0)::text as v from journal_lines l join accounts a on a.id = l.account_id
      where l.user_id = $1 and a.system_key = 'deposits_held'`, [U]);
  return r.v as string;
};

describe("contract deposit after creation + journal dimension names (real Postgres)", { skip: fv2DbSkip }, () => {
  let on: LegacyEnv, off: LegacyEnv;
  let fOn: Fx, fOff: Fx;

  before(async () => {
    [on, off] = [await legacyEnv("wired"), await legacyEnv("wired")];
    await enableV2(on, U, "manager");
    fOn = await fixtures(on);
    fOff = await fixtures(off);
    await drain(on);
  });
  after(async () => {
    for (const e of [on, off]) await e?.t.drop();
  });

  it("a deposit is added to a live contract that had none, then collected → E09 into 2141", async () => {
    const v = await fOn.ctl.setTerms(user, String(fOn.c), { amount: "3000", dueDate: today, method: "bank_transfer" });
    assert.deepEqual([v.amount, v.status, v.received, v.outstanding, v.canEditTerms, v.canTopUp], [3000, "pending", 0, 3000, true, false]);
    const col = await on.contracts.collectDeposit(user, String(fOn.c), { paidDate: today, method: "bank_transfer" });
    assert.equal(Number(col.voucher.total), 3000);
    await drain(on);
    assert.equal(await held(on), "3000.00");
  });

  it("once receipted the terms are not edited: a lower amount is a 409, never a silent change", async () => {
    const r: any = await attempt(() => fOn.ctl.setTerms(user, String(fOn.c), { amount: "2500" }));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "DEPOSIT_RECEIPTED");
    const [c] = await on.q(`select deposit_amount::text as a from contracts where id = $1`, [fOn.c]);
    assert.equal(c.a, "3000.00");
  });

  it("an additional deposit is a NEW receipt (own RV, own E09); the first receipt is untouched", async () => {
    const [first] = await on.q(`select id, number, total::text as total from simple_invoices where contract_id = $1 and kind = 'deposit'`, [fOn.c]);
    const r = await fOn.ctl.topUp(user, String(fOn.c), { amount: "500", paidDate: today, method: "cash" });
    assert.notEqual(r.voucher.number, first.number);
    assert.equal(r.voucher.status, "confirmed");
    assert.deepEqual([r.deposit.amount, r.deposit.received, r.deposit.outstanding, r.deposit.receipts.length], [3500, 3500, 0, 2]);
    const [again] = await on.q(`select total::text as total, status from simple_invoices where id = $1`, [first.id]);
    assert.deepEqual([again.total, again.status], ["3000.00", "confirmed"]);
    await drain(on);
    assert.equal(await held(on), "3500.00");
    const e09 = await on.q(`select count(*)::int as n from journal_entries where user_id = $1 and payload->>'rule' = 'E09'`, [U]);
    assert.equal(e09[0].n, 2);
    const errs = await on.q(`select count(*)::int as n from ledger_outbox where user_id = $1 and status = 'failed'`, [U]);
    assert.equal(errs[0].n, 0);
  });

  it("refusals: a draft contract, a top-up before any receipt, a bad amount", async () => {
    const d: any = await attempt(() => fOn.ctl.setTerms(user, String(fOn.draft), { amount: "100" }));
    assert.deepEqual([d.status, d.body.error], [400, "DEPOSIT_CONTRACT_DRAFT"]);
    const t: any = await attempt(() => fOff.ctl.topUp(user, String(fOff.c), { amount: "100" }));
    assert.deepEqual([t.status, t.body.error], [409, "DEPOSIT_NOT_RECEIPTED"]);
    const b: any = await attempt(() => fOff.ctl.setTerms(user, String(fOff.c), { amount: "10.555" }));
    assert.equal(b.status, 400);
  });

  it("flag off: the same routes write the same documents and no ledger rows", async () => {
    await fOff.ctl.setTerms(user, String(fOff.c), { amount: "3000" });
    await off.contracts.collectDeposit(user, String(fOff.c), { paidDate: today, method: "bank_transfer" });
    const r = await fOff.ctl.topUp(user, String(fOff.c), { amount: "500", paidDate: today });
    assert.deepEqual([r.deposit.amount, r.deposit.received], [3500, 3500]);
    const n = await off.q(`select count(*)::int as n from ledger_outbox where user_id = $1`, [U]);
    assert.equal(n[0].n, 0);
  });

  it("TR-11: a journal entry's lines carry the names of their dimensions", async () => {
    const [e] = await on.q(`select id from journal_entries where user_id = $1 and payload->>'rule' = 'E09' order by id limit 1`, [U]);
    const svc = new JournalQueryService(on.t.pool as any, on.engine);
    const entry: any = await svc.get(U, Number(e.id));
    const withTenant = entry.lines.find((l: any) => l.tenantId != null);
    assert.ok(withTenant, "an E09 line names the tenant");
    assert.equal(withTenant.tenantName, "Synthetic Tenant");
    const [c] = await on.q(`select contract_number from contracts where id = $1`, [fOn.c]);
    for (const l of entry.lines) {
      if (l.contractId != null) assert.equal(l.contractNumber, c.contract_number);
      if (l.ownerId != null) assert.equal(l.ownerName, "Synthetic Landlord A");
      if (l.propertyId != null) assert.equal(l.propertyName, "Synthetic Tower");
      if (l.unitId != null) assert.equal(l.unitNumber, "A1");
      if (l.documentId != null) assert.match(String(l.documentNumber), /^RV-/);
      if (l.bankAccountId != null) assert.ok(l.bankAccountNameAr);
    }
    assert.ok(entry.lines.some((l: any) => l.ownerName || l.propertyName), "owner or property named");
  });
});
