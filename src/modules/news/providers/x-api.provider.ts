import {
  compareTweetIds, ProviderError,
  type FetchOptions, type FetchResult, type NormalisedTweet, type SourceProfile, type SourceProvider,
} from "../news.types";
import { getJson } from "./http";
import { expandUrls, isoOrNull, largerAvatar, num, tweetUrl } from "./normalise";

const BASE = "https://api.x.com/2";

/**
 * The official X API v2, app-only bearer token.
 *
 *   GET /2/users/by/username/:handle   → id, name, avatar (skipped once cached)
 *   GET /2/users/:id/tweets            → the timeline, retweets + replies excluded
 *
 * X caps a timeline page at 100 and the job asks for at most `max_per_account`,
 * so one page is enough; `since_id` makes the next run cheap.
 */
export class XApiProvider implements SourceProvider {
  readonly name = "x" as const;

  constructor(private readonly bearer: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private headers() {
    return { authorization: `Bearer ${this.bearer}` };
  }

  async lookupUser(handle: string): Promise<SourceProfile & { userId: string }> {
    const body = await getJson(
      `${BASE}/users/by/username/${encodeURIComponent(handle)}?user.fields=profile_image_url,name`,
      this.headers(), this.fetchImpl,
    );
    const u = body?.data;
    if (!u?.id) {
      const e = body?.errors?.[0];
      const suspended = /suspend/i.test(e?.detail ?? "");
      throw new ProviderError("not_found", suspended ? `@${handle} is suspended` : `@${handle} not found on X`, 404);
    }
    return { userId: String(u.id), name: u.name ?? null, avatarUrl: largerAvatar(u.profile_image_url) };
  }

  async fetchLatest(handle: string, opts: FetchOptions): Promise<FetchResult> {
    let profile: SourceProfile = { userId: opts.userId ?? null, name: null, avatarUrl: null };
    if (!profile.userId) profile = await this.lookupUser(handle);

    const qs = new URLSearchParams({
      max_results: String(Math.min(100, Math.max(5, opts.max))),
      exclude: "retweets,replies",
      "tweet.fields": "created_at,public_metrics,lang,attachments,entities,note_tweet,referenced_tweets,author_id,in_reply_to_user_id",
      expansions: "attachments.media_keys,author_id",
      "media.fields": "type,url,preview_image_url",
      "user.fields": "profile_image_url,name,username",
    });
    if (opts.sinceId) qs.set("since_id", opts.sinceId);
    if (opts.since) qs.set("start_time", opts.since.toISOString().replace(/\.\d{3}Z$/, "Z"));

    const body = await getJson(`${BASE}/users/${profile.userId}/tweets?${qs}`, this.headers(), this.fetchImpl);
    const res = normaliseXTimeline(body, handle, opts);
    return {
      profile: {
        userId: profile.userId,
        name: res.author?.name ?? profile.name,
        avatarUrl: res.author?.avatarUrl ?? profile.avatarUrl,
      },
      tweets: res.tweets,
      skipped: res.skipped,
    };
  }
}

/** Pure: an X v2 timeline response → normalised tweets. Exported for the spec. */
export function normaliseXTimeline(
  body: any,
  handle: string,
  opts: Pick<FetchOptions, "sinceId" | "since" | "max"> = { max: 100 },
): { tweets: NormalisedTweet[]; skipped: number; author: { name: string | null; avatarUrl: string | null } | null } {
  const data: any[] = Array.isArray(body?.data) ? body.data : [];
  const media = new Map<string, any>();
  for (const m of body?.includes?.media ?? []) if (m?.media_key) media.set(m.media_key, m);
  const users = new Map<string, any>();
  for (const u of body?.includes?.users ?? []) if (u?.id) users.set(String(u.id), u);

  let skipped = 0;
  let author: { name: string | null; avatarUrl: string | null } | null = null;
  const tweets: NormalisedTweet[] = [];

  for (const t of data) {
    if (!t?.id) continue;
    const refs: any[] = t.referenced_tweets ?? [];
    const isRetweet = refs.some((r) => r?.type === "retweeted") || /^RT @/.test(t.text ?? "");
    const isReplyToOther = refs.some((r) => r?.type === "replied_to") && t.in_reply_to_user_id && t.in_reply_to_user_id !== t.author_id;
    if (isRetweet || isReplyToOther) {
      skipped++;
      continue;
    }
    if (opts.sinceId && compareTweetIds(String(t.id), opts.sinceId) <= 0) continue;
    const postedAt = isoOrNull(t.created_at);
    if (opts.since && postedAt && new Date(postedAt) < opts.since) continue;

    const u = users.get(String(t.author_id));
    if (u && !author) author = { name: u.name ?? null, avatarUrl: largerAvatar(u.profile_image_url) };

    // A long post's `text` is cut at 280 with a t.co to itself; `note_tweet`
    // carries the whole thing.
    const long = t.note_tweet?.text;
    const text = expandUrls(long ?? t.text ?? "", (long ? t.note_tweet?.entities?.urls : t.entities?.urls) ?? t.entities?.urls);

    const pm = t.public_metrics ?? {};
    tweets.push({
      id: String(t.id),
      url: tweetUrl(u?.username ?? handle, String(t.id)),
      text,
      lang: t.lang ?? null,
      postedAt,
      authorHandle: (u?.username ?? handle).toLowerCase(),
      authorName: u?.name ?? null,
      authorAvatarUrl: largerAvatar(u?.profile_image_url),
      media: (t.attachments?.media_keys ?? [])
        .map((k: string) => media.get(k))
        .filter(Boolean)
        .map((m: any) => ({ type: String(m.type ?? "photo"), url: m.url ?? null, preview_url: m.preview_image_url ?? m.url ?? null })),
      metrics: {
        likes: num(pm.like_count),
        retweets: num(pm.retweet_count) + num(pm.quote_count),
        replies: num(pm.reply_count),
        views: pm.impression_count == null ? null : num(pm.impression_count),
      },
    });
  }
  tweets.sort((a, b) => compareTweetIds(b.id, a.id));
  return { tweets: tweets.slice(0, opts.max), skipped, author };
}
