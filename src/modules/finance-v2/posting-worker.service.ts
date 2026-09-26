import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type pg from "pg";
import { createAuxPool } from "@dara/database";
import { FV2_POOL, type Fv2Pool } from "./db";
import { PostingEngine } from "./posting.engine";
import { LedgerEmitter } from "./ledger-emitter.service";

const TICK_MS = 5_000;

type LockPool = Pick<pg.Pool, "connect">;

/**
 * The per-account serial posting worker (DESIGN §5.3), after the
 * NewsSchedulerService pattern: a 5 s `setInterval` (unref'd) plus `kick()`.
 * `FINANCE_V2_WORKER_DISABLED=1` switches it off (tests).
 *
 * Per tick: the accounts with due `pending` rows AND the flag on AND
 * `ledger_started_at` set (§1.5: until the first real backfill nothing posts;
 * live events wait in the outbox). For each, a session advisory lock
 * `hashtextextended('fv2:'||user_id, 0)` on a DEDICATED client from a small
 * auxiliary pool, held for the account's batch and released on that same
 * client, so only one worker posts an account at a time, across processes.
 */
@Injectable()
export class PostingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("FinanceV2Worker");
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private kicked = new Set<number>();
  /** Injected by tests (a pool on their throwaway schema); lazily the aux pool otherwise. */
  lockPool: LockPool | null = null;

  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly engine: PostingEngine,
    private readonly emitter: LedgerEmitter,
  ) {}

  onModuleInit(): void {
    this.emitter.onKick = (userId) => this.kick(userId);
    if (process.env.FINANCE_V2_WORKER_DISABLED === "1") {
      this.log.log("finance v2 posting worker disabled (FINANCE_V2_WORKER_DISABLED=1)");
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wake the worker for one account (after the source transaction committed). */
  kick(userId: number): void {
    if (!this.timer) return;
    this.kicked.add(userId);
    setImmediate(() => void this.tick());
  }

  /** Accounts the worker may post for now. */
  async dueAccounts(): Promise<number[]> {
    const r = await this.pool.query(
      `select distinct o.user_id from ledger_outbox o
         join finance_settings s on s.account_user_id = o.user_id
        where o.status = 'pending' and o.next_attempt_at <= now()
          and s.finance_v2_enabled and s.ledger_started_at is not null`,
    );
    return r.rows.map((x: any) => Number(x.user_id));
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.kicked.clear();
      for (const userId of await this.dueAccounts()) await this.runAccount(userId);
    } catch (err: any) {
      // 42P01: the Finance v2 tables are absent (the 0066 block failed at boot): nothing to post, stay quiet.
      if (err?.code !== "42P01") this.log.warn(`finance v2 worker tick failed: ${err?.message ?? err}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Post one account's due rows under its session lock. Returns null when another worker holds it. */
  async runAccount(userId: number, limit = 200) {
    const lp = (this.lockPool ??= createAuxPool(2, "finance-v2 worker lock pool"));
    const client = await lp.connect();
    let got = false;
    try {
      const r = await client.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as got", [`fv2:${userId}`]);
      got = r.rows[0]?.got === true;
      if (!got) return null;
      return await this.engine.processAccount(userId, limit);
    } finally {
      let broken = false;
      if (got) {
        try {
          await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`fv2:${userId}`]);
        } catch {
          broken = true; // destroy the session so the lock cannot linger
        }
      }
      client.release(broken || undefined);
    }
  }
}
