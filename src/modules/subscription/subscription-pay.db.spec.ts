import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../finance-v2/__tests__/with-db";
import { planPrice } from "../../common/packages";
import { SubscriptionInvoiceService } from "./subscription-invoice.service";
import { SubscriptionController, SubscriptionWebhookController } from "./subscription.module";
import { LimitsBillingService } from "../limits/limits-billing.service";
import { AddonCatalogService } from "../limits/addon-catalog.service";

/**
 * "Opening a payment emailed me a PAID invoice." The subscription pay endpoint
 * self-heals an earlier pending row when Moyasar calls its invoice paid, and
 * the webhook activates on Moyasar's word — both send the "paid" invoice
 * email. These run the REAL controllers against a throwaway Postgres schema
 * with Moyasar mocked at `fetch` and the email sender stubbed: nothing leaves
 * the machine, and any unexpected outbound request fails the test.
 */

const SECRET = "whsec_test_only";
const U = 9101;
const OTHER = 9102;

interface FakeInvoice {
  id: string; status: string; amount: number; currency: string; url: string;
  metadata: Record<string, any>; payments: any[];
}

const moyasar = new Map<string, FakeInvoice>();
const outbound: string[] = [];
const sent: Array<{ to: string; invoiceNumber: string }> = [];
const logs: any[] = [];
const realFetch = globalThis.fetch;

function fakeFetch(input: any, init?: any): Promise<Response> {
  const url = String(input?.url ?? input);
  const method = String(init?.method || "GET").toUpperCase();
  outbound.push(`${method} ${url}`);
  const json = (body: any, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  const m = url.match(/^https:\/\/api\.moyasar\.com\/v1\/invoices(?:\/([^/]+))?(\/cancel)?$/);
  if (!m) return Promise.reject(new Error(`unexpected outbound request in a test: ${method} ${url}`));
  if (method === "POST" && !m[1]) {
    const body = JSON.parse(init.body);
    const id = randomUUID();
    const inv: FakeInvoice = {
      id, status: "initiated", amount: body.amount, currency: body.currency,
      url: `https://checkout.moyasar.test/invoices/${id}`, metadata: body.metadata ?? {}, payments: [],
    };
    moyasar.set(id, inv);
    return json(inv, 201);
  }
  const inv = m[1] ? moyasar.get(m[1]) : undefined;
  if (!inv) return json({ message: "not found" }, 404);
  if (m[2]) {
    if (inv.status !== "initiated") return json({ message: "cannot cancel" }, 400);
    inv.status = "canceled";
    return json(inv);
  }
  return json(inv);
}

/** Moyasar marks the invoice paid by a settled payment (the real shape seen on staging). */
function settle(invId: string, over: Partial<{ status: string; payStatus: string; amount: number; refunded: number }> = {}) {
  const inv = moyasar.get(invId)!;
  const pay = {
    id: randomUUID(), status: over.payStatus ?? "paid", amount: over.amount ?? inv.amount, currency: inv.currency,
    captured: 0, refunded: over.refunded ?? 0, invoice_id: inv.id, metadata: null, created_at: "2026-09-29T08:11:14.608Z",
  };
  inv.status = over.status ?? "paid";
  inv.payments.push(pay);
  return pay;
}

/** Let the fire-and-forget invoice issue (render + send) finish. */
const drainAsync = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); };

describe("subscription: no PAID email or paid state before a verified payment (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let pay: SubscriptionController;
  let hook: SubscriptionWebhookController;
  const q = async (sql: string, p: unknown[] = []) => (await t.pool.query(sql, p)).rows;
  const user = { id: U, ownerUserId: null } as any;
  const amount = planPrice("basic", "monthly")!;
  const env: Record<string, string | undefined> = {};

  before(async () => {
    for (const k of ["MOYASAR_SECRET_KEY", "MOYASAR_WEBHOOK_SECRET", "RESEND_API_KEY"]) env[k] = process.env[k];
    process.env.MOYASAR_SECRET_KEY = "sk_test_never_real";
    process.env.MOYASAR_WEBHOOK_SECRET = SECRET;
    delete process.env.RESEND_API_KEY;
    globalThis.fetch = fakeFetch as any;

    t = await withDb({ legacy: "full", migrate: false });
    const db = drizzle(t.pool, { schema }) as any;
    const pdf = { htmlToPdf: async () => Buffer.from("%PDF-1.4 stub") } as any;
    const email = {
      isConfigured: () => true,
      sendSubscriptionInvoice: async (to: string, _name: string, p: any) => { sent.push({ to, invoiceNumber: p.invoiceNumber }); return true; },
    } as any;
    const appLog = { record: (e: any) => { logs.push(e); } } as any;
    const invoices = new SubscriptionInvoiceService(pdf, email, appLog);
    pay = new SubscriptionController(db, invoices, appLog);
    hook = new SubscriptionWebhookController(db, invoices, appLog);
  });
  after(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await t?.drop();
  });
  beforeEach(async () => {
    moyasar.clear(); outbound.length = 0; sent.length = 0; logs.length = 0;
    await q(`delete from subscription_payments`);
    await q(`delete from users where id in ($1, $2)`, [U, OTHER]);
    for (const id of [U, OTHER]) {
      await q(`insert into users (id, email, password_hash, name, user_type, package_plan, subscription_status, billing_cycle)
               values ($1, $2, 'x', 'Synthetic', 'company', 'basic', 'pending_payment', 'monthly')`, [id, `sub-spec-${id}@example.test`]);
    }
  });

  const rowsOf = (uid = U) => q(`select id, status, paid_at, moyasar_payment_id, moyasar_invoice_id, invoice_emailed_at, plan
                                  from subscription_payments where user_id = $1 order by id`, [uid]);
  const account = async (uid = U) => (await q(`select package_plan, subscription_status, subscription_ends_at from users where id = $1`, [uid]))[0];
  const webhookFor = (invId: string, payment: any, over: Record<string, any> = {}) =>
    hook.webhook({ secret_token: SECRET, type: `payment_${payment.status}`, data: { ...payment, invoice_id: invId, ...over } }, {});

  it("opening a payment creates a pending row and a checkout link — no email, nothing paid, account untouched", async () => {
    const r: any = await pay.pay(user, { plan: "basic", cycle: "monthly" });
    assert.ok(r.url, "a checkout URL is returned");
    assert.equal(r.alreadyPaid, undefined);
    // Opening it again while still unpaid hands back the same link, still nothing paid.
    const again: any = await pay.pay(user, { plan: "basic", cycle: "monthly" });
    assert.equal(again.reused, true);
    assert.equal(again.url, r.url);
    await drainAsync();
    const rows = await rowsOf();
    assert.deepEqual(rows.map((x: any) => [x.status, x.paid_at, x.invoice_emailed_at]), [["pending", null, null]]);
    const a = await account();
    assert.equal(a.subscription_status, "pending_payment");
    assert.equal(a.subscription_ends_at, null);
    assert.equal(sent.length, 0, "no invoice email");
    assert.ok(outbound.every((o) => o.includes("api.moyasar.com")), "only (mocked) Moyasar was called");
  });

  // Every non-success Moyasar answer, through BOTH paths that can activate.
  const notPaid: Array<[string, (invId: string) => any]> = [
    ["initiated (checkout opened, nothing paid)", () => null],
    ["failed", (id) => settle(id, { status: "failed", payStatus: "failed" })],
    ["authorized but not captured", (id) => settle(id, { status: "paid", payStatus: "authorized" })],
    ["paid for a different amount", (id) => settle(id, { amount: 5000 })],
    ["paid then refunded", (id) => settle(id, { refunded: 100 })],
    ["paid, but the invoice is for another amount", (id) => { moyasar.get(id)!.amount = 5000; return settle(id); }],
    ["paid, but in another currency", (id) => { moyasar.get(id)!.currency = "USD"; return settle(id); }],
  ];
  for (const [label, mutate] of notPaid) {
    it(`Moyasar says "${label}" → the pay endpoint's self-heal sends nothing and marks nothing paid`, async () => {
      const r: any = await pay.pay(user, { plan: "basic", cycle: "monthly" });
      mutate(r.invoiceId);
      // The user opens the payment page again (or for another plan).
      await pay.pay(user, { plan: "professional", cycle: "monthly" });
      await drainAsync();
      const rows = await rowsOf();
      assert.ok(rows.every((x: any) => x.status !== "paid" && x.invoice_emailed_at == null), JSON.stringify(rows));
      assert.equal((await account()).subscription_status, "pending_payment");
      assert.equal(sent.length, 0);
    });

    it(`Moyasar says "${label}" → the webhook sends nothing and marks nothing paid`, async () => {
      const r: any = await pay.pay(user, { plan: "basic", cycle: "monthly" });
      const p = mutate(r.invoiceId) ?? { id: randomUUID(), status: "initiated", amount: Math.round(amount * 100), currency: "SAR" };
      await webhookFor(r.invoiceId, p);
      await drainAsync();
      const [row] = await rowsOf();
      assert.equal(row.status, "pending");
      assert.equal((await account()).subscription_status, "pending_payment");
      assert.equal(sent.length, 0);
    });
  }

  it("a paid webhook whose own payload claims 'paid' is still refused when Moyasar's invoice is unpaid", async () => {
    const r: any = await pay.pay(user, { plan: "basic", cycle: "monthly" });
    const res: any = await webhookFor(r.invoiceId, { id: randomUUID(), status: "paid", amount: Math.round(amount * 100), currency: "SAR" });
    await drainAsync();
    assert.equal(res.ignored, true);
    assert.equal((await rowsOf())[0].status, "pending");
    assert.equal(sent.length, 0);
  });

  it("a paid invoice belonging to a different row/account (shared Moyasar account) is never matched by metadata", async () => {
    // A local pending row for ANOTHER account with id N, and a paid Moyasar
    // invoice we never created here whose metadata happens to say row N.
    const other: any = await pay.pay({ id: OTHER, ownerUserId: null } as any, { plan: "basic", cycle: "monthly" });
    const foreignId = randomUUID();
    moyasar.set(foreignId, {
      id: foreignId, status: "initiated", amount: Math.round(amount * 100), currency: "SAR", url: "x",
      metadata: { subscriptionPaymentId: String(other.paymentId), userId: "777777" }, payments: [],
    });
    const p = settle(foreignId);
    const res: any = await hook.webhook({ secret_token: SECRET, data: { ...p, metadata: { subscriptionPaymentId: String(other.paymentId) } } }, {});
    await drainAsync();
    assert.equal(res.unmatched, true);
    assert.equal((await rowsOf(OTHER))[0].status, "pending");
    assert.equal((await account(OTHER)).subscription_status, "pending_payment");
    assert.equal(sent.length, 0);
  });

  it("a verified payment sends exactly ONE invoice email when the webhook and the pay-page self-heal both arrive", async () => {
    const r: any = await pay.pay(user, { plan: "basic", cycle: "monthly" });
    const p = settle(r.invoiceId);
    // Webhook, its retry and the user's return/re-click all at once.
    const [w1, s1, w2] = await Promise.all([
      webhookFor(r.invoiceId, p),
      pay.pay(user, { plan: "basic", cycle: "monthly" }),
      webhookFor(r.invoiceId, p),
    ]) as any[];
    await drainAsync();
    // And once more after everything settled.
    const s2: any = await pay.pay(user, { plan: "basic", cycle: "monthly" });
    const w3: any = await webhookFor(r.invoiceId, p);
    await drainAsync();

    assert.equal(sent.length, 1, `exactly one email, got ${JSON.stringify(sent)}`);
    assert.equal(sent[0].to, `sub-spec-${U}@example.test`);
    // Exactly one caller won the paid transition (a webhook, or the pay page's self-heal).
    const winners = [w1, w2, w3].filter((x) => x.activated).length + (s1.alreadyPaid ? 1 : 0);
    assert.ok(winners >= 1 && [w1, w2, w3].filter((x) => x.activated).length <= 1, JSON.stringify([w1, s1, w2, w3]));
    const rows = await rowsOf();
    const paid = rows.filter((x: any) => x.status === "paid");
    assert.equal(paid.length, 1);
    assert.equal(paid[0].moyasar_payment_id, p.id, "the settled Moyasar payment is recorded");
    assert.equal(new Date(paid[0].paid_at).toISOString(), "2026-09-29T08:11:14.608Z", "paid_at is when the money moved");
    assert.ok(paid[0].invoice_emailed_at);
    assert.equal((await account()).subscription_status, "active");
    // The self-heal never sends the user back to a checkout page Moyasar shows as PAID.
    if (s1.alreadyPaid) assert.equal(s1.url, undefined);
    assert.ok(s2.url, "after activation a new Pay opens a fresh checkout");
    assert.notEqual(s2.url, r.url);
  });

  it("the self-heal on opening a payment reports an earlier verified payment without redirecting to its paid checkout", async () => {
    const r: any = await pay.pay(user, { plan: "basic", cycle: "monthly" });
    settle(r.invoiceId);
    const res: any = await pay.pay(user, { plan: "professional", cycle: "monthly" });
    await drainAsync();
    assert.equal(res.alreadyPaid, true);
    assert.equal(res.url, undefined);
    assert.equal(res.plan, "basic");
    assert.equal(sent.length, 1);
    assert.equal((await rowsOf()).filter((x: any) => x.status === "paid").length, 1);
  });
});

/**
 * Account-limit add-on payments (kind='addon') share subscription_payments,
 * the webhook and /sync with plan payments. They must stay independent: paying
 * the plan never cancels an open add-on invoice, and an add-on payment never
 * touches package_plan or the subscription period.
 */
describe("subscription vs add-on payments are independent (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let pay: SubscriptionController;
  let hook: SubscriptionWebhookController;
  let billing: LimitsBillingService;
  const A = 9111;
  const q = async (sql: string, p: unknown[] = []) => (await t.pool.query(sql, p)).rows;
  const user = { id: A, ownerUserId: null } as any;
  const env: Record<string, string | undefined> = {};
  const started = new Date("2026-09-01T00:00:00Z");
  const ends = new Date(Date.now() + 75 * 86_400_000);

  before(async () => {
    for (const k of ["MOYASAR_SECRET_KEY", "MOYASAR_WEBHOOK_SECRET", "RESEND_API_KEY", "DARA_SELLER_VAT"]) env[k] = process.env[k];
    process.env.MOYASAR_SECRET_KEY = "sk_test_never_real";
    process.env.MOYASAR_WEBHOOK_SECRET = SECRET;
    delete process.env.RESEND_API_KEY;
    delete process.env.DARA_SELLER_VAT;
    globalThis.fetch = fakeFetch as any;
    t = await withDb({ legacy: "full", migrate: false });
    const db = drizzle(t.pool, { schema }) as any;
    const pdf = { htmlToPdf: async () => Buffer.from("%PDF-1.4 stub") } as any;
    const email = {
      isConfigured: () => true,
      sendSubscriptionInvoice: async (to: string, _name: string, p: any) => { sent.push({ to, invoiceNumber: p.invoiceNumber, itemLabel: p.itemLabel } as any); return true; },
    } as any;
    const appLog = { record: (e: any) => { logs.push(e); } } as any;
    const invoices = new SubscriptionInvoiceService(pdf, email, appLog);
    pay = new SubscriptionController(db, invoices, appLog);
    hook = new SubscriptionWebhookController(db, invoices, appLog);
    billing = new LimitsBillingService(db, new AddonCatalogService(db));
  });
  after(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await t?.drop();
  });
  beforeEach(async () => {
    moyasar.clear(); outbound.length = 0; sent.length = 0; logs.length = 0;
    await q(`delete from account_limit_events`); await q(`delete from account_limit_addons`);
    await q(`delete from subscription_payments`);
    await q(`delete from users where id = $1`, [A]);
    await q(`insert into users (id, email, password_hash, name, user_type, package_plan, subscription_status, billing_cycle,
                                subscription_started_at, subscription_ends_at, subscription_is_trial)
             values ($1, $2, 'x', 'Synthetic', 'company', 'basic', 'active', 'quarterly', $3, $4, false)`,
      [A, `addon-spec-${A}@example.test`, started, ends]);
  });

  /** An admin-invoiced seat add-on with its open Moyasar invoice (the real billing service). */
  const openAddon = async (priceSar = "100.00") => {
    const [addon] = await q(`insert into account_limit_addons (account_id, limit_key, quantity, period, status, activation, source, price_sar)
                             values ($1, 'users', 2, 'subscription_period', 'pending_payment', 'on_payment', 'admin_invoice', $2) returning *`, [A, priceSar]);
    const camel = { id: addon.id, accountId: A, limitKey: "users", quantity: 2, period: "subscription_period", priceSar,
      catalogKey: null, endsAt: null, status: "pending_payment", paymentId: null } as any;
    const r = await billing.createAddonPayment(camel);
    await q(`update account_limit_addons set payment_id = $1 where id = $2`, [r.paymentId, addon.id]);
    const [row] = await q(`select * from subscription_payments where id = $1`, [r.paymentId]);
    return { addonId: addon.id as number, paymentId: r.paymentId!, invoiceId: row.moyasar_invoice_id as string, row };
  };
  const account = async () => (await q(`select package_plan, billing_cycle, subscription_status, subscription_started_at, subscription_ends_at from users where id = $1`, [A]))[0];
  const webhookFor = (invId: string, payment: any) =>
    hook.webhook({ secret_token: SECRET, type: `payment_${payment.status}`, data: { ...payment, invoice_id: invId } }, {});

  it("opens a kind='addon' row: seats pro-rated × remaining months, Moyasar metadata names the add-on", async () => {
    const a = await openAddon("100.00");
    assert.equal(a.row.kind, "addon");
    assert.equal(a.row.addon_id, a.addonId);
    assert.equal(a.row.status, "pending");
    assert.equal(Number(a.row.amount), 300, "100/month × 3 remaining months, no VAT while DARA_SELLER_VAT is unset");
    assert.match(a.row.description, /3 أشهر/);
    const inv = moyasar.get(a.invoiceId)!;
    assert.equal(inv.amount, 30000);
    assert.deepEqual(inv.metadata, { subscriptionPaymentId: String(a.paymentId), userId: String(A), kind: "addon", addonId: String(a.addonId) });
  });

  it("paying the plan never cancels an open add-on invoice", async () => {
    const a = await openAddon();
    const r: any = await pay.pay(user, { plan: "professional", cycle: "yearly" });
    assert.ok(r.url);
    await pay.pay(user, { plan: "basic", cycle: "yearly" }); // supersedes the professional row only
    const [row] = await q(`select status from subscription_payments where id = $1`, [a.paymentId]);
    assert.equal(row.status, "pending");
    assert.equal(moyasar.get(a.invoiceId)!.status, "initiated", "the add-on's Moyasar invoice was not cancelled");
    assert.ok(!outbound.includes(`POST https://api.moyasar.com/v1/invoices/${a.invoiceId}/cancel`));
    const subs = await q(`select status from subscription_payments where user_id = $1 and kind = 'subscription' order by id`, [A]);
    assert.deepEqual(subs.map((x: any) => x.status), ["cancelled", "pending"]);
    // The plan's "continue payment" never points at the add-on's checkout.
    const me: any = await pay.mySubscription(user);
    assert.notEqual(me.pendingPayment?.id, a.paymentId);
    const addonRow = me.payments.find((p: any) => p.id === a.paymentId);
    assert.equal(addonRow.kind, "addon");
    assert.equal(addonRow.addonId, a.addonId);
    assert.match(addonRow.description, /إضافة على الباقة/);
  });

  it("a paid add-on (webhook) activates the add-on and never changes package_plan or the period", async () => {
    const before = await account();
    const a = await openAddon();
    const p = settle(a.invoiceId);
    const res: any = await webhookFor(a.invoiceId, p);
    await drainAsync();
    assert.equal(res.activated, true);
    const after = await account();
    assert.deepEqual(after, before, "package_plan, cycle, status and period are untouched");
    const [addon] = await q(`select status, starts_at, ends_at, payment_id from account_limit_addons where id = $1`, [a.addonId]);
    assert.equal(addon.status, "active");
    assert.equal(new Date(addon.ends_at).toISOString(), ends.toISOString(), "valid to the end of the subscription period");
    const [ev] = await q(`select source, old_value, new_value, payment_id, actor_kind from account_limit_events where addon_id = $1`, [a.addonId]);
    assert.equal(ev.source, "addon_purchase");
    assert.equal(ev.new_value - ev.old_value, 2);
    assert.equal(ev.payment_id, a.paymentId);
    assert.equal(sent.length, 1, "one invoice email");
    assert.match((sent[0] as any).itemLabel, /إضافة على الباقة/);
    const [row] = await q(`select invoice_number, period_end from subscription_payments where id = $1`, [a.paymentId]);
    assert.equal(row.invoice_number, `SUB-${String(a.paymentId).padStart(6, "0")}`);
    // A second delivery is a no-op.
    const again: any = await webhookFor(a.invoiceId, p);
    assert.equal(again.already, true);
  });

  it("/sync activates a paid add-on and keeps walking to the subscription row", async () => {
    const before = await account();
    const sub: any = await pay.pay(user, { plan: "basic", cycle: "quarterly" });
    const a = await openAddon(); // newer than the subscription row
    settle(a.invoiceId);
    settle(sub.invoiceId);
    const r: any = await pay.sync(user);
    await drainAsync();
    assert.equal(r.activated, 2, "both the add-on and the plan payment");
    const [addon] = await q(`select status from account_limit_addons where id = $1`, [a.addonId]);
    assert.equal(addon.status, "active");
    const after = await account();
    assert.notEqual(new Date(after.subscription_started_at).getTime(), new Date(before.subscription_started_at).getTime(), "the plan payment renewed");
  });

  it("/sync with only an add-on paid leaves the plan and period alone", async () => {
    const before = await account();
    await pay.pay(user, { plan: "professional", cycle: "yearly" }); // open, unpaid plan row
    const a = await openAddon();
    settle(a.invoiceId);
    const r: any = await pay.sync(user);
    await drainAsync();
    assert.equal(r.activated, 1);
    const after = await account();
    assert.equal(after.package_plan, "basic");
    assert.equal(new Date(after.subscription_ends_at).toISOString(), new Date(before.subscription_ends_at).toISOString());
  });
});
