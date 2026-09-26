# Real-estate news (الأخبار العقارية)

A daily job collects Saudi real-estate news, keeps what matters to landlords, and shows
it in the portal. Super-admins manage the sources, the schedule, the run-now button,
run history and moderation.

**Default: free mode ($0 to run).** Sources are public **RSS/Atom feeds** (15 verified
feeds, mostly Google News searches plus Argaam, Aleqt, SPA, Al Arabiya, Al Yaum, Okaz and
Al Madina). A **deterministic keyword filter** decides what is published. It needs no
keys, no paid API and no AI. Claude (as the filter) and X (as a source) are optional
upgrades, switched on by env vars alone (see "Upgrading" below).

**Status (26 Sep 2026):** staging only (`master`). Not on `main` or production. Staging
runs in free mode: 15 RSS feeds are enabled, and the 18 enabled X accounts are skipped
because no X key is set. The first real runs are in `QA.md` under "v2 (free mode) QA".

## Files in this folder
| file | what |
|---|---|
| `README.md` | this runbook |
| `CONTRACT.md` | v1 API contract plus the "Backend deviations" (what actually shipped) |
| `CONTRACT-v2-FREE.md` | v2 addendum (RSS + keyword filter) plus the v2 backend deviations |
| `BUSINESS.md` | audience, AI relevance rubric, categories, style guide, defaults, edge cases |
| `lexicon.md` | the keyword filter: normalisation, matching, scoring, lexicon and worked examples (API repo, and web repo from v2 QA) |
| `rss-feeds.json` | the 15 verified RSS feeds (URL, publisher, why chosen) |
| `seed-rss.sql` | an idempotent insert of those feeds (API repo only) |
| `seed-accounts.json` | the 20 verified X accounts (used only once an X key is set) |
| `DESIGN.md` | screen spec: wireframes, components, states, i18n keys (web repo only) |
| `QA.md` | QA reports from staging, v1 and v2, with the bugs fixed (web repo only) |
| `qa/*.png` | QA screenshots; `v2-*.png` are free mode (web repo only) |

## Where things are
- **API** (`dara-api`): `src/modules/news/`, schema `db/src/schema/news.ts`, migrations
  `db/drizzle/0061_re_news.sql` + `0062_re_news_rss.sql`. Both are idempotent and applied
  on every boot by `ensureSchema`, so they need no manual SQL.
  - Keyword filter: `news.keyword-filter.ts`, lexicon `news.lexicon.ts`, matching
    `news.text.ts`.
  - RSS: `providers/rss.provider.ts`, `rss.parse.ts`, and the SSRF-safe fetch
    `safe-fetch.ts`.
- **Web** (`dara-web`): portal `components/dashboard/NewsView.tsx` + `components/news/*`.
  Admin `components/admin/tabs/NewsTab.tsx` + `components/admin/tabs/news/*`. Hooks are
  in `lib/api-hooks.ts` and `admin-hooks.ts`, strings under `news.*` / `admin.news.*`.
- **Screens:** portal `/dashboard/news?cat=&q=`. Admin
  `/admin?tab=news&section=overview|sources|items|runs|settings`.

## Free mode (the default)
### Sources: RSS/Atom feeds
- **Storage:** feeds are `news_sources` rows with `kind = 'rss'` and a `feed_url`, next
  to any X rows.
- **Adding feeds:** in Admin → News → Sources → Add source → RSS feed. Preview a feed
  before saving it. Or seed the verified list with
  `psql "$DATABASE_URL" -f docs/news/seed-rss.sql`, which is idempotent.
- **Fetching:** each run makes one **conditional GET** per feed; the ETag and
  Last-Modified are stored on the row. Limits: a 15 s timeout, a 2 MB cap applied after
  decompression, and at most 5 redirects.
- **Per-feed limits:** `lookback_hours` (36) and `max_per_account` (20) apply to each
  feed.
- **Failures:** a feed that fails is logged and never stops the other feeds.
- **SSRF guard:**
  - only http(s) on ports 80 and 443, with no credentials in the URL;
  - the host must resolve to public addresses only, checked at connect time (so DNS
    rebinding cannot get through) and again on every redirect;
  - loopback, RFC 1918, link-local/metadata (169.254.x), CGNAT, IPv6 ULA and v4-mapped
    addresses are refused.

  The guard was verified on staging, with a `*.nip.io` name and a redirect to
  169.254.169.254 among the cases.
- **Parsing:** `fast-xml-parser` with entities off, and HTML stripped to text.
- **Item fields:**
  - `url` is the article link (Google News links are kept as-is);
  - `authorHandle` is the publisher's host;
  - `authorName` is the publisher's name;
  - `metrics` is null.

### X accounts: first-class, even without a key
X accounts are a normal source kind, and they can be managed with or without a key:
- **Add:** in Admin → News → Sources → Add source → X account, by `@handle` or by pasting
  an `x.com/…` link. No key is needed; the account saves at once.
- **Waiting state:** with no key set, the button reads "Add account" and the account is
  saved without a test. The sheet that follows says **"Waiting for X key"** and names the
  two env vars. This is a neutral state, not an error.
- **Test:** the API answers `200` with `error.kind = 'no_key'`; it never returns 400 and
  never shows an error toast.
- **The list:** each X row shows its handle, name and toggle, plus a neutral "Waiting for
  X key" pill instead of an error. Its run-one button is disabled until a key exists.
  Toggle and delete work as usual.
- **Header:** reads "X is paused until a key is added (N accounts waiting). RSS feeds run
  as normal."
- **Runs:** X rows are skipped with one info line. The run does not become `partial` and
  still succeeds on RSS.
- **After a key is set:** the next run fetches every enabled X account next to the feeds,
  with no other change.

### Filter: keyword scoring
- **What it is:** a 0–100 score from Arabic and English lexicon terms, weighted per
  category. It publishes at `min_score` (60), like the AI path.
  - **Scoring:** a term in the title counts at full weight and one in the description at
    half, with diminishing returns after the first term. A Saudi place or entity adds
    points, a foreign market with no Saudi context subtracts heavily, and a figure with a
    unit adds points.
  - **Negative terms** cover ads, listings, greetings, sport, oil and FX, SEO question
    headlines and similar.
  - **Hard blocks** cover phone numbers, "for sale/rent + price", WhatsApp and
    retweet-to-win.
  - **Before matching,** Arabic text is normalised: tashkeel and tatweel are stripped,
    and letter forms are unified (أإآ→ا, ة→ه, ى→ي).
  - The spec and worked examples are in `lexicon.md`.
- **Output:** the publisher's own headline, plus the first ~220 characters of the
  description as the summary. Both stay in the source language; the other language is
  null, and the portal shows the card with a small language hint. Tags are lexicon slugs
  (`rega`, `redf`, `sakani`, `rent-freeze` and so on). `ai_reason` reads
  `keyword <score>: matched: … | neg: … | foreign: …`, and `filter_kind = 'keyword'`.
- **Story clustering** runs before the filter. Items are one story when they:
  - share a figure plus an entity;
  - overlap ≥ 50% on content tokens; or
  - pass Jaccard ≥ 0.6.

  This check covers this run and the last 72 h. It keeps one canonical copy (a `.gov.sa`
  copy first, then the publisher's own feed, then Google News). The rest are stored
  hidden as "duplicate of <id>", and an admin can still publish them.
- **Unchanged from v1:** the untrusted-post guard, moderation, pinning and the schedule
  work exactly as before.
- **Portal disclosure:** in keyword mode the disclosure says the headlines and excerpts
  are the publishers' own, picked by keyword matching. In AI mode it says Claude wrote and
  classified them. `GET /news/summary` returns `filter` so the portal knows which mode
  applies.

### Cost: $0
There are no API keys, per-item charges or tokens in free mode. RSS feeds and Google News
RSS are free, and the filter runs in-process in a few milliseconds per item. The only cost
is the existing API container.

### What free mode cannot do
- **Rewriting:** it does not rewrite or translate. An Arabic story has no English title,
  and the reverse.
- **Judging relevance:** it matches words, not meaning. The first staging run judged 108
  items; 2 false negatives and 1 false positive were found and fixed in the lexicon (see
  `QA.md`). Expect a few misses, which admins can publish or hide by hand.
- **Lexicon edits:** the lexicon lives in code (`news.lexicon.ts`) with unit tests, and
  cannot be edited from the admin UI. `extraInstructions` only affects Claude.

## Upgrading later (optional)
Both upgrades are env vars on `dara-api` alone, plus a redeploy. No code, migration or
data change is needed, and both can be switched off again by removing the var.

| upgrade | set | effect |
|---|---|---|
| **Claude as the filter** | `ANTHROPIC_API_KEY` (and optionally `NEWS_AI_MODEL`, default `claude-sonnet-5`) | With `NEWS_FILTER=auto` (the default), runs switch to Claude. It writes an Arabic **and** English title and summary, applies the BUSINESS.md rubric plus the admin's extra instructions, and is capped by `NEWS_MAX_AI_ITEMS_PER_RUN` (150). Existing items keep their keyword verdicts, and the portal disclosure switches to the AI wording. This is paid per token. |
| **Force a filter** | `NEWS_FILTER=keyword` or `ai` | `keyword` stays free even with a key set. `ai` without a key blocks runs ("missing ANTHROPIC_API_KEY"). |
| **X accounts as sources** | `X_BEARER_TOKEN` (official X API, paid tier) **or** `TWITTERAPI_IO_KEY` (cheaper third party); optional `NEWS_SOURCE_PROVIDER=x`/`twitterapiio` | The X rows already in Sources (18 enabled) start being fetched next to the RSS feeds. Without a key they are skipped with one info line, which does not make a run `partial`. |

**To set a var on staging:** set it on `dara-api-staging` (uuid
`rg2fzzvc8wnxd8njnyi1bqxu`) through Coolify's own tinker, because the REST token on this
machine is dead (see DARA-NOTES §1). Then redeploy, and check Admin → News: the header
shows the filter mode, and Run now shows the effect in the run log.

## How a run works
1. **Trigger.** A 60 s in-process tick claims a due run atomically, with a conditional
   UPDATE on `news_job_settings.next_run_at` plus a pg advisory lock. The schedule is
   `run_time` HH:MM in Asia/Riyadh on `days_of_week` (default 07:00 daily). There is no
   catch-up after downtime.

   **Run now** (`POST /admin/news/run`) returns 202, or 409 while a run is in progress.
2. **Fetch** every enabled source:
   - **RSS feeds:** a conditional GET for each. An item stored by an earlier run is
     logged as "N already stored".
   - **X accounts:** fetched only when a key is set. Posts come since
     `last_seen_tweet_id`, excluding retweets and replies. Rate-limit, quota or auth
     errors stop X.
3. **Dedupe:** by `external_id` (sha256 of guid or link for RSS), then by story
   clustering (see above).
4. **Filter:** keyword (free) or Claude (batches of 10, structured output checked with
   zod, posts wrapped as untrusted data). A score of at least `min_score` (60) is
   `published`; the rest are `rejected`. The guard (`news.guard.ts`) keeps any post that
   tries to steer the filter `hidden`, whatever the verdict.
5. **Failure bounds (Claude only):**
   - a truncated batch is split in half, and each half is retried once;
   - an item is given up after 3 failed reviews (`ai_attempts`);
   - at most `NEWS_MAX_AI_ITEMS_PER_RUN` posts go to Claude per run;
   - during an AI outage the feed keeps what it already had.
6. **Stale runs:** `running` rows left by a killed process are marked failed as soon as
   no process holds the lock.

The first log line of a run reads `x=<provider|off (no key)> filter=<keyword|claude
(model)> …`.

## Env (dara-api)
| var | purpose |
|---|---|
| `NEWS_FILTER` | `auto` (default: Claude if `ANTHROPIC_API_KEY` is set, else keyword) / `keyword` / `ai` |
| `ANTHROPIC_API_KEY` | optional: the Claude filter |
| `NEWS_AI_MODEL` | default `claude-sonnet-5` |
| `NEWS_MAX_AI_ITEMS_PER_RUN` | default 150, max 2000 |
| `X_BEARER_TOKEN` | optional: official X API v2 (paid tier with read access to user timelines) |
| `TWITTERAPI_IO_KEY` | optional: twitterapi.io. X needs **one** of these two; without either, X rows are skipped |
| `NEWS_SOURCE_PROVIDER` | `x` / `twitterapiio`. Blank means whichever key is set, X first |
| `NEWS_SCHEDULER_DISABLED` | `1` = no in-process tick (local dev) |

## Admin (Admin → News)
- **Header:** shows the filter mode ("keyword — free" or "Claude"), with a short note on
  upgrading.
- **Sources:** RSS feeds and X accounts, each with a kind badge and a favicon for feeds.
  - **Add:** an X handle, or an RSS URL with Preview.
  - **Manage:** Test, toggle, delete. A feed URL cannot be edited; delete the source and
    add it again.
- **Items:** a Filter column (keyword / Claude), with publish, hide, pin and recategorise.
- **Runs:** history plus a full log.
- **Schedule:** enabled, run time (Riyadh), days, lookback, max per source, minimum score,
  and extra AI instructions (Claude only, ≤ 2000 chars; they cannot loosen the safety
  rules).

## Audience
Every signed-in account sees the feed, including tenant-package and demo accounts, so
`"news"` is in `TENANT_TABS`. The admin screens and every `/admin/news/*` route are
super-admin only.

## Known / open
- **X before its first live run:** check the X API's `since_id` + `start_time`
  behaviour, since the docs say `since_id` wins. Neither X provider has run against live
  keys.
- **Keyword filter limits:** see "What free mode cannot do" and `QA.md` (v2).
- **Sidebar position:** "News" sits second. BUSINESS.md suggested placing it above
  Settings; this is a product call.
- **Hydration error:** React hydration error #418 on every `/admin` tab predates this
  feature.
- **Promotion to production:** merge `feat/re-news` to `main`; the migrations apply
  themselves on boot. Then seed the feeds with `seed-rss.sql`. Free mode needs no env.
  Seed X accounts from `seed-accounts.json` only when an X key is set.
