import { BadRequestException } from "@nestjs/common";
import { and, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { newsItemsTable } from "@dara/database";

/**
 * Keyset ("cursor") paging for the reader feed.
 *
 * The feed is ordered `pinned desc, posted_at desc nulls last, id desc`.
 * Offset paging over that order skips and repeats rows: a story published
 * between two fetches keeps its original posted_at and lands mid-list, and a
 * moderator hiding a story already shown shifts every later row up one. A
 * cursor names the last row the reader saw, and the next page is "every row
 * strictly after it in the same order", which neither change can disturb.
 *
 * Wire form: base64url of `[pinned 0|1, postedAt text | null, id]`. Opaque to
 * clients — they only echo `nextCursor` back. `postedAt` is rendered by
 * Postgres (`NEWS_CURSOR_AT`, UTC, microseconds intact), so the boundary row
 * compares equal to itself; a JS Date would round to milliseconds and drop or
 * repeat rows whose posted_at carries microseconds.
 */
export interface NewsCursor {
  pinned: boolean;
  postedAt: string | null;
  id: string;
}

/** posted_at as the cursor carries it: UTC, microsecond precision. */
export const NEWS_CURSOR_AT = sql<string | null>`to_char(${newsItemsTable.postedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeNewsCursor(c: NewsCursor): string {
  return Buffer.from(JSON.stringify([c.pinned ? 1 : 0, c.postedAt, c.id]), "utf8").toString("base64url");
}

/** Undefined when nothing was sent; 400 on anything that is not a cursor we issued. */
export function decodeNewsCursor(raw: unknown): NewsCursor | undefined {
  if (raw == null || raw === "") return undefined;
  const bad = () => new BadRequestException("invalid cursor");
  if (typeof raw !== "string" || raw.length > 200) throw bad();
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (!Array.isArray(v) || v.length !== 3) throw bad();
  const [p, t, id] = v;
  if (p !== 0 && p !== 1) throw bad();
  if (t !== null && (typeof t !== "string" || !AT.test(t) || Number.isNaN(Date.parse(t)))) throw bad();
  if (typeof id !== "string" || !UUID.test(id)) throw bad();
  return { pinned: p === 1, postedAt: t, id };
}

/**
 * Rows strictly after `c` in `posted_at desc nulls last, id desc`, within one
 * pinned group:
 *  - cursor dated:   older, OR undated (nulls sort last), OR same instant and lower id
 *  - cursor undated: undated and lower id (every dated row came before it)
 */
function afterWithinGroup(c: NewsCursor): SQL {
  const t = newsItemsTable;
  if (c.postedAt === null) return and(isNull(t.postedAt), lt(t.id, c.id))!;
  const at = sql`${c.postedAt}::timestamptz`;
  return or(
    sql`${t.postedAt} < ${at}`,
    isNull(t.postedAt),
    and(sql`${t.postedAt} = ${at}`, lt(t.id, c.id)),
  )!;
}

/**
 * The full predicate. `pinned desc` puts every pinned row first, so:
 *  - cursor pinned:   the rest of the pinned group, then EVERY unpinned row
 *  - cursor unpinned: the rest of the unpinned group only
 */
export function newsCursorCondition(c: NewsCursor): SQL {
  const t = newsItemsTable;
  if (c.pinned) return or(eq(t.pinned, false), and(eq(t.pinned, true), afterWithinGroup(c)))!;
  return and(eq(t.pinned, false), afterWithinGroup(c))!;
}
