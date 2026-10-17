import { BadRequestException, Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { and, count, desc, eq, ilike, inArray, max, or, sql, type SQL } from "drizzle-orm";
import { newsItemsTable, newsJobRunsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { DEFAULT_PAGE_SIZE, listQuerySchema, type ListQuery } from "../../common/pagination";
import { z } from "zod/v4";
import { NEWS_CATEGORIES } from "./news.types";
import { readNewsConfig } from "./news.config";
import { NEWS_CURSOR_AT, decodeNewsCursor, encodeNewsCursor, newsCursorCondition } from "./news.cursor";

/** What a reader sees of an item — no AI score/reason, no moderation fields. */
export const PUBLIC_ITEM_COLUMNS = {
  id: newsItemsTable.id,
  url: newsItemsTable.url,
  authorHandle: newsItemsTable.authorHandle,
  authorName: newsItemsTable.authorName,
  authorAvatarUrl: newsItemsTable.authorAvatarUrl,
  text: newsItemsTable.text,
  lang: newsItemsTable.lang,
  postedAt: newsItemsTable.postedAt,
  media: newsItemsTable.media,
  metrics: newsItemsTable.metrics,
  category: newsItemsTable.aiCategory,
  titleAr: newsItemsTable.aiTitleAr,
  titleEn: newsItemsTable.aiTitleEn,
  summaryAr: newsItemsTable.aiSummaryAr,
  summaryEn: newsItemsTable.aiSummaryEn,
  tags: newsItemsTable.aiTags,
  pinned: newsItemsTable.pinned,
};

/** Largest page any news list returns (a bigger `pageSize` is clamped to it). */
export const NEWS_MAX_PAGE_SIZE = 100;

/**
 * `page` / `pageSize` for every news list: the shared schema (400 on junk),
 * with pageSize clamped to NEWS_MAX_PAGE_SIZE. The response's `pageSize` is the
 * one applied, so a client can trust it for "showing X–Y of Z".
 */
/** The shared schema caps pageSize at 200 with a 400; news clamps any size instead. */
const newsListSchema = listQuerySchema.extend({
  pageSize: z.coerce.number().int().min(1).default(DEFAULT_PAGE_SIZE),
});

export function newsListQuery(raw: unknown): ListQuery {
  const p = newsListSchema.safeParse(raw ?? {});
  if (!p.success) throw new BadRequestException("invalid page or pageSize");
  return { ...p.data, pageSize: Math.min(p.data.pageSize, NEWS_MAX_PAGE_SIZE) };
}

export function searchCondition(q: string): SQL | undefined {
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return or(
    ilike(newsItemsTable.aiTitleAr, like),
    ilike(newsItemsTable.aiTitleEn, like),
    ilike(newsItemsTable.aiSummaryAr, like),
    ilike(newsItemsTable.aiSummaryEn, like),
    ilike(newsItemsTable.text, like),
    ilike(newsItemsTable.authorHandle, like),
  );
}

/**
 * The landlord-facing feed. Any signed-in account (BUSINESS.md §1): public
 * news, no customer data, so no permission key.
 */
@ApiTags("news")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("news")
export class NewsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /**
   * GET /news?category=&q=&page=&pageSize=&cursor=
   * → `{ data, page, pageSize, total, nextCursor }`, published only, pinned
   * first then newest.
   *
   * Two ways to walk it. The portal's infinite feed sends `cursor` (the
   * previous response's `nextCursor`; omit it for the first page) and gets
   * keyset paging that cannot skip or repeat a row when a story is published
   * or hidden mid-scroll — see news.cursor.ts. `page` is ignored then.
   * Offset callers (`page`) keep working unchanged; they get `nextCursor` too.
   * `nextCursor` is null on the last page. `total` is the count for the same
   * filters, regardless of the cursor.
   */
  @Get()
  async list(@Query() raw: any) {
    const query = newsListQuery(raw);
    const cursor = decodeNewsCursor(raw?.cursor);
    const conds: SQL[] = [eq(newsItemsTable.status, "published")];
    const category = typeof raw?.category === "string" ? raw.category.trim() : "";
    if (category) {
      if (!(NEWS_CATEGORIES as readonly string[]).includes(category)) throw new BadRequestException("unknown category");
      conds.push(eq(newsItemsTable.aiCategory, category));
    }
    const q = (typeof raw?.q === "string" ? raw.q : query.search ?? "").trim().slice(0, 100);
    if (q) conds.push(searchCondition(q)!);
    const where = and(...conds);
    const pageWhere = cursor ? and(where, newsCursorCondition(cursor)) : where;

    const [found, total] = await Promise.all([
      this.db.select({ ...PUBLIC_ITEM_COLUMNS, cursorAt: NEWS_CURSOR_AT }).from(newsItemsTable).where(pageWhere)
        // Stable: pinned, newest (undated last), then id — pages never repeat or skip.
        .orderBy(desc(newsItemsTable.pinned), sql`${newsItemsTable.postedAt} desc nulls last`, desc(newsItemsTable.id))
        // One extra row says whether another page exists without a second count.
        .limit(query.pageSize + 1).offset(cursor ? 0 : (query.page - 1) * query.pageSize),
      this.db.select({ n: count() }).from(newsItemsTable).where(where),
    ]);
    const more = found.length > query.pageSize;
    const page = more ? found.slice(0, query.pageSize) : found;
    const last = page[page.length - 1];
    const nextCursor = more && last ? encodeNewsCursor({ pinned: !!last.pinned, postedAt: last.cursorAt ?? null, id: last.id }) : null;
    const data = page.map(({ cursorAt: _c, ...row }) => row);
    return { data, page: query.page, pageSize: query.pageSize, total: Number(total[0]?.n ?? 0), nextCursor };
  }

  /**
   * GET /news/summary → `{ total, categories: [{ key, count }], lastUpdatedAt, filter }`.
   * Every category is listed (zero counts included) in the fixed order.
   * `lastUpdatedAt` is the end of the last run that fetched anything.
   * `filter` ('keyword' | 'ai') is the filter runs use now, so the portal's
   * disclosure can say whether an AI wrote the titles or they are the
   * publishers' own headlines picked by keyword.
   */
  @Get("summary")
  async summary() {
    const [counts, lastRun] = await Promise.all([
      this.db.select({ key: newsItemsTable.aiCategory, n: count() }).from(newsItemsTable)
        .where(eq(newsItemsTable.status, "published")).groupBy(newsItemsTable.aiCategory),
      this.db.select({ at: max(newsJobRunsTable.finishedAt) }).from(newsJobRunsTable)
        .where(inArray(newsJobRunsTable.status, ["success", "partial"])),
    ]);
    const byKey = new Map(counts.map((c) => [c.key ?? "other", Number(c.n)]));
    const categories = NEWS_CATEGORIES.map((key) => ({ key, count: byKey.get(key) ?? 0 }));
    return {
      total: categories.reduce((s, c) => s + c.count, 0),
      categories,
      lastUpdatedAt: lastRun[0]?.at ?? null,
      filter: readNewsConfig().filter,
    };
  }
}
