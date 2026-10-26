import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fv2DbSkip, withDb, type TestDb } from "./__tests__/with-db";
import { withTx } from "./db";
import { FinanceFlagService } from "./flag.service";
import { PeriodsService } from "./periods.service";
import { ChartService } from "./chart.service";
import { FinanceSetupService } from "./setup.service";
import { JournalRepository } from "./journal.repository";
import { PostingEngine } from "./posting.engine";
import { LedgerEmitter } from "./ledger-emitter.service";
import { PostingWorker } from "./posting-worker.service";
import { LedgerStartService } from "./ledger-start.service";
import { fromHalalas, vatSplit } from "./money";
import { SYS, type OutboxPayload } from "./rules";
import { archiveLedger, ledgerCounts, restoreLedger } from "./ledger-archive";

/**
 * Archive → purge → restore of an account's derived ledger, including a reversed entry and its reversal (the
 * restore inserts it as posted and then marks it reversed, the one update the ledger allows). Synthetic only.
 */
const MIGRATION_0090 = join(__dirname, "../../../db/drizzle/0090_plan_transitions.sql");

describe("finance v2 ledger archive / restore (real Postgres)", { skip: fv2DbSkip }, () => {
  let t: TestDb;
  let emitter: LedgerEmitter;
  let worker: PostingWorker;
  const U = 9601, OTHER = 9602;
  const DIMS = { ownerId: 7, propertyId: 3, unitId: 5, tenantId: 11, contractId: 13 };
  const q = async (sql: string, p: unknown[] = []) => (await t.pool.query(sql, p)).rows;
  let seq = 5000;
  const expense = (date: string, gross: number): OutboxPayload => {
    const { net, vat } = vatSplit(gross);
    return { rule: "E18", facts: { date, treatment: "principal", dims: DIMS, expenseId: ++seq, revision: 1, gross: fromHalalas(gross), net: fromHalalas(net), vat: fromHalalas(vat), category: "S", rate: 15, recoverable: true, chargeTo: "company", expenseAccount: { sys: SYS.expensePropertyOther }, bank: { method: "cash" } } } as any;
  };
  const snapshot = async (u: number) => ({
    entries: await q(`select id, entry_no, status, reversal_of, reversed_by, total::text, source_type, source_id, event from journal_entries where user_id = $1 order by id`, [u]),
    lines: await q(`select id, entry_id, line_no, account_id, debit::text, credit::text from journal_lines where user_id = $1 order by id`, [u]),
    outbox: await q(`select id, status, entry_id, event from ledger_outbox where user_id = $1 order by id`, [u]),
  });

  before(async () => {
    process.env.FINANCE_V2_WORKER_DISABLED = "1";
    t = await withDb({ legacy: "full" });
    await t.apply(MIGRATION_0090);
    const periods = new PeriodsService(t.pool);
    const setup = new FinanceSetupService(new ChartService(t.pool), periods);
    const engine = new PostingEngine(t.pool, new JournalRepository(periods), periods);
    emitter = new LedgerEmitter(t.pool);
    worker = new PostingWorker(t.pool, engine, emitter);
    worker.lockPool = t.pool;
    worker.onModuleInit();
    const start = new LedgerStartService(new FinanceFlagService(t.pool), worker);
    for (const u of [U, OTHER]) {
      await q(`insert into users (id, email, password_hash, name) values ($1, $2, 'x', 'Synthetic')`, [u, `arch-${u}@example.test`]);
      await q(`insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode) values ($1, true, 'owner')`, [u]);
      await withTx(t.pool, (c) => setup.firstEnable(c, u, null));
      await withTx(t.pool, (c) => start.markStarted(c, u));
    }
    for (const u of [U, OTHER]) {
      const p1 = expense("2026-08-01", 115_00), p2 = expense("2026-08-02", 230_00);
      await emitter.emit({ fv2: true, userId: u }, { sourceType: "expense", sourceId: (p1.facts as any).expenseId, event: "rev:1", occurredOn: "2026-08-01", payload: p1 });
      await emitter.emit({ fv2: true, userId: u }, { sourceType: "expense", sourceId: (p2.facts as any).expenseId, event: "rev:1", occurredOn: "2026-08-02", payload: p2 });
      await emitter.emit({ fv2: true, userId: u }, { sourceType: "expense", sourceId: (p1.facts as any).expenseId, event: "reversal:rev:1", occurredOn: "2026-08-03", payload: { rule: "E18", facts: { date: "2026-08-03" } } as any });
      for (let i = 0; i < 10; i++) {
        const r = await worker.runAccount(u);
        if (!r || r.posted + r.skipped + r.failed + r.retry === 0) break;
      }
    }
  });

  after(async () => {
    delete process.env.FINANCE_V2_WORKER_DISABLED;
    await t?.drop();
  });

  it("archives, purges and restores byte-for-byte (ids, statuses, reversal links, amounts); other accounts untouched", async () => {
    const before = await snapshot(U);
    const other = await snapshot(OTHER);
    assert.equal(before.entries.length, 3);
    assert.ok(before.entries.some((e: any) => e.status === "reversed" && e.reversed_by));
    const counts = await ledgerCounts(t.pool as any, U);
    const [{ started }] = await q(`select ledger_started_at as started from finance_settings where account_user_id = $1`, [U]);

    const archiveId = await withTx(t.pool, async (c) => {
      const id = await archiveLedger(c, U, null, "spec archive");
      await c.query(`select fv2_purge_account($1, true)`, [U]);
      await c.query(`update finance_settings set accounting_mode = 'manager', ledger_started_at = null where account_user_id = $1`, [U]);
      return id;
    });
    assert.equal((await q(`select count(*)::int n from journal_entries where user_id = $1`, [U]))[0].n, 0);
    const [arch] = await q(`select counts from finance_ledger_archives where id = $1`, [archiveId]);
    assert.deepEqual(arch.counts, counts);

    const res = await withTx(t.pool, (c) => restoreLedger(c, archiveId, 1, "spec restore"));
    assert.equal(res.accountUserId, U);
    assert.deepEqual(res.counts, counts);
    assert.deepEqual(await snapshot(U), before);
    assert.deepEqual(await snapshot(OTHER), other);
    const [fs] = await q(`select accounting_mode, ledger_started_at from finance_settings where account_user_id = $1`, [U]);
    assert.equal(fs.accounting_mode, "owner");
    assert.equal(new Date(fs.ledger_started_at).getTime(), new Date(started).getTime());

    // New entries after a restore get fresh ids (the sequence is past the restored ones).
    const p3 = expense("2026-08-05", 115_00);
    await emitter.emit({ fv2: true, userId: U }, { sourceType: "expense", sourceId: (p3.facts as any).expenseId, event: "rev:1", occurredOn: "2026-08-05", payload: p3 });
    await worker.runAccount(U);
    const ids = (await q(`select id from journal_entries where user_id = $1 order by id`, [U])).map((r: any) => Number(r.id));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 4);

    await assert.rejects(withTx(t.pool, (c) => restoreLedger(c, archiveId, 1, "again")), /already restored|RESTORE_BLOCKED/);
  });
});
