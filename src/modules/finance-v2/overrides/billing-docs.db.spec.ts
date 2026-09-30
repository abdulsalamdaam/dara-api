import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "../__tests__/legacy-env";
import { riyadhToday } from "../dates";
import { VatReportService } from "../reports/vat-report.service";
import { ArAgingService } from "../reports/aging.service";
import { ReconciliationService } from "../reports/reconciliation.service";
import { legacyAccountingFor } from "../reports/legacy-accounting";

/**
 * How billing documents post: who the seller is, which revenue account, which
 * VAT category (staging test run 30 Sep 2026, fix list items 4, 5, 6, 10).
 * Real legacy routes with the v2 hooks, on a throwaway Postgres; synthetic
 * data only (public repo). ZATCA is stubbed by the harness.
 *
 *  - An external-customer free invoice is the account's own sale (principal,
 *    seller 'account'): own AR, 4140, output VAT in the account's return; its
 *    collection clears 1121. Never 1122/2122/2121 for a landlord of nobody.
 *  - A no-VAT line is booked as the document states it (E for a registered
 *    seller), not defaulted to out of scope.
 *  - Non-rent lines (free invoice, debit note) go to 4140, not rent.
 *  - Commission / agency-fee documents carry VAT only when the account is
 *    registered and linked, and a VAT-bearing one is never approved (§9 E8).
 *  - AR aging names the external customer.
 */
const M = 5401; // manager mode, the account holder linked to ZATCA
const N = 5402; // manager mode, nobody but the agent landlord linked
const O = 5403; // owner mode, the account holder linked
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
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "contracts.view", "contracts.write"];
const userFor = (u: number) => ({ ...userOf(u), permissions: PERMS });
const vatPeriod = `${today.slice(0, 4)}-Q${Math.ceil(Number(today.slice(5, 7)) / 3)}`;

/** An external customer typed onto the document (no tenant, no landlord record). */
const customer = (name: string, idNumber: string) => ({
  name, type: "individual", email: `${idNumber}@example.test`, phone: "0500000009", idNumber,
});

/** The dummy sandbox credentials the seed gives the agent, copied to the account holder (ZATCA itself is stubbed). */
async function linkHolder(env: LegacyEnv, u: number, s: Seed) {
  await env.q(
    `insert into zatca_credentials (user_id, owner_id, active_environment, seller_name, seller_vat_number, seller_street, seller_building_no,
       seller_district, seller_city, seller_postal_zone, serial_number, organization_identifier, organization_unit_name, location_address,
       industry_category, common_name, sandbox_private_key_enc, sandbox_binary_security_token, sandbox_secret_enc, sandbox_cert_pem)
     select user_id, $2, active_environment, 'Synthetic Holder', '310000000000003', seller_street, seller_building_no, seller_district, seller_city,
       seller_postal_zone, serial_number, '310000000000003', organization_unit_name, location_address, industry_category, common_name,
       sandbox_private_key_enc, sandbox_binary_security_token, sandbox_secret_enc, sandbox_cert_pem
       from zatca_credentials where user_id = $1 and owner_id = $3`, [u, s.holder, s.agent]);
}

async function drain(env: LegacyEnv, u: number) {
  await env.recognizer.runAccount(u);
  for (let i = 0; i < 10; i++) {
    const r = await env.worker.runAccount(u);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

async function entry(env: LegacyEnv, u: number, sourceType: string, sourceId: number, event: string) {
  const lines = await env.q(
    `select a.code, l.debit::text as debit, l.credit::text as credit, l.vat_category, l.tax_role, l.vat_base::text as base, l.seller_key, l.owner_id
       from ledger_outbox o join journal_entries e on e.id = o.entry_id join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
      where o.user_id = $1 and o.source_type = $2 and o.source_id = $3 and o.event = $4 order by l.line_no`,
    [u, sourceType, sourceId, event],
  );
  const [o] = await env.q(
    `select o.status, o.skip_reason, e.warnings from ledger_outbox o left join journal_entries e on e.id = o.entry_id
      where o.user_id = $1 and o.source_type = $2 and o.source_id = $3 and o.event = $4`, [u, sourceType, sourceId, event]);
  return { lines, status: o?.status ?? null, warnings: (o?.warnings ?? []) as string[] };
}
const codes = (lines: any[]) => lines.map((l) => [l.code, l.debit, l.credit]);

describe("fv2 billing documents: seller, revenue account and VAT category (real Postgres, real legacy routes)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let sM: Seed, sN: Seed, sO: Seed;
  let vat: VatReportService, aging: ArAgingService, rec: ReconciliationService;

  const freeInvoice = async (u: number, items: any[], total: number, client = customer("Synthetic Customer X", "1000054011")) => {
    const doc: any = await env.billing.create(userFor(u), { type: "invoice", issueDate: today, client, items, total });
    const ap: any = await env.billing.approve(userFor(u), String(doc.id), { confirmations: { tenantNoVat: true } });
    await drain(env, u);
    return ap;
  };

  before(async () => {
    env = await legacyEnv("wired");
    sM = await seedAccount(env, M);
    await linkHolder(env, M, sM);
    await enableV2(env, M, "manager");
    sN = await seedAccount(env, N);
    await enableV2(env, N, "manager");
    sO = await seedAccount(env, O);
    await linkHolder(env, O, sO);
    await env.q(`update owners set is_account_holder = true, tax_number = '310000000000003' where user_id = $1`, [O]); // owner mode: one legal person
    await enableV2(env, O, "owner");
    vat = new VatReportService(env.t.pool as any);
    aging = new ArAgingService(env.t.pool as any);
    rec = new ReconciliationService(env.t.pool as any, legacyAccountingFor(env.db));
  });
  after(async () => { await env?.t.drop(); });

  // ── Fix list 4: the external customer's invoice is the account's own sale ──
  it("manager: an external-customer invoice posts own AR, other income 4140 and output VAT under seller 'account' (not 1122/2122 for nobody)", async () => {
    const inv = await freeInvoice(M, [{ description: "خدمة استشارية", quantity: 1, unitPrice: 1000, amount: 1000, vat: true }], 1150);
    const e = await entry(env, M, "simple_invoice", inv.id, "confirmed");
    assert.equal(e.status, "posted");
    assert.deepEqual(codes(e.lines), [["1121", "1150.00", "0.00"], ["4140", "0.00", "1000.00"], ["2151", "0.00", "150.00"]]);
    assert.ok(e.lines.every((l: any) => l.owner_id == null), "no landlord dimension");
    const v = e.lines.find((l: any) => l.code === "2151");
    assert.deepEqual([v.seller_key, v.tax_role, v.vat_category, v.base], ["account", "output", "S", "1000.00"]);
    assert.ok(!e.warnings.includes("landlord_unresolved") && !e.warnings.includes("no_coverage_window"), JSON.stringify(e.warnings));

    // Its collection clears the account's own AR; nothing reaches the landlord payable.
    await env.billing.collect(userFor(M), String(inv.id), { method: "cash", paidDate: today });
    await drain(env, M);
    const [pc] = await env.q(`select id from payment_collections where invoice_id = $1`, [inv.id]);
    assert.deepEqual(codes((await entry(env, M, "payment_collection", pc.id, "collected")).lines), [["1111", "1150.00", "0.00"], ["1121", "0.00", "1150.00"]]);
    const [lp] = await env.q(
      `select count(*)::int as n from journal_lines l join accounts a on a.id = l.account_id
        where l.user_id = $1 and a.code in ('1122','2121','2122')`, [M]);
    assert.equal(lp.n, 0, "no agent money for a landlord of nobody");
  });

  it("a no-VAT line is booked as the document states it: exempt (E) for the registered account, in box 5, not out of scope", async () => {
    const inv = await freeInvoice(M, [{ description: "خدمة إدارية", quantity: 1, unitPrice: 100, amount: 100, vat: false }], 100,
      customer("Synthetic Customer Y", "1000054012"));
    const e = await entry(env, M, "simple_invoice", inv.id, "confirmed");
    assert.deepEqual(codes(e.lines), [["1121", "100.00", "0.00"], ["4140", "0.00", "100.00"]]);
    const rev = e.lines.find((l: any) => l.code === "4140");
    assert.deepEqual([rev.vat_category, rev.tax_role, rev.base, rev.seller_key], ["E", "output", "100.00", "account"]);
  });

  it("the account's VAT return carries the free invoices (box 1 and box 5), and its document cross-check lists them with no difference", async () => {
    const r: any = await vat.vatReturn(M, { period: vatPeriod });
    const box = (n: number) => r.boxes.find((b: any) => b.box === n);
    assert.deepEqual([box(1).amount, box(1).vat], ["1000.00", "150.00"]);
    assert.equal(box(5).amount, "100.00");
    const docs = r.documentCheck.rows;
    assert.equal(docs.length, 2);
    assert.ok(docs.every((d: any) => d.difference === "0.00" && d.explanation == null), JSON.stringify(docs));
    assert.deepEqual(r.documentCheck.unposted, []);
  });

  it("AR aging names the external customer from the document (no nameless row)", async () => {
    const a: any = await aging.arAging(M, { asOf: today });
    const row = a.rows.find((x: any) => x.open !== "0.00" && x.tenantId == null);
    assert.ok(row, "the open free invoice is on the aging");
    assert.equal(row.tenantName, "Synthetic Customer Y");
    assert.equal(row.customerName, "Synthetic Customer Y");
    assert.equal(row.open, "100.00");
    assert.ok(a.rows.every((x: any) => x.tenantName != null), JSON.stringify(a.rows.map((x: any) => x.tenantName)));
    assert.equal(a.reconciliation.balanced, true);
  });

  it("reconciliation: R3 (landlord payable) is untouched by external-customer documents; R1 and R5 stay ok", async () => {
    const r: any = await rec.reconciliation(M, { asOf: today, lang: "en" });
    const c = (id: string) => r.checks.find((x: any) => x.id === id);
    assert.equal(c("R3").ledger, "0.00");
    assert.ok(!c("R3").rows.some((x: any) => x.ownerId == null), JSON.stringify(c("R3").rows));
    assert.equal(c("R1").status, "ok", JSON.stringify(c("R1")));
    assert.equal(c("R5").status, "ok", JSON.stringify(c("R5")));
  });

  it("the account's VAT cross-check flags VAT booked under an unresolved seller (seller_unresolved), which no return carries", async () => {
    // What a free invoice posted before this fix looks like: agent, owner:unresolved.
    const [d] = await env.q(
      `insert into simple_invoices (user_id, number, type, status, subtotal, total, issue_date, items, client, confirmed_at)
       values ($1, 'INV-SYN-OLD', 'invoice', 'confirmed', 1000, 1150, $2, '[]', '{"name":"Synthetic Old Customer"}', now()) returning id`, [M, today]);
    await env.emitter.emit({ fv2: true, userId: M }, {
      sourceType: "simple_invoice", sourceId: d.id, event: "confirmed", occurredOn: today,
      payload: { rule: "E01", facts: {
        date: today, treatment: "agent", warnings: ["landlord_unresolved"], documentId: d.id, coverage: [], deferRent: true,
        dims: { ownerId: null, propertyId: null, unitId: null, tenantId: null, contractId: null },
        groups: [{ category: "S", rate: 15, net: "1000.00", vat: "150.00", nature: "rent" }],
      } },
    });
    await drain(env, M);
    const r: any = await vat.vatReturn(M, { period: vatPeriod });
    const row = r.documentCheck.rows.find((x: any) => x.number === "INV-SYN-OLD");
    assert.ok(row, "listed on the account's return");
    assert.deepEqual([row.documentVat, Number(row.ledgerVat), row.difference, row.explanation], ["150.00", 0, "150.00", "seller_unresolved"]);
    // Leave the ledger as it was for the tests below.
    await env.q(`update simple_invoices set deleted_at = now() where id = $1`, [d.id]);
  });

  // ── Fix list 6: non-rent lines are not rent ──
  it("a debit note's extra claim on a rent invoice is other income (4140), never deferred into 2131 as rent", async () => {
    const c: any = await env.contracts.create(userFor(M), {
      unitIds: [sM.unitH1], tenantId: sM.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(0), endDate: lastOf(11),
      monthlyRent: "2000", paymentFrequency: "monthly", vatEnabled: true,
    });
    const [p1] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date limit 1`, [c.id]);
    const inv: any = await env.billing.create(userFor(M), {
      type: "invoice", paymentIds: [p1.id], issueDate: today,
      items: [{ description: "إيجار", quantity: 1, unitPrice: 2000, amount: 2000, vat: true }], total: 2300,
    });
    await env.billing.approve(userFor(M), String(inv.id), { confirmations: { tenantNoVat: true } });
    const dbn: any = await env.billing.create(userFor(M), {
      type: "debit", billingReference: inv.number, issueDate: today,
      items: [{ description: "مطالبة إضافية", quantity: 1, unitPrice: 200, amount: 200, vat: true }], total: 230,
    });
    await env.billing.approve(userFor(M), String(dbn.id), {});
    await drain(env, M);
    const e = await entry(env, M, "simple_invoice", dbn.id, "confirmed");
    assert.deepEqual(codes(e.lines), [["1121", "230.00", "0.00"], ["4140", "0.00", "200.00"], ["2151", "0.00", "30.00"]]);
    // The rent invoice itself is still deferred rent.
    assert.ok((await entry(env, M, "simple_invoice", inv.id, "confirmed")).lines.some((l: any) => l.code === "2131"));
  });

  // ── Fix list 5: commission / agency-fee VAT that never reaches ZATCA ──
  it("linked account: the commission is S-rated, and approving it is refused (never reported to ZATCA); nothing posts", async () => {
    const c: any = await env.contracts.create(userFor(M), {
      unitIds: [sM.unitA1], tenantId: sM.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(0), endDate: lastOf(11),
      monthlyRent: "6000", paymentFrequency: "monthly", vatEnabled: true,
    });
    const [p1] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date limit 1`, [c.id]);
    const inv: any = await env.billing.create(userFor(M), {
      type: "invoice", paymentIds: [p1.id], issueDate: today,
      items: [{ description: "إيجار", quantity: 1, unitPrice: 6000, amount: 6000, vat: true }], total: 6900,
    });
    const ap: any = await env.billing.approve(userFor(M), String(inv.id), { confirmations: { tenantNoVat: true } });
    assert.deepEqual([ap.commission?.subtotal, ap.commission?.total], ["300.00", "345.00"]);
    const r: any = await attempt(() => env.billing.approve(userFor(M), String(ap.commission.id), {}));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "FINANCE_V2_TAX_DOC_NOT_REPORTABLE");
    const [st] = await env.q(`select status::text as status from simple_invoices where id = $1`, [ap.commission.id]);
    assert.equal(st.status, "draft");
    await drain(env, M);
    const [n] = await env.q(`select count(*)::int as n from ledger_outbox where user_id = $1 and source_id = $2 and source_type = 'simple_invoice'`, [M, ap.commission.id]);
    assert.equal(n.n, 0);
  });

  it("linked account: a VAT-bearing agency fee is refused (pinned); unlinked account: the AGF prints without VAT and approves with no 2151", async () => {
    const mk = async (u: number, s: Seed, unit: number) => {
      const c: any = await env.contracts.create(userFor(u), {
        unitIds: [unit], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(1), endDate: lastOf(12),
        monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false, agencyFee: "2500",
      });
      const [d] = await env.q(`select id, subtotal::text as subtotal, total::text as total, items from simple_invoices where contract_id = $1 and kind = 'agency_fee'`, [c.id]);
      return d;
    };
    const linked = await mk(M, sM, sM.unitA2);
    assert.deepEqual([linked.subtotal, linked.total], ["2500.00", "2875.00"]);
    const r: any = await attempt(() => env.billing.approve(userFor(M), String(linked.id), {}));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "FINANCE_V2_TAX_DOC_NOT_REPORTABLE");

    const unlinked = await mk(N, sN, sN.unitA2);
    assert.deepEqual([unlinked.subtotal, unlinked.total, unlinked.items[0].vatCategory], ["2500.00", "2500.00", "O"], "not a tax invoice: no VAT");
    const ok: any = await env.billing.approve(userFor(N), String(unlinked.id), {});
    assert.equal(ok.status, "confirmed");
    await drain(env, N);
    const e = await entry(env, N, "simple_invoice", unlinked.id, "confirmed");
    assert.deepEqual(codes(e.lines), [["1121", "2500.00", "0.00"], ["4220", "0.00", "2500.00"]]);
    assert.equal(e.lines[1].vat_category, "O");
  });

  it("unlinked account: an AGF drafted with VAT (before this rule) is refused, naming the missing link", async () => {
    const [d] = await env.q(
      `insert into simple_invoices (user_id, number, type, kind, status, subtotal, total, issue_date, items, client)
       values ($1, 'AGF-900009', 'invoice', 'agency_fee', 'draft', 1000, 1150, $2,
               '[{"description":"أتعاب الوساطة","quantity":1,"unitPrice":1000,"amount":1000,"vat":true,"vatCategory":"S"}]', '{}') returning id`, [N, today]);
    const r: any = await attempt(() => env.billing.approve(userFor(N), String(d.id), {}));
    assert.equal(r.status, 409);
    assert.deepEqual([r.body.error, r.body.linked], ["FINANCE_V2_TAX_DOC_NOT_REPORTABLE", false]);
  });

  it("unlinked account: the commission is drafted without VAT and approves; E15 books no output VAT", async () => {
    const c: any = await env.contracts.create(userFor(N), {
      unitIds: [sN.unitA1], tenantId: sN.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(0), endDate: lastOf(11),
      monthlyRent: "6000", paymentFrequency: "monthly", vatEnabled: true,
    });
    const [p1] = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date limit 1`, [c.id]);
    const inv: any = await env.billing.create(userFor(N), {
      type: "invoice", paymentIds: [p1.id], issueDate: today,
      items: [{ description: "إيجار", quantity: 1, unitPrice: 6000, amount: 6000, vat: true }], total: 6900,
    });
    const ap: any = await env.billing.approve(userFor(N), String(inv.id), { confirmations: { tenantNoVat: true } });
    assert.deepEqual([ap.commission?.subtotal, ap.commission?.total], ["300.00", "300.00"]);
    const ok: any = await env.billing.approve(userFor(N), String(ap.commission.id), {});
    assert.equal(ok.status, "confirmed");
    await drain(env, N);
    const e = await entry(env, N, "simple_invoice", ap.commission.id, "confirmed");
    assert.deepEqual(codes(e.lines), [["2121", "300.00", "0.00"], ["4210", "0.00", "300.00"]]);
    const r: any = await vat.vatReturn(N, { period: vatPeriod });
    assert.equal(r.boxes.find((b: any) => b.box === 1).vat, "0.00", "no commission VAT without a tax invoice");
  });

  // ── Owner mode ──
  it("owner mode: a free invoice's consulting line is other income (4140), not commercial rent, with no no_coverage_window", async () => {
    const inv = await freeInvoice(O, [{ description: "خدمة استشارية", quantity: 1, unitPrice: 1000, amount: 1000, vat: true }], 1150,
      customer("Synthetic Customer Z", "1000054031"));
    const e = await entry(env, O, "simple_invoice", inv.id, "confirmed");
    assert.deepEqual(codes(e.lines), [["1121", "1150.00", "0.00"], ["4140", "0.00", "1000.00"], ["2151", "0.00", "150.00"]]);
    assert.ok(!e.warnings.includes("no_coverage_window"), JSON.stringify(e.warnings));
    const r: any = await vat.vatReturn(O, { period: vatPeriod });
    assert.equal(r.boxes.find((b: any) => b.box === 1).vat, "150.00");
    const a: any = await aging.arAging(O, { asOf: today });
    assert.ok(a.rows.some((x: any) => x.tenantName === "Synthetic Customer Z"));
  });

  it("flag off is untouched: the commission guard and the classification never run without Finance v2", async () => {
    // A flag-off account approving a VAT-bearing commission keeps the legacy behaviour (no v2 refusal).
    const U = 5404;
    const s = await seedAccount(env, U);
    await linkHolder(env, U, s);
    const [d] = await env.q(
      `insert into simple_invoices (user_id, number, type, kind, status, contract_id, subtotal, total, issue_date, items, client)
       values ($1, 'COM-900001', 'invoice', 'commission', 'draft', null, 100, 115, $2,
               '[{"description":"عمولة إدارة الأملاك","quantity":1,"unitPrice":100,"amount":100,"vat":true}]', '{}') returning id`, [U, today]);
    const out: any = await env.billing.approve(userFor(U), String(d.id), {});
    assert.equal(out.status, "confirmed");
    const [n] = await env.q(`select count(*)::int as n from ledger_outbox where user_id = $1`, [U]);
    assert.equal(n.n, 0);
  });
});
