import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../finance-v2/__tests__/with-db";
import { planPrice } from "../../common/packages";
import { SubscriptionInvoiceService } from "./subscription-invoice.service";
import { RecurringBillingService, STALE_PROCESSING_MS } from "./recurring-billing.service";
import { DhamenBillingService } from "./dhamen-billing.module";

/**
 * Dhamen (Elm) checkout + renewals (customer-payment-subsequent) against a
 * throwaway Postgres schema, with Dhamen faked at `fetch` and email stubbed.
 * Nothing leaves the machine: any other outbound request fails the test.
 */

const U = 9301;
const BASE = "https://dhamen.test";
const DAY = 24 * 60 * 60 * 1000;

interface FakeStatus { paymentReferenceId: string; customerIdentifier: string; amount: number; paymentStatus: number; paymentStatusDetail: number; paymentBrand?: string; cardLast4Digits?: string; recurring: boolean }
const store = new Map<string, FakeStatus>();
const subsequent: Array<{ ref: string; original: string; amount: number }> = [];
const outbound: string[] = [];
const emails: Array<{ reason: string; final: boolean }> = [];
const realFetch = globalThis.fetch;
/** What the next subsequent charge does. */
let chargeMode: "paid" | "rejected" | "pending" | "lost_response" | "refused" = "paid";

function json(body: any, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function fakeFetch(input: any, init?: any): Promise<Response> {
  const url = String(input?.url ?? input);
  outbound.push(url);
  if (!url.startsWith(BASE)) return Promise.reject(new Error(`unexpected outbound request in a test: ${url}`));
  const body = init?.body ? JSON.parse(init.body) : {};
  const path = url.slice(BASE.length);
  if (path === "/api/payments/customer-payment") {
    if (store.has(body.paymentReferenceId)) return json({ messageCode: "C033", messageDescription: "PaymentReferenceId already exist" }, 412);
    const c = body.customerPayments[0];
    store.set(body.paymentReferenceId, { paymentReferenceId: body.paymentReferenceId, customerIdentifier: c.customerIdentifier, amount: c.amount, paymentStatus: 0, paymentStatusDetail: 1, recurring: !!body.enableRecurring });
    return json({ customerPayments: [{ customerIdentifier: c.customerIdentifier, paymentUrl: `${BASE}/pay/x`, invoiceId: `inv-${body.paymentReferenceId}` }] });
  }
  if (path === "/api/payments/customer-payment-status") {
    const s = store.get(body.paymentReferenceId);
    return s ? json([s]) : json({ messageCode: "InvPay010", messageDescription: "Invoice not found" }, 412);
  }
  if (path === "/api/payments/cancel") return json({ messageCode: 200, messageDescription: "Success" });
  if (path === "/api/payments/customer-payment-subsequent") {
    if (store.has(body.paymentReferenceId)) return json({ messageCode: "C033", messageDescription: "PaymentReferenceId already exist" }, 412);
    const orig = store.get(body.originalPaymentReferenceId);
    if (!orig || !orig.recurring || orig.paymentStatusDetail !== 3) return json({ messageCode: "C037", messageDescription: "original Request does not support Recurring payment" }, 412);
    if (chargeMode === "refused") return json({ messageCode: "C065", messageDescription: "Customer payment amount should be greater than fess amount" }, 412);
    subsequent.push({ ref: body.paymentReferenceId, original: body.originalPaymentReferenceId, amount: body.amount });
    const detail = chargeMode === "rejected" ? 4 : chargeMode === "pending" ? 2 : 3;
    store.set(body.paymentReferenceId, { paymentReferenceId: body.paymentReferenceId, customerIdentifier: body.customerIdentifier, amount: body.amount, paymentStatus: detail === 3 ? 1 : 0, paymentStatusDetail: detail, paymentBrand: "MADA", cardLast4Digits: "0007", recurring: false });
    if (chargeMode === "lost_response") return json({ message: "gateway timeout" }, 504);
    return json({ customerIdentifier: body.customerIdentifier, invoiceId: `inv-${body.paymentReferenceId}` });
  }
  return Promise.reject(new Error(`unexpected Dhamen path in a test: ${path}`));
}

/** What the customer does in Dhamen's widget: pay the open payment. */
function widgetPays(ref: string) {
  const s = store.get(ref)!;
  Object.assign(s, { paymentStatus: 1, paymentStatusDetail: 3, paymentBrand: "MADA", cardLast4Digits: "0007" });
}

const drainAsync = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); };

describe("Dhamen checkout and renewals (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let svc: RecurringBillingService;
  let dhamen: DhamenBillingService;
  const q = async (s: string, p: unknown[] = []) => (await t.pool.query(s, p)).rows;
  const user = { id: U, ownerUserId: null } as any;
  const quarterly = planPrice("basic", "quarterly")!;
  const env: Record<string, string | undefined> = {};
  const ENV = {
    DHAMEN_BASE_URL: BASE, DHAMEN_APP_ID: "a", DHAMEN_APP_KEY: "k", DHAMEN_CLIENT_ID: "c", DHAMEN_ENV_TAG: "S",
    DHAMEN_NOTIFY_CLIENT_ID: "dh", DHAMEN_NOTIFY_SECRET: "secret-for-tests",
    BILLING_DHAMEN_USERS: String(U), BILLING_TOKENIZATION_ENABLED: "true",
    MOYASAR_SECRET_KEY: undefined, RESEND_API_KEY: undefined, BILLING_EMAIL_ALLOWLIST: undefined, BILLING_DHAMEN_ENABLED: undefined,
  } as Record<string, string | undefined>;

  before(async () => {
    for (const [k, v] of Object.entries(ENV)) { env[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    globalThis.fetch = fakeFetch as any;
    t = await withDb({ legacy: "full", migrate: false });
    await t.apply(join(__dirname, "../../../db/drizzle/0096_linked_accounts.sql"));
    await t.apply(join(__dirname, "../../../db/drizzle/0097_moyasar_tokenization.sql"));
    await t.apply(join(__dirname, "../../../db/drizzle/0098_linked_member_prices.sql"));
    await t.apply(join(__dirname, "../../../db/drizzle/0099_bank_transfer.sql"));
    await t.apply(join(__dirname, "../../../db/drizzle/0103_subscription_gateway.sql"));
    const db = drizzle(t.pool, { schema }) as any;
    const pdf = { htmlToPdf: async () => Buffer.from("%PDF-1.4 stub") } as any;
    const email = {
      isConfigured: () => true,
      sendSubscriptionInvoice: async () => true,
      sendAdminPaymentReceived: async () => true,
      sendRenewalCardAction: async (_to: string, _n: string, p: any) => { emails.push({ reason: p.reason, final: p.final }); return true; },
    } as any;
    const appLog = { record: () => {} } as any;
    const invoices = new SubscriptionInvoiceService(pdf, email, appLog);
    svc = new RecurringBillingService(db, invoices, email, appLog);
    dhamen = new DhamenBillingService(db, svc, appLog);
  });
  after(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await t?.drop();
  });
  beforeEach(async () => {
    store.clear(); subsequent.length = 0; outbound.length = 0; emails.length = 0; chargeMode = "paid";
    await q(`delete from subscription_payments`);
    await q(`delete from payment_methods`);
    await q(`delete from users where id = $1`, [U]);
    await q(`insert into users (id, email, password_hash, name, user_type, package_plan, subscription_status, billing_cycle)
             values ($1, 'dhamen-spec@example.test', 'x', 'Synthetic', 'company', 'basic', 'pending_payment', 'quarterly')`, [U]);
  });

  const account = async () => (await q(`select subscription_status, subscription_ends_at, auto_renew, next_billing_at, billing_state,
                                          billing_failed_attempts, default_payment_method_id from users where id = $1`, [U]))[0];
  const methods = () => q(`select id, gateway, gateway_ref, moyasar_token_id, status, is_default, brand, last4 from payment_methods where user_id = $1 order by id`, [U]);
  const rows = () => q(`select id, status, charge_type, gateway, gateway_ref, attempt, failure_reason from subscription_payments where user_id = $1 order by id`, [U]);
  const refOf = async (id: number) => (await q(`select gateway_ref from subscription_payments where id = $1`, [id]))[0].gateway_ref as string;

  async function subscribe() {
    const cfg: any = await dhamen.startCheckout(user, { plan: "basic", cycle: "quarterly" });
    const ref = await refOf(cfg.paymentId);
    widgetPays(ref);
    const r = await dhamen.complete(user, cfg.paymentId);
    await drainAsync();
    return { cfg, ref, r };
  }
  async function periodEnded(daysAgo = 0) {
    const end = new Date(Date.now() - daysAgo * DAY);
    await q(`update users set subscription_ends_at = $2, next_billing_at = $2 where id = $1`, [U, end]);
    return end;
  }

  it("a paid Dhamen checkout activates, saves its reference as the method and schedules the renewal", async () => {
    const { ref, r } = await subscribe();
    assert.equal(r.status, "paid");
    assert.equal(r.autoRenew, true);
    assert.ok(store.get(ref)!.recurring, "the first payment asked Dhamen for recurring");
    const a = await account();
    assert.equal(a.subscription_status, "active");
    assert.equal(a.auto_renew, true);
    assert.equal(new Date(a.next_billing_at).getTime(), new Date(a.subscription_ends_at).getTime());
    const [m] = await methods();
    assert.equal(m.gateway, "dhamen");
    assert.equal(m.gateway_ref, ref);
    assert.equal(m.moyasar_token_id, `dhamen:${ref}`);
    assert.equal(m.status, "active");
    assert.equal(m.last4, "0007");
    assert.equal(a.default_payment_method_id, m.id);
    const ov: any = await svc.overview(U);
    assert.equal(ov.paymentMethod.gateway, "dhamen");
    assert.equal(ov.paymentMethod.label, "mada •••• 0007");
  });

  it("an unpaid checkout activates nothing and saves no method", async () => {
    const cfg: any = await dhamen.startCheckout(user, { plan: "basic", cycle: "quarterly" });
    const r = await dhamen.complete(user, cfg.paymentId);
    assert.equal(r.status, "pending");
    assert.equal((await account()).subscription_status, "pending_payment");
    assert.equal((await methods()).length, 0);
  });

  it("renewal charges the original payment once and moves the window", async () => {
    const { ref } = await subscribe();
    const end = await periodEnded();
    const out = await svc.renewOne(U);
    assert.equal(out.status, "paid");
    assert.equal(subsequent.length, 1);
    assert.equal(subsequent[0]!.original, ref);
    assert.equal(subsequent[0]!.amount, quarterly);
    const a = await account();
    assert.ok(new Date(a.subscription_ends_at).getTime() > end.getTime(), "window extended from the old end");
    assert.equal(new Date(a.next_billing_at).getTime(), new Date(a.subscription_ends_at).getTime());
    const ren = (await rows()).filter((x: any) => x.charge_type === "renewal");
    assert.equal(ren.length, 1);
    assert.equal(ren[0].status, "paid");
    assert.equal(ren[0].gateway, "dhamen");
    // Running again: not due any more, nothing charged.
    assert.equal((await svc.renewOne(U)).status, "skipped");
    assert.equal(subsequent.length, 1);
  });

  it("running the job twice at once charges exactly once", async () => {
    await subscribe();
    await periodEnded();
    const outs = await Promise.all([svc.renewOne(U), svc.renewOne(U), svc.renewOne(U)]);
    assert.equal(outs.filter((o) => o.status === "paid").length, 1);
    assert.equal(subsequent.length, 1);
  });

  it("a run that died mid-call is recovered by its reference — never charged a second time", async () => {
    await subscribe();
    await periodEnded();
    chargeMode = "lost_response";
    const first = await svc.renewOne(U);
    assert.equal(first.status, "pending_unknown");
    assert.equal(subsequent.length, 1, "Dhamen did charge");
    await q(`update subscription_payments set updated_at = now() - ($1 || ' milliseconds')::interval where charge_type = 'renewal'`, [String(STALE_PROCESSING_MS + 60_000)]);
    chargeMode = "paid";
    const second = await svc.renewOne(U);
    assert.equal(second.status, "paid");
    assert.equal(subsequent.length, 1, "recovered by lookup, not charged again");
  });

  it("a declined renewal goes past due and retries on day 1 with a new reference", async () => {
    await subscribe();
    const end = await periodEnded();
    chargeMode = "rejected";
    const out: any = await svc.renewOne(U);
    assert.equal(out.status, "failed");
    assert.equal(out.final, false);
    const a = await account();
    assert.equal(a.billing_state, "past_due");
    assert.equal(a.billing_failed_attempts, 1);
    assert.equal(new Date(a.next_billing_at).getTime(), end.getTime() + DAY);
    assert.deepEqual(emails.map((e) => e.reason), ["charge_failed"]);
    const firstRef = (await rows()).find((x: any) => x.charge_type === "renewal").gateway_ref;
    chargeMode = "paid";
    const retry = await svc.renewOne(U, { force: true });
    assert.equal(retry.status, "paid");
    assert.equal(subsequent.length, 2);
    assert.notEqual(subsequent[1]!.ref, firstRef, "a retry is a new Dhamen payment");
    assert.equal((await account()).billing_state, "ok");
  });

  it("a pending renewal is settled by Dhamen's notification", async () => {
    await subscribe();
    await periodEnded();
    chargeMode = "pending";
    const out = await svc.renewOne(U);
    assert.equal(out.status, "pending_unknown");
    const ren = (await rows()).find((x: any) => x.charge_type === "renewal");
    assert.equal(ren.status, "processing");
    widgetPays(ren.gateway_ref); // Dhamen settles it later
    const res: any = await dhamen.notify({ "x-dhamen-client-id": "dh", "x-dhamen-secret": "secret-for-tests" }, {
      Header: { BatchId: "b1" },
      Notifications: [{ NotificationId: 1, NotificationType: "Deposit_Notification", Payment: { PaymentID: ren.gateway_ref, PaymentAmount: quarterly } }],
    });
    assert.equal(res.status, "SUCCESS");
    assert.equal((await rows()).find((x: any) => x.charge_type === "renewal").status, "paid");
    assert.equal((await account()).billing_state, "ok");
  });

  it("an original Dhamen will not charge again (C037) stops renewals and asks for a new card", async () => {
    const { ref } = await subscribe();
    await periodEnded();
    store.get(ref)!.recurring = false;
    const out = await svc.renewOne(U);
    assert.equal(out.status, "card_unusable");
    const [m] = await methods();
    assert.equal(m.status, "inactive");
    const a = await account();
    assert.equal(a.billing_state, "past_due");
    assert.equal(a.next_billing_at, null);
    assert.deepEqual(emails.map((e) => e.reason), ["card_unusable"]);
  });

  it("removing a Dhamen method calls nobody and stops renewals", async () => {
    await subscribe();
    outbound.length = 0;
    await svc.removeCard(user);
    assert.equal(outbound.length, 0);
    const a = await account();
    assert.equal(a.auto_renew, false);
    assert.equal(a.next_billing_at, null);
  });

  it("notifications without the right headers are refused", async () => {
    await assert.rejects(dhamen.notify({}, { Notifications: [] }), (e: any) => e?.getStatus?.() === 401);
    await assert.rejects(dhamen.notify({ "x-dhamen-client-id": "dh", "x-dhamen-secret": "nope" }, {}), (e: any) => e?.getStatus?.() === 401);
  });
});
