import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject,
  NotFoundException, Param, Patch, Post, Query, UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { and, asc, count, desc, eq, getTableColumns, type SQL } from "drizzle-orm";
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
    const cfg = this.runner.config();
    const [settings, running, last] = await Promise.all([
      this.runner.loadSettings(),
      this.db.select({ id: newsJobRunsTable.id }).from(newsJobRunsTable)
        .where(eq(newsJobRunsTable.status, "running")).orderBy(desc(newsJobRunsTable.startedAt)).limit(1),
      this.db.select(RUN_SUMMARY_COLUMNS).from(newsJobRunsTable).orderBy(desc(newsJobRunsTable.startedAt)).limit(1),
    ]);
    return {
      configured: cfg.configured,
      provider: cfg.provider,
      model: cfg.model,
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
      this.db.select().from(newsSourcesTable).orderBy(asc(newsSourcesTable.handle)),
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

  @Post("sources")
  async createSource(@Body() body: any) {
    const handle = normaliseHandle(body?.handle);
    if (!handle) throw new BadRequestException("handle must be an X username (letters, digits, _; up to 15) or an x.com link");
    const extra = parsed(() => {
      const hasAny = body?.displayName !== undefined || body?.display_name !== undefined || body?.notes !== undefined || body?.enabled !== undefined;
      return hasAny ? parseSourcePatch(body) : {};
    });
    const [row] = await this.db.insert(newsSourcesTable).values({ handle, ...extra })
      .onConflictDoNothing({ target: newsSourcesTable.handle }).returning();
    if (!row) throw new ConflictException(`@${handle} is already in the list`);
    return row;
  }

  /** Try a handle before adding it: POST /admin/news/sources/test { handle }. */
  @Post("sources/test")
  @HttpCode(200)
  async testHandle(@Body() body: any) {
    const handle = normaliseHandle(body?.handle);
    if (!handle) throw new BadRequestException("handle must be an X username (letters, digits, _; up to 15) or an x.com link");
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
    return this.probe(src.handle, src.xUserId);
  }

  private async probe(handle: string, userId: string | null) {
    const cfg = this.runner.config();
    const provider = this.runner.providerOverride ?? buildProvider(cfg);
    if (!provider) {
      throw new BadRequestException(`news source not configured — missing: ${cfg.configured.missing.filter((m) => !m.startsWith("ANTHROPIC")).join(", ")}`);
    }
    try {
      const res = await provider.fetchLatest(handle, { max: 5, userId });
      return { ok: true, handle, provider: provider.name, profile: res.profile, tweets: res.tweets, skipped: res.skipped, error: null };
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError("other", (err as Error)?.message ?? String(err));
      return { ok: false, handle, provider: provider.name, profile: null, tweets: [], skipped: 0, error: { kind: pe.kind, message: pe.message } };
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
