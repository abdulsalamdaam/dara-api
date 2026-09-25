import {
  compareTweetIds, ProviderError,
  type FetchOptions, type FetchResult, type NormalisedTweet, type SourceProvider,
} from "../news.types";
import { getJson } from "./http";
import { expandUrls, isoOrNull, largerAvatar, num, tweetUrl } from "./normalise";

const BASE = "https://api.twitterapi.io";
/** Pages of 20 (the endpoint's fixed size); 3 pages = 60 posts is past any sane max_per_account. */
const MAX_PAGES = 3;

/**
 * twitterapi.io — a pay-per-call scraper API, used when an X API plan is not
 * available. `GET /twitter/user/last_tweets?userName=` with `X-API-Key`,
 * newest first, 20 per page, `has_next_page` / `next_cursor`.
 *
 * No `since_id` parameter exists, so this pages until it reaches a tweet at or
 * below `sinceId`, one older than `since`, or `max`.
 */
export class TwitterApiIoProvider implements SourceProvider {
  readonly name = "twitterapiio" as const;

  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async fetchLatest(handle: string, opts: FetchOptions): Promise<FetchResult> {
    const all: NormalisedTweet[] = [];
    let skipped = 0;
    let profile: FetchResult["profile"] = { userId: opts.userId ?? null, name: null, avatarUrl: null };
    let cursor = "";

    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = new URLSearchParams({ userName: handle, includeReplies: "false" });
      if (cursor) qs.set("cursor", cursor);
      const body = await getJson(`${BASE}/twitter/user/last_tweets?${qs}`, { "x-api-key": this.apiKey }, this.fetchImpl);
      if (body?.status === "error") {
        const msg = String(body?.message ?? body?.msg ?? "error");
        throw new ProviderError(/not.?found|does not exist|suspend/i.test(msg) ? "not_found" : "other", msg);
      }
      const res = normaliseTwitterApiIo(body, handle, opts);
      skipped += res.skipped;
      all.push(...res.tweets);
      if (res.author) profile = { userId: res.author.userId ?? profile.userId, name: res.author.name, avatarUrl: res.author.avatarUrl };
      const next = body?.next_cursor ?? body?.data?.next_cursor;
      const hasNext = body?.has_next_page ?? body?.data?.has_next_page;
      if (res.reachedEnd || !hasNext || !next || all.length >= opts.max) break;
      cursor = String(next);
    }
    const seen = new Set<string>();
    const tweets = all.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
    tweets.sort((a, b) => compareTweetIds(b.id, a.id));
    return { profile, tweets: tweets.slice(0, opts.max), skipped };
  }
}

/**
 * Pure: one twitterapi.io page → normalised tweets. `reachedEnd` is true once a
 * tweet at/below `sinceId` or older than `since` is seen (the list is newest
 * first, so nothing past it is wanted). Exported for the spec.
 *
 * Tolerates both envelopes the service has used — `{ tweets }` at the top and
 * `{ data: { tweets } }`.
 */
export function normaliseTwitterApiIo(
  body: any,
  handle: string,
  opts: Pick<FetchOptions, "sinceId" | "since" | "max"> = { max: 100 },
): {
  tweets: NormalisedTweet[];
  skipped: number;
  reachedEnd: boolean;
  author: { userId: string | null; name: string | null; avatarUrl: string | null } | null;
} {
  const list: any[] = Array.isArray(body?.tweets) ? body.tweets : Array.isArray(body?.data?.tweets) ? body.data.tweets : [];
  let skipped = 0;
  let reachedEnd = false;
  let author: { userId: string | null; name: string | null; avatarUrl: string | null } | null = null;
  const tweets: NormalisedTweet[] = [];

  for (const t of list) {
    if (!t?.id) continue;
    const id = String(t.id);
    const postedAt = isoOrNull(t.createdAt);
    if (opts.sinceId && compareTweetIds(id, opts.sinceId) <= 0) {
      reachedEnd = true;
      continue;
    }
    if (opts.since && postedAt && new Date(postedAt) < opts.since) {
      reachedEnd = true;
      continue;
    }
    const a = t.author ?? {};
    const authorId = a.id != null ? String(a.id) : null;
    if (!author && (a.userName || a.name)) {
      author = { userId: authorId, name: a.name ?? null, avatarUrl: largerAvatar(a.profilePicture) };
    }

    const isRetweet = !!t.retweeted_tweet || /^RT @/.test(t.text ?? "");
    const isReplyToOther = t.isReply === true && (!authorId || String(t.inReplyToUserId ?? "") !== authorId);
    if (isRetweet || isReplyToOther) {
      skipped++;
      continue;
    }

    const mediaList: any[] = t.extendedEntities?.media ?? t.extended_entities?.media ?? t.entities?.media ?? [];
    const text = expandUrls(t.text ?? "", t.entities?.urls, mediaList.map((m) => m?.url).filter(Boolean));
    const h = String(a.userName ?? handle).toLowerCase();

    tweets.push({
      id,
      url: typeof t.url === "string" && t.url ? t.url.replace("://twitter.com/", "://x.com/") : tweetUrl(h, id),
      text,
      lang: t.lang ?? null,
      postedAt,
      authorHandle: h,
      authorName: a.name ?? null,
      authorAvatarUrl: largerAvatar(a.profilePicture),
      media: mediaList.map((m) => {
        const video = (m?.video_info?.variants ?? [])
          .filter((v: any) => v?.content_type === "video/mp4")
          .sort((x: any, y: any) => num(y.bitrate) - num(x.bitrate))[0];
        const type = String(m?.type ?? "photo");
        return {
          type,
          url: type === "photo" ? m?.media_url_https ?? null : video?.url ?? m?.media_url_https ?? null,
          preview_url: m?.media_url_https ?? null,
        };
      }),
      metrics: {
        likes: num(t.likeCount),
        retweets: num(t.retweetCount) + num(t.quoteCount),
        replies: num(t.replyCount),
        views: t.viewCount == null ? null : num(t.viewCount),
      },
    });
  }
  return { tweets, skipped, reachedEnd, author };
}
