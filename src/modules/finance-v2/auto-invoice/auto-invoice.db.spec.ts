import { describe, it, before, after } from "node:test";
import { BadRequestException } from "@nestjs/common";
import assert from "node:assert/strict";
import { fv2DbSkip } from "../__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "../__tests__/legacy-env";
import { riyadhToday } from "../dates";
import { AutoInvoiceService } from "./auto-invoice.service";
import { PostingErrorsService } from "../posting-errors.service";
import { EmailService } from "../../email/email.service";
import { TaqnyatService } from "../../sms/taqnyat.service";

/**
 * Automatic invoicing of due installments (accountant requirement 9), on a
 * throwaway Postgres with the REAL billing controller (create + approve) and
 * the v2 hooks, worker and recognizer. ZATCA is stubbed by the harness (the
 * stub counts its calls); every message sender is stubbed to count, and must
 * stay at zero. Synthetic data only (public repo).
 */
const M = 7301; // manager mode: agent landlord (VAT, linked) + account-holder landlord (VAT, linked)
const O = 7302; // owner mode: one legal person
const U = 7303; // manager mode: the agent landlord has NO VAT number (rent receipts)
const F = 7304; // flag off
const today = riyadhToday();
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const PERMS = ["reports.view", "payments.view", "payments.write", "invoices.view", "invoices.write", "expenses.write", "expenses.approve", "contracts.view", "contracts.write"];
const userFor = (u: number) => ({ ...userOf(u), permissions: PERMS });

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

describe("fv2 auto-invoicing of due installments (real Postgres, real billing create/approve)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let sM: Seed, sO: Seed, sU: Seed, sF: Seed;
  let auto: AutoInvoiceService;
  let errors: PostingErrorsService;
  const sends = { email: 0, sms: 0, fetch: 0, zatca: 0 };
  const orig = { email: EmailService.prototype.send, sms: TaqnyatService.prototype.send, fetch: globalThis.fetch };

  const drain = async (u: number, asOf = today) => {
    await env.recognizer.runAccount(u, asOf);
    for (let i = 0; i < 10; i++) {
      const r = await env.worker.runAccount(u);
      if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
    }
  };
  /** A monthly contract; its installments are then re-dated to `dues` (in order), the rest pushed a year out. */
  const contract = async (u: number, s: Seed, unit: number, rent: string, vat: boolean, dues: string[]) => {
    const [y, m] = today.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 1 + 1, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(y, m - 1 + 13, 0)).toISOString().slice(0, 10);
    const c: any = await env.contracts.create(userFor(u), {
      unitIds: [unit], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: start, endDate: end,
      monthlyRent: rent, paymentFrequency: "monthly", vatEnabled: vat,
    });
    const ps = await env.q(`select id from payments where contract_id = $1 and deleted_at is null order by due_date, id`, [c.id]);
    for (let i = 0; i < ps.length; i++) {
      await env.q(`update payments set due_date = $2 where id = $1`, [ps[i].id, i < dues.length ? dues[i] : addDays(today, 400 + i * 30)]);
    }
    return { id: Number(c.id), p: ps.map((x: any) => Number(x.id)) };
  };
  const docsFor = (u: number, pid: number) => env.q(
    `select id, number, kind, status::text as status, total::text as total, subtotal::text as subtotal, items, to_char(issue_date,'YYYY-MM-DD') as issue_date
       from simple_invoices where user_id = $1 and deleted_at is null and type = 'invoice' and coalesce(kind,'invoice') <> 'commission'
        and (payment_id = $2 or coalesce(payment_ids,'[]'::jsonb) @> jsonb_build_array($2::int)) order by id`, [u, pid]);
  /**
   * Net receivable (1121 + 1122) booked for one installment, over every entry: its own charge lines (E02 and any
   * reversal carry the installment) plus the lines of the documents covering it (E01 carries the document).
   */
  const arNet = async (u: number, pid: number) => {
    const [r] = await env.q(
      `select coalesce(sum(l.debit - l.credit), 0)::text as n from journal_lines l join accounts a on a.id = l.account_id
        where l.user_id = $1 and a.code in ('1121','1122')
          and (l.payment_id = $2 or l.document_id in (
                select id from simple_invoices si where si.user_id = $1 and coalesce(si.kind,'invoice') <> 'commission'
                   and (si.payment_id = $2 or coalesce(si.payment_ids,'[]'::jsonb) @> jsonb_build_array($2::int))))`, [u, pid]);
    return r.n;
  };
  const charges = (u: number, pid: number) => env.q(
    `select charged_by, reversed_reason from finance_installment_charges where user_id = $1 and payment_id = $2 order by generation`, [u, pid]);
  const entryOf = async (u: number, sourceType: string, sourceId: number, event: string) => {
    const lines = await env.q(
      `select a.code, l.debit::text as debit, l.credit::text as credit, l.seller_key, l.vat_category, e.is_late, to_char(e.entry_date,'YYYY-MM-DD') as entry_date
         from ledger_outbox o join journal_entries e on e.id = o.entry_id join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
        where o.user_id = $1 and o.source_type = $2 and o.source_id = $3 and o.event = $4 order by l.line_no`, [u, sourceType, sourceId, event]);
    const [o] = await env.q(`select status from ledger_outbox where user_id = $1 and source_type = $2 and source_id = $3 and event = $4`, [u, sourceType, sourceId, event]);
    return { status: o?.status ?? null, lines };
  };
  const newUnit = async (prop: number, n: string) => Number((await env.q(`insert into units (property_id, unit_number) values ($1, $2) returning id`, [prop, n]))[0].id);
  const enableAuto = (u: number, leadDays = 0) => auto.patchSettings(u, u, { enabled: true, leadDays, reason: "turn on auto-invoicing (spec)" });

  before(async () => {
    env = await legacyEnv("wired");
    const origZatca = env.billing.submitApprovedDocToZatca;
    env.billing.submitApprovedDocToZatca = async (...a: any[]) => { sends.zatca++; return origZatca(...a); };
    EmailService.prototype.send = async function () { sends.email++; return false; };
    TaqnyatService.prototype.send = async function () { sends.sms++; return { ok: false } as any; };
    globalThis.fetch = (async () => { sends.fetch++; throw new Error("fv2 spec: no network"); }) as any;

    sM = await seedAccount(env, M);
    await linkHolder(env, M, sM);
    await enableV2(env, M, "manager");
    sO = await seedAccount(env, O);
    await linkHolder(env, O, sO);
    await env.q(`update owners set is_account_holder = true, tax_number = '310000000000003' where user_id = $1`, [O]);
    await enableV2(env, O, "owner");
    sU = await seedAccount(env, U);
    await env.q(`update owners set tax_number = null where id = $1`, [sU.agent]);
    await enableV2(env, U, "manager");
    sF = await seedAccount(env, F);

    auto = new AutoInvoiceService(env.t.pool as any);
    auto.billing = env.billing;
    errors = new PostingErrorsService(env.t.pool as any);
  });
  after(async () => {
    EmailService.prototype.send = orig.email;
    TaqnyatService.prototype.send = orig.sms;
    globalThis.fetch = orig.fetch;
    await env?.t.drop();
  });

  it("is OFF by default: no row means off, and the daily run issues nothing", async () => {
    await contract(M, sM, sM.unitA2, "3000", true, [today]);
    assert.deepEqual(await auto.getSettings(M), { enabled: false, leadDays: 0, startFrom: null });
    assert.deepEqual(await auto.runAccount(M), []);
    const [n] = await env.q(`select count(*)::int as n from simple_invoices where user_id = $1`, [M]);
    assert.equal(n.n, 0);
    // The setting needs a reason, and validates its values.
    assert.equal(((await attempt(() => auto.patchSettings(M, M, { enabled: true }))) as any).status, 400);
    assert.equal(((await attempt(() => auto.patchSettings(M, M, { leadDays: 99, reason: "too many days" }))) as any).status, 400);
  });

  it("manager, agent landlord, VAT: issues the due installment through create+approve; the ledger charges it once (E01, never E02); idempotent", async () => {
    const k = await contract(M, sM, sM.unitA1, "6000", true, [addDays(today, -40), today, addDays(today, 3)]); // 6,000 + 15% = 6,900 per installment
    const [p1, p2, p3] = k.p;
    await drain(M); // the recognizer charges the backlog p1 at its due date (E02)
    assert.equal((await entryOf(M, "payment", p1, "charge")).status, "posted");

    const s = await enableAuto(M);
    assert.deepEqual(s, { enabled: true, leadDays: 0, startFrom: today });
    const z0 = sends.zatca;
    const res = await auto.runAccount(M);
    // p1 is due before the setting was turned on (backlog: listed, never auto-issued); p3 is not due yet (lead 0).
    const mine = res.filter((r) => r.contractId === k.id);
    assert.equal(mine.length, 1);
    assert.deepEqual([mine[0].status, mine[0].paymentIds], ["issued", [p2]]);
    assert.equal(sends.zatca - z0, 2, "the tax invoice took the approve path's ZATCA step (this contract's and the other unit's)");

    const [doc] = await docsFor(M, p2);
    assert.equal(doc.status, "confirmed");
    assert.match(doc.number, /^INV-/);
    assert.equal(doc.issue_date, today);
    assert.deepEqual(doc.items, [{ description: "إيجار", quantity: 1, unitPrice: 6000, amount: 6000, vat: true, vatCategory: "S" }]);
    assert.deepEqual([doc.subtotal, doc.total], ["6000.00", "6900.00"]);
    assert.equal((await docsFor(M, p1)).length, 0);
    assert.equal((await docsFor(M, p3)).length, 0);
    // The v2 commission draft came with the approval, exactly as for a person.
    const [com] = await env.q(`select status::text as status from simple_invoices where user_id = $1 and kind = 'commission' and billing_reference = $2`, [M, doc.number]);
    assert.equal(com?.status, "draft");

    await drain(M);
    const e = await entryOf(M, "simple_invoice", doc.id, "confirmed");
    assert.equal(e.status, "posted");
    assert.deepEqual(e.lines.map((l: any) => [l.code, l.debit, l.credit, l.seller_key]), [
      ["1122", "6900.00", "0.00", null], ["2122", "0.00", "6000.00", `owner:${sM.agent}`], ["2122", "0.00", "900.00", `owner:${sM.agent}`],
    ]);
    // Tomorrow's recognizer never charges it at its due date: the document already did (§4.1 rule 1).
    await drain(M, addDays(today, 1));
    const [c2] = await env.q(`select count(*)::int as n from ledger_outbox where user_id = $1 and source_type = 'payment' and source_id = $2 and event like 'charge%'`, [M, p2]);
    assert.equal(c2.n, 0);
    assert.deepEqual(await charges(M, p2), [{ charged_by: "document", reversed_reason: null }]);
    assert.equal(await arNet(M, p2), "6900.00");

    // A second run (and a third) is free: nothing new, no second invoice.
    assert.deepEqual((await auto.runAccount(M)).filter((r) => r.contractId === k.id), []);
    assert.deepEqual((await auto.runAccount(M)).filter((r) => r.contractId === k.id), []);
    assert.equal((await docsFor(M, p2)).length, 1);
    const [link] = await env.q(`select status, document_id from finance_auto_invoice_links where payment_id = $1`, [p2]);
    assert.deepEqual([link.status, Number(link.document_id)], ["issued", doc.id]);
  });

  it("lead days: issues N days before the due date; two concurrent runs still make ONE invoice", async () => {
    await auto.patchSettings(M, M, { leadDays: 3, reason: "issue three days early" });
    const k = await contract(M, sM, await newUnit(sM.propA, "A3"), "1000", true, [addDays(today, 3), addDays(today, 4)]);
    const [a, b] = await Promise.all([auto.runAccount(M), auto.runAccount(M), auto.runAccount(M)]).then((r) => [r[0], r[1].concat(r[2])]);
    const issued = [...a, ...b].filter((r) => r.contractId === k.id && r.status === "issued");
    assert.equal(issued.length, 1);
    assert.equal((await docsFor(M, k.p[0])).length, 1);
    assert.equal((await docsFor(M, k.p[1])).length, 0, "four days out is beyond the lead time");
    await drain(M, addDays(today, 5)); // even after its due date has passed, the recognizer leaves it alone
    assert.equal(await arNet(M, k.p[0]), "1150.00");
    await auto.patchSettings(M, M, { leadDays: 0, reason: "back to the due date" });
  });

  it("the backlog is listed as due-not-invoiced; 'issue now' reverses the due-date charge and posts the invoice (no double charge), even into a closed period", async () => {
    const list = await auto.uninvoiced(M);
    const back = list.items.filter((x: any) => x.dueDate === addDays(today, -40));
    assert.equal(back.length, 1);
    const p1 = back[0].paymentId;
    assert.equal(await arNet(M, p1), "6900.00", "charged once at its due date by the recognizer");
    assert.ok((await auto.summary(M)).count >= 1);

    // Close the current period: the invoice's E01 and the E02 reversal post late, into the next open period (§4.7).
    await env.q(`update fiscal_periods set status = 'closed', closed_at = now() where user_id = $1 and starts_on <= $2 and ends_on >= $2`, [M, today]);
    // A person without invoices.write cannot.
    assert.equal(((await attempt(() => auto.issueNow(M, { ...userOf(M), permissions: ["reports.view"] }, { paymentIds: [p1] }))) as any).status, 403);
    const r = await auto.issueNow(M, userFor(M), { paymentIds: [p1] });
    assert.deepEqual(r.results.map((x) => x.status), ["issued"]);
    await drain(M);
    const [doc] = await docsFor(M, p1);
    const e1 = await entryOf(M, "simple_invoice", doc.id, "confirmed");
    assert.equal(e1.status, "posted");
    assert.deepEqual(await charges(M, p1), [
      { charged_by: "due", reversed_reason: "replaced_by_document" }, { charged_by: "document", reversed_reason: null },
    ]);
    assert.ok(e1.lines.every((l: any) => l.is_late === true && l.entry_date > today), "late, into the next open period");
    const [rev] = await env.q(
      `select e.is_late, to_char(e.entry_date,'YYYY-MM-DD') as d from journal_entries e where e.user_id = $1 and e.origin = 'reversal'
          and e.reversal_of in (select entry_id from finance_installment_charges where user_id = $1 and payment_id = $2 and charged_by = 'due')`, [M, p1]);
    assert.ok(rev?.is_late === true && rev.d > today, "the E02 reversal also lands in the next open period");
    assert.equal(await arNet(M, p1), "6900.00", "the E02 is reversed and replaced: still one charge");
    const [fails] = await env.q(`select count(*)::int as n from ledger_outbox where user_id = $1 and status = 'failed'`, [M]);
    assert.equal(fails.n, 0);
    await env.q(`update fiscal_periods set status = 'open', closed_at = null where user_id = $1 and status = 'closed'`, [M]);
    // Not listed any more, and "issue now" on it again is refused (it is invoiced).
    assert.ok(!(await auto.uninvoiced(M)).items.some((x: any) => x.paymentId === p1));
    assert.equal(((await attempt(() => auto.issueNow(M, userFor(M), { paymentIds: [p1] }))) as any).status, 409);
  });

  it("VAT vs exempt: rent without VAT is issued as exempt (VATEX-SA-30) and books no output VAT; the account holder's rent is principal", async () => {
    const k = await contract(M, sM, sM.unitH1, "2000", false, [today]);
    const res = (await auto.runAccount(M)).filter((r) => r.contractId === k.id);
    assert.deepEqual(res.map((x) => x.status), ["issued"]);
    const [doc] = await docsFor(M, k.p[0]);
    assert.deepEqual(doc.items, [{ description: "إيجار", quantity: 1, unitPrice: 2000, amount: 2000, vat: false, vatCategory: "E", exemptionReason: "VATEX-SA-30" }]);
    assert.deepEqual([doc.subtotal, doc.total], ["2000.00", "2000.00"]);
    await drain(M);
    const e = await entryOf(M, "simple_invoice", doc.id, "confirmed");
    assert.deepEqual(e.lines.map((l: any) => [l.code, l.debit, l.credit, l.seller_key, l.vat_category]), [
      ["1121", "2000.00", "0.00", null, null], ["2131", "0.00", "2000.00", "account", "E"],
    ]);
  });

  it("owner mode: the account is the seller (1121 / 2131 / 2151, seller 'account')", async () => {
    await enableAuto(O);
    const k = await contract(O, sO, sO.unitA1, "1000", true, [today]);
    const res = await auto.runAccount(O);
    assert.deepEqual(res.map((x) => x.status), ["issued"]);
    const [doc] = await docsFor(O, k.p[0]);
    await drain(O);
    const e = await entryOf(O, "simple_invoice", doc.id, "confirmed");
    assert.deepEqual(e.lines.map((l: any) => [l.code, l.debit, l.credit, l.seller_key]), [
      ["1121", "1150.00", "0.00", null], ["2131", "0.00", "1000.00", "account"], ["2151", "0.00", "150.00", "account"],
    ]);
  });

  it("a landlord with no VAT number gets the v2 non-tax rent receipt (never ZATCA), charged by E08", async () => {
    await enableAuto(U);
    const k = await contract(U, sU, sU.unitA1, "4000", false, [today]);
    const z0 = sends.zatca;
    const res = await auto.runAccount(U);
    assert.deepEqual(res.map((x) => [x.status, x.kind]), [["issued", "rent_receipt"]]);
    assert.equal(sends.zatca, z0, "a rent receipt never reaches ZATCA");
    const [doc] = await docsFor(U, k.p[0]);
    assert.match(doc.number, /^RR-/);
    assert.equal(doc.status, "confirmed");
    await drain(U);
    assert.equal((await entryOf(U, "simple_invoice", doc.id, "confirmed")).status, "posted");
    assert.equal(await arNet(U, k.p[0]), "4000.00");
  });

  it("a failure never throws: it is recorded (no draft, no number spent), shown on the posting-errors list, dismissable, and retried by 'issue now'", async () => {
    await env.q(`update tenants set national_id = null where id = $1`, [sM.tenant]);
    const k = await contract(M, sM, await newUnit(sM.propA, "A4"), "500", true, [today]);
    const res = (await auto.runAccount(M)).filter((r) => r.contractId === k.id);
    assert.deepEqual(res.map((x) => [x.status, x.errorCode]), [["failed", "NOT_READY"]]);
    assert.equal((await env.q(`select 1 from simple_invoices where user_id = $1 and (payment_id = $2 or payment_ids @> jsonb_build_array($2::int))`, [M, k.p[0]])).length, 0);
    const pe: any = await errors.list(M);
    assert.equal(pe.counts.autoInvoiceFailed, 1);
    assert.equal(pe.autoInvoice[0].paymentId, k.p[0]);
    assert.equal(pe.autoInvoice[0].errorCode, "NOT_READY");
    assert.ok(pe.autoInvoice[0].message.ar && pe.autoInvoice[0].message.en);

    await auto.dismiss(M, M, k.p[0], { reason: "tenant data being collected" });
    assert.deepEqual((await auto.runAccount(M)).filter((r) => r.contractId === k.id), [], "the daily run leaves a dismissed one alone");
    assert.ok((await auto.uninvoiced(M)).items.some((x: any) => x.paymentId === k.p[0]), "still due and not invoiced");

    await env.q(`update tenants set national_id = $2 where id = $1`, [sM.tenant, `10000${M}`]);
    const r = await auto.issueNow(M, userFor(M), { paymentIds: [k.p[0]] });
    assert.deepEqual(r.results.map((x) => x.status), ["issued"]);
    assert.equal((await errors.list(M) as any).counts.autoInvoiceFailed, 0);
  });

  it("a user's own draft is never duplicated: the installment is reported, not re-invoiced", async () => {
    const k = await contract(M, sM, await newUnit(sM.propA, "A5"), "700", true, [today]);
    await env.billing.create(userFor(M), {
      type: "invoice", paymentIds: [k.p[0]], paymentId: k.p[0], contractId: k.id, issueDate: today,
      items: [{ description: "إيجار", quantity: 1, unitPrice: 700, amount: 700, vat: true }], total: 805,
    });
    const res = (await auto.runAccount(M)).filter((r) => r.contractId === k.id);
    assert.deepEqual(res.map((x) => [x.status, x.errorCode]), [["failed", "DRAFT_EXISTS"]]);
    assert.equal((await docsFor(M, k.p[0])).length, 1);
    const item = (await auto.uninvoiced(M)).items.find((x: any) => x.paymentId === k.p[0]);
    assert.ok(item?.draft?.number, "listed with its draft");
  });

  it("a refused approval keeps its draft, and the next run approves THAT draft (no second document); a stale claim is taken over", async () => {
    const k = await contract(M, sM, await newUnit(sM.propA, "A6"), "900", true, [today]);
    const realApprove = env.billing.approve;
    env.billing.approve = async () => { throw new BadRequestException({ error: "invoice_not_ready", message: "synthetic refusal" }); };
    try {
      const res = (await auto.runAccount(M)).filter((r) => r.contractId === k.id);
      assert.deepEqual(res.map((x) => [x.status, x.errorCode]), [["failed", "APPROVE_REFUSED"]]);
    } finally {
      env.billing.approve = realApprove;
    }
    const [draft] = await docsFor(M, k.p[0]);
    assert.equal(draft.status, "draft");
    const res2 = (await auto.runAccount(M)).filter((r) => r.contractId === k.id);
    assert.deepEqual(res2.map((x) => [x.status, x.documentId]), [["issued", draft.id]]);
    const all = await docsFor(M, k.p[0]);
    assert.deepEqual(all.map((d: any) => [d.id, d.status]), [[draft.id, "confirmed"]]);

    // A claim left by a crashed attempt blocks for 15 minutes, then the next run takes it over.
    const k2 = await contract(M, sM, await newUnit(sM.propA, "A7"), "900", true, [today]);
    await env.q(`insert into finance_auto_invoice_links (payment_id, user_id, status, attempts, claimed_at) values ($1, $2, 'claimed', 1, now())`, [k2.p[0], M]);
    assert.deepEqual((await auto.runAccount(M)).filter((r) => r.contractId === k2.id), []);
    await env.q(`update finance_auto_invoice_links set claimed_at = now() - interval '1 hour' where payment_id = $1`, [k2.p[0]]);
    assert.deepEqual((await auto.runAccount(M)).filter((r) => r.contractId === k2.id).map((x) => x.status), ["issued"]);
  });

  it("flag off: an enabled setting row does nothing", async () => {
    await env.q(`insert into finance_auto_invoice_settings (user_id, enabled, start_from) values ($1, true, $2)`, [F, today]);
    await contract(F, sF, sF.unitA1, "1000", true, [today]);
    assert.deepEqual(await auto.runAccount(F), []);
    assert.equal((await env.q(`select 1 from simple_invoices where user_id = $1`, [F])).length, 0);
  });

  it("no message was sent to anybody by any of the above (email, SMS, push, in-app)", async () => {
    assert.deepEqual([sends.email, sends.sms, sends.fetch], [0, 0, 0]);
    const [n] = await env.q(`select count(*)::int as n from notifications`);
    assert.equal(n.n, 0);
    const [o] = await env.q(`select count(*)::int as n from owner_notifications`);
    assert.equal(o.n, 0);
  });
});
