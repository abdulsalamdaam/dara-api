import { sql, type SQL } from "drizzle-orm";

/**
 * One way to run raw, positional-parameter SQL (`$1, $2 …`) on whatever handle
 * a legacy handler holds: the Finance v2 pool, a pg client, or a Drizzle
 * transaction (the legacy `tx`). The facts loaders read through it so that,
 * inside a source transaction, they see the rows that transaction has written
 * but not yet committed.
 *
 * Array parameters are sent as Postgres array literals (`{1,2,3}`): Drizzle's
 * `sql` template expands a JS array into a parameter LIST, which would turn
 * `= any($1::int[])` into a syntax error, so arrays never reach it raw.
 */
export interface Sql {
  rows<T = any>(text: string, params?: unknown[]): Promise<T[]>;
  exec(text: string, params?: unknown[]): Promise<number>;
}

type PgLike = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
type DrizzleLike = { execute: (q: SQL) => Promise<any> };

export function pgArray(xs: ReadonlyArray<number>): string {
  for (const x of xs) if (!Number.isInteger(x)) throw new Error(`fv2: not an integer id: ${x}`);
  return `{${xs.join(",")}}`;
}

function normalise(params: unknown[]): unknown[] {
  return params.map((p) => (Array.isArray(p) ? pgArray(p as number[]) : p));
}

/** `text` with `$n` placeholders → a Drizzle SQL object with bound parameters. */
export function toDrizzleSql(text: string, params: unknown[] = []): SQL {
  const parts = text.split(/\$(\d+)/);
  const chunks: SQL[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) chunks.push(sql.raw(parts[i]));
    } else {
      const n = Number(parts[i]);
      if (!(n >= 1 && n <= params.length)) throw new Error(`fv2: parameter $${n} has no value`);
      chunks.push(sql`${params[n - 1]}`);
    }
  }
  return sql.join(chunks, sql.raw(""));
}

export function sqlOf(handle: PgLike | DrizzleLike): Sql {
  if ("query" in handle && typeof handle.query === "function") {
    const h = handle as PgLike;
    return {
      async rows(text, params = []) {
        return (await h.query(text, normalise(params))).rows;
      },
      async exec(text, params = []) {
        return (await h.query(text, normalise(params))).rowCount ?? 0;
      },
    };
  }
  const d = handle as DrizzleLike;
  return {
    async rows(text, params = []) {
      const r = await d.execute(toDrizzleSql(text, normalise(params)));
      return Array.isArray(r) ? r : (r?.rows ?? []);
    },
    async exec(text, params = []) {
      const r = await d.execute(toDrizzleSql(text, normalise(params)));
      return r?.rowCount ?? 0;
    },
  };
}
