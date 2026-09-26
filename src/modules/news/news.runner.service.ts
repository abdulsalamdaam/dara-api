import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, count, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  newsItemsTable, newsJobRunsTable, newsJobSettingsTable, newsSourcesTable,
  type NewsJobSettings, type NewsRunLogEntry, type NewsSource,
} from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { AppLogService } from "../../common/logging/app-log.service";
import { buildProvider, readNewsConfig, type FilterKind, type NewsConfig } from "./news.config";
import { compareTweetIds, ProviderError, type FetchResult, type NormalisedTweet, type SourceProvider } from "./news.types";
import { ApifyProvider } from "./providers/apify.provider";
import { dedupeTweets } from "./news.dedupe";
import { decideStatus, NewsAiFilter } from "./news.ai";
import { AI_MAX_ATTEMPTS, capQueue, processAiQueue } from "./news.batches";
import { detectManipulation, heldReason } from "./news.guard";
import { tryAcquireNewsLock, type NewsRunLock } from "./news.lock";
import { KeywordFilter } from "./news.keyword-filter";
import { RssProvider, type RssFetchResult } from "./providers/rss.provider";

/** How far back the "same story" comparison and the AI's recent-titles list look. */
const RECENT_WINDOW_MS = 72 * 3_600_000;
/**
 * Items the AI never judged are retried by later runs for this long, and only
 * while they have fewer than AI_MAX_ATTEMPTS failed reviews.
 */
const RETRY_WINDOW_MS = 7 * 24 * 3_600_000;
const RETRY_MAX = 60;
const LOG_CAP = 500;

export type StartRunResult =
  | { kind: "started"; runId: string }
  | { kind: "busy" }
  | { kind: "not_configured"; missing: string[] };

type Counters = {
  accountsTotal: number; accountsOk: number; fetched: number; newItems: number;
  published: number; rejected: number; duplicates: number;
};

/**
 * One news run: fetch every source (X accounts, RSS feeds) → drop duplicates →
 * store → filter (Claude, or the free keyword filter) → status.
 *
 * Stored BEFORE the AI sees anything, as `hidden` with `ai_relevant = null`.
 * That ordering is what makes an AI failure (or a crash mid-run) lose nothing:
 * the post is in the table, invisible to landlords, and the next run picks up
 * every unjudged item from the last week and tries again. Nothing is ever
 * published without a verdict.
 */
@Injectable()
export class NewsRunnerService {
  private readonly logger = new Logger("NewsRunner");
  /** Test seam: a provider / AI to use instead of the env-built ones. */
  providerOverride: SourceProvider | null = null;
  aiOverride: Pick<NewsAiFilter, "classify"> | null = null;
  rssOverride: Pick<RssProvider, "fetchFeed"> | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly appLog: AppLogService,
  ) {}

  /** Env-only view (does not know about RSS rows) — prefer `readiness()`. */
  config(): NewsConfig {
    return readNewsConfig();
  }

  /** Enabled/total source rows per kind. */
  async sourceCounts(): Promise<{ x: { count: number; enabled: number }; rss: { count: number; enabled: number } }> {
    const rows = await this.db.select({ kind: newsSourcesTable.kind, enabled: newsSourcesTable.enabled, n: count() })
      .from(newsSourcesTable).groupBy(newsSourcesTable.kind, newsSourcesTable.enabled);
    const out = { x: { count: 0, enabled: 0 }, rss: { count: 0, enabled: 0 } };
    for (const r of rows) {
      const k = r.kind === "rss" ? out.rss : out.x;
      k.count += Number(r.n);
      if (r.enabled) k.enabled += Number(r.n);
    }
    return out;
  }

  /** The config a run would use now: env + whether any RSS source is enabled. */
  async readiness(): Promise<NewsConfig> {
    const counts = await this.sourceCounts();
    return readNewsConfig(process.env, { rssEnabled: counts.rss.enabled });
  }

  /**
   * Take the lock, write the `running` row, return — the run itself continues
   * in the background. `busy` when another run holds the lock.
   */
  async startRun(trigger: "schedule" | "manual", userId: number | null, sourceIds?: string[]): Promise<StartRunResult> {
    const cfg = await this.readiness();
    const testSeams = !!((this.providerOverride || this.rssOverride) && this.aiOverride);
    if (!testSeams && (!cfg.configured.source || !cfg.configured.ai)) {
      return { kind: "not_configured", missing: cfg.configured.missing };
    }
    const lock = await tryAcquireNewsLock();
    if (!lock) return { kind: "busy" };
    let runId: string;
    try {
      const [row] = await this.db
        .insert(newsJobRunsTable)
        .values({ trigger, triggeredBy: userId, status: "running" })
        .returning({ id: newsJobRunsTable.id });
      runId = row.id;
    } catch (err) {
      await lock.release();
      throw err;
    }
    this.appLog.record({ level: "log", event: "news_run_started", context: "News", userId, meta: { runId, trigger } });
    void this.execute(runId, cfg, lock, sourceIds);
    return { kind: "started", runId };
  }

  /** A scheduled slot that could not run: recorded, not failed. */
  async recordSkipped(trigger: "schedule" | "manual", reason: string): Promise<void> {
    await this.db.insert(newsJobRunsTable).values({
      trigger, status: "skipped", finishedAt: new Date(), error: reason,
      log: [{ at: new Date().toISOString(), level: "warn", message: reason }],
    });
  }

  private async execute(runId: string, cfg: NewsConfig, lock: NewsRunLock, sourceIds?: string[]): Promise<void> {
    const log: NewsRunLogEntry[] = [];
    const c: Counters = { accountsTotal: 0, accountsOk: 0, fetched: 0, newItems: 0, published: 0, rejected: 0, duplicates: 0 };
    let partial = false;
    const push = (level: NewsRunLogEntry["level"], message: string, handle?: string) => {
      if (log.length < LOG_CAP) log.push({ at: new Date().toISOString(), level, message, ...(handle ? { handle } : {}) });
      else if (log.length === LOG_CAP) log.push({ at: new Date().toISOString(), level: "warn", message: "log truncated" });
    };
    const flush = () =>
      this.db.update(newsJobRunsTable).set({ ...c, log: [...log] }).where(eq(newsJobRunsTable.id, runId)).catch(() => undefined);

    try {
      const settings = await this.loadSettings();
      const provider = this.providerOverride ?? buildProvider(cfg);
      const rss = this.rssOverride ?? new RssProvider();
      // The filter: Claude when configured (NEWS_FILTER / ANTHROPIC_API_KEY), else the free keyword filter.
      const filterKind: FilterKind = this.aiOverride ? (this.aiOverride instanceof KeywordFilter ? "keyword" : "ai") : cfg.filter;
      const ai = this.aiOverride
        ?? (cfg.filter === "ai" ? new NewsAiFilter(process.env.ANTHROPIC_API_KEY!.trim(), cfg.model) : new KeywordFilter());
      push("info", `x=${provider?.name ?? "off (no key)"} filter=${filterKind === "ai" ? `claude (${cfg.model})` : "keyword"} lookback=${settings.lookbackHours}h max/source=${settings.maxPerAccount} min_score=${settings.minScore}`);
      for (const w of cfg.warnings) push("warn", w);

      // ── 1. sources ─────────────────────────────────────────────────────
      const all = sourceIds?.length
        ? await this.db.select().from(newsSourcesTable).where(inArray(newsSourcesTable.id, sourceIds))
        : await this.db.select().from(newsSourcesTable).where(eq(newsSourcesTable.enabled, true));
      // X rows need a key. Without one they are skipped — logged, not an error —
      // and the run carries on with RSS.
      const xRows = all.filter((s) => s.kind !== "rss");
      // Apify: the month's budget is checked before any X spend. Over it, X is
      // skipped like "no key" (a warning, not a failure) and RSS carries the run.
      let xOn = !!provider;
      let maxChargeUsd: number | null = null;
      if (provider instanceof ApifyProvider && xRows.length) {
        const b = await provider.budget();
        if (b.overBudget) {
          xOn = false;
          push("warn", `${xRows.length} X account(s) skipped — Apify budget reached: $${b.usage!.spentUsd.toFixed(2)} of $${b.effectiveBudgetUsd.toFixed(2)} this cycle (NEWS_APIFY_MONTHLY_BUDGET_USD)${b.usage?.cycleEndAt ? `, resets ${b.usage.cycleEndAt.slice(0, 10)}` : ""}`);
          this.logger.warn(`news run ${runId}: Apify budget reached ($${b.usage!.spentUsd.toFixed(4)} of $${b.effectiveBudgetUsd}) — X skipped`);
        } else if (b.error) {
          push("warn", `could not read Apify usage (${b.error}) — fetching anyway; Apify's own monthly cap still applies`);
        } else {
          maxChargeUsd = b.remainingUsd;
          push("info", `Apify: $${b.usage!.spentUsd.toFixed(4)} of $${b.effectiveBudgetUsd.toFixed(2)} spent this cycle`);
        }
      }
      const sources = xOn ? all : all.filter((s) => s.kind === "rss");
      if (!provider && xRows.length) push("info", `${xRows.length} X account(s) skipped — no X key set (X_BEARER_TOKEN / TWITTERAPI_IO_KEY / APIFY_TOKEN)`);
      c.accountsTotal = sources.length;
      if (!all.length) push("warn", sourceIds?.length ? "none of the requested sources exist" : "no enabled sources");

      // ── 2. fetch, one account at a time ────────────────────────────────
      const since = new Date(Date.now() - settings.lookbackHours * 3_600_000);
      const fetched: Array<NormalisedTweet & { sourceId: string }> = [];
      let stopReason: string | null = null;

      // A batch provider (Apify) fetches every X account in ONE call, up front;
      // the loop below then does the per-source bookkeeping from its results.
      let batch: Map<string, FetchResult | { error: ProviderError }> | null = null;
      const xToFetch = sources.filter((s) => s.kind !== "rss" && s.handle);
      if (xOn && provider?.fetchMany && xToFetch.length) {
        try {
          const res = await provider.fetchMany(
            xToFetch.map((s) => ({ handle: s.handle!, since, sinceId: s.lastSeenTweetId, userId: s.xUserId, lastFetchedAt: s.lastFetchedAt })),
            { maxPerTarget: settings.maxPerAccount, maxChargeUsd },
          );
          batch = res.results;
          const r = res.run;
          if (r) push("info", `${provider.name} run ${r.runId} ${r.status.toLowerCase()}: ${r.items} row(s) for ${xToFetch.length} account(s)${r.costUsd != null ? `, cost $${r.costUsd.toFixed(4)}` : ""}${r.chargedItems != null ? ` (${r.chargedItems} charged)` : ""}`);
          if (res.unmatched) push("warn", `${res.unmatched} post(s) matched no account (renamed handle?) — dropped`);
        } catch (err) {
          const pe = err instanceof ProviderError ? err : new ProviderError("other", (err as Error)?.message ?? String(err));
          batch = new Map(xToFetch.map((s) => [s.handle!.toLowerCase(), { error: pe }]));
        }
        await flush();
      }

      for (const src of sources) {
        const label = sourceLabel(src);
        if (src.kind === "rss") {
          try {
            const res = await rss.fetchFeed(src.feedUrl!, {
              etag: src.httpEtag, lastModified: src.httpLastModified, since, max: settings.maxPerAccount, displayName: src.displayName,
            });
            c.accountsOk++;
            c.fetched += res.items.length;
            fetched.push(...res.items.map((t) => ({ ...t, sourceId: src.id })));
            await this.afterRssFetch(src, res);
            push("info", res.notModified ? "not modified since last run (304)"
              : `fetched ${res.items.length} item(s)${res.skipped ? `, ${res.skipped} older or over the cap` : ""}`, label);
          } catch (err) {
            partial = true;
            const pe = err instanceof ProviderError ? err : new ProviderError("other", (err as Error)?.message ?? String(err));
            push("error", `${pe.kind}: ${pe.message}`, label);
            await this.db.update(newsSourcesTable).set({ lastError: `${pe.kind}: ${pe.message}`.slice(0, 500) })
              .where(eq(newsSourcesTable.id, src.id)).catch(() => undefined);
            // One feed failing says nothing about the others: never stops the run.
          }
          await flush();
          continue;
        }
        if (!provider || !xOn) continue;
        if (stopReason) {
          push("warn", `skipped: ${stopReason}`, label);
          continue;
        }
        try {
          const hit = batch?.get(src.handle!.toLowerCase());
          if (batch && hit && "error" in hit) throw hit.error;
          const res = batch
            ? (hit as FetchResult | undefined) ?? { profile: { userId: src.xUserId, name: null, avatarUrl: null }, tweets: [], skipped: 0 }
            : await provider.fetchLatest(src.handle!, {
              sinceId: src.lastSeenTweetId, since, max: settings.maxPerAccount, userId: src.xUserId,
            });
          c.accountsOk++;
          c.fetched += res.tweets.length;
          fetched.push(...res.tweets.map((t) => ({ ...t, sourceId: src.id })));
          await this.afterFetch(src, res.profile, res.tweets, push);
          push("info", `fetched ${res.tweets.length} post(s)${res.skipped ? `, skipped ${res.skipped} retweet/reply` : ""}`, label);
        } catch (err) {
          partial = true;
          const pe = err instanceof ProviderError ? err : new ProviderError("other", (err as Error)?.message ?? String(err));
          push("error", `${pe.kind}: ${pe.message}`, label);
          await this.db.update(newsSourcesTable).set({ lastError: `${pe.kind}: ${pe.message}`.slice(0, 500) })
            .where(eq(newsSourcesTable.id, src.id)).catch(() => undefined);
          // A rate limit or an exhausted plan will fail every remaining account
          // the same way; stop spending calls. Their last_seen id is untouched,
          // so the next run's lookback covers them.
          if (pe.kind === "rate_limit" || pe.kind === "quota" || pe.kind === "auth") {
            stopReason = pe.kind === "rate_limit"
              ? `provider rate limit${pe.retryAfterSec ? ` (retry after ${pe.retryAfterSec}s)` : ""}`
              : pe.kind === "quota" ? "provider quota exhausted" : "provider rejected the credentials";
          }
        }
        await flush();
      }

      // ── 3. dedupe ──────────────────────────────────────────────────────
      const ids = [...new Set(fetched.map((t) => t.id))];
      const existing = ids.length
        ? await this.db.select({ id: newsItemsTable.externalId }).from(newsItemsTable).where(inArray(newsItemsTable.externalId, ids))
        : [];
      const recentRows = await this.db
        .select({
          externalId: newsItemsTable.externalId, text: newsItemsTable.text, status: newsItemsTable.status,
          title: newsItemsTable.aiTitleEn, titleAr: newsItemsTable.aiTitleAr,
        })
        .from(newsItemsTable)
        // Story clustering compares against what is on the feed AND what is held
        // (hidden: near-duplicates, unjudged) — not against rejected items.
        .where(and(
          inArray(newsItemsTable.status, ["published", "hidden"]),
          gte(newsItemsTable.createdAt, new Date(Date.now() - RECENT_WINDOW_MS)),
        ))
        .orderBy(desc(newsItemsTable.createdAt))
        .limit(500);
      const existingIds = new Set(existing.map((e) => e.id));
      const d = dedupeTweets(fetched, existingIds, recentRows.map((r) => ({ id: r.externalId, text: r.text })));
      // Items stored by an earlier run are the norm for feeds (a feed lists its
      // last N items every time) — logged, not counted as duplicates.
      const alreadyStored = d.exactDuplicates.filter((t) => existingIds.has(t.id)).length;
      c.duplicates += d.exactDuplicates.length - alreadyStored + d.nearDuplicates.length;
      if (alreadyStored) push("info", `${alreadyStored} already stored — skipped`);
      for (const n of d.nearDuplicates) push("info", `${n.tweet.id} kept hidden: same story as ${n.duplicateOf} (${n.rule})`, n.tweet.authorHandle);

      // ── 4. store as hidden/unjudged ────────────────────────────────────
      // Near-duplicates are stored too — hidden, never sent to the AI, with
      // "duplicate of <id>" — so an admin can still publish one.
      const bySourceId = new Map(fetched.map((t) => [t.id, t.sourceId]));
      const toStore = d.kept as Array<NormalisedTweet>;
      const nearDupReason = new Map(d.nearDuplicates.map((n) => [n.tweet.id, `duplicate of ${n.duplicateOf}`]));
      const rowsToStore = [...toStore, ...d.nearDuplicates.map((n) => n.tweet)];
      const inserted = rowsToStore.length
        ? await this.db.insert(newsItemsTable).values(rowsToStore.map((t) => ({
            sourceId: bySourceId.get(t.id) ?? null,
            externalId: t.id,
            url: t.url,
            authorHandle: t.authorHandle,
            authorName: t.authorName,
            authorAvatarUrl: t.authorAvatarUrl,
            text: t.text,
            lang: t.lang,
            postedAt: t.postedAt ? new Date(t.postedAt) : null,
            media: t.media,
            metrics: t.metrics,
            status: "hidden",
            ...(nearDupReason.has(t.id)
              ? { aiRelevant: false, aiReason: nearDupReason.get(t.id)! }
              : { aiReason: "awaiting AI review" }),
            runId,
          }))).onConflictDoNothing({ target: newsItemsTable.externalId }).returning({ id: newsItemsTable.id, externalId: newsItemsTable.externalId })
        : [];
      const insertedIds = new Set(inserted.map((r) => r.externalId));
      const keptInserted = toStore.filter((t) => insertedIds.has(t.id)).length;
      c.newItems = keptInserted;
      c.duplicates += toStore.length - keptInserted; // lost a race with another writer
      await flush();

      // ── 5. AI: this run's items + earlier ones the AI never judged ─────
      const queue: NormalisedTweet[] = toStore.filter((t) => insertedIds.has(t.id));
      // The keyword filter costs nothing and cannot fail: no cap, one pass.
      const isAi = filterKind === "ai";
      const retry = await this.db.select().from(newsItemsTable).where(and(
        isNull(newsItemsTable.aiRelevant),
        eq(newsItemsTable.status, "hidden"),
        lt(newsItemsTable.aiAttempts, AI_MAX_ATTEMPTS),
        gte(newsItemsTable.createdAt, new Date(Date.now() - RETRY_WINDOW_MS)),
        sql`${newsItemsTable.runId} is distinct from ${runId}`,
      )).orderBy(desc(newsItemsTable.createdAt)).limit(RETRY_MAX);
      if (retry.length) push("info", `retrying AI review for ${retry.length} earlier unjudged item(s)`);
      for (const r of retry) {
        queue.push({
          id: r.externalId, url: r.url ?? "", text: r.text, lang: r.lang, postedAt: r.postedAt?.toISOString() ?? null,
          authorHandle: r.authorHandle ?? "", authorName: r.authorName, authorAvatarUrl: r.authorAvatarUrl,
          media: r.media ?? [], metrics: r.metrics ?? null,
        });
      }

      // The run's cost bound. What is over the cap stays hidden and unjudged
      // (no attempt counted); the next run's retry picks it up.
      const { send, deferred } = isAi ? capQueue(queue, cfg.maxAiItemsPerRun) : { send: queue, deferred: [] };
      if (deferred.length) {
        partial = true;
        push("warn", `AI cap reached: ${cfg.maxAiItemsPerRun} item(s) per run (NEWS_MAX_AI_ITEMS_PER_RUN) — ${deferred.length} left hidden for the next run`);
        this.logger.warn(`news run ${runId}: AI cap ${cfg.maxAiItemsPerRun} hit, ${deferred.length} deferred`);
        await this.markAiFailure(deferred.map((t) => t.id), "awaiting AI review (per-run AI cap reached; next run)", false);
      }

      const recentTitles = recentRows
        .filter((r) => r.status === "published")
        .map((r) => ({ externalId: r.externalId, title: r.title || r.titleAr || "" }))
        .filter((r) => r.title)
        .slice(0, 60);

      await processAiQueue(send, {
        classify: (batch) => ai.classify(batch, { extraInstructions: settings.extraInstructions, recent: recentTitles }),
        log: (level, message) => push(level, message),
        afterBatch: () => flush(),
        onFailure: async (ids, reason, attempted) => {
          partial = true;
          await this.markAiFailure(ids, reason, attempted);
        },
        onResult: async (batch, out, label) => {
          const textById = new Map(batch.map((t) => [t.id, t.text]));
          for (const p of out.problems) push("warn", p);
          for (const [id, v] of out.verdicts) {
            let status: "published" | "rejected" | "hidden" = decideStatus(v, settings.minScore);
            let reason = v.reason || null;
            // Deterministic guard: a post that talks to the filter is never
            // auto-published, whatever the model concluded.
            const held = detectManipulation(textById.get(id) ?? "");
            if (held && !v.duplicateOf) {
              status = "hidden";
              reason = heldReason(held, v.reason);
              push("warn", `${id} held for review: ${held}`);
            }
            if (v.duplicateOf) c.duplicates++;
            else if (status === "published") c.published++;
            else c.rejected++;
            await this.db.update(newsItemsTable).set({
              aiRelevant: v.relevant, aiScore: v.score, aiCategory: v.category,
              aiTitleAr: v.titleAr || null, aiTitleEn: v.titleEn || null,
              aiSummaryAr: v.summaryAr || null, aiSummaryEn: v.summaryEn || null,
              aiTags: v.tags, aiReason: reason, status, filterKind,
            }).where(and(eq(newsItemsTable.externalId, id), isNull(newsItemsTable.aiRelevant)));
            if (status === "published") recentTitles.unshift({ externalId: id, title: v.titleEn || v.titleAr });
          }
          if (out.missing.length) {
            partial = true;
            push("warn", `AI returned no verdict for ${out.missing.length} item(s) — kept hidden`);
            await this.markAiFailure(out.missing, "AI returned no verdict", true);
          }
          push("info", isAi
            ? `AI batch ${label}: ${out.verdicts.size} verdict(s), ${out.usage.input}/${out.usage.output} tokens`
            : `keyword filter: ${out.verdicts.size} item(s) judged`);
        },
      }, isAi ? {} : { batchSize: 200 });

      // ── 6. finish ──────────────────────────────────────────────────────
      const status = c.accountsTotal > 0 && c.accountsOk === 0 ? "failed" : partial ? "partial" : "success";
      push(status === "success" ? "info" : "warn",
        `done: ${c.accountsOk}/${c.accountsTotal} sources, ${c.fetched} fetched, ${c.newItems} new, ${c.published} published, ${c.rejected} rejected, ${c.duplicates} duplicates`);
      await this.db.update(newsJobRunsTable).set({
        ...c, status, finishedAt: new Date(), log,
        error: status === "failed" ? "every account failed — see log" : null,
      }).where(eq(newsJobRunsTable.id, runId));
      this.appLog.record({
        level: status === "success" ? "log" : "warn", event: "news_run_finished", context: "News",
        message: `news run ${status}`, meta: { runId, status, ...c },
      });
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      this.logger.error(`news run ${runId} failed: ${msg}`);
      push("error", `run failed: ${msg}`);
      await this.db.update(newsJobRunsTable).set({ ...c, status: "failed", finishedAt: new Date(), error: msg.slice(0, 1000), log })
        .where(eq(newsJobRunsTable.id, runId)).catch(() => undefined);
      this.appLog.record({ level: "error", event: "news_run_failed", context: "News", error: err, meta: { runId } });
    } finally {
      await lock.release();
    }
  }

  /** Feed bookkeeping: validators for the next conditional GET, site, a blank name. */
  private async afterRssFetch(src: NewsSource, res: RssFetchResult): Promise<void> {
    const patch: Partial<typeof newsSourcesTable.$inferInsert> = { lastFetchedAt: new Date(), lastError: null };
    if (!res.notModified) {
      patch.httpEtag = res.etag;
      patch.httpLastModified = res.lastModified;
      if (res.siteUrl && res.siteUrl !== src.siteUrl) patch.siteUrl = res.siteUrl;
      if (res.title && !src.displayName) patch.displayName = res.title.slice(0, 120);
    }
    await this.db.update(newsSourcesTable).set(patch).where(eq(newsSourcesTable.id, src.id));
  }

  /** Source bookkeeping after a successful fetch, incl. a rename seen on X. */
  private async afterFetch(
    src: NewsSource,
    profile: { userId: string | null; name: string | null; avatarUrl: string | null },
    tweets: NormalisedTweet[],
    push: (l: NewsRunLogEntry["level"], m: string, h?: string) => void,
  ): Promise<void> {
    const newest = tweets.reduce<string | null>((m, t) => (!m || compareTweetIds(t.id, m) > 0 ? t.id : m), null);
    const patch: Partial<typeof newsSourcesTable.$inferInsert> = { lastFetchedAt: new Date(), lastError: null };
    if (newest && (!src.lastSeenTweetId || compareTweetIds(newest, src.lastSeenTweetId) > 0)) patch.lastSeenTweetId = newest;
    if (profile.userId && profile.userId !== src.xUserId) patch.xUserId = profile.userId;
    // An admin-entered display name wins; X's only fills a blank one.
    if (profile.name && !src.displayName) patch.displayName = profile.name;
    if (profile.avatarUrl && profile.avatarUrl !== src.avatarUrl) patch.avatarUrl = profile.avatarUrl;

    // Fetched by user id, the timeline reports the account's CURRENT username.
    const current = tweets[0]?.authorHandle;
    if (src.handle && current && current !== src.handle && /^[a-z0-9_]{1,15}$/.test(current)) {
      const [clash] = await this.db.select({ id: newsSourcesTable.id }).from(newsSourcesTable).where(eq(newsSourcesTable.handle, current));
      if (!clash) {
        patch.handle = current;
        push("info", `account renamed @${src.handle} → @${current}`, current);
      }
    }
    await this.db.update(newsSourcesTable).set(patch).where(eq(newsSourcesTable.id, src.id));
  }

  /**
   * Record why the AI did not judge these items. `attempted` counts one failed
   * review; at AI_MAX_ATTEMPTS the item is given up — it stays hidden with a
   * reason saying so, and the retry query never picks it up again.
   */
  private async markAiFailure(externalIds: string[], reason: string, attempted: boolean): Promise<void> {
    if (!externalIds.length) return;
    const r = reason.slice(0, 400);
    const set = attempted
      ? {
          aiAttempts: sql`${newsItemsTable.aiAttempts} + 1`,
          aiReason: sql`case when ${newsItemsTable.aiAttempts} + 1 >= ${AI_MAX_ATTEMPTS}
            then ${`AI gave up after ${AI_MAX_ATTEMPTS} attempts — review manually. Last error: ${r}`}
            else ${`${r} (will retry next run)`} end`,
        }
      : { aiReason: r };
    await this.db.update(newsItemsTable).set(set)
      .where(and(inArray(newsItemsTable.externalId, externalIds), isNull(newsItemsTable.aiRelevant)))
      .catch((err) => this.logger.warn(`markAiFailure: ${(err as Error)?.message ?? err}`));
  }

  async loadSettings(): Promise<NewsJobSettings> {
    const [row] = await this.db.select().from(newsJobSettingsTable).where(eq(newsJobSettingsTable.id, 1));
    if (row) return row;
    const [created] = await this.db.insert(newsJobSettingsTable).values({ id: 1 }).onConflictDoNothing().returning();
    if (created) return created;
    const [again] = await this.db.select().from(newsJobSettingsTable).where(eq(newsJobSettingsTable.id, 1));
    return again;
  }
}

/** How a source is named in the run log: @handle for X, the host for a feed. */
export function sourceLabel(src: Pick<NewsSource, "kind" | "handle" | "feedUrl" | "displayName">): string {
  if (src.kind !== "rss") return src.handle ?? "?";
  if (src.displayName) return src.displayName;
  try {
    return new URL(src.feedUrl ?? "").hostname.replace(/^www\./, "");
  } catch {
    return src.feedUrl ?? "feed";
  }
}
