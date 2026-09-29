import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { FV2_POOL, type Fv2Pool } from "./db";
import type { FlagState } from "./flag.service";
import type { OutboxPayload } from "./rules";

/** Anything that runs raw SQL: a pg client/pool, or a Drizzle transaction (the legacy handlers' `tx`). */
type PgLike = { query: (text: string, params?: unknown[]) => Promise<{ rowCount?: number | null; rows: any[] }> };
type DrizzleLike = { execute: (q: any) => Promise<any>; transaction: <T>(fn: (sp: any) => Promise<T>) => Promise<T> };

export interface EmitCtx {
  /** The flag resolved ONCE at handler entry, before any transaction (§1.2). Off → emit is a no-op. */
  fv2: boolean | Pick<FlagState, "on"> | null | undefined;
  /** scopeId(user): the account the event belongs to. */
  userId: number;
  /**
   * The SOURCE transaction, when the path has one (§5.1 point 3): the outbox
   * row then commits atomically with the money change. The insert runs in a
   * savepoint so a failure rolls back only itself. Omit it on paths without a
   * transaction: the row is written right after the last write.
   */
  tx?: PgLike | DrizzleLike | null;
}

export interface LedgerEvent {
  sourceType: string;
  sourceId: number;
  event: string;
  /** Business date (YYYY-MM-DD, Riyadh). */
  occurredOn: string;
  payload: OutboxPayload | { rule?: undefined; facts: { date: string; [k: string]: unknown } };
  origin?: "live" | "backfill" | "recognizer" | "repair";
  backfillRunId?: number | null;
}

const INSERT = `insert into ledger_outbox (user_id, source_type, source_id, event, occurred_on, origin, payload, backfill_run_id)
  values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
  on conflict (user_id, source_type, source_id, event) do nothing`;

function isOn(fv2: EmitCtx["fv2"]): boolean {
  return fv2 === true || (typeof fv2 === "object" && fv2 !== null && fv2.on === true);
}

/**
 * Enqueue ledger events (DESIGN §5.1). Never throws into the caller and never
 * blocks the user's action: with the flag off it does nothing at all; on an
 * insert failure it logs `finance_v2.enqueue_failed` and returns false, and the
 * nightly catch-up sweep fills the gap. A second emit of the same key is a
 * no-op (the outbox's unique key), which is the enqueue half of idempotency.
 */
@Injectable()
export class LedgerEmitter {
  private readonly log = new Logger("FinanceV2Emitter");
  /** Set by the worker so an emit can wake it after the source commits. */
  onKick: ((userId: number) => void) | null = null;

  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool) {}

  /** Returns true when a new outbox row was written. */
  async emit(ctx: EmitCtx, ev: LedgerEvent): Promise<boolean> {
    if (!isOn(ctx.fv2)) return false;
    const params = [
      ctx.userId, ev.sourceType, ev.sourceId, ev.event, ev.occurredOn, ev.origin ?? "live",
      JSON.stringify(ev.payload), ev.backfillRunId ?? null,
    ];
    try {
      const tx = ctx.tx;
      if (tx && "execute" in tx && "transaction" in tx) {
        const [u, st, sid, e, on, o, pl, br] = params;
        const res = await tx.transaction(async (sp: any) => sp.execute(sql`
          insert into ledger_outbox (user_id, source_type, source_id, event, occurred_on, origin, payload, backfill_run_id)
          values (${u}, ${st}, ${sid}, ${e}, ${on}, ${o}, ${pl}::jsonb, ${br})
          on conflict (user_id, source_type, source_id, event) do nothing`));
        return (res?.rowCount ?? 0) > 0;
      }
      if (tx && "query" in tx) {
        await tx.query("savepoint fv2_emit");
        try {
          const r = await tx.query(INSERT, params);
          await tx.query("release savepoint fv2_emit");
          return (r.rowCount ?? 0) > 0;
        } catch (err) {
          await tx.query("rollback to savepoint fv2_emit").catch(() => undefined);
          throw err;
        }
      }
      const r = await this.pool.query(INSERT, params);
      return (r.rowCount ?? 0) > 0;
    } catch (err: any) {
      // First line only: a Drizzle error message would otherwise echo the whole payload.
      const msg = String(err?.cause?.message ?? err?.message ?? err).split("\n")[0];
      this.log.warn(`finance_v2.enqueue_failed ${ev.sourceType},${ev.sourceId},${ev.event}: ${msg}`);
      return false;
    }
  }

  /** Call AFTER the source transaction resolved (§5.1 point 4): posting then lands within a second. */
  kick(userId: number): void {
    try {
      this.onKick?.(userId);
    } catch {
      /* never reaches the user action */
    }
  }
}
