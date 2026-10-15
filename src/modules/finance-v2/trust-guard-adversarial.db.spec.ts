import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { riyadhToday } from "./dates";
import { PeriodsService } from "./periods.service";
import { JournalRepository } from "./journal.repository";
import { AccountTransferService } from "./tier1/account-transfer.service";
import { BankAccountsService } from "./tier1/bank-accounts.service";
import { ExpensesV2Service } from "./tier1/expenses-v2.service";
import { ApService } from "./tier3/ap.service";
import { ManualJournalsService } from "./manual-journals.service";
import { clientMoneyPosition } from "./client-money";
import { trustAvailability } from "./trust-guard";
import { JournalQueryService } from "./journal-query.service";

/**
 * Adversarial review of the trust guard (synthetic data only): per-landlord math (tagged / untagged money moved into
 * trust, another landlord paid from the cash box, halalas when spreading), the paths that move trust money without
 * the caps (manual journal approval, a landlord's expense or bill paid from trust), and maker-checker.
 */
const today = riyadhToday();
const firstOf = (n: number) => { const [y, m] = today.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10); };
const lastOf = (n: number) => { const d = new Date(`${firstOf(n + 1)}T00:00:00Z`); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "contracts.view", "contracts.write", "contracts.delete"];
const userFor = (id: number) => ({ ...userOf(id), permissions: PERMS });

async function drain(env: LegacyEnv, u: number) {
  await env.recognizer.runAccount(u);
  for (let i = 0; i < 12; i++) { const r = await env.worker.runAccount(u); if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break; }
}

describe("fv2 trust guard, adversarial (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let periods: PeriodsService;
  let journal: JournalRepository;
  let transfers: AccountTransferService;
  let banks: BankAccountsService;

  const glBal = async (u: number, code: string) => (await env.q(
    `select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id where l.user_id = $1 and a.code = $2`, [u, code]))[0].b;
  const bankOf = async (u: number, code: string) =>
    Number((await env.q(`select b.id from bank_accounts b join accounts a on a.id = b.gl_account_id where b.user_id = $1 and a.code = $2`, [u, code]))[0].id);
  const trustOf = async (u: number) => Number((await env.q(`select id from bank_accounts where user_id = $1 and is_trust and is_default`, [u]))[0].id);
  const trustActive = (u: number, on: boolean) => env.q(`update bank_accounts set is_active = $2 where user_id = $1 and is_trust`, [u, on]);
  const landlord = async (u: number, name: string, n: number) => {
    const o = Number((await env.q(
      `insert into owners (user_id, name, email, phone, id_number, type) values ($1, $2, $3, '0500000002', $4, 'individual') returning id`,
      [u, name, `owner-${n}-${u}@example.test`, `7${n}${u}`]))[0].id);
    const p = Number((await env.q(`insert into properties (user_id, name, owner_id) values ($1, $2, $3) returning id`, [u, `${name} Court`, o]))[0].id);
    const unit = Number((await env.q(`insert into units (property_id, unit_number) values ($1, 'X1') returning id`, [p]))[0].id);
    return { owner: o, prop: p, unit };
  };
  const contract = async (u: number, s: Seed, unit: number, rent: string) => {
    const c: any = await env.contracts.create(userFor(u), { unitIds: [unit], tenantId: s.tenant, tenantName: "T", startDate: firstOf(0), endDate: lastOf(11),
      monthlyRent: rent, paymentFrequency: "monthly", vatEnabled: false });
    return (await env.q(`select id from payments where contract_id = $1 and deleted_at is null and description is distinct from 'تأمين (وديعة)' order by due_date`, [c.id])).map((r: any) => String(r.id));
  };
  const position = async (u: number, ownerId: number) => (await trustAvailability(env.t.pool as any, u, ownerId)).landlord!;

  before(async () => {
    env = await legacyEnv("wired");
    periods = new PeriodsService(env.t.pool);
    journal = new JournalRepository(periods);
    transfers = new AccountTransferService(env.t.pool as any, journal, periods);
    banks = new BankAccountsService(env.t.pool as any);
  });
  after(async () => { await env?.t.drop(); });

  it("money moved into trust tagged with a landlord is his, even when another landlord was paid from the cash box (aggregate netting)", async () => {
    // A's 2,000 rent went into the cash box; B's 1,000 into trust, and B was then paid his 1,000 from the cash box.
    // The office moves A's 2,000 into trust, tagged with A: trust = 1,000 (B's, now the office's) + 2,000 (A's).
    const U = 6581; const user = userFor(U);
    const s = await seedAccount(env, U); await enableV2(env, U, "manager");
    const b = await landlord(U, "B", 2);
    const [a1] = await contract(U, s, s.unitA2, "2000");
    const [b1] = await contract(U, s, b.unit, "1000");
    const cash = await bankOf(U, "1111"); const trust = await trustOf(U);
    await trustActive(U, false);
    await env.payments.addCollection(user, a1, { amount: "2000", collectedDate: today, method: "cash" });
    await drain(env, U);
    await trustActive(U, true);
    await env.payments.addCollection(user, b1, { amount: "1000", collectedDate: today, method: "bank_transfer" });
    await drain(env, U);
    await env.reports.createPayout(user, { ownerId: b.owner, amount: "1000", transferDate: today, method: "cash", bankAccountId: cash });
    await drain(env, U);
    const due = Number(((await env.reports.accounting(user)) as any).landlordDues.find((d: any) => Number(d.ownerId) === s.agent).remaining);
    await transfers.create(U, user, { fromBankAccountId: cash, toBankAccountId: trust, amount: due.toFixed(2), ownerId: s.agent });
    await drain(env, U);
    assert.equal(await glBal(U, "1114"), (1000 + due).toFixed(2));
    const p = await position(U, s.agent);
    assert.equal(p.payable, due.toFixed(2), `A's whole due was moved in for him: ${JSON.stringify(p)}`);
    // Never more than trust between them: A's payable and the office's money in trust.
    const office = Number((await trustAvailability(env.t.pool as any, U)).officeInTrust);
    assert.ok(office + due <= 1000 + due, `office ${office} + A ${due} within trust`);
    const r: any = await attempt(() => env.reports.createPayout(user, { ownerId: s.agent, amount: due.toFixed(2), transferDate: today, method: "bank_transfer" }));
    assert.ok(r.voucherNumber, JSON.stringify(r));
    await drain(env, U);
    // Reversing the transfer that brought A's money in, after A was paid from it: that money is no longer in trust.
    const [t] = await env.q(`select id from journal_entries where user_id = $1 and payload->'transfer'->>'ownerId' is not null`, [U]);
    const jq = new JournalQueryService(env.t.pool, env.engine);
    const rev: any = await attempt(() => jq.reverse(U, user, Number(t.id), {}));
    assert.deepEqual([rev.status, rev.body?.error], [409, "TRUST_INSUFFICIENT"], JSON.stringify(rev));
    assert.equal(await glBal(U, "1114"), "1000.00");
  });

  it("untagged money moved into trust is spread to the halala: no 0.01 lost or created", async () => {
    const U = 6582; const user = userFor(U);
    const s = await seedAccount(env, U); await enableV2(env, U, "manager");
    const ls = [await landlord(U, "B", 2), await landlord(U, "C", 3), await landlord(U, "D", 4)];
    const insts = [];
    for (const l of ls) insts.push((await contract(U, s, l.unit, "1000"))[0]);
    await trustActive(U, false);
    for (const i of insts) await env.payments.addCollection(user, i, { amount: "1000", collectedDate: today, method: "cash" });
    await drain(env, U);
    await trustActive(U, true);
    const cash = await bankOf(U, "1111"); const trust = await trustOf(U);
    for (const amt of ["0.01", "999.99"]) {
      await transfers.create(U, user, { fromBankAccountId: cash, toBankAccountId: trust, amount: amt });
      const pos = await clientMoneyPosition(env.t.pool as any, U, "9999-12-31");
      const moved = ls.reduce((t, l) => t + (pos.byOwner.get(l.owner)?.movedIn ?? 0), 0);
      assert.equal(moved, pos.movedIntoTrust, `Σ movedIn ${moved} ≠ moved into trust ${pos.movedIntoTrust} after ${amt}`);
    }
  });

  it("two landlords racing payouts that together exceed trust: exactly one is refused", async () => {
    const U = 6583; const user = userFor(U);
    const s = await seedAccount(env, U); await enableV2(env, U, "manager");
    const b = await landlord(U, "B", 2);
    const [a1] = await contract(U, s, s.unitA2, "1000");
    const [b1] = await contract(U, s, b.unit, "1000");
    await env.payments.addCollection(user, a1, { amount: "1000", collectedDate: today, method: "bank_transfer" });
    await env.payments.addCollection(user, b1, { amount: "1000", collectedDate: today, method: "bank_transfer" });
    await drain(env, U);
    const park = (await banks.create(U, U, { kind: "bank", nameAr: "أمانات ٢", isTrust: true, isDefault: false })).id;
    await transfers.create(U, user, { fromBankAccountId: await trustOf(U), toBankAccountId: park, amount: "1000" }); // 1114: 1,000 left
    const [x, y] = await Promise.all([
      attempt(() => env.reports.createPayout(user, { ownerId: s.agent, amount: "900", transferDate: today, method: "bank_transfer" })),
      attempt(() => env.reports.createPayout(user, { ownerId: b.owner, amount: "900", transferDate: today, method: "bank_transfer" })),
    ]);
    assert.equal([x, y].filter((r: any) => r?.voucherNumber).length, 1, JSON.stringify([x, y]));
    assert.equal([x, y].filter((r: any) => r?.status === 409).length, 1);
  });

  it("a landlord's expense paid from trust takes only HIS money there (not another landlord's)", async () => {
    const U = 6584; const user = userFor(U);
    const s = await seedAccount(env, U); await enableV2(env, U, "manager");
    const b = await landlord(U, "B", 2);
    const [b1] = await contract(U, s, b.unit, "1000");
    await env.payments.addCollection(user, b1, { amount: "1000", collectedDate: today, method: "bank_transfer" });
    await drain(env, U);
    assert.equal((await position(U, s.agent)).payable, "0.00");
    const ex = new ExpensesV2Service(env.t.pool as any, env.emitter, banks);
    const tId = await trustOf(U);
    const r: any = await attempt(() => ex.create(U, user, { expenseDate: today, category: "صيانة", amount: "300", ownerId: s.agent, propertyId: s.propA,
      chargeTo: "landlord", bankAccountId: tId }));
    assert.deepEqual([r.status, r.body?.error], [409, "LANDLORD_TRUST_INSUFFICIENT"], JSON.stringify(r));
  });

  it("a landlord's supplier bill paid from trust takes only HIS money there (not another landlord's)", async () => {
    const U = 6585; const user = userFor(U);
    const s = await seedAccount(env, U); await enableV2(env, U, "manager");
    const b = await landlord(U, "B", 2);
    const [b1] = await contract(U, s, b.unit, "1000");
    await env.payments.addCollection(user, b1, { amount: "1000", collectedDate: today, method: "bank_transfer" });
    await drain(env, U);
    const ap = new ApService(env.t.pool as any, env.emitter, banks);
    const sup = await ap.createSupplier(U, user, { nameAr: "مورد", paymentTermsDays: 30 });
    const bill = await ap.approveBill(U, user, (await ap.createBill(U, user, {
      supplierId: sup.id, billDate: today, ownerId: s.agent, propertyId: s.propA, chargeTo: "landlord", lines: [{ description: "صيانة", amount: "300" }],
    })).id);
    await drain(env, U);
    const tId = await trustOf(U);
    const r: any = await attempt(() => ap.createPayment(U, user, { supplierId: sup.id, paidOn: today, amount: "300", bankAccountId: tId,
      allocations: [{ billId: bill.id, amount: "300" }] }));
    assert.deepEqual([r.status, r.body?.error], [409, "LANDLORD_TRUST_INSUFFICIENT"], JSON.stringify(r));
  });

  describe("manual journals", () => {
    const M = 6586; const E = 6587; const F = 6588;
    let mj: ManualJournalsService;
    let acc: Record<string, number>;
    const holder = { ...userOf(M), permissions: [...PERMS, "settings.write"] } as any;
    const emp = { ...userOf(E), ownerUserId: M, role: "accountant", permissions: PERMS } as any;
    const emp2 = { ...userOf(F), ownerUserId: M, role: "accountant", permissions: PERMS } as any;
    const L = (code: string, side: "d" | "c", amt: string) => ({ accountId: acc[code], debit: side === "d" ? amt : "0", credit: side === "c" ? amt : "0" });
    const REASON = "تصحيح قيد مكرر في سند الصرف";
    before(async () => {
      await seedAccount(env, M); await enableV2(env, M, "manager");
      const role = Number((await env.q(`insert into roles (key, label_ar, label_en, permissions) values ('accountant', 'محاسب', 'Accountant', $1::jsonb) returning id`, [JSON.stringify(PERMS)]))[0].id);
      for (const id of [E, F]) await env.q(`insert into users (id, email, password_hash, name, owner_user_id, role_id) values ($1, $2, 'x', 'Emp', $3, $4)`, [id, `fv2-emp-${id}@example.test`, M, role]);
      mj = new ManualJournalsService(env.t.pool, journal, periods);
      acc = Object.fromEntries((await env.q(`select code, id from accounts where user_id = $1`, [M])).map((r: any) => [r.code, Number(r.id)]));
    });

    it("maker-checker: an earlier editor may not approve after the creator re-submits it", async () => {
      const d: any = await mj.create(M, holder, { entryDate: today, memo: "تصحيح", lines: [L("5290", "d", "10"), L("1114", "c", "10")], trustReason: REASON });
      await mj.update(M, emp, d.id, { lines: [L("5290", "d", "20"), L("1114", "c", "20")] }); // E writes the lines
      await mj.submit(M, holder, d.id); // the holder only submits
      const r: any = await attempt(() => mj.approve(M, emp, d.id));
      assert.deepEqual([r.status, r.body?.error], [403, "SAME_USER_APPROVAL"], JSON.stringify(r));
      assert.deepEqual((await mj.get(M, d.id)).makerIds, [M, E], "the detail lists every maker (the web's notice)");
      // A third user passes maker-checker (trust is empty here, so the trust balance refuses it next).
      const third: any = await attempt(() => mj.approve(M, emp2, d.id));
      assert.deepEqual([third.status, third.body?.error], [409, "TRUST_INSUFFICIENT"], JSON.stringify(third));
    });

    it("approving a journal that takes money out of trust: never more than trust holds", async () => {
      assert.equal(Number(await glBal(M, "1114")), 0);
      const d: any = await mj.create(M, emp, { entryDate: today, memo: "مصروف", lines: [L("5290", "d", "50"), L("1114", "c", "50")], trustReason: REASON });
      await mj.submit(M, emp, d.id);
      const r: any = await attempt(() => mj.approve(M, holder, d.id));
      assert.deepEqual([r.status, r.body?.error], [409, "TRUST_INSUFFICIENT"], JSON.stringify(r));
    });

    it("approving a journal trust → office bank (unflagged, a transfer by hand): capped at the office's money in trust", async () => {
      const d: any = await mj.create(M, emp, { entryDate: today, memo: "تحويل", lines: [L("1113", "d", "70"), L("1114", "c", "70")] });
      await mj.submit(M, emp, d.id);
      const r: any = await attempt(() => mj.approve(M, holder, d.id));
      assert.equal(r.status, 409, JSON.stringify(r));
      assert.ok(["TRUST_INSUFFICIENT", "TRUST_TRANSFER_EXCEEDS_OFFICE_MONEY"].includes(r.body?.error), JSON.stringify(r.body));
    });
  });
});
