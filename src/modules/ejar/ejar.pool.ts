import { eq, sql } from "drizzle-orm";
import { appSettingsTable } from "@dara/database";
import type { Drizzle } from "../../database/database.module";
import { SUCCESS_SQL } from "./ejar.usage";

/**
 * The Ejar call pool: the calls Dara has bought from the gateway (e.g. 500),
 * shared by every account. Set by a super-admin in Admin › Ejar usage and
 * kept in `app_settings` — one row, global by design.
 *
 * Only successful calls are deducted (SUCCESS_SQL): every Balady data call
 * since `since`, on any endpoint, any account. When the pool is empty no
 * lookup starts (the lookup needs room for Invoices + its second call, and the
 * Details fallback for one more). `total: null` = no pool configured, the
 * gateway's own EJAR_LOOKUP_LIMIT budget is the only cap.
 */
export const EJAR_POOL_KEY = "ejar_call_pool";

export interface EjarPoolSetting {
  total: number | null;
  /** ISO timestamp the pool is counted from (the purchase / renewal date). */
  since: string;
  note: string | null;
  updatedBy: number | null;
  updatedAt: string | null;
}

export interface EjarPool {
  limit: number;
  used: number;
}

const EPOCH = "2026-01-01T00:00:00.000Z";

export function coercePool(v: unknown): EjarPoolSetting {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const n = Number(o.total);
  const total = o.total == null || o.total === "" || !Number.isInteger(n) || n < 0 ? null : n;
  const d = typeof o.since === "string" ? new Date(o.since) : null;
  const since = d && !Number.isNaN(d.getTime()) ? d.toISOString() : EPOCH;
  const note = typeof o.note === "string" && o.note.trim() ? o.note.trim().slice(0, 500) : null;
  const by = Number(o.updatedBy);
  return {
    total, since, note,
    updatedBy: Number.isInteger(by) && by > 0 ? by : null,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null,
  };
}

export async function readPoolSetting(db: Drizzle): Promise<EjarPoolSetting> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, EJAR_POOL_KEY)).limit(1);
  return coercePool(row?.value ?? null);
}

export async function writePoolSetting(db: Drizzle, next: EjarPoolSetting): Promise<EjarPoolSetting> {
  const value = coercePool(next);
  await db
    .insert(appSettingsTable)
    .values({ key: EJAR_POOL_KEY, value: value as never })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: value as never, updatedAt: sql`now()` } });
  return value;
}

/** Successful Balady calls since `since` — what the pool has spent. */
export async function poolUsed(db: Drizzle, since: string): Promise<number> {
  const res: any = await db.execute(sql`
    select count(*)::int as n
      from ejar_api_logs l
     where l.env like 'balady%'
       and ${SUCCESS_SQL}
       and l.created_at >= ${since}::timestamptz`);
  const rows: Array<{ n: number }> = Array.isArray(res) ? res : res?.rows ?? [];
  return Number(rows[0]?.n ?? 0);
}

/** The pool as the lookup gate needs it; null when none is configured. */
export async function readPool(db: Drizzle): Promise<EjarPool | null> {
  const s = await readPoolSetting(db);
  if (s.total == null) return null;
  return { limit: s.total, used: await poolUsed(db, s.since) };
}

/** Calls left in the pool (null pool = unlimited). */
export const poolLeft = (p: EjarPool | null): number => (p ? Math.max(0, p.limit - p.used) : Number.POSITIVE_INFINITY);
