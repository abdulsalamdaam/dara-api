import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NewsAdminController, X_NO_KEY_MESSAGE } from "./news-admin.controller";
import { NewsRunnerService } from "./news.runner.service";

/**
 * X stays a first-class source without a key: an admin can add, test, toggle
 * and delete X accounts; the test says "saved, waiting for a key" (200), not 400.
 */
const KEYS = ["X_BEARER_TOKEN", "TWITTERAPI_IO_KEY", "APIFY_TOKEN", "NEWS_SOURCE_PROVIDER"] as const;

function fakeDb(existing: Record<string, any>[] = []) {
  const rows = [...existing];
  let last: any = null;
  const chain: any = {
    insert: () => chain,
    values: (v: any) => { last = { id: `id-${rows.length + 1}`, enabled: true, ...v }; return chain; },
    onConflictDoNothing: () => chain,
    returning: async () => {
      if (rows.some((r) => r.handle && r.handle === last.handle)) return [];
      rows.push(last);
      return [last];
    },
    select: () => chain,
    from: () => chain,
    where: async () => rows.slice(0, 1),
  };
  return { db: chain, rows };
}

describe("X sources without an X key", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("creates an X account from @handle or an x.com URL — no key needed", async () => {
    const { db, rows } = fakeDb();
    const c = new NewsAdminController(db, new NewsRunnerService(db, {} as any), {} as any);
    const a: any = await c.createSource({ handle: "@SaudiREGA" });
    assert.equal(a.kind, "x");
    assert.equal(a.handle, "saudirega");
    const b: any = await c.createSource({ handle: "https://x.com/Ejar_SA?s=20" });
    assert.equal(b.handle, "ejar_sa");
    assert.equal(rows.length, 2);
    await assert.rejects(c.createSource({ handle: "saudirega" }), /already in the list/);
  });

  it("the pre-save and per-row tests answer 200 with a neutral no_key, never a 400", async () => {
    const { db } = fakeDb([{ id: "a", kind: "x", handle: "rega_ksa", xUserId: null }]);
    const c = new NewsAdminController(db, new NewsRunnerService(db, {} as any), {} as any);
    for (const r of [await c.testHandle({ handle: "rega_ksa" }), await c.testSource("00000000-0000-4000-8000-000000000001")] as any[]) {
      assert.equal(r.kind, "x");
      assert.equal(r.ok, false);
      assert.equal(r.provider, null);
      assert.deepEqual(r.tweets, []);
      assert.deepEqual(r.error, { kind: "no_key", message: X_NO_KEY_MESSAGE });
    }
  });
});
