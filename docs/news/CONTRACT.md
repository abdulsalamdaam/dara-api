# Real-estate News — shared contract (staging-only feature)

Feature: a daily job pulls tweets from admin-managed X (Twitter) accounts, an AI
(Claude) filters them for Saudi real-estate relevance, classifies, and writes a
bilingual (AR/EN) title + summary. Landlords read a curated feed in the portal;
super-admins manage accounts, schedule, run-now, review runs, and moderate items.

Branch: `feat/re-news` in dara-api and dara-web (cut from `main`). Staging deploys
from `master`. Do NOT push to `main`.

## Env (dara-api)
- NEWS_SOURCE_PROVIDER = `x` (official X API v2, needs X_BEARER_TOKEN) | `twitterapiio`
  (twitterapi.io, needs TWITTERAPI_IO_KEY). Default: pick whichever key is present.
- ANTHROPIC_API_KEY; NEWS_AI_MODEL (default a current Claude model — check the claude-api skill).
- Missing keys => feature reports `configured: false` with the exact missing var names;
  scheduled runs are skipped (not recorded as failures); manual run returns 400 with that reason.

## Tables (hand-written migration, see dara-api/CLAUDE.md)
- news_sources: id uuid, handle text unique (no @, lowercase), display_name, avatar_url,
  x_user_id, enabled bool default true, notes text, last_fetched_at, last_seen_tweet_id,
  last_error text, created_at, updated_at
- news_items: id uuid, source_id fk (on delete set null), external_id text unique,
  url, author_handle, author_name, author_avatar_url, text, lang, posted_at timestamptz,
  media jsonb (array of {type,url,preview_url}), metrics jsonb ({likes,retweets,replies,views}),
  ai_relevant bool, ai_score int 0-100, ai_category text, ai_title_ar, ai_title_en,
  ai_summary_ar, ai_summary_en, ai_tags text[], ai_reason text,
  status text: 'published' | 'rejected' | 'hidden'  (AI sets published/rejected; admin can override to any),
  pinned bool default false, run_id fk, created_at, updated_at
- news_job_settings (single row id=1): enabled bool, run_time text 'HH:MM' (Asia/Riyadh),
  days_of_week int[] (0=Sun..6, default all), lookback_hours int default 36,
  max_per_account int default 20, min_score int default 60, extra_instructions text,
  next_run_at timestamptz, updated_at, updated_by
- news_job_runs: id uuid, trigger 'schedule'|'manual', triggered_by user id nullable,
  status 'running'|'success'|'partial'|'failed'|'skipped', started_at, finished_at,
  accounts_total, accounts_ok, fetched, new_items, published, rejected, duplicates,
  error text, log jsonb (array of {at, level, message, handle?})

Categories (fixed, code-coupled): `regulation` (REGA, Ejar, laws), `market` (prices,
transactions, indices), `finance` (mortgage, SAMA, rates, REITs), `projects` (giga
projects, developments, launches), `housing` (Sakani, MOMRAH, housing programs),
`rental` (rental market, Ejar, tenant/landlord), `other`.

## Endpoints (dara-api, all JSON, snake_case → match existing API style you find)
Portal — JwtAuthGuard, any signed-in account:
- GET  /news?category=&q=&cursor=&limit=20   → { items: NewsItem[], next_cursor }
       only status='published', pinned first then posted_at desc
- GET  /news/summary → { categories: {key,count}[], last_updated_at }

Admin — JwtAuthGuard + SuperAdminGuard (same as the admin module):
- GET    /admin/news/status   → { configured:{source:bool, ai:bool, missing:string[]}, provider, running_run_id|null, settings, next_run_at, last_run }
- GET    /admin/news/settings | PATCH /admin/news/settings (recomputes next_run_at)
- GET    /admin/news/sources  | POST {handle, display_name?, notes?} | PATCH /:id | DELETE /:id
- POST   /admin/news/sources/:id/test → fetches latest few tweets, no AI, no save (validates handle)
- POST   /admin/news/run  { source_ids?: string[] } → 202 { run_id } ; 409 if a run is in progress
- GET    /admin/news/runs?limit=20 | GET /admin/news/runs/:id (with log)
- GET    /admin/news/items?status=&category=&source_id=&q=&cursor= (all statuses, includes ai_reason, ai_score)
- PATCH  /admin/news/items/:id { status?, pinned?, ai_category? }

## Scheduler
In-process, no new infra: a 60s tick; claim a due run atomically
(UPDATE news_job_settings SET next_run_at = <next> WHERE id=1 AND enabled AND next_run_at <= now() RETURNING)
+ pg_try_advisory_lock so only one run executes across restarts/instances. Stale
'running' rows older than 1h are marked failed on boot.

## Web
- Portal: new dashboard tab "الأخبار العقارية / Real-estate news" visible to landlord accounts
  (check TENANT_TABS; decide with business spec whether tenants see it).
- Admin: new tab in AdminShell "الأخبار" with sub-sections: Overview/Status + Run now,
  Schedule settings, Accounts, Items moderation, Run history (with log drawer).
- Strings in locales/ar.json + en.json; Dara tokens; RTL-first; mobile responsive.

Specs from the business and design agents land in this folder:
BUSINESS.md, DESIGN.md, seed-accounts.json.

## Backend deviations (dara-api `feat/re-news`, as implemented)

All paths under the global `/api` prefix.

1. **camelCase everywhere.** Responses are Drizzle rows, so keys are camelCase like
   every other endpoint (`postedAt`, `aiScore`, `aiTitleAr`, `nextRunAt`, `runningRunId`,
   `lastRun`, `accountsOk`, `newItems` …). Request bodies are camelCase too
   (`displayName`, `runTime`, `daysOfWeek`, `lookbackHours`, `maxPerAccount`, `minScore`,
   `extraInstructions`, `sourceIds`, `aiCategory`); the snake_case spellings are also accepted.
2. **Page pagination, not cursors** (the shared `listQuerySchema`):
   `GET /news?category=&q=&page=1&pageSize=25` and
   `GET /admin/news/items?status=&category=&sourceId=&runId=&q=&page=&pageSize=`
   → `{ data: T[], page, pageSize, total }` (pageSize max 200, default 25). No `next_cursor`;
   "load more" = `page+1` while `page*pageSize < total`.
3. **Portal item shape** (`GET /news`): `{ id, url, authorHandle, authorName, authorAvatarUrl,
   text, lang, postedAt, media:[{type,url,preview_url}], metrics:{likes,retweets,replies,views},
   category, titleAr, titleEn, summaryAr, summaryEn, tags, pinned }` — the `ai` prefix is dropped
   and score/reason/status are not exposed. Admin items return the full row (`aiCategory`,
   `aiScore`, `aiReason`, `status`, `sourceId`, `runId`, …).
4. `GET /news/summary` → `{ total, categories: [{key,count}] (all 7, fixed order, zeros included),
   lastUpdatedAt }` — `lastUpdatedAt` = finish time of the last success/partial run.
5. `GET /admin/news/status` → `{ configured:{source,ai,missing[]}, provider, model, timezone,
   runningRunId, settings, nextRunAt (null when disabled), lastRun (no log) }`.
6. `POST /admin/news/run` → **202 `{ runId }`**; 409 `"a news run is already in progress"`;
   400 `"news is not configured — missing: …"`; 400 on bad `sourceIds`.
7. `GET /admin/news/runs?limit=20` → bare array, **without `log`**; `GET /admin/news/runs/:id` has `log`
   (`[{at, level:'info'|'warn'|'error', message, handle?}]`).
8. `GET /admin/news/sources` rows include `itemCounts: { published, total }`.
   `POST /admin/news/sources` → 201 row; 409 duplicate handle; 400 bad handle.
   `DELETE /admin/news/sources/:id` → `{ ok: true, id }` (items keep, `sourceId` → null).
9. **Extra endpoint:** `POST /admin/news/sources/test { handle }` tests a handle *before* adding it.
   Both test endpoints return **200** `{ ok, handle, provider, profile:{userId,name,avatarUrl}|null,
   tweets: NormalisedTweet[], skipped, error: {kind,message}|null }` — a failing account is `ok:false`,
   not an HTTP error (400 only when the source provider is not configured).
   `kind` ∈ `rate_limit | not_found | auth | quota | other`.
10. **AI failure** (orchestrator rule + BUSINESS §7 reconciled): fetched posts are stored first as
    `status='hidden'`, `aiRelevant=null`, `aiReason='AI failed: …'`; nothing is published without a
    verdict, and every later run re-sends unjudged items from the last 7 days to the AI. So
    `last_seen_tweet_id` does advance — nothing is lost either way.
11. `PATCH` with no recognised field → 400 `"nothing to update"`. Malformed `:id` → 404.
12. Settings PATCH validation: `runTime` HH:MM; `daysOfWeek` non-empty subset of 0–6 (disable with
    `enabled:false`); `lookbackHours` 1–168; `maxPerAccount` 1–100; `minScore` 0–100;
    `extraInstructions` ≤ 2000 chars (blank → null). Response = settings row with recomputed `nextRunAt`.
13. Scheduled slots that cannot run are recorded as `status:'skipped'` runs with `error` = reason
    (not configured / already running). `NEWS_SCHEDULER_DISABLED=1` switches the tick off.
14. Near-duplicates (same story from several accounts) are dropped before the AI and only counted in
    `duplicates` + logged; AI-flagged duplicates are stored as `rejected` with `aiReason` "duplicate of …".
15. Tables are created by `ensureSchema` on boot from `db/drizzle/0061_re_news.sql` (idempotent) —
    deploy needs no manual SQL.
