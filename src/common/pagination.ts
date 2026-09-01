import { z } from "zod/v4";

/**
 * Shared pagination + search query schema for every list endpoint.
 *
 * All list endpoints follow the same wire shape so the React Query hooks on
 * the frontend can share helpers and so the user gets consistent behavior
 * across tabs:
 *
 *   GET /api/<entity>?page=2&pageSize=25&search=alpha&sort=createdAt&order=desc
 *
 * The handler reads `page` + `pageSize` to compute LIMIT/OFFSET and returns
 *
 *   { data: T[]; page: number; pageSize: number; total: number }
 *
 * `search` is optional; controllers ILIKE it against their text columns.
 *
 * Two rules every list endpoint must hold to:
 *
 *  1. **Every filter the UI offers is a query parameter applied in SQL.** A
 *     handler that pulls a page (or a capped 200 rows) and then filters it in
 *     JavaScript is filtering a slice, not the list — the rows past the cap
 *     silently do not exist. That is how a figure computed off a capped query
 *     goes quietly wrong, and how a contract finance panel built its invoice
 *     map from the first 200 rows and offered a duplicate invoice for an
 *     installment that was already invoiced.
 *  2. **`total` is the database's count for the same WHERE**, never
 *     `rows.length` — several summary numbers on the frontend read it.
 */
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Upper bound on a single page. Kept at 200: the frontend's `fetchAllPages`
 * helper walks pages at exactly this size when a screen genuinely needs the
 * whole set, so raising it would only make the worst-case query heavier
 * without removing the need to walk.
 */
export const MAX_PAGE_SIZE = 200;

export const listQuerySchema = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  search:   z.string().trim().optional(),
  sort:     z.string().trim().optional(),
  order:    z.enum(["asc", "desc"]).default("desc"),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export type Paginated<T> = { data: T[]; page: number; pageSize: number; total: number };

/**
 * Does this request want the paginated envelope, or the legacy bare array?
 *
 * Several endpoints are consumed by the mobile app and the Ejar import as well
 * as the portal, and those callers expect a bare `T[]`. Rather than break
 * them, pagination is opt-in: a caller that sends `page`, `pageSize` or
 * `paginated` (or any of the endpoint's own `extraKeys`, e.g. `search`) gets
 * `{ data, page, pageSize, total }`; a caller that sends none of them gets the
 * array it has always got. Filters still apply in SQL either way — an
 * unpaginated caller gets a filtered array, not a filtered slice.
 *
 * `extraKeys` should only ever name parameters the endpoint ALREADY treats as
 * a pagination trigger. A newly added filter must not be added to it: a caller
 * that sends nothing but that new filter would flip from array to envelope.
 */
export function wantsPagination(raw: unknown, extraKeys: readonly string[] = []): boolean {
  if (!raw || typeof raw !== "object") return false;
  const q = raw as Record<string, unknown>;
  if (q.page != null || q.pageSize != null) return true;
  // `paginated=1` — an explicit opt-in for a caller that wants the envelope
  // (and its `total`) without naming a page.
  if (q.paginated != null && q.paginated !== "0" && q.paginated !== "false") return true;
  return extraKeys.some((k) => q[k] != null);
}

/** LIMIT/OFFSET for a parsed list query. */
export function pageBounds(q: Pick<ListQuery, "page" | "pageSize">) {
  return { limit: q.pageSize, offset: (q.page - 1) * q.pageSize };
}

/** `?ids=1,2,3` → `[1, 2, 3]`. Returns undefined when nothing usable was sent. */
export function parseIdList(raw: unknown): number[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const ids = raw.split(",")
    .map((s) => parseInt(s.trim(), 10))
    // Bounded to int4 — an id past 2^31 reaches the driver and comes back a
    // 500 rather than a clean miss.
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 2147483647);
  return ids.length > 0 ? ids : undefined;
}

/**
 * `?status=a,b` → `["a", "b"]`, keeping only values in `allowed`. A single
 * value works too, so `status=active` and `status=active,ended` are one param.
 */
export function parseEnumList<T extends string>(raw: unknown, allowed: readonly T[]): T[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const set = new Set<string>(allowed);
  const vals = raw.split(",").map((s) => s.trim()).filter((s): s is T => set.has(s));
  return vals.length > 0 ? vals : undefined;
}

/** A `YYYY-MM-DD` bound for a date-range filter, or undefined if unusable. */
export function parseDateBound(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}
