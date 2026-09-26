import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import { fv2DbSkip, withDb, type TestDb } from "./__tests__/with-db";
import { withTx } from "./db";
import { FinanceFlagService } from "./flag.service";
import { PeriodsService } from "./periods.service";
import { ChartService } from "./chart.service";
import { FinanceSetupService } from "./setup.service";
import { JournalRepository } from "./journal.repository";
import { PostingEngine, MAX_ATTEMPTS, backoffMs } from "./posting.engine";
import { LedgerEmitter } from "./ledger-emitter.service";
import { PostingWorker } from "./posting-worker.service";
import { PostingErrorsService } from "./posting-errors.service";
import { LedgerStartService } from "./ledger-start.service";
import { toHalalas, vatSplit, fromHalalas } from "./money";
import { SYS, type OutboxPayload } from "./rules";

/**
 * The posting engine against a real (throwaway, local) Postgres (DESIGN §5,
 * §11.1-b/c/d, §11.3-d): outbox enqueue, ledger_started_at gating, the serial
 * worker, idempotency, reversal, late routing, blocking, retry/backoff and
 * the posting-errors list. Synthetic ids and amounts only.
 */
describe("finance v2 posting engine (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let engine: PostingEngine;
  let emitter: LedgerEmitter;
  let worker: PostingWorker;
  let errors: PostingErrorsService;
  let start: LedgerStartService;
  const U = 9101;       // flag on, ledger started (manager mode)
  const IDLE = 9102;    // flag on, ledger NOT started
  const OFF = 9103;     // flag off
  const ACTOR = 77;
  const DIMS = { ownerId: 7, propertyId: 3, unitId: 5, tenantId: 11, contractId: 13 };
  const q = (sql: string, p: unknown[] = []) => t.pool.query(sql, p);
  let seq = 1000;
  const sid = () => ++seq;

  const emit = (userId: number, sourceType: string, sourceId: number, event: string, payload: OutboxPayload, fv2 = true) =>
    emitter.emit({ fv2, userId }, { sourceType, sourceId, event, occurredOn: payload.facts.date, payload });

  const outbox = async (userId: number, sourceType: string, sourceId: number, event: string) =>
    (await q(`select * from ledger_outbox where user_id = $1 and source_type = $2 and source_id = $3 and event = $4`, [userId, sourceType, sourceId, event])).rows[0];
  const entry = async (userId: number, sourceType: string, sourceId: number, event: string) =>
    (await q(`select *, to_char(entry_date,'YYYY-MM-DD') as d, to_char(original_date,'YYYY-MM-DD') as od from journal_entries
               where user_id = $1 and source_type = $2 and source_id = $3 and event = $4`, [userId, sourceType, sourceId, event])).rows[0];
  const lines = async (entryId: number) =>
    (await q(`select l.*, a.system_key, a.code from journal_lines l join accounts a on a.id = l.account_id where entry_id = $1 order by line_no`, [entryId])).rows;
  const run = () => worker.runAccount(U);

  const payout = (date: string, amount = "500.00"): OutboxPayload =>
    ({ rule: "E19", facts: { date, treatment: "agent", dims: DIMS, amount, bank: { method: "bank_transfer" } } });
  const invoice = (p: number, gross: number, date = "2026-08-01", docId = sid()): OutboxPayload => {
    const { net, vat } = vatSplit(gross);
    return {
      rule: "E01", paymentIds: [p],
      facts: { date, treatment: "agent", dims: DIMS, documentId: docId, groups: [{ category: "S", rate: 15, net: fromHalalas(net), vat: fromHalalas(vat), nature: "rent", usage: "commercial" }], coverage: [{ paymentId: p, amount: fromHalalas(gross) }], deferRent: true },
    };
  };
  const dueCharge = (p: number, gross: string, date = "2026-07-01", t2: "agent" | "principal" = "agent"): OutboxPayload =>
    ({ rule: "E02", paymentIds: [p], facts: { date, treatment: t2, dims: DIMS, paymentId: p, gross, category: "S", rate: 15, nature: "rent", usage: "commercial", deferRent: true } });

  before(async () => {
    process.env.FINANCE_V2_WORKER_DISABLED = "1";
    t = await withDb();
    const periods = new PeriodsService(t.pool);
    const chart = new ChartService(t.pool);
    const flag = new FinanceFlagService(t.pool);
    const setup = new FinanceSetupService(chart, periods);
    const journal = new JournalRepository(periods);
    engine = new PostingEngine(t.pool, journal, periods);
    emitter = new LedgerEmitter(t.pool);
    worker = new PostingWorker(t.pool, engine, emitter);
    worker.lockPool = t.pool;
    worker.onModuleInit(); // disabled by env: registers the kick hook only
    errors = new PostingErrorsService(t.pool);
    start = new LedgerStartService(flag, worker);
    for (const [u, on] of [[U, true], [IDLE, true], [OFF, false]] as const) {
      await q(`insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode) values ($1, $2, 'manager')`, [u, on]);
      await withTx(t.pool, (c) => setup.firstEnable(c, u, ACTOR));
    }
    await withTx(t.pool, (c) => start.markStarted(c, U));
  });
  after(async () => {
    delete process.env.FINANCE_V2_WORKER_DISABLED;
    await t?.drop();
  });

  describe("enqueue (§5.1)", () => {
    it("does nothing with the flag off; a second emit of a key is a no-op", async () => {
      const id = sid();
      assert.equal(await emit(U, "landlord_payout", id, "created", payout("2026-08-02"), false), false);
      assert.equal((await q(`select count(*)::int n from ledger_outbox where source_id = $1`, [id])).rows[0].n, 0);
      assert.equal(await emit(U, "landlord_payout", id, "created", payout("2026-08-02")), true);
      assert.equal(await emit(U, "landlord_payout", id, "created", payout("2026-08-02")), false);
      assert.equal(await emitter.emit({ fv2: { on: true }, userId: U }, { sourceType: "landlord_payout", sourceId: id, event: "created", occurredOn: "2026-08-02", payload: payout("2026-08-02") }), false);
      assert.equal((await q(`select count(*)::int n from ledger_outbox where source_id = $1`, [id])).rows[0].n, 1);
    });

    it("inside the source transaction: a failed insert rolls back only its savepoint (pg client)", async () => {
      const id = sid();
      await withTx(t.pool, async (c) => {
        await c.query(`insert into audit_logs (owner_user_id, actor_user_id, action, entity, method, path) values ($1, 1, 'update', 'synthetic', 'POST', '/x')`, [id]);
        const ok = await emitter.emit({ fv2: true, userId: U, tx: c }, { sourceType: "landlord_payout", sourceId: id, event: "created", occurredOn: "not-a-date", payload: payout("2026-08-02") });
        assert.equal(ok, false);
        await c.query(`select 1`); // the transaction is still usable
      });
      assert.equal((await q(`select count(*)::int n from audit_logs where owner_user_id = $1`, [id])).rows[0].n, 1, "the source write committed");
      assert.equal((await q(`select count(*)::int n from ledger_outbox where source_id = $1`, [id])).rows[0].n, 0);
    });

    it("inside a Drizzle transaction: commits atomically with the source write, or not at all", async () => {
      const db = drizzle(t.pool as any);
      const ok = sid();
      await db.transaction(async (tx) => {
        assert.equal(await emitter.emit({ fv2: true, userId: U, tx }, { sourceType: "landlord_payout", sourceId: ok, event: "created", occurredOn: "2026-08-02", payload: payout("2026-08-02") }), true);
      });
      assert.ok(await outbox(U, "landlord_payout", ok, "created"));
      const rolled = sid();
      await assert.rejects(db.transaction(async (tx) => {
        await emitter.emit({ fv2: true, userId: U, tx }, { sourceType: "landlord_payout", sourceId: rolled, event: "created", occurredOn: "2026-08-02", payload: payout("2026-08-02") });
        throw new Error("source write failed");
      }));
      assert.equal(await outbox(U, "landlord_payout", rolled, "created"), undefined, "rolled back with the source");
      const bad = sid();
      await db.transaction(async (tx) => {
        assert.equal(await emitter.emit({ fv2: true, userId: U, tx }, { sourceType: "landlord_payout", sourceId: bad, event: "created", occurredOn: "garbage", payload: payout("2026-08-02") }), false);
      });
    });
  });

  describe("gating (§1.5 two switches)", () => {
    it("the worker skips accounts whose ledger has not started, or whose flag is off", async () => {
      await emit(IDLE, "landlord_payout", sid(), "created", payout("2026-08-02"));
      await q(`insert into ledger_outbox (user_id, source_type, source_id, event, occurred_on, payload) values ($1, 'landlord_payout', $2, 'created', '2026-08-02', $3)`,
        [OFF, sid(), JSON.stringify(payout("2026-08-02"))]);
      await emit(U, "landlord_payout", sid(), "created", payout("2026-08-02"));
      const due = await worker.dueAccounts();
      assert.ok(due.includes(U));
      assert.ok(!due.includes(IDLE) && !due.includes(OFF));
      await worker.tick();
      assert.equal((await q(`select count(*)::int n from journal_entries where user_id in ($1, $2)`, [IDLE, OFF])).rows[0].n, 0);
      assert.equal((await q(`select count(*)::int n from ledger_outbox where user_id = $1 and status = 'pending'`, [U])).rows[0].n, 0);
    });

    it("markStarted sets ledger_started_at once; the queued events then post in order", async () => {
      await withTx(t.pool, async (c) => assert.equal(await start.markStarted(c, IDLE), true));
      await withTx(t.pool, async (c) => assert.equal(await start.markStarted(c, IDLE), false));
      await withTx(t.pool, async (c) => assert.equal(await start.markStarted(c, OFF), false, "never while the flag is off"));
      assert.ok((await worker.dueAccounts()).includes(IDLE));
      await worker.runAccount(IDLE);
      assert.equal((await q(`select count(*)::int n from journal_entries where user_id = $1`, [IDLE])).rows[0].n, 1);
    });

    it("only one worker posts an account at a time (session advisory lock)", async () => {
      const holder = await t.pool.connect();
      try {
        await holder.query("select pg_advisory_lock(hashtextextended($1, 0))", [`fv2:${U}`]);
        assert.equal(await worker.runAccount(U), null);
      } finally {
        await holder.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`fv2:${U}`]);
        holder.release();
      }
      assert.notEqual(await worker.runAccount(U), null);
    });
  });

  describe("posting, idempotency and reversal (§5.3, §5.4, §11.1-b, c)", () => {
    it("posts a balanced entry with dims, bank_account_id and the payload frozen on it", async () => {
      const id = sid();
      await emit(U, "landlord_payout", id, "created", payout("2026-08-05", "1234.56"));
      await run();
      const ob = await outbox(U, "landlord_payout", id, "created");
      assert.equal(ob.status, "posted");
      const e = await entry(U, "landlord_payout", id, "created");
      assert.equal(Number(ob.entry_id), Number(e.id));
      assert.match(e.entry_no, /^JV-2026-\d{6}$/);
      assert.deepEqual(e.payload, ob.payload);
      const ls = await lines(e.id);
      assert.deepEqual(ls.map((l: any) => [l.code, l.debit, l.credit]), [["2121", "1234.56", "0.00"], ["1113", "0.00", "1234.56"]]);
      assert.ok(ls[1].bank_account_id, "bank line carries bank_account_id");
      assert.ok(ls.every((l: any) => l.owner_id === 7 && l.tenant_id === 11 && l.contract_id === 13));
    });

    it("a replayed key marks the row posted with the SAME entry; a different payload is KEY_COLLISION", async () => {
      const id = sid();
      await emit(U, "landlord_payout", id, "created", payout("2026-08-06"));
      await run();
      const e = await entry(U, "landlord_payout", id, "created");
      await q(`update ledger_outbox set status = 'pending', entry_id = null where user_id = $1 and source_id = $2`, [U, id]);
      await run();
      const ob = await outbox(U, "landlord_payout", id, "created");
      assert.equal(ob.status, "posted");
      assert.equal(Number(ob.entry_id), Number(e.id));
      assert.equal((await q(`select count(*)::int n from journal_entries where user_id = $1 and source_id = $2`, [U, id])).rows[0].n, 1);

      await q(`update ledger_outbox set status = 'pending', payload = $3 where user_id = $1 and source_id = $2`, [U, id, JSON.stringify(payout("2026-08-06", "9.99"))]);
      await run();
      const bad = await outbox(U, "landlord_payout", id, "created");
      assert.equal(bad.status, "failed");
      assert.equal(bad.last_error_code, "KEY_COLLISION");
    });

    it("a reversal event mirrors the original, marks it reversed, and nets to zero per account and dims", async () => {
      const id = sid();
      const { net, vat } = vatSplit(115_00);
      await emit(U, "expense", id, "rev:1", {
        rule: "E18", facts: { date: "2026-08-07", treatment: "principal", dims: DIMS, expenseId: id, revision: 1, gross: "115.00", net: fromHalalas(net), vat: fromHalalas(vat), category: "S", rate: 15, recoverable: true, chargeTo: "company", expenseAccount: { sys: SYS.expensePropertyOther }, bank: { method: "cash" } },
      });
      await emit(U, "expense", id, "reversal:rev:1", { rule: "E18", facts: { date: "2026-08-09" } } as any);
      await run();
      const orig = await entry(U, "expense", id, "rev:1");
      const rev = await entry(U, "expense", id, "reversal:rev:1");
      assert.equal(orig.status, "reversed");
      assert.equal(Number(orig.reversed_by), Number(rev.id));
      assert.equal(Number(rev.reversal_of), Number(orig.id));
      assert.equal(rev.origin, "reversal");
      const net0 = await q(
        `select account_id, owner_id, tenant_id, contract_id, sum(debit - credit)::text s, sum(coalesce(vat_base,0))::numeric(14,2)::text b
           from journal_lines where entry_id in ($1, $2) group by 1,2,3,4`, [orig.id, rev.id]);
      assert.ok(net0.rows.length >= 3);
      for (const r of net0.rows) assert.deepEqual([r.s, r.b], ["0.00", "0.00"]);
    });

    it("a reversal whose original never posted is skipped nothing_to_reverse", async () => {
      const id = sid();
      await emit(U, "expense", id, "reversal:rev:1", { rule: "E18", facts: { date: "2026-08-09" } } as any);
      await run();
      const ob = await outbox(U, "expense", id, "reversal:rev:1");
      assert.deepEqual([ob.status, ob.skip_reason], ["skipped", "nothing_to_reverse"]);
    });
  });

  describe("installment state at post time (§4.1, §5.3)", () => {
    it("a document replaces an active due-date charge (reverse-and-replace) and marks generation 2", async () => {
      const p = sid();
      await emit(U, "payment", p, "charge", dueCharge(p, "6900.00"));
      await emit(U, "simple_invoice", sid(), "confirmed", invoice(p, 690000, "2026-08-01"));
      await run();
      const due = await entry(U, "payment", p, "charge");
      assert.equal(due.status, "reversed");
      assert.ok(await entry(U, "payment", p, "reversal:charge"));
      const marks = (await q(`select generation, charged_by, reversed_at is null as active, amount::text from finance_installment_charges where payment_id = $1 order by generation`, [p])).rows;
      assert.deepEqual(marks.map((m: any) => [m.generation, m.charged_by, m.active]), [[1, "due", false], [2, "document", true]]);
      const bal = await q(`select a.system_key, sum(l.debit - l.credit)::text s from journal_lines l join accounts a on a.id = l.account_id
                            where l.user_id = $1 and l.payment_id = $2 group by 1`, [U, p]);
      const by = Object.fromEntries(bal.rows.map((r: any) => [r.system_key, r.s]));
      assert.equal(by[SYS.arAgency], "0.00", "the due charge's AR is fully reversed on the installment dim");
    });

    it("advance VAT books a VAT point and the later charge nets it", async () => {
      const p = sid();
      const cid = sid();
      const coll = { date: "2026-06-10", treatment: "principal", dims: DIMS, collectionId: cid, amount: "3450.00", cls: "rent", bank: { method: "cash" }, paymentId: p, category: "S", rate: 15 };
      await emit(U, "payment_collection", cid, "collected", { rule: "E03", paymentIds: [p], facts: coll });
      await emit(U, "payment_collection", cid, "advance_vat", { rule: "E34", paymentIds: [p], facts: coll });
      await emit(U, "payment", p, "charge", dueCharge(p, "6900.00", "2026-07-01", "principal"));
      await run();
      const vp = (await q(`select vat_booked::text v from finance_installment_vat_points where collection_id = $1`, [cid])).rows[0];
      assert.equal(vp.v, "450.00");
      const vatLines = await q(`select sum(credit - debit)::text vat, sum(vat_base)::text base from journal_lines where user_id = $1 and payment_id = $2 and tax_role = 'output'`, [U, p]);
      assert.deepEqual([vatLines.rows[0].vat, vatLines.rows[0].base], ["900.00", "6000.00"]);
      const ch = (await q(`select amount::text a, vat_amount::text v from finance_installment_charges where payment_id = $1 and reversed_at is null`, [p])).rows[0];
      assert.deepEqual([ch.a, ch.v], ["6450.00", "450.00"]);
    });
  });

  describe("late events and closed periods (§4.7, §11.1-d)", () => {
    it("an event in a closed period posts on the first day of the next open period, flagged", async () => {
      await q(`update fiscal_periods set status = 'closed' where user_id = $1 and starts_on = '2026-03-01'`, [U]);
      const id = sid();
      await emit(U, "landlord_payout", id, "created", payout("2026-03-10"));
      await run();
      const e = await entry(U, "landlord_payout", id, "created");
      assert.deepEqual([e.d, e.od, e.is_late], ["2026-04-01", "2026-03-10", true]);
      assert.ok(e.warnings.includes("late_posting"));
      const ob = await outbox(U, "landlord_payout", id, "created");
      assert.equal(ob.payload.late.originalDate, "2026-03-10");
      assert.ok(ob.payload.late.closedPeriodId);
    });

    it("VAT-bearing entries also skip a VAT-locked period; locked periods chain forward", async () => {
      await q(`update fiscal_periods set status = 'locked' where user_id = $1 and starts_on = '2026-02-01'`, [U]);
      await q(`update fiscal_periods set vat_locked_at = now() where user_id = $1 and starts_on in ('2026-03-01', '2026-04-01')`, [U]);
      const id = sid();
      await emit(U, "simple_invoice", id, "confirmed", {
        rule: "E17", facts: { date: "2026-02-15", treatment: "principal", dims: DIMS, documentId: id, groups: [{ category: "S", rate: 15, net: "1000.00", vat: "150.00", nature: "other" }], coverage: [], deferRent: false },
      });
      await run();
      const e = await entry(U, "simple_invoice", id, "confirmed");
      assert.deepEqual([e.d, e.od, e.is_late], ["2026-05-01", "2026-02-15", true]);
      const noVat = sid();
      await emit(U, "landlord_payout", noVat, "created", payout("2026-02-15"));
      await run();
      assert.equal((await entry(U, "landlord_payout", noVat, "created")).d, "2026-04-01", "no VAT lines: April is open");
    });

    it("the DB still refuses a direct post into a closed period; a manual journal is never moved (PERIOD_CLOSED)", async () => {
      const acc = (await q(`select id from accounts where user_id = $1 and code in ('1113','3100') order by code`, [U])).rows;
      const id = sid();
      await emit(U, "manual_journal", id, "posted", {
        rule: "E28", entryOrigin: "manual",
        facts: { date: "2026-02-10", lines: [{ accountId: acc[0].id, debit: "10.00", credit: "0" }, { accountId: acc[1].id, debit: "0", credit: "10.00" }] },
      } as any);
      await run();
      const ob = await outbox(U, "manual_journal", id, "posted");
      assert.deepEqual([ob.status, ob.last_error_code], ["failed", "PERIOD_CLOSED"]);
      // (Feb stays locked and Mar/Apr VAT-locked: both are irreversible, and nothing later in this file posts there.)
    });
  });

  describe("failures: blocking, retry with backoff, posting errors (§5.3–§5.5, §11.3-d)", () => {
    it("backoff is min(2^n × 30 s, 6 h)", () => {
      assert.deepEqual([1, 2, 5, 10, 20].map(backoffMs), [60_000, 120_000, 960_000, 21_600_000, 21_600_000]);
    });

    it("a retryable error goes through 8 attempts to failed, with backoff between them", async () => {
      const p = sid();
      await emit(U, "payment", p, "settled_external", { rule: "E33", paymentIds: [p], facts: { date: "2026-08-01", treatment: "principal", dims: DIMS, paymentId: p, gross: "100.00", category: "O", rate: 0, nature: "rent", deferRent: true } });
      for (let i = 1; i <= MAX_ATTEMPTS; i++) {
        await run();
        const ob = await outbox(U, "payment", p, "settled_external");
        assert.equal(ob.attempts, i);
        assert.equal(ob.last_error_code, "NOT_CHARGED");
        assert.equal(ob.status, i < MAX_ATTEMPTS ? "pending" : "failed");
        if (i < MAX_ATTEMPTS) {
          assert.ok(new Date(ob.next_attempt_at).getTime() > Date.now() + 20_000, "backed off");
          await q(`update ledger_outbox set next_attempt_at = now() where id = $1`, [ob.id]);
        }
      }
      // A charge-state event on the same installment waits behind it.
      await emit(U, "payment", p, "charge_cancelled", { rule: "E05", paymentIds: [p], facts: { date: "2026-08-02", treatment: "principal", dims: DIMS, paymentId: p, gross: "100.00", category: "O", rate: 0, nature: "rent", deferRent: true } });
      await run();
      const blocked = await outbox(U, "payment", p, "charge_cancelled");
      const failed = await outbox(U, "payment", p, "settled_external");
      assert.equal(blocked.status, "pending");
      assert.equal(Number(blocked.blocked_on), Number(failed.id));
      // Dismissing the blocker releases it.
      await errors.dismiss(U, ACTOR, Number(failed.id), { reason: "synthetic: not needed" });
      await run();
      const after = await outbox(U, "payment", p, "charge_cancelled");
      assert.deepEqual([after.status, after.skip_reason], ["skipped", "not_charged"]);
    });

    it("rows blocked behind a failed or backing-off row do not stall the account: a batch reaches the rows after them", async () => {
      const p = sid();
      const cancel = (d: string) => ({ rule: "E05", paymentIds: [p], facts: { date: d, treatment: "principal", dims: DIMS, paymentId: p, gross: "100.00", category: "O", rate: 0, nature: "rent", deferRent: true } });
      for (const [status, next] of [["failed", "now()"], ["pending", "now() + interval '6 hours'"]] as const) {
        const [blocker] = (await q(`insert into ledger_outbox (user_id, source_type, source_id, event, occurred_on, payload, status, attempts, next_attempt_at)
                                    values ($1, 'payment', $2, $3, '2026-08-01', $4, $5, 3, ${next}) returning id`,
          [U, p, `settled_external:${status}`, JSON.stringify(cancel("2026-08-01")), status])).rows;
        // 210 rows already found blocked behind it (more than one batch of 200), then an unrelated payout.
        await q(`insert into ledger_outbox (user_id, source_type, source_id, event, occurred_on, payload, blocked_on)
                 select $1, 'payment', $2, $3 || g, '2026-08-02', $4, $5 from generate_series(1, 210) g`,
          [U, p, `charge_cancelled:${status}:`, JSON.stringify(cancel("2026-08-02")), blocker.id]);
        const id = sid();
        await emit(U, "landlord_payout", id, "created", payout("2026-08-03", "7.00"));
        await engine.processAccount(U, 200);
        assert.equal((await outbox(U, "landlord_payout", id, "created")).status, "posted", `behind a ${status} blocker`);
        await q(`update ledger_outbox set status = 'dismissed' where user_id = $1 and source_id = $2 and status in ('pending','failed')`, [U, p]);
      }
    });

    it("a reversal waits for its failed original, which posts after Retry; then the reversal posts", async () => {
      const id = sid();
      await q(`update accounts set is_active = false where user_id = $1 and system_key = $2`, [U, SYS.drawings]);
      await emit(U, "landlord_payout", id, "created", { rule: "E19", facts: { date: "2026-08-12", treatment: "principal", dims: DIMS, amount: "50.00", bank: {} } });
      await emit(U, "landlord_payout", id, "reversal:created", { rule: "E19", facts: { date: "2026-08-13" } } as any);
      await run();
      const orig = await outbox(U, "landlord_payout", id, "created");
      assert.deepEqual([orig.status, orig.last_error_code, orig.attempts], ["pending", "ACCOUNT_INACTIVE", 1]);
      const rev = await outbox(U, "landlord_payout", id, "reversal:created");
      assert.equal(Number(rev.blocked_on), Number(orig.id));

      const listed = await errors.list(U);
      assert.ok(listed.items.some((i: any) => i.id === String(orig.id) || Number(i.id) === Number(orig.id)));
      const item = listed.items.find((i: any) => Number(i.id) === Number(orig.id));
      assert.equal(item.state, "retrying");
      assert.equal(item.message.en, "A linked account is inactive");
      assert.ok(listed.items.some((i: any) => Number(i.id) === Number(rev.id) && i.state === "blocked"));

      await q(`update accounts set is_active = true where user_id = $1 and system_key = $2`, [U, SYS.drawings]);
      await errors.retry(U, ACTOR, Number(orig.id));
      await run();
      assert.equal((await outbox(U, "landlord_payout", id, "created")).status, "posted");
      assert.equal((await outbox(U, "landlord_payout", id, "reversal:created")).status, "posted");
      assert.equal((await entry(U, "landlord_payout", id, "created")).status, "reversed");
      const audit = await q(`select path from audit_logs where owner_user_id = $1 and entity = 'finance_v2_posting' order by id`, [U]);
      assert.ok(audit.rows.some((r: any) => r.path.endsWith(`/${orig.id}/retry`)));
      assert.ok(audit.rows.some((r: any) => r.path.endsWith("/dismiss")));
    });

    it("posting-errors: scoped to the account, validated, skipped tab separate", async () => {
      const mine = (await q(`select id from ledger_outbox where user_id = $1 limit 1`, [U])).rows[0].id;
      await assert.rejects(errors.retry(IDLE, ACTOR, Number(mine)), NotFoundException);
      await assert.rejects(errors.dismiss(U, ACTOR, Number(mine), { reason: "no" }), BadRequestException);
      const skipped = await errors.list(U, { tab: "skipped" });
      assert.ok(skipped.items.length > 0 && skipped.items.every((i: any) => i.status === "skipped" && i.skipReason));
      assert.ok(skipped.counts.skipped >= skipped.items.length);
    });

    it("every posted entry balances and trial balance debits = credits", async () => {
      const r = await q(`select sum(debit)::text d, sum(credit)::text c from journal_lines where user_id = $1`, [U]);
      assert.equal(toHalalas(r.rows[0].d), toHalalas(r.rows[0].c));
      const bad = await q(`select e.id from journal_entries e join journal_lines l on l.entry_id = e.id
                            group by e.id, e.total having sum(l.debit) <> sum(l.credit) or sum(l.debit) <> e.total`);
      assert.equal(bad.rowCount, 0);
    });
  });
});
