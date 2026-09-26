import {
  compareTweetIds, ProviderError,
  type BatchFetchResult, type BatchTarget, type FetchOptions, type FetchResult, type NormalisedTweet,
  type SourceProfile, type SourceProvider,
} from "../news.types";
import { expandUrls, isoOrNull, largerAvatar, num, tweetUrl } from "./normalise";

const BASE = "https://api.apify.com/v2";
/**
 * Xquik's "X Tweet Scraper" (store: apify.com/xquik/x-tweet-scraper). Chosen
 * after measuring the candidates with a real token (docs/news/README.md →
 * "Apify"): $0.00015 per delivered tweet, no start fee, no minimum or mock rows
 * (kaitoeasyapi pads a thin query with paid "mock_tweet" rows), and a
 * `profileTweets` mode that takes every handle in one run. The input below is
 * shaped for this actor — another actor needs another mapping.
 */
export const APIFY_ACTOR = "xquik~x-tweet-scraper";
/** Per delivered row, FREE tier. Used only for estimates and the per-run charge cap. */
export const APIFY_PRICE_PER_ITEM_USD = 0.00015;
export const DEFAULT_APIFY_BUDGET_USD = 4.5;
export const DEFAULT_APIFY_MAX_ITEMS_PER_RUN = 300;
const MAX_ITEMS_CEILING = 5000;
/** Overlap re-read behind the last fetch, for posts that surface a little late. */
const REFETCH_OVERLAP_MS = 60 * 60_000;
/** Whole run, start to dataset — past it the run is aborted and what it has is used. */
const RUN_DEADLINE_MS = 240_000;
const POLL_WAIT_SECS = 60;
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

export interface ApifyUsage {
  /** Spend in the current Apify usage cycle (it is not a calendar month). */
  spentUsd: number;
  /** Apify's own hard cap for the cycle (the free plan: $5). */
  limitUsd: number | null;
  cycleStartAt: string | null;
  cycleEndAt: string | null;
}

export interface ApifyBudget {
  budgetUsd: number;
  usage: ApifyUsage | null;
  /** The smaller of our budget and Apify's cap. */
  effectiveBudgetUsd: number;
  /** Left before the budget; null when usage could not be read. */
  remainingUsd: number | null;
  overBudget: boolean;
  /** Why usage could not be read. */
  error: string | null;
}

export interface ApifyRunInfo {
  runId: string;
  status: string;
  costUsd: number | null;
  chargedItems: number | null;
  items: number;
}

export function readApifyBudget(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  return (raw ?? "").trim() && Number.isFinite(n) && n >= 0 ? n : DEFAULT_APIFY_BUDGET_USD;
}

export function readApifyMaxItems(raw: string | undefined): number {
  const t = (raw ?? "").trim();
  if (!/^\d+$/.test(t) || Number(t) < 1) return DEFAULT_APIFY_MAX_ITEMS_PER_RUN;
  return Math.min(Number(t), MAX_ITEMS_CEILING);
}

/** Pure: usage + budget → the decision. */
export function evaluateBudget(budgetUsd: number, usage: ApifyUsage | null, error: string | null = null): ApifyBudget {
  const effective = usage?.limitUsd != null ? Math.min(budgetUsd, usage.limitUsd) : budgetUsd;
  if (!usage) return { budgetUsd, usage: null, effectiveBudgetUsd: effective, remainingUsd: null, overBudget: false, error };
  const remaining = Math.max(0, effective - usage.spentUsd);
  return { budgetUsd, usage, effectiveBudgetUsd: effective, remainingUsd: remaining, overBudget: usage.spentUsd >= effective, error };
}

/** A snowflake tweet id → when it was posted. */
export function snowflakeTime(id: string | null | undefined): Date | null {
  if (!id || !/^\d{10,20}$/.test(id)) return null;
  try {
    return new Date(Number((BigInt(id) >> 22n) + 1288834974657n));
  } catch {
    return null;
  }
}

/**
 * The window one target needs: from the lookback, the last post seen or the
 * last fetch (minus an overlap) — whichever is latest. What is older was either
 * fetched already or is outside the lookback, and every row fetched costs money.
 */
export function targetSince(t: Pick<BatchTarget, "since" | "sinceId" | "lastFetchedAt">): Date | null {
  const c = [t.since ?? null, snowflakeTime(t.sinceId), t.lastFetchedAt ? new Date(t.lastFetchedAt.getTime() - REFETCH_OVERLAP_MS) : null]
    .filter((d): d is Date => !!d && !isNaN(d.getTime()));
  return c.length ? new Date(Math.max(...c.map((d) => d.getTime()))) : null;
}

/**
 * Apify — one actor run per job for every enabled X handle. The run is started,
 * polled to the end (or aborted at the deadline, keeping what it has), its
 * dataset read, and the rows handed back per handle. Retweets and replies are
 * excluded by the actor (not paid for) and again here.
 *
 * The token goes in the Authorization header only, never in a URL.
 */
export class ApifyProvider implements SourceProvider {
  readonly name = "apify" as const;
  /** The last run's id/cost, for the run log. */
  lastRun: ApifyRunInfo | null = null;

  constructor(
    private readonly token: string,
    private readonly opts: { budgetUsd?: number; maxItemsPerRun?: number } = {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly deadlineMs = RUN_DEADLINE_MS,
  ) {}

  get budgetUsd(): number {
    return this.opts.budgetUsd ?? DEFAULT_APIFY_BUDGET_USD;
  }

  get maxItemsPerRun(): number {
    return this.opts.maxItemsPerRun ?? DEFAULT_APIFY_MAX_ITEMS_PER_RUN;
  }

  /** This cycle's spend from `GET /users/me/limits`. */
  async usage(): Promise<ApifyUsage> {
    const body = await this.request("GET", "/users/me/limits", undefined, 20_000);
    const d = body?.data ?? {};
    const spent = Number(d?.current?.monthlyUsageUsd);
    if (!Number.isFinite(spent)) throw new ProviderError("other", "Apify usage: unexpected response");
    const limit = Number(d?.limits?.maxMonthlyUsageUsd);
    return {
      spentUsd: spent,
      limitUsd: Number.isFinite(limit) && limit > 0 ? limit : null,
      cycleStartAt: d?.monthlyUsageCycle?.startAt ?? null,
      cycleEndAt: d?.monthlyUsageCycle?.endAt ?? null,
    };
  }

  /** Budget check before spending. A failed usage read is reported, not fatal. */
  async budget(): Promise<ApifyBudget> {
    try {
      return evaluateBudget(this.budgetUsd, await this.usage());
    } catch (err) {
      return evaluateBudget(this.budgetUsd, null, (err as Error)?.message ?? String(err));
    }
  }

  /** One handle (the admin "Test" button): its latest `max` posts, no window. */
  async fetchLatest(handle: string, opts: FetchOptions): Promise<FetchResult> {
    const b = await this.budget();
    if (b.overBudget) throw overBudgetError(b);
    const res = await this.fetchMany([{ handle, since: opts.since ?? null, sinceId: opts.sinceId ?? null, userId: opts.userId ?? null }], {
      maxPerTarget: Math.min(opts.max, 20), maxChargeUsd: b.remainingUsd,
    });
    const r = res.results.get(handle.toLowerCase());
    if (!r || "error" in r) throw r && "error" in r ? r.error : new ProviderError("other", "no result");
    return r;
  }

  /**
   * Every target in one run. `maxChargeUsd` caps what Apify may charge for the
   * run (its own enforcement), on top of the item caps.
   */
  async fetchMany(targets: BatchTarget[], o: { maxPerTarget: number; maxChargeUsd?: number | null }): Promise<BatchFetchResult> {
    const handles = [...new Set(targets.map((t) => t.handle.toLowerCase()))];
    const results: BatchFetchResult["results"] = new Map();
    if (!handles.length) return { results, unmatched: 0, run: null };

    const perTarget = Math.max(1, Math.min(o.maxPerTarget, 100));
    const maxItems = Math.max(1, Math.min(this.maxItemsPerRun, perTarget * handles.length));
    const sinces = targets.map(targetSince);
    // One window for the run: the earliest any target needs. Targets that need
    // less are trimmed here after the fact (by id and time).
    const runSince = sinces.every(Boolean) ? new Date(Math.min(...sinces.map((d) => d!.getTime()))) : null;
    const input: Record<string, unknown> = {
      mode: "profileTweets",
      twitterHandles: handles,
      maxItems,
      maxItemsPerTarget: perTarget,
      tweetTypes: { excludeReplies: true, excludeRetweets: true },
    };
    if (runSince) input.time = { sinceTime: String(Math.floor(runSince.getTime() / 1000)) };

    const qs = new URLSearchParams({ waitForFinish: String(POLL_WAIT_SECS), memory: "256", maxItems: String(maxItems) });
    const cap = o.maxChargeUsd != null ? o.maxChargeUsd : maxItems * APIFY_PRICE_PER_ITEM_USD * 2;
    qs.set("maxTotalChargeUsd", Math.max(0.001, cap).toFixed(4));

    const started = Date.now();
    let run = (await this.request("POST", `/acts/${APIFY_ACTOR}/runs?${qs}`, input, (POLL_WAIT_SECS + 30) * 1000))?.data;
    if (!run?.id) throw new ProviderError("other", "Apify: the run did not start");
    while (!TERMINAL.has(run.status) && Date.now() - started < this.deadlineMs) {
      run = (await this.request("GET", `/actor-runs/${run.id}?waitForFinish=${POLL_WAIT_SECS}`, undefined, (POLL_WAIT_SECS + 30) * 1000))?.data ?? run;
    }
    if (!TERMINAL.has(run.status)) {
      await this.request("POST", `/actor-runs/${run.id}/abort`, undefined, 20_000).catch(() => undefined);
      run.status = "ABORTED (deadline)";
    }
    if (run.status === "FAILED" && !run.defaultDatasetId) throw new ProviderError("other", `Apify run ${run.id} failed`);

    const rows = run.defaultDatasetId
      ? await this.request("GET", `/datasets/${run.defaultDatasetId}/items?clean=1&format=json&limit=${maxItems + 50}`, undefined, 30_000)
      : [];
    const list: any[] = Array.isArray(rows) ? rows : [];
    const byHandle = normaliseApify(list);

    // The charge settles a moment after the run; one re-read for the log.
    const final = await this.request("GET", `/actor-runs/${run.id}`, undefined, 20_000).then((b) => b?.data).catch(() => null);
    this.lastRun = {
      runId: String(run.id),
      status: String(run.status),
      costUsd: numOrNull(final?.usageTotalUsd ?? run.usageTotalUsd),
      chargedItems: numOrNull((final?.chargedEventCounts ?? run.chargedEventCounts)?.["apify-default-dataset-item"]),
      items: list.length,
    };

    let matched = 0;
    const byUserId = new Map<string, string>();
    for (const [h, g] of byHandle.groups) if (g.profile.userId) byUserId.set(g.profile.userId, h);
    for (const t of targets) {
      const key = t.handle.toLowerCase();
      const g = byHandle.groups.get(key) ?? (t.userId && byUserId.has(t.userId) ? byHandle.groups.get(byUserId.get(t.userId)!) : undefined);
      const since = targetSince(t);
      const tweets = (g?.tweets ?? [])
        .filter((tw) => !t.sinceId || compareTweetIds(tw.id, t.sinceId) > 0)
        .filter((tw) => !since || !tw.postedAt || new Date(tw.postedAt) >= since)
        .sort((a, b) => compareTweetIds(b.id, a.id))
        .slice(0, perTarget);
      matched += g?.tweets.length ?? 0;
      results.set(key, {
        profile: g?.profile ?? { userId: t.userId ?? null, name: null, avatarUrl: null },
        tweets,
        skipped: g?.skipped ?? 0,
      });
    }
    const total = [...byHandle.groups.values()].reduce((n, g) => n + g.tweets.length, 0);
    return { results, unmatched: Math.max(0, total - matched), run: this.lastRun };
  }

  private async request(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ProviderError("other", `Apify network error: ${(err as Error)?.message ?? err}`);
    }
    const raw = await res.text().catch(() => "");
    let json: any = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    if (res.ok) {
      if (json == null) throw new ProviderError("other", `Apify: unparseable response (${res.status})`, res.status);
      return json;
    }
    const e = json?.error;
    const detail = String((typeof e === "object" ? [e?.type, e?.message].filter(Boolean).join(": ") : e) || raw.slice(0, 200)).slice(0, 300);
    if (res.status === 429) throw new ProviderError("rate_limit", `Apify 429 ${detail}`.trim(), 429, Number(res.headers.get("retry-after")) || null);
    if (res.status === 402 || (res.status === 403 && /limit|usage|credit|insufficient|exceed/i.test(detail))) {
      throw new ProviderError("quota", `Apify ${res.status} ${detail}`.trim(), res.status);
    }
    if (res.status === 401 || res.status === 403) throw new ProviderError("auth", `Apify ${res.status} ${detail}`.trim(), res.status);
    if (res.status === 404) throw new ProviderError("not_found", `Apify 404 ${detail}`.trim(), 404);
    throw new ProviderError("other", `Apify ${res.status} ${detail}`.trim(), res.status);
  }
}

export function overBudgetError(b: ApifyBudget): ProviderError {
  return new ProviderError("quota", `Apify budget reached: $${(b.usage?.spentUsd ?? 0).toFixed(2)} of $${b.effectiveBudgetUsd.toFixed(2)} this cycle`
    + (b.usage?.cycleEndAt ? ` (resets ${b.usage.cycleEndAt.slice(0, 10)})` : ""));
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return v != null && Number.isFinite(n) ? n : null;
}

/**
 * Pure: the actor's dataset rows → normalised posts grouped by author handle
 * (lowercase). Rows that are not tweets (the actor's diagnostic rows), native
 * retweets and replies to other accounts are dropped (counted in `skipped`).
 * Exported for the spec.
 */
export function normaliseApify(rows: any[]): {
  groups: Map<string, { profile: SourceProfile; tweets: NormalisedTweet[]; skipped: number }>;
  ignored: number;
} {
  const groups = new Map<string, { profile: SourceProfile; tweets: NormalisedTweet[]; skipped: number }>();
  const seen = new Set<string>();
  let ignored = 0;
  for (const t of rows) {
    const a = t?.author ?? {};
    const handle = String(a.username ?? a.userName ?? "").toLowerCase();
    if (!t?.id || !/^\d+$/.test(String(t.id)) || !handle) {
      ignored++;
      continue;
    }
    const id = String(t.id);
    const authorId = a.id != null ? String(a.id) : null;
    const g = groups.get(handle) ?? { profile: { userId: authorId, name: a.name ?? null, avatarUrl: largerAvatar(a.profilePicture) }, tweets: [], skipped: 0 };
    groups.set(handle, g);

    const isRetweet = t.type === "retweet" || t.isRetweet === true || !!t.retweeted_tweet || /^RT @/.test(t.text ?? "");
    const isReplyToOther = t.isReply === true && (!authorId || String(t.inReplyToUserId ?? "") !== authorId);
    if (isRetweet || isReplyToOther) {
      g.skipped++;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);

    const mediaList: any[] = Array.isArray(t.media) ? t.media : t.extendedEntities?.media ?? [];
    const text = expandUrls(t.text ?? t.fullText ?? "", t.entities?.urls, mediaList.map((m) => m?.url).filter(Boolean));
    g.tweets.push({
      id,
      url: typeof t.url === "string" && /^https:\/\/(x|twitter)\.com\//.test(t.url) ? t.url.replace("://twitter.com/", "://x.com/") : tweetUrl(handle, id),
      text,
      lang: typeof t.lang === "string" && t.lang ? t.lang : null,
      postedAt: isoOrNull(t.createdAt),
      authorHandle: handle,
      authorName: a.name ?? null,
      authorAvatarUrl: largerAvatar(a.profilePicture),
      media: mediaList.map((m) => {
        const type = String(m?.type ?? "photo");
        const still = m?.mediaUrl ?? m?.media_url_https ?? null;
        const variants: any[] = m?.videoInfo?.variants ?? m?.video_info?.variants ?? [];
        const video = variants.filter((v) => (v?.contentType ?? v?.content_type) === "video/mp4")
          .sort((x, y) => num(y.bitrate) - num(x.bitrate))[0];
        return { type, url: type === "photo" ? still : video?.url ?? still, preview_url: still };
      }),
      metrics: {
        likes: num(t.likeCount),
        retweets: num(t.retweetCount) + num(t.quoteCount),
        replies: num(t.replyCount),
        views: t.viewCount == null ? null : num(t.viewCount),
      },
    });
  }
  return { groups, ignored };
}
