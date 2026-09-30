import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip, withDb, type TestDb } from "../__tests__/with-db";
import { withTx } from "../db";
import { toHalalas } from "../money";
import { PeriodsService } from "../periods.service";
import { ChartService } from "../chart.service";
import { JournalRepository, type LineInput } from "../journal.repository";
import { CoreReportsService } from "./core-reports.service";
import { AcctReportsService } from "./acct-reports.service";
import { FinanceV2AcctReportsController } from "../controllers/reports-acct.controller";
import { FinanceV2Guard } from "../finance-v2.guard";

/**
 * The accountant's reports (cash flow, rent roll, deposits register, property
 * profitability) on one seeded Manager-mode fixture modelled on the workbook's
 * example: the account's own tower (principal) and two managed buildings
 * (agent: one unregistered landlord, one VAT-registered). Every total is
 * checked by hand AND against the trial balance / income statement, so no
 * figure can differ between screens. All data is synthetic.
 */
const U = 7501;
const OTHER = 7502;

describe("finance v2 accountant reports (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let repo: JournalRepository;
  let svc: AcctReportsService;
  let core: CoreReportsService;
  let acc: Record<string, number> = {};
  let nSrc = 0;
  const q = (sql: string, p: unknown[] = []) => t.pool.query(sql, p);
  const one = async (sql: string, p: unknown[]) => Number((await q(sql, p)).rows[0].id);
  type X = Partial<LineInput>;
  const L = (code: string, side: "dr" | "cr", amt: string, x: X = {}): LineInput =>
    ({ accountId: acc[code], [side === "dr" ? "debit" : "credit"]: toHalalas(amt), ...x, vatBase: x.vatBase });
  const post = (date: string, rule: string | null, lines: LineInput[], origin: "auto" | "manual" | "opening" = "auto") =>
    withTx(t.pool, (c) => repo.post(c, {
      userId: U, entryDate: date, origin, sourceType: "test", sourceId: ++nSrc, event: "posted", lines, payload: rule ? { rule } : {},
    }));

  const ids: Record<string, number> = {};

  before(async () => {
    t = await withDb({ legacy: "full" });
    const periods = new PeriodsService(t.pool);
    repo = new JournalRepository(periods);
    svc = new AcctReportsService(t.pool);
    core = new CoreReportsService(t.pool);
    const chart = new ChartService(t.pool);
    for (const u of [U, OTHER]) {
      await q(`insert into users (id, email, password_hash, name, user_type) values ($1, $2, 'x', 'Synthetic Co', 'company')`, [u, `fv2-acct-${u}@example.test`]);
      await q(`insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode) values ($1, true, 'manager')`, [u]);
      await withTx(t.pool, (c) => chart.seedChart(c, u));
    }
    acc = Object.fromEntries((await q(`select code, id from accounts where user_id = $1`, [U])).rows.map((r: any) => [r.code, r.id]));
    await q(`insert into bank_accounts (user_id, kind, name_ar, is_trust, is_default, gl_account_id) values ($1, 'bank', 'Operating', false, true, $2), ($1, 'bank', 'Client money', true, false, $3)`,
      [U, acc["1113"], acc["1114"]]);

    // Landlords, properties, units, tenants, contracts.
    ids.O1 = await one(`insert into owners (user_id, name, is_account_holder) values ($1, 'Synthetic Holder', true) returning id`, [U]);
    ids.O2 = await one(`insert into owners (user_id, name) values ($1, 'Agent Unregistered') returning id`, [U]);
    ids.O3 = await one(`insert into owners (user_id, name, tax_number) values ($1, 'Agent Registered', '300000000000003') returning id`, [U]);
    ids.P1 = await one(`insert into properties (user_id, name, owner_id) values ($1, 'A Tower', $2) returning id`, [U, ids.O1]);
    ids.P2 = await one(`insert into properties (user_id, name, owner_id) values ($1, 'B Palms', $2) returning id`, [U, ids.O2]);
    ids.P3 = await one(`insert into properties (user_id, name, owner_id) values ($1, 'C Villa', $2) returning id`, [U, ids.O3]);
    const unit = (p: number, n: string) => one(`insert into units (property_id, unit_number) values ($1, $2) returning id`, [p, n]);
    ids.U11 = await unit(ids.P1, "101"); ids.U12 = await unit(ids.P1, "102");
    ids.A1 = await unit(ids.P2, "A1"); ids.A2 = await unit(ids.P2, "A2"); ids.A3 = await unit(ids.P2, "A3");
    ids.B1 = await unit(ids.P3, "B1");
    for (const n of ["T1", "T2", "T3", "T4", "T5", "T0"]) ids[n] = await one(`insert into tenants (user_id, name) values ($1, $2) returning id`, [U, `Tenant ${n}`]);
    const contract = async (key: string, tenant: string, unitKey: string, start: string, end: string, monthly: string, deposit: string | null, status = "active", ejar: string | null = null) => {
      ids[key] = await one(
        `insert into contracts (user_id, contract_number, tenant_id, tenant_name, start_date, end_date, monthly_rent, deposit_amount, status, ejar_contract_number)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [U, key, ids[tenant], `Tenant ${tenant}`, start, end, monthly, deposit, status, ejar]);
      await q(`insert into contract_units (contract_id, unit_id) values ($1, $2)`, [ids[key], ids[unitKey]]);
    };
    await contract("C1", "T1", "U11", "2026-01-01", "2026-12-31", "10000", "10000", "active", "10512345678");
    await contract("C2", "T2", "U12", "2026-01-01", "2026-12-31", "6000", "6000");
    await contract("C3", "T3", "A1", "2026-01-01", "2026-12-31", "3500", "2000");
    await contract("C4", "T4", "A2", "2026-02-01", "2027-01-31", "3000", "3000");
    await contract("C5", "T5", "B1", "2026-01-01", "2026-12-31", "5000", "1500", "terminated");
    await q(`insert into finance_contract_dims (contract_id, user_id, owner_id, property_id, ended_on) values ($1, $2, $3, $4, '2026-02-28')`, [ids.C5, U, ids.O3, ids.P3]);
    await contract("C0", "T0", "U12", "2025-01-01", "2025-12-31", "500", null, "expired");
    await contract("C9", "T0", "A3", "2026-06-01", "2027-05-31", "1000", "800", "pending"); // future: A3 is vacant at 2026-03-31

    const d = (c: string, tenant: string, unitKey: string, prop: string, owner: string): X =>
      ({ contractId: ids[c], tenantId: ids[tenant], unitId: ids[unitKey], propertyId: ids[prop], ownerId: ids[owner] });
    const c1 = d("C1", "T1", "U11", "P1", "O1"), c2 = d("C2", "T2", "U12", "P1", "O1"), c0 = d("C0", "T0", "U12", "P1", "O1");
    const c3 = d("C3", "T3", "A1", "P2", "O2"), c4 = d("C4", "T4", "A2", "P2", "O2"), c5 = d("C5", "T5", "B1", "P3", "O3");
    const out = (b: string, seller = "account") => ({ vatCategory: "S" as const, vatBase: toHalalas(b), taxRole: "output" as const, sellerKey: seller });

    // Prior year: C0 charged 500, never paid (opening AR; written off 200 in February).
    await post("2025-12-01", "E02", [L("1121", "dr", "500.00", c0), L("4120", "cr", "500.00", c0)]);
    // Capital paid in.
    await post("2026-01-01", "E28", [L("1113", "dr", "20000.00"), L("3100", "cr", "20000.00")], "manual");
    // C1 (principal, commercial S): one quarterly invoice, collected; straight-line releases.
    await post("2026-01-01", "E01", [L("1121", "dr", "34500.00", c1), L("2131", "cr", "30000.00", c1), L("2151", "cr", "4500.00", { ...c1, ...out("30000.00") })]);
    await post("2026-01-05", "E03", [L("1113", "dr", "34500.00", c1), L("1121", "cr", "34500.00", c1)]);
    for (const m of ["2026-01-31", "2026-02-28", "2026-03-31"]) await post(m, "E35", [L("2131", "dr", "10000.00", c1), L("4120", "cr", "10000.00", c1)]);
    // C2 (principal): monthly charges, a credit note, part collections (the workbook's 2,750 outstanding).
    for (const m of ["2026-01-01", "2026-02-01", "2026-03-01"]) {
      await post(m, "E02", [L("1121", "dr", "6900.00", c2), L("2131", "cr", "6000.00", c2), L("2151", "cr", "900.00", { ...c2, ...out("6000.00") })]);
    }
    await post("2026-03-05", "E06", [L("2131", "dr", "1000.00", c2), L("2151", "dr", "150.00", { ...c2, ...out("-1000.00") }), L("1121", "cr", "1150.00", c2)]);
    await post("2026-01-03", "E03", [L("1113", "dr", "6900.00", c2), L("1121", "cr", "6900.00", c2)]);
    await post("2026-02-03", "E03", [L("1113", "dr", "6900.00", c2), L("1121", "cr", "6900.00", c2)]);
    await post("2026-03-03", "E03", [L("1113", "dr", "3000.00", c2), L("1121", "cr", "3000.00", c2)]);
    const wrong = await post("2026-03-10", "E03", [L("1113", "dr", "100.00", c2), L("1121", "cr", "100.00", c2)]);
    await withTx(t.pool, (c) => repo.reverse(c, U, wrong.id, { entryDate: "2026-03-12" }));
    for (const [m, v] of [["2026-01-31", "6000.00"], ["2026-02-28", "6000.00"], ["2026-03-31", "5000.00"]]) {
      await post(m, "E35", [L("2131", "dr", v, c2), L("4120", "cr", v, c2)]);
    }
    // Deposits of the principal contracts into the operating bank.
    await post("2026-01-01", "E09", [L("1113", "dr", "10000.00", c1), L("2141", "cr", "10000.00", c1)]);
    await post("2026-01-01", "E09", [L("1113", "dr", "6000.00", c2), L("2141", "cr", "6000.00", c2)]);
    // C0 write-off.
    await post("2026-02-01", "E24", [L("5330", "dr", "200.00", c0), L("1121", "cr", "200.00", c0)]);

    // C3 (agent O2, residential E): monthly charges, collected into the trust account.
    for (const [due, paid] of [["2026-01-01", "2026-01-02"], ["2026-02-01", "2026-02-02"], ["2026-03-01", "2026-03-02"]]) {
      await post(due, "E02", [L("1122", "dr", "3500.00", c3), L("2122", "cr", "3500.00", { ...c3, vatCategory: "E", sellerKey: `owner:${ids.O2}` })]);
      await post(paid, "E03", [L("1114", "dr", "3500.00", c3), L("1122", "cr", "3500.00", c3), L("2122", "dr", "3500.00", c3), L("2121", "cr", "3500.00", c3)]);
    }
    await post("2026-01-01", "E09", [L("1114", "dr", "2000.00", c3), L("2141", "cr", "2000.00", c3)]);
    // C4 (agent O2): February collected, March settled through Ejar (paid to the landlord directly: no cash here).
    for (const due of ["2026-02-01", "2026-03-01"]) {
      await post(due, "E02", [L("1122", "dr", "3000.00", c4), L("2122", "cr", "3000.00", { ...c4, vatCategory: "E", sellerKey: `owner:${ids.O2}` })]);
    }
    await post("2026-02-03", "E03", [L("1114", "dr", "3000.00", c4), L("1122", "cr", "3000.00", c4), L("2122", "dr", "3000.00", c4), L("2121", "cr", "3000.00", c4)]);
    await post("2026-03-04", "E33", [L("2122", "dr", "3000.00", c4), L("1122", "cr", "3000.00", c4)]);
    await post("2026-02-01", "E09C", [L("1114", "dr", "3000.00", c4), L("2141", "cr", "3000.00", c4)]);
    // O2: an expense charged to the landlord (unregistered: VAT not recoverable), commission (gross cost 1,207.50), a payout.
    const p2 = { propertyId: ids.P2, ownerId: ids.O2 };
    await post("2026-02-15", "E18", [
      L("2121", "dr", "800.00", { ...p2, vatCategory: "S", sellerKey: `owner:${ids.O2}` }),
      L("2121", "dr", "120.00", { ...p2, ...out("800.00", `owner:${ids.O2}`), taxRole: "input_nonrecoverable" }),
      L("1114", "cr", "920.00", p2)]);
    await post("2026-03-31", "E15", [L("2121", "dr", "1207.50", p2), L("4210", "cr", "1050.00", { ...p2, vatCategory: "S" }), L("2151", "cr", "157.50", { ...p2, ...out("1050.00") })]);
    await post("2026-03-31", "E19", [L("2121", "dr", "9000.00", p2), L("1114", "cr", "9000.00", p2)]);
    // Commission cash moved from the trust account to the operating account (an internal transfer).
    await post("2026-03-31", "E28", [L("1113", "dr", "1207.50"), L("1114", "cr", "1207.50")], "manual");

    // C5 (agent O3, VAT-registered, commercial S): January charged and collected; ended 28 Feb; deposit 1,000 refunded + 500 forfeited to the landlord.
    const s3 = `owner:${ids.O3}`;
    await post("2026-01-01", "E02", [L("1122", "dr", "5750.00", c5), L("2122", "cr", "5000.00", { ...c5, vatCategory: "S", sellerKey: s3 }), L("2122", "cr", "750.00", { ...c5, ...out("5000.00", s3) })]);
    await post("2026-01-04", "E03", [L("1114", "dr", "5750.00", c5), L("1122", "cr", "5750.00", c5), L("2122", "dr", "5750.00", c5), L("2121", "cr", "5750.00", c5)]);
    await post("2026-01-01", "E09", [L("1114", "dr", "1500.00", c5), L("2141", "cr", "1500.00", c5)]);
    await post("2026-02-28", "E10", [L("2141", "dr", "1000.00", c5), L("1114", "cr", "1000.00", c5)]);
    await post("2026-02-28", "E11", [L("2141", "dr", "500.00", c5), L("2121", "cr", "500.00", { ...c5, vatCategory: "O", sellerKey: s3 })]);
    const p3 = { propertyId: ids.P3, ownerId: ids.O3 };
    await post("2026-02-20", "E18", [
      L("2121", "dr", "400.00", { ...p3, vatCategory: "S", sellerKey: s3 }),
      L("2121", "dr", "60.00", { ...p3, ...out("400.00", s3), taxRole: "input" }),
      L("1114", "cr", "460.00", p3)]);
    await post("2026-03-31", "E15", [L("2121", "dr", "575.00", p3), L("4210", "cr", "500.00", { ...p3, vatCategory: "S" }), L("2151", "cr", "75.00", { ...p3, ...out("500.00") })]);

    // Office: a property expense on the tower, an overhead, a supplier bill and its payment, VAT paid, equipment bought.
    await post("2026-02-10", "E18", [L("5110", "dr", "2000.00", { propertyId: ids.P1, ownerId: ids.O1 }), L("1151", "dr", "300.00", { propertyId: ids.P1, ownerId: ids.O1 }), L("1113", "cr", "2300.00")]);
    await post("2026-02-12", "E18", [L("5290", "dr", "500.00"), L("1113", "cr", "500.00")]);
    await post("2026-02-14", "E38", [L("5120", "dr", "1000.00", { propertyId: ids.P1, ownerId: ids.O1 }), L("2111", "cr", "1000.00")]);
    await post("2026-03-14", "E39", [L("2111", "dr", "1000.00"), L("1113", "cr", "1000.00")]);
    await post("2026-03-20", "E28", [L("2151", "dr", "500.00"), L("1113", "cr", "500.00")], "manual");
    await post("2026-03-25", "E28", [L("1222", "dr", "3000.00"), L("1113", "cr", "3000.00")], "manual");
    // Another account's cash never shows up here.
    const accO = Object.fromEntries((await q(`select code, id from accounts where user_id = $1`, [OTHER])).rows.map((r: any) => [r.code, r.id]));
    await withTx(t.pool, (c) => repo.post(c, { userId: OTHER, entryDate: "2026-02-01", origin: "manual", sourceType: "test", sourceId: 1, event: "posted",
      lines: [{ accountId: accO["1113"], debit: toHalalas("99999.00") }, { accountId: accO["3100"], credit: toHalalas("99999.00") }], payload: { rule: "E28" } }));
  });
  after(async () => { await t?.drop(); });

  /** closing debit − credit of an account on the trial balance at `to`. */
  const tbClosing = async (to: string, code: string, extra: Record<string, string> = {}) => {
    const tb: any = await core.trialBalance(U, { from: "2026-01-01", to, ...extra });
    const r = tb.rows.find((x: any) => x.code === code);
    return r ? toHalalas(r.closingDebit) - toHalalas(r.closingCredit) : 0;
  };

  describe("cash flow (direct method)", () => {
    let cf: any;
    before(async () => { cf = await svc.cashFlow(U, { from: "2026-01-01", to: "2026-03-31", lang: "en" }); });
    const line = (k: string) => cf.sections.flatMap((s: any) => s.lines).find((l: any) => l.key === k);

    it("classifies each cash movement by rule or counter-account, split trust / own", () => {
      assert.deepEqual(line("tenant_receipts"), { key: "tenant_receipts", amount: "70550.00", restricted: "19250.00", own: "51300.00", entries: 11 });
      assert.equal(line("ejar_settlements"), undefined, "an Ejar settlement to an agent landlord moves no cash of ours");
      assert.deepEqual([line("deposits_received").amount, line("deposits_received").restricted], ["22500.00", "6500.00"]);
      assert.equal(line("deposits_refunded").amount, "-1000.00");
      assert.equal(line("landlord_payouts").amount, "-9000.00");
      assert.deepEqual([line("expenses_paid").amount, line("expenses_paid").restricted, line("expenses_paid").own], ["-4180.00", "-1380.00", "-2800.00"]);
      assert.equal(line("supplier_payments").amount, "-1000.00");
      assert.equal(line("vat").amount, "-500.00");
      assert.equal(line("investing").amount, "-3000.00");
      assert.equal(line("capital").amount, "20000.00");
      assert.deepEqual(cf.sections.map((s: any) => [s.key, s.total.amount]), [["operating", "77370.00"], ["investing", "-3000.00"], ["financing", "20000.00"]]);
      assert.deepEqual({ amount: cf.internalTransfers.amount, restricted: cf.internalTransfers.restricted, own: cf.internalTransfers.own, gross: cf.internalTransfers.gross },
        { amount: "0.00", restricted: "-1207.50", own: "1207.50", gross: "1207.50" });
    });

    it("opening + net change = closing, and closing equals the cash and bank ledger balances (trial balance)", async () => {
      assert.deepEqual(cf.opening, { amount: "0.00", restricted: "0.00", own: "0.00" });
      assert.deepEqual(cf.netChange, { amount: "94370.00", restricted: "13162.50", own: "81207.50" });
      assert.deepEqual(cf.closing, cf.netChange);
      const tb = (await tbClosing("2026-03-31", "1113")) + (await tbClosing("2026-03-31", "1114"));
      assert.equal(toHalalas(cf.closing.amount), tb);
      assert.equal(toHalalas(cf.closing.restricted), await tbClosing("2026-03-31", "1114"));
      assert.equal(cf.check.balanced, true);
      assert.equal(cf.check.ledgerClosing, "94370.00");
      assert.deepEqual(cf.accounts.map((a: any) => [a.code, a.isTrust, a.closing]), [["1113", false, "81207.50"], ["1114", true, "13162.50"]]);
    });

    it("restricted cash: the trust accounts, with client money held (2141 + 2121) and the trust difference", () => {
      assert.deepEqual(cf.restrictedCash, {
        basis: "trust_accounts", trustAccounts: "13162.50", depositsHeld: "21000.00", landlordPayable: "7587.50", clientMoneyHeld: "28587.50",
        restricted: "13162.50", unrestricted: "81207.50", trustDifference: "-15425.00",
      });
    });

    it("a later period opens where the earlier one closed", async () => {
      const feb: any = await svc.cashFlow(U, { from: "2026-03-01", to: "2026-03-31" });
      const janFeb: any = await svc.cashFlow(U, { from: "2026-01-01", to: "2026-02-28" });
      assert.deepEqual(feb.opening, janFeb.closing);
      assert.equal(feb.closing.amount, "94370.00");
    });
  });

  describe("rent roll", () => {
    let rr: any;
    before(async () => { rr = await svc.rentRoll(U, { asOf: "2026-03-31", from: "2026-01-01", lang: "en" }); });
    const row = (c: string) => rr.rows.find((r: any) => r.contractNumber === c);

    it("one row per unit with its lease, billed / collected / outstanding and days remaining", () => {
      assert.deepEqual(rr.rows.map((r: any) => [r.propertyName, r.unitNumber, r.status, r.contractNumber]), [
        ["A Tower", "101", "leased", "C1"], ["A Tower", "102", "leased", "C2"],
        ["B Palms", "A1", "leased", "C3"], ["B Palms", "A2", "leased", "C4"], ["B Palms", "A3", "vacant", null],
        ["C Villa", "B1", "vacant", null],
        ["A Tower", "102", "ended", "C0"], ["C Villa", "B1", "ended", "C5"],
      ]);
      const c1 = row("C1");
      assert.deepEqual([c1.ejarContractNumber, c1.annualRent, c1.billed, c1.collected, c1.outstanding, c1.daysRemaining, c1.tenantName],
        ["10512345678", "120000.00", "34500.00", "34500.00", "0.00", 275, "Tenant T1"]);
      assert.deepEqual([row("C2").billed, row("C2").collected, row("C2").outstanding], ["19550.00", "16800.00", "2750.00"]);
      assert.deepEqual([row("C4").billed, row("C4").collected, row("C4").outstanding, row("C4").daysRemaining], ["6000.00", "6000.00", "0.00", 306]);
      assert.deepEqual([row("C0").opening, row("C0").adjustments, row("C0").outstanding], ["500.00", "-200.00", "300.00"]);
      assert.deepEqual([row("C5").billed, row("C5").collected, row("C5").daysRemaining], ["5750.00", "5750.00", null]);
    });

    it("the outstanding total ties to the receivable accounts (1121 + 1122) on the trial balance", async () => {
      assert.deepEqual(rr.totals, { opening: "500.00", billed: "76300.00", collected: "73550.00", adjustments: "-200.00", outstanding: "3050.00", annualRent: "270000.00" });
      const tb = (await tbClosing("2026-03-31", "1121")) + (await tbClosing("2026-03-31", "1122"));
      assert.equal(toHalalas(rr.totals.outstanding), tb);
      assert.deepEqual(rr.check, { ledgerAr: "3050.00", difference: "0.00", balanced: true });
    });

    it("occupancy summary", () => {
      assert.deepEqual({ ...rr.occupancy, byProperty: undefined }, {
        units: 6, leased: 4, vacant: 2, occupancyPct: "66.67", annualRentLeased: "270000.00", collectionPct: "96.40", byProperty: undefined,
      });
      assert.deepEqual(rr.occupancy.byProperty.map((b: any) => [b.propertyName, b.units, b.leased, b.occupancyPct]),
        [["A Tower", 2, 2, "100.00"], ["B Palms", 3, 2, "66.67"], ["C Villa", 1, 0, "0.00"]]);
    });

    it("filtered by landlord, still ties to the ledger with the same filter", async () => {
      const o2: any = await svc.rentRoll(U, { asOf: "2026-03-31", ownerId: String(ids.O2) });
      assert.deepEqual(o2.rows.map((r: any) => r.unitNumber), ["A1", "A2", "A3"]);
      assert.equal(o2.totals.outstanding, "0.00");
      assert.equal(o2.check.balanced, true);
      await assert.rejects(svc.rentRoll(U, { ownerId: "999999" }), /not found/i);
    });
  });

  describe("deposits register", () => {
    let dr: any;
    before(async () => { dr = await svc.depositsRegister(U, { from: "2026-01-01", to: "2026-03-31" }); });

    it("per contract: required, received, deducted, refunded, balance and state", () => {
      const r = (c: string) => dr.rows.find((x: any) => x.contractNumber === c);
      assert.deepEqual(dr.rows.map((x: any) => x.contractNumber), ["C1", "C2", "C3", "C4", "C5"]);
      assert.deepEqual([r("C1").required, r("C1").received, r("C1").balance, r("C1").state], ["10000.00", "10000.00", "10000.00", "held"]);
      assert.deepEqual([r("C4").received, r("C4").balance], ["3000.00", "3000.00"], "E09C (deposit installment collection) is a receipt");
      const c5 = r("C5");
      assert.deepEqual([c5.received, c5.refunded, c5.forfeited, c5.deducted, c5.balance, c5.contractStatus, c5.state],
        ["1500.00", "1000.00", "500.00", "500.00", "0.00", "ended", "settled"]);
    });

    it("the balance total ties to the deposits-held account (2141)", async () => {
      assert.deepEqual([dr.totals.required, dr.totals.received, dr.totals.deducted, dr.totals.refunded, dr.totals.balance, dr.totals.uncollected],
        ["22500.00", "22500.00", "500.00", "1000.00", "21000.00", "0.00"]);
      assert.equal(-toHalalas(dr.totals.balance), await tbClosing("2026-03-31", "2141"));
      assert.equal(dr.check.balanced, true);
    });

    it("a period after the receipts opens with them and shows only its own movements", async () => {
      const mar: any = await svc.depositsRegister(U, { from: "2026-03-01", to: "2026-03-31" });
      assert.deepEqual([mar.totals.opening, mar.totals.received, mar.totals.refunded, mar.totals.balance], ["21000.00", "0.00", "0.00", "21000.00"]);
    });

    it("a contract that requires a deposit not yet received shows it as uncollected", async () => {
      const later: any = await svc.depositsRegister(U, { from: "2026-01-01", to: "2026-06-30" });
      const c9 = later.rows.find((x: any) => x.contractNumber === "C9");
      assert.deepEqual([c9.required, c9.received, c9.uncollected, c9.state], ["800.00", "0.00", "800.00", "not_collected"]);
    });
  });

  describe("property profitability", () => {
    let pp: any;
    before(async () => { pp = await svc.propertyProfitability(U, { from: "2026-01-01", to: "2026-03-31" }); });
    const row = (name: string | null) => pp.rows.find((r: any) => r.propertyName === name);

    it("principal property: rent revenue (straight-line), expenses, NOI, occupancy and collection", () => {
      const a = row("A Tower");
      assert.deepEqual([a.treatment, a.revenue, a.rentRevenue, a.expenses, a.noi, a.units, a.leased, a.occupancyPct, a.billed, a.collected, a.collectionPct, a.landlord],
        ["principal", "47000.00", "47000.00", "3200.00", "43800.00", 2, 2, "100.00", "54050.00", "51300.00", "94.91", null]);
    });

    it("agent properties: the office earns the commission; the landlord's rent, costs and net are shown apart", () => {
      const b = row("B Palms");
      assert.deepEqual([b.treatment, b.revenue, b.rentRevenue, b.commission, b.noi, b.occupancyPct, b.collectionPct], ["agent", "1050.00", "0.00", "1050.00", "1050.00", "66.67", "100.00"]);
      // Unregistered landlord: commission and expenses at gross (VAT not recoverable).
      assert.deepEqual(b.landlord, { vatRegistered: false, rent: "16500.00", commission: "1207.50", expenses: "920.00", net: "14372.50", marginPct: "87.11" });
      const c = row("C Villa");
      // Registered landlord: rent net of output VAT; commission and expenses net of recoverable VAT.
      assert.deepEqual(c.landlord, { vatRegistered: true, rent: "5000.00", commission: "500.00", expenses: "400.00", net: "4100.00", marginPct: "82.00" });
      assert.deepEqual([c.units, c.leased, c.occupancyPct], [1, 0, "0.00"]);
    });

    it("revenue and expenses tie to the income statement (an unallocated row carries company overheads)", async () => {
      const un = pp.rows.find((r: any) => r.treatment === "unallocated");
      assert.deepEqual([un.revenue, un.expenses], ["0.00", "500.00"]);
      assert.deepEqual([pp.totals.revenue, pp.totals.expenses, pp.totals.noi, pp.totals.commission], ["48550.00", "3700.00", "44850.00", "1550.00"]);
      const is: any = await core.incomeStatement(U, { from: "2026-01-01", to: "2026-03-31" });
      assert.equal(pp.totals.revenue, is.revenue.total.total);
      assert.equal(pp.totals.expenses, is.expenses.total.total);
      assert.equal(pp.check.balanced, true);
      assert.equal(toHalalas(pp.totals.commission), -(await tbClosing("2026-03-31", "4210")));
    });

    it("filtered by property", async () => {
      const one: any = await svc.propertyProfitability(U, { from: "2026-01-01", to: "2026-03-31", propertyId: String(ids.P2) });
      assert.deepEqual(one.rows.map((r: any) => r.propertyName), ["B Palms"]);
      assert.equal(one.check.balanced, true);
    });
  });

  describe("scope and routes", () => {
    it("another account sees only its own cash", async () => {
      const cf: any = await svc.cashFlow(OTHER, { from: "2026-01-01", to: "2026-03-31" });
      assert.equal(cf.closing.amount, "99999.00");
      const rr: any = await svc.rentRoll(OTHER, { asOf: "2026-03-31" });
      assert.equal(rr.rows.length, 0);
      await assert.rejects(svc.rentRoll(OTHER, { propertyId: String(ids.P1) }), /not found/i);
    });

    it("rejects a bad range", async () => {
      await assert.rejects(svc.cashFlow(U, { from: "2026-04-01", to: "2026-03-31" }), /from must not be after/);
    });

    it("every route is behind JwtAuthGuard + FinanceV2Guard with the view capability", () => {
      const guards = Reflect.getMetadata("__guards__", FinanceV2AcctReportsController) ?? [];
      assert.ok(guards.includes(FinanceV2Guard));
      const proto = FinanceV2AcctReportsController.prototype as any;
      for (const m of ["cashFlow", "rentRoll", "depositsRegister", "propertyProfitability"]) {
        assert.equal(Reflect.getMetadata("fv2:capability", proto[m]), "view", m);
        assert.equal(Reflect.getMetadata("fv2:allowOwnerScope", proto[m]), undefined, m);
      }
    });
  });
});
