import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../__tests__/with-db";
import { attempt, enableV2, legacyEnv, normalise, seedAccount, userOf, type LegacyEnv, type Seed } from "../__tests__/legacy-env";
import { riyadhToday } from "../dates";
import { BankAccountsService } from "./bank-accounts.service";
import { ExpensesV2Service } from "./expenses-v2.service";
import { TenantCreditsService } from "./tenant-credits.service";
import { ArAgingService } from "../reports/aging.service";
import { makeSaudiIban } from "./iban";
import { FinanceV2BugsController } from "../controllers/bugs.controller";
import { FinanceV2Tier1Controller } from "../controllers/tier1.controller";
import { extractEvents, keyOf } from "../backfill/extract";
import { loadSettings } from "../hooks/facts-loader";
import { sqlOf } from "../hooks/sql";

/**
 * DESIGN §8.2 Tier 1 on a throwaway Postgres (synthetic data only): bank
 * accounts, the "received into / paid from" account on the legacy money
 * routes, expenses with input VAT and edit, and tenant credit refund /
 * carry-forward with the E20 sufficiency check, plus the backfill extraction of
 * the v2-only records (write-offs, credit actions).
 */
const U = 5401;
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
const user = { ...userOf(U), permissions: ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve"] };
const IBAN_B = makeSaudiIban("80", "000000000000123456");

async function drain(env: LegacyEnv, u = U) {
  await env.recognizer.runAccount(u);
  for (let i = 0; i < 10; i++) {
    const r = await env.worker.runAccount(u);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

async function linesOf(env: LegacyEnv, sourceType: string, sourceId: number, event: string) {
  return env.q(
    `select a.code, l.debit::text as debit, l.credit::text as credit, l.bank_account_id, l.contract_id from ledger_outbox o
       join journal_entries e on e.id = o.entry_id join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
      where o.user_id = $1 and o.source_type = $2 and o.source_id = $3 and o.event = $4 order by l.line_no`,
    [U, sourceType, sourceId, event],
  );
}
const codes = (ls: any[]) => ls.map((l) => `${l.code} ${Number(l.debit) ? "Dr" : "Cr"} ${Number(l.debit) || Number(l.credit)}`);

describe("fv2 tier 1 on the real legacy routes (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let banks: BankAccountsService;
  let expenses: ExpensesV2Service;
  let credits: TenantCreditsService;
  let bankB: any;
  let c1: number, c2: number, c3: number;
  let p1Future: number, p2Due: number, p3Due: number;

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, U);
    await enableV2(env, U, "manager");
    banks = new BankAccountsService(env.t.pool as any);
    expenses = new ExpensesV2Service(env.t.pool as any, env.emitter, banks);
    credits = new TenantCreditsService(env.t.pool as any, env.emitter, banks, new ArAgingService(env.t.pool as any), env.worker);
    const mk = (unit: number, rent: string, start: string, end: string) => env.contracts.create(user, {
      unitIds: [unit], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: start, endDate: end, monthlyRent: rent, paymentFrequency: "monthly", vatEnabled: false,
    });
    c1 = (await mk(s.unitA1, "1000", firstOf(1), lastOf(6))).id; // agent landlord, every installment in the future
    c2 = (await mk(s.unitH1, "2000", firstOf(-1), lastOf(4))).id; // account-holder landlord (principal)
    c3 = (await mk(s.unitA2, "500", firstOf(-1), lastOf(4))).id; // same agent landlord
    const pay = async (c: number, due: string) => Number((await env.q(`select id from payments where contract_id = $1 and due_date = $2 and deleted_at is null`, [c, due]))[0].id);
    p1Future = await pay(c1, firstOf(1));
    p2Due = await pay(c2, firstOf(-1));
    p3Due = await pay(c3, firstOf(-1));
    await drain(env);
  });

  after(async () => {
    await env?.t.drop();
  });

  // ── Bank accounts ─────────────────────────────────────────────────────────
  it("bank accounts: create makes a GL leaf under 1110; IBAN validated; unique; one default per kind in settings", async () => {
    const list0 = await banks.list(U);
    assert.deepEqual(list0.map((b) => [b.kind, b.glCode, b.isDefault]), [["bank", "1113", true], ["cash", "1111", true]], "setup's default boxes");
    const bad: any = await attempt(() => banks.create(U, U, { kind: "bank", nameAr: "حساب", iban: IBAN_B.slice(0, 23) + "0" }));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "BAD_IBAN");
    bankB = await banks.create(U, U, { kind: "bank", nameAr: "حساب التشغيل", nameEn: "Operating", iban: IBAN_B.replace(/(.{4})/g, "$1 ").toLowerCase(), isDefault: true });
    assert.equal(bankB.glCode, "111001");
    assert.equal(bankB.iban, IBAN_B);
    assert.equal(bankB.bankCode, "80");
    assert.equal(bankB.isDefault, true);
    const [gl] = await env.q(`select a.code, p.code as parent, a.bank_account_id, a.type from accounts a join accounts p on p.id = a.parent_id where a.id = $1`, [bankB.glAccountId]);
    assert.deepEqual(gl, { code: "111001", parent: "1110", bank_account_id: bankB.id, type: "asset" });
    const [st] = await env.q(`select default_bank_account_id from finance_settings where account_user_id = $1`, [U]);
    assert.equal(st.default_bank_account_id, bankB.id);
    const old = (await banks.list(U)).find((b) => b.glCode === "1113")!;
    assert.equal(old.isDefault, false, "the previous default is unset");
    const dup: any = await attempt(() => banks.create(U, U, { kind: "bank", nameAr: "مكرر", iban: IBAN_B }));
    assert.equal(dup.status, 409);
    const off: any = await attempt(() => banks.update(U, U, bankB.id, { isActive: false }));
    assert.equal(off.body.error, "BANK_ACCOUNT_IS_DEFAULT", "the default cannot be deactivated");
    // an unused account can be deleted, and its GL leaf goes with it
    const tmp = await banks.create(U, U, { kind: "cash", nameAr: "عهدة" });
    assert.equal((await banks.remove(U, U, tmp.id)).ok, true);
    assert.equal((await env.q(`select 1 from accounts where id = $1`, [tmp.glAccountId])).length, 0);
    // another account's id is 404
    assert.equal(((await attempt(() => banks.get(U + 1, bankB.id))) as any).status, 404);
  });

  it("received into: a collection with bankAccountId posts to that account's leaf; a foreign id falls back to the default", async () => {
    const [p] = await env.q(`select id from payments where contract_id = $1 and due_date = $2`, [c3, firstOf(-1)]);
    const r: any = await env.payments.addCollection(user, String(p.id), { amount: "100", collectedDate: today, method: "bank_transfer", bankAccountId: bankB.id });
    await drain(env);
    const [meta] = await env.q(`select bank_account_id from finance_collection_meta where collection_id = $1`, [r.collection.id]);
    assert.equal(meta.bank_account_id, bankB.id);
    const ls = await linesOf(env, "payment_collection", r.collection.id, "collected");
    assert.equal(ls[0].code, "111001");
    assert.equal(ls[0].bank_account_id, bankB.id);
    // a payout paid from B
    const po: any = await env.reports.createPayout(user, { ownerId: s.agent, amount: 40, transferDate: today, method: "bank_transfer", bankAccountId: bankB.id });
    await drain(env);
    assert.deepEqual(codes(await linesOf(env, "landlord_payout", po.id, "created")), ["2121 Dr 40", "111001 Cr 40"]);
    // a bank account id of nobody in this scope is ignored (no meta row), the engine uses the default
    const r2: any = await env.payments.addCollection(user, String(p.id), { amount: "10", collectedDate: today, method: "bank_transfer", bankAccountId: 999999 });
    await drain(env);
    assert.equal((await env.q(`select 1 from finance_collection_meta where collection_id = $1`, [r2.collection.id])).length, 0);
    assert.equal((await linesOf(env, "payment_collection", r2.collection.id, "collected"))[0].code, "111001", "B is the default now");
    bankB = await banks.get(U, bankB.id);
    assert.equal(bankB.balance, "70.00", "100 + 10 − 40");
    assert.equal(bankB.used, true);
    assert.equal(((await attempt(() => banks.remove(U, U, bankB.id))) as any).status, 409, "a used account cannot be deleted");
  });

  // ── Expenses ──────────────────────────────────────────────────────────────
  it("expenses: an overhead of 1,150 gross at 15% (registered account) posts Dr 5190 1,000 / Dr 1151 150 / Cr bank 1,150; the legacy row is written", async () => {
    const e = await expenses.create(U, user, {
      expenseDate: today, category: "صيانة عامة", amount: "1150", amountMode: "gross", vatCategory: "S", vatRate: 15,
      supplierName: "Synthetic Supplier", supplierVatNumber: "300000000000003", supplierInvoiceNo: "SI-1", supplierInvoiceDate: today, bankAccountId: bankB.id,
    });
    assert.equal(e.amount, "1150.00");
    assert.equal(e.details!.net, "1000.00");
    assert.equal(e.details!.vat, "150.00");
    assert.equal(e.details!.vatRecoverable, true, "overhead of a registered account");
    const [legacy] = await env.q(`select amount::text as amount, expense_date, owner_id, property_id from expenses where id = $1`, [e.id]);
    assert.deepEqual(legacy, { amount: "1150.00", expense_date: today, owner_id: null, property_id: null });
    await drain(env);
    assert.deepEqual(codes(await linesOf(env, "expense", e.id, "rev:1")), ["5290 Dr 1000", "1151 Dr 150", "111001 Cr 1150"], "5290: general (no property)");
    // edit: 2,300 gross → reversal of rev:1 and rev:2; net effect 5190 2,000 / 1151 300
    const e2 = await expenses.update(U, user, e.id, { amount: "2300" });
    assert.equal(e2.details!.revision, 2);
    await drain(env);
    assert.deepEqual(codes(await linesOf(env, "expense", e.id, "rev:2")), ["5290 Dr 2000", "1151 Dr 300", "111001 Cr 2300"]);
    assert.equal((await linesOf(env, "expense", e.id, "reversal:rev:1")).length, 3);
    const [net] = await env.q(`select sum(l.debit - l.credit)::text as n from journal_lines l join journal_entries je on je.id = l.entry_id
      where je.user_id = $1 and je.source_type = 'expense' and je.source_id = $2 and l.account_id = (select id from accounts where user_id = $1 and code = '1151')`, [U, e.id]);
    assert.equal(net.n, "300.00");
    assert.equal((await env.q(`select amount::text as a from expenses where id = $1`, [e.id]))[0].a, "2300.00", "the legacy row follows the edit");
  });

  it("expenses: a legacy expense gets its details lazily on the first v2 edit (O rev:1 reversed, S rev:2 posted)", async () => {
    const row: any = await env.reports.createExpense(user, { ownerId: s.holder, propertyId: s.propH, category: "كهرباء", amount: 230, expenseDate: today });
    await drain(env);
    assert.deepEqual(codes(await linesOf(env, "expense", row.id, "rev:1")), ["5190 Dr 230", "111001 Cr 230"], "legacy: O, gross; 5190: property expense");
    const e = await expenses.update(U, user, row.id, { vatCategory: "S", vatRate: 15, vatRecoverable: true });
    assert.equal(e.details!.revision, 2);
    assert.equal(e.details!.net, "200.00");
    await drain(env);
    assert.deepEqual(codes(await linesOf(env, "expense", row.id, "rev:2")), ["5190 Dr 200", "1151 Dr 30", "111001 Cr 230"]);
  });

  it("expenses: refusals — bad supplier VAT, charge-to-landlord for a principal landlord, a foreign property, a locked period", async () => {
    const base = { expenseDate: today, category: "x", amount: "100" };
    assert.equal(((await attempt(() => expenses.create(U, user, { ...base, supplierVatNumber: "123" }))) as any).body.error, "BAD_SUPPLIER_VAT");
    assert.equal(((await attempt(() => expenses.create(U, user, { ...base, ownerId: s.holder, chargeTo: "landlord" }))) as any).body.error, "CHARGE_TO_NOT_ALLOWED");
    assert.equal(((await attempt(() => expenses.create(U, user, { ...base, propertyId: 987654 }))) as any).status, 404);
    assert.equal(((await attempt(() => expenses.create(U, user, { ...base, ownerId: s.holder, propertyId: s.propA }))) as any).body.error, "OWNER_PROPERTY_MISMATCH");
    const lockedDay = `${Number(today.slice(0, 4)) - 1}-01-15`;
    await env.q(`update fiscal_periods set status = 'locked' where user_id = $1 and starts_on <= $2::date and ends_on >= $2::date`, [U, lockedDay]);
    assert.equal(((await attempt(() => expenses.create(U, user, { ...base, expenseDate: lockedDay }))) as any).body.error, "PERIOD_LOCKED");
    // charge to landlord for the AGENT landlord: Dr LP net / Dr LP VAT / Cr bank
    const e = await expenses.create(U, user, { ...base, amount: "115", vatCategory: "S", ownerId: s.agent, propertyId: s.propA, chargeTo: "landlord" });
    assert.equal(e.details!.vatRecoverable, false);
    await drain(env);
    assert.deepEqual(codes(await linesOf(env, "expense", e.id, "rev:1")), ["2121 Dr 100", "2121 Dr 15", "111001 Cr 115"]);
  });

  // ── Tenant credits ────────────────────────────────────────────────────────
  it("tenant credit: an advance on a future installment is a credit; refund above it is refused (E20), a refund within it posts a PV", async () => {
    await env.payments.addCollection(user, String(p1Future), { amount: "1000", collectedDate: today, method: "bank_transfer", bankAccountId: bankB.id });
    await drain(env);
    const l = await credits.list(U);
    const row = l.rows.find((r) => r.tenantId === s.tenant)!;
    assert.deepEqual(row.buckets.map((b) => [b.contractId, b.credit, b.treatment]), [[c1, "1000.00", "agent"]]);
    const over: any = await attempt(() => credits.refund(U, user, { tenantId: s.tenant, amount: "1000.01" }));
    assert.equal(over.status, 409);
    assert.equal(over.body.error, "FINANCE_V2_INSUFFICIENT_CREDIT");
    assert.equal(over.body.available, "1000.00");
    // apply 300 to the same landlord's other contract (c3's past-due installment): E21 reclass between contracts
    const ap = await credits.apply(U, user, { tenantId: s.tenant, contractId: c1, targetPaymentId: p3Due, amount: "300" });
    assert.equal(ap.action.kind, "apply");
    await drain(env);
    const al = await linesOf(env, "tenant_credit_action", ap.action.id, "apply");
    assert.deepEqual(al.map((x) => [x.code, Number(x.debit) || -Number(x.credit), x.contract_id]),
      [["1122", 300, c1], ["1122", -300, c3], ["2122", -300, c1], ["2122", 300, c3]], "Dr source / Cr target (the credit moves to c3)");
    // across landlords under agency: refused before anything is written
    const n0 = (await env.q(`select count(*)::int as n from tenant_credit_actions where user_id = $1`, [U]))[0].n;
    const cross: any = await attempt(() => credits.apply(U, user, { tenantId: s.tenant, contractId: c1, targetPaymentId: p2Due, amount: "100" }));
    assert.equal(cross.status, 400);
    assert.equal(cross.body.error, "FINANCE_V2_CROSS_LANDLORD");
    assert.equal((await env.q(`select count(*)::int as n from tenant_credit_actions where user_id = $1`, [U]))[0].n, n0);
    // 700 left: 800 refused, 500 refunded (PV-000001)
    assert.equal(((await attempt(() => credits.refund(U, user, { tenantId: s.tenant, amount: "800" }))) as any).body.available, "700.00");
    const rf = await credits.refund(U, user, { tenantId: s.tenant, amount: "500", bankAccountId: bankB.id, method: "bank_transfer", reference: "TRX-1" });
    assert.equal(rf.action.number, "PV-000001");
    assert.equal(rf.remainingCredit, "200.00");
    await drain(env);
    assert.deepEqual(codes(await linesOf(env, "tenant_credit_action", rf.action.id, "refund")), ["111001 Cr 500", "1122 Dr 500", "2122 Cr 500", "2121 Dr 500"]);
  });

  it("tenant credit: two concurrent refunds of the whole remaining credit — exactly one succeeds", async () => {
    const [a, b] = await Promise.all([
      attempt(() => credits.refund(U, user, { tenantId: s.tenant, amount: "200" })),
      attempt(() => credits.refund(U, user, { tenantId: s.tenant, amount: "200" })),
    ]);
    const ok = [a, b].filter((x: any) => x?.action);
    const refused = [a, b].filter((x: any) => x?.status === 409);
    assert.equal(ok.length, 1);
    assert.equal(refused.length, 1);
    assert.equal((ok[0] as any).action.number, "PV-000002");
    await drain(env);
    assert.equal((await credits.list(U)).rows.filter((r) => r.tenantId === s.tenant).length, 0, "no credit left");
  });

  it("tenant credit: void reverses the entry and restores the credit; the aging report sees the application", async () => {
    const [last] = await env.q(`select id from tenant_credit_actions where user_id = $1 and kind = 'refund' order by id desc limit 1`, [U]);
    const v = await credits.void(U, user, Number(last.id));
    assert.equal(v.status, "void");
    await drain(env);
    assert.equal((await linesOf(env, "tenant_credit_action", Number(last.id), "reversal:refund")).length, 4);
    const row = (await credits.list(U)).rows.find((r) => r.tenantId === s.tenant)!;
    assert.equal(row.total, "200.00");
    assert.equal(((await attempt(() => credits.void(U, user, Number(last.id)))) as any).status, 409);
    const aging = await new ArAgingService(env.t.pool as any).openItems(U, today, "contract");
    const item = aging.items.find((i) => i.type === "installment" && i.id === p3Due)!;
    assert.equal(item.credited, 30000, "the 300 applied to c3's installment");
    assert.equal(item.remaining, 50000 - 10000 - 1000 - 30000, "500 − 100 − 10 collected − 300 applied");
  });

  it("documents/:id/tenant-credit is 0 for anything but a confirmed credit note, and 404 for another account's id", async () => {
    const [d] = await env.q(`select id from simple_invoices where user_id = $1 order by id limit 1`, [U]);
    if (d) assert.equal((await credits.documentCredit(U, Number(d.id))).amount, "0.00");
    assert.equal(((await attempt(() => credits.documentCredit(U, 99999999))) as any).status, 404);
  });

  // ── Backfill extraction of the v2-only records ────────────────────────────
  it("backfill: write-offs and tenant credit actions are extracted with their live keys, so a catch-up posts nothing new", async () => {
    const bugs = new FinanceV2BugsController(env.t.pool as any, env.emitter);
    const wo: any = await bugs.writeOffs({ user } as any, { paymentIds: [p2Due], reason: "synthetic write-off" });
    await drain(env);
    const woId = wo.writeOffs[0].id;
    const st = await loadSettings(sqlOf(env.t.pool as any), U);
    const { events } = await extractEvents(sqlOf(env.t.pool as any), U, st!, { today });
    const keys = new Set(events.map(keyOf));
    const actions = await env.q(`select id, kind, status from tenant_credit_actions where user_id = $1 order by id`, [U]);
    assert.ok(keys.has(`write_off|${woId}|posted`), "the write-off (E24)");
    for (const a of actions) {
      assert.ok(keys.has(`tenant_credit_action|${a.id}|${a.kind}`), `credit action ${a.id}`);
      if (a.status === "void") assert.ok(keys.has(`tenant_credit_action|${a.id}|reversal:${a.kind}`), `its reversal ${a.id}`);
    }
    const posted = new Set((await env.q(`select source_type, source_id, event from journal_entries where user_id = $1`, [U]))
      .map((r: any) => keyOf({ sourceType: r.source_type, sourceId: Number(r.source_id), event: r.event })));
    const missing = events.filter((e) => ["write_off", "tenant_credit_action"].includes(e.sourceType) && !posted.has(keyOf(e)));
    assert.deepEqual(missing.map(keyOf), [], "every extracted key is already in the ledger");
  });

  it("the trial balance still balances", async () => {
    const [t] = await env.q(`select sum(debit)::text as d, sum(credit)::text as c from journal_lines where user_id = $1`, [U]);
    assert.equal(t.d, t.c);
  });
});

describe("fv2 tier 1: flag off — bankAccountId on the legacy routes changes nothing", { skip: fv2DbSkip }, () => {
  let off: LegacyEnv, bare: LegacyEnv;
  before(async () => {
    [off, bare] = [await legacyEnv("wired"), await legacyEnv("none")];
    for (const e of [off, bare]) await seedAccount(e, U);
  });
  after(async () => {
    for (const e of [off, bare]) await e?.t.drop();
  });
  it("collection, payout and receipt voucher responses equal the code with no v2 line; no side rows", async () => {
    const run = async (env: LegacyEnv) => {
      const seed = (await env.q(`select id from owners where user_id = $1 and not is_account_holder`, [U]))[0].id;
      const unit = (await env.q(`select u.id from units u join properties p on p.id = u.property_id where p.user_id = $1 order by u.id limit 1`, [U]))[0].id;
      const tenant = (await env.q(`select id from tenants where user_id = $1`, [U]))[0].id;
      const c: any = await env.contracts.create(user, { unitIds: [unit], tenantId: tenant, tenantName: "Synthetic Tenant", startDate: firstOf(0), endDate: lastOf(1),
        monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false });
      const [p] = await env.q(`select id from payments where contract_id = $1 order by due_date limit 1`, [c.id]);
      return [
        await env.payments.addCollection(user, String(p.id), { amount: "100", collectedDate: today, method: "cash", bankAccountId: 1 }),
        await env.reports.createPayout(user, { ownerId: seed, amount: 5, transferDate: today, bankAccountId: 1 }),
        await env.billing.createReceiptVoucher(user, { contractId: c.id, amount: 50, paidDate: today, countAsCollection: true, bankAccountId: 1 }),
      ];
    };
    const strip = (v: any) => JSON.parse(JSON.stringify(normalise(v), (k, x) => (k === "id" || k.endsWith("Id") || k === "number" || k === "receiptNumber" ? "<id>" : x)));
    assert.deepEqual(strip(await run(off)), strip(await run(bare)));
    for (const t of ["finance_collection_meta", "finance_payout_meta", "finance_document_meta", "ledger_outbox"]) {
      assert.equal((await off.q(`select count(*)::int as n from ${t}`))[0].n, 0, t);
    }
  });
});

describe("fv2 tier 1 routes: every handler needs a capability", () => {
  it("tier1 controller", () => {
    for (const C of [FinanceV2Tier1Controller]) {
      for (const k of Object.getOwnPropertyNames(C.prototype).filter((x) => x !== "constructor")) {
        const cap = Reflect.getMetadata("fv2:capability", (C.prototype as any)[k]);
        assert.ok(cap, `${C.name}.${k} has no capability`);
      }
    }
  });
});
