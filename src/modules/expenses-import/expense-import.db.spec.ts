import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { fv2DbSkip } from "../finance-v2/__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, withoutTrust, type LegacyEnv, type Seed } from "../finance-v2/__tests__/legacy-env";
import { BankAccountsService } from "../finance-v2/tier1/bank-accounts.service";
import { ExpenseRowError, ExpensesV2Service } from "../finance-v2/tier1/expenses-v2.service";
import { riyadhToday } from "../finance-v2/dates";
import { ExpenseImportService } from "./expense-import.service";
import { MAIN_SHEET, columnsFor, type Field, type ImportMode } from "./expense-sheet";

/**
 * Expenses from Excel against a throwaway Postgres: the per-account template
 * read back and filled, the dry run (no writes), all-or-nothing commit, and
 * the same rules as the single create — legacy (POST /reports/expenses) and
 * Accounting on (ExpensesV2Service). Synthetic data only (public repo).
 */
const L = 7801; // legacy (flag off)
const V = 7802; // finance v2 on, manager mode
const today = riyadhToday();
const PERMS = ["expenses.view", "expenses.write"];
const userFor = (u: number) => ({ ...userOf(u), permissions: PERMS });

/** The account's own template with `rows` written from row 4 (under the two example rows), as a user would. */
async function filled(svc: ExpenseImportService, u: number, mode: ImportMode, rows: Partial<Record<Field, unknown>>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await svc.template(userFor(u))) as any);
  const ws = wb.getWorksheet(MAIN_SHEET)!;
  const cols = columnsFor(mode);
  rows.forEach((r, i) => cols.forEach((c, j) => { if (r[c.key] !== undefined) ws.getCell(4 + i, j + 1).value = r[c.key] as any; }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("expense import: template → dry run → all-or-nothing commit", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed, sv: Seed;
  let svc: ExpenseImportService;
  let v2: ExpensesV2Service;
  const count = async (u: number) => Number((await env.q(`select count(*)::int as n from expenses where user_id = $1 and deleted_at is null`, [u]))[0].n);

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, L);
    sv = await seedAccount(env, V);
    await enableV2(env, V, "manager");
    await withoutTrust(env, V);
    v2 = new ExpensesV2Service(env.t.pool as any, env.emitter, new BankAccountsService(env.t.pool as any));
    svc = new ExpenseImportService(env.db, v2, env.hooks);
  });
  after(async () => { await env?.t.drop(); });

  it("the template lists this account's landlords and properties only", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await svc.template(userFor(L))) as any);
    const lists = wb.getWorksheet("القوائم")!;
    const col = (n: number) => (lists.getColumn(n).values as unknown[]).slice(2).filter(Boolean);
    assert.deepEqual(col(1), [`Synthetic Holder (#${s.holder})`, `Synthetic Landlord A (#${s.agent})`]);
    assert.deepEqual(col(2), [`Synthetic Tower (#${s.propA})`, `Synthetic Villa (#${s.propH})`]);
    assert.equal(wb.getWorksheet(MAIN_SHEET)!.getRow(1).cellCount, columnsFor("legacy").length);
  });

  it("legacy: a dry run writes nothing; one bad row refuses the whole commit; a clean file creates every row", async () => {
    const good = [
      { expenseDate: new Date(Date.UTC(2026, 0, 15)), category: "صيانة", amount: 1150, ownerId: `Synthetic Landlord A (#${s.agent})`, propertyId: `Synthetic Tower (#${s.propA})` },
      { expenseDate: "20/01/2026", category: "نظافة", amount: "٢٥٠", propertyId: "Synthetic Villa", notes: "synthetic" },
    ];
    const bad = [
      ...good,
      { expenseDate: "2026-01-21", category: "x", amount: 10, ownerId: `Synthetic Holder (#${s.holder})`, propertyId: `Synthetic Tower (#${s.propA})` },
      // Another account's property id, typed as a label: not in this account's list.
      { expenseDate: "2026-01-22", category: "x", amount: 10, ownerId: `Synthetic Landlord A (#${s.agent})`, propertyId: `Synthetic Tower (#${sv.propA})` },
    ];
    const before0 = await count(L);
    const dry: any = await svc.run(userFor(L), await filled(svc, L, "legacy", bad), true);
    assert.deepEqual([dry.mode, dry.valid, dry.invalid, dry.skipped], ["legacy", 2, 2, 2]);
    assert.deepEqual(dry.rows.map((r: any) => [r.row, r.ok]), [[4, true], [5, true], [6, false], [7, false]]);
    assert.deepEqual(dry.rows[2].errors, [{ field: "propertyId", message: "العقار لا يتبع هذا المؤجر" }]);
    assert.equal(dry.rows[3].errors[0].field, "propertyId");
    assert.equal(dry.rows[1].preview.ownerId, s.holder, "a property alone names its landlord");
    assert.equal(((await attempt(() => svc.run(userFor(L), Buffer.from("not a workbook"), false))) as any).body.error, "BAD_FILE");
    const r: any = await attempt(async () => svc.run(userFor(L), await filled(svc, L, "legacy", bad), false));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "IMPORT_INVALID");
    assert.equal(r.body.invalid, 2);
    assert.equal(await count(L), before0, "nothing written");

    const ok: any = await svc.run(userFor(L), await filled(svc, L, "legacy", good), false);
    assert.equal(ok.created, 2);
    const rows = await env.q(`select owner_id, property_id, category, amount::text as amount, expense_date from expenses where id = any($1::int[]) order by id`, [ok.ids]);
    assert.deepEqual(rows, [
      { owner_id: s.agent, property_id: s.propA, category: "صيانة", amount: "1150.00", expense_date: "2026-01-15" },
      { owner_id: s.holder, property_id: s.propH, category: "نظافة", amount: "250.00", expense_date: "2026-01-20" },
    ]);
  });

  it("v2: the service's own rules per row (charge-to, VAT); a commit books details and queues the ledger", async () => {
    const good = [
      { expenseDate: today, category: "قرطاسية", amount: 100, amountMode: "غير شامل الضريبة", vatCategory: "خاضعة 15%" },
      { expenseDate: today, category: "صيانة", amount: 230, ownerId: `Synthetic Landlord A (#${sv.agent})`, propertyId: `Synthetic Tower (#${sv.propA})`, chargeTo: "المؤجر", vatCategory: "خاضعة 15%" },
    ];
    // Charge-to-landlord with no landlord at all is refused by the service (the account holder's own landlord is
    // accepted and booked as the account's own expense — see tier1.db.spec).
    const holderRow = { expenseDate: today, category: "x", amount: 50, chargeTo: "المؤجر" };
    const dry: any = await svc.run(userFor(V), await filled(svc, V, "v2", [...good, holderRow]), true);
    assert.deepEqual([dry.mode, dry.valid, dry.invalid], ["v2", 2, 1]);
    assert.deepEqual([dry.rows[0].preview.net, dry.rows[0].preview.vat, dry.rows[0].preview.gross], ["100.00", "15.00", "115.00"]);
    assert.equal(dry.rows[2].errors[0].field, "chargeTo");
    assert.match(dry.rows[2].errors[0].message, /^التحميل على المؤجر/);
    const n0 = await count(V);
    assert.equal(((await attempt(async () => svc.run(userFor(V), await filled(svc, V, "v2", [...good, holderRow]), false))) as any).status, 400);
    assert.equal(await count(V), n0);

    const ok: any = await svc.run(userFor(V), await filled(svc, V, "v2", good), false);
    assert.equal(ok.created, 2);
    const det = await env.q(
      `select gross_amount::text as g, net_amount::text as n, vat_category, charge_to from finance_expense_details where expense_id = any($1::int[]) order by expense_id`, [ok.ids]);
    assert.deepEqual(det, [
      { g: "115.00", n: "100.00", vat_category: "S", charge_to: "company" },
      { g: "230.00", n: "200.00", vat_category: "S", charge_to: "landlord" },
    ]);
    const ob = await env.q(`select source_id, event from ledger_outbox where user_id = $1 and source_type = 'expense' and source_id = any($2::int[]) order by source_id`, [V, ok.ids]);
    assert.deepEqual(ob.map((o: any) => o.event), ["rev:1", "rev:1"]);
    const audit = await env.q(`select path from audit_logs where owner_user_id = $1 and entity = 'expense' and entity_id = any($2::text[])`, [V, ok.ids.map(String)]);
    assert.deepEqual(audit.map((a: any) => a.path), ["/expenses/import", "/expenses/import"]);
  });

  it("v2 createMany: a row refused at commit time rolls back every row and names its index", async () => {
    const n0 = await count(V);
    const lockedDay = `${Number(today.slice(0, 4)) - 1}-01-15`;
    await env.q(`update fiscal_periods set status = 'locked' where user_id = $1 and starts_on <= $2::date and ends_on >= $2::date`, [V, lockedDay]);
    await assert.rejects(
      v2.createMany(V, userFor(V), [{ expenseDate: today, category: "a", amount: "10" }, { expenseDate: lockedDay, category: "b", amount: "10" }], "/expenses/import"),
      (e: any) => e instanceof ExpenseRowError && e.index === 1 && (e.reason as any).getResponse().error === "PERIOD_LOCKED",
    );
    assert.equal(await count(V), n0);
    const dry: any = await svc.run(userFor(V), await filled(svc, V, "v2", [{ expenseDate: lockedDay, category: "b", amount: 10 }]), true);
    assert.deepEqual([dry.invalid, dry.rows[0].errors[0].field], [1, "expenseDate"]);
    assert.match(dry.rows[0].errors[0].message, /مقفلة/);
  });
});
