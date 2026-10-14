import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../finance-v2/__tests__/with-db";
import { planPrice } from "../../common/packages";
import { SubscriptionInvoiceService } from "./subscription-invoice.service";
import { SubscriptionController, SubscriptionWebhookController } from "./subscription.module";

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
