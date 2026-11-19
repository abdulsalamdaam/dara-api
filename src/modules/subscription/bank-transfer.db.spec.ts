import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../finance-v2/__tests__/with-db";
import { planPrice } from "../../common/packages";
import { receiptProblem } from "../../common/bank-transfer";
import { SubscriptionInvoiceService } from "./subscription-invoice.service";
import { BankTransferService } from "./bank-transfer.module";

/**
 * Pay by bank transfer (0099) against a throwaway Postgres schema. The bucket,
 * the add-on catalog and the email sender are stubbed; nothing leaves the
 * machine.
 */

const U = 9301;
const ADMIN = { id: 1, role: "super_admin", ownerUserId: null } as any;
const pdfReceipt = () => ({ buffer: Buffer.from("%PDF-1.4 receipt"), originalname: "transfer.pdf", mimetype: "application/pdf", size: 16 });
const drainAsync = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); };

describe("receipt rules", () => {
  it("accepts a PDF or a photo up to 10 MB, nothing else", () => {
    assert.equal(receiptProblem(pdfReceipt()), null);
    assert.equal(receiptProblem({ mimetype: "image/jpeg", size: 2_000_000 }), null);
    assert.ok(receiptProblem(null));
    assert.ok(receiptProblem({ mimetype: "application/pdf", size: 0 }));
    assert.ok(receiptProblem({ mimetype: "application/pdf", size: 10 * 1024 * 1024 + 1 }));
    assert.ok(receiptProblem({ mimetype: "text/html", size: 100 }));
  });
});

describe("bank transfer (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let svc: BankTransferService;
  const q = async (s: string, p: unknown[] = []) => (await t.pool.query(s, p)).rows;
  const user = { id: U, ownerUserId: null } as any;
  const uploaded: Array<{ key: string; scopeId?: number }> = [];
  const adminNotices: any[] = [];
  const rejections: any[] = [];
  const invoiceEmails: string[] = [];
  const env: Record<string, string | undefined> = {};
  const ENV_KEYS = ["BANK_TRANSFER_ENABLED", "BILLING_EMAIL_ALLOWLIST", "RESEND_API_KEY"];

  before(async () => {
    for (const k of ENV_KEYS) env[k] = process.env[k];
    delete process.env.BANK_TRANSFER_ENABLED;
    delete process.env.BILLING_EMAIL_ALLOWLIST;
    delete process.env.RESEND_API_KEY;
    t = await withDb({ legacy: "full", migrate: false });
    await t.apply(join(__dirname, "../../../db/drizzle/0096_linked_accounts.sql"));
    await t.apply(join(__dirname, "../../../db/drizzle/0097_moyasar_tokenization.sql"));
    await t.apply(join(__dirname, "../../../db/drizzle/0098_linked_member_prices.sql"));
    await t.apply(join(__dirname, "../../../db/drizzle/0099_bank_transfer.sql"));
    const db = drizzle(t.pool, { schema }) as any;
    const pdf = { htmlToPdf: async () => Buffer.from("%PDF-1.4 stub") } as any;
    const email = {
      isConfigured: () => true,
      sendSubscriptionInvoice: async (to: string) => { invoiceEmails.push(to); return true; },
      sendAdminPaymentReceived: async () => true,
      sendAdminBankTransferSubmitted: async (p: any) => { adminNotices.push(p); return true; },
      sendBankTransferRejected: async (to: string, _n: string, p: any) => { rejections.push({ to, ...p }); return true; },
    } as any;
    const appLog = { record: () => {} } as any;
    const invoices = new SubscriptionInvoiceService(pdf, email, appLog);
    const uploads = {
      upload: async (f: any, o: any) => {
        const key = `acct/${o.scopeId}/${o.folder}/${uploaded.length + 1}-${f.originalname}`;
        uploaded.push({ key, scopeId: o.scopeId });
        return { key, bucket: "test", size: f.size, contentType: f.mimetype, originalName: f.originalname };
      },
      presignGet: async (key: string) => `https://minio.test/${key}?sig=1`,
    } as any;
    const catalog = { find: async () => null } as any;
    svc = new BankTransferService(db, uploads, invoices, catalog, email, appLog);
  });
  after(async () => {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await t?.drop();
  });
  beforeEach(async () => {
    uploaded.length = 0; adminNotices.length = 0; rejections.length = 0; invoiceEmails.length = 0;
    await q(`delete from subscription_payments`);
    await q(`delete from account_limit_addons`);
    await q(`delete from users where id = $1`, [U]);
    await q(`insert into users (id, email, password_hash, name, user_type, package_plan, subscription_status, billing_cycle)
             values ($1, 'bank-spec@example.test', 'x', 'Synthetic', 'company', 'basic', 'pending_payment', 'quarterly')`, [U]);
  });

  const account = async () => (await q(`select subscription_status, subscription_ends_at, package_plan, billing_cycle, next_billing_at, auto_renew from users where id = $1`, [U]))[0];
  const rows = () => q(`select id, status, charge_type, kind, amount, receipt_key, receipt_name, review_note, reviewed_by, paid_at, addon_id from subscription_payments where user_id = $1 order by id`, [U]);

  it("quotes the exact amount the receipt row will carry", async () => {
    const q = await svc.quote(user, { plan: "professional", cycle: "yearly" });
    assert.equal(q.amount, planPrice("professional", "yearly"));
    const own = await svc.quote(user, {});
    assert.equal(own.amount, planPrice("basic", "quarterly"), "no selection → the account's own plan and cycle");
    const r: any = await svc.submit(user, pdfReceipt(), { plan: "professional", cycle: "yearly" });
    assert.equal(r.amount, q.amount);
    await drainAsync();
  });

  it("an uploaded receipt waits for review and activates nothing", async () => {
    const r: any = await svc.submit(user, pdfReceipt(), { plan: "basic", cycle: "yearly" });
    assert.equal(r.status, "review");
    assert.equal(r.chargeType, "bank_transfer");
    assert.equal(r.amount, planPrice("basic", "yearly"));
    assert.equal(r.hasReceipt, true);
    assert.equal(r.receiptKey, undefined, "the object key is never handed out");
    assert.match(uploaded[0]!.key, new RegExp(`^acct/${U}/subscription-receipts/`), "stored under the account's own prefix");
    const a = await account();
    assert.equal(a.subscription_status, "pending_payment", "a receipt is not money");
    await drainAsync();
    assert.equal(adminNotices.length, 1, "the admins are told");
    assert.equal(adminNotices[0].accountId, U);
  });

  it("approval activates the subscription like a card payment and emails the invoice", async () => {
    const r: any = await svc.submit(user, pdfReceipt(), { plan: "professional", cycle: "yearly" });
    const done: any = await svc.approve(ADMIN, r.id);
    assert.equal(done.status, "paid");
    assert.equal(done.reviewedBy, ADMIN.id);
    const a = await account();
    assert.equal(a.subscription_status, "active");
    assert.equal(a.package_plan, "professional");
    assert.equal(a.billing_cycle, "yearly");
    assert.ok(a.subscription_ends_at);
    await drainAsync();
    assert.deepEqual(invoiceEmails, ["bank-spec@example.test"]);
    await assert.rejects(svc.approve(ADMIN, r.id), /Already/, "approving twice does nothing");
  });

  it("rejection closes the receipt with the reason and emails the customer", async () => {
    const r: any = await svc.submit(user, pdfReceipt(), { plan: "basic", cycle: "yearly" });
    await assert.rejects(svc.reject(ADMIN, r.id, ""), /reason/);
    const done: any = await svc.reject(ADMIN, r.id, "المبلغ في الإيصال أقل من المطلوب");
    assert.equal(done.status, "rejected");
    assert.equal(done.reviewNote, "المبلغ في الإيصال أقل من المطلوب");
    assert.equal((await account()).subscription_status, "pending_payment");
    await drainAsync();
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].to, "bank-spec@example.test");
    await assert.rejects(svc.approve(ADMIN, r.id), /Already reviewed/, "a rejected receipt cannot be approved later");
  });

  it("a new receipt replaces one still under review", async () => {
    const first: any = await svc.submit(user, pdfReceipt(), { plan: "basic", cycle: "yearly" });
    const second: any = await svc.submit(user, pdfReceipt(), { plan: "basic", cycle: "quarterly" });
    const all = await rows();
    assert.equal(all.find((x: any) => x.id === first.id).status, "cancelled");
    assert.equal(all.find((x: any) => x.id === second.id).status, "review");
    const list: any = await svc.list("review");
    assert.equal(list.waiting, 1);
    assert.equal(list.items[0].id, second.id);
    assert.equal(list.items[0].account.email, "bank-spec@example.test");
  });

  it("approving a renewal moves a saved card's next charge to the new end", async () => {
    const end = new Date(Date.now() + 5 * 86_400_000);
    await q(`update users set subscription_status = 'active', subscription_ends_at = $2, auto_renew = true, next_billing_at = $2 where id = $1`, [U, end]);
    const r: any = await svc.submit(user, pdfReceipt(), {});
    await svc.approve(ADMIN, r.id);
    const a = await account();
    assert.ok(new Date(a.subscription_ends_at) > end, "the window continued from the old end");
    assert.equal(new Date(a.next_billing_at).getTime(), new Date(a.subscription_ends_at).getTime(), "the card is not charged for the period paid by transfer");
  });

  it("only the account holder pays, and only with a receipt", async () => {
    await assert.rejects(svc.submit({ id: 77, ownerUserId: U } as any, pdfReceipt(), {}), /account holder/);
    await assert.rejects(svc.submit(user, undefined, {}), /receipt/i);
    process.env.BANK_TRANSFER_ENABLED = "false";
    try { await assert.rejects(svc.submit(user, pdfReceipt(), {}), /not available/); } finally { delete process.env.BANK_TRANSFER_ENABLED; }
    assert.equal((await rows()).length, 0);
  });

  it("an offered add-on is paid by transfer and activated on approval; a rejection leaves it payable", async () => {
    await q(`update users set subscription_status = 'active', subscription_ends_at = now() + interval '90 days' where id = $1`, [U]);
    const [addon] = await q(`insert into account_limit_addons (account_id, limit_key, quantity, period, status, activation, source, price_sar, offer_expires_at)
                             values ($1, 'users', 2, 'one_off', 'offered', 'on_payment', 'admin_offer', 100, now() + interval '7 days') returning id`, [U]);
    const r: any = await svc.submit(user, pdfReceipt(), { addonId: String(addon.id) });
    assert.equal(r.kind, "addon");
    assert.equal(r.status, "review");
    const [a1] = await q(`select status, payment_id from account_limit_addons where id = $1`, [addon.id]);
    assert.equal(a1.status, "pending_payment");
    assert.equal(a1.payment_id, r.id);

    await svc.reject(ADMIN, r.id, "الإيصال غير واضح");
    const [back] = await rows();
    assert.equal(back.status, "pending", "the add-on can still be paid");

    const again: any = await svc.submit(user, pdfReceipt(), { addonId: String(addon.id) });
    assert.equal(again.id, r.id, "the same payment row is reused");
    await svc.approve(ADMIN, again.id);
    const [a2] = await q(`select status from account_limit_addons where id = $1`, [addon.id]);
    assert.equal(a2.status, "active");
    assert.equal((await account()).subscription_status, "active", "the plan is untouched");
  });
});
