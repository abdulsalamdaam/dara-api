import "reflect-metadata";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../db/src/schema";
import { fv2DbSkip, withDb, type TestDb } from "../finance-v2/__tests__/with-db";
import { AddonCatalogService } from "./addon-catalog.service";
import { AdminLimitsController } from "./admin-limits.controller";
import { LimitsService, parseCreateAddon } from "./limits.service";
import type { LimitsBillingPort, LimitsChangedNotice, LimitsNotifier } from "./limits-billing.port";

/**
 * LimitsService + the admin controller against a throwaway Postgres schema
 * (FV2_TEST_DATABASE_URL, localhost only). Synthetic data only (public repo);
 * nothing is sent — the notifier and billing port are recording fakes.
 */
const ADMIN = 9100;
const BASIC = 9101;      // basic: 2 seats, 1 landlord
const PRO = 9102;        // professional, yearly
const EMP = 9103;        // employee of BASIC

async function caught(p: Promise<unknown>): Promise<{ status: number; body: any } | null> {
  try { await p; return null; } catch (e: any) {
    if (typeof e?.getStatus === "function") return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
}

describe("account limits — LimitsService (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let db: any;
  let svc: LimitsService;
  let ctl: AdminLimitsController;
  const notices: LimitsChangedNotice[] = [];
  const offered: number[] = [];
  const cancelledPayments: number[] = [];
  const q = async (sql: string, p: unknown[] = []) => (await t.pool.query(sql, p)).rows;
  const admin = { id: ADMIN, email: "a@example.test", role: "super_admin", permissions: [] } as any;
  const actor = { userId: ADMIN, kind: "admin" as const };

  before(async () => {
    t = await withDb({ legacy: "full", migrate: false });
    db = drizzle(t.pool, { schema });
    const billing: LimitsBillingPort = {
      // Stands in for Agent B's Moyasar path: one kind='addon' payment row.
      async createAddonPayment(addon) {
        const [row] = await q(
          `insert into subscription_payments (user_id, plan, billing_cycle, amount, status, payment_url, kind, addon_id, description)
           values ($1, 'addon', 'one_off', $2, 'pending', 'https://pay.example.test/x', 'addon', $3, 'synthetic add-on') returning id`,
          [addon.accountId, addon.priceSar ?? "0", addon.id]);
        return { paymentId: row.id, payUrl: "https://pay.example.test/x" };
      },
      async cancelAddonPayment(addon) { cancelledPayments.push(addon.paymentId!); },
    };
    const notifier: LimitsNotifier = {
      async limitsChanged(n) { notices.push(n); },
      async addonOffered(a) { offered.push(a.id); },
    };
    const catalog = new AddonCatalogService(db);
    svc = new LimitsService(db, catalog, billing, notifier);
    ctl = new AdminLimitsController(svc, catalog);
    const user = (id: number, plan: string, ownerUserId: number | null = null, extra = "") =>
      q(`insert into users (id, email, password_hash, name, package_plan, owner_user_id, billing_cycle, subscription_started_at, subscription_ends_at)
         values ($1, $2, 'x', $3, $4, $5, 'yearly', now() - interval '1 day', now() + interval '300 days')`,
        [id, `lim-${id}${extra}@example.test`, `Synthetic ${id}`, plan, ownerUserId]);
    await user(ADMIN, "enterprise"); await user(BASIC, "basic"); await user(PRO, "professional"); await user(EMP, "broker", BASIC);
    await q(`insert into owners (user_id, name, is_account_holder) values ($1, 'Synthetic Self', true)`, [BASIC]);
  });
  after(async () => { await t?.drop(); });

  const lim = (v: any, key: string) => v.limits.find((l: any) => l.key === key);

  it("GET: the package alone, with the contract's shape", async () => {
    const v = await ctl.view(BASIC);
    assert.deepEqual(Object.keys(v).sort(), ["addons", "ejar", "events", "limits", "overrides"]);
    assert.deepEqual(lim(v, "users"), {
      key: "users", base: 2, override: null, addons: 0, effective: 2, used: 2, remaining: 0, over: false, window: "none", resetsAt: null,
    });
    assert.equal(lim(v, "landlords").effective, 1);
    assert.equal(lim(v, "ejar_lookups").base, 90);
    assert.equal(lim(v, "ejar_lookups").window, "period");
    assert.deepEqual(v.ejar, { mode: "default", envMode: "all", effective: true });
    assert.deepEqual(v.overrides, []);
    assert.deepEqual(v.events, []);
  });

  it("an employee or a missing account is refused", async () => {
    assert.equal((await caught(ctl.view(EMP)))?.status, 400);
    assert.equal((await caught(ctl.view(999_999)))?.status, 404);
  });

  it("override: a note is required; value validated", async () => {
    assert.equal((await caught(ctl.setOverride(admin, BASIC, "users", { value: 1 })))?.status, 400);
    assert.equal((await caught(ctl.setOverride(admin, BASIC, "users", { value: -1, note: "x" })))?.status, 400);
    assert.equal((await caught(ctl.setOverride(admin, BASIC, "ejar.enabled", { value: 1, note: "x" })))?.status, 400);
  });

  it("override DOWN below usage: over, nothing deleted, event with old/new; no email by default", async () => {
    const before = notices.length;
    const v = await ctl.setOverride(admin, BASIC, "users", { value: 1, note: "synthetic: lowered" });
    assert.equal(lim(v, "users").effective, 1);
    assert.equal(lim(v, "users").override, 1);
    assert.equal(lim(v, "users").over, true);
    assert.equal(lim(v, "users").used, 2, "nothing deleted");
    assert.deepEqual(v.overrides.map((o: any) => [o.limitKey, o.value, o.note, o.setBy]), [["users", 1, "synthetic: lowered", ADMIN]]);
    const e = v.events[0];
    assert.equal(e.source, "admin_override");
    assert.equal(e.oldValue, 2);
    assert.equal(e.newValue, 1);
    assert.equal(e.actorKind, "admin");
    assert.equal(e.actorName, `Synthetic ${ADMIN}`);
    assert.equal(notices.length, before, "a decrease is not emailed unless asked");
  });

  it("override UP / unlimited / clear — each logged; an increase notifies", async () => {
    let v = await ctl.setOverride(admin, BASIC, "users", { value: 5, note: "up" });
    assert.equal(lim(v, "users").effective, 5);
    assert.equal(notices.at(-1)?.newValue, 5);
    v = await ctl.setOverride(admin, BASIC, "users", { value: null, note: "unlimited" });
    assert.equal(lim(v, "users").effective, null);
    assert.equal(v.events[0].newValue, null);
    v = await ctl.setOverride(admin, BASIC, "users", { clear: true, note: "back to package" });
    assert.equal(lim(v, "users").effective, 2);
    assert.equal(lim(v, "users").override, null);
    assert.deepEqual(v.overrides, []);
    assert.equal(v.events[0].oldValue, null);
    assert.equal(v.events[0].newValue, 2);
  });

  it("free grant: active now, effective goes up, ends with the subscription period", async () => {
    const v = await ctl.createAddon(admin, BASIC, { limitKey: "landlords", quantity: 2, mode: "free", period: "subscription_period", note: "synthetic grant" });
    assert.equal(lim(v, "landlords").effective, 3);
    assert.equal(lim(v, "landlords").addons, 2);
    const a = v.addons[0];
    assert.equal(a.status, "active");
    assert.equal(a.source, "admin_free");
    assert.equal(a.activation, "immediate");
    assert.ok(a.startsAt);
    const [u] = await q(`select subscription_ends_at from users where id = $1`, [BASIC]);
    assert.equal(a.endsAt, new Date(u.subscription_ends_at).toISOString());
    assert.equal(a.payUrl, null);
    assert.equal(v.events[0].source, "addon_grant");
    assert.deepEqual([v.events[0].oldValue, v.events[0].newValue], [1, 3]);
  });

  it("an expired add-on is ignored by the effective limit", async () => {
    await q(`insert into account_limit_addons (account_id, limit_key, quantity, status, activation, source, starts_at, ends_at)
             values ($1, 'landlords', 10, 'active', 'immediate', 'admin_free', now() - interval '2 days', now() - interval '1 day')`, [BASIC]);
    assert.equal(lim(await ctl.view(BASIC), "landlords").effective, 3);
  });

  it("invoice: needs a price; with one it waits for payment and opens one through the billing port", async () => {
    assert.equal((await caught(ctl.createAddon(admin, BASIC, { limitKey: "users", quantity: 1, mode: "invoice", note: "x" })))?.status, 400);
    const v = await ctl.createAddon(admin, BASIC, { limitKey: "users", quantity: 1, mode: "invoice", priceSar: 40, note: "synthetic invoice" });
    const a = v.addons[0];
    assert.equal(a.status, "pending_payment");
    assert.equal(a.source, "admin_invoice");
    assert.equal(a.priceSar, 40);
    assert.ok(a.paymentId);
    assert.equal(a.payUrl, "https://pay.example.test/x");
    assert.equal(a.amountInclVat, 40, "the payment's amount");
    assert.equal(lim(v, "users").effective, 2, "not active until paid");
    assert.ok(offered.includes(a.id));
  });

  it("invoice with activation=immediate is active at once", async () => {
    const v = await ctl.createAddon(admin, PRO, { limitKey: "users", quantity: 1, mode: "invoice", priceSar: 40, activation: "immediate", note: "trusted" });
    assert.equal(v.addons[0].status, "active");
    assert.equal(lim(v, "users").effective, 5);
  });

  it("offer from the catalog: price scaled from the pack, offered, expires", async () => {
    await ctl.setCatalog({ items: [
      { key: "seat_1", limitKey: "users", quantity: 1, priceSar: 50, period: "subscription_period", labelAr: "مستخدم", labelEn: "Seat" },
      { key: "ejar_50", limitKey: "ejar_lookups", quantity: 50, priceSar: 100, period: "one_off", labelAr: "إيجار", labelEn: "Ejar 50" },
    ] });
    const v = await ctl.createAddon(admin, PRO, { limitKey: "ejar_lookups", quantity: 100, mode: "offer", catalogKey: "ejar_50", period: "one_off", note: "offer" });
    const a = v.addons[0];
    assert.equal(a.status, "offered");
    assert.equal(a.priceSar, 200);
    assert.ok(a.offerExpiresAt);
    assert.equal(v.events[0].source, "addon_offer");
    assert.equal(v.events[0].oldValue, v.events[0].newValue);
    assert.equal((await caught(ctl.createAddon(admin, PRO, { limitKey: "users", quantity: 1, mode: "offer", catalogKey: "ejar_50", note: "x" })))?.status, 400);
  });

  it("cancel: an active add-on stops counting; a pending one cancels its payment", async () => {
    let v = await ctl.view(BASIC);
    const grant = v.addons.find((a: any) => a.status === "active" && a.limitKey === "landlords" && a.quantity === 2);
    v = await ctl.cancelAddon(admin, BASIC, grant.id, { note: "synthetic cancel" });
    assert.equal(lim(v, "landlords").effective, 1);
    assert.equal(lim(v, "landlords").over, false);
    assert.equal(v.events[0].source, "addon_cancel");
    assert.deepEqual([v.events[0].oldValue, v.events[0].newValue], [3, 1]);

    const pending = v.addons.find((a: any) => a.status === "pending_payment");
    v = await ctl.cancelAddon(admin, BASIC, pending.id, { note: "never paid" });
    assert.ok(cancelledPayments.includes(pending.paymentId));
    assert.equal((await caught(ctl.cancelAddon(admin, BASIC, pending.id, { note: "again" })))?.status, 400);
    assert.equal((await caught(ctl.cancelAddon(admin, PRO, grant.id, { note: "other account" })))?.status, 404);
  });

  it("Ejar switch: enabled / disabled / default, each logged", async () => {
    assert.equal((await caught(ctl.setEjarAccess(admin, BASIC, { mode: "on", note: "x" })))?.status, 400);
    let v = await ctl.setEjarAccess(admin, BASIC, { mode: "disabled", note: "synthetic off" });
    assert.deepEqual(v.ejar, { mode: "disabled", envMode: "all", effective: false });
    assert.equal(v.events[0].source, "ejar_toggle");
    assert.deepEqual([v.events[0].oldValue, v.events[0].newValue], [null, 0]);
    v = await ctl.setEjarAccess(admin, BASIC, { mode: "enabled", note: "on" });
    assert.equal(v.ejar.mode, "enabled");
    assert.equal(v.overrides.find((o: any) => o.limitKey === "ejar.enabled").value, 1);
    v = await ctl.setEjarAccess(admin, BASIC, { mode: "default", note: "reset" });
    assert.equal(v.ejar.mode, "default");
    assert.equal(v.overrides.some((o: any) => o.limitKey === "ejar.enabled"), false);
  });

  it("limit-events pages, newest first, with the total", async () => {
    const all = await ctl.events(BASIC, "1", "200");
    const p2 = await ctl.events(BASIC, "2", "3");
    assert.equal(all.total, all.items.length);
    assert.ok(all.total > 6);
    assert.deepEqual(p2.items.map((e: any) => e.id), all.items.slice(3, 6).map((e: any) => e.id));
    assert.ok(all.items[0].id > all.items[1].id);
  });

  it("catalog: GET defaults shape, PUT validates strictly", async () => {
    const c = await ctl.getCatalog();
    assert.deepEqual(c.items.map((i: any) => i.key), ["seat_1", "ejar_50"]);
    assert.ok("amountInclVat" in c.items[0]);
    assert.equal((await caught(ctl.setCatalog({ items: [{ key: "x", limitKey: "nope", quantity: 1 }] })))?.status, 400);
    assert.equal((await caught(ctl.setCatalog({ items: [{ key: "a", limitKey: "users", quantity: 1 }, { key: "a", limitKey: "users", quantity: 1 }] })))?.status, 400);
    assert.equal((await caught(ctl.setCatalog({})))?.status, 400);
    const saved = await ctl.setCatalog({ items: [{ key: "seat_1", limitKey: "users", quantity: 1, priceSar: null, labelAr: "a", labelEn: "b" }] });
    assert.equal(saved.items[0].priceSar, null);
    assert.equal(saved.items[0].amountInclVat, null);
    assert.equal(saved.items[0].period, "subscription_period");
  });

  it("parseCreateAddon: free is always immediate; offer always on_payment; notify defaults on", () => {
    assert.equal(parseCreateAddon({ limitKey: "users", quantity: 1, mode: "free", activation: "on_payment" }).activation, "immediate");
    assert.equal(parseCreateAddon({ limitKey: "users", quantity: 1, mode: "offer", activation: "immediate" }).activation, "on_payment");
    assert.equal(parseCreateAddon({ limitKey: "users", quantity: 1, mode: "invoice" }).notify, true);
    assert.throws(() => parseCreateAddon({ limitKey: "users", quantity: 0, mode: "free" }));
    assert.throws(() => parseCreateAddon({ limitKey: "users", quantity: 1, mode: "free", endsAt: "2000-01-01" }));
  });
});
