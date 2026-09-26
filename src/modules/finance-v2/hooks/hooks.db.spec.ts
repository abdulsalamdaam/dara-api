import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../__tests__/with-db";
import { attempt, enableV2, legacyEnv, normalise, seedAccount, userOf, type LegacyEnv, type Seed } from "../__tests__/legacy-env";

/**
 * Step 5 (DESIGN §11.3-c, §10.2): the posting hooks on the REAL legacy routes.
 * One scenario of ordinary finance actions runs in three throwaway schemas
 * with identical synthetic fixtures:
 *   - ON:   finance_v2 on (manager mode, ledger started), hooks wired;
 *   - OFF:  finance_v2 off (no settings row), hooks wired;
 *   - BARE: no hooks at all (`fv2h` undefined), i.e. the code as it was.
 * OFF must equal BARE response for response and leave no v2 row; ON must
 * enqueue the right outbox events per step, refuse what v2 refuses, and post
 * cleanly through the worker.
 */
const U = 5101;
const D = (s: string) => s;

interface Run {
  results: Array<{ step: string; out: unknown }>;
  events: Map<string, Array<{ source_type: string; source_id: number; event: string; rule: string | null; origin: string; payload: any }>>;
  ids: Record<string, number>;
  numbers: Record<string, string>;
}

async function scenario(env: LegacyEnv, s: Seed): Promise<Run> {
  const run: Run = { results: [], events: new Map(), ids: {}, numbers: {} };
  const user = userOf(U);
  let last = 0;
  const outboxTail = async () => {
    try {
      const rows = await env.q(
        `select id, source_type, source_id::int as source_id, event, payload->>'rule' as rule, origin, payload from ledger_outbox where id > $1 order by id`, [last]);
      if (rows.length) last = Number(rows[rows.length - 1].id);
      return rows;
    } catch {
      return [];
    }
  };
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const out = await attempt(fn);
    run.results.push({ step: name, out: normalise(out) });
    run.events.set(name, await outboxTail());
    return out as T;
  };
  const pay = async (contractId: number, due: string) =>
    Number((await env.q(`select id from payments where contract_id = $1 and due_date = $2 and deleted_at is null order by id limit 1`, [contractId, due]))[0]?.id);
  const tick = async (today: string) => {
    await env.recognizer.runAccount(U, today);
    for (let i = 0; i < 10; i++) {
      const r = await env.worker.runAccount(U);
      if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
    }
  };

  // Contracts: C1 agent landlord, VAT, advance + collected deposit; C2 the account holder's, quarterly, no VAT.
  const c1: any = await step("create_c1", () => env.contracts.create(user, {
    unitIds: [s.unitA1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: "2026-01-01", endDate: "2026-12-31",
    monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: true, prepaidRent: "2300", prepaidMethod: "bank_transfer",
    depositAmount: "5000", depositStatus: "collected", depositMethod: "bank_transfer", depositDueDate: "2026-01-01",
    landlordName: "Synthetic Landlord A",
  }));
  run.ids.c1 = c1.id;
  const c2: any = await step("create_c2", () => env.contracts.create(user, {
    unitIds: [s.unitH1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: "2026-01-01", endDate: "2026-06-30",
    monthlyRent: "2000", paymentFrequency: "quarterly", vatEnabled: false, depositAmount: "3000", depositStatus: "pending",
  }));
  run.ids.c2 = c2.id;
  const c3: any = await step("create_c3", () => env.contracts.create(user, {
    unitIds: [s.unitA2], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: "2026-01-01", endDate: "2026-06-30",
    monthlyRent: "500", paymentFrequency: "monthly", vatEnabled: false,
  }));
  run.ids.c3 = c3.id;
  for (const [k, due] of [["p1", "2026-01-01"], ["p3", "2026-03-01"], ["p4", "2026-04-01"], ["p5", "2026-05-01"], ["p6", "2026-06-01"]] as const) {
    run.ids[k] = await pay(c1.id, due);
  }

  await step("collect_installment", () => env.payments.addCollection(user, String(run.ids.p3), { amount: "500", collectedDate: D("2026-03-05"), method: "cash" }));

  const inv: any = await step("create_invoice", () => env.billing.create(user, {
    type: "invoice", paymentIds: [run.ids.p4], issueDate: "2026-03-25",
    items: [{ description: "إيجار", quantity: 1, unitPrice: 1000, amount: 1000, vat: true }], total: 1150,
  }));
  run.ids.inv = inv.id;
  run.numbers.inv = inv.number;
  const approved: any = await step("approve_invoice", () => env.billing.approve(user, String(inv.id), { confirmations: { tenantNoVat: true } }));
  run.ids.com = approved?.commission?.id;
  await step("approve_commission", () => env.billing.approve(user, String(run.ids.com), {}));
  await step("collect_commission", () => env.billing.collect(user, String(run.ids.com), { paidDate: "2026-03-30" }));
  const comNo = (await env.q(`select number from simple_invoices where id = $1`, [run.ids.com]))[0]?.number;
  const ccn: any = await step("create_commission_credit", () => env.billing.create(user, {
    type: "credit", billingReference: comNo, issueDate: "2026-03-29",
    items: [{ description: "تعديل عمولة", quantity: 1, unitPrice: 10, amount: 10, vat: true }], total: 11.5,
  }));
  await step("approve_commission_credit", () => env.billing.approve(user, String(ccn.id), {}));

  const crn: any = await step("create_credit", () => env.billing.create(user, {
    type: "credit", billingReference: inv.number, issueDate: "2026-03-28",
    items: [{ description: "خصم", quantity: 1, unitPrice: 100, amount: 100, vat: true }], total: 115,
  }));
  run.ids.crn = crn.id;
  await step("approve_credit", () => env.billing.approve(user, String(crn.id), {}));
  await step("collect_invoice", () => env.billing.collect(user, String(inv.id), { amount: 600, paidDate: "2026-04-02", method: "cash" }));

  const dep: any = await step("collect_deposit_c2", () => env.contracts.collectDeposit(user, String(c2.id), { paidDate: "2026-01-02", method: "cash" }));
  run.ids.depC2 = dep?.voucher?.id;
  const rv: any = await step("deposit_voucher", () => env.billing.createReceiptVoucher(user, { kind: "deposit", contractId: c2.id, amount: 1000, paidDate: "2026-01-05" }));
  run.ids.depRv = rv.id;
  const rv2: any = await step("receipt_voucher_fifo", () => env.billing.createReceiptVoucher(user, { contractId: c2.id, amount: 6500, paidDate: "2026-01-10", countAsCollection: true }));
  run.ids.rv2 = rv2.id;

  const e1: any = await step("expense_landlord", () => env.reports.createExpense(user, { ownerId: s.agent, propertyId: s.propA, category: "صيانة", amount: 200, expenseDate: "2026-03-10" }));
  run.ids.e1 = e1.id;
  const e2: any = await step("expense_company", () => env.reports.createExpense(user, { ownerId: s.holder, propertyId: s.propH, category: "كهرباء", amount: 115, expenseDate: "not a date" }));
  run.ids.e2 = e2.id;
  await step("expense_delete", () => env.reports.deleteExpense(user, String(e1.id)));
  const po: any = await step("payout", () => env.reports.createPayout(user, { ownerId: s.agent, amount: 300, transferDate: "2026-03-15", method: "bank_transfer" }));
  run.ids.po = po.id;
  const po2: any = await step("payout_2", () => env.reports.createPayout(user, { ownerId: s.agent, amount: 50, transferDate: "2026-03-16" }));
  await step("payout_delete", () => env.reports.deletePayout(user, String(po2.id)));

  await step("patch_payment_status", () => env.payments.update(user, String(run.ids.p5), { status: "paid" }));
  await step("patch_payment_notes", () => env.payments.update(user, String(run.ids.p5), { notes: "synthetic note" }));
  await step("post_payment_bad_amount", () => env.payments.create(user, { contractId: c2.id, amount: "100.555", dueDate: "2026-12-15" }));
  const np: any = await step("post_payment_paid", () => env.payments.create(user, { contractId: c2.id, amount: "100.50", dueDate: "2026-12-15", status: "paid", paidDate: "2026-12-01", receiptNumber: "X-1" }));
  run.ids.np = np?.id;

  await step("tick_0510", () => tick("2026-05-10"));
  await step("settle_external_p6", () => env.payments.settleExternal(user, String(run.ids.p6)));
  await step("tick_0610", () => tick("2026-06-10"));
  await step("tick_0611", () => tick("2026-06-11"));
  await step("revert_external_p6", () => env.payments.revertExternal(user, String(run.ids.p6)));
  await step("settle_again_p6", () => env.payments.settleExternal(user, String(run.ids.p6)));

  await step("regenerate_c3", () => env.contracts.generateInstallments(user, String(c3.id), {}));
  await step("rebuild_c3", () => env.contracts.update(user, String(c3.id), {
    rebuild: true, unitIds: [s.unitA2], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: "2026-01-01", endDate: "2026-06-30",
    monthlyRent: "600", paymentFrequency: "monthly", vatEnabled: false,
  }));

  await step("terminate_c1_paid", () => env.contracts.terminate(user, String(c1.id), { mode: "paid" }));
  await step("terminate_c1", () => env.contracts.terminate(user, String(c1.id), { mode: "cancelled", deposit: "refund", advance: "refund" }));
  await step("terminate_c2_revenue", () => env.contracts.terminate(user, String(c2.id), { deposit: "revenue" }));
  const c4: any = await step("create_c4", () => env.contracts.create(user, {
    unitIds: [s.unitH1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: "2026-07-01", endDate: "2026-12-31",
    monthlyRent: "2000", paymentFrequency: "monthly", vatEnabled: false, depositAmount: "2000", depositStatus: "collected", depositDueDate: "2026-07-01",
  }));
  run.ids.c4 = c4.id;
  await step("terminate_c4_forfeit", () => env.contracts.terminate(user, String(c4.id), { deposit: "forfeit" }));
  await step("delete_c3_paid", () => env.contracts.remove(user, String(c3.id), "paid"));
  await step("delete_c3", () => env.contracts.remove(user, String(c3.id), "cancelled"));
  await step("tick_final", () => tick("2026-06-12"));
  return run;
}

describe("finance v2 hooks on the real legacy routes (real Postgres)", { skip: fv2DbSkip }, () => {
  let on: LegacyEnv, off: LegacyEnv, bare: LegacyEnv;
  let rOn: Run, rOff: Run, rBare: Run;
  let sOn: Seed;

  before(async () => {
    [on, off, bare] = [await legacyEnv("wired"), await legacyEnv("wired"), await legacyEnv("none")];
    sOn = await seedAccount(on, U);
    const sOff = await seedAccount(off, U);
    const sBare = await seedAccount(bare, U);
    await enableV2(on, U, "manager");
    rOn = await scenario(on, sOn);
    rOff = await scenario(off, sOff);
    rBare = await scenario(bare, sBare);
  });

  after(async () => {
    for (const e of [on, off, bare]) await e?.t.drop();
  });

  const ev = (step: string) => rOn.events.get(step) ?? [];
  const keys = (step: string) => ev(step).map((e) => `${e.source_type},${e.event},${e.rule ?? "-"}`).sort();
  const status = (step: string) => (rOn.results.find((r) => r.step === step)?.out as any)?.status;
  const outOf = (r: Run, step: string) => r.results.find((x) => x.step === step)?.out as any;

  // ── Flag off ──────────────────────────────────────────────────────────────

  it("flag off: every response equals the code with no finance-v2 line at all", () => {
    assert.equal(rOff.results.length, rBare.results.length);
    for (let i = 0; i < rOff.results.length; i++) {
      assert.deepEqual(rOff.results[i], rBare.results[i], `step ${rOff.results[i].step}`);
    }
  });

  it("flag off: no outbox row and no v2 side-table row is written", async () => {
    for (const table of ["ledger_outbox", "finance_contract_dims", "finance_collection_meta", "finance_ejar_settlements", "journal_entries", "finance_installment_charges"]) {
      const [r] = await off.q(`select count(*)::int as n from ${table}`);
      assert.equal(r.n, 0, table);
    }
  });

  it("flag off: legacy behaviours v2 refuses still happen (mark as paid, status PATCH, paid POST)", () => {
    assert.equal(outOf(rOff, "terminate_c1_paid")?.success, true);
    assert.equal(outOf(rOff, "patch_payment_status")?.status, "paid");
    assert.equal(outOf(rOff, "post_payment_paid")?.status, "paid");
    assert.equal(outOf(rOff, "delete_c3_paid")?.success, true);
  });

  // ── Flag on: enqueue per hook ────────────────────────────────────────────

  it("contract create: dims captured; advance collections E03 + E34; deposit voucher E09 (in the create transaction)", async () => {
    assert.deepEqual(keys("create_c1"), [
      "payment_collection,advance_vat,E34", "payment_collection,advance_vat,E34",
      "payment_collection,collected,E03", "payment_collection,collected,E03",
      "simple_invoice,deposit_received,E09",
    ]);
    const e09 = ev("create_c1").find((e) => e.rule === "E09")!;
    assert.equal(e09.payload.facts.amount, "5000.00");
    assert.equal(e09.payload.facts.date, "2026-01-01");
    const e03 = ev("create_c1").filter((e) => e.rule === "E03");
    assert.deepEqual(e03.map((e) => e.payload.facts.amount).sort(), ["1150.00", "1150.00"]);
    assert.equal(e03[0].payload.facts.treatment, "agent");
    assert.equal(e03[0].payload.facts.dims.ownerId, sOn.agent);
    assert.equal(e03[0].payload.facts.dims.propertyId, sOn.propA);
    assert.equal(e03[0].payload.facts.category, "S");
    const [dims] = await on.q(`select owner_id, property_id, unit_ids from finance_contract_dims where contract_id = $1`, [rOn.ids.c1]);
    assert.deepEqual([dims.owner_id, dims.property_id, dims.unit_ids], [sOn.agent, sOn.propA, [sOn.unitA1]]);
    assert.deepEqual(keys("create_c2"), []);
    const [d2] = await on.q(`select owner_id from finance_contract_dims where contract_id = $1`, [rOn.ids.c2]);
    assert.equal(d2.owner_id, sOn.holder);
  });

  it("installment collection: E03 + E34 with the installment, inside its transaction", () => {
    assert.deepEqual(keys("collect_installment"), ["payment_collection,advance_vat,E34", "payment_collection,collected,E03"]);
    const f = ev("collect_installment")[0].payload;
    assert.deepEqual(f.paymentIds, [rOn.ids.p3]);
    assert.equal(f.facts.amount, "500.00");
    assert.equal(f.facts.bank.method, "cash");
  });

  it("invoice approve: E01 with its own groups and coverage; draft and the paired commission draft post nothing", () => {
    assert.deepEqual(keys("create_invoice"), []);
    assert.deepEqual(keys("approve_invoice"), ["simple_invoice,confirmed,E01"]);
    const p = ev("approve_invoice")[0].payload;
    assert.deepEqual(p.paymentIds, [rOn.ids.p4]);
    assert.deepEqual(p.facts.groups, [{ category: "S", rate: 15, net: "1000.00", vat: "150.00", nature: "rent", usage: null }]);
    assert.deepEqual(p.facts.coverage, [{ paymentId: rOn.ids.p4, amount: "1150.00" }]);
    assert.equal(p.facts.date, "2026-03-25");
    assert.ok(rOn.ids.com, "the commission draft was created");
  });

  it("commission approve: E15; credit note approve: E06 covering the original invoice's installments", () => {
    assert.deepEqual(keys("approve_commission"), ["simple_invoice,confirmed,E15"]);
    assert.deepEqual(keys("create_credit"), []);
    assert.deepEqual(keys("approve_credit"), ["simple_invoice,confirmed,E06"]);
    const p = ev("approve_credit")[0].payload;
    assert.deepEqual(p.facts.coverage, [{ paymentId: rOn.ids.p4, amount: "1150.00" }]);
    assert.equal(p.facts.groups[0].vat, "15.00");
  });

  it("commission collect: E16 (deduction by default, skipped at post); commission credit note: E36", () => {
    assert.deepEqual(keys("collect_commission"), ["payment_collection,collected,E16"]);
    assert.equal(ev("collect_commission")[0].payload.facts.cls, "commission_deduction");
    assert.deepEqual(keys("approve_commission_credit"), ["simple_invoice,confirmed,E36"]);
  });

  it("invoice collect: only this transaction's collection(s), E03 (+E34)", () => {
    assert.deepEqual(keys("collect_invoice"), ["payment_collection,advance_vat,E34", "payment_collection,collected,E03"]);
    assert.equal(ev("collect_invoice").find((e) => e.rule === "E03")!.payload.facts.amount, "600.00");
  });

  it("deposits: collect-deposit E09; standalone deposit voucher E09; FIFO receipt voucher E03 per collection (no E34 off-S)", () => {
    assert.deepEqual(keys("collect_deposit_c2"), ["simple_invoice,deposit_received,E09"]);
    assert.equal(ev("collect_deposit_c2")[0].payload.facts.amount, "3000.00");
    assert.equal(ev("collect_deposit_c2")[0].payload.facts.treatment, "principal");
    assert.deepEqual(keys("deposit_voucher"), ["simple_invoice,deposit_received,E09"]);
    assert.equal(ev("deposit_voucher")[0].payload.facts.amount, "1000.00");
    assert.deepEqual(keys("receipt_voucher_fifo"), ["payment_collection,collected,E03", "payment_collection,collected,E03"]);
    assert.deepEqual(ev("receipt_voucher_fifo").map((e) => e.payload.facts.amount), ["6000.00", "500.00"]);
  });

  it("expenses and payouts: E18 rev:1 and its reversal on delete; E19 and its reversal", () => {
    assert.deepEqual(keys("expense_landlord"), ["expense,rev:1,E18"]);
    const f = ev("expense_landlord")[0].payload.facts;
    assert.deepEqual([f.chargeTo, f.treatment, f.gross, f.vat, f.date], ["landlord", "agent", "200.00", "0.00", "2026-03-10"]);
    const g = ev("expense_company")[0].payload.facts;
    assert.deepEqual([g.chargeTo, g.treatment], ["company", "principal"]);
    assert.ok(g.warnings.includes("inferred_date"));
    assert.deepEqual(keys("expense_delete"), ["expense,reversal:rev:1,-"]);
    assert.deepEqual(keys("payout"), ["landlord_payout,created,E19"]);
    assert.equal(ev("payout")[0].payload.facts.date, "2026-03-15");
    assert.deepEqual(keys("payout_delete"), ["landlord_payout,reversal:created,-"]);
  });

  it("PATCH /payments: money fields refused (400 FINANCE_V2_FIELD_LOCKED), notes pass", () => {
    assert.equal(status("patch_payment_status"), 400);
    assert.equal((outOf(rOn, "patch_payment_status").body as any).error, "FINANCE_V2_FIELD_LOCKED");
    assert.equal(outOf(rOn, "patch_payment_notes")?.notes, "synthetic note");
  });

  it("POST /payments: amount validated; status forced pending, paidDate and receipt ignored", () => {
    assert.equal(status("post_payment_bad_amount"), 400);
    const np = outOf(rOn, "post_payment_paid");
    assert.deepEqual([np.status, np.paidDate, np.receiptNumber, np.amount], ["pending", null, null, "100.50"]);
  });

  it("recognizer: E02 for installments past due and uncovered (not the invoiced one, not deposits); releases only for principal rent", () => {
    const k = keys("tick_0510");
    const charges = ev("tick_0510").filter((e) => e.rule === "E02");
    assert.ok(charges.every((e) => e.origin === "recognizer"));
    const charged = new Set(charges.map((e) => e.source_id));
    for (const p of ["p1", "p3", "p5"]) assert.ok(charged.has(rOn.ids[p]), `${p} charged`);
    assert.ok(!charged.has(rOn.ids.p4), "the invoiced installment is charged by its document");
    assert.ok(!charged.has(rOn.ids.p6), "not yet due");
    assert.ok(k.every((x) => !x.startsWith("payment,settled_external")));
  });

  it("settle-external: E33 once the installment is charged; revert reverses it; a second settle is refused (409)", () => {
    assert.deepEqual(keys("settle_external_p6"), [], "not charged yet: the recognizer settles it later");
    assert.ok(ev("tick_0610").some((e) => e.rule === "E02" && e.source_id === rOn.ids.p6));
    assert.deepEqual(ev("tick_0611").filter((e) => e.source_id === rOn.ids.p6).map((e) => `${e.event},${e.rule}`), ["settled_external,E33"]);
    assert.deepEqual(keys("revert_external_p6"), ["payment,reversal:settled_external,-"]);
    assert.equal(status("settle_again_p6"), 409);
  });

  it("generate-installments: 409 when a row it would delete is charged", () => {
    assert.equal(status("regenerate_c3"), 409);
    assert.equal(outOf(rOff, "regenerate_c3")?.success, true);
  });

  it("rebuild: reversal of every live event of the destroyed installments, before the deletes", () => {
    const k = ev("rebuild_c3");
    assert.ok(k.length > 0);
    assert.ok(k.every((e) => e.source_type === "payment" && e.event === "reversal:charge"), JSON.stringify(k.map((e) => e.event)));
    assert.ok(k.every((e) => e.payload.facts.snapshot?.t === "payment"));
  });

  it("terminate / DELETE with mode paid: 409 FINANCE_V2_MARK_PAID_REFUSED and nothing written", async () => {
    assert.equal(status("terminate_c1_paid"), 409);
    assert.equal((outOf(rOn, "terminate_c1_paid").body as any).error, "FINANCE_V2_MARK_PAID_REFUSED");
    assert.deepEqual(keys("terminate_c1_paid"), []);
    assert.equal(status("delete_c3_paid"), 409);
  });

  it("terminate: refunds E04 (+E34 reversal part), deposit refund E10, E05 per cancelled installment, ended_on", async () => {
    const k = ev("terminate_c1");
    assert.ok(k.some((e) => e.rule === "E04" && e.payload.facts.amount === "-1150.00"));
    assert.ok(k.some((e) => e.rule === "E10" && e.payload.facts.amount === "5000.00" && e.event === "deposit_refunded"));
    const e05 = k.filter((e) => e.rule === "E05").map((e) => e.source_id);
    for (const p of ["p5", "p6"]) assert.ok(e05.includes(rOn.ids[p]), `${p} charge_cancelled`);
    const [d] = await on.q(`select to_char(ended_on,'YYYY-MM-DD') as e from finance_contract_dims where contract_id = $1`, [rOn.ids.c1]);
    assert.match(d.e, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("terminate: deposit to revenue E12 (classified by meta); forfeit E11 for the held deposit", async () => {
    const conv = ev("terminate_c2_revenue").filter((e) => e.rule === "E12");
    assert.equal(conv.length, 2);
    assert.ok(conv.every((e) => e.event === "deposit_converted"));
    const [m] = await on.q(`select count(*)::int as n from finance_collection_meta where classification = 'deposit_conversion'`);
    assert.equal(m.n, 2);
    assert.deepEqual(keys("terminate_c4_forfeit"), ["contract,deposit_forfeited,E11"]);
    assert.equal(ev("terminate_c4_forfeit")[0].payload.facts.amount, "2000.00");
    assert.ok(ev("delete_c3").every((e) => e.rule === "E05"));
  });

  it("end to end: the worker posts every event; nothing fails; the agent mirror holds (1122 = −2122)", async () => {
    const failed = await on.q(`select source_type, source_id, event, last_error_code, last_error from ledger_outbox where status in ('failed') or (status = 'pending' and attempts > 0)`);
    assert.deepEqual(failed, []);
    const pending = await on.q(`select count(*)::int as n from ledger_outbox where status = 'pending'`);
    assert.equal(pending[0].n, 0);
    const [m] = await on.q(
      `select coalesce(sum(case when a.system_key = 'tenant_receivable_agency' then l.debit - l.credit else 0 end), 0)::text as ar,
              coalesce(sum(case when a.system_key = 'landlord_payable_uncollected' then l.credit - l.debit else 0 end), 0)::text as lpu,
              coalesce(sum(l.debit - l.credit), 0)::text as tb
         from journal_lines l join accounts a on a.id = l.account_id where l.user_id = $1`, [U]);
    assert.equal(m.tb, "0.00");
    assert.equal(m.ar, m.lpu);
    const [n] = await on.q(`select count(*)::int as n from journal_entries where user_id = $1`, [U]);
    assert.ok(n.n > 20);
  });

  it("Ejar attach under v2: paid → settled_external (+ reported), partial stays pending (+ reported), nothing becomes paid", async () => {
    const [c] = await on.q(`insert into contracts (user_id, contract_number, tenant_name, start_date, end_date, monthly_rent) values ($1, 'EJ-1', 'T', '2026-01-01', '2026-03-31', '1000') returning id`, [U]);
    const rows = [];
    for (const due of ["2026-01-01", "2026-02-01", "2026-03-01"]) {
      rows.push((await on.q(`insert into payments (user_id, contract_id, amount, due_date) values ($1, $2, '1000', $3) returning id, to_char(due_date,'YYYY-MM-DD') as "dueDate"`, [U, c.id, due]))[0]);
    }
    await on.hooks.ejarAttachV2({ fv2: true, userId: U }, rows, [
      { number: "E1", dueDate: "2026-01-01", status: "paid", amount: "1000", remaining: "0" },
      { number: "E2", dueDate: "2026-02-01", status: "overdue", amount: "1000", remaining: "400" },
      { number: "E3", dueDate: "2026-03-01", status: "unpaid", amount: "1000", remaining: "1000" },
    ]);
    const got = await on.q(`select status::text as s, receipt_number, to_char(paid_date,'YYYY-MM-DD') as pd from payments where contract_id = $1 order by due_date`, [c.id]);
    assert.deepEqual(got.map((r: any) => r.s), ["settled_external", "pending", "pending"]);
    assert.equal(got[0].pd, "2026-01-01");
    assert.deepEqual(got.map((r: any) => r.receipt_number), ["E1", "E2", "E3"]);
    const rep = await on.q(`select reported_status, reported_amount::text as a from finance_ejar_settlements where user_id = $1 order by payment_id`, [U]);
    assert.deepEqual(rep.map((r: any) => [r.reported_status, r.a]), [["paid", "1000.00"], ["partially_paid", "600.00"]]);
    // Flag off: the v2 attach is a no-op (the legacy attach runs instead, in the handler).
    await on.hooks.ejarAttachV2({ fv2: false, userId: U }, rows, [{ number: "Z", dueDate: "2026-03-01", status: "paid", amount: "1000", remaining: "0" }]);
    const [p3] = await on.q(`select status::text as s from payments where id = $1`, [rows[2].id]);
    assert.equal(p3.s, "pending");
  });

  it("hooks never throw into the caller: a broken outbox is swallowed and the flag-off hook is a no-op", async () => {
    const [p] = await on.q(`select id from payments where contract_id = $1 and status = 'pending' and deleted_at is null order by due_date limit 1`, [rOn.ids.c4]);
    await on.q(`alter table ledger_outbox rename to ledger_outbox_x`);
    try {
      await on.hooks.expenseCreated({ fv2: true, userId: U }, rOn.ids.e2);
      await on.hooks.documentConfirmed({ fv2: true, userId: U }, rOn.ids.inv);
      // Inside a source transaction: the failed enqueue rolls back only its savepoint; the collection commits.
      const res: any = await on.payments.addCollection(userOf(U), String(p.id), { amount: "10", collectedDate: "2026-08-02" });
      assert.equal(res.collection.amount, "10.00");
      const [c] = await on.q(`select count(*)::int as n from payment_collections where id = $1`, [res.collection.id]);
      assert.equal(c.n, 1);
    } finally {
      await on.q(`alter table ledger_outbox_x rename to ledger_outbox`);
    }
    await on.hooks.expenseCreated({ fv2: false, userId: U }, 999_999);
  });

  it("first enable captures dims for existing contracts (ended ones get ended_on)", async () => {
    const V = 5103;
    const s = await seedAccount(on, V);
    const mk = async (status: string) => {
      const [c] = await on.q(`insert into contracts (user_id, contract_number, tenant_name, start_date, end_date, monthly_rent, status, tenant_id)
                                values ($1, $2, 'T', '2026-01-01', '2026-12-31', '1000', $3, $4) returning id`, [V, `C-${status}`, status, s.tenant]);
      await on.q(`insert into contract_units (contract_id, unit_id) values ($1, $2)`, [c.id, status === "active" ? s.unitH1 : s.unitA1]);
      return c.id;
    };
    const active = await mk("active");
    const ended = await mk("terminated");
    await enableV2(on, V, "manager");
    const rows = await on.q(`select contract_id, owner_id, property_id, ended_on is not null as ended from finance_contract_dims where user_id = $1 order by contract_id`, [V]);
    assert.deepEqual(rows.map((r: any) => [r.contract_id, r.owner_id, r.property_id, r.ended]), [
      [active, s.holder, s.propH, false], [ended, s.agent, s.propA, true],
    ]);
  });

  it("admin purge: removes every v2 row of the account; unknown function is ignored", async () => {
    const OTHER = 5102;
    await on.q(`insert into finance_contract_dims (contract_id, user_id) values (999999, $1)`, [OTHER]);
    await on.hooks.purgeAccount(OTHER);
    const [r] = await on.q(`select count(*)::int as n from finance_contract_dims where user_id = $1`, [OTHER]);
    assert.equal(r.n, 0);
    const [mine] = await on.q(`select count(*)::int as n from journal_entries where user_id = $1`, [U]);
    assert.ok(mine.n > 0, "other accounts untouched");
  });
});
