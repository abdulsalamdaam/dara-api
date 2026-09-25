# Real-estate news (الأخبار العقارية)

A daily job pulls posts from admin-managed X (Twitter) accounts. Claude filters them
for Saudi real-estate relevance, assigns a category, and writes an Arabic and English
title and summary. Landlords read the curated feed in the portal. Super-admins manage
the accounts, the schedule, the run-now button, run history and moderation.

**Status (26 Sep 2026):** staging only (`master`). Not on `main` or production.
It is inert until the keys below are set: the UI shows a "not configured" banner and
scheduled runs are recorded as `skipped`.

## Files in this folder
| file | what |
|---|---|
| `README.md` | this runbook |
| `CONTRACT.md` | API contract plus the "Backend deviations" that are what actually shipped (camelCase, page/pageSize) |
| `BUSINESS.md` | audience, AI relevance rubric, categories, style guide, defaults, edge cases |
| `DESIGN.md` | screen spec: wireframes, components, states, i18n keys (web repo only) |
| `QA.md` | QA report from staging, bugs fixed, and the fixes after QA (web repo only) |
| `seed-accounts.json` | the 20 verified X accounts seeded on staging |
| `qa/*.png` | QA screenshots: AR/EN × 360/1280 (web repo only) |

## Where things are
- **API** (`dara-api`): `src/modules/news/`, schema `db/src/schema/news.ts`,
  migration `db/drizzle/0061_re_news.sql`. The migration is idempotent and applied on
  every boot by `ensureSchema`, so it needs no manual SQL.
- **Web** (`dara-web`): portal `components/dashboard/NewsView.tsx` + `components/news/*`.
  Admin `components/admin/tabs/NewsTab.tsx` + `components/admin/tabs/news/*`. Hooks are
  in `lib/api-hooks.ts` and `admin-hooks.ts`, strings under `news.*` / `admin.news.*`.
- **Screens:** portal `/dashboard/news?cat=&q=`. Admin
  `/admin?tab=news&section=overview|sources|items|runs|settings`.

## How a run works
1. **Trigger.** A 60 s in-process tick claims a due run atomically with a conditional
   UPDATE on `news_job_settings.next_run_at`, plus a pg advisory lock, so only one run
   happens across restarts and instances. The schedule is `run_time` HH:MM in
   Asia/Riyadh on `days_of_week` (default 07:00 daily). There is no catch-up after
   downtime. **Run now** (`POST /admin/news/run`) returns 202, or 409 while a run is in
   progress.
2. **Fetch** from each enabled account: posts from the last `lookback_hours` (36), since
   `last_seen_tweet_id`, up to `max_per_account` (20). Retweets and replies are excluded.
   If one account fails, the run is marked `partial`. Rate-limit, quota or auth errors
   stop the fetch.
3. **Dedupe** by tweet id, then by near-duplicate text across accounts (Jaccard 0.6).
   Near-duplicates are stored as `hidden` with reason "duplicate of <id>", so an admin
   can still publish them.
4. **AI filter** (Claude, default `claude-sonnet-5`), in batches of 10:
   - **Output:** structured output, validated with zod.
   - **Untrusted text:** posts are wrapped in `<untrusted_posts>` as untrusted data.
   - **Rubric:** in `news.rubric.ts`, copied from BUSINESS.md.
   - **Extra instructions:** the admin's extra instructions are appended.
   - **Publishing:** posts with a score of at least `min_score` (60) are `published`;
     the rest are `rejected`.
   - **Guard:** `news.guard.ts` holds for review any post that tries to steer the AI.
     Such a post is kept `hidden` whatever the verdict.
5. **Failure bounds:**
   - **Truncated batch:** a batch cut off at max_tokens is split in half and each half
     is retried once.
   - **Give-up:** an item is dropped for good after 3 failed reviews (`ai_attempts`).
     It stays `hidden` with a reason.
   - **Spend cap:** at most `NEWS_MAX_AI_ITEMS_PER_RUN` posts (150) go to the AI per run.
     The rest wait for the next run.
   - **AI outage:** the feed keeps showing what it already had.
6. Stale `running` rows, from a process killed mid-run, are marked failed as soon as
   no process holds the lock.

## Env (dara-api)
| var | purpose |
|---|---|
| `X_BEARER_TOKEN` | official X API v2 (paid tier with read access to user timelines) |
| `TWITTERAPI_IO_KEY` | twitterapi.io, a cheaper third-party source. Needs **one** of these two |
| `NEWS_SOURCE_PROVIDER` | `x` / `twitterapiio`. Blank means whichever key is set, X first |
| `ANTHROPIC_API_KEY` | required, the Claude filter |
| `NEWS_AI_MODEL` | default `claude-sonnet-5` |
| `NEWS_MAX_AI_ITEMS_PER_RUN` | default 150, max 2000 |
| `NEWS_SCHEDULER_DISABLED` | `1` = no in-process tick (local dev) |

**To switch it on for staging:**
1. Set the keys on `dara-api-staging` (uuid `rg2fzzvc8wnxd8njnyi1bqxu`) through
   Coolify's own tinker. The REST token on this machine is dead; see DARA-NOTES §1.
2. Redeploy the app.
3. Open Admin → News → Run now and check the run log.

## Admin settings (Admin → News → Schedule)
- **Schedule:** enabled, run time (Riyadh), days of week.
- **Fetch limits:** lookback hours, max posts per account.
- **Filter:** minimum score, extra AI instructions (≤ 2000 chars; these cannot loosen
  the safety rules).

Accounts can be added by `@handle`, `x.com/handle` or a URL, and tested before or after
saving. Each account can also be toggled or deleted.

## Audience
Every signed-in account sees the feed, including tenant-package and demo accounts, so
`"news"` is in `TENANT_TABS`. The admin screens and every `/admin/news/*` route are
super-admin only.

## Known / open
- **Before the first real run:** verify the X API's `since_id` + `start_time` behaviour,
  since the docs say `since_id` wins. Both providers have only been tested against
  recorded payloads, never with live keys.
- **Sidebar position:** "News" sits second. BUSINESS.md suggested placing it above
  Settings; this is a product call.
- **Hydration error:** React hydration error #418 on every `/admin` tab predates this
  feature.
- **Promotion to production:** merge `feat/re-news` to `main`. The migration applies
  itself on boot. Then set the prod env and seed the accounts from `seed-accounts.json`.
