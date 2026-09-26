/**
 * Shared shapes for the news module. Kept free of Nest/Drizzle imports so the
 * pure helpers (and their specs) can load it without the app.
 */

/** Fixed, code-coupled categories (the web maps each to a label + colour). */
export const NEWS_CATEGORIES = ["regulation", "market", "finance", "projects", "housing", "rental", "other"] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export const NEWS_ITEM_STATUSES = ["published", "rejected", "hidden"] as const;
export type NewsItemStatus = (typeof NEWS_ITEM_STATUSES)[number];

export const NEWS_RUN_STATUSES = ["running", "success", "partial", "failed", "skipped"] as const;
export type NewsRunStatus = (typeof NEWS_RUN_STATUSES)[number];

/** One post, normalised from whichever provider fetched it. */
export interface NormalisedTweet {
  id: string;
  url: string;
  text: string;
  lang: string | null;
  postedAt: string | null; // ISO
  authorHandle: string;
  authorName: string | null;
  authorAvatarUrl: string | null;
  media: Array<{ type: string; url: string | null; preview_url: string | null }>;
  /** X only; RSS items have none. */
  metrics: { likes: number; retweets: number; replies: number; views: number | null } | null;
  /** RSS only: the headline and the cleaned description, kept apart for the keyword filter. */
  title?: string | null;
  summary?: string | null;
}

export interface SourceProfile {
  userId: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface FetchOptions {
  /** Only tweets with an id greater than this. */
  sinceId?: string | null;
  /** Only tweets posted at or after this instant. */
  since?: Date | null;
  /** Upper bound on tweets returned. */
  max: number;
  /** X numeric user id if already known — saves a lookup. */
  userId?: string | null;
}

export interface FetchResult {
  profile: SourceProfile;
  tweets: NormalisedTweet[];
  /** Posts dropped as retweets / replies to others. */
  skipped: number;
}

export type ProviderErrorKind = "rate_limit" | "not_found" | "auth" | "quota" | "other";

/** Every provider failure is one of these, so the runner can decide per kind. */
export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly status: number | null = null,
    public readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** One X source in a batch fetch (providers that fetch every handle in one call). */
export interface BatchTarget {
  handle: string;
  /** Lookback start. */
  since: Date | null;
  sinceId: string | null;
  userId?: string | null;
  /** When this source was last fetched — lets a batch provider skip what it already has. */
  lastFetchedAt?: Date | null;
}

export interface BatchFetchResult {
  /** Per lowercase handle: its posts, or the error that source hit. */
  results: Map<string, FetchResult | { error: ProviderError }>;
  /** Posts whose author matched no target (e.g. a renamed account). */
  unmatched: number;
  /** Provider run info for the log (Apify: run id, cost). */
  run: { runId: string; status: string; costUsd: number | null; chargedItems: number | null; items: number } | null;
}

export interface SourceProvider {
  readonly name: "x" | "twitterapiio" | "apify";
  fetchLatest(handle: string, opts: FetchOptions): Promise<FetchResult>;
  /** Optional: every handle in one call (Apify: one actor run per job). */
  fetchMany?(targets: BatchTarget[], opts: { maxPerTarget: number; maxChargeUsd?: number | null }): Promise<BatchFetchResult>;
}

/** Compare two numeric tweet id strings (snowflakes exceed 2^53). */
export function compareTweetIds(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x === y ? 0 : x > y ? 1 : -1;
  } catch {
    return a.localeCompare(b);
  }
}
