import { BadRequestException, Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { and, count, desc, eq, ilike, inArray, max, or, sql, type SQL } from "drizzle-orm";
import { newsItemsTable, newsJobRunsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { listQuerySchema, type ListQuery } from "../../common/pagination";
import { NEWS_CATEGORIES } from "./news.types";
import { readNewsConfig } from "./news.config";

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
export function newsListQuery(raw: unknown): ListQuery {
  const p = listQuerySchema.safeParse(raw ?? {});
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
   * GET /news?category=&q=&page=&pageSize=
   * → `{ data, page, pageSize, total }`, published only, pinned first then newest.
   */
  @Get()
  async list(@Query() raw: any) {
    const query = newsListQuery(raw);
    const conds: SQL[] = [eq(newsItemsTable.status, "published")];
    const category = typeof raw?.category === "string" ? raw.category.trim() : "";
    if (category) {
      if (!(NEWS_CATEGORIES as readonly string[]).includes(category)) throw new BadRequestException("unknown category");
      conds.push(eq(newsItemsTable.aiCategory, category));
    }
    const q = (typeof raw?.q === "string" ? raw.q : query.search ?? "").trim().slice(0, 100);
    if (q) conds.push(searchCondition(q)!);
    const where = and(...conds);

    const [rows, total] = await Promise.all([
      this.db.select(PUBLIC_ITEM_COLUMNS).from(newsItemsTable).where(where)
        // Stable: pinned, newest (undated last), then id — pages never repeat or skip.
        .orderBy(desc(newsItemsTable.pinned), sql`${newsItemsTable.postedAt} desc nulls last`, desc(newsItemsTable.id))
        .limit(query.pageSize).offset((query.page - 1) * query.pageSize),
      this.db.select({ n: count() }).from(newsItemsTable).where(where),
    ]);
    return { data: rows, page: query.page, pageSize: query.pageSize, total: Number(total[0]?.n ?? 0) };
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
