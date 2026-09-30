import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip } from "./__tests__/with-db";
import { attempt, enableV2, legacyEnv, normalise, seedAccount, userOf, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { riyadhToday } from "./dates";
import { withTx } from "./db";
import { toHalalas } from "./money";
import { JournalRepository } from "./journal.repository";
import { PeriodsService } from "./periods.service";
import { BankAccountsService } from "./tier1/bank-accounts.service";
import { ReconciliationService } from "./reports/reconciliation.service";
import { legacyAccountingFor } from "./reports/legacy-accounting";
import { FinanceSettingsService } from "./settings.service";
import { FinanceV2SettingsController } from "./controllers/settings.controller";
import { FinanceV2Guard } from "./finance-v2.guard";

/**
 * Staging-test defects of 30 Sep 2026 (FINANCE-V2-FIX-LIST items 7, 8, 11–14),
 * on the REAL legacy routes against a throwaway Postgres. Synthetic data only.
 *   ON   finance_v2 on (manager), hooks wired;
 *   OFF  hooks wired, flag off  — must equal BARE;
 *   BARE no finance-v2 line at all.
 */
const U = 5701;
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
const user = userOf(U);
const approver = { ...user, permissions: ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "invoices.delete"] };

async function drain(env: LegacyEnv) {
  await env.recognizer.runAccount(U);
  for (let i = 0; i < 10; i++) {
    const r = await env.worker.runAccount(U);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

interface Fx { s: Seed; c2: number; c3: number; unitA3: number }

/** C2: agent, deposit 5,000 not yet collected. C3: agent, monthly 1,000 from two months ago, first month collected. */
async function fixtures(env: LegacyEnv): Promise<Fx> {
  const s = await seedAccount(env, U);
  const [u3] = await env.q(`insert into units (property_id, unit_number) values ($1, 'A3') returning id`, [s.propA]);
  const c2: any = await env.contracts.create(user, {
    unitIds: [s.unitA1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(0), endDate: lastOf(11),
    monthlyRent: "2000", paymentFrequency: "monthly", vatEnabled: false, depositAmount: "5000", depositStatus: "pending", depositDueDate: firstOf(0),
  });
  const c3: any = await env.contracts.create(user, {
    unitIds: [s.unitA2], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(-2), endDate: lastOf(3),
    monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false,
  });
  const [p] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date limit 1`, [c3.id]);
  await env.payments.addCollection(user, String(p.id), { amount: "1000", collectedDate: firstOf(-2), method: "cash" });
  return { s, c2: c2.id, c3: c3.id, unitA3: Number(u3.id) };
}

describe("fv2 reconciliation and minor API fixes (real Postgres, real legacy routes)", { skip: fv2DbSkip }, () => {
  let on: LegacyEnv, off: LegacyEnv, bare: LegacyEnv;
  let fOn: Fx, fOff: Fx, fBare: Fx;
  let banks: BankAccountsService;
  let b2: any;
  const recon = (env: LegacyEnv) => new ReconciliationService(env.t.pool as any, legacyAccountingFor(drizzle(env.t.pool, { schema })))
    .reconciliation(U, { asOf: today, lang: "en" });
  const check = (r: any, id: string) => r.checks.find((c: any) => c.id === id);

  before(async () => {
    [on, off, bare] = [await legacyEnv("wired"), await legacyEnv("wired"), await legacyEnv("none")];
    await enableV2(on, U, "manager");
    fOn = await fixtures(on);
    fOff = await fixtures(off);
    fBare = await fixtures(bare);
    banks = new BankAccountsService(on.t.pool as any);
    await drain(on);
  });

  after(async () => {
    for (const e of [on, off, bare]) await e?.t.drop();
  });

  // ── Item 14: a new bank account's leaf is 1117, then 1118, 1119, then 111001 ──
  it("bank account GL codes follow the chart template: 1117 onwards, then 111001 onwards", async () => {
    b2 = await banks.create(U, U, { kind: "bank", nameAr: "بنك الاختبار الثاني", nameEn: "Test bank two" });
    assert.equal(b2.glCode, "1117");
    const b3 = await banks.create(U, U, { kind: "bank", nameAr: "بنك ثالث" });
    const b4 = await banks.create(U, U, { kind: "cash", nameAr: "صندوق ثانٍ" });
    const b5 = await banks.create(U, U, { kind: "bank", nameAr: "بنك خامس" });
    assert.deepEqual([b3.glCode, b4.glCode, b5.glCode], ["1118", "1119", "111001"]);
    // a freed code is reused, lowest first
    await banks.remove(U, U, b3.id);
    const b6 = await banks.create(U, U, { kind: "bank", nameAr: "بنك سادس" });
    assert.equal(b6.glCode, "1118");
    for (const b of [b4, b5, b6]) await banks.remove(U, U, b.id);
  });

  // ── Item 7a: R4 routes a deposit voucher to the bank it was collected into ──
  it("R4: a deposit collected into B2 counts against B2 (ledger and sub-ledger agree)", async () => {
    await on.contracts.collectDeposit(user, String(fOn.c2), { paidDate: today, method: "bank_transfer", bankAccountId: b2.id });
    await drain(on);
    const [line] = await on.q(
      `select a.code, l.debit::text as debit from journal_lines l join accounts a on a.id = l.account_id join journal_entries e on e.id = l.entry_id
        where e.user_id = $1 and e.payload->>'rule' = 'E09' and l.debit > 0`, [U]);
    assert.deepEqual([line.code, line.debit], ["1117", "5000.00"], "the ledger books B2");
    const r4 = check(await recon(on), "R4");
    assert.deepEqual([r4.status, r4.difference, r4.rows], ["ok", "0.00", []]);
    const bal = r4.explanations.find((e: any) => e.code === "balances").items.find((x: any) => x.code === "1117");
    assert.deepEqual([bal.ledger, bal.subLedger], ["5000.00", "5000.00"]);
  });

  // ── Item 7b: R4 counts the reversal of a manual journal on both sides ──
  it("R4: a reversed manual journal nets to zero on both sides", async () => {
    const periods = new PeriodsService(on.t.pool as any);
    const repo = new JournalRepository(periods);
    const acc = Object.fromEntries((await on.q(`select code, id from accounts where user_id = $1`, [U])).map((r: any) => [r.code, r.id]));
    const mj = await withTx(on.t.pool, (c) => repo.post(c, {
      userId: U, entryDate: today, origin: "manual", sourceType: "manual_journal", sourceId: 990001, event: "approved",
      lines: [{ accountId: acc["1113"], debit: toHalalas("9995.00") }, { accountId: acc["3100"], credit: toHalalas("9995.00") }], payload: {},
    }));
    assert.equal(check(await recon(on), "R4").status, "ok", "the manual entry alone is on both sides");
    await withTx(on.t.pool, (c) => repo.reverse(c, U, mj.id, { entryDate: today }));
    const r4 = check(await recon(on), "R4");
    assert.deepEqual([r4.status, r4.difference, r4.rows], ["ok", "0.00", []], "…and so is its reversal");
  });

  // ── Item 13: generate-installments on a v2 contract with collected rows → the v2 409 ──
  it("generate-installments: v2 answers 409 FINANCE_V2_INSTALLMENTS_LINKED before the legacy 'skipped'; flag off is unchanged", async () => {
    const r: any = await attempt(() => on.contracts.generateInstallments(user, String(fOn.c3), {}));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "FINANCE_V2_INSTALLMENTS_LINKED");
    const o = await off.contracts.generateInstallments(user, String(fOff.c3), {});
    const b = await bare.contracts.generateInstallments(user, String(fBare.c3), {});
    assert.deepEqual(o, { success: false, skipped: true, reason: "has_collected_payments", installmentsCreated: 0 });
    assert.deepEqual(o, b);
  });

  // ── Item 8: R3 keeps a terminated contract's landlord ──
  it("R3: terminating an agent contract (units unlinked) keeps its collections on the landlord", async () => {
    assert.equal(check(await recon(on), "R3").status, "ok", "before terminate");
    const open = await on.q(
      `select id from payments where contract_id = $1 and deleted_at is null and status::text in ('pending','overdue','partially_paid') order by due_date`, [fOn.c3]);
    await on.contracts.terminate(approver, String(fOn.c3), {
      mode: "cancelled", dispositions: open.map((p: any) => ({ paymentId: Number(p.id), action: "cancel" })),
    });
    assert.equal((await on.q(`select count(*)::int as n from contract_units where contract_id = $1`, [fOn.c3]))[0].n, 0, "legacy terminate unlinks the units");
    await drain(on);
    const r3 = check(await recon(on), "R3");
    assert.deepEqual([r3.status, r3.difference, r3.rows], ["ok", "0.00", []]);
    assert.deepEqual(r3.explanations.find((e: any) => e.code === "unresolved_landlords_in_dues_report").items, []);
    // The flag-on landlord dues show it too.
    const acc: any = await on.reports.accounting(user);
    const due = acc.landlordDues.find((d: any) => d.ownerId === fOn.s.agent);
    assert.equal(due.remaining, 1000);
    assert.equal(acc.landlordDues.some((d: any) => d.ownerId == null), false);
  });

  it("flag off: the legacy dues report after a terminate is byte-identical to the code with no v2 line", async () => {
    for (const [env, f] of [[off, fOff], [bare, fBare]] as const) {
      await env.contracts.terminate(user, String(f.c3), { mode: "cancelled" });
    }
    assert.deepEqual(normalise(await off.reports.accounting(user)), normalise(await bare.reports.accounting(user)));
    assert.equal(await on.hooks.contractPropertySnapshots(U + 999).then((m) => m.size), 0, "no snapshot for an account without v2");
  });

  // ── Item 12: deleting the same expense twice ──
  it("DELETE /reports/expenses/:id twice: v2 answers 404 the second time (and for a foreign id); one reversal; flag off unchanged", async () => {
    const mk = (env: LegacyEnv, f: Fx) => env.reports.createExpense(user, { ownerId: f.s.agent, propertyId: f.s.propA, category: "صيانة", amount: "115" });
    const e: any = await mk(on, fOn);
    assert.deepEqual(await on.reports.deleteExpense(user, String(e.id)), { ok: true });
    const again: any = await attempt(() => on.reports.deleteExpense(user, String(e.id)));
    assert.equal(again.status, 404);
    const foreign: any = await attempt(() => on.reports.deleteExpense(user, "99999999"));
    assert.equal(foreign.status, 404);
    await drain(on);
    const rev = await on.q(`select count(*)::int as n from journal_entries where user_id = $1 and source_type = 'expense' and source_id = $2 and origin = 'reversal'`, [U, e.id]);
    assert.equal(rev[0].n, 1);
    for (const [env, f] of [[off, fOff], [bare, fBare]] as const) {
      const x: any = await mk(env, f);
      assert.deepEqual(await env.reports.deleteExpense(user, String(x.id)), { ok: true });
      assert.deepEqual(await env.reports.deleteExpense(user, String(x.id)), { ok: true }, "legacy: 200 every time");
    }
  });

  it("the whole reconciliation is clean after all of the above", async () => {
    const r: any = await recon(on);
    const bad = r.checks.filter((c: any) => c.status === "difference").map((c: any) => [c.id, c.difference, c.rows]);
    assert.deepEqual(bad, []);
    const [f] = await on.q(`select count(*)::int as n from ledger_outbox where user_id = $1 and status = 'failed'`, [U]);
    assert.equal(f.n, 0);
  });

  // ── Item 11: /finance/v2/settings ──
  describe("GET / PATCH /finance/v2/settings", () => {
    let svc: FinanceSettingsService;
    before(() => { svc = new FinanceSettingsService(on.t.pool as any); });

    it("routes: view to read, settings to change; both behind the flag guard", () => {
      const guards = Reflect.getMetadata("__guards__", FinanceV2SettingsController) ?? [];
      assert.ok(guards.includes(FinanceV2Guard));
      const p = FinanceV2SettingsController.prototype as any;
      assert.equal(Reflect.getMetadata("fv2:capability", p.get), "view");
      assert.equal(Reflect.getMetadata("fv2:capability", p.patch), "settings");
    });

    it("GET returns the settings with the mode read-only", async () => {
      const s: any = await svc.get(U);
      assert.equal(s.accountingMode, "manager");
      assert.equal(s.depositForfeitVat, "O");
      assert.equal(s.commissionBasis, "billed");
      assert.equal(s.agencyCollectionsToTrust, false);
      assert.equal(s.vatFilingFrequency, "quarterly");
      assert.equal(typeof s.defaultBankAccountId, "number");
      assert.deepEqual([...s.readOnly].sort(), ["accountingMode", "deferRentStraightLine", "fiscalYearStartMonth", "inputVatMethod"]);
      assert.deepEqual([...s.editable].sort(), ["agencyCollectionsToTrust", "commissionBasis", "defaultBankAccountId", "defaultCashAccountId", "depositForfeitVat", "vatFilingFrequency"]);
    });

    it("PATCH validates: reason, unknown and read-only fields, values, ids in scope", async () => {
      const code = async (body: any) => { const r: any = await attempt(() => svc.patch(U, U, body)); return [r.status, r.body?.error]; };
      assert.deepEqual(await code({ depositForfeitVat: "S" }), [400, "REASON_REQUIRED"]);
      assert.deepEqual(await code({ reason: "synthetic change" }), [400, "NOTHING_TO_CHANGE"]);
      assert.deepEqual(await code({ reason: "synthetic change", foo: 1 }), [400, "UNKNOWN_FIELD"]);
      assert.deepEqual(await code({ reason: "synthetic change", accountingMode: "owner" }), [400, "FIELD_READ_ONLY"]);
      assert.deepEqual(await code({ reason: "synthetic change", fiscalYearStartMonth: 4 }), [400, "FIELD_READ_ONLY"]);
      assert.deepEqual(await code({ reason: "synthetic change", depositForfeitVat: "X" }), [400, "BAD_VALUE"]);
      assert.deepEqual(await code({ reason: "synthetic change", vatFilingFrequency: "yearly" }), [400, "BAD_VALUE"]);
      assert.deepEqual(await code({ reason: "synthetic change", agencyCollectionsToTrust: "yes" }), [400, "BAD_VALUE"]);
      assert.deepEqual(await code({ reason: "synthetic change", commissionBasis: "collected" }), [409, "COMMISSION_BASIS_UNAVAILABLE"]);
      const cash = (await banks.list(U)).find((b) => b.kind === "cash")!;
      assert.deepEqual(await code({ reason: "synthetic change", defaultBankAccountId: cash.id }), [400, "BAD_BANK_ACCOUNT"]);
      assert.deepEqual(await code({ reason: "synthetic change", defaultCashAccountId: b2.id }), [400, "BAD_BANK_ACCOUNT"]);
      assert.deepEqual(await code({ reason: "synthetic change", defaultBankAccountId: 99999999 }), [404, "BANK_ACCOUNT_NOT_FOUND"]);
      assert.deepEqual(await code({ reason: "synthetic change", agencyCollectionsToTrust: true }), [400, "TRUST_ACCOUNT_REQUIRED"]);
      assert.equal((await on.q(`select count(*)::int as n from finance_settings_events where account_user_id = $1 and reason = 'synthetic change'`, [U]))[0].n, 0, "nothing written");
    });

    it("PATCH applies, writes one settings event per changed field and an audit row, and keeps bank defaults consistent", async () => {
      const r: any = await svc.patch(U, U, { reason: "synthetic change", depositForfeitVat: "S", vatFilingFrequency: "monthly", defaultBankAccountId: b2.id, commissionBasis: "billed" });
      assert.equal(r.depositForfeitVat, "S");
      assert.equal(r.vatFilingFrequency, "monthly");
      assert.equal(r.defaultBankAccountId, b2.id);
      const ev = await on.q(`select field, old_value, new_value from finance_settings_events where account_user_id = $1 and reason = 'synthetic change' order by id`, [U]);
      assert.deepEqual(ev.map((e: any) => e.field), ["deposit_forfeit_vat", "vat_filing_frequency", "default_bank_account_id"], "unchanged commissionBasis writes nothing");
      assert.deepEqual([ev[0].old_value, ev[0].new_value], ["O", "S"]);
      assert.equal((await on.q(`select count(*)::int as n from audit_logs where owner_user_id = $1 and entity = 'finance_v2_settings' and method = 'PATCH'`, [U]))[0].n, 1);
      const defaults = await on.q(`select id from bank_accounts where user_id = $1 and kind = 'bank' and not is_trust and is_default`, [U]);
      assert.deepEqual(defaults.map((x: any) => x.id), [b2.id], "exactly one default bank, the new one");
      // a trust account makes trust routing possible
      const t = await banks.create(U, U, { kind: "bank", nameAr: "حساب الأمانات", isTrust: true, isDefault: true });
      const r2: any = await svc.patch(U, U, { reason: "synthetic trust", agencyCollectionsToTrust: true });
      assert.equal(r2.agencyCollectionsToTrust, true);
      void t;
    });

    it("vatFilingFrequency is refused once a VAT return is locked", async () => {
      await on.q(`update fiscal_periods set vat_locked_at = now() where user_id = $1 and id = (select min(id) from fiscal_periods where user_id = $1)`, [U]);
      const r: any = await attempt(() => svc.patch(U, U, { reason: "synthetic change", vatFilingFrequency: "quarterly" }));
      assert.deepEqual([r.status, r.body.error], [409, "VAT_RETURN_LOCKED"]);
      // (a VAT lock is irreversible, so this is the last test on the account)
    });
  });
});
