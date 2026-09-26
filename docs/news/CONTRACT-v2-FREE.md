# v2 — run entirely free (RSS + keyword filter). Addendum to CONTRACT.md.

The owner wants zero running cost. The Claude subscription can't be used by a server, and X has no free tier.

## Sources: add RSS/Atom
- news_sources gains `kind text NOT NULL DEFAULT 'x'` ('x' | 'rss') and `feed_url text`
  (unique when kind='rss'); `handle` becomes nullable for rss rows (keep the unique
  index working, e.g. partial index where handle is not null). Idempotent ALTERs in a
  new migration 0062, wired into ensureSchema like 0061.
- RSS provider: free, no key, always "configured". Fetch with timeout (15s), size cap
  (2 MB), a real User-Agent, conditional GET (ETag / Last-Modified stored on the source
  row: `http_etag`, `http_last_modified`), and parse RSS 2.0 + Atom (use a small, maintained
  parser dependency such as `fast-xml-parser`; no DOM). Normalise to the same shape as
  tweets: external_id = sha256(guid || link), url = link (http/https only), author = feed
  or source display name, text = title + stripped description (strip HTML, decode entities),
  posted_at = pubDate/updated, media = enclosure / media:content / media:thumbnail images.
  Google News links: keep as-is. Respect lookback_hours and max_per_account.
- Dedupe unchanged (external_id unique + near-dup text across sources, which now also
  catches the same story from Argaam RSS and Google News).
- X sources stay supported; if no X key is set, X rows are skipped with a log line
  (not an error), and the run can still succeed on RSS alone.
- "configured" = at least one usable enabled source kind. `missing` lists only what
  blocks everything.

## Filter: free keyword filter, Claude optional
- `NEWS_FILTER` = 'auto' (default: Claude if ANTHROPIC_API_KEY set, else keyword) | 'keyword' | 'ai'.
- Keyword filter (`news.keyword-filter.ts` + lexicon file `news.lexicon.ts`): Arabic
  and English terms with weights per category, negative terms (ads, listings for sale,
  "للبيع", "للإيجار" + phone numbers, giveaways, greetings), Arabic normalisation
  (strip tashkeel/tatweel, unify أإآ→ا, ة→ه, ى→ي) before matching, word-boundary aware.
  Output the same verdict shape: relevant, score 0-100, category, tags, reason
  ("matched: ..."), title_* = feed title in its detected language (other language null),
  summary_* = first ~220 chars of cleaned description (same language). Deterministic, unit-tested.
- Items judged by keyword filter get `ai_model = 'keyword'` (add column `filter_kind`
  text, or reuse an existing one) so the admin UI can show "keyword" vs "Claude".
- The untrusted-post guard still applies.
- The lexicon + feed list come from the business agent: scratchpad news/rss-feeds.json
  and news/lexicon.md.

## Admin API changes
- POST /admin/news/sources accepts { kind:'rss', feedUrl, displayName? } (validate URL,
  http/https only, reject private/loopback IPs to avoid SSRF — resolve DNS and check).
- POST /admin/news/sources/test works for rss (fetch + parse, return title + first 5 items).
- GET /admin/news/status: `filter: 'keyword'|'ai'`, `sources: {x:{configured,count}, rss:{count}}`.

## Web changes
- Accounts section → "Sources": tabs or a kind badge; "Add source" dialog with X handle or
  RSS URL; test preview for RSS; favicon for RSS sources (from the feed's site, http(s) only).
- Status header shows filter mode (keyword — free / Claude) and a short note on upgrading.
- Cards: when only one language exists, show it (dir=auto) with a small language hint;
  "View on X" becomes "Read at <site>" for RSS.
- Not-configured banner disappears when RSS sources exist.

## v2 backend deviations (dara-api `feat/re-news`, as implemented)

All paths are under `/api`. Keys are camelCase, as in v1.

1. **Source rows** (`GET /admin/news/sources`) carry these new fields: `kind` (`'x'|'rss'`),
   `feedUrl`, `siteUrl`, `httpEtag` and `httpLastModified`. `handle` is **null** on rss rows.
   `displayName` fills from the feed title on the first fetch if blank.
   `siteUrl` is the feed's channel link; derive the favicon from its host. For Google
   News feeds it is `news.google.com`.
   Rows are ordered by kind (`rss` first), then by name. `itemCounts` is unchanged.
2. **Create:** `POST /admin/news/sources`:
   - `{ kind:'rss', feedUrl, displayName?, notes?, enabled? }` creates an RSS source. A body
     with `feedUrl` and no `handle` also means rss.
   - `{ handle, … }` (or `kind:'x'`) creates an X source, as before.
   - Errors:
     - 400 `feedUrl is required for an RSS source`;
     - 400 `feedUrl rejected: <why>`: not http(s), a port other than 80/443, credentials,
       localhost, or a private or reserved IP, checked after DNS;
     - 400 `kind must be 'x' or 'rss'`;
     - 409 `that feed is already in the list`.

   The feed is **not** fetched on create; use the test endpoint first. The URL is stored
   normalised, without its `#fragment`.
3. **Test** (always 200 unless the body is invalid):
   - Endpoints: `POST /admin/news/sources/test { kind:'rss', feedUrl }` and
     `POST /admin/news/sources/:id/test` for an rss row.
   - Response: `{ kind:'rss', ok, handle:null, feedUrl, provider:'rss', title, siteUrl,
     profile:{userId:null,name:title,avatarUrl:null}|null, tweets: NewsItemPreview[≤5], skipped,
     error:{kind,message}|null }`.
   - `tweets` has the same shape as X previews, plus `title` and `summary`; `metrics` is null.
   - Error kinds: `not_found` (404/410, or a blocked URL at fetch time), `rate_limit` (429),
     `other` (timeout, too large, HTML instead of a feed, invalid XML, other HTTP codes).
   - X tests now include `kind:'x'`. An X test without a key gives **200** with `ok:false`,
     `provider:null`, `tweets:[]` and `error:{kind:'no_key', message:'X key not set — the
     account is saved and will be fetched once X_BEARER_TOKEN or TWITTERAPI_IO_KEY is added'}`.
     This changed after QA (dara-api `0cbe3db`); it used to be a 400 "X is not configured".
     Creating, toggling and deleting X accounts never needs a key.
4. **Status:** `GET /admin/news/status` adds these fields:
   - `filter: 'keyword'|'ai'`, the filter a run uses now;
   - `filterSetting: 'auto'|'keyword'|'ai'`;
   - `sources: { x:{configured,count,enabled}, rss:{count,enabled} }`;
   - `warnings: string[]`, non-blocking. Example: `"X sources are skipped — X_BEARER_TOKEN"`
     when `NEWS_SOURCE_PROVIDER=x` is set without its key but RSS exists, or an invalid
     NEWS_FILTER.

   `model` is **null** in keyword mode. `provider` is null when X has no key.
   `configured.source` is true when an X key is set or ≥1 **enabled** rss row exists.
   `configured.ai` is true when the chosen filter can run: keyword is always true, and
   `ai` needs a key. `missing` lists only what blocks every run. With no RSS and no X
   key it is `"an enabled RSS source, or X_BEARER_TOKEN / TWITTERAPI_IO_KEY"`. The
   not-configured banner should key off `configured.source && configured.ai`, which is
   true with RSS alone.
5. **Items (portal + admin)** from RSS use the same shape as v1:
   - `url` is the article (Google News links kept as-is).
   - `authorHandle` is the **publisher's host**, e.g. `maaal.com` or `alyaum.com`. Use it
     for "Read at <site>" and the favicon.
   - `authorName` is the publisher's name (Google `<source>`, else the source's display
     name, else the feed title).
   - `authorAvatarUrl` is null and `metrics` is **null**. Hide the metrics row.
   - `lang` is `'ar'|'en'`.
   - `media` holds images from enclosure / media:content / media:thumbnail / the first
     `<img>`, http(s) only.
   - `text` is the title, a blank line, then the cleaned description (Google News
     descriptions are dropped).
   - Tell RSS from X items by `authorHandle` containing a `.` (X handles never do). The
     admin rows also have `sourceId` → source `kind`.
6. **Keyword verdicts:**
   - `filterKind: 'keyword'` on admin item rows (`'ai'` = Claude, including all pre-v2
     rows; null = not judged or a stored near-duplicate). The portal item shape does
     **not** include it.
   - Only the source language's title and summary are set: `titleAr`/`summaryAr` **or**
     `titleEn`/`summaryEn`. The other pair is **null**. `summary*` is ≤220 chars ending in
     `…`, or null (Google News items have no summary).
   - `tags` are lexicon tags such as `rega`, `rent-freeze`, `redf` or `sakani` (English
     slugs).
   - `aiReason` reads `keyword <score>: matched: t1, t2 | neg: … | foreign: …`.
   - `aiScore` runs 0–100 and publishes at `minScore` (60), as with the AI.
7. **Runs:**
   - Log `handle` for RSS lines is the source's display name, or its host.
   - The first line reads `x=<provider|off (no key)> filter=<keyword|claude (model)> …`.
   - X rows skipped for a missing key produce one info line and do not make the run
     `partial`.
   - `accountsTotal`/`accountsOk` now count **sources** (X rows skipped for no key are not
     counted).
   - Items stored by an earlier run (normal for feeds) are logged as "N already stored"
     and no longer counted in `duplicates`.
   - A feed failure never stops the other feeds (only X rate-limit, quota or auth stop X).
8. **Not in v2:** there is no `PATCH` of `feedUrl`; delete the source and re-add it. PATCH
   is still `displayName`, `notes` and `enabled`. The keyword filter has no admin-editable
   lexicon; it lives in code (`news.lexicon.ts`), and `extraInstructions` only affects
   Claude.
9. **Seed:** `news/seed-rss.sql` (also `docs/news/seed-rss.sql` in dara-api) inserts the 15
   verified feeds from `rss-feeds.json`, idempotently. It has not been run anywhere yet.

## Changes after v2 QA (26 Sep 2026)
- `GET /news/summary` adds `filter: 'keyword'|'ai'`, the filter runs use now. The portal
  uses it to pick the disclosure text (dara-api `14acf42`, dara-web `44cd9f1`).
- X test without a key → 200 `no_key` (see 3 above). The web shows X accounts as "Waiting
  for X key" (neutral), saves them without a test, and the header reads "X is paused until
  a key is added … RSS feeds run as normal" (dara-web `a05bfa8`).
- Lexicon: `*` now works on every word of a phrase, not only the last one. Also new: the
  term «العقار* السعودي*» (45, sa), and the negatives «هل نزل» / «متى ينزل» (30)
  (dara-api `e2ff5c2`).
