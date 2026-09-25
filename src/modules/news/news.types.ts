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
  metrics: { likes: number; retweets: number; replies: number; views: number | null };
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

export interface SourceProvider {
  readonly name: "x" | "twitterapiio";
  fetchLatest(handle: string, opts: FetchOptions): Promise<FetchResult>;
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
