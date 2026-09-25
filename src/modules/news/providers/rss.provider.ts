import { ProviderError, type NormalisedTweet } from "../news.types";
import { FeedParseError, parseFeed } from "./rss.parse";
import { safeGet, SafeFetchError, type SafeFetchOptions } from "./safe-fetch";

/**
 * RSS/Atom — free, keyless, always configured.
 *
 * One GET per feed per run, conditional (If-None-Match / If-Modified-Since from
 * the validators stored on the source row), so an unchanged feed costs a 304.
 * Items are filtered to the lookback window and capped at max_per_account,
 * newest first. There is no "since id" for feeds; items already stored are
 * dropped by the runner's external_id dedupe.
 */
export const RSS_USER_AGENT = "Mozilla/5.0 (compatible; DaraNewsBot/1.0; +https://dara-sa.net)";
export const RSS_TIMEOUT_MS = 15_000;
export const RSS_MAX_BYTES = 2 * 1024 * 1024;

export interface RssFetchOptions {
  etag?: string | null;
  lastModified?: string | null;
  since?: Date | null;
  max: number;
  displayName?: string | null;
}

export interface RssFetchResult {
  notModified: boolean;
  etag: string | null;
  lastModified: string | null;
  title: string | null;
  siteUrl: string | null;
  items: NormalisedTweet[];
  /** Items in the feed but outside the lookback window / over the cap. */
  skipped: number;
}

function header(h: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = h[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s ? String(s).slice(0, 500) : null;
}

/** Bytes → text, honouring the HTTP charset, else the XML declaration, else UTF-8. */
export function decodeBody(body: Buffer, contentType: string | null): string {
  let charset = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? "")?.[1] ?? null;
  if (!charset) charset = /^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(body.subarray(0, 200).toString("latin1"))?.[1] ?? null;
  let text: string;
  try {
    text = new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    text = new TextDecoder("utf-8").decode(body);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export class RssProvider {
  readonly name = "rss" as const;

  constructor(private readonly fetchOpts: Pick<SafeFetchOptions, "resolve" | "transport"> = {}) {}

  async fetchFeed(feedUrl: string, opts: RssFetchOptions): Promise<RssFetchResult> {
    const headers: Record<string, string> = {
      "user-agent": RSS_USER_AGENT,
      accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
    };
    if (opts.etag) headers["if-none-match"] = opts.etag;
    if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;

    let res;
    try {
      res = await safeGet(feedUrl, { headers, timeoutMs: RSS_TIMEOUT_MS, maxBytes: RSS_MAX_BYTES, ...this.fetchOpts });
    } catch (err) {
      if (err instanceof SafeFetchError) {
        throw new ProviderError(err.kind === "blocked" || err.kind === "invalid_url" ? "not_found" : "other", err.message, err.status);
      }
      throw new ProviderError("other", `network error: ${(err as Error)?.message ?? err}`);
    }

    if (res.status === 304) {
      return { notModified: true, etag: opts.etag ?? null, lastModified: opts.lastModified ?? null, title: null, siteUrl: null, items: [], skipped: 0 };
    }
    if (res.status < 200 || res.status >= 300) {
      const kind = res.status === 404 || res.status === 410 ? "not_found" : res.status === 429 ? "rate_limit" : "other";
      throw new ProviderError(kind, `feed answered HTTP ${res.status}`, res.status);
    }

    let parsed;
    try {
      parsed = parseFeed(decodeBody(res.body, header(res.headers, "content-type")), { feedUrl, displayName: opts.displayName });
    } catch (err) {
      if (err instanceof FeedParseError) throw new ProviderError("other", err.message, res.status);
      throw err;
    }

    const sinceMs = opts.since?.getTime() ?? null;
    const inWindow = parsed.items.filter((i) => sinceMs == null || !i.postedAt || new Date(i.postedAt).getTime() >= sinceMs);
    // Newest first; undated items after dated ones (they are usually evergreen pages).
    inWindow.sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
    const items = inWindow.slice(0, Math.max(0, opts.max));
    return {
      notModified: false,
      etag: header(res.headers, "etag"),
      lastModified: header(res.headers, "last-modified"),
      title: parsed.title,
      siteUrl: parsed.siteUrl,
      items,
      skipped: parsed.items.length - items.length,
    };
  }
}
