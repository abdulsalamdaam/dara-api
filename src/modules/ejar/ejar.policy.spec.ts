/**
 * Manual-add policy (Task 4).
 *
 * Precedence is admin override > Ejar health > default (disabled). These tests
 * drive the service against an in-memory settings store so all three states are
 * pinned without a database or the Ejar gateway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EjarPolicyService } from "./ejar.policy.service";

/** Minimal stand-in for the app_settings table. */
function stubDb(store: Map<string, unknown>) {
  return {
    select: () => ({
      from: () => ({
        where: (pred: { key?: string }) => ({
          limit: async () => {
            const key = pred?.key;
            return key && store.has(key) ? [{ key, value: store.get(key) }] : [];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (v: { key: string; value: unknown }) => ({
        onConflictDoUpdate: async () => { store.set(v.key, v.value); },
      }),
    }),
  };
}

/**
 * drizzle's eq() returns an opaque SQL object, so the stub above can't read the
 * key back out of it. Patch the private accessors instead — the behaviour under
 * test is the precedence rule, not the query builder.
 */
function makeService(opts: { healthy: boolean | null; override?: string }) {
  const store = new Map<string, unknown>();
  const svc = new EjarPolicyService(stubDb(store) as never, {
    request: async () => {
      if (!opts.healthy) throw Object.assign(new Error("gateway down"), { status: 502 });
      return { body: null, log: { status: 200 } };
    },
  } as never);
  const health = opts.healthy === null
    ? { ok: false, checkedAt: null, status: null, detail: null }
    : { ok: opts.healthy, checkedAt: "2026-07-31T00:00:00.000Z", status: opts.healthy ? 200 : 502, detail: null };
  (svc as never as Record<string, unknown>).getHealth = async () => health;
  (svc as never as Record<string, unknown>).getOverride = async () => opts.override ?? "auto";
  return svc;
}

test("Ejar healthy → manual Add is disabled (everything must come through Ejar)", async () => {
  const p = await makeService({ healthy: true }).getPolicy();
  assert.equal(p.enabled, false);
  assert.equal(p.reason, "ejar_healthy");
});

test("Ejar unreachable → manual Add is auto-enabled so the business isn't blocked", async () => {
  const p = await makeService({ healthy: false }).getPolicy();
  assert.equal(p.enabled, true);
  assert.equal(p.reason, "ejar_down");
});

test("admin force_enabled overrides a healthy gateway", async () => {
  const p = await makeService({ healthy: true, override: "force_enabled" }).getPolicy();
  assert.equal(p.enabled, true);
  assert.equal(p.reason, "admin_forced_on");
});

test("admin force_disabled overrides an outage", async () => {
  const p = await makeService({ healthy: false, override: "force_disabled" }).getPolicy();
  assert.equal(p.enabled, false);
  assert.equal(p.reason, "admin_forced_off");
});

test("never probed yet → stay unlocked rather than locking out a fresh deploy", async () => {
  const p = await makeService({ healthy: null }).getPolicy();
  assert.equal(p.enabled, true);
  assert.equal(p.reason, "unknown");
});

test("a failing probe is recorded, not thrown — the hourly job runs unattended", async () => {
  const store = new Map<string, unknown>();
  const svc = new EjarPolicyService(stubDb(store) as never, {
    request: async () => { throw Object.assign(new Error("boom"), { status: 403 }); },
  } as never);
  const state = await svc.refreshHealth();
  assert.equal(state.ok, false);
  assert.equal(state.status, 403);
  assert.ok(state.checkedAt, "the check timestamp is what distinguishes 'down' from 'never checked'");
});
