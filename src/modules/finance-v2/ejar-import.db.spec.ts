import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { EjarController } from "../ejar/ejar.module";
import { paymentsListV2 } from "./overrides/payments-list";
import { contractSummaryV2, dashboardV2 } from "./overrides/reads";
import { ArAgingService } from "./reports/aging.service";
import { ReconciliationService } from "./reports/reconciliation.service";
import { legacyAccountingFor } from "./reports/legacy-accounting";
import { sqlOf } from "./hooks/sql";
import { BackfillService } from "./backfill/backfill.service";
import { LedgerStartService } from "./ledger-start.service";
import { FinanceSetupService } from "./setup.service";
import { ChartService } from "./chart.service";
import { PeriodsService } from "./periods.service";
import { withTx } from "./db";

/**
 * The Ejar import, end to end, on the REAL legacy controllers (FINANCE-V2-FIX-LIST
 * items 1, 2, 3; test plan FR-2 and §8 issues 11a, 11b, 11c, 11f, 11g, 11h, 11i).
 * `POST /ejar/import` never calls Ejar: it takes the already-mapped preview
 * from the body, so these bodies are fully synthetic (public repo).
 *
 *  - ON:  Finance v2 on (manager mode, ledger started), recognizer + worker run
 *         as of 2026-09-30;
 *  - OFF: Finance v2 off, the legacy attach.
 */
const U_ON = 5301;
const U_OFF = 5302;
const TODAY = "2026-09-30";
const refuse = new Proxy({}, { get: () => () => { throw new Error("ejar spec: NHC must not be reached"); } });

const months = ["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01",
  "2027-01-01", "2027-02-01", "2027-03-01", "2027-04-01", "2027-05-01", "2027-06-01"];

function body(num: string, o: {
  lessorId: string; usage: string; invoices: Array<Record<string, unknown>>; fees?: Array<Record<string, unknown>>; deposit?: string;
}) {
  return {
    contract: {
      ejarContractNumber: num, status: "active", startDate: "2026-07-01", endDate: "2027-06-30", paymentFrequency: "monthly", monthlyRent: "3000",
      tenantType: "individual", tenantName: "Synthetic Ejar Tenant", tenantIdNumber: `19${num.replace(/\D/g, "").padStart(8, "0")}`,
      tenantPhone: "500000000", tenantEmail: "ejar-tenant@example.test",
      landlordName: "Synthetic Ejar Lessor", landlordIdNumber: o.lessorId, depositAmount: o.deposit ?? "3000",
      customSchedule: months.map((d) => ({ dueDate: d, amount: "3000" })),
    },
    property: { ejarId: `prop-${num}`, name: `Synthetic Ejar Property ${num}`, propertyUsage: o.usage },
    units: [{ ejarId: `unit-${num}`, unitNumber: "EJ-1" }],
    parties: {
      lessors: [{ name: "Synthetic Ejar Lessor", idNumber: o.lessorId, isRepresentative: false }],
      tenants: [{ name: "Synthetic Ejar Tenant", idNumber: `19${num.replace(/\D/g, "").padStart(8, "0")}`, isRepresentative: false }],
    },
    invoices: o.invoices,
    additionalFees: o.fees ?? [],
  };
}

const inv = (number: string | null, dueDate: string, status: string, remaining: string, amount = "3000") =>
  ({ id: `${number ?? "x"}-${dueDate}`, number, dueDate, issueDate: dueDate.replace(/-01$/, "-25").replace(/^(\d{4})-(\d{2})/, (_, y, m) => {
    const mm = Number(m) === 1 ? 12 : Number(m) - 1;
    return `${Number(m) === 1 ? Number(y) - 1 : y}-${String(mm).padStart(2, "0")}`;
  }), lateDate: null, amount, remaining, status });

async function setup(env: LegacyEnv, user: number): Promise<{ seed: Seed; ejar: any }> {
  const seed = await seedAccount(env, user);
  for (const [key, ar] of [["families", "عوائل"], ["individuals", "أفراد"], ["commercial", "تجاري"]]) {
    const [x] = await env.q(`select 1 from lookups where category = 'property_usage' and key = $1`, [key]);
    if (!x) await env.q(`insert into lookups (category, key, label_ar, label_en) values ('property_usage', $1, $2, $1)`, [key, ar]);
  }
  const ejar = new (EjarController as any)(env.db, refuse, refuse, refuse);
  ejar.fv2h = env.hooks;
  return { seed, ejar };
}

const rowsOf = (env: LegacyEnv, contractId: number) => env.q(
  `select p.id, to_char(p.due_date,'YYYY-MM-DD') as due, p.amount::text as amount, p.status::text as status, p.description, p.vat_enabled,
          s.reported_status, s.reported_amount::text as reported
     from payments p left join finance_ejar_settlements s on s.payment_id = p.id
    where p.contract_id = $1 and p.deleted_at is null order by p.due_date, p.description nulls first, p.id`, [contractId]);

describe("finance v2: Ejar import settles, classifies and taxes by what Ejar reports", { skip: fv2DbSkip }, () => {
  let on: LegacyEnv;
  let off: LegacyEnv;
  let seedOn: Seed;
  let a: any; // FINQA-EJ-A: agent, residential; Jul paid, Aug part-paid (1,000 remaining), Sep no number, a 500 fee on Jul 1
  let b: any; // FINQA-EJ-B: agent, residential; Aug "مدفوعة جزئياً"
  let c: any; // FINQA-EJ-C: the account holder's own commercial property (principal)

  before(async () => {
    on = await legacyEnv("wired");
    off = await legacyEnv("wired");
    const s1 = await setup(on, U_ON);
    seedOn = s1.seed;
    await enableV2(on, U_ON, "manager");
    const holderIdOn = (await on.q(`select id_number from owners where id = $1`, [seedOn.holder]))[0].id_number;
    const invA = [
      inv("EJ-INV-A1", "2026-07-01", "مدفوعة", "0"),
      inv("EJ-INV-A2", "2026-08-01", "متأخرة", "1000"),
      inv(null, "2026-09-01", "غير مدفوعة", "3000"),
      inv("EJ-INV-A4", "2026-10-01", "غير مدفوعة", "3000"),
    ];
    const fee = [{ name: "رسوم خدمات", amount: "500", recurrence: "one_time" }];
    a = await s1.ejar.import(userOf(U_ON), body("FINQA-EJ-A", { lessorId: "2000000011", usage: "residential_families", invoices: invA, fees: fee }));
    b = await s1.ejar.import(userOf(U_ON), body("FINQA-EJ-B", { lessorId: "2000000011", usage: "residential_families", invoices: [
      inv("EJ-INV-B1", "2026-07-01", "مدفوعة", "0"), inv("EJ-INV-B2", "2026-08-01", "مدفوعة جزئياً", "1000")] }));
    c = await s1.ejar.import(userOf(U_ON), body("FINQA-EJ-C", { lessorId: holderIdOn, usage: "commercial", invoices: [
      inv("EJ-INV-C1", "2026-07-01", "مدفوعة", "0"), inv("EJ-INV-C2", "2026-08-01", "غير مدفوعة", "3000")] }));
    await on.recognizer.runAccount(U_ON, TODAY);
    for (let i = 0; i < 10; i++) {
      const r = await on.worker.runAccount(U_ON);
      if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
    }
    await on.recognizer.runAccount(U_ON, TODAY);
    for (let i = 0; i < 10; i++) {
      const r = await on.worker.runAccount(U_ON);
      if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
    }

    const s2 = await setup(off, U_OFF);
    await s2.ejar.import(userOf(U_OFF), body("FINQA-EJ-OFF", { lessorId: "2000000022", usage: "commercial",
      invoices: [inv("EJ-INV-O1", "2026-07-01", "مدفوعة", "0"), inv("EJ-INV-O2", "2026-08-01", "مدفوعة جزئياً", "1000"),
        inv(null, "2026-09-01", "غير مدفوعة", "3000")],
      fees: fee }));
  });

  after(async () => {
    await on?.t.drop();
    await off?.t.drop();
  });

  it("11a: the fee row on the same date as a rent invoice is not stamped, not settled, and charged as a fee", async () => {
    const rows = await rowsOf(on, a.id);
    const fee = rows.find((r: any) => r.description === "رسوم خدمات")!;
    assert.ok(fee, "the fee row keeps its fee name");
    assert.equal(fee.status, "pending");
    assert.equal(fee.reported_status, null);
    const jul = rows.find((r: any) => r.due === "2026-07-01" && r.amount === "3000.00")!;
    assert.equal(jul.status, "settled_external");
    assert.match(jul.description, /^فاتورة إيجار رقم EJ-INV-A1/);
    const [e] = await on.q(`select payload->'facts'->>'nature' as nature from ledger_outbox where user_id = $1 and source_type = 'payment' and source_id = $2 and event = 'charge'`, [U_ON, fee.id]);
    assert.equal(e?.nature, "fee");
    const settled = await on.q(`select 1 from ledger_outbox where user_id = $1 and source_type = 'payment' and source_id = $2 and event <> 'charge'`, [U_ON, fee.id]);
    assert.equal(settled.length, 0, "nothing settles the fee");
  });

  it("11i: a rent invoice with a date but no number stays rent (description and charge)", async () => {
    const sep = (await rowsOf(on, a.id)).find((r: any) => r.due === "2026-09-01")!;
    assert.match(sep.description, /^فاتورة إيجار/);
    const [e] = await on.q(`select payload->'facts'->>'nature' as nature from ledger_outbox where user_id = $1 and source_type = 'payment' and source_id = $2 and event = 'charge'`, [U_ON, sep.id]);
    assert.equal(e?.nature, "rent");
  });

  it("11b: 'مدفوعة جزئياً' is a part payment: the row stays open for the remaining 1,000", async () => {
    const aug = (await rowsOf(on, b.id)).find((r: any) => r.due === "2026-08-01")!;
    assert.equal(aug.status, "pending");
    assert.deepEqual([aug.reported_status, aug.reported], ["partially_paid", "2000.00"]);
  });

  it("11c: the reported 2,000 counts: Aug is overdue by 1,000 in the list, aging, dashboard and contract summary", async () => {
    const q = sqlOf(on.t.pool as any);
    const list: any = await paymentsListV2(q, U_ON, { contractIds: String(a.id), page: 1, pageSize: 50 });
    const aug = list.data.find((r: any) => r.dueDate === "2026-08-01");
    assert.equal(aug.statusV2, "overdue");
    assert.equal(aug.remaining, 1000);
    assert.equal(aug.ejarSettled, 2000);
    const jul = list.data.find((r: any) => r.dueDate === "2026-07-01" && r.amount === "3000.00");
    assert.equal(jul.statusV2, "settled_external");

    const aging = await new ArAgingService(on.t.pool as any).openItems(U_ON, TODAY);
    const item = aging.items.find((i) => i.type === "installment" && i.id === aug.id)!;
    assert.equal(item.remaining, 100_000, "1,000.00 in halalas");

    const sum: any = await contractSummaryV2(q, U_ON, a.id, TODAY);
    // Aug 1,000 + Sep 3,000 + the Jul fee 500.
    assert.equal(sum.overdue, "4500.00");
    assert.equal(sum.settledExternal, "5000.00", "Jul 3,000 settled in Ejar + Aug 2,000 reported");
    assert.equal(sum.outstanding, "4500.00");

    const dash: any = await dashboardV2(q, U_ON, {}, TODAY);
    // A: 4,500; B: Aug 1,000 + Sep 3,000; C: Aug 3,000 + Sep 3,000.
    assert.equal(dash.overdueAmount, 4500 + 4000 + 6000);
  });

  it("11h: E33 settles only what Ejar reported (2,000 on the part-paid row), in the agent's accounts", async () => {
    const aug = (await rowsOf(on, a.id)).find((r: any) => r.due === "2026-08-01")!;
    const lines = await on.q(
      `select a.system_key as k, l.debit::text as dr, l.credit::text as cr, to_char(l.entry_date,'YYYY-MM-DD') as d
         from journal_lines l join accounts a on a.id = l.account_id join journal_entries e on e.id = l.entry_id
        where l.user_id = $1 and e.source_type = 'payment' and e.source_id = $2 and e.event in ('settled_external','ejar_partial')
        order by l.id`, [U_ON, aug.id]);
    assert.deepEqual(lines.map((l: any) => [l.k, l.dr, l.cr]), [
      ["landlord_payable_uncollected", "2000.00", "0.00"],
      ["tenant_receivable_agency", "0.00", "2000.00"],
    ]);
    assert.equal(lines[0].d, "2026-08-01");
  });

  it("R1 agrees with the sub-ledger after the partial settlement, and the trial balance balances", async () => {
    const r: any = await new ReconciliationService(on.t.pool as any, legacyAccountingFor(on.db)).reconciliation(U_ON, { asOf: TODAY, lang: "en" });
    const r1 = r.checks.find((x: any) => x.id === "R1");
    assert.equal(r1.difference, "0.00", JSON.stringify(r1.rows));
    const [tb] = await on.q(`select coalesce(sum(debit - credit), 0)::text as s from journal_lines where user_id = $1`, [U_ON]);
    assert.equal(tb.s, "0.00");
    const [err] = await on.q(`select count(*)::int as n from ledger_outbox where user_id = $1 and status = 'failed'`, [U_ON]);
    assert.equal(err.n, 0);
  });

  it("E27 after a part settlement: settling the rest outside Dara clears only the remaining 1,000", async () => {
    const aug = (await rowsOf(on, b.id)).find((r: any) => r.due === "2026-08-01")!;
    await on.payments.settleExternal(userOf(U_ON), String(aug.id));
    for (let i = 0; i < 5; i++) {
      const r = await on.worker.runAccount(U_ON);
      if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
    }
    const [ar] = await on.q(
      `select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
        where l.user_id = $1 and l.payment_id = $2 and a.system_key = 'tenant_receivable_agency'`, [U_ON, aug.id]);
    assert.equal(ar.b, "0.00", "3,000 charged − 2,000 (Ejar part) − 1,000 (the rest)");
    const r: any = await new ReconciliationService(on.t.pool as any, legacyAccountingFor(on.db)).reconciliation(U_ON, { asOf: TODAY, lang: "en" });
    assert.equal(r.checks.find((x: any) => x.id === "R1").difference, "0.00");
  });

  it("backfill: a catch-up finds nothing new, and a full rebuild reproduces the live ledger (ejar_partial included)", async () => {
    const backfill = new BackfillService(on.t.pool, on.engine, on.worker, new LedgerStartService(on.flag, on.worker), on.recognizer,
      new FinanceSetupService(new ChartService(on.t.pool), new PeriodsService(on.t.pool)));
    const dry: any = await backfill.run({ userId: U_ON, actorUserId: U_ON, mode: "catchup", dryRun: true, today: TODAY });
    assert.equal(dry.events.new, 0, JSON.stringify(dry.events));
    const bal = async () => (await on.q(
      `select a.system_key as k, l.contract_id as c, sum(l.debit - l.credit)::text as b from journal_lines l join accounts a on a.id = l.account_id
        where l.user_id = $1 group by 1, 2 having sum(l.debit - l.credit) <> 0 order by 1, 2`, [U_ON])).map((r: any) => `${r.k}|${r.c}|${r.b}`);
    const live = await bal();
    const [partial] = await on.q(`select count(*)::int as n from ledger_outbox where user_id = $1 and event = 'ejar_partial' and status = 'posted'`, [U_ON]);
    assert.equal(partial.n, 2, "A and B each have one part-paid row");
    await withTx(on.t.pool, async (cl) => {
      await cl.query(`select set_config('fv2.purge', 'on', true)`);
      for (const t of ["journal_lines", "journal_entries", "ledger_outbox", "finance_installment_charges", "finance_installment_vat_points", "finance_backfill_runs"]) {
        await cl.query(`delete from ${t} where user_id = $1`, [U_ON]);
      }
      await cl.query(`update finance_settings set ledger_started_at = null where account_user_id = $1`, [U_ON]);
    });
    on.flag.invalidate(U_ON);
    const full: any = await backfill.run({ userId: U_ON, actorUserId: U_ON, mode: "full", dryRun: false, today: TODAY });
    assert.equal(full.failed.length, 0, JSON.stringify(full.failed.slice(0, 3)));
    assert.deepEqual(await bal(), live);
  });

  it("11g: a commercial Ejar contract is VAT-enabled by usage; the principal's charge books output VAT inside Ejar's amount", async () => {
    const [ct] = await on.q(`select vat_enabled from contracts where id = $1`, [c.id]);
    assert.equal(ct.vat_enabled, true);
    const rows = await rowsOf(on, c.id);
    assert.ok(rows.every((r: any) => r.vat_enabled === true), "every rent row is VAT-enabled");
    assert.ok(rows.every((r: any) => r.amount === "3000.00"), "Ejar's billed amounts are kept (VAT-inclusive)");
    const jul = rows.find((r: any) => r.due === "2026-07-01")!;
    const [e] = await on.q(`select payload->'facts'->>'category' as cat, payload->'facts'->>'treatment' as t from ledger_outbox where source_type = 'payment' and source_id = $1 and event = 'charge'`, [jul.id]);
    assert.deepEqual([e.cat, e.t], ["S", "principal"]);
    const [vat] = await on.q(
      `select coalesce(sum(l.credit - l.debit), 0)::text as v from journal_lines l join accounts a on a.id = l.account_id
        where l.user_id = $1 and a.system_key = 'output_vat' and l.contract_id = $2`, [U_ON, c.id]);
    // Jul, Aug, Sep charged: 3 × (3,000 − 3,000/1.15) = 3 × 391.30.
    assert.equal(vat.v, "1173.90");
    // The residential contract stays exempt / out of scope, as before.
    const [ra] = await on.q(`select vat_enabled from contracts where id = $1`, [a.id]);
    assert.equal(ra.vat_enabled, false);
  });

  it("11f: the imported deposit is recorded as expected, not as money received (no voucher, nothing in 2141 until collected)", async () => {
    const [ct] = await on.q(`select deposit_amount::text as amt, deposit_status from contracts where id = $1`, [a.id]);
    assert.equal(ct.amt, "3000.00");
    const vouchers = await on.q(`select 1 from simple_invoices where contract_id = $1 and kind = 'deposit'`, [a.id]);
    assert.equal(vouchers.length, 0);
    // Collecting it is the manual contract's path: RV + E09 into the chosen account.
    const res: any = await on.contracts.collectDeposit(userOf(U_ON), String(a.id), { method: "bank_transfer", paidDate: "2026-07-01" });
    assert.ok(res.voucher?.id);
    const [e] = await on.q(`select payload->>'rule' as rule from ledger_outbox where source_type = 'simple_invoice' and source_id = $1`, [res.voucher.id]);
    assert.equal(e.rule, "E09");
  });

  it("flag off: fee not stamped, 'مدفوعة جزئياً' is partially_paid (not paid), a numberless invoice is rent, VAT by usage", async () => {
    const [ct] = await off.q(`select id, vat_enabled from contracts where user_id = $1`, [U_OFF]);
    assert.equal(ct.vat_enabled, true);
    const rows = await rowsOf(off, ct.id);
    const fee = rows.find((r: any) => r.description === "رسوم خدمات")!;
    assert.equal(fee.status, "pending");
    const rent = rows.filter((r: any) => r.description !== "رسوم خدمات");
    assert.deepEqual(rent.slice(0, 3).map((r: any) => r.status), ["paid", "partially_paid", "pending"]);
    assert.match(rent[2].description, /^فاتورة إيجار/);
    assert.ok(rent.every((r: any) => r.vat_enabled === true));
    assert.equal(fee.vat_enabled, false);
    // Flag off writes no v2 row.
    const [n] = await off.q(`select count(*)::int as n from finance_ejar_settlements`);
    assert.equal(n.n, 0);
  });
});
