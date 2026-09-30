import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { riyadhToday } from "./dates";
import { CommissionRunService, type CommissionIssuer } from "./commission-run.service";
import { StatementsService } from "./reports/statements.service";
import { BankAccountsService } from "./tier1/bank-accounts.service";
import { FinanceSettingsService } from "./settings.service";
import { BillingModule } from "../billing/billing.module";

/**
 * The monthly commission run on the collected basis, end to end through the
 * real legacy routes and the posting engine, on a throwaway Postgres
 * (synthetic data only; ZATCA is a fake that records what would be signed).
 *
 *  - calc: partial payments, a refund, Ejar-settled rent, property vs landlord
 *    rate, VAT and non-VAT offices;
 *  - idempotency per (account, landlord, month), concurrent runs, reversal by
 *    commission credit note and re-run, carry-forward of a late collection;
 *  - closed periods: the invoice's entry posts late like any v2 event;
 *  - the cutover from the billed basis (no rent is charged twice);
 *  - the invoice shape handed to ZATCA: office seller, landlord buyer,
 *    standard for a VAT-registered landlord, simplified otherwise;
 *  - the commission transfer (Dr operating / Cr trust), landlord statement unchanged.
 */
const M = 5701; // manager, office VAT-registered and linked (the account-holder landlord's credentials)
const N = 5702; // manager, office not linked (no VAT on commission)
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
const dayOf = (monthsFromNow: number, day: number) => `${firstOf(monthsFromNow).slice(0, 8)}${String(day).padStart(2, "0")}`;
const monthOf = (monthsFromNow: number) => firstOf(monthsFromNow).slice(0, 7);
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "contracts.view", "contracts.write"];
const userFor = (u: number) => ({ ...userOf(u), permissions: PERMS });
const ctl = (mod: unknown) => (Reflect as any).getMetadata("controllers", mod)[0];

async function linkHolder(env: LegacyEnv, u: number, s: Seed) {
  await env.q(
    `insert into zatca_credentials (user_id, owner_id, active_environment, seller_name, seller_vat_number, seller_street, seller_building_no,
       seller_district, seller_city, seller_postal_zone, serial_number, organization_identifier, organization_unit_name, location_address,
       industry_category, common_name, sandbox_private_key_enc, sandbox_binary_security_token, sandbox_secret_enc, sandbox_cert_pem)
     select user_id, $2, active_environment, 'Synthetic Office', '310000000000003', seller_street, seller_building_no, seller_district, seller_city,
       seller_postal_zone, serial_number, '310000000000003', organization_unit_name, location_address, industry_category, common_name,
       sandbox_private_key_enc, sandbox_binary_security_token, sandbox_secret_enc, sandbox_cert_pem
       from zatca_credentials where user_id = $1 and owner_id = $3`, [u, s.holder, s.agent]);
}

async function drain(env: LegacyEnv, u: number) {
  await env.recognizer.runAccount(u);
  for (let i = 0; i < 12; i++) {
    const r = await env.worker.runAccount(u);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

async function entryOf(env: LegacyEnv, u: number, docId: number, event = "confirmed") {
  const lines = await env.q(
    `select a.code, l.debit::text as debit, l.credit::text as credit, l.owner_id, l.vat_category, l.tax_role, l.seller_key, l.vat_base::text as base
       from journal_entries e join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
      where e.user_id = $1 and e.source_type = 'simple_invoice' and e.source_id = $2 and e.event = $3 order by l.line_no`, [u, docId, event]);
  const [e] = await env.q(`select to_char(entry_date,'YYYY-MM-DD') as entry_date, is_late, status from journal_entries
                            where user_id = $1 and source_type = 'simple_invoice' and source_id = $2 and event = $3`, [u, docId, event]);
  return { lines, entry: e ?? null };
}
const codes = (lines: any[]) => lines.map((l) => [l.code, l.debit, l.credit]);

/** A second landlord: an individual, not VAT-registered, 7.5% agreed at landlord level; his property has no rate. */
async function landlordB(env: LegacyEnv, u: number) {
  const [o] = await env.q(
    `insert into owners (user_id, name, email, phone, id_number, management_fee_percent, is_account_holder, type)
     values ($1, 'Synthetic Landlord B', $2, '0500000002', $3, 7.5, false, 'individual') returning id`, [u, `owner-b-${u}@example.test`, `10200${u}`]);
  const [p] = await env.q(`insert into properties (user_id, name, owner_id, management_fee_percent) values ($1, 'Synthetic Palms', $2, null) returning id`, [u, o.id]);
  const [un] = await env.q(`insert into units (property_id, unit_number) values ($1, 'B1') returning id`, [p.id]);
  return { owner: Number(o.id), property: Number(p.id), unit: Number(un.id) };
}

async function installments(env: LegacyEnv, contractId: number): Promise<Array<{ id: number; amount: string; vat: boolean }>> {
  return (await env.q(`select id, amount::text as amount, vat_enabled from payments where contract_id = $1 and deleted_at is null order by due_date, id`, [contractId]))
    .map((r: any) => ({ id: Number(r.id), amount: r.amount, vat: r.vat_enabled === true }));
}

/** A fake ZATCA: records every DTO it is asked to sign; an onboarded sandbox link. Nothing leaves the process. */
function fakeZatca() {
  const issued: any[] = [];
  const invoices = {
    issue: async (_uid: number, dto: any) => {
      issued.push(dto);
      return { invoice: { id: issued.length, status: dto.profile === "standard" ? "cleared" : "reported", submittedTo: dto.profile === "standard" ? "clearance" : "reporting",
        httpStatus: 200, qrBase64: "UVI=", zatcaResponse: {}, clearedXml: null } };
    },
  };
  const onboarding = {
    getCredentials: async () => ({ activeEnvironment: "sandbox", prodSlotEnv: null, sandboxCertPem: "c", sandboxPrivateKeyEnc: "k", sandboxBinarySecurityToken: "t", sandboxSecretEnc: "s" }),
  };
  return { issued, invoices, onboarding };
}

describe("fv2 commission run on the collected basis (real Postgres, real legacy routes)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let B: { owner: number; property: number; unit: number };
  let svc: CommissionRunService;
  let zatcaSvc: CommissionRunService;
  let zatca: ReturnType<typeof fakeZatca>;
  let c1: number, c2: number;
  let i1: Array<{ id: number; amount: string; vat: boolean }>, i2: Array<{ id: number; amount: string; vat: boolean }>;
  let statements: StatementsService;
  const m3 = monthOf(-3);
  const m2 = monthOf(-2);

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, M);
    await linkHolder(env, M, s);
    await enableV2(env, M, "manager");
    await env.q(`update finance_settings set commission_basis = 'collected' where account_user_id = $1`, [M]);
    await env.q(`insert into finance_commission_settings (account_user_id, collected_from) values ($1, $2)`, [M, firstOf(-3)]);
    await env.q(`update owners set management_fee_percent = 10 where id = $1`, [s.agent]); // the property's 5% must win
    B = await landlordB(env, M);
    const issuer: CommissionIssuer = { approve: (scope, id) => env.billing.approve(userFor(scope), String(id), {}) };
    svc = new CommissionRunService(env.t.pool as any, env.emitter, issuer);
    zatca = fakeZatca();
    const Billing = ctl(BillingModule);
    const billingZ = new Billing(env.db, zatca.invoices, zatca.onboarding, {}, {}, { record: () => undefined });
    billingZ.fv2h = env.hooks;
    zatcaSvc = new CommissionRunService(env.t.pool as any, env.emitter, { approve: (scope, id) => billingZ.approve(userFor(scope), String(id), {}) });
    statements = new StatementsService(env.t.pool as any);

    const a: any = await env.contracts.create(userFor(M), {
      unitIds: [s.unitA1], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(-3), endDate: lastOf(8),
      monthlyRent: "6000", paymentFrequency: "monthly", vatEnabled: true,
    });
    const b: any = await env.contracts.create(userFor(M), {
      unitIds: [B.unit], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(-3), endDate: lastOf(8),
      monthlyRent: "3500", paymentFrequency: "monthly", vatEnabled: false,
    });
    c1 = a.id; c2 = b.id;
    i1 = await installments(env, c1);
    i2 = await installments(env, c2);
    await drain(env, M);
  });
  after(async () => { await env?.t.drop(); });

  it("fixtures: a 6,000 + VAT installment is stored gross (6,900) with VAT on; the landlord-B one 3,500 without", () => {
    assert.deepEqual([i1[0].amount, i1[0].vat, i2[0].amount, i2[0].vat], ["6900.00", true, "3500.00", false]);
  });

  it("month 1: preview per landlord — partial payment, refund, Ejar-settled rent, property rate vs landlord rate, VAT", async () => {
    // A: 6,900 collected, 1,150 refunded, 3,000 part-paid on the next installment.
    await env.payments.addCollection(userFor(M), String(i1[0].id), { amount: "6900", collectedDate: dayOf(-3, 5), method: "bank_transfer" });
    await env.payments.addCollection(userFor(M), String(i1[1].id), { amount: "3000", collectedDate: dayOf(-3, 20), method: "bank_transfer" });
    const [rf] = await env.q(`insert into payment_collections (user_id, payment_id, amount, collected_date, method) values ($1, $2, -1150, $3, 'bank_transfer') returning id`,
      [M, i1[0].id, dayOf(-3, 25)]);
    await env.hooks.collectionsAdded({ fv2: true, userId: M }, [Number(rf.id)]);
    // B: his first installment settled through Ejar (E33 at its due date).
    await env.payments.settleExternal(userFor(M), String(i2[0].id));
    await drain(env, M);

    const pv = await svc.preview(M, m3);
    assert.equal(pv.blocked, null);
    assert.deepEqual(pv.office, { vatRegistered: true, zatcaLinked: true });
    const a = pv.landlords.find((l) => l.ownerId === s.agent)!;
    const b = pv.landlords.find((l) => l.ownerId === B.owner)!;
    // (6,900 − 1,150) / 1.15 + 3,000 / 1.15 = 5,000 + 2,608.70; × 5% (property) = 380.44; VAT 57.07.
    assert.deepEqual([a.collected, a.base, a.net, a.vat, a.total, a.profile], ["8750.00", "7608.70", "380.44", "57.07", "437.51", "standard"]);
    assert.deepEqual([a.properties[0].pct, a.properties[0].source], ["5.00", "property"]);
    // 3,500 (Ejar, no VAT) × 7.5% (landlord: the property has none) = 262.50; VAT 39.38.
    assert.deepEqual([b.collected, b.base, b.net, b.vat, b.total, b.profile], ["3500.00", "3500.00", "262.50", "39.38", "301.88", "simplified"]);
    assert.deepEqual([b.properties[0].pct, b.properties[0].source], ["7.50", "landlord"]);
    assert.deepEqual(pv.totals, { collected: "12250.00", base: "11108.70", net: "642.94", vat: "96.45", total: "739.39" });
  });

  it("month 1: the run issues one confirmed COM per landlord; E15 Dr 2121 gross / Cr 4210 net / Cr 2151 VAT on the landlord", async () => {
    const r = await svc.run(M, { id: M }, { month: m3 });
    assert.deepEqual(r.results.map((x) => [x.ownerId, x.status, x.total]).sort(), [[s.agent, "issued", "437.51"], [B.owner, "issued", "301.88"]].sort());
    await drain(env, M);
    const ra = r.results.find((x) => x.ownerId === s.agent)!;
    const [doc] = await env.q(`select status::text as status, kind, contract_id, client, items, subtotal::text as sub, total::text as total from simple_invoices where id = $1`, [ra.documentId]);
    assert.deepEqual([doc.status, doc.kind, doc.contract_id, doc.client.kind, doc.client.ownerId, doc.sub, doc.total], ["confirmed", "commission", null, "landlord", s.agent, "380.44", "437.51"]);
    assert.deepEqual(doc.items.map((i: any) => [i.amount, i.vatCategory]), [[380.44, "S"]]);
    const e = await entryOf(env, M, ra.documentId!);
    assert.deepEqual(codes(e.lines), [["2121", "437.51", "0.00"], ["4210", "0.00", "380.44"], ["2151", "0.00", "57.07"]]);
    assert.ok(e.lines.every((l: any) => l.owner_id === s.agent), "on the landlord's sub-ledger");
    const v = e.lines.find((l: any) => l.code === "2151");
    assert.deepEqual([v.seller_key, v.tax_role, v.base], ["account", "output", "380.44"]);

    // كشف الملاك: commission before VAT and its VAT, apart.
    const st: any = await statements.landlordStatement(M, { ownerId: s.agent, from: firstOf(-3), to: today });
    assert.deepEqual([st.summary.commission, st.summary.commissionNet, st.summary.commissionVat], ["-437.51", "-380.44", "-57.07"]);
  });

  it("idempotent: running month 1 again issues nothing; on the collected basis a rent invoice spawns no per-document commission", async () => {
    const before = await env.q(`select count(*)::int as n from simple_invoices where user_id = $1 and kind = 'commission'`, [M]);
    const r = await svc.run(M, { id: M }, { month: m3 });
    assert.deepEqual(r.results.map((x) => [x.status, x.reason]), [["skipped", "already_issued"], ["skipped", "already_issued"]]);
    const inv: any = await env.billing.create(userFor(M), {
      type: "invoice", paymentIds: [i1[2].id], issueDate: today,
      items: [{ description: "إيجار", quantity: 1, unitPrice: 6000, amount: 6000, vat: true }], total: 6900,
    });
    const ap: any = await env.billing.approve(userFor(M), String(inv.id), { confirmations: { tenantNoVat: true } });
    assert.equal(ap.commission, null);
    // A credit note on it moves no money, so the collected base does not change.
    const crn: any = await env.billing.create(userFor(M), {
      type: "credit", billingReference: inv.number, issueDate: today, items: [{ description: "خصم", quantity: 1, unitPrice: 1000, amount: 1000, vat: true }], total: 1150,
    });
    await env.billing.approve(userFor(M), String(crn.id), {});
    await drain(env, M);
    const after = await env.q(`select count(*)::int as n from simple_invoices where user_id = $1 and kind = 'commission'`, [M]);
    assert.equal(after[0].n, before[0].n);
  });

  it("month 2: a late collection dated month 1 is carried into month 2; the ZATCA shape is office → landlord (standard / simplified)", async () => {
    await env.payments.addCollection(userFor(M), String(i1[1].id), { amount: "3900", collectedDate: dayOf(-2, 3), method: "bank_transfer" });
    // Posted now, dated month 1, after month 1 was run: it must not be lost.
    await env.payments.addCollection(userFor(M), String(i2[1].id), { amount: "3500", collectedDate: dayOf(-3, 28), method: "cash" });
    await drain(env, M);
    const r = await zatcaSvc.run(M, { id: M }, { month: m2 });
    const a = r.results.find((x) => x.ownerId === s.agent)!;
    const b = r.results.find((x) => x.ownerId === B.owner)!;
    assert.deepEqual([a.status, a.net, a.vat, a.zatcaStatus], ["issued", "169.57", "25.44", "cleared"]); // 3,900 / 1.15 = 3,391.30 × 5%
    assert.deepEqual([b.status, b.net, b.vat, b.zatcaStatus], ["issued", "262.50", "39.38", "reported"]);

    const da = zatca.issued.find((d) => d.invoiceNumber === a.number)!;
    const db = zatca.issued.find((d) => d.invoiceNumber === b.number)!;
    // The office is the seller (its standalone seller: the account-holder landlord's credentials), the landlord the buyer.
    assert.deepEqual([da.ownerId, da.profile, da.docType, da.contractId, da.buyer.vat, da.buyer.name], [s.holder, "standard", "invoice", null, "300000000000003", "Synthetic Landlord A"]);
    assert.ok(da.buyer.city && da.buyer.street && da.buyer.postalZone, "a standard invoice carries the landlord's national address");
    assert.deepEqual(da.lines.map((l: any) => [l.vatCategory, l.vatPercent, l.unitPrice]), [["S", 15, 169.57]]);
    assert.deepEqual([db.ownerId, db.profile, db.buyer.vat, db.buyer.name], [s.holder, "simplified", null, "Synthetic Landlord B"]);
    const [st] = await env.q(`select zatca_status, zatca_qr from simple_invoices where id = $1`, [a.documentId]);
    assert.deepEqual([st.zatca_status, st.zatca_qr], ["cleared", "UVI="]);
  });

  it("reversal: a commission credit note (E36 mirror, a ZATCA credit note on the COM), the run is freed; re-runs concurrently issue once, late in a closed period", async () => {
    const list = await svc.list(M, { month: m3 });
    const runA = list.rows.find((x) => x.ownerId === s.agent && x.status === "issued")!;
    const bad: any = await attempt(() => zatcaSvc.reverse(M, { id: M }, runA.id, { reason: "x" }));
    assert.equal(bad.status, 400, "a reason is required");
    const rev: any = await zatcaSvc.reverse(M, { id: M }, runA.id, { reason: "Wrong month, re-issue" });
    assert.equal(rev.status, "reversed");
    await drain(env, M);
    const cn = zatca.issued.find((d) => d.invoiceNumber === rev.creditNote.number)!;
    assert.deepEqual([cn.docType, cn.billingReferenceId, cn.profile, cn.ownerId], ["credit", runA.document!.number, "standard", s.holder]);
    const e = await entryOf(env, M, rev.creditNote.id);
    assert.deepEqual(codes(e.lines), [["2121", "0.00", "437.51"], ["4210", "380.44", "0.00"], ["2151", "57.07", "0.00"]]);
    const again: any = await attempt(() => svc.reverse(M, { id: M }, runA.id, { reason: "twice over" }));
    assert.equal(again.body.error, "RUN_ALREADY_REVERSED");

    // Close the current period: the re-issued invoice posts late into the next open one, like any v2 event.
    await env.q(`update fiscal_periods set status = 'closed', closed_at = now() where user_id = $1 and starts_on <= $2 and ends_on >= $2`, [M, today]);
    const [r1, r2] = await Promise.all([svc.run(M, { id: M }, { month: m3, ownerIds: [s.agent] }), svc.run(M, { id: M }, { month: m3, ownerIds: [s.agent] })]);
    const all = [...r1.results, ...r2.results];
    assert.deepEqual(all.map((x) => x.status).sort(), ["issued", "skipped"]);
    const issued = all.find((x) => x.status === "issued")!;
    assert.equal(issued.total, "437.51", "the freed lines are counted again, once");
    await drain(env, M);
    const late = await entryOf(env, M, issued.documentId!);
    assert.equal(late.entry.is_late, true);
    assert.ok(late.entry.entry_date > lastOf(0), `posted after the closed period (${late.entry.entry_date})`);
    await env.q(`update fiscal_periods set status = 'open', closed_at = null where user_id = $1 and starts_on <= $2 and ends_on >= $2`, [M, today]);
    const live = await env.q(`select count(*)::int as n from finance_commission_runs where user_id = $1 and owner_id = $2 and month = $3 and status = 'issued'`, [M, s.agent, firstOf(-3)]);
    assert.equal(live[0].n, 1);
  });

  it("refuses a month that has not ended, one before the cutover, and a bad month", async () => {
    const r1: any = await attempt(() => svc.run(M, { id: M }, { month: monthOf(0) }));
    assert.deepEqual([r1.status, r1.body.error], [409, "COMMISSION_MONTH_NOT_ENDED"]);
    const r2: any = await attempt(() => svc.run(M, { id: M }, { month: monthOf(-5) }));
    assert.deepEqual([r2.status, r2.body.error], [409, "COMMISSION_BEFORE_CUTOVER"]);
    const r3: any = await attempt(() => svc.preview(M, "2026-13"));
    assert.equal(r3.status, 400);
  });

  it("commission transfer: prefilled with the untransferred commission; Dr operating / Cr trust; the landlord statement does not move; void reverses", async () => {
    const banks = new BankAccountsService(env.t.pool as any);
    const trust = await banks.create(M, M, { kind: "bank", nameAr: "حساب الأمانات", isTrust: true, isDefault: true });
    const runs = (await svc.list(M)).rows.filter((x) => x.status === "issued");
    const expected = runs.reduce((t, x) => t + Math.round(Number(x.total) * 100), 0);
    const t0: any = await svc.listTransfers(M);
    assert.equal(t0.unsent, (expected / 100).toFixed(2));
    assert.equal(t0.defaults.fromBankAccountId, trust.id);
    const before: any = await statements.landlordStatement(M, { ownerId: s.agent, from: firstOf(-3), to: today });

    const over: any = await attempt(() => svc.createTransfer(M, { id: M }, { amount: "999999" }));
    assert.deepEqual([over.status, over.body.error], [409, "OVER_UNSENT_COMMISSION"]);
    const tr: any = await svc.createTransfer(M, { id: M }, {});
    assert.equal(tr.amount, t0.unsent);
    await drain(env, M);
    const lines = await env.q(
      `select a.code, l.debit::text as debit, l.credit::text as credit, l.bank_account_id, l.owner_id from journal_entries e join journal_lines l on l.entry_id = e.id
         join accounts a on a.id = l.account_id where e.user_id = $1 and e.source_type = 'commission_transfer' and e.source_id = $2 and e.event = 'posted' order by l.line_no`, [M, tr.id]);
    assert.equal(lines.length, 2);
    assert.deepEqual([lines[0].debit, lines[1].credit, lines[1].bank_account_id, lines[0].owner_id], [t0.unsent, t0.unsent, trust.id, null]);
    assert.notEqual(lines[0].bank_account_id, trust.id, "into the operating account");
    const after: any = await statements.landlordStatement(M, { ownerId: s.agent, from: firstOf(-3), to: today });
    assert.equal(after.closing, before.closing, "a transfer between the office's own accounts is not a landlord movement");
    assert.equal((await svc.listTransfers(M)).unsent, "0.00");
    const none: any = await attempt(() => svc.createTransfer(M, { id: M }, {}));
    assert.equal(none.body.error, "NOTHING_TO_TRANSFER");

    const v: any = await svc.voidTransfer(M, { id: M }, tr.id, { reason: "Entered twice" });
    assert.equal(v.status, "void");
    await drain(env, M);
    const [rv] = await env.q(`select count(*)::int as n from journal_entries where user_id = $1 and source_type = 'commission_transfer' and source_id = $2 and event = 'reversal:posted'`, [M, tr.id]);
    assert.equal(rv.n, 1);
    assert.equal((await svc.listTransfers(M)).unsent, t0.unsent);

    await env.q(`update fiscal_periods set status = 'locked' where user_id = $1 and starts_on <= $2 and ends_on >= $2`, [M, firstOf(-3)]);
    const locked: any = await attempt(() => svc.createTransfer(M, { id: M }, { date: dayOf(-3, 15) }));
    assert.deepEqual([locked.status, locked.body.error], [409, "PERIOD_LOCKED"]);
  });

  it("scheduled pass: runs the month once per account (then records it), skips what is issued, and honours auto-run off", async () => {
    const first = await svc.runScheduled(m2);
    const mine = first.find((x) => x.scope === M)!;
    assert.ok(mine.results!.every((x) => x.status === "skipped"), "month 2 was already issued by hand");
    const [cs] = await env.q(`select to_char(last_auto_month,'YYYY-MM') as m from finance_commission_settings where account_user_id = $1`, [M]);
    assert.equal(cs.m, m2);
    assert.equal((await svc.runScheduled(m2)).find((x) => x.scope === M), undefined, "a second pass for the same month does nothing");
    await svc.patchSettings(M, { id: M }, { autoRun: false, reason: "Run by hand after review" });
    assert.equal((await svc.runScheduled(monthOf(-1))).find((x) => x.scope === M), undefined, "auto-run off");
  });

  // ── The cutover from the billed basis, and an office with no VAT ──
  it("switching billed → collected never charges twice; an unlinked office's commission carries no VAT and is not a tax invoice", async () => {
    const sN = await seedAccount(env, N);
    await enableV2(env, N, "manager");
    const c: any = await env.contracts.create(userFor(N), {
      unitIds: [sN.unitA1], tenantId: sN.tenant, tenantName: "Synthetic Tenant", startDate: firstOf(-1), endDate: lastOf(10),
      monthlyRent: "2000", paymentFrequency: "monthly", vatEnabled: false,
    });
    const inst = await installments(env, c.id);
    // Billed basis: approving the rent invoice drafts its COM (5% of 2,000).
    const inv: any = await env.billing.create(userFor(N), {
      type: "invoice", paymentIds: [inst[0].id], issueDate: firstOf(-1),
      items: [{ description: "إيجار", quantity: 1, unitPrice: 2000, amount: 2000, vat: false, vatCategory: "O" }], total: 2000,
    });
    const ap: any = await env.billing.approve(userFor(N), String(inv.id), { confirmations: { tenantNoVat: true } });
    assert.equal(ap.commission?.subtotal, "100.00");

    const settings = new FinanceSettingsService(env.t.pool as any, undefined, env.flag);
    const st: any = await settings.patch(N, N, { commissionBasis: "collected", reason: "Accountant: commission on collected rent" });
    assert.equal(st.commissionBasis, "collected");
    const [cut] = await env.q(`select to_char(collected_from,'YYYY-MM-DD') as d from finance_commission_settings where account_user_id = $1`, [N]);
    assert.equal(cut.d, firstOf(0), "the cutover is the first day of the current month");
    await env.q(`update finance_commission_settings set collected_from = $2 where account_user_id = $1`, [N, firstOf(-1)]); // to run a month that has ended

    await env.payments.addCollection(userFor(N), String(inst[0].id), { amount: "2000", collectedDate: dayOf(-1, 10), method: "cash" });
    await env.payments.addCollection(userFor(N), String(inst[1].id), { amount: "2000", collectedDate: dayOf(-1, 12), method: "cash" });
    await drain(env, N);
    const r = await svc.run(N, { id: N }, { month: monthOf(-1) });
    const x = r.results.find((y) => y.ownerId === sN.agent)!;
    // Only the second installment: the first already has its billed COM.
    assert.deepEqual([x.status, x.net, x.vat, x.total], ["issued", "100.00", "0.00", "100.00"]);
    await drain(env, N);
    const [d] = await env.q(`select items from simple_invoices where id = $1`, [x.documentId]);
    assert.equal(d.items[0].vatCategory, "O");
    const e = await entryOf(env, N, x.documentId!);
    assert.deepEqual(codes(e.lines), [["2121", "100.00", "0.00"], ["4210", "0.00", "100.00"]]);
  });
});
