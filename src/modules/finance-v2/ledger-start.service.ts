import { Injectable } from "@nestjs/common";
import type { Fv2Client } from "./db";
import { FinanceFlagService } from "./flag.service";
import { PostingWorker } from "./posting-worker.service";

/**
 * The second switch (DESIGN §1.5): `finance_settings.ledger_started_at`. Until
 * it is set, the emitter queues but the worker (and the recognizer) skip the
 * account. The first successful NON-dry-run backfill sets it, inside its own
 * transaction, through `markStarted`; the caller then calls `afterCommit`.
 */
@Injectable()
export class LedgerStartService {
  constructor(private readonly flag: FinanceFlagService, private readonly worker: PostingWorker) {}

  /** Set ledger_started_at once (idempotent). Returns true when this call started the ledger. */
  async markStarted(c: Pick<Fv2Client, "query">, userId: number): Promise<boolean> {
    const r = await c.query(
      `update finance_settings set ledger_started_at = now(), updated_at = now()
        where account_user_id = $1 and ledger_started_at is null and finance_v2_enabled`,
      [userId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** After the starting transaction committed: drop the cached flag state and wake the worker. */
  afterCommit(userId: number): void {
    this.flag.invalidate(userId);
    this.worker.kick(userId);
  }
}
