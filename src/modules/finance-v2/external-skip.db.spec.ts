import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { fv2DbSkip } from "./__tests__/with-db";
import { attempt, enableV2, legacyEnv, seedAccount, userOf, type LegacyEnv, type Seed } from "./__tests__/legacy-env";
import { sqlOf } from "./hooks/sql";
import { loadSettings } from "./hooks/facts-loader";
import { extractEvents } from "./backfill/extract";
import { contractSummaryV2 } from "./overrides/reads";
import { externalPostedCount } from "./external-skip";

/**
 * Migration 0084 — a contract's externally-settled installments, COUNTED or
 * SKIPPED, on the real legacy contracts controller with Finance v2 on.
 *
 *  - A (count, the default): Jan–Mar are `settled_external`; the recognizer
 *    charges them (E02) and settles them (E33) as before.
 *  - B (skip): the same rows are never charged nor settled, by the recognizer
 *    or by a backfill; the live rows (Apr…) are charged as usual.
 *  - Switching A to skip is refused (409) once its rows are in the ledger;
 *    B → count lets the next run book them; a fresh contract with nothing
 *    booked switches freely.
 * Every value is synthetic (public repo).
 */
const U = 5401;
const TODAY = "2026-06-15";

describe("finance v2: externally-settled installments, count or skip (0084)", { skip: fv2DbSkip }, () => {
  let env: LegacyEnv;
  let s: Seed;
  let a: any;
  let b: any;
  const user = userOf(U);

  const rows = (contractId: number) => env.q(
    `select p.id, to_char(p.due_date,'YYYY-MM-DD') as due, p.status::text as status from payments p
      where p.contract_id = $1 and p.deleted_at is null and coalesce(p.description, '') not like 'تأمين%' order by p.due_date, p.id`, [contractId]);
  const eventsFor = (ids: number[]) => env.q(
    `select source_id::int as id, event, status from ledger_outbox where user_id = $1 and source_type = 'payment' and source_id = any($2::int[]) order by id`,
    [U, `{${ids.join(",")}}`]);
  const tick = async () => {
    await env.recognizer.runAccount(U, TODAY);
    for (let i = 0; i < 10; i++) {
      const r = await env.worker.runAccount(U);
      if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
    }
  };
  const contract = (unitId: number, mode?: "count" | "skip") => env.contracts.create(user, {
    unitIds: [unitId], tenantId: s.tenant, tenantName: "Synthetic Tenant", startDate: "2026-01-01", endDate: "2026-12-31",
    monthlyRent: "1000", paymentFrequency: "monthly", vatEnabled: false, settledExternalUntil: "2026-04-01",
    ...(mode ? { externalSettlementMode: mode } : {}),
  });

  before(async () => {
    env = await legacyEnv("wired");
    s = await seedAccount(env, U);
    await enableV2(env, U, "manager");
    a = await contract(s.unitA1);
    b = await contract(s.unitA2, "skip");
    // Two runs: E33 needs the charge posted first.
    await tick();
    await tick();
  });

  after(async () => {
    await env?.t.drop();
  });

  it("the mode is stored, defaults to count, and is returned on the contract", async () => {
    assert.equal(a.externalSettlementMode, "count");
    assert.equal(b.externalSettlementMode, "skip");
    const one = await env.contracts.getOne(user, String(b.id));
    assert.equal(one.externalSettlementMode, "skip");
    const bad = await attempt(() => env.contracts.update(user, String(a.id), { externalSettlementMode: "maybe" }));
    assert.equal((bad as any).status, 400);
  });

  it("count: Jan–Mar are charged (E02) and settled (E33), as before", async () => {
    const ra = await rows(a.id);
    const ext = ra.filter((r: any) => r.status === "settled_external");
    assert.deepEqual(ext.map((r: any) => r.due), ["2026-01-01", "2026-02-01", "2026-03-01"]);
    const ev = await eventsFor(ext.map((r: any) => r.id));
    assert.deepEqual(ev.filter((e: any) => e.event === "charge").length, 3);
    assert.deepEqual(ev.filter((e: any) => e.event === "settled_external").length, 3);
    assert.ok(ev.every((e: any) => e.status === "posted"));
  });

  it("skip: Jan–Mar are never charged nor settled; Apr–Jun (live) are charged as usual", async () => {
    const rb = await rows(b.id);
    const ext = rb.filter((r: any) => r.status === "settled_external");
    assert.equal(ext.length, 3, "still in the schedule, marked settled outside the platform");
    assert.deepEqual(await eventsFor(ext.map((r: any) => r.id)), []);
    const live = rb.filter((r: any) => r.status !== "settled_external" && r.due < TODAY);
    assert.deepEqual(live.map((r: any) => r.due), ["2026-04-01", "2026-05-01", "2026-06-01"]);
    const ev = await eventsFor(live.map((r: any) => r.id));
    assert.equal(ev.filter((e: any) => e.event === "charge").length, 3);
  });

  it("skip: a backfill extraction plans nothing for them either (notes them as external_skipped)", async () => {
    const q = sqlOf(env.t.pool as any);
    const settings = (await loadSettings(q, U))!;
    const { events, notes } = await extractEvents(q, U, settings, { today: TODAY });
    const extB = (await rows(b.id)).filter((r: any) => r.status === "settled_external").map((r: any) => Number(r.id));
    assert.deepEqual(events.filter((e) => e.sourceType === "payment" && extB.includes(e.sourceId)), []);
    assert.equal(notes.external_skipped?.count, 3);
    const extA = (await rows(a.id)).filter((r: any) => r.status === "settled_external").map((r: any) => Number(r.id));
    assert.equal(events.filter((e) => e.sourceType === "payment" && extA.includes(e.sourceId) && e.event === "settled_external").length, 3);
  });

  it("skip: the contract summary bills and settles none of them; count still does", async () => {
    const q = sqlOf(env.t.pool as any);
    const sb: any = await contractSummaryV2(q, U, b.id, TODAY);
    assert.equal(sb.settledExternal, "0.00");
    assert.equal(sb.billed, "3000.00", "Apr–Jun only");
    const sa: any = await contractSummaryV2(q, U, a.id, TODAY);
    assert.equal(sa.settledExternal, "3000.00");
    assert.equal(sa.billed, "6000.00");
    assert.equal(sa.outstanding, sb.outstanding, "what the tenant owes is the same either way");
  });

  it("count → skip is refused (409) once those installments are in the ledger; nothing changes", async () => {
    assert.equal(await externalPostedCount(sqlOf(env.t.pool as any), U, a.id), 3);
    const r: any = await attempt(() => env.contracts.update(user, String(a.id), { externalSettlementMode: "skip" }));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "EXTERNAL_SKIP_POSTED");
    assert.equal(r.body.count, 3);
    const [c] = await env.q(`select external_settlement_mode as m from contracts where id = $1`, [a.id]);
    assert.equal(c.m, "count");
  });

  it("a contract with nothing booked switches to skip freely; a PATCH that does not touch the mode is unaffected", async () => {
    const c: any = await contract(s.unitH1);
    const r: any = await env.contracts.update(user, String(c.id), { externalSettlementMode: "skip" });
    assert.equal(r.externalSettlementMode, "skip");
    const n: any = await env.contracts.update(user, String(a.id), { notes: "synthetic note" });
    assert.equal(n.externalSettlementMode, "count");
    await tick();
    const ext = (await rows(c.id)).filter((x: any) => x.status === "settled_external");
    assert.deepEqual(await eventsFor(ext.map((x: any) => x.id)), []);
  });

  it("skip → count: the next recognizer run books them; switching back is then refused", async () => {
    const r: any = await env.contracts.update(user, String(b.id), { externalSettlementMode: "count" });
    assert.equal(r.externalSettlementMode, "count");
    await tick();
    await tick();
    const ext = (await rows(b.id)).filter((x: any) => x.status === "settled_external");
    const ev = await eventsFor(ext.map((x: any) => x.id));
    assert.equal(ev.filter((e: any) => e.event === "charge" && e.status === "posted").length, 3);
    assert.equal(ev.filter((e: any) => e.event === "settled_external" && e.status === "posted").length, 3);
    const again: any = await attempt(() => env.contracts.update(user, String(b.id), { externalSettlementMode: "skip" }));
    assert.equal(again.status, 409);
  });

  it("the trial balance still balances", async () => {
    const [t] = await env.q(`select coalesce(sum(debit),0)::text as dr, coalesce(sum(credit),0)::text as cr from journal_lines where user_id = $1`, [U]);
    assert.equal(t.dr, t.cr);
  });
});
