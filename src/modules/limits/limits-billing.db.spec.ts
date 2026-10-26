import "reflect-metadata";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../finance-v2/__tests__/with-db";
import { AddonCatalogService } from "./addon-catalog.service";
import { LimitsService } from "./limits.service";
import { LimitsBillingService } from "./limits-billing.service";
import { LimitsHousekeepingService } from "./limits-housekeeping.service";
import { LimitsReachedService } from "./limits-reached.service";
import { MeLimitsController } from "./me-limits.controller";
import { signalLimitRefused } from "./limits-signals";
import type { LimitsNotifier } from "./limits-billing.port";

/**
 * Billing side of account limits against a throwaway Postgres schema
 * (FV2_TEST_DATABASE_URL, localhost only): housekeeping, the `limit_reached`
 * audit event, and the customer routes. Moyasar is a fake at `fetch` (any
 * other outbound request fails the test) and every email is a recording stub.
 * Synthetic data only.
 */
const ACC = 9201;     // paid, active
const EMP = 9202;     // employee of ACC
const OTHER = 9203;   // another account

const moyasar = new Map<string, any>();
const outbound: string[] = [];
const realFetch = globalThis.fetch;
function fakeFetch(input: any, init?: any): Promise<Response> {
  const url = String(input?.url ?? input);
  const method = String(init?.method || "GET").toUpperCase();
  outbound.push(`${method} ${url}`);
  const json = (body: any, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  const m = url.match(/^https:\/\/api\.moyasar\.com\/v1\/invoices(?:\/([^/]+))?(\/cancel)?$/);
  if (!m) return Promise.reject(new Error(`unexpected outbound request in a test: ${method} ${url}`));
  if (method === "POST" && !m[1]) {
    const body = JSON.parse(init.body);
    const id = randomUUID();
    const inv = { id, status: "initiated", amount: body.amount, currency: body.currency, url: `https://checkout.moyasar.test/${id}`, metadata: body.metadata, payments: [] as any[] };
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
const settle = (id: string) => {
  const inv = moyasar.get(id)!;
  inv.status = "paid";
  inv.payments.push({ id: randomUUID(), status: "paid", amount: inv.amount, currency: inv.currency, refunded: 0, invoice_id: id, created_at: new Date().toISOString() });
};

async function caught(p: Promise<unknown>): Promise<{ status: number; body: any } | null> {
  try { await p; return null; } catch (e: any) {
    if (typeof e?.getStatus === "function") return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
}

describe("account limits — billing, housekeeping, customer routes (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let db: any;
  let limits: LimitsService;
  let hk: LimitsHousekeepingService;
  let reached: LimitsReachedService;
  let me: MeLimitsController;
  const expiredMails: number[] = [];
  const offered: number[] = [];
  const env: Record<string, string | undefined> = {};
  const q = async (sql: string, p: unknown[] = []) => (await t.pool.query(sql, p)).rows;
  const holder = { id: ACC, ownerUserId: null, role: "user", permissions: [] } as any;
  const employee = { id: EMP, ownerUserId: ACC, role: "user", permissions: [] } as any;
  const admin = { userId: 1, kind: "admin" as const };

  before(async () => {
    for (const k of ["MOYASAR_SECRET_KEY", "DARA_SELLER_VAT"]) env[k] = process.env[k];
    process.env.MOYASAR_SECRET_KEY = "sk_test_never_real";
    delete process.env.DARA_SELLER_VAT;
    globalThis.fetch = fakeFetch as any;
    t = await withDb({ legacy: "full", migrate: false });
    db = drizzle(t.pool, { schema });
    const catalog = new AddonCatalogService(db);
    const billing = new LimitsBillingService(db, catalog);
    const notifier: LimitsNotifier = { async limitsChanged() {}, async addonOffered(a) { offered.push(a.id); } };
    limits = new LimitsService(db, catalog, billing, notifier);
    const fakeEmailNotifier = { addonExpired: async (a: any) => { expiredMails.push(a.id); } } as any;
    hk = new LimitsHousekeepingService(db, limits, billing, fakeEmailNotifier, undefined);
    reached = new LimitsReachedService(db);
    me = new MeLimitsController(db, limits, billing, undefined);
  });
  after(async () => {
    globalThis.fetch = realFetch;
    reached?.onModuleDestroy();
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await t?.drop();
  });
  beforeEach(async () => {
    moyasar.clear(); outbound.length = 0; expiredMails.length = 0; offered.length = 0;
    await q(`delete from account_limit_events`); await q(`delete from account_limit_addons`); await q(`delete from subscription_payments`);
    await q(`delete from users where id in ($1, $2, $3)`, [EMP, ACC, OTHER]);
    for (const id of [ACC, OTHER]) {
      await q(`insert into users (id, email, password_hash, name, package_plan, billing_cycle, subscription_status, subscription_started_at, subscription_ends_at)
               values ($1, $2, 'x', 'Synthetic', 'basic', 'yearly', 'active', now() - interval '10 days', now() + interval '200 days')`, [id, `lb-${id}@example.test`]);
    }
    await q(`insert into users (id, email, password_hash, name, package_plan, owner_user_id) values ($1, $2, 'x', 'Emp', 'basic', $3)`, [EMP, `lb-${EMP}@example.test`, ACC]);
  });

  const offer = async (acc = ACC, priceSar = 40) =>
    limits.createAddon(acc, {
      limitKey: "ejar_lookups", quantity: 50, mode: "offer", catalogKey: null, priceSar, period: "one_off",
      endsAt: null, activation: "on_payment", note: "synthetic", notify: true,
    }, admin);

  /* ── housekeeping ────────────────────────────────────────────────── */

  it("expires an active add-on past ends_at, logs addon_expiry with old/new effective, emails once", async () => {
    const [a] = await q(`insert into account_limit_addons (account_id, limit_key, quantity, period, status, activation, source, starts_at, ends_at)
                         values ($1, 'users', 3, 'subscription_period', 'active', 'immediate', 'admin_free', now() - interval '30 days', now() - interval '1 hour') returning id`, [ACC]);
    const [live] = await q(`insert into account_limit_addons (account_id, limit_key, quantity, period, status, activation, source, starts_at, ends_at)
                            values ($1, 'users', 1, 'subscription_period', 'active', 'immediate', 'admin_free', now() - interval '1 day', now() + interval '1 day') returning id`, [ACC]);
    const r = await hk.runOnce();
    assert.deepEqual(r.expired, [a.id]);
    const rows = await q(`select id, status from account_limit_addons order by id`);
    assert.deepEqual(rows.map((x: any) => x.status), ["expired", "active"]);
    const [ev] = await q(`select source, old_value, new_value, actor_kind from account_limit_events where addon_id = $1`, [a.id]);
    assert.equal(ev.source, "addon_expiry");
    assert.equal(ev.actor_kind, "system");
    assert.equal(ev.old_value - ev.new_value, 3, "the expired 3 seats came off; the live add-on stays counted");
    assert.deepEqual(expiredMails, [a.id]);
    assert.deepEqual((await hk.runOnce()).expired, [], "idempotent");
    assert.equal(expiredMails.length, 1);
    void live;
  });

  it("cancels a stale offer past offer_expires_at and voids its Moyasar invoice", async () => {
    const { addon, payment } = await offer();
    assert.ok(payment.payUrl);
    const [row] = await q(`select moyasar_invoice_id, kind, amount from subscription_payments where id = $1`, [payment.paymentId]);
    assert.equal(row.kind, "addon");
    assert.equal(Number(row.amount), 40);
    await q(`update account_limit_addons set offer_expires_at = now() - interval '1 minute' where id = $1`, [addon.id]);
    const r = await hk.runOnce();
    assert.deepEqual(r.cancelled, [addon.id]);
    assert.equal((await q(`select status from account_limit_addons where id = $1`, [addon.id]))[0].status, "cancelled");
    assert.equal((await q(`select status from subscription_payments where id = $1`, [payment.paymentId]))[0].status, "cancelled");
    assert.equal(moyasar.get(row.moyasar_invoice_id).status, "canceled");
    const [ev] = await q(`select source, actor_kind from account_limit_events where addon_id = $1 and source = 'addon_cancel'`, [addon.id]);
    assert.equal(ev.actor_kind, "system");
  });

  it("a stale offer whose invoice was in fact paid (missed webhook) is activated, not cancelled", async () => {
    const { addon, payment } = await offer();
    const [row] = await q(`select moyasar_invoice_id from subscription_payments where id = $1`, [payment.paymentId]);
    settle(row.moyasar_invoice_id);
    await q(`update account_limit_addons set offer_expires_at = now() - interval '1 minute' where id = $1`, [addon.id]);
    const r = await hk.runOnce();
    assert.deepEqual(r.activated, [addon.id]);
    assert.equal((await q(`select status from account_limit_addons where id = $1`, [addon.id]))[0].status, "active");
    assert.equal((await q(`select package_plan from users where id = $1`, [ACC]))[0].package_plan, "basic");
  });

  /* ── limit_reached ───────────────────────────────────────────────── */

  it("a refusing gate records ONE limit_reached per key per period — no offer, no email", async () => {
    assert.equal(await reached.recordLimitReached(ACC, "users"), "recorded");
    assert.equal(await reached.recordLimitReached(ACC, "users"), "already_recorded");
    assert.equal(await reached.recordLimitReached(ACC, "ejar_lookups"), "recorded", "another key is separate");
    assert.equal(await reached.recordLimitReached(EMP, "users"), "not_account");
    // A burst through the signal still lands one row.
    reached.onModuleInit();
    for (let i = 0; i < 5; i++) signalLimitRefused(OTHER, "users");
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
    const rows = await q(`select account_id, limit_key, actor_kind, old_value from account_limit_events where source = 'limit_reached' order by id`);
    assert.deepEqual(rows.map((r: any) => [r.account_id, r.limit_key]), [[ACC, "users"], [ACC, "ejar_lookups"], [OTHER, "users"]]);
    assert.equal(rows[0].actor_kind, "system");
    assert.equal(rows[0].old_value, 2, "the effective seat limit at the time");
    assert.equal((await q(`select count(*)::int as c from account_limit_addons`))[0].c, 0, "no add-on offered");
    assert.equal(outbound.length, 0, "no Moyasar call");
    // A new period → it may be recorded again.
    await q(`update users set subscription_started_at = now() where id = $1`, [ACC]);
    assert.equal(await reached.recordLimitReached(ACC, "users"), "recorded");
  });

  /* ── customer routes ─────────────────────────────────────────────── */

  it("GET /me/limits: limits, add-ons, notices (offers + unacknowledged grants), no catalog, Ejar gateway", async () => {
    const { addon: off } = await offer();
    const { addon: grant } = await limits.createAddon(ACC, {
      limitKey: "users", quantity: 1, mode: "free", catalogKey: null, priceSar: null, period: "subscription_period",
      endsAt: null, activation: "immediate", note: "gift", notify: false,
    }, admin);
    await q(`insert into app_settings (key, value) values ('limit_addon_catalog', $1::jsonb) on conflict (key) do update set value = excluded.value`,
      [JSON.stringify({ items: [{ key: "seat_1", limitKey: "users", quantity: 1, priceSar: 50, period: "subscription_period", labelAr: "s", labelEn: "s" }] })]);
    const v = await me.myLimits(employee);
    assert.deepEqual(v.limits.map((l) => l.key), ["users", "landlords"], "the Ejar quota is never sent to a customer");
    const users = v.limits.find((l) => l.key === "users")!;
    assert.equal(users.base, 2);
    assert.equal(users.addons, 1);
    assert.equal(users.effective, 3);
    assert.deepEqual(v.catalog, [], "add-ons are admin-only: nothing for sale");
    assert.deepEqual(v.addons.map((a) => a.id).sort(), [off.id, grant.id].sort());
    assert.deepEqual(v.notices.map((a) => a.id).sort(), [off.id, grant.id].sort());
    const n = v.notices.find((a) => a.id === off.id)!;
    assert.equal(n.status, "offered");
    assert.ok(n.payUrl?.startsWith("https://checkout.moyasar.test/"));
    assert.equal(n.amountInclVat, 40);
    assert.equal(typeof v.ejar.enabled, "boolean");
    assert.deepEqual(Object.keys(v.ejar).sort(), ["available", "enabled"], "yes/no only, no counts");
    assert.equal(v.ejar.available, v.ejar.enabled);

    // Ack the grant: it leaves the notices, stays in addons. Another account's id is a 404.
    assert.deepEqual(await me.ack(employee, String(grant.id)), { ok: true });
    assert.equal((await caught(me.ack({ ...holder, id: OTHER }, String(grant.id))))?.status, 404);
    const v2 = await me.myLimits(holder);
    assert.deepEqual(v2.notices.map((a) => a.id), [off.id]);
    assert.equal(v2.addons.length, 2);
  });

  it("POST /me/limits/addons/:id/pay: holder only; open checkout reused; offered → pending_payment", async () => {
    const { addon, payment } = await offer();
    assert.equal((await caught(me.pay(employee, String(addon.id))))?.status, 403);
    assert.equal((await caught(me.pay({ ...holder, id: OTHER }, String(addon.id))))?.status, 404, "another account's add-on");
    const r = await me.pay(holder, String(addon.id));
    assert.equal(r.url, payment.payUrl);
    assert.equal((await q(`select status from account_limit_addons where id = $1`, [addon.id]))[0].status, "pending_payment");
    assert.equal((await q(`select count(*)::int as c from subscription_payments`))[0].c, 1, "no second invoice");
  });

  it("pay opens a fresh invoice when the old one is gone, and reports an already-paid one", async () => {
    const { addon, payment } = await offer();
    const [row] = await q(`select moyasar_invoice_id from subscription_payments where id = $1`, [payment.paymentId]);
    moyasar.get(row.moyasar_invoice_id).status = "failed";
    const r = await me.pay(holder, String(addon.id));
    assert.ok(r.url && r.url !== payment.payUrl);
    const rows = await q(`select status from subscription_payments where addon_id = $1 order by id`, [addon.id]);
    assert.deepEqual(rows.map((x: any) => x.status), ["cancelled", "pending"]);
    const [cur] = await q(`select payment_id from account_limit_addons where id = $1`, [addon.id]);
    const [curRow] = await q(`select moyasar_invoice_id from subscription_payments where id = $1`, [cur.payment_id]);
    settle(curRow.moyasar_invoice_id);
    const paid = await me.pay(holder, String(addon.id));
    assert.deepEqual(paid, { url: null, alreadyPaid: true });
    assert.equal((await q(`select status from account_limit_addons where id = $1`, [addon.id]))[0].status, "active");
  });

  it("pay refuses active, cancelled and expired-offer add-ons", async () => {
    const { addon } = await offer();
    await q(`update account_limit_addons set offer_expires_at = now() - interval '1 minute' where id = $1`, [addon.id]);
    assert.equal((await caught(me.pay(holder, String(addon.id))))?.status, 400);
    const { addon: grant } = await limits.createAddon(ACC, {
      limitKey: "users", quantity: 1, mode: "free", catalogKey: null, priceSar: null, period: "subscription_period",
      endsAt: null, activation: "immediate", note: "gift", notify: false,
    }, admin);
    assert.equal((await caught(me.pay(holder, String(grant.id))))?.status, 400);
  });

  it("there is no self-serve purchase route", () => {
    assert.equal((me as any).buy, undefined);
  });
});
