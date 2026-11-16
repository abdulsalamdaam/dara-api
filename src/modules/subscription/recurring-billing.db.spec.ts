import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../finance-v2/__tests__/with-db";
import { planPrice } from "../../common/packages";
import { moyasarAppTag } from "../../common/moyasar";
import { SubscriptionInvoiceService } from "./subscription-invoice.service";
import { SubscriptionWebhookController, registerTokenPaymentHandler } from "./subscription.module";
import { RecurringBillingService, STALE_PROCESSING_MS } from "./recurring-billing.service";

/**
 * Recurring billing with saved Moyasar tokens, against a throwaway Postgres
 * schema with Moyasar faked at `fetch` (payments + tokens) and the email
 * sender stubbed. Nothing leaves the machine: any other outbound request
 * fails the test.
 */

const SECRET = "whsec_test_only";
const U = 9201;
const MIG_0097 = join(__dirname, "../../../db/drizzle/0097_moyasar_tokenization.sql");
const DAY = 24 * 60 * 60 * 1000;

interface FakePayment { id: string; status: string; amount: number; currency: string; refunded: number; metadata: any; source: any; created_at: string; live: boolean; invoice_id: null }
interface FakeToken { id: string; status: string; brand: string; last_four: string; month: string; year: string; name: string }

const payments = new Map<string, FakePayment>();
const tokens = new Map<string, FakeToken>();
const charges: Array<{ givenId: string; token: string; amount: number }> = [];
const deletedTokens: string[] = [];
const outbound: string[] = [];
const emails: Array<{ to: string; reason: string; final: boolean }> = [];
const invoiceEmails: string[] = [];
const realFetch = globalThis.fetch;
/** What the next token charge does. */
let chargeMode: "paid" | "failed" | "initiated" | "lost_response" = "paid";

function json(body: any, status = 200) {
  return Promise.resolve(new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function fakeFetch(input: any, init?: any): Promise<Response> {
  const url = String(input?.url ?? input);
  const method = String(init?.method || "GET").toUpperCase();
  outbound.push(`${method} ${url}`);
  let m = url.match(/^https:\/\/api\.moyasar\.com\/v1\/payments(?:\/([^/]+))?$/);
  if (m) {
    if (method === "GET") { const p = payments.get(decodeURIComponent(m[1]!)); return p ? json(p) : json({ message: "not found" }, 404); }
    if (method === "POST") {
      const body = JSON.parse(init.body);
      const existing = payments.get(body.given_id);
      if (existing) return json(existing); // Moyasar: a repeated given_id returns the existing payment
      charges.push({ givenId: body.given_id, token: body.source.token, amount: body.amount });
      const tok = tokens.get(body.source.token);
      const status = !tok || tok.status !== "active" ? "failed" : chargeMode === "lost_response" ? "paid" : chargeMode;
      const p: FakePayment = {
        id: body.given_id, status, amount: body.amount, currency: body.currency, refunded: 0, metadata: body.metadata,
        source: { type: "token", company: tok?.brand, number: `4111-11XX-XXXX-${tok?.last_four}`, message: status === "failed" ? "INSUFFICIENT_FUNDS" : "APPROVED", transaction_url: status === "initiated" ? "https://3ds.test" : null },
        created_at: new Date().toISOString(), live: false, invoice_id: null,
      };
      payments.set(p.id, p);
      if (chargeMode === "lost_response") return json({ message: "gateway timeout" }, 504);
      return json(p, 201);
    }
  }
  m = url.match(/^https:\/\/api\.moyasar\.com\/v1\/tokens\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    if (method === "GET") { const t = tokens.get(id); return t ? json(t) : json({ message: "not found" }, 404); }
    if (method === "DELETE") { deletedTokens.push(id); tokens.delete(id); return json(null, 204); }
  }
  return Promise.reject(new Error(`unexpected outbound request in a test: ${method} ${url}`));
}

function newToken(status = "active", last4 = "1111"): FakeToken {
  const t = { id: `token_${randomUUID().replace(/-/g, "")}`, status, brand: "visa", last_four: last4, month: "12", year: "2030", name: "Test Card" };
  tokens.set(t.id, t);
  return t;
}

/** What Moyasar.js does in the browser: create the payment with save_card, and it settles. */
function browserPays(cfg: any, opts: { status?: string; type?: string; app?: string } = {}) {
  const tok = newToken();
  const p: FakePayment = {
    id: randomUUID(), status: opts.status ?? "paid", amount: cfg.amountHalalas, currency: cfg.currency, refunded: 0,
    metadata: { ...cfg.metadata, ...(opts.app ? { app: opts.app } : {}) },
    source: { type: opts.type ?? "creditcard", company: "visa", name: "Test Card", number: "4111-11XX-XXXX-1111", token: tok.id, message: "APPROVED" },
    created_at: new Date().toISOString(), live: false, invoice_id: null,
  };
  payments.set(p.id, p);
  return { payment: p, token: tok };
}

const drainAsync = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); };

describe("recurring billing with saved Moyasar tokens (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let svc: RecurringBillingService;
  let hook: SubscriptionWebhookController;
  const q = async (s: string, p: unknown[] = []) => (await t.pool.query(s, p)).rows;
  const user = { id: U, ownerUserId: null } as any;
  const quarterly = planPrice("basic", "quarterly")!;
  const env: Record<string, string | undefined> = {};
  const ENV_KEYS = ["MOYASAR_SECRET_KEY", "MOYASAR_PUBLISHABLE_KEY", "MOYASAR_WEBHOOK_SECRET", "RESEND_API_KEY", "BILLING_TOKENIZATION_ENABLED", "BILLING_APPLEPAY_RECURRING", "BILLING_EMAIL_ALLOWLIST"];

  before(async () => {
    for (const k of ENV_KEYS) env[k] = process.env[k];
    process.env.MOYASAR_SECRET_KEY = "sk_test_never_real";
    process.env.MOYASAR_PUBLISHABLE_KEY = "pk_test_never_real";
    process.env.MOYASAR_WEBHOOK_SECRET = SECRET;
    process.env.BILLING_TOKENIZATION_ENABLED = "true";
    delete process.env.BILLING_APPLEPAY_RECURRING;
    delete process.env.BILLING_EMAIL_ALLOWLIST;
    delete process.env.RESEND_API_KEY;
    globalThis.fetch = fakeFetch as any;

    t = await withDb({ legacy: "full", migrate: false });
    await t.apply(MIG_0097);
    const db = drizzle(t.pool, { schema }) as any;
    const pdf = { htmlToPdf: async () => Buffer.from("%PDF-1.4 stub") } as any;
    const email = {
      isConfigured: () => true,
      sendSubscriptionInvoice: async (to: string) => { invoiceEmails.push(to); return true; },
      sendAdminPaymentReceived: async () => true,
      sendRenewalCardAction: async (to: string, _n: string, p: any) => { emails.push({ to, reason: p.reason, final: p.final }); return true; },
    } as any;
    const appLog = { record: () => {} } as any;
    const invoices = new SubscriptionInvoiceService(pdf, email, appLog);
    svc = new RecurringBillingService(db, invoices, email, appLog);
    hook = new SubscriptionWebhookController(db, invoices, appLog);
    registerTokenPaymentHandler((row, p) => svc.applyVerifiedPayment(row, p));
  });
  after(async () => {
    registerTokenPaymentHandler(null);
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await t?.drop();
  });
  beforeEach(async () => {
    payments.clear(); tokens.clear(); charges.length = 0; deletedTokens.length = 0; outbound.length = 0; emails.length = 0; invoiceEmails.length = 0;
    chargeMode = "paid";
    await q(`delete from subscription_payments`);
    await q(`delete from payment_methods`);
    await q(`delete from users where id = $1`, [U]);
    await q(`insert into users (id, email, password_hash, name, user_type, package_plan, subscription_status, billing_cycle)
             values ($1, 'recurring-spec@example.test', 'x', 'Synthetic', 'company', 'basic', 'pending_payment', 'quarterly')`, [U]);
  });

  const account = async () => (await q(`select subscription_status, subscription_ends_at, auto_renew, next_billing_at, billing_state,
                                          billing_failed_attempts, default_payment_method_id from users where id = $1`, [U]))[0];
  const methods = () => q(`select id, moyasar_token_id, status, is_default, brand, last4, deleted_at from payment_methods where user_id = $1 order by id`, [U]);
  const rows = () => q(`select id, status, charge_type, attempt, renewal_of, moyasar_given_id, moyasar_payment_id, failure_reason from subscription_payments where user_id = $1 order by id`, [U]);

  /** A paid in-app checkout: the account is active with a saved card. */
  async function subscribeWithCard() {
    const cfg: any = await svc.startCheckout(user, { plan: "basic", cycle: "quarterly" });
    const { payment, token } = browserPays(cfg);
    await svc.recordCheckoutPayment(user, cfg.paymentId, payment.id);
    const r = await svc.completeCheckout(user, cfg.paymentId, payment.id);
    await drainAsync();
    return { cfg, payment, token, r };
  }

  /** Move the paid window so it ended `daysAgo` days before `now`, and make renewal due. */
  async function periodEnded(daysAgo = 0) {
    const end = new Date(Date.now() - daysAgo * DAY);
    await q(`update users set subscription_ends_at = $2, next_billing_at = $2 where id = $1`, [U, end]);
    return end;
  }

  it("first payment saves the token, activates the subscription and schedules the renewal", async () => {
    const { cfg, token, r } = await subscribeWithCard();
    assert.equal(cfg.saveCard, true);
    assert.equal(cfg.metadata.app, moyasarAppTag());
    assert.equal(r.status, "paid");
    assert.equal(r.autoRenew, true);
    const a = await account();
    assert.equal(a.subscription_status, "active");
    assert.equal(a.auto_renew, true);
    assert.ok(a.subscription_ends_at, "window opened");
    assert.equal(new Date(a.next_billing_at).getTime(), new Date(a.subscription_ends_at).getTime(), "renewal due at the period end");
    const [m] = await methods();
    assert.equal(m.moyasar_token_id, token.id);
    assert.equal(m.status, "active");
    assert.equal(m.is_default, true);
    assert.equal(m.last4, "1111");
    assert.equal(a.default_payment_method_id, m.id);
    assert.equal(charges.length, 0, "the first payment is the browser's, not a server charge");
    // Completing again (a refresh) changes nothing.
    await svc.completeCheckout(user, cfg.paymentId, null);
    assert.equal((await rows()).filter((x: any) => x.status === "paid").length, 1);
  });

  it("the browser's redirect alone activates nothing: an unpaid payment leaves the account pending", async () => {
    const cfg: any = await svc.startCheckout(user, { plan: "basic", cycle: "quarterly" });
    const { payment } = browserPays(cfg, { status: "initiated" });
    const r = await svc.completeCheckout(user, cfg.paymentId, payment.id);
    assert.equal(r.status, "initiated");
    assert.equal((await account()).subscription_status, "pending_payment");
    assert.equal((await methods()).length, 0);
  });

  it("a paid payment made by the OTHER environment (shared Moyasar account) is not matched", async () => {
    const cfg: any = await svc.startCheckout(user, { plan: "basic", cycle: "quarterly" });
    const { payment } = browserPays(cfg, { app: "app.someone-else.test" });
    const r = await svc.completeCheckout(user, cfg.paymentId, payment.id);
    assert.equal(r.status, "mismatch");
    assert.equal((await account()).subscription_status, "pending_payment");
  });

  it("the webhook alone (user closed the tab) verifies the payment with Moyasar and saves the card", async () => {
    const cfg: any = await svc.startCheckout(user, { plan: "basic", cycle: "quarterly" });
    const { payment } = browserPays(cfg);
    // The payload lies about nothing here, but is never trusted: the handler GETs the payment.
    const res: any = await hook.webhook({ secret_token: SECRET, type: "payment_paid", data: { id: payment.id, status: "paid", metadata: payment.metadata } }, {});
    await drainAsync();
    assert.equal(res.activated, true);
    assert.ok(outbound.includes(`GET https://api.moyasar.com/v1/payments/${payment.id}`));
    assert.equal((await account()).auto_renew, true);
    assert.equal((await methods()).length, 1);
  });

  it("renewal success: charges the token once, extends the window from the old end, reschedules", async () => {
    const { token } = await subscribeWithCard();
    const end = await periodEnded(0);
    const out = await svc.runDue(new Date(end.getTime() + 60_000));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.outcome.status, "paid");
    assert.equal(charges.length, 1);
    assert.equal(charges[0]!.token, token.id);
    assert.equal(charges[0]!.amount, Math.round(quarterly * 100));
    const a = await account();
    const expectedEnd = new Date(end); expectedEnd.setMonth(expectedEnd.getMonth() + 3);
    assert.equal(new Date(a.subscription_ends_at).getTime(), expectedEnd.getTime(), "stacked on the old end, one quarter");
    assert.equal(new Date(a.next_billing_at).getTime(), expectedEnd.getTime());
    assert.equal(a.billing_state, "ok");
    const renewal = (await rows()).find((x: any) => x.charge_type === "renewal");
    assert.equal(renewal.status, "paid");
    assert.equal(new Date(renewal.renewal_of).getTime(), end.getTime());
  });

  it("running the job twice — concurrently, then again — charges exactly once", async () => {
    await subscribeWithCard();
    const end = await periodEnded(0);
    const now = new Date(end.getTime() + 60_000);
    await Promise.all([svc.runDue(now), svc.runDue(now), svc.renewOne(U, { now })]);
    await svc.runDue(now);
    await svc.runDue(new Date(now.getTime() + DAY));
    assert.equal(charges.length, 1, `charges: ${JSON.stringify(charges)}`);
    assert.equal((await rows()).filter((x: any) => x.charge_type === "renewal").length, 1);
  });

  it("a run that died mid-charge is recovered by its given_id — never charged a second time", async () => {
    await subscribeWithCard();
    const end = await periodEnded(0);
    chargeMode = "lost_response"; // Moyasar charged, but our side never heard
    const first = await svc.renewOne(U, { now: new Date(end.getTime() + 60_000) });
    assert.equal(first.status, "pending_unknown");
    assert.equal((await rows()).find((x: any) => x.charge_type === "renewal").status, "processing");
    chargeMode = "paid";
    // Too early: another runner may still be in that call.
    const busy = await svc.renewOne(U, { now: new Date(end.getTime() + 120_000) });
    assert.equal(busy.status, "in_flight");
    // Later: the row is stale; the payment is looked up, not re-created.
    const later = await svc.renewOne(U, { now: new Date(Date.now() + STALE_PROCESSING_MS + 60_000) });
    assert.equal(later.status, "paid");
    assert.equal(charges.length, 1);
    assert.equal((await account()).billing_state, "ok");
  });

  it("renewal failure → past_due, retries on day 1, 3 and 7, then stops (grace still decides the lock)", async () => {
    await subscribeWithCard();
    const end = await periodEnded(0);
    chargeMode = "failed";
    const at = (d: number) => new Date(end.getTime() + d * DAY + 60_000);

    let o: any = (await svc.runDue(at(0)))[0]!.outcome;
    assert.equal(o.status, "failed");
    let a = await account();
    assert.equal(a.billing_state, "past_due");
    assert.equal(a.billing_failed_attempts, 1);
    assert.equal(new Date(a.next_billing_at).getTime(), end.getTime() + 1 * DAY);
    assert.equal((await svc.runDue(at(0.5))).length, 0, "not retried before day 1");

    for (const [day, next] of [[1, 3], [3, 7]] as const) {
      o = (await svc.runDue(at(day)))[0]!.outcome;
      assert.equal(o.status, "failed");
      a = await account();
      assert.equal(new Date(a.next_billing_at).getTime(), end.getTime() + next * DAY);
    }
    o = (await svc.runDue(at(7)))[0]!.outcome;
    assert.equal(o.final, true);
    a = await account();
    assert.equal(a.billing_failed_attempts, 4);
    assert.equal(a.next_billing_at, null, "no more automatic attempts");
    assert.equal(a.subscription_status, "active", "the stored status is untouched — grace/lock is derived from the end date");
    assert.equal((await svc.runDue(at(14))).length, 0);

    assert.equal(charges.length, 4);
    assert.equal(new Set(charges.map((c) => c.givenId)).size, 4, "each attempt has its own given_id");
    const renewalRows = (await rows()).filter((x: any) => x.charge_type === "renewal");
    assert.equal(renewalRows.length, 1, "one row per period, attempts counted on it");
    assert.equal(renewalRows[0].attempt, 4);
    assert.deepEqual(emails.map((e) => [e.reason, e.final]), [["charge_failed", false], ["charge_failed", false], ["charge_failed", false], ["charge_failed", true]]);

    // A new card while the renewal is owed is charged on the next run.
    chargeMode = "paid";
    const fresh = newToken("active", "4242");
    await svc.replaceCard(user, fresh.id);
    a = await account();
    assert.equal(a.billing_state, "ok", "a new card clears the update-your-card warning");
    assert.equal(a.billing_failed_attempts, 0, "the old card's failures do not count against the new one");
    o = (await svc.runDue(new Date(Date.now() + 60_000)))[0]!.outcome;
    assert.equal(o.status, "paid");
    a = await account();
    assert.equal(a.billing_state, "ok");
    assert.equal(a.billing_failed_attempts, 0);
  });

  it("an inactive/expired token is never charged — the user is asked to update the card", async () => {
    const { token } = await subscribeWithCard();
    tokens.get(token.id)!.status = "inactive";
    const end = await periodEnded(0);
    const o: any = (await svc.runDue(new Date(end.getTime() + 60_000)))[0]!.outcome;
    assert.equal(o.status, "card_unusable");
    assert.equal(charges.length, 0);
    const a = await account();
    assert.equal(a.billing_state, "past_due");
    assert.equal(a.next_billing_at, null);
    assert.equal((await methods())[0].status, "inactive");
    assert.deepEqual(emails.map((e) => e.reason), ["card_unusable"]);
  });

  it("issuer demands 3DS on a renewal → no automatic retry, the user is asked to pay", async () => {
    await subscribeWithCard();
    const end = await periodEnded(0);
    chargeMode = "initiated";
    const o: any = (await svc.runDue(new Date(end.getTime() + 60_000)))[0]!.outcome;
    assert.equal(o.status, "failed");
    assert.equal(o.reason, "requires_3ds");
    assert.equal((await account()).next_billing_at, null);
    assert.deepEqual(emails.map((e) => e.reason), ["action_required"]);
  });

  it("card replace: the new verified token becomes default and the old one is deleted at Moyasar", async () => {
    const { token: old } = await subscribeWithCard();
    const next = newToken("active", "4242");
    const ov: any = await svc.replaceCard(user, next.id);
    assert.equal(ov.paymentMethod.last4, "4242");
    assert.deepEqual(deletedTokens, [old.id]);
    const ms = await methods();
    assert.deepEqual(ms.map((m: any) => [m.moyasar_token_id, m.status, m.is_default]), [[old.id, "deleted", false], [next.id, "active", true]]);
    // An unverified (3DS not completed) token is refused.
    const pending = newToken("initiated", "0000");
    await assert.rejects(() => svc.replaceCard(user, pending.id));
  });

  it("cancel stops renewals (and deletes the token when asked); resume needs a card", async () => {
    const { token } = await subscribeWithCard();
    await svc.cancel(user, true);
    let a = await account();
    assert.equal(a.auto_renew, false);
    assert.equal(a.billing_state, "canceled");
    assert.equal(a.next_billing_at, null);
    assert.deepEqual(deletedTokens, [token.id]);
    const end = await periodEnded(0);
    assert.equal((await svc.runDue(new Date(end.getTime() + 60_000))).length, 0);
    assert.equal(charges.length, 0);
    await assert.rejects(() => svc.resume(user));
    a = await account();
    assert.equal(a.subscription_status, "active", "the paid window is untouched");
  });

  it("Apple Pay: the token is not kept for renewals unless BILLING_APPLEPAY_RECURRING is on", async () => {
    const cfg: any = await svc.startCheckout(user, { plan: "basic", cycle: "quarterly" });
    const { payment } = browserPays(cfg, { type: "applepay" });
    const r = await svc.completeCheckout(user, cfg.paymentId, payment.id);
    assert.equal(r.status, "paid");
    assert.equal(r.autoRenew, false);
    const a = await account();
    assert.equal(a.subscription_status, "active");
    assert.equal(a.auto_renew, false);
    assert.equal((await methods()).length, 0);
  });

  it("production test account: opted in by id, charged the test price on checkout and renewal", async () => {
    delete process.env.BILLING_TOKENIZATION_ENABLED;
    process.env.BILLING_TOKENIZATION_USERS = String(U);
    process.env.BILLING_TEST_PRICE_USERS = `${U}=5`;
    try {
      const other = { id: U + 1000, ownerUserId: null } as any;
      await assert.rejects(() => svc.startCheckout(other, { plan: "basic", cycle: "quarterly" }), "everyone else keeps the invoice flow");
      const { cfg } = await subscribeWithCard();
      assert.equal(cfg.amount, 5);
      assert.equal(cfg.amountHalalas, 500);
      const end = await periodEnded(0);
      const out = await svc.runDue(new Date(end.getTime() + 60_000));
      assert.equal(out[0]!.outcome.status, "paid");
      assert.equal(charges[0]!.amount, 500, "the renewal charges the test price too");
    } finally {
      process.env.BILLING_TOKENIZATION_ENABLED = "true";
      delete process.env.BILLING_TOKENIZATION_USERS;
      delete process.env.BILLING_TEST_PRICE_USERS;
    }
  });

  it("BILLING_EMAIL_ALLOWLIST: renewal emails go only to listed addresses (staging)", async () => {
    process.env.BILLING_EMAIL_ALLOWLIST = "abdulsalam@example.test";
    try {
      await subscribeWithCard();
      const end = await periodEnded(0);
      chargeMode = "failed";
      await svc.runDue(new Date(end.getTime() + 60_000));
      assert.equal(emails.length, 0);
    } finally {
      delete process.env.BILLING_EMAIL_ALLOWLIST;
    }
  });
});
