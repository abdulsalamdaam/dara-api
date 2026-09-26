# v3 — retention cleaner + pagination. Addendum to CONTRACT.md / v2.

Owner: "rejected news I don't want them for longer than a day, I don't want to keep it in my db".

## Retention cleaner (dara-api)
- New table `news_seen` (external_id text PK, source_id uuid null, first_seen_at timestamptz,
  verdict text 'rejected'|'duplicate'|...). Idempotent migration 0064+ (check the last number on
  origin/master), via ensureSchema. Backfill from existing news_items on creation.
- Every insert path records the external_id in news_seen too. Dedupe/insert must treat an
  external_id present in news_seen as already seen — a deleted rejected item must NEVER be
  re-inserted, re-judged, or cost an Apify/AI call again. (Also the near-dup/story clustering:
  deleted rows simply stop participating; that's fine.)
- Cleaner deletes, in batches (e.g. 500/stmt, loop), rows of news_items where:
  - status='rejected' AND created_at < now() - rejected_retention_hours (default 24)
    AND NOT manually moderated (moderated_at IS NULL) — an admin's explicit decision is kept;
  - status='hidden' AND ai_reason starts with 'duplicate of' AND older than the same window AND not moderated
    (make this a setting `purge_duplicates` default true);
  - never published or pinned items; never hidden items that are held for review (guard/AI give-up) unless
    older than `hidden_retention_days` (default 14).
- news_seen rows older than `seen_retention_days` (default 30, must be ≥ lookback window + margin; validate)
  are deleted.
- news_job_runs older than `runs_retention_days` (default 90) are deleted (logs are the heavy part).
- Settings (news_job_settings): rejected_retention_hours (1–168), purge_duplicates bool,
  hidden_retention_days (1–90), runs_retention_days (7–365), seen_retention_days (7–180);
  plus last_cleanup_at, last_cleanup_stats jsonb.
- When it runs: at the end of every job run (logged in that run's log), plus the existing 60 s tick
  runs it at most once per hour (atomic claim on last_cleanup_at, same advisory-lock discipline, never
  concurrently with a job run).
- Endpoints (super-admin): POST /admin/news/cleanup { dryRun?: boolean } → { deleted: {rejected, duplicates,
  hidden, seen, runs}, dryRun }. Status includes lastCleanupAt + stats + counts per status.
- Rescore (v2.5) must keep working on what remains; document that rejected items older than the
  retention window can no longer be re-scored.

## Pagination
API: every admin list (items, sources, runs) and the portal feed return { data, total, page, pageSize }
(keep existing shapes where already so); pageSize max 100. Add GET /admin/news/items/counts →
{ published, rejected, hidden, pinned } honouring the same filters except status (for tab badges).
Stable ordering with a tiebreaker (id) so pages never duplicate/skip.

Web:
- Admin Items: status tabs with counts, a proper paginator (prev/next, page numbers with ellipsis,
  page-size 20/50/100, "showing X–Y of Z"), page kept in the URL (?page=&size=), resets to 1 when filters change.
- Admin Runs and Sources: same paginator.
- Portal feed: keep "load more" but show "X of Y" and handle the end; no duplicates between pages.
- Settings: a "Data retention" card (the 5 settings, AR+EN), last cleanup time + what it removed,
  "Clean now" button with a preview (dryRun) confirm dialog.
- Reusable Paginator component (check admin/ui.tsx and components/ for an existing one first).

## v3 backend deviations (dara-api `feat/re-news`, as implemented)

All paths are under `/api`, super-admin only for `/admin/news/*`. Keys are camelCase (snake_case accepted in bodies).

1. **Settings** (`GET/PATCH /admin/news/settings`, and `status.settings`) gain:
   `rejectedRetentionHours` (1–168, default 24), `purgeDuplicates` (bool, true),
   `hiddenRetentionDays` (1–90, 14), `runsRetentionDays` (7–365, 90), `seenRetentionDays` (7–180, 30),
   plus read-only `lastCleanupAt` and `lastCleanupStats`.
   - 400 messages: `<name> must be a whole number from <min> to <max>`, `purgeDuplicates must be true or false`.
   - Cross-field 400 (checked on the merged row, so a `lookbackHours` change can trigger it too):
     `seenRetentionDays must cover the lookback window plus 2 days — with lookbackHours N it must be at least M`
     (M = max(7, ceil((lookbackHours + 48) / 24)); lookback ≤ 120 h → 7 days, 168 h → 9 days).
2. **`lastCleanupStats`** = `{ trigger: 'hourly'|'run'|'manual', deleted: { rejected, duplicates, hidden, seen, runs },
   ms, runId: string|null, error: string|null }` (null before the first cleanup).
3. **`POST /admin/news/cleanup { dryRun?: boolean }`** → **200** `{ dryRun, deleted: { rejected, duplicates, hidden, seen, runs },
   settings: { rejectedRetentionHours, purgeDuplicates, hiddenRetentionDays, runsRetentionDays, seenRetentionDays }, at, ms }`.
   400 `dryRun must be true or false`; **409** `a news run is in progress — try again when it finishes` (real cleanup only;
   a dry run takes no lock and writes nothing, not even lastCleanupAt).
4. **`GET /admin/news/status`** adds `lastCleanupAt`, `lastCleanupStats`, `itemCounts: { published, rejected, hidden, pinned, total }`
   (whole table, no filters).
5. **`GET /admin/news/items/counts?category=&sourceId=&runId=&q=`** → `{ published, rejected, hidden, pinned, total }`
   (`status` is ignored; `pinned` counts pinned items of any status; `total` = all statuses).
6. **Pagination.** Envelope `{ data, page, pageSize, total }`; `pageSize` above 100 is **clamped** to 100 (not a 400) and the
   response's `pageSize` is the one applied. Bad `page`/`pageSize` → 400 `invalid page or pageSize`.
   - `GET /admin/news/items` and `GET /news`: as before (envelope always). Order: items `postedAt desc nulls last, id desc`;
     feed `pinned desc, postedAt desc nulls last, id desc`.
   - `GET /admin/news/runs` and `GET /admin/news/sources`: **opt-in** — with `page` or `pageSize` (or `paginated=1`) you get the
     envelope; without, the old bare array (`runs?limit=` still works). Runs order `startedAt desc, id desc`; sources
     `kind, name, id`. Source rows keep `itemCounts`.
7. **What the cleaner deletes** (per run of it):
   - `rejected` older than `rejectedRetentionHours`;
   - `hidden` + `aiReason` "duplicate of …" older than the same window when `purgeDuplicates`; with `purgeDuplicates=false`
     they follow the hidden window instead (counted under `hidden`);
   - other `hidden` (guard-held, AI gave up, not judged) older than `hiddenRetentionDays` — but an item still waiting for an
     AI retry (not judged, < 3 attempts) is always kept for the 7-day retry window;
   - never published, pinned, or moderated (`moderatedAt` set) items; AI-flagged duplicates stored as `rejected` count as `rejected`;
   - `news_seen` ids whose item is gone, `seenRetentionDays` after the purge; `news_job_runs` older than `runsRetentionDays`
     (never a `running` row).
8. **When:** at the end of every job run (one log line `cleanup: deleted …` in that run's log; a cleanup failure is a warn line
   and never changes the run's status), from the 60 s tick at most once an hour (also while the job is disabled; skipped while
   a run holds the lock), and by hand. Not after a re-score.
9. **Run log:** a purged item fetched again is logged as `N seen before and removed by the cleaner — skipped` and is not
   counted in `newItems` or `duplicates`.
10. **Re-score** works only on what is still stored: rejected items/duplicates older than the retention window are gone and
    cannot be re-scored (they are also never fetched again).
11. `news_seen` backfill runs on **every boot** (idempotent `ON CONFLICT DO NOTHING`), not only on creation — covers items
    stored by an old container during a rolling deploy. The table has an extra `purged_at` column.
12. Migration `db/drizzle/0064_re_news_retention.sql`, applied by `ensureSchema` on boot.
13. **(QA fix, dara-api `f999c0d`)** A scheduled slot that finds the run lock held by a cleanup or a re-score (no `running`
    row) retries every 2 s for up to 30 s instead of recording "skipped — another news run was already in progress";
    a real run in progress still skips it at once. And any `pageSize` above 100 is clamped (before the fix, 101–200 were
    clamped but anything above 200 was a 400 from the shared schema).
