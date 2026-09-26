import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject,
  NotFoundException, Param, Patch, Post, Query, UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { and, asc, count, desc, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import { newsItemsTable, newsJobRunsTable, newsJobSettingsTable, newsSourcesTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard, type AuthUser } from "../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../common/guards/roles.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { listQuerySchema } from "../../common/pagination";
import { AppLogService } from "../../common/logging/app-log.service";
import { buildProvider } from "./news.config";
import { normaliseHandle } from "./news.handles";
import { computeNextRunAt, NEWS_TZ } from "./news.schedule";
import { NewsRunnerService } from "./news.runner.service";
import { searchCondition } from "./news.controller";
import { NEWS_CATEGORIES, NEWS_ITEM_STATUSES, ProviderError } from "./news.types";
import { RssProvider } from "./providers/rss.provider";
import { assertPublicHost, checkUrlShape, SafeFetchError } from "./providers/safe-fetch";
import {
  NewsValidationError, parseItemPatch, parseSettingsPatch, parseSourceIds, parseSourcePatch, UUID_RE,
} from "./news.validation";

/** Run a body parser, turning its error into a 400 with the parser's message. */
function parsed<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof NewsValidationError) throw new BadRequestException(err.message);
    throw err;
  }
}

function uuidParam(id: string): string {
  // A malformed uuid reaches Postgres as a cast error → 500. It is a miss.
  if (!UUID_RE.test(id ?? "")) throw new NotFoundException("not found");
  return id;
}

const { log: _omitLog, ...RUN_SUMMARY_COLUMNS } = getTableColumns(newsJobRunsTable);

const BAD_HANDLE = "handle must be an X username (letters, digits, _; up to 15) or an x.com link";

/** `kind` of a create/test body: explicit, else rss when only a feed URL is given. */
function bodyKind(body: any): "x" | "rss" {
  const k = typeof body?.kind === "string" ? body.kind.trim().toLowerCase() : "";
  if (k === "rss" || k === "x") return k;
  if (k) throw new BadRequestException("kind must be 'x' or 'rss'");
  const hasFeed = body?.feedUrl !== undefined || body?.feed_url !== undefined;
  return hasFeed && body?.handle === undefined ? "rss" : "x";
}

/**
 * A feed URL an admin typed → a normalised URL that is safe to fetch: http(s),
 * standard port, no credentials, and a host that resolves only to public
 * addresses (the fetch re-checks at connect time and on every redirect).
 */
export async function parseFeedUrl(body: any, resolve?: (h: string) => Promise<Array<{ address: string; family: number }>>): Promise<string> {
  const raw = body?.feedUrl ?? body?.feed_url;
  if (typeof raw !== "string" || !raw.trim()) throw new BadRequestException("feedUrl is required for an RSS source");
  if (raw.length > 2000) throw new BadRequestException("feedUrl is too long");
  try {
    const u = checkUrlShape(raw);
    u.hash = "";
    await assertPublicHost(u.hostname, resolve);
    return u.toString();
  } catch (err) {
    if (err instanceof SafeFetchError) throw new BadRequestException(`feedUrl rejected: ${err.message}`);
    throw err;
  }
}

/** What an X test says while no X key is set (the account itself is fine). */
export const X_NO_KEY_MESSAGE =
  "X key not set — the account is saved and will be fetched once X_BEARER_TOKEN or TWITTERAPI_IO_KEY is added";

/**
 * Super-admin console for the news job — same guard pair as the admin module.
 */
@ApiTags("admin-news")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller("admin/news")
export class NewsAdminController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly runner: NewsRunnerService,
    private readonly appLog: AppLogService,
  ) {}

  // ── status ────────────────────────────────────────────────────────────

  @Get("status")
  async status() {
    const counts = await this.runner.sourceCounts();
    const cfg = await this.runner.readiness();
    const [settings, running, last] = await Promise.all([
      this.runner.loadSettings(),
      this.db.select({ id: newsJobRunsTable.id }).from(newsJobRunsTable)
        .where(eq(newsJobRunsTable.status, "running")).orderBy(desc(newsJobRunsTable.startedAt)).limit(1),
      this.db.select(RUN_SUMMARY_COLUMNS).from(newsJobRunsTable).orderBy(desc(newsJobRunsTable.startedAt)).limit(1),
    ]);
    return {
      configured: cfg.configured,
      provider: cfg.provider,
      /** The filter a run uses now; `filterSetting` is NEWS_FILTER as read. */
      filter: cfg.filter,
      filterSetting: cfg.filterSetting,
      sources: {
        x: { configured: cfg.xConfigured, count: counts.x.count, enabled: counts.x.enabled },
        rss: { count: counts.rss.count, enabled: counts.rss.enabled },
      },
      warnings: cfg.warnings,
      model: cfg.filter === "ai" ? cfg.model : null,
      timezone: NEWS_TZ,
      runningRunId: running[0]?.id ?? null,
      settings,
      nextRunAt: settings?.enabled ? settings.nextRunAt : null,
      lastRun: last[0] ?? null,
    };
  }

  // ── settings ──────────────────────────────────────────────────────────

  @Get("settings")
  settings() {
    return this.runner.loadSettings();
  }

  @Patch("settings")
  async updateSettings(@Body() body: any, @CurrentUser() user: AuthUser) {
    const patch = parsed(() => parseSettingsPatch(body));
    const current = await this.runner.loadSettings();
    const merged = { ...current, ...patch };
    const nextRunAt = computeNextRunAt(new Date(), merged.runTime, merged.daysOfWeek, NEWS_TZ);
    const [row] = await this.db.update(newsJobSettingsTable)
      .set({ ...patch, nextRunAt, updatedAt: new Date(), updatedBy: user?.id ?? null })
      .where(eq(newsJobSettingsTable.id, 1))
      .returning();
    this.appLog.record({ level: "log", event: "news_settings_updated", context: "News", meta: patch });
    return row;
  }

  // ── sources ───────────────────────────────────────────────────────────

  @Get("sources")
  async sources() {
    const [rows, counts] = await Promise.all([
      this.db.select().from(newsSourcesTable).orderBy(
        asc(newsSourcesTable.kind),
        asc(sql`lower(coalesce(${newsSourcesTable.handle}, ${newsSourcesTable.displayName}, ${newsSourcesTable.feedUrl}))`),
      ),
      this.db.select({ sourceId: newsItemsTable.sourceId, status: newsItemsTable.status, n: count() })
        .from(newsItemsTable).groupBy(newsItemsTable.sourceId, newsItemsTable.status),
    ]);
    const stats = new Map<string, { published: number; total: number }>();
    for (const c of counts) {
      if (!c.sourceId) continue;
      const s = stats.get(c.sourceId) ?? { published: 0, total: 0 };
      s.total += Number(c.n);
      if (c.status === "published") s.published += Number(c.n);
      stats.set(c.sourceId, s);
    }
    return rows.map((r) => ({ ...r, itemCounts: stats.get(r.id) ?? { published: 0, total: 0 } }));
  }

  /**
   * POST /admin/news/sources — `{ handle, displayName?, notes?, enabled? }` for X,
   * `{ kind: 'rss', feedUrl, displayName?, notes?, enabled? }` for a feed.
   */
  @Post("sources")
  async createSource(@Body() body: any) {
    const extra = parsed(() => {
      const hasAny = body?.displayName !== undefined || body?.display_name !== undefined || body?.notes !== undefined || body?.enabled !== undefined;
      return hasAny ? parseSourcePatch(body) : {};
    });
    if (bodyKind(body) === "rss") {
      const feedUrl = await parseFeedUrl(body);
      const [row] = await this.db.insert(newsSourcesTable).values({ kind: "rss", feedUrl, ...extra })
        .onConflictDoNothing({ target: newsSourcesTable.feedUrl, where: sql`${newsSourcesTable.kind} = 'rss'` }).returning();
      if (!row) throw new ConflictException("that feed is already in the list");
      return row;
    }
    const handle = normaliseHandle(body?.handle);
    if (!handle) throw new BadRequestException(BAD_HANDLE);
    const [row] = await this.db.insert(newsSourcesTable).values({ kind: "x", handle, ...extra })
      .onConflictDoNothing({ target: newsSourcesTable.handle }).returning();
    if (!row) throw new ConflictException(`@${handle} is already in the list`);
    return row;
  }

  /**
   * Try a source before adding it: POST /admin/news/sources/test
   * `{ handle }` (X) or `{ kind: 'rss', feedUrl }` (feed: fetch + parse, first 5 items).
   */
  @Post("sources/test")
  @HttpCode(200)
  async testHandle(@Body() body: any) {
    if (bodyKind(body) === "rss") return this.probeFeed(await parseFeedUrl(body), null);
    const handle = normaliseHandle(body?.handle);
    if (!handle) throw new BadRequestException(BAD_HANDLE);
    return this.probe(handle, null);
  }

  @Patch("sources/:id")
  async updateSource(@Param("id") id: string, @Body() body: any) {
    const patch = parsed(() => parseSourcePatch(body));
    const [row] = await this.db.update(newsSourcesTable).set(patch)
      .where(eq(newsSourcesTable.id, uuidParam(id))).returning();
    if (!row) throw new NotFoundException("account not found");
    return row;
  }

  @Delete("sources/:id")
  async deleteSource(@Param("id") id: string) {
    const [row] = await this.db.delete(newsSourcesTable).where(eq(newsSourcesTable.id, uuidParam(id)))
      .returning({ id: newsSourcesTable.id });
    if (!row) throw new NotFoundException("account not found");
    return { ok: true, id: row.id };
  }

  /** Fetch a few latest posts for an existing account — no AI, nothing saved. */
  @Post("sources/:id/test")
  @HttpCode(200)
  async testSource(@Param("id") id: string) {
    const [src] = await this.db.select().from(newsSourcesTable).where(eq(newsSourcesTable.id, uuidParam(id)));
    if (!src) throw new NotFoundException("account not found");
    if (src.kind === "rss") return this.probeFeed(src.feedUrl!, src.displayName);
    return this.probe(src.handle!, src.xUserId);
  }

  /**
   * Fetch + parse a feed, no conditional GET, nothing saved. 200 either way:
   * a feed that fails is `ok: false` with the reason (same as the X test).
   */
  private async probeFeed(feedUrl: string, displayName: string | null) {
    const rss = this.runner.rssOverride ?? new RssProvider();
    const base = { kind: "rss" as const, handle: null, feedUrl, provider: "rss" as const };
    try {
      const res = await rss.fetchFeed(feedUrl, { max: 5, displayName });
      return {
        ...base, ok: true, title: res.title, siteUrl: res.siteUrl,
        profile: { userId: null, name: res.title, avatarUrl: null },
        tweets: res.items, skipped: res.skipped, error: null,
      };
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError("other", (err as Error)?.message ?? String(err));
      return { ...base, ok: false, title: null, siteUrl: null, profile: null, tweets: [], skipped: 0, error: { kind: pe.kind, message: pe.message } };
    }
  }

  private async probe(handle: string, userId: string | null) {
    const cfg = this.runner.config();
    const provider = this.runner.providerOverride ?? buildProvider(cfg);
    // No X key is not a problem with the account: it is saved (or can be) and
    // will be fetched once a key is added. 200 with a neutral `no_key`, never a 400.
    if (!provider) {
      return {
        kind: "x", ok: false, handle, provider: null, profile: null, tweets: [], skipped: 0,
        error: { kind: "no_key", message: X_NO_KEY_MESSAGE },
      };
    }
    try {
      const res = await provider.fetchLatest(handle, { max: 5, userId });
      return { kind: "x", ok: true, handle, provider: provider.name, profile: res.profile, tweets: res.tweets, skipped: res.skipped, error: null };
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError("other", (err as Error)?.message ?? String(err));
      return { kind: "x", ok: false, handle, provider: provider.name, profile: null, tweets: [], skipped: 0, error: { kind: pe.kind, message: pe.message } };
    }
  }

  // ── runs ──────────────────────────────────────────────────────────────

  /** 202 `{ runId }`; 409 while a run is in progress; 400 when not configured. */
  @Post("run")
  @HttpCode(202)
  async run(@Body() body: any, @CurrentUser() user: AuthUser) {
    const sourceIds = parsed(() => parseSourceIds(body));
    const res = await this.runner.startRun("manual", user?.id ?? null, sourceIds);
    if (res.kind === "busy") throw new ConflictException("a news run is already in progress");
    if (res.kind === "not_configured") throw new BadRequestException(`news is not configured — missing: ${res.missing.join(", ")}`);
    return { runId: res.runId };
  }

  /** Newest first, without the log. `?limit=` 1–100, default 20. */
  @Get("runs")
  runs(@Query("limit") limitRaw?: string) {
    const n = Number(limitRaw ?? 20);
    const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, 100) : 20;
    return this.db.select(RUN_SUMMARY_COLUMNS).from(newsJobRunsTable).orderBy(desc(newsJobRunsTable.startedAt)).limit(limit);
  }

  @Get("runs/:id")
  async runDetail(@Param("id") id: string) {
    const [row] = await this.db.select().from(newsJobRunsTable).where(eq(newsJobRunsTable.id, uuidParam(id)));
    if (!row) throw new NotFoundException("run not found");
    return row;
  }

  // ── items ─────────────────────────────────────────────────────────────

  /**
   * GET /admin/news/items?status=&category=&sourceId=&q=&page=&pageSize=
   * All statuses, every column. Newest first (pinned not floated — this is a
   * moderation queue, not the feed).
   */
  @Get("items")
  async items(@Query() raw: any) {
    const p = listQuerySchema.safeParse(raw ?? {});
    if (!p.success) throw new BadRequestException("invalid page or pageSize");
    const query = p.data;
    const conds: SQL[] = [];
    const status = typeof raw?.status === "string" ? raw.status.trim() : "";
    if (status) {
      if (!(NEWS_ITEM_STATUSES as readonly string[]).includes(status)) throw new BadRequestException("unknown status");
      conds.push(eq(newsItemsTable.status, status));
    }
    const category = typeof raw?.category === "string" ? raw.category.trim() : "";
    if (category) {
      if (!(NEWS_CATEGORIES as readonly string[]).includes(category)) throw new BadRequestException("unknown category");
      conds.push(eq(newsItemsTable.aiCategory, category));
    }
    const sourceId = String(raw?.sourceId ?? raw?.source_id ?? "").trim();
    if (sourceId) {
      if (!UUID_RE.test(sourceId)) throw new BadRequestException("invalid sourceId");
      conds.push(eq(newsItemsTable.sourceId, sourceId));
    }
    const runId = String(raw?.runId ?? raw?.run_id ?? "").trim();
    if (runId) {
      if (!UUID_RE.test(runId)) throw new BadRequestException("invalid runId");
      conds.push(eq(newsItemsTable.runId, runId));
    }
    const q = (typeof raw?.q === "string" ? raw.q : query.search ?? "").trim().slice(0, 100);
    if (q) conds.push(searchCondition(q)!);
    const where = conds.length ? and(...conds) : undefined;

    const [rows, total] = await Promise.all([
      this.db.select().from(newsItemsTable).where(where)
        .orderBy(desc(newsItemsTable.postedAt), desc(newsItemsTable.id))
        .limit(query.pageSize).offset((query.page - 1) * query.pageSize),
      this.db.select({ n: count() }).from(newsItemsTable).where(where),
    ]);
    return { data: rows, page: query.page, pageSize: query.pageSize, total: Number(total[0]?.n ?? 0) };
  }

  @Patch("items/:id")
  async updateItem(@Param("id") id: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    const patch = parsed(() => parseItemPatch(body));
    const [row] = await this.db.update(newsItemsTable).set(patch)
      .where(eq(newsItemsTable.id, uuidParam(id))).returning();
    if (!row) throw new NotFoundException("item not found");
    this.appLog.record({ level: "log", event: "news_item_moderated", context: "News", userId: user?.id ?? null, meta: { id, ...patch } });
    return row;
  }
}
