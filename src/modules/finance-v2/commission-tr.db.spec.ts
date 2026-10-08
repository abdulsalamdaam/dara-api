import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { riyadhToday } from "./dates";
import { sqlOf } from "./hooks/sql";
import { createRentReceipt } from "./overrides/documents-v2";
import { commissionSellerCheckById } from "./overrides/commission-approve";
import { CommissionRunService, type CommissionIssuer } from "./commission-run.service";
import { BillingModule } from "../billing/billing.module";
import { PropertiesModule } from "../properties/properties.module";

/**
 * The accountant's test of 5 Oct 2026 (Finance v2 beta, staging), findings 1,
 * 8 and 9, on a throwaway Postgres through the real legacy routes. Synthetic
 * data only; ZATCA is stubbed (or a recording fake).
 *
 *  1. A commission document is approved on the OFFICE's data only: an office
 *     that is not VAT-registered issues a non-tax commission document that
 *     approves with no tenant confirmation, no landlord VAT number and no
 *     landlord ZATCA link; a VAT-registered, linked office issues a tax
 *     invoice in its own name, reported under its seller to the landlord.
 *  8. The property rate keeps two decimals end to end (7.5% of 3,000 = 225).
 *  9. Per-property commission basis: billed vs collected, the account's basis
 *     by default.
 */
const T = 5951; // the accountant's account: office NOT VAT-registered, landlord NOT VAT-registered, nobody linked
const V = 5952; // an office that IS VAT-registered and linked (the account holder's credentials), landlord not registered
const P = 5953; // per-property basis
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
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve",
  "contracts.view", "contracts.write", "properties.view", "properties.write"];
const userFor = (u: number) => ({ ...userOf(u), permissions: PERMS });
const ctl = (mod: unknown) => (Reflect as any).getMetadata("controllers", mod)[0];

async function drain(env: LegacyEnv, u: number) {
  await env.recognizer.runAccount(u);
  for (let i = 0; i < 12; i++) {
    const r = await env.worker.runAccount(u);
    if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
  }
}

async function entryOf(env: LegacyEnv, u: number, docId: number) {
  return env.q(
    `select a.code, l.debit::text as debit, l.credit::text as credit, l.owner_id
       from journal_entries e join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
      where e.user_id = $1 and e.source_type = 'simple_invoice' and e.source_id = $2 and e.event = 'confirmed' order by l.line_no`, [u, docId]);
}
const codes = (lines: any[]) => lines.map((l) => [l.code, l.debit, l.credit]);

/** The accountant's landlord: an individual with no VAT number, not linked to ZATCA; and an office that is not registered either. */
async function unregister(env: LegacyEnv, u: number, s: Seed) {
  await env.q(`update owners set tax_number = null, type = 'individual' where user_id = $1`, [u]);
  await env.q(`delete from zatca_credentials where user_id = $1`, [u]);
  void s;
}

async function installments(env: LegacyEnv, contractId: number) {
  return (await env.q(`select id, amount::text as amount from payments where contract_id = $1 and deleted_at is null order by due_date, id`, [contractId]))
    .map((r: any) => ({ id: Number(r.id), amount: r.amount as string }));
}

/** The annual 36,000 residential contract in 12 monthly installments of 3,000 (no VAT). */
async function annualContract(env: LegacyEnv, u: number, unitId: number, tenantId: number, startMonth = 0) {
  const c: any = await env.contracts.create(userFor(u), {
    unitIds: [unitId], tenantId, tenantName: "Synthetic Tenant", startDate: firstOf(startMonth), endDate: lastOf(startMonth + 11),
    monthlyRent: "3000", paymentFrequency: "monthly", vatEnabled: false,
  });
  return { id: Number(c.id), inst: await installments(env, Number(c.id)) };
}

/** سند استلام إيجار (rent receipt, non-tax) for one installment, approved: returns the approve response (with `commission`). */
async function receiptAndApprove(env: LegacyEnv, u: number, paymentId: number) {
  const rr: any = await createRentReceipt(sqlOf(env.t.pool as any), u, { paymentIds: [paymentId], issueDate: today });
  return env.billing.approve(userFor(u), String(rr.id), {});
}

describe("fv2 accountant test 5 Oct 2026: commission approval, 2-decimal rate, basis per property (real Postgres)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let sT: Seed, sV: Seed, sP: Seed;
  let properties: any;
  let aP: { id: number; inst: Array<{ id: number; amount: string }> };

  before(async () => {
    env = await legacyEnv("wired");
    properties = new (ctl(PropertiesModule))(env.db);
    sT = await seedAccount(env, T);
    await unregister(env, T, sT);
    await enableV2(env, T, "manager");
    await env.q(`update properties set management_fee_percent = 7 where id = $1`, [sT.propA]);

    sV = await seedAccount(env, V);
    // The office is registered (the account holder's VAT number) and linked (its credentials); the landlord is not registered.
    await env.q(
      `insert into zatca_credentials (user_id, owner_id, active_environment, seller_name, seller_vat_number, seller_street, seller_building_no,
         seller_district, seller_city, seller_postal_zone, serial_number, organization_identifier, organization_unit_name, location_address,
         industry_category, common_name, sandbox_private_key_enc, sandbox_binary_security_token, sandbox_secret_enc, sandbox_cert_pem)
       select user_id, $2, active_environment, 'Synthetic Office', '310000000000003', seller_street, seller_building_no, seller_district, seller_city,
         seller_postal_zone, serial_number, '310000000000003', organization_unit_name, location_address, industry_category, common_name,
         sandbox_private_key_enc, sandbox_binary_security_token, sandbox_secret_enc, sandbox_cert_pem
         from zatca_credentials where user_id = $1 and owner_id = $3`, [V, sV.holder, sV.agent]);
    await env.q(`delete from zatca_credentials where user_id = $1 and owner_id = $2`, [V, sV.agent]);
    await env.q(`update owners set tax_number = null, type = 'individual' where id = $1`, [sV.agent]);
    await enableV2(env, V, "manager");
    await env.q(`update properties set management_fee_percent = 7 where id = $1`, [sV.propA]);

    sP = await seedAccount(env, P);
    await unregister(env, P, sP);
    await enableV2(env, P, "manager");
  });
  after(async () => { await env?.t.drop(); });

  // ── Finding 1: the office is the seller, and the only party checked ──
  it("finding 1: unregistered office + unregistered landlord, 7% — the 3,000 rent receipt drafts a 210 non-tax commission that approves with nothing else asked", async () => {
    const c = await annualContract(env, T, sT.unitA1, sT.tenant);
    assert.equal(c.inst.length, 12);
    assert.equal(c.inst[0].amount, "3000.00");
    const ap: any = await receiptAndApprove(env, T, c.inst[0].id);
    assert.equal(ap.status, "confirmed");
    const com = ap.commission;
    assert.ok(com, "the automatic commission document");
    assert.deepEqual([com.kind, com.status, com.subtotal, com.total], ["commission", "draft", "210.00", "210.00"]);
    assert.deepEqual([com.items[0].vatCategory, com.client.kind, com.client.ownerId], ["O", "landlord", sT.agent]);

    // The verdict the approve dialog shows: the office only — a non-tax document, nothing missing.
    const check = await commissionSellerCheckById(sqlOf(env.t.pool as any), T, com.id);
    assert.deepEqual([check.document, check.ok, check.blockers, check.office.vatRegistered, check.office.zatcaLinked], ["non_tax", true, [], false, false]);
    assert.deepEqual(check.notices, []);

    // Approve with NO confirmations: no tenant acknowledgement, no landlord VAT number, no ZATCA link of anyone.
    const ok: any = await env.billing.approve(userFor(T), String(com.id), {});
    assert.equal(ok.status, "confirmed");
    await drain(env, T);
    const lines = await entryOf(env, T, com.id);
    assert.deepEqual(codes(lines), [["2121", "210.00", "0.00"], ["4210", "0.00", "210.00"]], "E15 with no output VAT");
    assert.ok(lines.every((l: any) => l.owner_id === sT.agent));
  });

  it("finding 1: a VAT-bearing commission on an office that cannot issue a tax invoice is refused, naming the OFFICE (never the landlord)", async () => {
    const [d] = await env.q(
      `insert into simple_invoices (user_id, number, type, kind, status, contract_id, subtotal, total, issue_date, items, client)
       values ($1, 'COM-900051', 'invoice', 'commission', 'draft', null, 100, 115, $2,
               '[{"description":"عمولة إدارة الأملاك","quantity":1,"unitPrice":100,"amount":100,"vat":true,"vatCategory":"S"}]',
               $3::jsonb) returning id`, [T, today, JSON.stringify({ kind: "landlord", ownerId: sT.agent })]);
    const r: any = await attempt(() => env.billing.approve(userFor(T), String(d.id), {}));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "FINANCE_V2_TAX_DOC_NOT_REPORTABLE");
    assert.deepEqual(r.body.sellerCheck.blockers.map((b: any) => b.code), ["OFFICE_NOT_VAT_REGISTERED"]);
  });

  it("finding 1: a VAT-registered, linked office — the billed commission is a 15% tax invoice in the office's name, filed under the office's seller to the landlord (simplified: he has no VAT number)", async () => {
    // A recording fake ZATCA; nothing leaves the process.
    const issued: any[] = [];
    const invoices = { issue: async (_u: number, dto: any) => { issued.push(dto); return { invoice: { id: issued.length, status: "reported", submittedTo: "reporting", httpStatus: 200, qrBase64: "UVI=", zatcaResponse: {}, clearedXml: null } }; } };
    const onboarding = { getCredentials: async () => ({ activeEnvironment: "sandbox", prodSlotEnv: null, sandboxCertPem: "c", sandboxPrivateKeyEnc: "k", sandboxBinarySecurityToken: "t", sandboxSecretEnc: "s" }) };
    const billingZ = new (ctl(BillingModule))(env.db, invoices, onboarding, {}, {}, { record: () => undefined });
    billingZ.fv2h = env.hooks;

    const c = await annualContract(env, V, sV.unitA1, sV.tenant);
    const ap: any = await receiptAndApprove(env, V, c.inst[0].id);
    const com = ap.commission;
    assert.deepEqual([com.subtotal, com.total, com.items[0].vatCategory], ["210.00", "241.50", "S"]);
    const check = await commissionSellerCheckById(sqlOf(env.t.pool as any), V, com.id);
    assert.deepEqual([check.document, check.ok, check.buyer.ownerId, check.buyer.profile], ["tax", true, sV.agent, "simplified"]);

    const ok: any = await billingZ.approve(userFor(V), String(com.id), {});
    assert.equal(ok.status, "confirmed");
    const dto = issued.find((d) => d.invoiceNumber === com.number);
    assert.ok(dto, "reported to ZATCA");
    // Seller = the office (its standalone seller: the account holder's credentials); buyer = the landlord; no contract.
    assert.deepEqual([dto.ownerId, dto.profile, dto.contractId, dto.buyer.name, dto.buyer.vat ?? null], [sV.holder, "simplified", null, "Synthetic Landlord A", null]);
    assert.deepEqual(dto.lines.map((l: any) => [l.vatCategory, l.vatPercent, l.unitPrice]), [["S", 15, 210]]);
    await drain(env, V);
    assert.deepEqual(codes(await entryOf(env, V, com.id)), [["2121", "241.50", "0.00"], ["4210", "0.00", "210.00"], ["2151", "0.00", "31.50"]]);
  });

  it("accountant 7 Oct: a VAT-registered office that is not linked gets a 15% commission tax invoice held as a draft until it is linked", async () => {
    const W = 5954;
    const sW = await seedAccount(env, W); // holder registered, nobody linked for the office
    await env.q(`delete from zatca_credentials where user_id = $1`, [W]);
    await env.q(`update owners set tax_number = null where id = $1`, [sW.agent]);
    await enableV2(env, W, "manager");
    const c = await annualContract(env, W, sW.unitA1, sW.tenant);
    const ap: any = await receiptAndApprove(env, W, c.inst[0].id);
    const com = ap.commission;
    assert.deepEqual([com.subtotal, com.total], ["150.00", "172.50"], "5% plus 15% VAT: a registered office never issues a non-tax commission");
    const check = await commissionSellerCheckById(sqlOf(env.t.pool as any), W, com.id);
    assert.deepEqual([check.document, check.ok, check.blockers.map((n) => n.code)], ["tax", false, ["OFFICE_NOT_LINKED"]]);
    const r: any = await attempt(() => env.billing.approve(userFor(W), String(com.id), {}));
    assert.equal(r.status, 409);
    const [d] = await env.q(`select status::text as status from simple_invoices where id = $1`, [com.id]);
    assert.equal(d.status, "draft", "held as a draft, not discarded");
  });

  // ── Finding 8: two decimals end to end ──
  it("finding 8: the property rate 7.5 is saved through the properties route as 7.50 and charges 225.00 on a 3,000 installment; 7.255 is refused", async () => {
    await properties.update(userFor(T), String(sT.propA), { managementFeePercent: "7.5" });
    const [p] = await env.q(`select management_fee_percent::text as pct from properties where id = $1`, [sT.propA]);
    assert.equal(p.pct, "7.50");
    const r: any = await attempt(() => properties.update(userFor(T), String(sT.propA), { managementFeePercent: "7.255" }));
    assert.equal(r.status, 400);
    await properties.update(userFor(T), String(sT.propA), { managementFeePercent: 7.25 });
    const [q] = await env.q(`select management_fee_percent::text as pct from properties where id = $1`, [sT.propA]);
    assert.equal(q.pct, "7.25");
    await properties.update(userFor(T), String(sT.propA), { managementFeePercent: "7.5" });

    const c = await annualContract(env, T, sT.unitA2, sT.tenant);
    const ap: any = await receiptAndApprove(env, T, c.inst[0].id);
    assert.deepEqual([ap.commission?.subtotal, ap.commission?.total], ["225.00", "225.00"]);
    assert.match(ap.commission.notes, /7\.50%/);
    assert.equal((await env.billing.approve(userFor(T), String(ap.commission.id), {})).status, "confirmed");
  });

  // ── Finding 9: billed vs collected per property ──
  it("finding 9: default — a property with no choice follows the account (billed): a commission per approved rent document", async () => {
    const svc = new CommissionRunService(env.t.pool as any, env.emitter);
    const pc: any = await svc.getPropertyCommission(P, sP.propA);
    assert.deepEqual([pc.basis, pc.override, pc.accountBasis, pc.pct, pc.available], ["billed", null, "billed", "5.00", true]);
  });

  it("finding 9: a property switched to 'collected' gets no per-document commission; the monthly run charges it on what was collected, other properties stay billed", async () => {
    const issuer: CommissionIssuer = { approve: (scope, id) => env.billing.approve(userFor(scope), String(id), {}) };
    const svc = new CommissionRunService(env.t.pool as any, env.emitter, issuer);
    // A second property of the same landlord, staying on the account's billed basis.
    const [p2] = await env.q(`insert into properties (user_id, name, owner_id, management_fee_percent) values ($1, 'Synthetic Annex', $2, 7.5) returning id`, [P, sP.agent]);
    const [u2] = await env.q(`insert into units (property_id, unit_number) values ($1, 'X1') returning id`, [p2.id]);

    const bad: any = await attempt(() => svc.patchPropertyCommission(P, { id: P }, sP.propA, { basis: "monthly" }));
    assert.equal(bad.status, 400);
    const pc: any = await svc.patchPropertyCommission(P, { id: P }, sP.propA, { basis: "collected", reason: "Accountant: this building on collected rent" });
    assert.deepEqual([pc.basis, pc.override, pc.accountBasis, pc.collectedFrom], ["collected", "collected", "billed", firstOf(0)]);
    const [ev] = await env.q(`select field, new_value from finance_settings_events where account_user_id = $1 and field like 'property_commission_basis:%'`, [P]);
    assert.deepEqual([ev.field, ev.new_value], [`property_commission_basis:${sP.propA}`, "collected"]);
    // To run a month that has ended: the property's cutover a month back.
    await env.q(`update finance_property_commission set collected_from = $3 where user_id = $1 and property_id = $2`, [P, sP.propA, firstOf(-1)]);

    const a = await annualContract(env, P, sP.unitA1, sP.tenant, -1);
    aP = a;
    const b = await annualContract(env, P, Number(u2.id), sP.tenant, -1);
    const apA: any = await receiptAndApprove(env, P, a.inst[0].id);
    assert.equal(apA.commission, null, "collected basis: no commission per document");
    const apB: any = await receiptAndApprove(env, P, b.inst[0].id);
    assert.deepEqual([apB.commission?.subtotal], ["225.00"], "the billed property still gets its per-document commission (7.5% of 3,000)");

    await env.payments.addCollection(userFor(P), String(a.inst[0].id), { amount: "3000", collectedDate: dayOf(-1, 10), method: "bank_transfer" });
    await env.payments.addCollection(userFor(P), String(b.inst[0].id), { amount: "3000", collectedDate: dayOf(-1, 11), method: "bank_transfer" });
    // The next installment paid early, with no document at all: collected is what counts.
    await env.payments.addCollection(userFor(P), String(a.inst[1].id), { amount: "3000", collectedDate: dayOf(-1, 12), method: "bank_transfer" });
    await drain(env, P);

    const pv = await svc.preview(P, monthOf(-1));
    assert.equal(pv.blocked, null, "a billed account with a collected property can run");
    const l = pv.landlords.find((x) => x.ownerId === sP.agent)!;
    // Only the collected property: 6,000 × 5% = 300; the billed property's collection is not counted.
    assert.deepEqual([l.collected, l.base, l.net, l.vat, l.total], ["6000.00", "6000.00", "300.00", "0.00", "300.00"]);
    assert.deepEqual(l.properties.map((x) => x.propertyId), [sP.propA]);
    const r = await svc.run(P, { id: P }, { month: monthOf(-1) });
    const x = r.results.find((y) => y.ownerId === sP.agent)!;
    assert.deepEqual([x.status, x.net, x.total], ["issued", "300.00", "300.00"]);
  });

  it("finding 9: switching a collected property back to billed never charges an installment the run already counted", async () => {
    const svc = new CommissionRunService(env.t.pool as any, env.emitter);
    await svc.patchPropertyCommission(P, { id: P }, sP.propA, { basis: "billed" });
    // The installment counted by last month's run (via its collection) now gets a document: no second commission.
    const [counted] = await env.q(
      `select i.payment_id from finance_commission_run_items i where i.user_id = $1 and i.live and i.payment_id = $2`, [P, aP.inst[1].id]);
    assert.ok(counted?.payment_id, "the run counted the early-paid installment");
    const ap: any = await receiptAndApprove(env, P, aP.inst[1].id);
    assert.equal(ap.status, "confirmed");
    assert.equal(ap.commission, null, "already charged by the run");
    // An installment the run never saw is charged per document again (billed): 5% of 3,000.
    const ap3: any = await receiptAndApprove(env, P, aP.inst[2].id);
    assert.equal(ap3.commission?.subtotal, "150.00");
    // null clears the choice: the property follows the account again.
    const pc: any = await svc.patchPropertyCommission(P, { id: P }, sP.propA, { basis: null });
    assert.deepEqual([pc.basis, pc.override], ["billed", null]);
  });
});
