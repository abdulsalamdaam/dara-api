# Finance v2 (beta): Design

Status: **draft for approval, revision 2 (after the accounting and engineering reviews). Nothing below is built.** This document gates Phase 2. The brief asks for a stop here: the account holder reviews this file (and §13, the accountant questions) before any code is written. Appendix A records every review finding and what was done with it.

- Branch `feat/finance-v2` in `dara-api` and `dara-web`, based on `origin/master` (staging).
- The design builds on `docs/finance-v2/DISCOVERY.md`, cited as **D§n**. Code citations are `file:line` in `dara-api` unless they are marked `web:`, which means `dara-web/src/`.
- **Public repo.** This file contains no personal data. Test-account ids, credentials and synthetic identity values live only in the private write-up outside both repos.
- Author's stance: a senior engineer who is also a Saudi-qualified accountant (SOCPA; IFRS for SMEs as endorsed by SOCPA; KSA VAT Law and Implementing Regulations; ZATCA e-invoicing). Where the design takes an accounting position, it says so and gives the reason. Every position the accountant might reasonably overturn is listed in §13 with the default used meanwhile.

---

## 0. Decisions at a glance

| # | Decision | Where |
|---|---|---|
| 1 | The flag lives in a **new table `finance_settings`**, keyed by the account's scope user id (`scopeId()`). A missing row means off. The flag is resolved **once per request, before any transaction opens**, and a read error uses the last cached value (stale-if-error). A second marker, `ledger_started_at`, holds automatic posting until the first real backfill. | §1.1, §1.2 |
| 2 | **Flag-off equality is structural.** No existing table gets a column; v2 data lives in 1:1 side tables. No role preset gets a permission key. Existing handlers only gain early `if (v2) return v2Impl()` forks and void hook calls. A CI script rejects any *removed* line in the protected legacy files, except hunks listed in a reviewed allowlist. | §1.4 |
| 3 | Money is stored as **`numeric(14,2)`** and computed in **integer halalas** inside the ledger engine. | §2.1 |
| 4 | Each journal entry is balanced by a **deferred constraint trigger**. Posted rows are made immutable by triggers. The idempotency key is a unique index on `(user_id, source_type, source_id, event)`. Periods are closed at DB level. | §2.4 |
| 5 | **A tenant charge is booked at the earlier of the document date and the installment due date; rent revenue is then released straight-line over the period the installment covers** (principal rent, through 2131 Unearned rent). **VAT is booked at the earliest tax point, including advance payments.** Every tenant money flow goes through AR. This removes the −96,000 statement (E3) by construction. | §4.1 |
| 6 | **Two modes.** *Manager* mode resolves per landlord: the account-holder landlord is principal and every other landlord is agent (collected rent is a landlord payable). *Owner* mode is offered only when every landlord with active contracts is the account holder's own legal identity. The default for company accounts is Manager. | §4.2 |
| 7 | Posting goes through an **outbox**. The outbox row is inserted inside the source transaction when one exists, otherwise immediately after the last write. A per-account serial worker posts the entries and **reads charge and coverage state at post time**. A failure never reaches the user action. Backfill doubles as the repair sweep. | §5 |
| 8 | Termination **"mark as paid" is refused under v2** (HTTP 409). It is replaced by three honest options: record the remaining collections, write off, or cancel. Every open installment must get a disposition, and nothing is charged after the contract ends. | §4.6, §9 E7 |
| 9 | **The approve route is not forked for tax invoices and notes**, so the ZATCA submission code keeps a single copy. Flag-on accounts get two added lines there (v2 commission, ledger emit); only the two non-ZATCA kinds (`rent_receipt`, `agency_fee`) have a v2 approve. | §10.2 |
| 10 | Proposed exceptions (fixes that apply with the flag off): **EX-1** the export **HTTP 400** (`pageSize=1000`), **EX-2** the **ZATCA action-cell wrap** (E10), **EX-3** the **scope check on expense and payout ids**, and **EX-4** a **guard that keeps the two v2 document kinds away from ZATCA and the legacy approve path**. Everything else is flag-gated. | §9 |

---

## 1. Flag mechanics

### 1.1 Where `finance_v2` lives

**Table `finance_settings`**, one row per customer account, primary key `account_user_id` = `scopeId(user)` (`src/common/scope.ts:9-11`).

Why a new table, and not something else:

| Option | Verdict |
|---|---|
| `companies` | Rejected. Individual accounts have no `companies` row (`auth.service.ts:501-508`, D§2.2). The admin console's "company id" is really a `users.id` (web:`lib/admin-hooks.ts:61-66`). |
| `users` column | Rejected. `users` is declared identity-only (`db/src/schema/users.ts:5-8`). More importantly, **adding a column to `users` changes every `select()` of `users`**, and some of those are serialised to the web. That breaks the flag-off guarantee (§1.4). |
| `app_settings` | Rejected. It is global by design (`appSettings.ts:3-19`). |
| **`finance_settings`** | Chosen. It is keyed like every finance row (`user_id` = scope), so reading it is a single primary-key lookup on a value every request already has. It also has room for the rest of the per-account settings (mode, default bank, fiscal year, VAT filing frequency). A missing row means off, so the default costs no backfill. |

The columns are listed in §2.3.1. The flag column is `finance_v2_enabled boolean not null default false`.

### 1.2 How the API reads it

- **`FinanceFlagService.isOn(scopeUserId): Promise<boolean>`** in the new module `src/modules/finance-v2/`.
  - It reads through **the pool, never the caller's transaction**. Inside a transaction, a failing query (a missing table, say) aborts the whole transaction. Reading via `this.db` rather than `tx` means a broken flag table can never abort a legacy write.
  - It keeps an in-process cache (`Map<scope, {on, mode, ledgerStarted, at}>`) with a 15-second TTL. The admin toggle invalidates the cache entry in the same process. There is one API container per environment (DARA-NOTES §1), so a 15-second window is the worst case.
  - **Errors are stale-if-error, not blanket fail-closed.** On a read error (a missing table, or the pool's 10 s `connectionTimeoutMillis`, `db/src/index.ts:45`) it returns the **last cached value, however old**, and logs once per minute to `app_logs`. Only a scope never seen as on since process start reads `false`. The reason: a blanket `false` would silently put a flag-on account back on legacy write paths (`mode:"paid"` succeeds, the Ejar import sets `paid`, enqueues are skipped) during a pool stall. v2-only routes (`/api/finance/v2/*`) return **503** when the read fails and there is no cached value. A missing table (the `0066` block failed at boot) still reads off, because no scope was ever seen as on in that process.
- **Resolved once per request, at handler entry, before any transaction opens.** The fork line and every hook receive the resolved value (`ctx.fv2`) instead of calling `isOn` again. This matters for `addCollection`, which holds a transaction and an advisory lock (`payments.module.ts:524-526`) and would otherwise ask the 20-connection pool (`db/src/index.ts:17,42`) for a second connection while holding the first; a burst of concurrent collections could then time out and flip the account to legacy mid-request.
- **`FinanceV2Guard`** protects every `/api/finance/v2/*` route except `/status`. It is `JwtAuthGuard` followed by `isOn(scopeId(user))`. When the flag is off it returns **404**, not 403, so the beta surface does not exist for other accounts.
- **Capabilities** are derived from existing permission keys (§10.1). No new key enters `PERMISSIONS` or the presets. Presets are rewritten on every boot (`bootstrap.ts:577-613`), so a new key would change `GET /api/auth/me/permissions` (`auth.controller.ts:120`) and `GET /admin/permissions/catalog` (`admin.module.ts:924`) for every account.

### 1.3 How the web reads it

- **New endpoint `GET /api/finance/v2/status`** (JWT only). It returns `{ enabled, mode, capabilities, betaLabel }`, or `{ enabled:false }` when the flag is off or the table is missing.
  - A separate endpoint keeps `GET /api/me/package` and `GET /api/auth/me` byte-identical (D§3.9).
  - With the flag off, the portal makes **one extra GET**. No existing response changes.
- **`useFinanceV2()`** in web:`lib/api-hooks.ts` is a React Query hook with a 5-minute `staleTime`.
  - It **returns `enabled:false` while loading and on error**. This is deliberately the opposite of `has()`, which returns `true` while loading (web:`hooks/use-permission.tsx:15`).
  - Every v2 surface renders only when `enabled === true`.
- **Every v2 component is loaded lazily** with `next/dynamic`. The legacy component tree is imported and rendered unchanged when the flag is off. The pattern is `financeV2 ? <V2/> : <Legacy/>`, and the legacy file itself is not edited.
- **Beta badge.** A small pill, "المالية v2 (تجريبي) · Finance v2 (Beta)", sits in the shell header at web:`_legacy/DashboardPage.tsx:578-582` (D§3.9), styled `bg-sky/15 text-cobalt border-cool-gray`. It renders only when enabled. Hovering it shows the accounting mode.

### 1.4 "Flag off = byte-identical responses", guaranteed structurally

Being careful is not enough. These mechanisms together make a flag-off difference either impossible or caught by CI:

1. **No column is added to any existing table, in SQL or in Drizzle.**
   - Drizzle `select()` enumerates declared columns, and several endpoints the UI reads return whole rows:
     - `reports.module.ts:322` (expenses)
     - `:423` (payouts)
     - `payments.module.ts:313` (collections)
     - `billing.module.ts:289,729` (documents)
   - A new nullable column would add `"x": null` to those JSON bodies. All v2 attributes therefore live in **1:1 side tables** keyed by the source id (§2.3). This is stricter than the brief's "additive" rule, and it is what makes the rule safe.
   - CI check: `git diff origin/master -- db/src/schema/<existing>.ts` must be empty for every pre-existing schema file.
2. **No new permission key and no preset change.** Capabilities are derived (§10.1).
3. **Fork at the edge.** Where v2 changes the behaviour of an existing route (E1, E4, E7, the receipt-voucher transaction, terminate and so on):
   - The handler gains exactly one inserted block at its top: `const fv2 = await this.fv2.resolve(scope); if (fv2) return this.v2.<same name>(...)` (resolved once, before any transaction; §1.2).
   - The v2 implementation lives in `src/modules/finance-v2/overrides/`, and **the legacy body is not modified**.
   - The cost is duplicated code during the beta. At general availability, the legacy branch is deleted.
4. **Posting hooks are void and cannot throw.**
   - `ledger.emit(ctx, event)` returns `Promise<void>` and is never merged into a response.
   - Its first statement is `if (!ctx.fv2) return;`, using the value resolved at handler entry.
   - Inside a caller's transaction it runs in a savepoint (`tx.transaction(...)` nests as `SAVEPOINT`) wrapped in `try/catch`, so its failure cannot roll back the caller.
5. **CI "additive diff" script** `scripts/finance-v2-additive-diff.ts`, run in `ci.yml`:
   - For every file under `src/modules/{billing,payments,contracts,reports,dashboard,ejar,import,admin,payment-confirmations,tenant-portal,mobile-landlord}` and `src/common/{payment-status,scope,permissions}.ts`, the unified diff against `origin/master` may contain **added lines only**.
   - Every added hunk must contain the marker `// finance-v2:`.
   - Any `-` line fails the build **unless its hunk is listed in `scripts/finance-v2-removed-lines.allow`**. On web, the same script covers `components/dashboard/**` and `lib/**`.
   - **Why an allowlist.** Some changes cannot be made with added lines only: EX-1 (web:`lib/report-export.ts:375,380`), EX-2 (web:`ZatcaIntegrationView.tsx:188`), the web `financeV2 ? <V2/> : <Legacy/>` swaps at their mount sites, and Nest module wiring such as `@Module({ imports: [...] })` (`billing.module.ts:2099`). Each allowlist entry is `file`, a hash of the removed hunk, and a one-line reason. The list is printed at the merge gate for approval, next to the exceptions.
   - The new Drizzle file `db/src/schema/financeV2.ts` is imported directly by the v2 module and **not** added to the barrel `db/src/schema/index.ts`, so the "no existing schema file changes" check (point 1) stays literally true.
6. **Snapshot proof (Phase 5).**
   - Record the 39 GET endpoints the UI calls (D§7) for a flag-off account, on `master` and on the branch, against the same database copy. The diff must be empty.
   - Record the same after a **flag-on account in the same database** has run the full v2 journey. This shows that nothing leaks across accounts.
7. **DB objects are confined to new tables.**
   - Triggers, functions and indexes attach only to tables created by `0066`.
   - `0066` alters nothing that exists; the file is grep-checked in CI for `alter table` against a list of existing table names.
8. **The migration fails closed.** If `0066` fails at boot, the flag reads off (point 1.2), so the account behaves as `master`.

### 1.5 Admin toggle and audit log

- **API.**
  - `PATCH /api/admin/finance-v2/:accountUserId` (SuperAdminGuard, like `admin.module.ts:110`).
  - Body: `{ enabled: boolean, accountingMode?: 'owner'|'manager', reason: string }`. The reason is required and between 5 and 500 characters.
  - The target must satisfy `isCustomerAccount()` (`permissions.ts:279-282`); otherwise the call returns 400.
- **One transaction**, which does the following:
  1. Upsert `finance_settings`, setting `enabled_at`, `enabled_by` and `accounting_mode`. The mode is required on the first enable, and the UI preselects a default (§4.2).
  2. Insert a `finance_settings_events` row with `{field, old, new, reason, actor}` for the full history.
  3. Insert **`audit_logs`** with:
     - `owner_user_id = accountUserId` (the target account, not the admin's scope; see D§2.3 on the interceptor)
     - `actor_user_id = admin`, `action='update'`, `entity='finance_v2'`, `entity_id = accountUserId`
     - `method='PATCH'`, `path='/admin/finance-v2/<id>'`

     The row therefore appears in that account's Settings → activity log. That is intended: the account holder can see when the beta was switched on.
  4. **First enable only**, and idempotent (Owner mode is refused here with 400 when the Owner-mode precondition in §4.2 fails):
     - seed the chart of accounts (§3)
     - create the current and previous fiscal-year monthly periods, all open
     - create two `bank_accounts`: "الصندوق الرئيسي" (cash, linked to 1111) and "الحساب البنكي الرئيسي" (bank, linked to 1113), both `is_default`
- **After the commit**, invalidate the flag cache and return `{ settings, backfill: { suggested: true } }`. The admin UI then offers "Dry-run backfill" (§6).
- **Two switches, not one.** `finance_v2_enabled` turns on the UI, the forks and the refusals, and the emitter starts enqueueing. It does **not** start posting. `finance_settings.ledger_started_at` is set by the first successful **non-dry-run** backfill (§6); until then the worker and the recognizer skip the account, reports show a "Ledger not started: run the backfill" banner instead of figures, and the enqueued live events wait in the outbox (their keys are the backfill's keys, so the backfill finds them as `alreadyQueued` and posts them in order). This keeps the dry-run reviewable before a single live entry exists. A dry-run is also allowed **while the flag is off**; it is read-only apart from its `finance_backfill_runs` row.
- **Audit.** The manual `audit_logs` row above is written because the interceptor audits only PATCH, PUT and DELETE (`audit.module.ts:32`). This PATCH is therefore audited twice: once by the interceptor under the admin's own scope, and once by the manual row under the target account. That is intentional and harmless.
- **Turning the flag off**
  - It keeps every v2 row. Hooks stop, and the ledger falls behind.
  - Turning it back on shows a banner saying "Ledger behind by N events; run catch-up backfill". The idempotency keys make catch-up safe (§6.6).
- **Web.**
  - A "Finance v2 (Beta)" column in web:`components/admin/tabs/CompaniesTab.tsx`, modelled on the active/suspended toggle at `:97-99,151-160`.
  - A confirmation dialog asks for the mode and the reason.
  - The Customer-360 drawer shows the event history.

### 1.6 Seeding the side-by-side beta account (a staging test account)

The brief asks for a second staging account with the same data as the existing accountant test account, and `finance_v2` **on** for that account only. **Everything that identifies it lives in the private write-up outside both repos** (`STAGING-ACCOUNTANT-BETA-ACCOUNT.md`, next to the existing private doc): the login, how to sign in, the SQL, every email alias and phone, and every created id. `dara-api` is public, so this file records only the procedure's shape. Values that would identify the account or let someone sign in to it are written here as `<private>`.

**When:**
- Seeding writes only ordinary data through master code paths, so it is inert while the flag table does not exist.
- Seed it on staging at the **start of Phase 6**. The Phase 6 preview database is a copy of staging, so it contains the account too.
- The flag is switched on for this account through the admin toggle **after** the merge gate (Phase 7), followed by a dry-run and then a real backfill. Backfilling a history created by master code is itself the best acceptance test of §6.

**Rules** (hard rules 5 and 6):
- Every contact email is an alias of the account holder's own mailbox (`<private>`). Every phone is a dummy in a range distinct from the first account's.
- Every VAT, CR and ID number is synthetic, passes its check digit where one applies, and differs from the first account's.
- None of these values, nor the login or sign-in method, is written into `dara-api`.
- Seeding never calls these, because they notify:
  - `PATCH /payment-confirmations/:id` (it pushes to the tenant; D§1.2.2)
  - any registration approval
  - any "send by email"
- The seeding script asserts, before every call, that the base URL is the staging API host, and aborts otherwise.

**Procedure (details in the private doc):**
1. **SQL** on the **staging** DB container only, after confirming the container's `DATABASE_URL` (DARA-NOTES §1): the user, its company, a paid subscription and the account-holder landlord row (`is_account_holder` is server-owned, so it is set here and never through the API). The column list is copied from the SQL recorded for the first account.
2. **Staging API**, signed in as the beta account (`<private>`): a second landlord (individual, not VAT-registered, a 5% management fee on the landlord and **not** on the property, which reproduces E1); three properties with deeds, ten units, seven tenants; seven contracts via `POST /contracts` with the first account's terms, dates, deposits and advance; the invoices via `POST /simple-invoices` and `/approve` (the commercial ones through ZATCA **sandbox** onboarding of the company landlord); one credit note; receipt vouchers for the villa rent and deposit vouchers; and collections at the original dates, including the partial payment on the café's August installment. The script lives outside both repos (`~/Desktop/dara-journey-maps/src/`), reuses the existing login helper, and records every created id in the private doc.
3. **Parity check.** A read-only script compares the key totals of the two accounts through `GET /api/reports/accounting` and the `GET /api/payments` stats. They must match the expected table in the private doc before the flag is flipped.
4. **After the merge gate:** admin toggle **on** with mode `manager` and a reason; `backfill --dry-run`, reviewed by the account holder; `backfill` (this sets `ledger_started_at`, §1.5); the reconciliation report must show zero unexplained differences.

The first accountant test account is never touched.

---

## 2. Schema

### 2.1 Money representation: `numeric(14,2)` in the DB, integer halalas in the engine

**Storage** is `numeric(14,2)`, which holds up to 999,999,999,999.99 SAR.

- **It matches the existing money columns.** `simple_invoices.subtotal/total` are already (14,2) (`simpleInvoices.ts:34-35`), and the others are (12,2) (D§1.1). Reconciliation queries then join and compare sub-ledger and ledger values with no scaling. A factor-of-100 mismatch is exactly the kind of silent error a reconciliation report exists to catch, not to introduce.
- **SQL `sum()` over numeric is exact.** The balance trigger compares `sum(debit) = sum(credit)` exactly, and the report SQL is readable by an accountant.
- **Drizzle returns numeric as a string**, so no float ever enters by accident on the read path.

**Computation** inside `finance-v2` uses **integer halalas** (`number`, asserted `Number.isSafeInteger`; the range is 9×10¹³ SAR).

- `toHalalas(s: string)` parses `/^-?\d+(\.\d{1,2})?$/` by splitting the string, with no float multiplication.
- Numbers from jsonb (`simple_invoices.items`, D§1.1) go through `String(n)`. More than two decimals means a round-half-up at the third decimal on the string, and the event is flagged `jsonb_precision`.
- `fromHalalas(n)` produces the `'1234.56'` string written to the DB.
- **VAT split of a gross amount G at rate r (15%)**, both done in integers:
  - `net = floor((2·G·100 + (100+r)) / (2·(100+r)))`, which is round-half-up of G·100/(100+r)
  - `vat = G − net`

  Documents are never re-split. Their own `subtotal` and `total` are used (VAT = total − subtotal), so the ledger equals the printed document to the halala.
- **Parity with the legacy split.** Legacy code splits with `round2(gross/1.15)` in floating point (`payment-confirmations.module.ts:448`, `billing.module.ts:1070`). An exhaustive test runs every gross value from 0.01 to 100,000.00 through both. If any value differs, the engine's split is changed to reproduce the legacy result for that value (still computed in integers), so a due-date charge and the invoice later issued for the same installment never differ by a halala. Under the reverse-and-replace rule (§4.1) a covered due-date charge is reversed anyway, so a mismatch could not persist in the ledger; the test removes the noise from R5 and from the dry-run.

### 2.2 Migration mechanics (DARA-NOTES §7, D§2.1)

1. **One file, `db/drizzle/0066_finance_v2.sql`.**
   - It is idempotent: `create table if not exists`, `create index if not exists`, `create or replace function`, `drop trigger if exists … ; create trigger …`, and `insert … on conflict do nothing`.
   - It gets a `meta/_journal.json` entry, as the convention requires (CLAUDE.md:45-49).
   - Tier-2 tables go in `0067_finance_v2_tier2.sql`, so tier 1 ships without them.
2. **`bootstrap.ts` runs the file** inside its own `try { … } catch { log.warn }` block, placed after the news block (`bootstrap.ts:564-575`) and before the role refresh. The pattern is identical: `findSqlFile(join("drizzle", f))`. The file lives in `db/drizzle`, which the Dockerfile copies (`Dockerfile:49-51`).
3. **Drizzle TS definitions** for the new tables go in a new file, `db/src/schema/financeV2.ts`, imported directly by the v2 module and **not** exported from the barrel (§1.4 point 5). They are never pushed.
   - **Name-collision guard.** The live DB was built with `push`, so the repo cannot rule out a pre-existing table with one of the new generic names (`accounts`, `journal_entries`, `bank_accounts`, and so on), in which case `create table if not exists` would silently do nothing. `0066` therefore starts with a `do $$ … $$` block that, for every table it creates, checks that either the table is absent or its columns match the expected set, and raises otherwise. A raise fails the block, and the flag then reads off (§1.4 point 8). **Never run `pnpm db:push`** (it would drop 22 indexes; D§2.1). No existing schema file is edited (§1.4).
4. **Deploy order.** The API goes first. Web v2 surfaces tolerate a 404 from `/finance/v2/status` and read it as off.
5. **Test databases** use one helper, `src/modules/finance-v2/__tests__/with-db.ts` (under `src/`, so `pnpm test`'s glob `src/**/*.spec.ts`, `package.json:12`, picks the specs up). It runs against `FV2_TEST_DATABASE_URL` only, the same pattern as the news retention suite, which already has a throwaway Postgres service in CI (`.github/workflows/ci.yml:27-39`). The fresh-DB bootstrap is broken at `db/data.sql:36` and `init.sql` predates columns such as `invoices.owner_id` (`bootstrap.ts:149-152`; D§4.1), so the harness builds the legacy tables from a committed **schema-only dump** (DDL, no rows) and then applies `0066`. See §11.3.

### 2.3 Tables

Conventions for every new table:

- `user_id integer not null` holds the **account scope**.
  - It has **no FK to `users`**, so an admin hard delete (`admin.module.ts:537-543,929-935`) cannot cascade into immutable rows.
  - Account deletion is handled by the explicit purge in §2.4.5.
- Dimension and source ids are plain integers **without FKs**, so posted history survives hard deletes on rebuild, terminate and DELETE (D§2.4, D§5.5).
- Timestamps are `timestamptz`. Business dates are `date`, always Asia/Riyadh.
- Enumerations are `text` with a `check`, not a Postgres enum, so values can be added later without a type change.

#### 2.3.1 `finance_settings` (the flag and per-account settings)

```sql
create table if not exists finance_settings (
  account_user_id        integer primary key,            -- = scopeId(); no FK (see conventions)
  finance_v2_enabled     boolean not null default false,
  accounting_mode        text check (accounting_mode in ('owner','manager')),
  fiscal_year_start_month smallint not null default 1 check (fiscal_year_start_month between 1 and 12),
  vat_filing_frequency   text not null default 'quarterly' check (vat_filing_frequency in ('monthly','quarterly')),
  default_bank_account_id integer,                       -- -> bank_accounts.id
  default_cash_account_id integer,
  agency_collections_to_trust boolean not null default false, -- manager: agent collections debit the trust bank (1114)
  commission_basis       text not null default 'billed' check (commission_basis in ('billed','collected')),
  deposit_forfeit_vat    text not null default 'O' check (deposit_forfeit_vat in ('O','S','E')),
  ledger_go_live_date    date,                            -- cutover date if backfill mode = cutover
  ledger_started_at      timestamptz,                     -- set by the first real backfill; worker and recognizer hold until then (§1.5)
  defer_rent_straight_line boolean not null default true, -- principal rent via 2131, released monthly (§4.1, Q23)
  input_vat_method       text not null default 'direct_plus_ratio' check (input_vat_method in ('direct_plus_ratio','direct_only')), -- §8.2(b), Q25
  enabled_at timestamptz, enabled_by integer,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists finance_settings_events (
  id bigserial primary key, account_user_id integer not null, actor_user_id integer not null,
  field text not null, old_value jsonb, new_value jsonb, reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists finance_settings_events_acct_idx on finance_settings_events (account_user_id, created_at desc);
```

#### 2.3.2 `accounts` (the chart of accounts)

```sql
create table if not exists accounts (
  id serial primary key,
  user_id integer not null,
  code text not null check (code ~ '^[0-9]{4,8}$'),
  name_ar text not null, name_en text not null,
  type text not null check (type in ('asset','liability','equity','revenue','expense')),
  normal_balance text not null check (normal_balance in ('debit','credit')),  -- contra accounts flip it
  parent_id integer references accounts(id),
  system_key text,                       -- stable handle the posting engine resolves; null for user accounts
  is_group boolean not null default false,   -- groups cannot take postings
  is_active boolean not null default true,
  is_template boolean not null default false, -- seeded from the template
  bank_account_id integer,               -- set for bank/cash leaf accounts created from bank_accounts
  description text,
  created_by integer, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id, code),
  unique (id, user_id)                   -- target of the composite FK from journal_lines
);
create unique index if not exists accounts_system_key_uq on accounts (user_id, system_key) where system_key is not null;
create index if not exists accounts_parent_idx on accounts (user_id, parent_id);
```

Guards, enforced by triggers because the rules must hold for any writer:

- **`accounts_guard` (BEFORE INSERT OR UPDATE).**
  - It refuses to change `type`, `normal_balance`, `system_key` or `user_id` once any `journal_lines` row references the account.
  - It refuses to set `is_group = true` on an account that has postings, **or on any account with a `system_key`** (the engine must never resolve a group).
  - It refuses a new child whose parent has a `system_key`. Sub-accounts go under group accounts only (for example a new bank leaf under the 1110 group); a user who wants to split tenant receivables adds a sibling, not a child of 1121.
  - It refuses a `parent_id` that belongs to another `user_id`, has a different `type`, is not a group, or would create a cycle (a recursive CTE walk).
- **`accounts_no_delete` (BEFORE DELETE).** It refuses when the account has postings or `is_template` is true, or when a `bank_accounts` row links to it. The composite FK from `journal_lines` also restricts the delete.
- **Deactivation.** It is allowed at any time. Posting to an inactive account is refused by `journal_lines_account_ok` (§2.4.3). Deactivating a system-key account is refused in code while the engine still resolves it.

#### 2.3.3 `fiscal_periods`

```sql
create table if not exists fiscal_periods (
  id serial primary key, user_id integer not null,
  fiscal_year integer not null, period_no smallint not null check (period_no between 1 and 12),
  starts_on date not null, ends_on date not null check (ends_on >= starts_on),
  status text not null default 'open' check (status in ('open','closed','locked')),
  vat_locked_at timestamptz,          -- set when a VAT return covering this month is locked (§7.5); refuses VAT-bearing lines only
  closed_at timestamptz, closed_by integer, reopened_at timestamptz, reopened_by integer, reopen_reason text,
  unique (user_id, fiscal_year, period_no), unique (user_id, starts_on), unique (id, user_id)
);
```

- `closed` can be reopened by a holder of the settings capability, and the reopen is audited. A `closed` period still accepts **manual adjustment journals** (and the year-end closing entry) posted by a holder of the settings capability, so audit adjustments dated inside a closed month remain possible. Automatic postings into a closed period are routed late (§4.7).
- `locked` is terminal (an audited year, or a manual lock). It refuses everything.
- `vat_locked_at` is separate from `status`. A filed VAT return sets it; it refuses (or, for automatic postings, routes late) only lines that carry `tax_role` or `vat_category`. Non-VAT adjustments stay possible in that month.
- Monthly periods are created on demand by `ensurePeriod(user, date)`, which is `insert … on conflict (user_id, fiscal_year, period_no) do nothing` followed by a select, so two concurrent first postings into a month cannot collide.
- `fiscal_year_start_month` cannot be changed once any period exists (400).

#### 2.3.4 `journal_entries` and `journal_lines` (the general ledger)

```sql
create table if not exists journal_entries (
  id bigserial primary key,
  user_id integer not null,
  entry_no text not null,                         -- JV-2026-000123, per account per fiscal year
  entry_date date not null,                       -- posting (effective) date, Riyadh
  original_date date not null,                    -- event date; <> entry_date only when is_late
  period_id integer not null,
  is_late boolean not null default false,
  origin text not null check (origin in ('auto','backfill','manual','opening','closing','reversal')),
  source_type text not null,                      -- 'simple_invoice' | 'payment' | 'payment_collection' | 'contract' | 'expense'
                                                  -- | 'landlord_payout' | 'deposit_refund' | 'tenant_credit_action'
                                                  -- | 'write_off' | 'manual_journal' | 'opening_balance'
  source_id bigint not null,
  event text not null,                            -- 'confirmed' | 'charge' | 'collected' | 'deleted' | 'reversal:<event>' ...
  memo text,
  status text not null default 'posted' check (status in ('posted','reversed')),
  reversal_of bigint references journal_entries(id),
  reversed_by bigint references journal_entries(id),
  reversed_at timestamptz,
  total numeric(14,2) not null check (total > 0),  -- = sum(debit) = sum(credit), verified by trigger
  payload jsonb not null default '{}'::jsonb,     -- frozen facts the rule used (amounts, dims, flags)
  warnings text[] not null default '{}',          -- e.g. {'vat_without_tax_invoice','dimension_ambiguous'}
  created_by integer,                              -- null = system
  posted_at timestamptz not null default now(),
  foreign key (period_id, user_id) references fiscal_periods (id, user_id),
  unique (id, user_id)
);
create unique index if not exists journal_entries_idem_uq  on journal_entries (user_id, source_type, source_id, event);
create unique index if not exists journal_entries_no_uq    on journal_entries (user_id, entry_no);
create unique index if not exists journal_entries_one_opening on journal_entries (user_id) where origin = 'opening' and status = 'posted';
create index if not exists journal_entries_date_idx on journal_entries (user_id, entry_date);
create index if not exists journal_entries_source_idx on journal_entries (user_id, source_type, source_id);

create table if not exists journal_lines (
  id bigserial primary key,
  entry_id bigint not null,
  user_id integer not null,
  line_no smallint not null,
  entry_date date not null,                       -- copied from the entry (immutable) for index-only report scans
  account_id integer not null,
  debit  numeric(14,2) not null default 0 check (debit  >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  memo text,
  -- dimensions (frozen at event time; no FKs)
  owner_id integer, property_id integer, unit_id integer, tenant_id integer, contract_id integer,
  payment_id integer,            -- installment
  document_id integer,           -- simple_invoices.id
  bank_account_id integer,       -- on cash/bank lines
  -- VAT attributes (on revenue/VAT/expense lines only)
  vat_category char(1) check (vat_category in ('S','Z','E','O')),
  vat_rate numeric(5,2),
  vat_base numeric(14,2),        -- signed taxable amount this line relates to
  tax_role text check (tax_role in ('output','input','input_nonrecoverable')),
  seller_key text,               -- 'account' or 'owner:<id>' (whose VAT return this belongs to)
  doc_class text check (doc_class in ('invoice','debit','credit','charge','charge_cancel','advance','rent_receipt','expense','other')),
  check ((debit > 0) <> (credit > 0)),            -- exactly one side positive
  foreign key (entry_id, user_id)   references journal_entries (id, user_id),
  foreign key (account_id, user_id) references accounts (id, user_id),
  unique (entry_id, line_no)
);
create index if not exists journal_lines_acct_date_idx on journal_lines (user_id, account_id, entry_date);
create index if not exists journal_lines_tenant_idx   on journal_lines (user_id, tenant_id, entry_date)   where tenant_id is not null;
create index if not exists journal_lines_owner_idx    on journal_lines (user_id, owner_id, entry_date)    where owner_id is not null;
create index if not exists journal_lines_property_idx on journal_lines (user_id, property_id, entry_date) where property_id is not null;
create index if not exists journal_lines_contract_idx on journal_lines (user_id, contract_id)             where contract_id is not null;
create index if not exists journal_lines_payment_idx  on journal_lines (user_id, payment_id)              where payment_id is not null;
create index if not exists journal_lines_vat_idx      on journal_lines (user_id, seller_key, entry_date)  where tax_role is not null or vat_category is not null;
create index if not exists journal_lines_entry_idx    on journal_lines (entry_id);
```

The composite FKs `(account_id, user_id)` and `(period_id, user_id)` enforce **scoping at DB level**. A line can never point at another account's chart or period, even if the code has a bug.

#### 2.3.5 `ledger_outbox` (the posting queue and the posting-errors list)

```sql
create table if not exists ledger_outbox (
  id bigserial primary key,
  user_id integer not null,
  source_type text not null, source_id bigint not null, event text not null,
  occurred_on date not null,                 -- business date of the event (Riyadh)
  origin text not null default 'live' check (origin in ('live','backfill','recognizer','repair')),
  payload jsonb not null,                    -- facts frozen at enqueue time (§5.2)
  status text not null default 'pending' check (status in ('pending','posted','skipped','failed','dismissed')),
  attempts smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text, last_error_code text,
  skip_reason text,                          -- rule decided nothing to post (e.g. 'self_commission')
  entry_id bigint,                           -- journal_entries.id when posted
  backfill_run_id integer,
  created_at timestamptz not null default now(), processed_at timestamptz,
  dismissed_by integer, dismissed_reason text
);
create unique index if not exists ledger_outbox_idem_uq on ledger_outbox (user_id, source_type, source_id, event);
create index if not exists ledger_outbox_due_idx on ledger_outbox (status, next_attempt_at) where status = 'pending';
create index if not exists ledger_outbox_user_idx on ledger_outbox (user_id, status, id);
```

The posting-errors list is `status in ('failed')`, with `('pending' and attempts>0)` shown as "retrying". Skipped rows are listed separately as "not posted by rule".

#### 2.3.6 `bank_accounts`

```sql
create table if not exists bank_accounts (
  id serial primary key, user_id integer not null,
  kind text not null check (kind in ('bank','cash')),
  name_ar text not null, name_en text,
  bank_name text,
  iban text check (iban is null or iban ~ '^SA[0-9]{2}[0-9A-Z]{20}$'),   -- mod-97 validated in code
  account_number text,
  currency char(3) not null default 'SAR',
  is_trust boolean not null default false,       -- client-money account (manager mode)
  is_default boolean not null default false,
  is_active boolean not null default true,
  gl_account_id integer not null,                -- leaf account created under 1110 at insert
  opening_balance numeric(14,2),                 -- informational; the real opening is the opening entry
  created_by integer, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (gl_account_id, user_id) references accounts (id, user_id)
);
create unique index if not exists bank_accounts_iban_uq on bank_accounts (user_id, iban) where iban is not null;
create unique index if not exists bank_accounts_default_uq on bank_accounts (user_id, kind, is_trust) where is_default and is_active;  -- one default bank, one default trust bank, one default cash box
```

#### 2.3.7 Side tables: v2 attributes of existing records (1:1, never on the legacy table)

```sql
-- which cash/bank account a collection used (tier 1), and v2's classification of it
create table if not exists finance_collection_meta (
  collection_id integer primary key,            -- payment_collections.id
  user_id integer not null, bank_account_id integer, method_detail text,
  settled_by_deduction boolean not null default false,   -- commission collected by deduction (§4.4 E16)
  classification text check (classification in ('deposit_offset','deposit_conversion','commission_cash')),  -- written by v2 paths; read by live posting AND catch-up
  date_defaulted_utc boolean not null default false,     -- the body omitted collectedDate and legacy stamped the UTC date
  created_at timestamptz not null default now()
);
-- expense VAT, supplier, attachment, edit history (tier 1)
create table if not exists finance_expense_details (
  expense_id integer primary key, user_id integer not null,
  revision integer not null default 1,           -- bumps on each edit; part of the posting key
  expense_on date,                               -- parsed business date (legacy expense_date is text)
  gross_amount numeric(14,2) not null,           -- mirrors expenses.amount at this revision
  net_amount numeric(14,2) not null,
  vat_rate numeric(5,2) not null default 0,
  vat_amount numeric(14,2) not null default 0,
  vat_category char(1) not null default 'S' check (vat_category in ('S','Z','E','O')),
  vat_recoverable boolean not null default false,
  supplier_name text, supplier_vat_number text check (supplier_vat_number is null or supplier_vat_number ~ '^3[0-9]{13}3$'),
  supplier_invoice_no text, supplier_invoice_date date,
  attachment_key text,
  bank_account_id integer,
  charge_to text not null default 'company' check (charge_to in ('company','landlord')),
  gl_account_id integer,                         -- override of the category mapping
  updated_by integer, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (net_amount + vat_amount = gross_amount)
);
create table if not exists finance_expense_category_map (
  user_id integer not null, category text not null, account_id integer not null,
  primary key (user_id, category)
);
create table if not exists finance_payout_meta (
  payout_id integer primary key, user_id integer not null,
  paid_on date, bank_account_id integer, created_at timestamptz not null default now()
);
-- disbursement record for a deposit refund (legacy terminate only cancels the voucher; D§1.2.6)
create table if not exists finance_deposit_refunds (
  id serial primary key, user_id integer not null,
  contract_id integer not null, tenant_id integer, owner_id integer,
  voucher_ids integer[] not null default '{}',
  amount numeric(14,2) not null check (amount > 0),
  refunded_on date not null, bank_account_id integer, method text, reference text,
  number text not null,                          -- PV-000001 (payment voucher)
  created_by integer, created_at timestamptz not null default now(),
  unique (user_id, number)
);
-- installment charge marker: at most one ACTIVE charge per installment (§4.1)
create table if not exists finance_installment_charges (
  payment_id integer not null, generation smallint not null default 1,   -- a re-charge after a reversal is a new generation
  user_id integer not null,
  charged_on date not null,
  charged_by text not null check (charged_by in ('due','document','settled_external')),
  document_id integer,
  amount numeric(14,2) not null, vat_amount numeric(14,2) not null default 0,
  entry_id bigint,
  reversed_at timestamptz, reversed_reason text,
  primary key (payment_id, generation)
);
create unique index if not exists finance_installment_charges_active_uq
  on finance_installment_charges (payment_id) where reversed_at is null;   -- the "charged exactly once" guarantee
-- VAT booked at an earlier tax point (advance payment on an uncharged S installment; §4.1)
create table if not exists finance_installment_vat_points (
  collection_id integer primary key, payment_id integer not null, user_id integer not null,
  vat_booked numeric(14,2) not null check (vat_booked > 0), booked_on date not null, entry_id bigint
);
create index if not exists finance_installment_vat_points_pay_idx on finance_installment_vat_points (user_id, payment_id);
-- tenant credit: refund or carry-forward (tier 1)
create table if not exists tenant_credit_actions (
  id serial primary key, user_id integer not null,
  tenant_id integer not null, contract_id integer, owner_id integer,
  kind text not null check (kind in ('refund','apply')),
  amount numeric(14,2) not null check (amount > 0),
  action_on date not null,
  target_document_id integer,                    -- apply: the invoice the credit settles
  source_document_id integer,                    -- the credit note that created the credit (informational)
  bank_account_id integer, method text, reference text, number text,  -- refund: PV- number
  status text not null default 'posted' check (status in ('posted','void')),
  created_by integer, created_at timestamptz not null default now()
);
-- write-offs (replacement for "mark as paid"; §4.6)
create table if not exists finance_write_offs (
  id serial primary key, user_id integer not null,
  tenant_id integer, contract_id integer, owner_id integer,
  payment_ids integer[] not null default '{}', document_ids integer[] not null default '{}',
  amount numeric(14,2) not null check (amount > 0),
  written_off_on date not null, reason text not null,
  created_by integer not null, approved_by integer, created_at timestamptz not null default now()
);
-- what Ejar reported as paid, under v2 (E7; nothing is set to paid)
create table if not exists finance_ejar_settlements (
  payment_id integer primary key, user_id integer not null,
  reported_status text not null, reported_amount numeric(14,2), imported_at timestamptz not null default now()
);
-- manual journal entries (drafts -> approval -> posted journal_entries)
create table if not exists manual_journals (
  id serial primary key, user_id integer not null,
  kind text not null default 'manual' check (kind in ('manual','opening')),
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','posted','void')),
  entry_date date not null, memo text not null, attachment_key text,
  lines jsonb not null,             -- [{accountId, debit, credit, memo, ownerId?, propertyId?, unitId?, tenantId?, contractId?}] as strings
  created_by integer not null, submitted_at timestamptz,
  approved_by integer, approved_at timestamptz, rejected_by integer, rejected_reason text,
  posted_entry_id bigint,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists finance_backfill_runs (
  id serial primary key, user_id integer not null, actor_user_id integer not null,
  mode text not null check (mode in ('full','cutover','catchup')), dry_run boolean not null,
  cutover_date date, started_at timestamptz not null default now(), finished_at timestamptz,
  status text not null default 'running' check (status in ('running','done','failed')),
  summary jsonb
);
-- Document numbers (JV-, PV-, RR-, AGF-) are per account: MAX+1 under pg_advisory_xact_lock(user_id, <series key>), never a global sequence.
-- Series keys live in ONE file, finance-v2/lock-keys.ts, and are NEGATIVE constants (JV -101, PV -102, RR -103, AGF -104, entry_no -105).
-- The positive two-int space is already taken: (uid, 1|2|3) invoice/credit/debit series (billing.module.ts:942), (uid, 11) contract
-- numbers (contracts.module.ts:33), (uid, docId) per-document (billing.module.ts:1971) and (scope, paymentId) per-installment
-- (payments.module.ts:526), so any small positive constant could collide with a real document or installment id.
-- RR-/AGF- rows are in simple_invoices but their prefixes differ from INV-, so they never share a MAX with the (uid,1) series.
```

**Non-tax documents (E9) and the agency fee (E8) do not need a schema change.** They are `simple_invoices` rows with new `kind` values, `'rent_receipt'` and `'agency_fee'`. `kind` is free `text` (`simpleInvoices.ts:22`), and those rows exist only for flag-on accounts. Their number series are `RR-######` and `AGF-######`.

**Expense VAT columns** are in `finance_expense_details`, **not** on `expenses`, for the reason given in §1.4.

Tier-2 tables are in §8.3.

### 2.4 Enforcement in the database

#### 2.4.1 Balance: a deferred constraint trigger

```sql
create or replace function fv2_check_entry_balanced() returns trigger language plpgsql as $$
declare eid bigint; d numeric(16,2); c numeric(16,2); n int; t numeric(14,2);
begin
  if tg_table_name = 'journal_entries' then eid := new.id; else eid := coalesce(new.entry_id, old.entry_id); end if;
  -- each entry is checked once per transaction, not once per line (O(lines), not O(lines²))
  if current_setting('fv2.chk.' || eid, true) = '1' then return null; end if;
  perform set_config('fv2.chk.' || eid, '1', true);
  select coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) into d, c, n from journal_lines where entry_id = eid;
  select total into t from journal_entries where id = eid;
  if n < 2 then raise exception 'fv2: journal entry % has % line(s); at least 2 required', eid, n using errcode = '23514'; end if;
  if d <> c then raise exception 'fv2: journal entry % is unbalanced (debit %, credit %)', eid, d, c using errcode = '23514'; end if;
  if t is distinct from d then raise exception 'fv2: journal entry % total % <> line total %', eid, t, d using errcode = '23514'; end if;
  return null;
end $$;
drop trigger if exists journal_lines_balanced on journal_lines;
create constraint trigger journal_lines_balanced after insert on journal_lines
  deferrable initially deferred for each row execute function fv2_check_entry_balanced();
drop trigger if exists journal_entries_balanced on journal_entries;
create constraint trigger journal_entries_balanced after insert on journal_entries
  deferrable initially deferred for each row execute function fv2_check_entry_balanced();
```

- The check runs at **commit**, after all the lines are in, so an entry and its lines are inserted in any order inside one transaction.
- The trigger on `journal_entries` catches an entry inserted with no lines.
- The same check exists in code (`assertBalanced(lines)` before insert), so a bad rule fails fast with a readable error. The trigger is the backstop.
- **Hardened in build (0068).** The per-transaction marker above could be set by the session itself (`set_config('fv2.chk_<id>','1',true)`), skipping the check. Migration `0068_finance_v2_hardening.sql` replaces the function: the entry's own trigger (one per entry) always checks at commit and consults no setting, and a new `before insert` trigger `journal_lines_same_tx` refuses a line whose entry was posted in an earlier transaction (`posted_at <> transaction_timestamp()`; `posted_at` is immutable). The lines' trigger then has nothing to check for a same-transaction entry. The check stays O(lines) per entry.

#### 2.4.2 Immutability

```sql
create or replace function fv2_ledger_immutable() returns trigger language plpgsql as $$
begin
  if current_setting('fv2.purge', true) = 'on' then return coalesce(old, new); end if;   -- §2.4.5 only
  if tg_table_name = 'journal_lines' then
    raise exception 'fv2: journal lines are immutable (correct with a reversal)' using errcode = '55000';
  end if;
  -- journal_entries: the only permitted UPDATE is posted -> reversed, setting reversed_by/reversed_at
  if tg_op = 'UPDATE' and old.status = 'posted' and new.status = 'reversed' and new.reversed_by is not null
     and (to_jsonb(new) - 'status' - 'reversed_by' - 'reversed_at') = (to_jsonb(old) - 'status' - 'reversed_by' - 'reversed_at') then
    return new;
  end if;
  raise exception 'fv2: journal entries are immutable (correct with a reversal)' using errcode = '55000';
end $$;
drop trigger if exists journal_lines_immutable on journal_lines;
create trigger journal_lines_immutable before update or delete on journal_lines for each row execute function fv2_ledger_immutable();
drop trigger if exists journal_entries_immutable on journal_entries;
create trigger journal_entries_immutable before update or delete on journal_entries for each row execute function fv2_ledger_immutable();
drop trigger if exists journal_no_truncate on journal_lines;
create trigger journal_no_truncate before truncate on journal_lines for each statement execute function fv2_ledger_immutable();
drop trigger if exists journal_entries_no_truncate on journal_entries;
create trigger journal_entries_no_truncate before truncate on journal_entries for each statement execute function fv2_ledger_immutable();
```

`manual_journals` rows in status `posted` are frozen by a similar trigger. They may only move to `void` if the posted entry has been reversed.

#### 2.4.3 Postable account and open period

- **`journal_lines_account_ok` (BEFORE INSERT on `journal_lines`).** The account must be `is_active` and must not be `is_group`, or the insert raises.
- **`journal_entries_period_open` (BEFORE INSERT on `journal_entries`).**
  - `entry_date` must fall between the period's `starts_on` and `ends_on`, and the period must be `open`, **or** `closed` with `origin in ('manual','closing')` (audit adjustments and the year-end entry; the settings capability is checked in code). `locked` refuses everything. Otherwise the insert raises (errcode `55000`, message `fv2: period closed`).
- **`journal_lines_vat_lock` (BEFORE INSERT on `journal_lines`).** A line with `tax_role` or `vat_category` set is refused when its entry's period has `vat_locked_at` set.
  - This is how "a closed period refuses postings" holds for every writer.
  - Routing a late event to the next open period is the engine's job (§5.5). The trigger only refuses.
  - Reversal entries obey the same rule, so reversing an entry from a closed period posts in the current open period.

#### 2.4.4 Idempotency

- `journal_entries_idem_uq (user_id, source_type, source_id, event)` makes a double post impossible, even with two workers. The engine never lets the loser hit a raw `23505` inside its transaction (that would abort it): the entry insert is `insert … on conflict (user_id, source_type, source_id, event) do nothing returning id`. When nothing is returned, the engine selects the existing entry and marks the outbox row `posted` with that id **only if the existing entry's payload matches**; otherwise the row is `failed` with `KEY_COLLISION` (§5.3).
- `ledger_outbox_idem_uq` on the same key makes a double enqueue a no-op (`on conflict do nothing`).
- Postgres `serial` ids are never reused, even after a hard delete. A collection deleted by rebuild and its replacement therefore always have different `source_id`s. D§2.5 worried about this; the worry does not apply.

#### 2.4.5 Account purge (the only delete path)

`fv2_purge_account(p_user integer)` runs `set local fv2.purge = 'on'` and then deletes the account's rows from every v2 table.

- **What the `fv2.purge` setting is, and is not.** The app owns the tables and there is one DB role, so any session could set the setting; `security definer` would add nothing and is not used. The setting is a guard against **accidental** deletes and truncates by application code, not a security boundary. A CI grep enforces that the string `fv2.purge` appears only inside this function's definition in `0066`.
- **Called unconditionally** (not flag-gated) from the admin hard-delete handlers (`admin.module.ts:537-543,929-935`) through an added-line hook placed **after** the legacy deletes have succeeded. It is a no-op for accounts that never used v2. The legacy hard deletes do not run in a transaction (`admin.module.ts:540-541,932-933`), and wrapping them would edit legacy lines. Purging afterwards gives the only safe order: if the legacy delete fails, the account and its ledger both remain; if the purge fails, the v2 rows are orphaned but harmless (scoped by a dead `user_id`) and the purge is retried from the admin support view.

---

## 3. Chart-of-accounts template (Saudi property manager / landlord)

The template is seeded per account on first enable (§1.5) by `seedChart(user)`. The seed is idempotent, with `on conflict (user_id, code) do nothing`.

**Design principles:**
- **Structure.** Codes use a four-digit, SOCPA-style classification: 1 assets, 2 liabilities, 3 equity, 4 revenue, 5 expenses. Groups (`G`) cannot take postings.
- **Sub-accounts.**
  - A user-added sub-account takes its parent's code plus a two-digit suffix, for example `511001` under a user-created group. The parent then becomes a group, which is allowed only while the parent has no postings **and has no `system_key`** (§2.3.2). Accounts the engine posts to (1111, 1113, 1121, 2121, 2151 …) therefore never become groups; the user adds a sibling instead.
  - A bank account's leaf is created under **1110**, at `1117` onwards and then `111001` onwards.
- **Presentation follows IFRS for SMEs.**
  - Tenant credit balances and landlord debit balances are reclassified on the balance sheet (§7.4).
  - Contra accounts carry `normal_balance` opposite to their type.
- **Investment property.** IFRS for SMEs s.16.7 **requires** fair value through profit or loss when fair value can be measured reliably without undue cost or effort on an ongoing basis; the cost model of s.17 applies only otherwise. The chart supports both (1211/1212 at cost less 1213, or a fair-value adjustment posted manually). The default assumed by this design is the **cost model**, on the basis that the SOCPA endorsement or undue cost applies to most customers; the accountant must confirm this (Q18). Depreciation or revaluation is posted manually (no fixed-asset register in scope). Non-recoverable VAT on a capitalised item goes into the asset's cost, not 5500 (s.17.10).
- **Two tenant receivable accounts.** 1121 is for the account's own rent and 1122 for rent managed on behalf of landlords. In Manager mode 1122 is always mirrored by 2122 (§4.2), so an agent's receivables never inflate its own assets on a net presentation.
- **Code layout under 2100.** Every current-liability group has a code inside the 2100 range (2110, 2120, 2130, 2140, 2150 taxes, 2160 employees, 2170, 2180), so a code never suggests a sibling of 2100 or 2300.

| Code | Arabic name | English name | Type | Parent | system_key | G = group |
|---|---|---|---|---|---|---|
| 1000 | الأصول | Assets | asset | — | — | G |
| 1100 | الأصول المتداولة | Current assets | asset | 1000 | — | G |
| 1110 | النقد وما في حكمه | Cash and cash equivalents | asset | 1100 | — | G |
| 1111 | الصندوق الرئيسي | Main cash box | asset | 1110 | `cash` | |
| 1112 | العُهد النقدية | Petty cash | asset | 1110 | `petty_cash` | |
| 1113 | الحساب البنكي الرئيسي | Main bank account | asset | 1110 | `bank_default` | |
| 1114 | حساب أموال العملاء (أمانات) | Client money (trust) bank account | asset | 1110 | `trust_bank` | |
| 1115 | شيكات تحت التحصيل | Cheques under collection | asset | 1110 | `cheques_under_collection` | |
| 1116 | نقدية في الطريق | Cash in transit | asset | 1110 | `cash_in_transit` | |
| 1120 | الذمم المدينة | Receivables | asset | 1100 | — | G |
| 1121 | ذمم المستأجرين | Tenant receivables | asset | 1120 | `tenant_receivable` | |
| 1122 | ذمم المستأجرين – عقارات مُدارة لحساب الملاك | Tenant receivables – managed for landlords | asset | 1120 | `tenant_receivable_agency` | |
| 1123 | ذمم الملاك المدينة | Due from landlords | asset | 1120 | `landlord_receivable` | |
| 1124 | مخصص الخسائر الائتمانية المتوقعة | Allowance for expected credit losses (contra) | asset (credit-normal) | 1120 | `ecl_allowance` | |
| 1125 | سلف وعُهد الموظفين | Employee advances | asset | 1120 | `employee_advances` | |
| 1126 | ذمم مدينة أخرى | Other receivables | asset | 1120 | `other_receivables` | |
| 1130 | المدفوعات المقدمة والتأمينات | Prepayments and deposits paid | asset | 1100 | — | G |
| 1131 | مصروفات مدفوعة مقدماً | Prepaid expenses | asset | 1130 | `prepaid_expenses` | |
| 1132 | دفعات مقدمة للموردين | Advances to suppliers | asset | 1130 | `supplier_advances` | |
| 1133 | تأمينات مستردة لدى الغير | Refundable deposits paid (utilities, etc.) | asset | 1130 | `deposits_paid` | |
| 1150 | ضريبة القيمة المضافة المدينة | VAT receivable | asset | 1100 | — | G |
| 1151 | ضريبة القيمة المضافة – المدخلات | Input VAT | asset | 1150 | `input_vat` | |
| 1152 | ضريبة القيمة المضافة المستردة من الهيئة | VAT refundable from ZATCA | asset | 1150 | `vat_refundable` | |
| 1200 | الأصول غير المتداولة | Non-current assets | asset | 1000 | — | G |
| 1210 | العقارات الاستثمارية | Investment property | asset | 1200 | — | G |
| 1211 | أراضٍ | Land | asset | 1210 | `investment_land` | |
| 1212 | مبانٍ | Buildings | asset | 1210 | `investment_buildings` | |
| 1213 | مجمع إهلاك المباني | Accumulated depreciation – buildings (contra) | asset (credit-normal) | 1210 | `investment_accum_dep` | |
| 1220 | الممتلكات والمعدات | Property and equipment | asset | 1200 | — | G |
| 1221 | الأثاث والتجهيزات | Furniture and fixtures | asset | 1220 | — | |
| 1222 | أجهزة الحاسب الآلي | Computer equipment | asset | 1220 | — | |
| 1223 | السيارات | Vehicles | asset | 1220 | — | |
| 1229 | مجمع إهلاك الممتلكات والمعدات | Accumulated depreciation – equipment (contra) | asset (credit-normal) | 1220 | — | |
| 1230 | الأصول غير الملموسة | Intangible assets | asset | 1200 | — | G |
| 1231 | البرامج والأنظمة | Software | asset | 1230 | — | |
| 1239 | مجمع الإطفاء | Accumulated amortisation (contra) | asset (credit-normal) | 1230 | — | |
| 2000 | الخصوم | Liabilities | liability | — | — | G |
| 2100 | الخصوم المتداولة | Current liabilities | liability | 2000 | — | G |
| 2110 | الذمم الدائنة والمستحقات | Payables and accruals | liability | 2100 | — | G |
| 2111 | الموردون | Accounts payable – suppliers | liability | 2110 | `accounts_payable` | |
| 2112 | مصروفات مستحقة | Accrued expenses | liability | 2110 | `accrued_expenses` | |
| 2120 | مستحقات الملاك | Landlord balances | liability | 2100 | — | G |
| 2121 | مستحقات الملاك – إيجارات محصّلة | Landlord payable – collected rent | liability | 2120 | `landlord_payable` | |
| 2122 | حصة الملاك من إيجارات غير محصّلة | Landlord share of uncollected rent | liability | 2120 | `landlord_payable_uncollected` | |
| 2130 | إيرادات مقدمة | Deferred income | liability | 2100 | — | G |
| 2131 | إيرادات إيجار مقدمة (غير مكتسبة) | Unearned rent | liability | 2130 | `unearned_rent` | |
| 2140 | التأمينات المحتفظ بها | Deposits held | liability | 2100 | — | G |
| 2141 | تأمينات المستأجرين | Tenant security deposits held | liability | 2140 | `deposits_held` | |
| 2150 | الضرائب والزكاة | Taxes and zakat | liability | 2100 | — | G |
| 2151 | ضريبة القيمة المضافة – المخرجات | Output VAT | liability | 2150 | `output_vat` | |
| 2152 | تسوية ضريبة القيمة المضافة (مستحقة للهيئة) | VAT settlement (payable to ZATCA) | liability | 2150 | `vat_settlement` | |
| 2153 | ضريبة الاستقطاع المستحقة | Withholding tax payable | liability | 2150 | `wht_payable` | |
| 2154 | الزكاة المستحقة | Zakat payable | liability | 2150 | `zakat_payable` | |
| 2160 | مستحقات الموظفين | Employee liabilities | liability | 2100 | — | G |
| 2161 | رواتب مستحقة | Accrued salaries | liability | 2160 | — | |
| 2162 | التأمينات الاجتماعية المستحقة | GOSI payable | liability | 2160 | — | |
| 2170 | مستحق لأطراف ذات علاقة | Due to related parties | liability | 2100 | — | |
| 2180 | قروض قصيرة الأجل | Short-term borrowings | liability | 2100 | — | |
| 2300 | الخصوم غير المتداولة | Non-current liabilities | liability | 2000 | — | G |
| 2310 | مخصص مكافأة نهاية الخدمة | End-of-service benefits provision | liability | 2300 | `eosb_provision` | |
| 2320 | قروض طويلة الأجل | Long-term borrowings | liability | 2300 | — | |
| 3000 | حقوق الملكية | Equity | equity | — | — | G |
| 3100 | رأس المال | Capital | equity | 3000 | `capital` | |
| 3200 | الاحتياطيات | Reserves | equity | 3000 | `reserves` | |
| 3300 | الأرباح المبقاة | Retained earnings | equity | 3000 | `retained_earnings` | |
| 3400 | جاري المالك / المسحوبات | Owner's current account / drawings | equity | 3000 | `owner_drawings` | |
| 3900 | حساب الأرصدة الافتتاحية | Opening balance equity | equity | 3000 | `opening_balance_equity` | |
| 4000 | الإيرادات | Revenue | revenue | — | — | G |
| 4100 | إيرادات الإيجار | Rental revenue | revenue | 4000 | — | G |
| 4110 | إيرادات إيجار سكني | Residential rent revenue | revenue | 4100 | `rent_revenue_residential` | |
| 4120 | إيرادات إيجار تجاري | Commercial rent revenue | revenue | 4100 | `rent_revenue_commercial` | |
| 4130 | إيرادات رسوم الخدمات | Service charge revenue | revenue | 4100 | `service_charge_revenue` | |
| 4140 | إيرادات أخرى من المستأجرين | Other tenant charges | revenue | 4100 | `other_tenant_revenue` | |
| 4200 | إيرادات إدارة الأملاك والوساطة | Property management and brokerage revenue | revenue | 4000 | — | G |
| 4210 | إيرادات عمولة إدارة الأملاك | Management commission revenue | revenue | 4200 | `commission_revenue` | |
| 4220 | إيرادات أتعاب الوساطة (السعي) | Brokerage (agency) fee revenue | revenue | 4200 | `agency_fee_revenue` | |
| 4300 | إيرادات تشغيلية أخرى | Other operating income | revenue | 4000 | — | G |
| 4310 | إيرادات تأمينات مُصادرة | Forfeited deposit income | revenue | 4300 | `deposit_forfeit_revenue` | |
| 4320 | غرامات التأخير | Late payment charges | revenue | 4300 | `late_fee_revenue` | |
| 4390 | إيرادات متنوعة | Miscellaneous income | revenue | 4300 | `misc_revenue` | |
| 4400 | إيرادات غير تشغيلية | Non-operating income | revenue | 4000 | — | G |
| 4410 | عوائد الودائع البنكية | Bank deposit returns | revenue | 4400 | — | |
| 4420 | أرباح بيع أصول | Gain on disposal of assets | revenue | 4400 | — | |
| 5000 | المصروفات | Expenses | expense | — | — | G |
| 5100 | مصروفات تشغيل العقارات | Property operating expenses | expense | 5000 | — | G |
| 5110 | الصيانة والإصلاحات | Maintenance and repairs | expense | 5100 | `expense_maintenance` | |
| 5120 | الكهرباء والمياه | Electricity and water | expense | 5100 | `expense_utilities` | |
| 5130 | النظافة | Cleaning | expense | 5100 | `expense_cleaning` | |
| 5140 | الحراسة والأمن | Security and guarding | expense | 5100 | `expense_security` | |
| 5150 | التأمين على العقارات | Property insurance | expense | 5100 | `expense_insurance` | |
| 5160 | أتعاب إدارة مدفوعة للغير | Management fees paid to third parties | expense | 5100 | `expense_management_fees` | |
| 5170 | رسوم حكومية وبلدية وتراخيص | Government, municipal and licence fees | expense | 5100 | `expense_government_fees` | |
| 5180 | رسوم منصة إيجار | Ejar platform fees | expense | 5100 | `expense_ejar_fees` | |
| 5190 | مصروفات عقارات أخرى | Other property expenses | expense | 5100 | `expense_property_other` | |
| 5200 | المصروفات العمومية والإدارية | General and administrative expenses | expense | 5000 | — | G |
| 5210 | الرواتب والأجور | Salaries and wages | expense | 5200 | — | |
| 5211 | التأمينات الاجتماعية | GOSI contributions | expense | 5200 | — | |
| 5212 | مكافأة نهاية الخدمة | End-of-service benefits expense | expense | 5200 | — | |
| 5213 | رسوم الإقامات والتأشيرات ومكتب العمل | Iqama, visa and labour-office fees | expense | 5200 | — | |
| 5220 | إيجار المكتب | Office rent | expense | 5200 | — | |
| 5230 | الاتصالات والإنترنت | Telecom and internet | expense | 5200 | — | |
| 5240 | اشتراكات البرامج | Software subscriptions | expense | 5200 | `expense_software` | |
| 5250 | الأتعاب المهنية | Professional fees | expense | 5200 | — | |
| 5260 | التسويق والإعلان | Marketing and advertising | expense | 5200 | — | |
| 5270 | العمولات والرسوم البنكية | Bank charges | expense | 5200 | `bank_charges` | |
| 5280 | القرطاسية والمطبوعات | Stationery and printing | expense | 5200 | — | |
| 5290 | مصروفات عمومية أخرى | Other general expenses | expense | 5200 | `expense_general_other` | |
| 5300 | الإهلاك والمخصصات | Depreciation and impairment | expense | 5000 | — | G |
| 5310 | إهلاك العقارات الاستثمارية | Depreciation – investment property | expense | 5300 | — | |
| 5320 | إهلاك الممتلكات والمعدات | Depreciation – property and equipment | expense | 5300 | — | |
| 5330 | الخسائر الائتمانية المتوقعة والديون المعدومة | Expected credit losses and bad debts | expense | 5300 | `bad_debt_expense` | |
| 5400 | تكاليف التمويل | Finance costs | expense | 5000 | — | |
| 5500 | ضريبة القيمة المضافة غير القابلة للاسترداد | Non-recoverable VAT | expense | 5000 | `vat_non_recoverable` | |
| 5600 | الزكاة وضريبة الدخل | Zakat and income tax | expense | 5000 | — | G |
| 5610 | مصروف الزكاة | Zakat expense | expense | 5600 | `zakat_expense` | |
| 5620 | مصروف ضريبة الدخل | Income tax expense | expense | 5600 | — | |

That is 116 accounts, of which 30 are groups.

**Accounts the engine resolves, and how:**
- **Rent revenue** is chosen by the line's nature:
  - 4110 when the unit or property usage is residential (`src/common/usage-vat.ts`) or the VAT category is E
  - 4120 otherwise
  - 4130 for installments with a description other than the deposit description, or document items flagged as fees
  - 4140 for any other document item
- **Cash or bank** comes from the collection's `bank_account_id`, if `finance_collection_meta` has one. Otherwise it follows the method:
  - `cash` goes to `default_cash_account_id`
  - anything else goes to `default_bank_account_id`
  - in Manager mode with `agency_collections_to_trust`, agent collections go to the default *trust* bank account
- **Expenses** use `finance_expense_details.gl_account_id`, then `finance_expense_category_map`, then 5190 when the expense has a property, then 5290.

Unused template accounts cost nothing and can be deactivated.

---

## 4. Posting rules

### 4.1 The recognition model: charge at the earlier of document and due date; revenue straight-line; VAT at the earliest tax point

G3-3 asks whether revenue is recognised at invoice date, due date or collection. This design separates three things that the question runs together: **when the tenant is charged** (AR), **when rent is earned** (revenue), and **when VAT is due** (the tax point).

**1. The charge (Dr AR).** It happens exactly once per installment (one *active* row in `finance_installment_charges`), at whichever comes first:
1. **Document charge.** A confirmed charge document covers the installment: a tax invoice, debit note, non-tax rent receipt (E9) or agency-fee invoice. The document is charged on its issue date, **in full, from its own `subtotal`, `total` and per-item categories** (documents are never re-split, §2.1). The installments it covers (`payment_id` / `payment_ids`) get an active marker with `charged_by='document'`.
2. **Due-date charge.** The installment's due date has **passed** (`due_date < riyadhToday()`) with no covering document. The recognizer (§5.6) charges it, dated `due_date`, with `charged_by='due'`. Waiting until the day after the due date means an invoice approved on the due date itself always wins, so live posting and backfill take the same path (backfill uses the same rule, §6.3).
3. **External settlement.** An installment that Ejar reports as paid (`settled_external`) is charged like any other at its due date, and the settlement is then posted as E33 (§4.4).

**A document that arrives after a due-date charge: reverse and replace.** When the document is posted, the worker (at post time, §5.3) finds each covered installment with an active `charged_by='due'` marker, posts `payment,<id>,reversal:charge` (a full mirror of the E02, dated the document's issue date or the next open period), marks that marker reversed, and then posts the document in full with its own categories and VAT. So a due-date charge in category O followed by an S invoice ends as the invoice's S revenue and VAT, never as a pro-rated "remainder"; and a document for less than what was charged simply leaves the difference off AR. There is no `alreadyCharged` fact anywhere.

**2. The collection.** A collection always credits AR (Dr Bank / Cr AR). Money received before the charge leaves the tenant in credit, which is an advance. The balance sheet reclassifies it as a liability (§7.4).

**3. Revenue: straight-line over the period each installment covers** (principal rent only; `defer_rent_straight_line`, on by default).
- IFRS for SMEs s.20.25 requires lessor operating-lease income on a straight-line basis over the lease term. Semi-annual and annual installments are normal in Saudi leases, so booking a six- or twelve-month installment as revenue on one day would misstate every monthly and quarterly P&L, the landlord "property performance" view (§7.8) and any fiscal year not aligned with the installment dates.
- **At the charge**, the net rent of a principal installment is credited to **2131 Unearned rent**, not to revenue: Dr AR gross / Cr 2131 net / Cr VAT.
- **The recognizer posts a monthly release** `payment,<id>,release:YYYY-MM`, dated the month's last day (or the window's last day if earlier): Dr 2131 / Cr REV, pro-rated by days over the installment's **coverage window**. The window runs from the installment's `due_date` to the day before the next rent installment's `due_date` on the same contract; the last one ends at the contract end date, or at `finance_contract_dims.ended_on` if the contract was ended early. The final month takes the halala remainder so the releases sum exactly to the net charge.
- Months already in the past when a charge posts are released in the same run (catch-up), each dated its own month-end, or the next open period if that month is closed (§4.7).
- **Reductions** follow the same split. A credit note, a charge cancellation or a reversal of a deferred charge debits 2131 up to the installment's unreleased balance and revenue for the rest; the entry payload records the split. Each later release spreads the **remaining** unreleased balance over the remaining days of the window, so a mid-window credit note lowers the releases that follow it.
- **Not deferred:** agent rent (it never reaches revenue: it sits on 2122 and 2121), fees and other non-rent lines (recognised at the charge), and document lines that cover no installment (recognised at the document date, with the warning `no_coverage_window`).
- **Stepped rent.** Straight-lining is applied per installment window, not averaged over the whole term. For a lease with rent-free months or escalations, s.20.25 strictly requires averaging over the term; that is Q23b, off by default.

**4. VAT: at the earliest tax point, including advances.**
- The charge books output VAT (documents: the printed VAT; due-date charges: the §2.1 split).
- **Advance payments.** VAT IR Art. 23 sets the supply date of a periodic supply at the earliest of the payment due date, the date payment is received, and the invoice date, to the extent of the payment. So when a positive collection lands on an **uncharged** installment in category S (an advance at contract start, `contracts.module.ts:950-989`; a receipt voucher paying a not-yet-due row, `billing.module.ts:1164-1190`), or is a FIFO remainder on an S contract, the engine also posts an **advance-VAT entry** `payment_collection,<id>,advance_vat`, dated `collected_date`: principal Dr AR / Cr 2151 vat(X); agent Dr 1122 / Cr 2122 (the VAT line, `tax_role output`, `doc_class 'advance'`), where vat(X) is the §2.1 split of the collected amount X. The amount is recorded in `finance_installment_vat_points`.
- **When that installment is charged later**, the charge credits VAT only for `vat − Σ vat_booked` and debits AR only for `gross − Σ vat_booked` (for a document, the reverse-and-replace step does the same netting against the document's VAT). A negative collection on such an installment reverses the matching part of the advance VAT while the installment is **not charged**; once charged, the charge carries the installment's VAT (a refund is then cash and AR only, and a tax invoice's VAT changes only by a credit note). Cancelling the installment (E05) reverses the advance VAT booked on it too, charged or not.
- The warning `vat_without_tax_invoice` is added to any VAT booked without a tax invoice (due-date charges and advance VAT). Reconciliation R7 lists these so the user can issue the invoice.

**Why this model:**
- **E3 disappears by construction.** A tenant paid only on receipt vouchers is charged at each due date and credited at each collection, so the balance is 0, not −96,000.
- **It matches the standard and the lease.** AR reflects what is contractually due or invoiced; revenue follows the period of use (s.20.25); VAT follows the Implementing Regulations' tax point.
- **VAT follows the documents where there are documents,** so the VAT report reconciles to what ZATCA received.
- **AR is simple and auditable.** AR by tenant is charges minus credit notes minus collections plus refunds minus write-offs, net of the advance-VAT lines, which is exactly the tenant ledger (§7.7).

What counts as a charge, and in which VAT category:
- **Installments.**
  - `vat_enabled` gives S at 15%, split per §2.1. If the seller landlord has no VAT number, the category stays S as the contract says, with the warning `vat_unregistered_seller` (the contract is probably wrong; an unregistered person cannot charge VAT).
  - Otherwise, residential usage (`usage-vat.ts`) gives **E when the seller is VAT-registered**, and **O when the seller is not** (only a taxable person makes exempt supplies).
  - Otherwise the category is O, with the warning `commercial_without_vat` when the landlord is VAT-registered.
- **Documents.** The category comes per item from `items[].vatCategory` / `vat` (`billing.module.ts:47-60`).
  - The VAT is `total − subtotal` on the S group.
  - The Z, E and O groups carry net only.
  - A non-tax rent receipt is O throughout, because its seller is not VAT-registered.
- **Excluded from charges:**
  - legacy deposit installments (description `تأمين (وديعة)`, `contracts.module.ts:1708-1709`), which are deposits (E09)
  - `cancelled` installments
  - soft-deleted installments
  - installments of deleted contracts (`contracts.deleted_at is not null`)
  - installments of a `terminated` or `cancelled` contract whose `due_date` is after `finance_contract_dims.ended_on` (§4.6); such rows are listed for a disposition instead


### 4.2 Owner mode and Manager mode, resolved per landlord

`finance_settings.accounting_mode` is set by the admin at enable time.

- **Owner.** Every landlord is treated as **principal**. Rent is the account's revenue, and payouts to landlords are equity drawings (3400).
  - **Precondition, checked by the admin dialog and the PATCH (400 otherwise):** every landlord with an active contract is either the account-holder landlord or carries the **same VAT number, or when unregistered the same ID/CR number,** as the account holder. Owner mode is for one legal person, or one person's several landlord rows (a common result of Ejar imports), never for real third parties.
  - Why: with third-party landlords in Owner mode, their output VAT would sit in the account's own 2151 and could not tie to any one return, and paying them would be booked as the account's drawings. Both are wrong for any third party. An account with third parties uses Manager mode.
  - Under this precondition every Owner-mode line has `seller_key='account'`.
- **Manager.**
  - The landlord row with `is_account_holder = true` (the account's own properties) is **principal**.
  - Every other landlord is **agent**. The rent belongs to the landlord, so the account records a receivable held for the landlord (1122), mirrored by the landlord's share of uncollected rent (2122). Collected rent becomes a landlord payable (2121). Only commission and fees are revenue.
  - If the landlord cannot be resolved, the treatment is agent with `owner_id = null` and the warning `landlord_unresolved`.
- **Default suggested in the admin dialog:** `manager` when the account is a company (`users.user_type='company'`) and has at least one landlord with `is_account_holder=false` who holds at least one property; `owner` otherwise, and only when the Owner-mode precondition holds. The default is only suggested, not applied silently, because Ejar imports create stranger landlord rows (DARA-NOTES §7).
- **The treatment is frozen into each event's payload.** Changing the mode after the first posting is refused. A later "re-base" (reverse everything and re-post) is a tier-2 admin action.

**Agent invariant.** `balance(1122) = −balance(2122)` at all times, per tenant, landlord and contract. Every agent rule posts both sides. As a result:
- 2121 moves only on cash events, so **2121 (per landlord) equals the landlord-dues report's `remaining` on a collected basis** (`reports.module.ts:151-185`), which is reconciliation R3.
- On a net presentation, the agent's balance sheet shows no managed receivable as its own asset (§7.4).

Why per landlord and not per company: the staging accountant account itself mixes the two. It owns two properties and manages a villa for an unregistered individual landlord. A single company-wide switch would book the villa's rent as the company's revenue, or the company's own rent as a payable to itself. Both are wrong.

### 4.3 Notation and dimensions

- **Account keys:**
  - `AR` is 1121 for principal and 1122 for agent. Agency-fee documents always use 1121.
  - `UR` 2131 Unearned rent (principal rent between charge and release, §4.1).
  - `LP` 2121, `LPU` 2122, `REV` rent revenue per §3, `VAT` 2151, `IN` 1151, `NR` 5500, `DEP` 2141, `BANK` the resolved cash or bank account (§3).
- **Dimensions** are stamped on **every line of an automatic entry** (landlord, property, unit, tenant, contract, installment, document), so a landlord- or property-filtered trial balance still balances.
  - Bank and cash lines also carry `bank_account_id`.
  - Revenue, VAT and 2122 lines carry the VAT attributes `vat_category`, `vat_rate`, `vat_base`, `tax_role`, `seller_key` and `doc_class`.
- **`seller_key`** is `'account'` for the account's own supplies. That covers principal rent of the account-holder landlord (and, in Owner mode, of every landlord row, which the §4.2 precondition makes the same legal person), commission, agency fees and company expenses. Every agent line is `'owner:<id>'`, because the ZATCA seller of that rent is that landlord (`billing.module.ts:1650`).
- **Dimension resolution** happens at enqueue and is frozen.
  - The path is contract → `contract_units` → unit → property → `owner_id`, falling back to the contract's landlord snapshot matched by id number and then name, as in `reports.module.ts:134-149`.
  - `contract_units` rows are **hard-deleted on terminate and DELETE** (`contracts.module.ts:1663,1803`), so v2 keeps a side table: `finance_contract_dims(contract_id pk, user_id, owner_id, property_id, unit_ids int[], captured_at)`. It is filled for every contract at enable time and at each contract create or rebuild. Resolution reads it first.
  - **Fallbacks (added in build)** for a contract with no units left (terminated before the flag was enabled): after the unit chain, the landlord id number and the name, the landlord VAT number on the contract, then the landlord and property on the ledger's own history of the contract (e.g. the opening entry), then the account's only landlord. Null dims on an existing row are filled (never overwritten). A contract resolved without units carries the warning `dimension_inferred`.
  - A contract that spans several properties takes the first unit, as the reports do (`reports.module.ts:74-79`), with the warning `dimension_ambiguous`.

```sql
create table if not exists finance_contract_dims (
  contract_id integer primary key, user_id integer not null,
  owner_id integer, property_id integer, unit_ids integer[] not null default '{}',
  ended_on date,                       -- set by the v2 terminate / DELETE override; nothing is charged after it (§5.6)
  captured_at timestamptz not null default now()
);
```

### 4.4 The rules: event → entry, in both modes

Keys are `(source_type, source_id, event)`. Amounts are gross unless marked *net*. "Skip" means an outbox row with status `skipped` and a reason, and no entry.

| # | Event (trigger site) | Key | Owner mode, and Manager mode for the principal landlord | Manager mode, agent landlord | Date | Notes |
|---|---|---|---|---|---|---|
| E01 | Charge document confirmed: tax invoice, `kind` null/`invoice`/`manual` (`billing.module.ts:1478-1482`) | `simple_invoice,id,confirmed` | Dr AR *gross* / Cr UR *net rent per category* (REV for non-rent lines) / Cr VAT *vat* | Dr 1122 *gross* / Cr 2122 *net per category* / Cr 2122 *vat* (tax_role output, `seller_key owner:<id>`) | `issue_date` (fallback `confirmedAt` Riyadh) | Posted **in full** from the document's own figures. First reverses any active due-date charge of the covered installments (`payment,id,reversal:charge`) and nets any advance VAT already booked (§4.1). Marks covered installments charged (`charged_by='document'`). |
| E02 | Installment past due (`due_date < today`), no covering document (recognizer §5.6) | `payment,id,charge` (generation ≥ 2: `charge:g<n>`) | Dr AR / Cr UR *net* (REV for fee rows) / Cr VAT, each net of advance VAT already booked | Dr 1122 / Cr 2122 (net and VAT lines) | `due_date` | Warnings `vat_without_tax_invoice`, `commercial_without_vat` or `vat_unregistered_seller` as they apply. |
| E03 | Collection, positive (`payments.module.ts:544`; `billing.module.ts:1180,1219,1233,2020,2047`; advance `contracts.module.ts:957-965`) | `payment_collection,id,collected` | Dr BANK / Cr AR | Dr BANK / Cr 1122 **and** Dr 2122 / Cr LP | `collected_date` | Classified first, reading `finance_collection_meta` (§4.4.1). On an uncharged S installment it also triggers E34. |
| E04 | Collection, negative (terminate refund `contracts.module.ts:1843`) | `payment_collection,id,collected` | Dr AR / Cr BANK | Dr 1122 / Cr BANK **and** Dr LP / Cr 2122 | `collected_date` | On a legacy deposit row: Dr DEP / Cr BANK. |
| E05 | Charged installment cancelled (v2 terminate / DELETE dispositions; status recompute to `cancelled` `:1893-1903`) | `payment,id,charge_cancelled` | Dr UR (unreleased part) / Dr REV (released part) / Dr VAT / Cr AR (`doc_class charge_cancel`), plus Dr VAT / Cr AR for any advance VAT booked on the installment (`doc_class advance`; also when it was never charged) | Dr 2122 / Cr 1122 | event date (Riyadh today) | The charge state is read **at post time** (§5.3). If the active charge is `charged_by='document'`: **skip** `cancelled_but_invoiced`, listed in R7 (needs a credit note). Skipped for installments in a write-off (`written_off`). |
| E06 | Credit note confirmed (`billing.module.ts:1467-1469`) | `simple_invoice,id,confirmed` | Dr UR up to the covered installments' unreleased balance, then Dr REV *net per category* / Dr VAT / Cr AR *gross* | Dr 2122 *net and VAT lines* / Cr 1122 *gross* | `issue_date` | Negative `vat_base` (adjustment column, §7.5). An excess over the invoice's open balance leaves the tenant in credit (tier-1 refund or apply). Triggers the commission credit note (E36). |
| E07 | Debit note confirmed | `simple_invoice,id,confirmed` | as E01 (`doc_class debit`) | as E01 | `issue_date` | |
| E08 | Non-tax rent receipt `kind='rent_receipt'` confirmed (E9, v2 only) | `simple_invoice,id,confirmed` | Dr AR / Cr UR (rent, category O, no VAT line) | Dr 1122 / Cr 2122 (O) | `issue_date` | Charges its installments like E01. |
| E09 | Deposit received: deposit voucher confirmed (`contracts.module.ts:1063-1080,1151`; standalone `billing.module.ts:1154` with kind `deposit`) **or** a collection on a legacy deposit installment | `simple_invoice,id,deposit_received` / `payment_collection,id,collected` | Dr BANK / Cr DEP | Dr BANK / Cr DEP | `paid_date`/`issue_date` / `collected_date` | Liability to the tenant in both modes: the account holds the deposit. A voucher posts only its **unlinked** amount: total − Σ its collections with `payment_id` set (§4.4.1). |
| E10 | Deposit refunded: v2 `finance_deposit_refunds` row (terminate override) **or** legacy voucher `cancelled` plus `deposit_status='returned'` (backfill) | `simple_invoice,<voucherId>,deposit_refunded`, **one key per voucher, the same key on both paths** | Dr DEP / Cr BANK | Dr DEP / Cr BANK | `refunded_on` / legacy: the date frozen by the first run (see note) | The v2 refund row lists its `voucher_ids`; the PV number is on the entry memo. Legacy dates are inferred from `updated_at` **once**, frozen into the first run's summary and reused (Drizzle `$onUpdate` bumps `updated_at` on any later write, `simpleInvoices.ts:77`), with the warning `inferred_date`. The deposit receipt is never un-posted. |
| E11 | Deposit forfeited, no money row (`contracts.module.ts:1864-1866`; v2 terminate also for voucher deposits) | `contract,id,deposit_forfeited` | Dr DEP / Cr 4310 *net* (+ Cr VAT when `deposit_forfeit_vat='S'`) | Dr DEP / Cr LP (VAT attributes for the landlord if S) | event date | VAT default is O, out of scope (Q4). |
| E12 | Deposit turned into revenue: a collection with `payment_id` null against a `kind='deposit'` voucher, created by terminate (`contracts.module.ts:1869-1889`) | `payment_collection,id,deposit_converted` | as E11 | as E11 | `collected_date` | **No Dr BANK.** The cash was booked at E09. Identified by meta `deposit_conversion` (v2) or, for history, by the terminate note text plus `collected_date` after the voucher's issue date (warning `inferred_classification`). |
| E12b | Deposit applied to tenant arrears (v2 terminate option): a collection with meta `deposit_offset` | `payment_collection,id,collected` | Dr DEP / Cr AR | Dr DEP / Cr 1122 **and** Dr 2122 / Cr LP | `collected_date` | A real collection row keeps the installment statuses right. |
| E13 | Advance rent at contract create or rebuild (collections with `ADVANCE_NOTE` plus a `kind='receipt'` voucher, `:957-989`) | per collection, as E03 | E03 (tenant in credit until the due-date charges) | E03 | `collected_date` | The voucher itself posts nothing (evidence only). |
| E14 | Advance re-pointed to an invoice (`billing.module.ts:974-981`) | — | skip `repoint_no_effect` | skip | — | The invoice's E01 does the charging; the collections already credited AR. |
| E15 | Commission invoice confirmed (`kind='commission'`, `:1480`) | `simple_invoice,id,confirmed` | **skip** `self_commission` (no agency) | Dr LP *gross* / Cr 4210 *net* / Cr VAT (`seller_key account`) | `issue_date` | G3 mapping. VAT only when the account is VAT-registered (E1 decision, §9). |
| E16 | Commission invoice collected (`/collect`, `payment_id` null, `:2046-2053`) | `payment_collection,id,collected` | skip | Default **skip** `settled_by_deduction` (meta flag; the v2 collect dialog default). If paid in cash by the landlord (meta `commission_cash`): Dr BANK / Cr LP | `collected_date` | Backfill assumes deduction, consistent with the dues report, with the warning `assumed_deduction`. |
| E17 | Agency-fee invoice `kind='agency_fee'` confirmed (E8, v2 only) | `simple_invoice,id,confirmed` | Dr 1121 / Cr 4220 *net* / Cr VAT **only if the account is VAT-registered** | same | `issue_date` | Always the account's own revenue (brokerage fee). Collected via E03 on 1121. During the beta an S-rated AGF cannot be approved by a ZATCA-integrated account (§9 E8, Q6b). |
| E18 | Expense created, edited or deleted (legacy `reports.module.ts:363-389`; v2 endpoints) | `expense,id,rev:<n>`; edit: `reversal:rev:<n>` plus `rev:<n+1>`; delete: `reversal:rev:<n>` | Company expense: Dr EXP *net* / Dr IN *recoverable VAT* / Dr NR *non-recoverable VAT* / Cr BANK *gross* | `charge_to='landlord'`: Dr LP *net* / Dr LP *VAT* (two lines, each with `vat_category`, `vat_base`, `tax_role input` or `input_nonrecoverable`, `seller_key owner:<id>`) / Cr BANK *gross*. `charge_to='company'`: as Owner | `expense_on` (parsed) | Legacy rows: gross, no VAT, `charge_to=landlord` when an agent landlord resolves from `ownerId`/`propertyId`, as the dues report does (`reports.module.ts:166-175`). For a landlord-charged expense, `vat_recoverable` defaults to false unless the supplier invoice is addressed to the landlord (VAT IR Art. 49). |
| E19 | Landlord payout created or deleted (`reports.module.ts:448-469`) | `landlord_payout,id,created` / `reversal:created` | Dr 3400 drawings / Cr BANK | Dr LP / Cr BANK | `paid_on` / parsed `transfer_date` | |
| E20 | Tenant credit refunded (tier 1) | `tenant_credit_action,id,refund` | Dr AR / Cr BANK | Dr 1122 / Cr BANK **and** Dr LP / Cr 2122 | `action_on` | Refused if the tenant's credit is less than the amount. |
| E21 | Tenant credit carried forward (tier 1) | `tenant_credit_action,id,apply` | Same contract and landlord: skip `allocation_only`. Otherwise Dr AR (source contract dims) / Cr AR (target contract dims); agent also Cr 2122 (source) / Dr 2122 (target). *(Corrected in build: the credit sits on the source as negative AR, so the source is debited; the sides first printed here would have doubled the credit.)* | Same landlord only; across landlords it is **refused** | `action_on` | The allocation record drives document matching and aging. |
| E22 | Contract rebuild hard-deletes collections and installments (`contracts.module.ts:1390-1391`) | `payment_collection,id,reversal:collected` and `reversal:advance_vat`; `payment,id,reversal:charge`, `reversal:settled_external` and `reversal:release:YYYY-MM` | Reversal of the original entry | Reversal | rebuild date | Enqueued **inside** the rebuild transaction before `:1390`, with a snapshot of the deleted rows in the payload. |
| E23 | `generate-installments` (`contracts.module.ts:1169-1185`) | — | Under v2 the fork returns **409** `FINANCE_V2_INSTALLMENTS_LINKED` when any row it would soft-delete has an active charge marker or is listed in a confirmed document's `payment_id(s)`, mirroring rebuild's `linked_documents` refusal (`rebuild.ts:295`). Otherwise the rows it deletes are uncharged, so nothing posts | same | — | Legacy deletes every `pending`/`settled_external` row, including invoiced ones; the replacement rows would then be charged a second time. |
| E24 | Write-off (v2, replaces "mark as paid") | `write_off,id,posted` | Dr 5330 / Cr AR; any unreleased 2131 of the written-off installments stays and is released as earned (the revenue was earned; the loss is a separate expense) | Dr 2122 / Cr 1122 (the landlord bears the loss) | `written_off_on` | Output VAT is **not** adjusted automatically. Bad-debt relief has conditions (VAT IR Art. 40; Q15). Commission on written-off rent: Q24. |
| E25 | Termination `mode:"paid"` / DELETE `mode=paid` | — | **Refused** (409) under v2 (§4.6) | Refused | — | |
| E26 | Ejar import (`ejar.module.ts:523+`) | — | v2: Ejar-paid becomes `settled_external`; the recognizer charges it at its due date and E33 posts the settlement. Partial stays pending and is recorded in `finance_ejar_settlements` | same | — | §9 E7. |
| E27 | `settle-external` / `revert-external` (`payments.module.ts:277-304`) | `payment,id,settled_external` / `payment,id,reversal:settled_external` | v2: settle posts E33 (the charge is untouched). Revert reverses E33 and the row returns to pending with its charge still active. A second settle after a revert is refused (409): record a collection instead | same | event date | The charge is never reversed by these routes, so the charge key is never reused. |
| E28 | Manual journal approved; opening balance | `manual_journal,id,posted` | As drafted (`origin manual`/`opening`) | same | `entry_date` | §8.1. |
| E29 | Payment confirmation approved (`payment-confirmations.module.ts:382-495`) | — | nothing (it creates a draft) | nothing | — | Never used in tests (it pushes to the tenant). |
| E30 | Receipt voucher `kind='receipt'` document itself | — | nothing | nothing | — | Its collections post E03. A FIFO remainder with `payment_id` null (`billing.module.ts:1233`) posts E03 with tenant and contract dims (the tenant stays in credit). |
| E31 | Confirmed charge document soft-deleted (defensive; should not happen) | `simple_invoice,id,reversal:confirmed` | Reversal | Reversal | event date | Warning `confirmed_document_deleted`. |
| E32 | Late-payment penalty | — | not built (G3-10, Q10) | — | — | |
| E33 | Installment settled outside Dara (Ejar-paid, `settled_external`), after it is charged | `payment,id,settled_external` | Dr 1116 cash in transit / Cr AR (the tenant paid the account's own bank through Ejar; cleared by bank reconciliation) | Dr 2122 / Cr 1122 (the tenant paid the landlord directly; nothing passes through the account, and the landlord payable is unchanged) | the Ejar-reported date, else `due_date` | In `cutover` mode, settlements dated before the cutover are in the opening balance. |
| E34 | Advance VAT: a positive collection on an uncharged S installment, or a FIFO remainder on an S contract (§4.1) | `payment_collection,id,advance_vat` | Dr AR / Cr VAT *vat(X)* (`doc_class advance`) | Dr 1122 / Cr 2122 *vat(X)* (VAT line, `seller_key owner:<id>`) | `collected_date` | Recorded in `finance_installment_vat_points`. The later charge is netted (§4.1). A negative collection reverses the matching part. |
| E35 | Monthly rent release (recognizer) | `payment,id,release:YYYY-MM` | Dr UR / Cr REV (pro-rated by days over the coverage window, §4.1) | — (agent rent is never deferred) | month-end (or window end) | Only when `defer_rent_straight_line` is on. |
| E36 | Commission credit note (v2): created as a **draft** when a credit note on a rent invoice with a confirmed COM document is approved; its approval posts | `simple_invoice,id,confirmed` | skip `self_commission` | Dr 4210 *net* / Dr VAT / Cr LP *gross* (the rent-proportional share of the COM document) | `issue_date` | Not sent to ZATCA, like every commission document (`billing.module.ts:1642-1645`). Write-offs: Q24. |
| E37 | VAT return locked for `seller_key='account'` (§7.5) | `vat_return,id,settled` | Dr 2151 *box 6 VAT (signed)* / Cr 1151 *box 12 VAT* / Cr 2152 *net payable* (or Dr 1152 when the net is a refund) | — (agent VAT belongs to the landlord's own return) | the return's period end (VAT-lock exempt: it carries no `tax_role`) | Box 14 and 15 amounts are posted by a manual journal the accountant approves. The ZATCA payment is a manual template: Dr 2152 / Cr bank. |
| E38 | Supplier bill approved (tier 3, §8.4) | `supplier_bill,id,approved` | Per line: Dr expense or asset *net* (line account → supplier default → 5190 with a property / 5290) / Dr 1151 *recoverable VAT* or Dr 5500 *non-recoverable VAT*; Cr 2111 *total* | Same; **charged to an agent landlord**: Dr LP *net + VAT* (seller key `owner:<id>`) / Cr 2111 | `bill_date` | VAT attributes as E18, so the VAT return needs no special case. Void (no posted payments) → `reversal:approved` at the void date. |
| E39 | Supplier payment (payment voucher PV-######, tier 3) | `supplier_payment,id,paid` | Dr 2111 / Cr BANK | Dr 2111 / Cr BANK | `paid_on` | Allocated to bills (Σ allocations = amount, each ≤ the bill's open amount, under the AP lock). Void → `reversal:paid`. |

#### 4.4.1 Classifying a collection (live posting and catch-up use the same function)

A `payment_collections` row is classified in this order. The classifier reads **every v2 side table** (`finance_collection_meta`, `finance_deposit_refunds`, `tenant_credit_actions`, `finance_write_offs`), so the nightly catch-up can never re-derive a v2 event under a different rule.

1. Meta `deposit_offset` → E12b. Meta `deposit_conversion` → E12. Meta `commission_cash` → E16 cash.
2. `invoice_id` points at a `kind='deposit'` voucher:
   - `payment_id` set → classify by the installment (a legacy deposit row → E09 collection; a rent or fee row → E03). The voucher's own E09 excludes these amounts.
   - `payment_id` null and identified as a terminate conversion (meta, or for history the terminate note text and a later date) → E12.
   - `payment_id` null otherwise (a `countAsCollection` remainder on a deposit voucher, `billing.module.ts:1229-1236`) → **nothing**; the amount is part of the voucher's E09.
3. `invoice_id` points at a commission document → E16.
   - `invoice_id` points at an `agency_fee` document → E03/E04 with the treatment forced to **principal** whatever the contract's landlord: the fee is the account's own revenue (E17 books it to 1121), so the cash goes to the operating bank and clears 1121, with no 2122 → 2121 transfer. No E34 (E17 already carries the VAT).
4. `payment_id` on a legacy deposit installment → E09 (collection variant); negative → E04 on DEP.
5. Otherwise → E03 (positive) or E04 (negative), plus E34 when §4.1's advance-VAT condition holds.

`POST /simple-invoices/receipt-voucher` accepts `kind='deposit'` together with `paymentIds` or `countAsCollection` (`billing.module.ts:189`, `:1164-1236`), so both paths of rule 2 occur. Tests cover each: a deposit voucher with no collections, with rent-row collections, with a payment-less remainder, and converted at termination.

**Every rule is a pure function** `rules/<event>.ts: (facts: EventFacts) => Line[]`, working in integer halalas. The rule test (§11.1) asserts, in both modes, that Σ debit = Σ credit and that the agent invariant holds.

### 4.5 Worked example (Manager mode, one agent landlord, synthetic values)

The installment is 6,900 = 6,000 + 900 VAT, due 1 August. The tenant pays 3,000 on 10 August. A credit note of 1,150 = 1,000 + 150 is issued on 20 August against that month's invoice INV (6,900), which was confirmed on 1 August. Commission is 5% of the net rent (300 + 45 VAT) and is confirmed on 1 August.

| Date | Entry | Lines |
|---|---|---|
| 01 Aug | E01 INV | Dr 1122 6,900 · Cr 2122 6,000 (S, base 6,000) · Cr 2122 900 (output, `owner:<L>`) |
| 01 Aug | E15 COM | Dr 2121 345 · Cr 4210 300 · Cr 2151 45 |
| 10 Aug | E03 | Dr 1113 3,000 · Cr 1122 3,000 · Dr 2122 3,000 · Cr 2121 3,000 |
| 20 Aug | E06 CRN | Dr 2122 1,000 · Dr 2122 150 · Cr 1122 1,150 |
| 20 Aug | E36 COM credit note (draft created by E06, approved the same day) | Dr 4210 50 · Dr 2151 7.50 · Cr 2121 57.50 (1,000 / 6,000 of the COM document) |

**Balances after 20 August:**
- 1122 = 6,900 − 3,000 − 1,150 = **2,750**, the tenant's open balance, and 2122 = −2,750 (the mirror holds).
- 2121 = 3,000 − 345 + 57.50 = **2,712.50**: collected 3,000 less commission on the rent actually billed (287.50). The legacy dues report shows 2,655 until it counts commission credit notes; R3 lists the difference as a known explanation.
- 4210 = 250 and 2151 = 37.50. The account's P&L shows only its commission.
- Agent rent is never deferred, so 2131 is not used.

The same events in Owner mode (principal, straight-line on; the installment covers 1–31 August):
- 01 Aug E01: Dr 1121 6,900 · Cr 2131 6,000 · Cr 2151 900. E15 is skipped (`self_commission`).
- 10 Aug E03: Dr 1113 3,000 · Cr 1121 3,000.
- 20 Aug E06: Dr 2131 1,000 (the unreleased balance absorbs the reduction) · Dr 2151 150 · Cr 1121 1,150.
- 31 Aug E35: Dr 2131 5,000 · Cr 4120 5,000. August revenue is 5,000, AR is 2,750 and 2131 is 0.

### 4.6 Contract termination "mark as paid" under v2: **refuse**

**Decision.** `POST /contracts/:id/terminate` with `mode:"paid"` and `DELETE /contracts/:id?mode=paid` return **409** under v2. The code is `FINANCE_V2_MARK_PAID_REFUSED`, with a bilingual message. The v2 End-contract dialog replaces the "mark as paid" option with three honest choices:

1. **"Record the remaining collections."** The user gives a date, a method and a bank account. The dialog creates real collections through the v2 collection path, so posting is E03 and statuses are recomputed from Σ collections.
2. **"Write off the remaining balance"** (needs the approve capability; §8.1). This creates a `finance_write_offs` row and posts E24. The covered installments move to `cancelled`, and E05 skips any installment listed in a write-off (`written_off`), so AR is never cleared twice. Uncharged future installments are cancelled and post nothing.
3. **"Cancel unpaid installments"** (the existing `mode:"cancelled"`). It posts E05 for installments charged at their due date. Installments covered by a confirmed tax invoice are refused, and the dialog tells the user to issue a credit note.

**Every open installment gets a disposition, and nothing is charged after the end.** Legacy terminate without `mode` leaves every future row `pending` (`contracts.module.ts:1786-1808`), and `mode:"cancelled"` deliberately keeps any row that holds collections (`:1813-1824`). Left alone, the recognizer would keep charging rent, revenue and VAT after the contract ended. Under v2:
- The v2 terminate and DELETE overrides set `finance_contract_dims.ended_on` (the termination date), and the recognizer never charges an installment of a `terminated` or `cancelled` contract with `due_date > ended_on` (§4.1, §5.6).
- The v2 End-contract dialog lists every open installment and requires one of the three choices above for each (the default is "cancel" for rows due after the end date and "collect" for rows already due). The API refuses a terminate body that leaves an open row without a disposition (400 `FINANCE_V2_DISPOSITION_REQUIRED`).
- A **part-collected** row due after the end date keeps its collections; only the uncollected remainder is removed, through a write-off (E24) or, if it was never charged, by recording its collected part as the tenant's credit (refund or apply, §8.2 c). It is never cancelled as a whole and never charged.

**Why not post "something honest" for "paid":**
- "Paid" asserts that cash arrived.
  - Posting Dr Bank without cash makes the cash book and the bank reconciliation lie.
  - Posting a write-off or a credit note silently reinterprets what the user said, which misstates revenue or VAT (a credit note also has ZATCA consequences).
- The only honest options need facts the user has not given: when the money arrived and where it went, or that it will never arrive. So the system asks for them.
- There is no UI impact beyond the v2 dialog. The DELETE `mode=paid` path is API-only (web:`lib/api-hooks.ts:689-692` calls DELETE without `mode`; D§1.2.7).

### 4.7 Late events and closed periods

- The engine computes `ensurePeriod(event_date)`.
  - If that period is `open`, then `entry_date = original_date = event_date`.
  - If it is `closed` or `locked`, **or the entry carries VAT lines and the period has `vat_locked_at`**, then `entry_date` is the first day of the **earliest open (and, for VAT lines, not VAT-locked) period after `event_date`**, `original_date = event_date`, and `is_late = true`. The entry gets the warning `late_posting`, and the outbox payload records the closed period id.
  - If no later period is open, the next month's period is created and is open by default.
- Reports select by `entry_date`, so closed periods never change.
  - A "Late postings" list (`/finance/v2/journal?late=true`) shows each late entry's original date.
  - The VAT return shows late VAT-bearing lines in a separate "prior-period items" block with their original dates. The user decides whether they go into box 14, corrections (allowed only within ±5,000 SAR of net VAT), or a voluntary disclosure.
- Manual journals and opening balances **cannot** be late; they are never moved to another period.
  - In a `closed` period a manual journal is accepted from a holder of the settings capability (an audit adjustment), provided it carries no VAT attributes when the period is VAT-locked.
  - In a `locked` period it is refused (409) and must be re-dated by the user.

---

## 5. Posting engine

Module: `src/modules/finance-v2/`, which contains:
- `flag.service.ts`
- `ledger-emitter.service.ts` (enqueue)
- `posting-worker.service.ts`
- `recognizer.service.ts`
- `rules/*.ts` (pure functions)
- `facts/*.ts` (loaders that build `EventFacts`)
- `journal.repository.ts`
- `overrides/*.ts` (the v2 versions of legacy handlers)
- `reports/*.ts`
- `controllers/*.ts`
- `lock-keys.ts` (every advisory-lock constant, §2.3.7)

**Dependency injection without cycles.** Two Nest modules:
- `FinanceV2CoreModule`: `FinanceFlagService`, `LedgerEmitter`, `JournalRepository` and the lock pool. It imports **nothing** from the legacy modules. The legacy modules (billing, payments, contracts, reports, dashboard, ejar, admin) import only this module, which is how their added fork and hook lines get the flag and the emitter.
- `FinanceV2Module`: the overrides, the worker, the recognizer, backfill, reports and controllers. It imports the core module and the legacy modules it needs.

`forwardRef` must not be used; a cycle is a design error to fix, not to paper over.

### 5.1 Enqueue: the outbox, written transactionally where possible

`LedgerEmitter.emit(ctx, ev)`, where `ctx = { db | tx, scope, actorId }` and `ev = { sourceType, sourceId, event, occurredOn, facts }`:

1. `if (!ctx.fv2) return;`. The flag was resolved once at handler entry, before any transaction (§1.2), so nothing else runs for flag-off accounts.
2. `facts` are a **snapshot of the source rows only**, built by the caller's `facts/*` loader from rows it already holds, plus at most a few scoped selects:
   - amounts as strings
   - frozen dimensions (§4.3)
   - the treatment (principal or agent)
   - VAT groups
   - for collections: its classification (§4.4.1)

   **Ledger state is never frozen at enqueue**: whether an installment is already charged, by what, how much advance VAT is booked, and how much 2131 is unreleased are all read **at post time** by the per-account serial worker (§5.3). Freezing them at enqueue made two orderings wrong: an invoice confirmed while its due-date charge was still queued would have charged in full and then failed on the marker, and a cancellation queued before a pending charge would have skipped and left AR overstated.
3. The emitter inserts into `ledger_outbox`, with `on conflict (user_id, source_type, source_id, event) do nothing`.
   - **Inside the source transaction** when the path has one: `addCollection`, `collect`, contract create and rebuild (D§1.0). It runs in a **savepoint**, `tx.transaction(async sp => …)`, wrapped in `try/catch`. A failed insert rolls back only the savepoint, logs `finance_v2.enqueue_failed` to `app_logs`, and returns. The event then commits atomically with the money change, or not at all, never half.
   - **Immediately after the last write** on paths without a transaction:
     - receipt voucher, terminate, collect-deposit, expenses, payouts
     - Ejar import and bulk import
     - approve
   - Two of those paths get a transaction under v2: `createReceiptVoucher` and `terminate`, both of which leave partial state on a crash today (D§1.0). The v2 overrides wrap them in `db.transaction` with an advisory lock, fixing the MAX+1 receipt-number race at `receipt-number.ts:13-27` for flag-on accounts. Their outbox inserts are then transactional as well.
4. **After the source transaction resolves** (not from inside it, where a kick would fire before the commit), the handler calls `worker.kick(scope)`, so posting normally lands within a second.

**The gap: a crash between a non-transactional write and its enqueue.** The **repair sweep** closes it. It runs catch-up backfill (§6) nightly at 03:30 Riyadh for every flag-on account; a run takes a per-account advisory lock and inserts only missing keys. The sweep's summary lists every event it added (`origin='repair'`). A non-zero count is itself a signal on the posting-errors screen.

### 5.2 What goes in the payload

Every fact the rule needs goes into the payload, so a rule never re-reads a source row that may have been deleted (rebuild) or edited since. The payload is JSON with string amounts and is kept on the resulting entry (`journal_entries.payload`) for audit.

The engine reads live data only for:
- account resolution: `system_key` to `accounts.id`, and bank account to GL account
- period state

### 5.3 The worker: per-account serial, idempotent, and retried

`PostingWorker` follows the `NewsSchedulerService` pattern (`news.scheduler.service.ts:52-65`):
- It uses `setInterval` with a 5-second tick, plus `kick(scope)`. It sets `unref()`, and `FINANCE_V2_WORKER_DISABLED=1` switches it off, for tests.
- **Per tick:**
  - select distinct `user_id` from `ledger_outbox` where `status='pending' and next_attempt_at <= now()`
  - skip accounts whose `ledger_started_at` is null (§1.5)
  - for each account, take `pg_try_advisory_lock(hashtextextended('fv2:'||user_id, 0))` **on a dedicated client from an auxiliary `lockPool`** (`createAuxPool`, `db/src/index.ts:63-66`), held for the whole tick and released on that same client, exactly as `news.lock.ts:17,30,47` does. A session lock taken through the shared Drizzle pool would land on an arbitrary pooled connection and could be unlocked on another, leaking the lock and starving the account. Skip the account if the lock is taken. Only one worker per account at a time, across processes, makes posting order deterministic.
  - process that account's due rows **in `id` order**, up to 200 rows per tick; each row's transaction runs on the normal pool
- **Per row**, in one transaction:
  1. `select … for update skip locked`.
  2. Load the **post-time state** the rule needs, inside this transaction: active charge markers of the installments involved, advance VAT booked, unreleased 2131 per installment, open balances. Then `rule(facts, state)` produces lines in halalas, followed by `assertBalanced` and `assertAgentMirror`. Because rows are processed serially per account in `id` order, the state a row sees is deterministic.
  3. If there are no lines, set `status='skipped', skip_reason=…`.
  4. Otherwise:
     - resolve accounts and the period (§4.7)
     - allocate `entry_no` under `pg_advisory_xact_lock(user_id, <entry_no key>)`, the same negative key (§2.3.7) used by manual approval and manual reversal, which post outside the worker
     - insert the entry with `on conflict … do nothing returning id` (§2.4.4), then its lines
     - update `finance_installment_charges` and any other state the rule owns
     - set `ledger_outbox.status='posted', entry_id=…`
  5. **Commit.** The deferred balance trigger runs here.
- **Idempotency key already present.** The `on conflict do nothing` insert returns no id (a raw `23505` would abort the transaction, so it is never allowed to happen). The worker selects the existing entry and marks the row `posted` with its id if the payloads match; otherwise `failed` with `KEY_COLLISION`. That is the idempotency contract.
- **Any other error.** The worker increments `attempts` and sets `last_error` and `last_error_code` (for example `ACCOUNT_INACTIVE`, `PERIOD_LOCKED`, `UNBALANCED`, `MISSING_FACT`).
  - Backoff is `next_attempt_at = now() + min(2^attempts × 30s, 6h)`.
  - After **8 attempts** the row becomes `status='failed'`.
- **Order after a failure.** Later events for the same account keep posting, **except** events that depend on a failed or pending row: a reversal whose original is not yet posted, and a charge-state-dependent event (E01, E05, E34, E35) for an installment that has a failed or pending earlier event. Those stay `pending` with `blocked_on = <outbox id>` and are released when the blocking row posts or is dismissed. Reconciliation R6 shows the outstanding amount.

### 5.4 Reversals

- **`reverse(entryId, {reason, sourceEvent})`** does the following:
  - posts a new entry with the lines mirrored (debit ↔ credit)
  - sets `origin='reversal'`, `reversal_of = entryId`, and `event = 'reversal:' + original.event` (or the triggering event)
  - dates it at the triggering event's date, or the next open period if that one is closed
  - in the same transaction, sets the original to `status='reversed', reversed_by, reversed_at`, the only update the immutability trigger allows
- **The reversal nets to zero on every account and dimension by construction.** Test §11.1-c checks it.
- **Reversal events** (E18 deletes, E19 deletes, E22, E27, E31, and the reverse-and-replace step of E01) carry the original key.
  - If the original is still `pending` or is `failed`, the reversal stays `pending` with `blocked_on = <original outbox id>`; it is never skipped just because the original has not posted yet. Otherwise a user could retry a failed original after its reversal had been skipped, and the original would post and never be reversed (a deleted expense staying booked).
  - When the original posts, the reversal is released and posts next. When the original is **dismissed** or `skipped` by rule, the reversal becomes `skipped` with `nothing_to_reverse`.
- **Manual reversal** (`POST /finance/v2/journal/:id/reverse`) is allowed only for `origin in ('manual','opening')` and needs the approve capability. Automatic entries are corrected only by correcting the source document, so the ledger never disagrees with the sub-ledger.

### 5.5 The posting-errors list

`GET /finance/v2/posting-errors` returns outbox rows that are `failed`, or `pending` with `attempts > 0`. Each row shows:
- the source, as a link to the document, collection or expense
- the event and the business date
- the attempts and the last error, in plain Arabic and English per code
- the actions **Retry**, which needs the approve or money capability and sets `attempts=0, next_attempt_at=now()`, and **Dismiss**, which needs the approve capability and a reason. Both are audited with an explicit `audit_logs` insert in the same transaction, because the audit interceptor skips POST (`audit.module.ts:32`)

A separate tab lists `skipped` rows with their reason, so "not posted" is never invisible.

A badge on the Accounting section header shows the count of failed rows. The period-close check (§8.1) refuses to close a period with failed or pending events dated inside it.

### 5.6 The recognizer (due-date charges)

- It runs from the same worker at **00:10 Asia/Riyadh** daily, plus after every backfill, and only for accounts with `ledger_started_at` set. Each run is idempotent.
- **Charges.** For each such account it finds installments with **`due_date < riyadhToday()`** (the day after the due date; the entry is still dated `due_date`, §4.1) that meet all of these:
  - `payments.deleted_at is null`, and the contract's `deleted_at is null`
  - status is not `cancelled` (`settled_external` rows **are** charged; their settlement is E33)
  - the contract is not `terminated`/`cancelled` with `due_date > finance_contract_dims.ended_on`
  - description is not the deposit description
  - no **active** row in `finance_installment_charges` (`reversed_at is null`)
  - no confirmed charge document covering them, whatever its date (that document is posted by E01, which charges the installment)
- It enqueues `payment,id,charge` (or `charge:g<n>` for a later generation) with `origin='recognizer'`, and E33 for `settled_external` rows.
- **Releases.** For every principal rent charge with an unreleased 2131 balance, it enqueues E35 for each month-end that has passed inside the coverage window (§4.1).
- In cutover mode it considers only installments with `due_date >= ledger_go_live_date`. Earlier ones are in the opening balance.

### 5.7 How it never blocks the existing action

- There are three guards. The flag is read outside the transaction. The enqueue runs in a savepoint with `try/catch`. The worker is asynchronous, so rules, accounts and periods never run inside the user's request.
- **The one deliberate v2 behaviour change is refusals**: "mark as paid", the locked `PATCH /payments` fields, and cross-landlord credit apply. Those come from the overrides, not from posting, and they happen **before** any write.
- A closed period **never** refuses a user action. The event posts late (§4.7). Only manual journals are refused in a closed period.

---

## 6. Backfill

**Entry points:**
- **CLI:** `pnpm exec tsx scripts/finance-v2-backfill.ts --account <scopeUserId> [--mode full|cutover|catchup] [--cutover YYYY-MM-DD] [--dry-run] [--allow-late]`. It refuses to run unless `DATABASE_URL` is set explicitly on the command line and `API_PORT` is not 4000 (DARA-NOTES §1: `.env` points at production). It prints the host it will write to and requires `--yes` for a non-dry run.
- **Admin:** `POST /api/admin/finance-v2/:accountUserId/backfill` with `{ mode, cutover?, dryRun }`. The default is `dryRun=true`. The route is SuperAdmin only.

Both call `BackfillService.run()`.

### 6.1 Preconditions

- For a real run: the flag is on, the chart is seeded, and `accounting_mode` is set. A **dry run** needs none of these (it may run while the flag is off, §1.5); it uses the template chart in memory and the mode given in the request.
- The run takes `pg_advisory_lock(hashtextextended('fv2:'||user, 0))`, the same key as the worker, **on a dedicated `lockPool` client held for the whole run** (§5.3), so live posting for the account pauses while it runs and the lock cannot leak onto a shared pooled connection.
- A successful real run sets `ledger_started_at` if it is null (§1.5).
- If any period is `closed` or `locked`, the run refuses unless `--allow-late` is given. In that case the events route to later open periods (§4.7) and the summary lists every late entry.

### 6.2 Modes

- **`full`** posts every historical event at its original date. This is the right mode for an account whose whole history is in Dara, including the beta account.
- **`cutover --cutover D`**:
  1. It builds an **opening-entry proposal** dated D−1 from the sub-ledgers as of D−1, as a **draft** `manual_journals` row of `kind='opening'`. It never posts it: the one-posted-opening index (§2.3.4) allows a single opening, and the user completes and approves it (§6.7). The proposed lines are:
     - AR per tenant, contract and landlord: charged but unpaid, net of collections; and **tenant credit balances** (collections on uncharged installments) as their own lines
     - 2131 unearned rent: the unreleased part of principal rent charged before D (straight-line on)
     - output VAT (2151) and input VAT (1151) for the VAT period that contains D−1 and is not yet filed, from documents and expenses in that period
     - DEP per contract
     - LP per agent landlord, on the same basis as the dues report
     - 2122/1122 per agent tenant
     - Cr 3900 for the balancing difference

     Bank and cash are **not** inferred. The user types them in on the opening-entry screen, which starts from this proposal.
  2. It then posts only events with a business date ≥ D. `settled_external` history is naturally excluded.
- **`catchup`** is `full`, but it inserts only keys that are missing. It is used after re-enabling the flag and by the nightly repair sweep (§5.1).

### 6.3 Event extraction (sources → events)

| Source | Selection | Event, date |
|---|---|---|
| `simple_invoices` | `status='confirmed'`, `deleted_at is null`; kind null/`invoice`/`manual`/`rent_receipt`/`agency_fee`/`commission`; type invoice, credit or debit | E01/E06/E07/E08/E15/E17 at `issue_date` (fallback `confirmed_at` Riyadh) |
| `simple_invoices` `kind='deposit'` | confirmed, **or** `cancelled` with `contracts.deposit_status='returned'` | E09 at `issue_date` (unlinked amount, §4.4.1), plus E10 under the key `simple_invoice,<voucherId>,deposit_refunded`: from the `finance_deposit_refunds` row that lists the voucher when there is one (its amount and `refunded_on`), otherwise at the inferred date frozen by the first run (`inferred_date`) |
| `payments` | the same selection as the recognizer (§5.6), evaluated as of each date: past due, not covered by a confirmed document **at that date**, not cancelled, deleted, deposit or after the contract's `ended_on` | E02 at `due_date`; when a covering document is confirmed later, E01's reverse-and-replace at the document's date. `settled_external` rows also get E33 |
| principal rent charges | every month-end inside the coverage window up to the run date | E35 releases |
| `payment_collections` on uncharged S installments | the advance-VAT condition (§4.1) | E34 at `collected_date` |
| `payments` that are `cancelled`, have no collections, and are past due | — | **not charged** (an unknown cancel date is treated as never charged) and listed as `cancelled_history` in the dry-run |
| `payment_collections` | all rows (hard-deleted ones no longer exist, which is consistent) | Classified by the **same** classifier as live posting (§4.4.1), which reads every v2 side table, at `collected_date` |
| `contracts` with `deposit_status='forfeited'` and no conversion collection | — | E11 at the inferred date frozen by the first run (`inferred_date`) |
| `expenses` | `deleted_at is null` | E18 `rev:1` at parsed `expense_date` (fallback `created_at` Riyadh plus `date_unparsed`) |
| `landlord_payouts` | `deleted_at is null` | E19 at parsed `transfer_date` (same fallback) |
| v2 tables (`finance_deposit_refunds`, `tenant_credit_actions`, `finance_write_offs`, `manual_journals` posted) | — | their events |

**Deleted sources.** In `full` mode on a fresh ledger, a soft-deleted expense or payout with no posted entry is skipped as a pair (net zero). In `catchup` (and the nightly repair sweep), for **every soft-deleted source whose `rev:<n>` / `created` entry is posted and not reversed**, the sweep emits the missing `reversal:rev:<n>` / `reversal:created` (`reports.module.ts:385-389,464-468`). That is exactly the case the sweep exists for: a lost live reversal enqueue.

**The sweep must never double-post.** A property test runs random live sequences, then catch-up, and asserts the trial balance is identical to live posting alone (§11.2).

**Facts are computed "as of" each event**, so a backfilled entry matches what live posting would have produced:
- Events are posted through the same worker in chronological order (§6.4), so the post-time state each event sees (charge markers, advance VAT, unreleased 2131) is the state at that date, exactly as live posting would have seen it.
- A due-date charge is extracted only when no covering document existed on the day after the due date; a document confirmed later produces its reverse-and-replace at its own date.
- For a credit note, the open balance is the referenced invoice's charge minus collections dated on or before the note.

### 6.4 Ordering

The sort key is `(business_date, rank, source_created_at, source_id)`. `rank` orders events within a day:

1. charges: documents (E01/E07/E08/E17), then due-date charges (E02), then external settlements (E33)
2. deposits received (E09)
3. collections (E03/E12b), each followed by its advance VAT (E34)
4. notes (E06)
5. commission (E15/E16)
6. refunds (E04/E10/E20)
7. conversions and forfeits (E11/E12)
8. expenses and payouts (E18/E19)
9. month-end releases (E35), then the VAT settlement (E37)

The events are inserted into `ledger_outbox` in this order, `origin='backfill'` with `backfill_run_id`, so the worker's `id` order is the chronological order. Charge state is read at post time (§5.3), so this order is what makes a backfilled entry equal the live one.

### 6.5 Dry-run output

A dry run writes **nothing** except its `finance_backfill_runs` row. It runs the rules in memory and returns:

```jsonc
{
  "account": 123, "mode": "full", "asOf": "2026-09-26",
  "events": { "total": 412, "new": 412, "alreadyPosted": 0, "byType": { "E01": 24, "E02": 38, "E03": 57, "...": 0 } },
  "entries": { "count": 398, "skipped": { "self_commission": 0, "assumed_deduction": 2, "...": 0 } },
  "trialBalance": [ { "code": "1121", "debit": "…", "credit": "…" } ],   // projected
  "controls": { "AR": { "ledger": "…", "subledger": "…", "diff": "0.00" }, "DEP": { }, "LP": { } },
  "warnings": [ { "code": "vat_without_tax_invoice", "count": 4, "sample": [ { "sourceType": "payment", "sourceId": 9 } ] },
                { "code": "paid_without_collection", "count": 3, "sample": [ ] },
                { "code": "inferred_date", "count": 6 }, { "code": "date_unparsed", "count": 0 } ],
  "lateEntries": [],
  "sampleEntries": [ /* first 20 entries with lines */ ]
}
```

The admin UI renders this as a report and offers "Run for real" only after it has been shown.

### 6.6 Re-runnability

- Every event's key equals the live key, and the outbox and ledger both have unique indexes on it. A second run therefore inserts nothing: `new: 0`, and the posted count does not change. Test §11.3-b checks this.
- A live event already posted before the backfill is `alreadyPosted`.
- A run killed part-way through is simply re-run.

### 6.7 Opening balances

- **`POST /finance/v2/opening-balances`** creates a `manual_journals` row of `kind='opening'`. It goes through approval (§8.1) and posts one entry, `origin='opening'`. At most one posted opening entry per account is allowed (a partial unique index).
- The entry is dated before any other entry. The screen pre-fills the cutover proposal (§6.2), and the user adds bank, cash, fixed assets and equity.
- It must balance (the DB trigger). Anything the user cannot allocate stays in 3900, and the balance sheet shows 3900 as its own line until it is cleared.
- **Correcting** the opening entry means a reversal plus a new opening. The partial unique index counts only `status='posted'`.

---

## 7. Report definitions

Every report is served at `GET /api/finance/v2/reports/<name>` (§10). Each takes `lang=ar|en` for labels, returns amounts as **strings with two decimals**, and follows these rules:

- **Dates are inclusive** `YYYY-MM-DD` values in Asia/Riyadh. The default `to` is `riyadhToday()`.
- **Only the calling account's rows are read:** `where user_id = :scope` on every table, including joins.
- **Every report exports to Excel and PDF, in Arabic and English, RTL correct** (§7.12).
- **Every figure drills down.** A row links to `GET /finance/v2/journal?accountId&from&to[&dims]`, and each entry links to its source (§10.2).
- Journal lines are always read with `entry_date` between the bounds. Reversed entries and their reversals are **both included**, because they net to zero.

### 7.1 Trial balance

**Parameters:** `from`, `to`, and an optional comparative range `cmpFrom`, `cmpTo`, which defaults to the same-length period immediately before. Optional filters are `ownerId`, `propertyId` and `level` (`leaf` or `group` roll-up).

```sql
-- opening: balance-sheet accounts: all lines < :from ; P&L accounts: lines in [fy_start(:from), :from)
select a.id, a.code, a.name_ar, a.name_en, a.type,
  sum(case when l.entry_date < :from and (a.type in ('asset','liability','equity') or l.entry_date >= :fyStart)
           then l.debit - l.credit else 0 end)                                           as opening,
  sum(case when l.entry_date between :from and :to then l.debit  else 0 end)            as period_debit,
  sum(case when l.entry_date between :from and :to then l.credit else 0 end)            as period_credit
from accounts a
left join journal_lines l on l.account_id = a.id and l.user_id = :u and l.entry_date <= :to
     [and l.owner_id = :ownerId] [and l.property_id = :propertyId]
where a.user_id = :u
group by a.id;
```

- **Closing** is opening plus period debits minus period credits. Balances are shown in debit and credit columns according to their sign.
- **Prior-year P&L** that has not been closed into retained earnings (no closing entry) appears on a synthetic row, "Retained earnings – unclosed prior years" under 3300. It is Σ(revenue and expense lines before `fyStart`). Without it the opening column would not balance.
- **Footer.** Totals of each column. The report asserts Σ opening debit = Σ opening credit, and the same for closing. For an unfiltered report a mismatch is impossible, and the report shows it in red if it ever occurs.
- **Filtered by landlord or property,** it balances for automatic entries, because all their lines carry the dimensions (§4.3). A manual line without the dimension goes into a row "Unallocated manual lines", which keeps the filtered TB balanced.
- **Group roll-up** sums descendants through a recursive CTE on `parent_id`.
- **The year-end closing entry** (`origin='closing'`, §8.1) is excluded from the period columns by default, so a December or full-year TB still shows revenue and expenses. `postClosing=true` includes it.

### 7.2 General ledger per account

**Parameters:** `accountId` (or `accountIds`), `from`, `to`, dimension filters, `page`.

- **The opening row** is the balance before `from`, using the TB opening rule for P&L accounts.
- **Each line** shows `entry_date`, `entry_no`, source (a type label, the document number, and a link), memo, counterparty (tenant or landlord name, resolved by id at read time and falling back to the payload snapshot), debit, credit and the **running balance**.
  - The running balance is a window function: `sum(debit - credit) over (order by entry_date, entry_id, line_no)` plus the opening.
  - It is signed by the account's `normal_balance`.
- Late entries show their original date in a tooltip.

### 7.3 Income statement (P&L)

**Parameters:** `from`, `to`, and optional `ownerId`, `propertyId`, `columns=total|property|landlord|month`, plus a comparative range.

- **Revenue** is Σ(credit − debit) over lines on `type='revenue'` accounts. **Expenses** are Σ(debit − credit) over `type='expense'` accounts. Lines of `origin='closing'` entries are always excluded (otherwise a full-year P&L would net to zero), in the current and the comparative columns. Both are grouped by the account tree. The result is Net profit = revenue − expenses.
- **In Manager mode, agent rent never reaches the P&L.** It sits on 2121 and 2122. A note under the statement says so and shows, as a memo, "Rent collected on behalf of landlords" (period credits on 2121 from E03). The accountant can see the volume without it being mistaken for revenue.
- **By landlord or property,** only lines carrying that dimension are included. Company overheads (5200 lines without a property) appear only on the total view, and on a split view they sit in an "Unallocated" column.

### 7.4 Balance sheet

**Parameter:** `asOf`, plus the optional filters `ownerId`, `propertyId`, `presentation=net|gross` (agency balances) and a comparative `cmpAsOf`.

- **Assets, liabilities and equity** are account balances at `asOf`: all lines with `entry_date <= asOf`.
- **Equity** also carries two computed lines:
  - **Current year profit** = Σ P&L lines from `fyStart(asOf)` to `asOf`, excluding `origin='closing'` lines (the closing entry's credit to 3300 already carries the closed year)
  - **Retained earnings – unclosed** = Σ P&L lines before `fyStart`, unless a year-end closing entry exists
- **Reclassifications** (presentation only, computed in SQL per dimension, never posted), applied **in this order**:
  1. **Agency balances.** With `presentation=net` (the default), 1122 and 2122 offset line for line (they mirror; §4.2) and are shown as a memo: "Managed tenant receivables SAR X, held for landlords", with agent tenants' credit balances shown in the same memo. With `gross`, both appear, and step 2 then covers 1122 as well.
  2. **Tenant credit balances.** For each tenant with a net *credit* balance on **1121** (and on 1122 only under `gross`), that amount is moved out of receivables into the liability "Tenant advances and credit balances". AR is then shown as the sum of **debit** balances only. Reclassifying 1122 credits under `net` would double-count agent advances, which already sit in 2121 (E03 agent posts Cr LP).
  3. **Landlord debit balances.** For each landlord with a net *debit* on 2121, the amount is moved to the asset "Due from landlords".
- **Check line:** Assets − (Liabilities + Equity) = 0, and the report shows the difference if it is non-zero.

### 7.5 VAT return summary (ZATCA VAT return layout)

**Parameters:** `year`, and either `quarter` or `month` according to `vat_filing_frequency`. `seller` is `account` (the default) or `owner:<id>`: a landlord who is a separate VAT registrant, for their statement or for Owner-mode accounts with several legal sellers.

The source is `journal_lines` with `seller_key = :seller` and `entry_date` in the period. For output lines, the base comes from revenue lines (or 2122 lines for agent landlords) with `vat_category` set, and the VAT from lines with `tax_role='output'`. Input comes from `tax_role in ('input','input_nonrecoverable')` plus the expense base.

**Adjustments** are lines with `doc_class in ('credit','charge_cancel')`, or a debit note's positive adjustment (`doc_class='debit'`), as ZATCA's "Adjustments" column expects.

| Box | Label (ZATCA form) | Amount (SAR) | Adjustment (SAR) | VAT (SAR) |
|---|---|---|---|---|
| 1 | Standard rated sales | Σ vat_base, S, `doc_class in (invoice,charge,advance,rent_receipt)` (an advance's base is net of the VAT later netted from its charge, so nothing is counted twice) | Σ vat_base, S, `doc_class in (credit,charge_cancel,debit)` | Σ output VAT on those lines (signed) |
| 2 | Sales to citizens (private healthcare and private education) | 0 (not applicable; editable) | 0 | 0 |
| 3 | Zero-rated domestic sales | Σ base, Z | adjustments Z | — |
| 4 | Exports | 0 (not applicable) | 0 | — |
| 5 | Exempt sales | Σ base, E | adjustments E | — |
| 6 | Total sales | 1 + 2 + 3 + 4 + 5 | Σ | Σ |
| 7 | Standard rated domestic purchases | Σ base of expense lines with recoverable input VAT | reversed or edited revisions in the period | Σ `tax_role='input'` |
| 8 | Imports subject to VAT paid at customs | 0 (not captured; editable) | 0 | 0 |
| 9 | Imports under reverse charge | 0 (not captured; editable) | 0 | 0 |
| 10 | Zero-rated purchases | Σ base of expenses with category Z | | — |
| 11 | Exempt purchases | Σ base of expenses with category E | | — |
| 12 | Total purchases | 7 + 8 + 9 + 10 + 11 | Σ | Σ |
| 13 | Total VAT due for current period | | | box 6 VAT − box 12 VAT |
| 14 | Corrections from previous period (±5,000 limit) | | | user input (the late-items block helps) |
| 15 | VAT credit carried forward | | | user input, or the previous v2 return's negative box 16 |
| 16 | Net VAT due (or claimed) | | | 13 + 14 − 15 |

The report also shows:
- **Out of scope (memo, not a box):** Σ base with category O. This covers unregistered landlords' rent (non-tax receipts), deposits forfeited as compensation (O by default) and anything else outside VAT.
- **Non-recoverable input VAT (memo):** Σ `tax_role='input_nonrecoverable'`, which is expensed to 5500.
- **Prior-period items:** late lines (§4.7) with their original dates.
- **Tax-invoice gaps:** VAT booked on due-date charges without a tax invoice (`vat_without_tax_invoice`), which the user should resolve before filing.
- **Cross-check against documents:** Σ confirmed documents' VAT (from `simple_invoices`, by the landlord who is the seller) against box 1 VAT. Differences are listed.

This summary prepares the return. It does not file it. Boxes 14 and 15 are user inputs, saved per period in `finance_vat_return_drafts`.

**Locking a return** (settings capability, audited explicitly because the interceptor skips POST and PUT is audited only generically):
- sets `vat_locked_at` on the months it covers. It does **not** set `status='locked'`: that would also block the non-VAT audit adjustments made after the Q4 return is filed. VAT-bearing lines dated in those months are then refused, or routed late for automatic postings (§4.7); non-VAT adjustments stay possible while the period is only `closed`.
- for `seller_key='account'`, posts the **VAT settlement** E37: Dr 2151 (box 6 VAT, signed) / Cr 1151 (box 12 VAT) / Cr 2152 net payable, or Dr 1152 when the net is a refund. Box 14 and 15 amounts are posted by a manual journal (template provided). Paying ZATCA is the manual template Dr 2152 / Cr bank.
- for `seller_key='owner:<id>'` (an agent landlord's summary), nothing is posted: that return is the landlord's own.

**Partial exemption.** An account with both exempt (residential) and taxable (commercial) supplies must apportion input VAT on overheads (VAT IR Art. 51). The input side of the summary applies the method in §8.2(b); it shows the ratio used and, in the last return of the fiscal year, the proposed annual true-up.

```sql
create table if not exists finance_vat_return_drafts (
  id serial primary key,                      -- source_id of the settlement entry (§7.5)
  user_id integer not null, seller_key text not null, period_start date not null, period_end date not null,
  box14 numeric(14,2) not null default 0, box15 numeric(14,2) not null default 0,
  locked_at timestamptz, locked_by integer, unique (user_id, seller_key, period_start)
);
```

### 7.6 AR aging (0–30 / 31–60 / 61–90 / 90+), part-paid correct

**Parameters:** `asOf` (default today), `ownerId`, `propertyId`, `tenantId`, `groupBy=tenant|contract`.

The report is built from the **sub-ledger**, so it works per open item. The ledger AR is then reconciled to it (R1).

**Open items as of `asOf`:**
1. **Installments not covered by a confirmed charge document** (deposit rows, `cancelled`, `settled_external` and deleted rows excluded).
   - `remaining = amount − Σ payment_collections.amount where payment_id = p.id and collected_date <= asOf`.
   - Negative (refund) rows are included, so a refunded part is owed again.
   - Written-off installments are excluded.
2. **Confirmed charge documents:** invoices, debit notes, rent receipts and agency-fee documents; not commission, which is billed to the landlord and has its own landlord aging tab.
   - Only documents with `issue_date <= asOf` count as covering (coverage is taken as of `asOf`).
   - `remaining = total − Σ credit notes whose billingReference = number and confirmed (issue_date <= asOf) − Σ collections applied to it (invoice_id = doc.id, or payment_id ∈ its covered installments) with collected_date <= asOf − Σ tenant_credit_actions(apply, target = doc) − write-offs`. A collection that matches on both `invoice_id` and `payment_id` is counted **once** (distinct collection ids).
   - The installments it covers are **not** counted again under item 1.
3. **Unapplied credit per tenant.** Collections with no installment and no charge document (the FIFO remainder, `billing.module.ts:1233`), the excess of items whose remaining is below −0.005, and credit notes in excess of their invoice. These are shown as a **negative "Unapplied credit" column** and are never netted into a bucket.

**Days past due** = `asOf − due_date`, where `due_date` is the installment's due date, or the document's `due_date`, falling back to the latest covered installment's due date and then to `issue_date`.

**Buckets** (items with remaining > 0.005):
- **Not yet due:** days < 0
- **0–30:** 0 to 30 (the due date is day 0)
- **31–60**, **61–90**
- **90+:** 91 or more

**Part-paid:** an installment of 6,900 with 3,000 collected ages 3,900 in its bucket. It is neither excluded (the E4 list bug) nor counted in full (the E2 dashboard bug).

**Rows and totals:**
- **Per tenant (or contract):** Not due, 0–30, 31–60, 61–90, 90+, total past due, total open, unapplied credit, and net.
- **Grand totals.**
- **Reconciliation footer:** see R1 (§7.10). The difference is shown.

### 7.7 Tenant ledger (running statement)

**Parameters:** `tenantId`, `from`, `to`, and optionally `contractId`.

The source is journal lines on tenant accounts (1121 and 1122) with that `tenant_id`, which exist for flag-on accounts:
- **Opening balance** at `from`.
- **Each movement** shows date, document number and type, description, charge (debit), payment or credit (credit) and a running balance. The types are:
  - invoice, rent receipt, due-date installment charge, advance VAT (E34), debit note (charges)
  - credit note, collection, deposit applied, write-off (credits)
  - refund (a charge)
- **Closing balance.** A positive balance is owed by the tenant; a negative one is the tenant's credit.
- **Deposit section** (separate, never mixed into the balance): received, refunded, forfeited or converted, and held at `to`, from 2141 lines with that `tenant_id`.

This is the E3 fix for v2 accounts. A tenant paid only on receipt vouchers shows each installment charged at its due date and each receipt as a credit, so the balance is 0.

### 7.8 Landlord statement (PDF)

**Parameters:** `ownerId`, `from`, `to`, `lang`.

**API (JSON):**
- **Header:** the landlord and the account (the manager) identities.
- **Opening balance** due to the landlord: 2121 with `owner_id`, before `from`.
- **Movements in the period:**
  - rent and fees collected: E03 on 2121, broken down by property, unit, tenant and document
  - deposits converted or forfeited (E11/E12), and deposits applied to the tenant's arrears (E12b, which credits LP)
  - commission (E15), showing net + VAT
  - expenses charged to the landlord (E18), showing supplier, net and VAT
  - payouts (E19)
  - refunds and credits (E04/E20)
- **Closing balance due.**
- **Memo:**
  - billed but uncollected rent: 2122 for that owner, per tenant
  - deposits held for that landlord's tenants: 2141 with `owner_id`
  - the **landlord's VAT summary** for the period: output VAT on their rent (box 1, 5 or O split) and input VAT on expenses charged to them, from lines with `seller_key='owner:<id>'`. The landlord needs these to file their own return.
- **Principal landlords** (the account holder, or Owner mode) get a "property performance" variant instead: revenue, expenses and net per property, from P&L lines with that `owner_id`.

**PDF** is generated client-side with the Arabic document pipeline, web:`lib/export-invoice.ts`:
- `ensureHostFontLoaded()`, then html2canvas-pro at scale 2, then jsPDF, paginated (`:354-408`)
- **the self-hosted, patched Readex Pro** (DARA-NOTES §5), not the Google Fonts copy used by `lib/export-pdf.ts:24`
- no `foreignObjectRendering`, no Arabic `letter-spacing`, and user values wrapped in `<bdi>` (DARA-NOTES §6)
- A4 portrait, with a table header repeated per page and page "x / y" in the footer
- the account's `<Logo>` in `currentColor`
- a "Prepared by Dara, beta ledger" footer note

A **Download PDF** button saves it, and a **Share** button uses `navigator.share` with the file where it is available. Nothing is emailed by the system (hard rule 5).

### 7.9 Cash and bank book

**Parameters:** `bankAccountId` (or all, grouped), `from`, `to`.

Lines on that bank account's `gl_account_id`, with opening balance, date, entry number, source document, counterparty, description, receipts (debit), payments (credit), running balance and closing balance.

Footer: total receipts and payments by method (from the collection metadata).

### 7.10 Reconciliation report (ledger against sub-ledgers)

**Parameter:** `asOf`. Every check shows the ledger figure, the sub-ledger figure, the difference and a drill-down list. **Differences are shown, never hidden or plugged.**

| # | Check | Ledger side | Sub-ledger side | Known explanations listed |
|---|---|---|---|---|
| R1 | AR control | Σ 1121 + 1122 per tenant | Σ remaining on **charged** items (charged installments and confirmed charge documents, §7.6) − Σ collections on **uncharged** installments (advances) − unapplied credit + Σ advance VAT booked (E34) not yet netted by a charge | failed or pending outbox events; installments `paid` with Σ collections < amount (`paid_unverified`) |
| R2 | Deposits held | 2141 per contract | Σ confirmed deposit vouchers + legacy deposit-row collections − `finance_deposit_refunds` − legacy refunds (cancelled vouchers with `deposit_status='returned'`, negative deposit-row collections) − converted or forfeited | inferred refund dates |
| R3 | Landlord payable (agent landlords) | 2121 per owner | Legacy landlord-dues `remaining` for that owner (`reports.module.ts:176-185`), recomputed read-only by calling the same function, **excluding `kind='agency_fee'` documents** (for flag-on accounts the v2 fork of `/reports/accounting` does the same) | **maintenance `estimated_cost` deducted by the dues report (`:127-131,165,176`) is not a posted expense**; commission collected in cash (E16); commission credit notes (E36); **forfeited deposits kept for the landlord (E11 credits LP; the dues report adds only converted vouchers, `:99-105`)**; **owner-linked expenses charged to the company (the dues report deducts every owner-linked expense, `:156-164`; v2 credits LP only for `charge_to='landlord'`)**; **payment-less collections on agency-fee documents (the dues report counts them as landlord rent, `:109-111`)**; pre-cutover history |
| R4 | Bank and cash | each bank account's GL balance | Σ collections (by meta account, or default by method) + deposit vouchers' unlinked amounts (E09; contract-create vouchers have no collection rows, `contracts.module.ts:1063-1080`) + commission paid in cash (E16) − tenant refunds (E04, E20 PVs) − payouts − expenses paid − deposit refunds (E10) ± opening and manual lines on the account | payments with no account chosen (defaulted) |
| R5 | Output VAT | 2151 plus the VAT attributes of agent 2122 lines, per seller | Σ VAT of confirmed documents + Σ VAT of due-date charges **not reversed** + Σ advance VAT (E34) not yet netted − notes − charge cancellations | `vat_without_tax_invoice` items |
| R6 | Posting completeness | entries per source key | a catch-up dry-run: keys that should exist | failed, pending or dismissed events, with amounts |
| R7 | Sub-ledger integrity (E7 detector) | — | installments `status='paid'` with Σ collections < amount; `cancelled` installments covered by a confirmed invoice; collections on deleted installments; open installments of ended contracts without a disposition; unreleased 2131 for periods after a contract's `ended_on`; VAT booked without a tax invoice | lists only; the user resolves each |
| R8 | Trial balance | Σ debit = Σ credit overall and per entry | — | must be zero (the DB guarantees it) |

### 7.11 Report permissions

All reports need the view capability (§10.1).

The landlord statement has one extra rule: an owner-mobile token (`ownerScopeId` set; `jwt-auth.guard.ts:57-79`) may fetch **only its own `ownerId`**. That is for a future mobile landlord view; the web does not use it.

### 7.12 Exports: Excel and PDF, Arabic and English, RTL

- **Excel** via web:`lib/export-excel.ts`, `downloadWorkbook(sheets, {rtl: lang==='ar'})` (`:184`).
  - Amounts are converted from API strings to `number` **only at the cell**, using `Number(s)` on a two-decimal string. That conversion is exact for display, and nothing is stored.
  - The number format is `#,##0.00`.
  - Every report sheet has a title row, a parameters row (range, filters, mode, generated-at in Riyadh time) and a totals row, with headers from `financeV2.*` locale keys.
- **PDF.**
  - Tabular reports use the same html2canvas + jsPDF pipeline as the landlord statement (not `window.print()` with the Google font), so Arabic shaping is the patched font's.
  - The page is `dir="rtl"` for Arabic, and numbers are `dir="ltr"` inside `<bdi>`.
- **CSV** of the journal (tier 3, accounting-software export) is out of scope until approved.

---

## 8. Feature designs

### 8.1 Core (brief §B): manual journal entries and fiscal periods

**Manual journal entries (قيد يدوي)**
- **Lifecycle.** A draft goes to `submitted`, then `approved`, then `posted`. At any point before `posted` it can be `rejected` or voided.
  - `POST /finance/v2/manual-journals` creates a draft with ≥ 2 lines.
  - Each line has `accountId`, `debit` or `credit` as a decimal string, `memo`, and optional dims.
  - Validation, in halalas:
    - Σ debit = Σ credit > 0
    - each line has exactly one side
    - every account is active, postable and in scope
    - every dim id belongs to the scope (checked with one query per dim type)
    - `entry_date` is in an `open` period, or in a `closed` one when the approver holds the settings capability (an audit adjustment); never in a `locked` one, and VAT attributes are refused in a VAT-locked month
- **Attachment.** It goes through the existing uploads flow, and the key is verified by `UploadsService`'s ownership check (`src/modules/uploads/uploads.controller.ts:94`, "every key goes through" the service). It is required on approval only when `amount > 10,000 SAR`, as a policy default (Q17).
- **Approval** (`/approve`) needs `journal.approve` (§10.1).
  - The approver must differ from the creator, unless the approver is the account holder. **Account holder** means `ownerUserId == null && ownerScopeId == null && role !== 'owner'`: owner-mobile tokens also carry `ownerUserId: null` (`jwt-auth.guard.ts:66-78`) and must never qualify. This keeps segregation of duties with a small-team escape hatch.
  - Approval posts **immediately** through the same `JournalRepository` (not the outbox, because this is a user action that should succeed or fail visibly). The key is `manual_journal,id,posted`.
- **Correction** is `POST /journal/:entryId/reverse`, which posts a reversal (§5.4). The user then drafts a new entry.

**Fiscal periods**
- **Periods** are monthly and created on demand (§2.3.3). The fiscal year start month comes from settings.
- **Close** (`POST /periods/:id/close`, settings capability) refuses when any of these holds:
  - `ends_on >= riyadhToday()` (a month cannot close before it has ended)
  - the recognizer has not completed a run after `ends_on` (charges and releases for the month may still be missing)
  - a catch-up **dry-run** finds keys dated in the period that are missing from the ledger (this covers the crash gap of §5.1)
  - outbox rows dated in the period are `pending` or `failed` (they must be posted or dismissed)
  - an earlier period is still open (periods close in order)
  - manual journals dated in the period are `submitted` but not approved

  Draft manual journals are only a warning. The close stores a TB snapshot hash in `finance_settings_events`.
- **Reopen** needs the settings capability and a reason. It is refused if the period is `locked` or any later period is closed.
- **Lock** is irreversible. It happens automatically when a VAT return draft is locked (§7.5), or manually.
- **Year end.** "Close year" runs only when periods 1–11 are closed. It posts a **closing entry** (`origin='closing'`) dated the last day of period 12: revenue and expense balances go to 3300. It then closes period 12. The balance sheet's "unclosed prior years" line is zero after that. The P&L, the TB period columns and current-year profit exclude `origin='closing'` lines (§7.1, §7.3, §7.4), so the closed year's statements still show its results.
  - **Refresh (added in build).** A manual adjustment approved into a closed month of a year that already has its closing entry would reopen that year's P&L. In the same transaction the journal repository posts `fiscal_year,<fy>,closing:adj:<entryId>` (`origin='closing'`, dated the year's last day) that closes the year's whole P&L residual to 3300. If period 12 is locked the adjustment is refused with 409 `YEAR_CLOSING_LOCKED`.
- **Audit.** Close, reopen, lock, year close, VAT-return lock, journal approve and reverse, write-off, retry and dismiss are all POST (or PUT) actions, which the audit interceptor does not record (`audit.module.ts:32`). Each handler writes its own `audit_logs` row in the same transaction.

### 8.2 Tier 1 (this release)

**(a) Bank accounts and the cash box**
- **CRUD** at `/finance/v2/bank-accounts`, with the settings capability for writes.
  - Creating an account creates its GL leaf under 1110 in the same transaction.
  - The IBAN is validated: `SA` + 22 characters, ISO 13616 mod-97 = 1, and the bank code is derived for display.
  - An account cannot be deleted once it is used. It is deactivated instead.
  - There is exactly one default per kind.
- **Selection.** Every v2 money dialog has an optional "Received into / Paid from" select that defaults from settings: collect installment, collect invoice, receipt voucher, collect deposit, payout, expense, deposit refund and tenant refund.
  - The web sends `bankAccountId` in the existing request body. The routes take `@Body() body: any` (`payments.module.ts:518`, `billing.module.ts:1103,1961`), so the ValidationPipe whitelist does not strip it.
  - The flag-on hook writes `finance_collection_meta` or `finance_payout_meta`. With the flag off the field is ignored, and the web never sends it then anyway.

**(b) Expenses with input VAT, supplier, attachment and edit**
- **`POST /finance/v2/expenses`** (expenses.write), in one transaction:
  - inserts the **legacy `expenses` row**, with `amount = gross` and `expense_date = 'YYYY-MM-DD'`, so every legacy report still sees it
  - inserts the `finance_expense_details` row
  - enqueues E18 `rev:1`
- **Fields:** date (a date picker), property or landlord (both **scope-checked**), category (lookup), amount entry mode (gross or net), VAT rate (15 / 0 / exempt / out of scope), supplier name, supplier VAT number (15 digits, starts and ends with 3), supplier invoice number and date, attachment, "Paid from" bank or cash, and "Charge to" (landlord or company). "Charge to" appears only for agent landlords in Manager mode.
- **Recoverability default:** recoverable only if **all** of these hold:
  - the VAT registrant is known: `charge_to='company'` and the account has a VAT number, or it is charged to a VAT-registered landlord
  - the category is S
  - the property is not residential

  Input VAT on costs of exempt residential letting is not recoverable (VAT IR Art. 49–51, apportionment). A mixed-use property defaults to non-recoverable, with a hint. The user can override, and the override is shown on the VAT report.
- **Overheads and apportionment** (`input_vat_method='direct_plus_ratio'`, the default; Q25). Input VAT on an expense attributable to a commercial (S) property is recovered in full; on a residential (E) property, not at all. Input VAT on **overheads** (an expense with no property, or a mixed-use property) of an account with both kinds of supply is recovered at a **provisional ratio**: taxable supplies (box 1 base) ÷ (taxable + exempt supplies, box 1 + box 5 base) of the previous fiscal year, or of the ledger to date in the first year. The recoverable part goes to 1151 and the rest to 5500 in the same entry. At year end the VAT summary proposes an **annual true-up** manual journal to the actual ratio; it is never posted automatically. `direct_only` turns the ratio off (all overheads non-recoverable unless overridden).
- **Expenses charged to a landlord** carry separate net and VAT lines (E18), with `vat_recoverable=false` by default unless the supplier invoice is addressed to the landlord (VAT IR Art. 49).
- **Edit** is `PATCH /finance/v2/expenses/:id`. It updates the legacy row and the details (`revision+1`), and enqueues `reversal:rev:<n>` then `rev:<n+1>`. An expense dated in a locked period cannot be edited (409).
- **Delete** uses the legacy DELETE plus the E18 reversal hook.
- **Legacy expenses** created while the flag was off get a details row lazily on first v2 edit. Backfill treats them as gross with no VAT.

**(c) Tenant credit balances: refund or carry forward**
- **"أرصدة المستأجرين الدائنة / Tenant credit balances"** lists tenants whose net tenant-account balance is below −0.005. It comes from the ledger and is also linked from the aging report's unapplied column.
- **Refund** is `POST /finance/v2/tenant-credits/refund` (payments.write), with `{tenantId, contractId?, amount, date, bankAccountId, method, reference}`. It issues a **payment voucher `PV-######`**, stored as `tenant_credit_actions` kind `refund`, and posts E20. The PV prints with the same document pipeline.
- **Apply** is `POST /finance/v2/tenant-credits/apply`, with `{tenantId, targetDocumentId | targetPaymentId, amount}`. It records the allocation and posts E21 (a reclass only when the contract or landlord differs; across landlords it is refused).
- **After a credit note is approved** on a fully collected invoice, the web (flag on) calls `GET /finance/v2/documents/:id/tenant-credit`, which returns `{amount}`, and offers "Refund now / Apply to next invoice / Keep as credit". The approve response itself is not changed, because approve is not forked for notes (§10.2).

**(d) Rent receipts (E9), the agency fee (E8), write-offs and deposit refund vouchers.** These are specified in §9, E7–E9, and §4.6.

### 8.3 Tier 2

**(a) Bank reconciliation** (`0067_finance_v2_tier2.sql`)

```sql
create table if not exists bank_import_profiles (
  id serial primary key, user_id integer not null, bank_account_id integer not null, name text not null,
  delimiter text not null default ',', encoding text not null default 'utf-8', skip_rows smallint not null default 0,
  date_col text not null, date_format text not null,          -- 'DD/MM/YYYY' | 'YYYY-MM-DD' | ...
  desc_col text, ref_col text, amount_col text, debit_col text, credit_col text, balance_col text,
  created_at timestamptz not null default now()
);
create table if not exists bank_statements (
  id serial primary key, user_id integer not null, bank_account_id integer not null,
  period_from date, period_to date, opening_balance numeric(14,2), closing_balance numeric(14,2),
  file_key text, imported_by integer not null, imported_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open','reconciled')), reconciled_at timestamptz
);
create table if not exists bank_statement_lines (
  id bigserial primary key, statement_id integer not null, user_id integer not null, bank_account_id integer not null,
  line_no integer not null, txn_date date not null, description text, reference text,
  amount numeric(14,2) not null,               -- + money in, - money out
  running_balance numeric(14,2),
  fingerprint text not null,                   -- sha256(bank_account_id|date|amount|reference|description|balance|occurrence)
  match_status text not null default 'unmatched' check (match_status in ('unmatched','auto','manual','ignored')),
  unique (bank_account_id, fingerprint)
);
create table if not exists bank_matches (
  id bigserial primary key, user_id integer not null,
  statement_line_id bigint not null, journal_line_id bigint not null,
  amount numeric(14,2) not null, method text not null check (method in ('auto','manual')),
  matched_by integer, matched_at timestamptz not null default now(),
  unique (statement_line_id, journal_line_id)
);
create unique index if not exists bank_matches_jl_once on bank_matches (journal_line_id);
```

- **Import.** The client uploads CSV text (at most 2 MB, 10,000 rows) together with a profile.
  - The server normalises Arabic-Indic digits and parses the dates. It accepts Gregorian dates only; a Hijri date is rejected with a clear message.
  - It skips duplicates by fingerprint, so re-importing an overlapping statement is safe.
- **Auto-match.** For each unmatched line, the candidates are unmatched journal lines on that bank account's GL account with **exactly the same amount** in halalas (signs consistent: money in matches a debit) and `|date diff| ≤ 3 days`.
  - The score is 100 − 10 × days, plus 50 when the reference or description contains the document's number (`RV-`, `PV-`, `INV-`, `JV-`) or the payer's IBAN tail.
  - A unique best candidate with a score ≥ 70 is auto-matched. Anything else becomes a suggestion.
- **Manual match** can be 1:1, 1:n or n:1, provided the amounts sum exactly. **Unmatched bank lines** (charges, transfers, profit) offer "Create entry", which pre-fills a manual journal against 5270, 4410 or another bank account, subject to approval.
- **Reconciliation statement:**
  - bank closing balance
  - − outstanding receipts (GL debits that are not matched)
  - + outstanding payments
  - = ledger balance

  A difference is shown. Completing the statement marks it `reconciled`, and its lines become read-only.

**(b) Scheduled rent reminders: built but disabled, and never sent in tests**
- **Tables** (in `0067`):
  - `reminder_settings(user_id pk, enabled boolean not null default false, offsets integer[] not null default '{-3,0,7}', channels text[] not null default '{sms}', template_ar text, template_en text, updated_at)`
  - `reminder_log(id bigserial, user_id, payment_id, offset_days, channel, status check in ('dry_run','sent','skipped','failed'), recipient_hash, created_at, unique(payment_id, offset_days, channel))`
- **Three independent gates must all be true to send:**
  1. the env `FINANCE_REMINDERS_ENABLED=1`, which is set **nowhere** (staging and production unset)
  2. `reminder_settings.enabled`, which cannot be set to true through the API while gate 1 is off (400)
  3. the flag is on
- **The sender** is an interface. The only binding registered is `DryRunReminderSender`, which writes `reminder_log` rows with `status='dry_run'` and a hashed recipient, and never calls Taqnyat or push. A real sender is a later, separate change.
  - Even then, in any non-production environment it would refuse any recipient not in `REMINDER_RECIPIENT_ALLOWLIST`, which contains only the account holder's address (hard rule 5).
- **Tests** spy on `TaqnyatService` and the push service and assert **zero calls**.
- **UI:** a disabled toggle marked "قريباً / Coming soon", with a preview of which installments *would* be reminded tomorrow (the dry-run list).

### 8.4 Tier 3 (approved by the account holder; built)

**Suppliers and bills (AP).** Tables in `0069_finance_v2_tier3.sql` (additive, no FK to legacy tables): `suppliers`, `supplier_bills`, `supplier_bill_lines`, `supplier_payments`, `supplier_payment_allocations`.
- **Supplier master:** Arabic/English name, VAT number (15 digits, 3…3; unique per account), CR, IBAN, contact, payment terms (days, default 30), a default GL account (an expense leaf or a non-control asset leaf), active flag. A supplier with bills or payments is deactivated, not deleted.
- **Bills:** `BILL-######` per account; the supplier's own invoice number is unique per supplier (unless voided). Draft → approved → void. Only a draft is edited or deleted. Lines carry description, account, net, VAT category/rate/amount and recoverability; amounts are entered net or gross, and a VAT figure copied from the tax invoice is accepted within 0.10 SAR of the computed one. Landlord/property dimension and "charge to landlord" follow the expense rules (§8.2 b; agent landlords in Manager mode only).
- **Input VAT:** recoverable per the §8.2 b default **and only when the supplier's VAT number is on file** (a tax invoice, VAT IR Art. 49); an explicit recoverable flag without it is refused (400 `SUPPLIER_VAT_REQUIRED`).
- **Payments:** payment vouchers in the account's single PV-###### series (shared with tenant refunds and v2 deposit refunds), paid from a bank account or cash box, allocated to one or more approved bills of the same supplier. Σ allocations = amount; each allocation ≤ the bill's open amount, checked under the per-account AP lock (a concurrent overpayment is refused). On-account payments and supplier advances (1132) are not built.
- **Postings:** E38 and E39 (§4.4). Voids post the reversal at the void date; a bill with posted payments cannot be voided.
- **Reports:** AP aging by due date (the due date is day 0; before it "not due"), per supplier with the bills, and a control check of 2111 against the sub-ledger (a difference is shown with the count of pending AP postings). Supplier statement from the sub-ledger with a running balance; voids appear as their own lines at the void date.
- **Backfill / catch-up** extracts both keys (and the reversals of voided records) with the live keys.
- Bills do not write the legacy `expenses` table, so legacy screens do not show them (v2 only). A bill charged to a landlord appears on the landlord statement as an expense with its supplier.

**Accounting-software export.** `GET /finance/v2/journal-export`: the general journal as a documented CSV, one row per journal line (UTF-8 with BOM, RFC 4180, CRLF), presets `standard` (all columns) and `simple`, Arabic or English account names, ISO or dd/mm/yyyy dates, optional exclusion of reversed entries, a CSV-injection guard, control totals in response headers, and a JSON preview. The format is specified in `docs/finance-v2/JOURNAL-EXPORT.md`. Vendor-specific mapping presets for Saudi accounting packages are **not** built (their import formats were not verified); the `simple` preset is the lowest common denominator.

---

## 9. Bug decisions (brief §E)

The legend for the "Gate" column:
- **FG**: flag-gated. The old behaviour holds when the flag is off, the fixed behaviour when it is on.
- **EX**: a proposed exception that applies in both states. It needs approval at the merge gate.

Every fix starts with a **failing test**:
- API: `node:test` specs in `src/modules/finance-v2/__tests__/`. The DB-backed ones are gated on a localhost `DATABASE_URL`.
- Web: no test runner exists (D§4.2), so pure functions are extracted and tested with `node --test --experimental-strip-types` (Node 22), with **no new dependency**, plus Playwright in Phase 5.

### E1: commission is 0% (landlord fee ignored). **FG**

**Root cause.** Verified.
- `maybeCreateCommissionInvoice` reads only `properties.management_fee_percent` (`billing.module.ts:1019-1024`) and returns at `:1025` when it is not positive.
- The revenue report reads only the property rate (`reports.module.ts:269`).
- `owners.management_fee_percent` (`owners.ts:26`) is written but never read for billing.

**Rule.**
- Effective rate = **the property rate if it is not null** (an explicit 0 means "no fee for this property"), **otherwise the landlord rate, otherwise none**.
- The web already sends `null` for an empty property field (web:`EditPropertyModal.tsx:137`, `AddPropertyModal.tsx:129`), so an explicit 0 only arises when the user types it.

**Apply** through a new helper, `effectiveManagementFee(db, scope, contractId) → {pct, source:'property'|'landlord'|null, ownerId}`, in `finance-v2/commission.ts`:
- **v2 commission creation.** Approve is **not** forked (§10.2). Instead, right after `let commission` (`billing.module.ts:1490`) an added block runs for flag-on accounts: `if (ctx.fv2) { commission = await this.fv2.commission(uid, doc); await this.fv2.afterApprove(ctx, doc); return { ...updated, commission, zatca }; }`. It returns the same response shape, and the legacy commission step below it never runs for flag-on accounts. `afterApprove` emits the ledger event and, for a credit note on a rent invoice with a confirmed COM document, creates the draft commission credit note (E36). Under v2:
  - no commission is created for **principal** landlords (it would be a commission to oneself)
  - commission VAT is charged **only if the account is VAT-registered** (`billing.module.ts:1039-1051`, the lookup the legacy code overrides at `:1054`; G3-5, Q5)
  - the trigger also covers **rent receipts** (E9)
  - `commission_basis='collected'` adds a "Generate commission for period" action on the landlord statement: base = net rent collected (E03 on 2121) not yet covered by a COM document
- **The v2 revenue report** column.
- **The UI**, which shows "5% (من المؤجر / from landlord)" on the contract finance panel and the property detail.

**Failing test first.** `commission-rate.spec.ts`:
- a property with a null rate and a landlord at 5%, then `effectiveManagementFee` gives `{pct:5, source:'landlord'}`
- a DB spec: approving a 6,900 rent invoice under v2 creates a COM draft of 300 + 45; the legacy path creates nothing (the test pins legacy behaviour too)

**Note.** In the staging data the 5% landlord's rent is collected on receipt vouchers with no invoice. E1 alone therefore produces no commission there. It needs the E9 rent receipt, or the "collected" basis.

### E2: dashboard revenue and arrears show 0. **Refuted as described.** The v2 definitions are **FG**.

**Verified.** The fields are on master (`dashboard.module.ts:93,103-110,128-129`, commit `01ede96`, the same patch as `240638d`), and staging runs `3eb2e4a` (D§5.4). There is nothing to "bring to master". Production (`main`) lacks it, and production is out of scope (staging-only rule).

**Why zeros still appear:**
- `monthlyRevenue` counts only rows with stored status `paid` and a `paidDate` in the server-clock month (`:76-84`).
- `overdueAmount` sums the full amounts of rows whose live status is overdue, which excludes part-paid rows (`:93-95`).

**Branch status.** `01ede96` is on `origin/master`. `240638d` is on **no remote branch** (`git branch -r --contains 240638d` is empty); it is the same patch, applied separately. Production (`main`) has neither, and production is out of scope.

**Decision.** A v2 dashboard override:
- `monthlyRevenue` = Σ collections (positive and negative, excluding deposits) with `collected_date` in the current **Riyadh** month. In Manager mode this includes rent collected for agent landlords, so the v2 dashboard labels the card **"Collections this month / التحصيلات هذا الشهر"** rather than revenue; ledger revenue lives in the P&L.
- `overdueAmount` = Σ remaining of overdue items under the E4 definition
- `revenueByMonth` built from collections, under the same label

The response shape is unchanged; only the values differ, and only when the flag is on.

**Failing test.** A fixture with an installment of 6,900 due last month and 3,000 collected this month, then the v2 summary gives `monthlyRevenue=3000` and `overdueAmount=3900`. The legacy summary gives 0 and 0, which the test pins as the legacy expectation.

### E3: tenant statement −96,000. **FG**

**Root cause.** Verified. `reports.module.ts:207-214` counts only confirmed documents as invoiced (excluding kinds `receipt` and `deposit`), while `:216-220` counts every collection on the contract as collected. The balance is invoiced − collected (`:230`). A tenant paid only on receipt vouchers is therefore −total.

**Decision.**
- **v2 tenant ledger** (§7.7). The recognition model (§4.1) charges installments at their due date, so the balance is correct by construction.
- **Legacy `/reports/accounting` under the flag** (`reports-accounting.override.ts`): `tenantStatement.invoiced` = Σ charges (confirmed charge documents, plus installments due by today that are not covered by a document), using the same helper as §4.1. The shape is unchanged.

**Failing test.** A tenant with two installments of 48,000, both collected on receipt vouchers with no invoice, both due. Then v2 `balance = 0`, while legacy gives `−96000`.

### E4: overdue totals disagree. **FG**

**Root cause.** Verified.
- `SETTLED_STATUSES` includes `partially_paid` (`payment-status.ts:26`), so `liveStatus` (`:35-39`) and `liveStatusSql` (`:48-51`) never make a part-paid, past-due row overdue.
- The payments list and stats (`payments.module.ts:65-66,159-163,222-234`) and the dashboard (`dashboard.module.ts:73,93`) therefore disagree with the arrears report. The arrears report sums remaining amounts but uses a UTC `Date.now()` (`reports.module.ts:236-257`).

**Decision.**
- A **new file** `src/common/payment-status-v2.ts`; `payment-status.ts` is not edited, per the additive-diff rule. It defines:
  - `remainingSql` = `amount − coalesce(Σ collections, 0)`, a correlated subquery or lateral join
  - `liveStatusV2Sql`, with the order `cancelled` / `settled_external` first, then:
    - `paid_unverified` if the stored status is `paid` and Σ collections < amount (legacy mark-as-paid, Ejar imports, `PATCH`): shown as paid with a "not verified" badge, **excluded from overdue**, and listed in R7. Without this, those rows would suddenly show as overdue on the flag-on screens, which contradicts E7's "historical rows are never auto-fixed".
    - `paid` if remaining ≤ 0.005
    - `overdue` if due < Riyadh today and remaining > 0.005
    - `partially_paid` if some was collected and it is not yet due
    - `pending` otherwise
  - `liveStatusV2(row, collected)` as the TS twin, modelled on the mobile `buckets()` (`mobile-landlord.module.ts:121-141`)
- **Used by the v2 overrides** of the payments list and stats (overdue amount = Σ remaining), the dashboard and the arrears report.
- **Web.** `InstallmentsView` v2 tab mapping: overdue = `overdue` (including part-paid past due); upcoming = `pending` + `partially_paid` not due. A `statusV2` param is sent only when the flag is on.

**Failing test.** Pure: `liveStatusV2({amount:6900, due:yesterday}, collected 3000)` gives `overdue` with remaining 3900. Legacy `liveStatus('partially_paid', yesterday)` gives `partially_paid`. A DB spec checks that list-stats overdue equals the arrears total on a mixed fixture.

### E5: the contract's "total collected" omits partials. **FG**

**Root cause.** Verified. web:`ContractDetailModal.tsx:237-242` sums rows with `status==="paid"` at face amount and **adds `prepaidRent`**. Advance rent is already recorded as collections that flip the covered rows to `paid` (`contracts.module.ts:957-970`), so the panel counts it twice. (`applyPrepaid()` in `contracts/installments.ts:207-215` is **not** the cause: both callers pass a prepaid of `0`, "prepaid is tracked as a collection, not a deduction", `contracts.module.ts:876,1200`.) The panel also drops partial collections and invoice-only collections.

**Decision.**
- API `GET /finance/v2/contracts/:id/summary` returns `{ billed, collected, outstanding, overdue, depositHeld, credit }`, where `collected` = Σ `payment_collections.amount` for the contract (installment-linked plus invoice-linked through documents with that `contract_id`), excluding deposit rows, deposit vouchers and commission.
- The web shows `summary.collected` when the flag is on. The legacy expression is left as it is.

**Failing test.** API DB spec: five paid rows of 6,900 plus a partial collection of 3,000 plus an advance already present as collections, then `collected = Σ collections` (for example 37,500 where legacy shows 34,500). The web pure-function test asserts the legacy function's value, to pin it, and the v2 selector's value.

### E6: Excel exports

**Root causes.** Verified.
- **(a)** The Collections screen exports `entity="payments"` (web:`CollectionsView.tsx:133`), which is built from **installments** (`lib/report-export.ts:393-394`), not collection rows.
- **(b)** The receipts export uses `pageSize=1000` (`:380`), and so does billing (`:375`). The API caps `pageSize` at 200 (`src/common/pagination.ts:38-45`), and zod turns that into **HTTP 400**. `list` parses the schema at `billing.module.ts:352`, so **both exports fail today** with "تعذّر تصدير التقرير". Even with the size fixed, the receipts filter (`kind in (deposit, receipt)`, `:381-382`) differs from the screen's (`type=invoice&status=confirmed&hasReceipt=true`, `ReceiptVouchersView.tsx:48-56`).

**Decision:**
- **EX-1:** replace `pageSize=1000` with the existing `fetchAllPages` walk (pages of 200; `api-hooks.ts:519-545`) in the billing and receipts exports. The exports are broken for everyone and nothing on screen changes. **Proposed exception.**
- **FG:** the Collections export reads `collections-all` with a new `collectionsSheet()` (one row per collection or RV: date, RV number, tenant, contract, installment or invoice, method, bank account under v2, amount). The receipts export reuses the screen's query parameters.

**Failing tests:**
- `report-export.urls.test.ts` (pure): every URL the exporter builds has `pageSize ≤ 200`. It fails today.
- API spec: `GET /simple-invoices?pageSize=1000` returns 400, which documents the cause.
- A pure test that the v2 collections sheet has one row per collection.

### E7: installments become "paid" with no money. **FG**

**Root cause.** Verified at five sites:
- `POST /payments` (`payments.module.ts:238-256`) and `PATCH /payments/:id` (`:258-270`, allowlist `:262`) accept `status` and `amount` with no validation
- `DELETE /contracts/:id?mode=paid` (`contracts.module.ts:1670`)
- terminate `mode:"paid"` (`:1806-1808`)
- Ejar `attachEjarInvoices` (`ejar.module.ts:523+`, `:535-537,544`)

**Decision, under v2:**
- **Terminate or DELETE with `mode=paid`** returns 409 `FINANCE_V2_MARK_PAID_REFUSED`, and the v2 dialog offers collect, write off or cancel (§4.6).
- **`PATCH /payments/:id`:**
  - `amount`, `status`, `paidDate` and `receiptNumber` are refused (400 `FINANCE_V2_FIELD_LOCKED`)
  - `dueDate` is refused if the installment is charged
  - notes and non-money fields pass through
- **`POST /payments`:** status forced to `pending`, `paidDate` and `receiptNumber` ignored, and `amount` validated as a decimal string > 0 with at most two decimals.
- **Ejar import:** paid becomes `settled_external`, which is **real rent** paid through Ejar outside Dara, not "history before the ledger". The recognizer charges it at its due date (revenue and output VAT) and E33 posts the settlement: principal Dr 1116 cash in transit / Cr AR, cleared by bank reconciliation; agent Dr 2122 / Cr 1122 (the landlord was paid directly). In `cutover` mode, rows due before the cutover are in the opening balance. Partial stays `pending`, with the reported figure kept in `finance_ejar_settlements` and shown on the installment ("Ejar reports 3,000 paid, record it?").
- **Historical rows** that are paid with no collection are listed by reconciliation R7 and never auto-fixed.

None of these endpoints has a UI caller except terminate (D§1.0 point 5), so the visible change is limited to the v2 End-contract dialog.

**Failing tests (DB):**
- terminate `mode:"paid"` under v2 returns 409 and no payment row changes; the legacy path's rows become paid, pinned
- `PATCH` with status paid under v2 returns 400
- the pure Ejar mapping `mapEjarStatusV2('paid')` gives `settled_external`
- the R7 detector lists a paid row with Σ collections = 0

### E8: the agency fee is stored but never billed. **FG**

**Root cause.** Verified. The fee lives in `contracts.agency_fee` (`contracts.ts:98`). `buildInstallments` has no agency-fee input (`installments.ts:98-112`), and only the retired `NewContractModal` can set it (web:`NewContractModal.tsx:229,1915`). `ContractWizardV2.tsx:845` passes it through.

**Decision:**
- Bill it as a **separate document**, not as a rent installment. The brokerage fee (السعي) is the broker's (the account's) own supply, with its own seller, not the landlord's rent. Putting it on a rent installment would put it under the landlord's ZATCA seller and into the landlord's payable.
- **When:** on contract create or rebuild under v2 with `agency_fee > 0`, a **draft** `kind='agency_fee'` document is created:
  - number `AGF-######`, buyer = tenant, line "أتعاب الوساطة (السعي) / Brokerage fee"
  - net = `agency_fee`
  - VAT 15% (S) if the account is VAT-registered, else O
  - due = contract start
- **Approval** uses the v2 approve path, which posts E17.
- **Existing contracts** with a fee and no AGF document are listed as "unbilled agency fees" with a one-click create. They are **not** auto-created.
- **ZATCA:** in the beta the AGF document is **not** sent to ZATCA. It never reaches the ZATCA orchestration: it has its own v2 approve, and EX-4 makes `runZatcaSubmission` and legacy approve refuse the kind in every state. No ZATCA file is touched.
  - **VAT only if the account is VAT-registered.** A VAT-registered account in ZATCA Phase 2 must clear or report its tax invoices, and a 15% document that never reaches Fatoora is not a valid tax invoice. So during the beta, **approving an S-rated AGF (or a v2 commission document carrying VAT) is refused** (409 `FINANCE_V2_TAX_DOC_NOT_REPORTABLE`) for an account that is integrated with ZATCA, until Q6b is decided. For an account not integrated, it prints as "ليس فاتورة ضريبية / not a tax invoice" with no VAT.
  - For principal landlords, whether the fee follows the rent's VAT category (it is arguably consideration for the lease) is asked of the accountant (Q12).
- **Wizard:** the "أتعاب الوساطة" field is added to `ContractWizardV2` when the flag is on.

**Failing test.** A DB spec: create a contract under v2 with `agencyFee 2500`, which yields one AGF draft of 2,500 + 375. Approving it gives Dr 1121 2,875 / Cr 4220 2,500 / Cr 2151 375. Legacy creates none, pinned.

### E9: landlords without a VAT number cannot issue any document. **FG**

**Root cause.** Verified. `approve()` runs the readiness gate (`billing.module.ts:1379-1459`) for every kind outside `TAX_EXEMPT_KINDS` (`:171-174`). `invoice-readiness.ts:533-534` blocks a landlord without a VAT number, and `:557-561` blocks one without a ZATCA link.

**Decision.** A new `kind='rent_receipt'`, "سند استلام إيجار — مستند غير ضريبي / Rent receipt — not a tax invoice":
- It is created from installments (`POST /finance/v2/rent-receipts`, invoices.write), with the same coverage logic as invoices (`payment_ids`).
- It is **allowed only when the seller landlord has no VAT number**. If the landlord is VAT-registered, it is refused (400), because a registrant must issue tax invoices.
- Number `RR-######`, with no VAT lines and no QR. A prominent band reads "ليس فاتورة ضريبية — This is not a tax invoice". The seller block shows the landlord's name and ID. It is issued on the account's letterhead as agent where applicable.
- **Not sent to ZATCA.** `rent_receipt` has its own v2 approve (an added fork at the top of `approve` that handles only the two v2 kinds), which never calls the ZATCA orchestration; EX-4 guards the legacy paths. **No change** to `invoice-builder.service.ts`, `invoice-signer.service.ts`, `qr.service.ts` or `zatca-assets.ts`, so the SDK workflow is not needed. The proof is an empty diff of those four files (Phase 5).
- Approval posts E08 and triggers commission (E1).

**Failing test.** For a no-VAT landlord, v2 `approve(rent_receipt)` gives `confirmed`, `zatcaStatus` null and a posted entry. For a VAT-registered landlord, create returns 400. The legacy approve of a normal invoice for the no-VAT landlord is still blocked, pinned.

### E10: the ZATCA settings table overflows at 1440px. **EX-2**

**Root cause.** Verified.
- `3ba6f6e` already wrapped the table in `overflow-x-auto` (web:`ZatcaIntegrationView.tsx:119,127-128`).
- The integrated-row action cell is `inline-flex items-center gap-2` **with no wrap** (`:188`), and holds up to three buttons and a badge. The revoked branch wraps (`:170`).

**Decision.** Add `flex-wrap justify-end` to the `:188` container. This is markup only, with no numbers or behaviour. **Proposed exception.**

**Failing test.** A Playwright script, read-only, at a 1440×900 viewport on the settings ZATCA tab. It asserts the table container's `scrollWidth ≤ clientWidth`, with a screenshot before and after.

### Other findings

| Finding | Gate | Why |
|---|---|---|
| `POST /reports/expenses` does not scope-check `ownerId`/`propertyId` (`reports.module.ts:363-381`), and `POST /reports/landlord-payouts` stores an unchecked `ownerId` (`:448-460`) | **EX-3** | A cross-account reference, which is a security bug, and E18/E19 would stamp the foreign id as a dimension. Rejecting foreign ids with 400 has no visible effect for legitimate users. Test: a foreign `propertyId` or `ownerId` returns 400; today it is 200. |
| The two v2 document kinds could reach ZATCA or the legacy tax-invoice gate: `runZatcaSubmission` skips only `commission` (`billing.module.ts:1642-1645`); `POST /simple-invoices/:id/submit-zatca` (`:1506-1569`) submits any confirmed document; legacy approve treats every kind outside `TAX_EXEMPT_KINDS` (`:171`) as a tax invoice and would mirror it to ZATCA under the **landlord's** seller identity (`:1478-1486,1646-1650`) | **EX-4** | Two added lines, active with the flag on or off: (1) at the top of `runZatcaSubmission`, `if (doc.kind === "rent_receipt" \|\| doc.kind === "agency_fee") return { submitted:false, code:"skipped", reason:… }`, which also covers `submit-zatca`; (2) at the top of legacy `approve`, after the v2 fork, a 409 for those kinds (reached only when the flag is off, for example after a flip-back). Both are no-ops for accounts that never had v2, because those kinds do not exist there. They are orchestration files, not the four signing files, so hard rule 4 is untouched. Test: with the flag off, approving or submitting a `rent_receipt` returns 409 / `skipped`, and no `invoices` row or ZATCA call is made. |
| Write paths stamp "today" in UTC (D§1.0 point 6) | FG | v2 overrides use `riyadhToday()`. Changing the legacy paths would move dates people see. On the **hooked** (not forked) `addCollection`, which defaults `collectedDate` to the UTC date (`payments.module.ts:541`), the v2 web always sends `collectedDate` in Riyadh time, and the hook sets `date_defaulted_utc` in `finance_collection_meta` (a warning on the entry) when the body omitted it. |
| `createReceiptVoucher` has no transaction or lock, so MAX+1 numbers can collide (`billing.module.ts:1101-1241`; `src/common/receipt-number.ts:13-27`) | FG | The v2 override adds a transaction and takes `pg_advisory_xact_lock(uid, 11)`, the key contract create already holds when it mints the advance-rent RV (`contracts.module.ts:1033,1058`). The legacy `/collect` mints RVs under a per-document key (`billing.module.ts:1971,1985`), which v2 cannot change with added lines, so an RV race between a v2 receipt voucher and a simultaneous legacy `/collect` remains possible; it is rare and pre-existing. (The `(uid, 1)` key is the INV series, `payment-confirmations.module.ts:46,460`, not the RV series.) |
| The dues report deducts maintenance *estimates* (`reports.module.ts:127-131,165,176`) | FG | The v2 landlord statement deducts only posted expenses. R3 lists the difference. |
| DARA-NOTES copies differ between the repos (D§0 point 10) | Phase 8 | Resync in the docs phase. |

**Exceptions to approve at the merge gate:** EX-1 (export page size), EX-2 (ZATCA action cell wrap), EX-3 (expense and payout id scope checks) and EX-4 (keep the v2 document kinds away from ZATCA and legacy approve). Nothing else changes with the flag off. The removed-lines allowlist (§1.4 point 5) is presented alongside.

---

## 10. API endpoints and web screens

### 10.1 Capabilities (derived; no new permission keys)

`capabilities(user)` is computed from `user.permissions` (`roles.permissions`, `jwt-auth.guard.ts:87-113`) and returned by `/finance/v2/status`.

| Capability | Granted when | Default presets that get it (`permissions.ts:170-260`) |
|---|---|---|
| `view` | `reports.view` and (`payments.view` or `invoices.view`) | general, accountant, collection officer, property manager |
| `draft` (manual journals, opening-balance drafts) | `invoices.write` and `expenses.write` | general, accountant |
| `approve` (approve journals, reverse manual entries, write-offs, dismiss posting errors) | `expenses.approve` and `invoices.write`; the approver is not the drafter unless they are the account holder | general, accountant |
| `settings` (chart, bank accounts, periods close/reopen/lock, VAT return lock, audit adjustments in closed periods, mode display) | the account holder (`ownerUserId == null && ownerScopeId == null && role !== 'owner'`; owner-mobile tokens also have `ownerUserId: null`, `jwt-auth.guard.ts:66-78`) **or** `invoices.delete` + `expenses.approve` + `payments.write` | account holder, general, **accountant** (the accountant preset has all three keys, `permissions.ts:224-226`). This is intended by default: the accountant is the person who closes periods and files VAT. The account holder can confirm or narrow it (§14) |
| `money` (tenant refunds, v2 collect with bank) | `payments.write` | general, collection officer, accountant |
| `expenses` (v2 create and edit) | `expenses.write` | general, accountant |

Real keys can replace this mapping at general availability, when changing the presets is allowed.

### 10.2 Endpoints

Conventions:
- **Account routes.** Everything under `/api/finance/v2` uses `JwtAuthGuard` + `FinanceV2Guard`, which returns 404 when the flag is off, plus a capability check. `/status` is the exception: it is JWT only.
- **Scope.** Every query filters `user_id = scopeId(user)`. **Every id in the path or body** (account, bank account, tenant, landlord, property, unit, contract, document, installment, entry, period) is loaded with the scope in the same `where`, and a miss is 404. Dimension ids in manual lines are checked in bulk per type.
- **Owner-mobile tokens** (`ownerScopeId` set) are refused on every route except the landlord statement restricted to their own `ownerId` (§7.11).
- **Tenant tokens** (`TenantAuthGuard`) have no access.
- **Admin routes** under `/api/admin/finance-v2` use `JwtAuthGuard` + `SuperAdminGuard` (`admin.module.ts:110`).

| Method and path | Capability | Purpose |
|---|---|---|
| GET `/finance/v2/status` | JWT | `{enabled, mode, capabilities}`; never 404 |
| GET / PATCH `/finance/v2/settings` | view / settings | Default bank and cash, VAT frequency, commission basis, deposit-forfeit VAT, trust routing. **Mode is read-only here** (admin sets it) |
| GET `/finance/v2/accounts` | view | Tree, with balances optional (`?asOf`) |
| POST `/finance/v2/accounts` | settings | Add a sub-account (`parentId`, names, code suggestion) |
| PATCH `/finance/v2/accounts/:id` | settings | Rename, deactivate or reactivate, description. Type and system key are locked (trigger) |
| DELETE `/finance/v2/accounts/:id` | settings | Only if it has no postings and is not a template account |
| GET / POST / PATCH `/finance/v2/bank-accounts[/:id]` | view / settings | Tier 1 (a) |
| GET `/finance/v2/journal` | view | Entries: filters for date, account, source, origin, late, status, dims; paginated |
| GET `/finance/v2/journal/:id` | view | Entry with lines, payload, warnings and a source link `{type, id, number, route}` |
| POST `/finance/v2/journal/:id/reverse` | approve | Manual or opening entries only |
| GET / POST / PATCH `/finance/v2/manual-journals[/:id]` | view / draft | Drafts |
| POST `/finance/v2/manual-journals/:id/{submit,approve,reject,void}` | draft / approve | Lifecycle (§8.1) |
| POST `/finance/v2/opening-balances` | draft | Creates an opening draft; `GET …/proposal?date=` returns the sub-ledger proposal |
| GET `/finance/v2/periods`; POST `/periods/:id/{close,reopen,lock}`; POST `/periods/close-year` | view / settings | §8.1 |
| GET `/finance/v2/posting-errors`; POST `/posting-errors/:id/{retry,dismiss}` | view / retry: approve or money; dismiss: approve | §5.5 |
| GET `/finance/v2/reports/{trial-balance, general-ledger, income-statement, balance-sheet, vat-return, ar-aging, tenant-ledger, landlord-statement, cash-book, reconciliation}` | view | §7 |
| GET / PUT `/finance/v2/vat-returns/:period` (box 14, 15, lock) | view / settings | §7.5 |
| GET `/finance/v2/contracts/:id/summary` | view | E5 |
| GET / POST / PATCH `/finance/v2/expenses[/:id]` | view / expenses | Tier 1 (b) |
| GET `/finance/v2/tenant-credits`; POST `/tenant-credits/{refund,apply}` | view / money | Tier 1 (c) |
| GET `/finance/v2/documents/:id/tenant-credit` | view | The credit a just-approved credit note left (tier 1 c); keeps the approve response unchanged |
| GET `/finance/v2/contracts/:id/open-installments` | view | The End-contract dialog's disposition list (§4.6) |
| POST `/finance/v2/rent-receipts` | `invoices.write` | E9 (then the normal approve route, forked under v2) |
| POST `/finance/v2/contracts/:id/agency-fee-invoice`; GET `/finance/v2/agency-fees/unbilled` | `invoices.write` / view | E8 |
| POST `/finance/v2/write-offs` | approve | §4.6 |
| POST `/finance/v2/landlords/:ownerId/commission-run` | `invoices.write` | E1 collected basis |
| Tier 2: `/finance/v2/bank-statements[/:id]`, `/bank-statements/import`, `/bank-statements/:id/{auto-match,match,unmatch,complete}`, `/bank-import-profiles` | view / money / settings | §8.3 (a) |
| Tier 2: GET / PATCH `/finance/v2/reminders` (enable refused while the env gate is off), GET `/reminders/preview` | view / settings | §8.3 (b) |
| Tier 3: `/finance/v2/suppliers[/:id]` (GET, POST, PATCH, DELETE), GET `/suppliers/:id/statement` | view / expenses | §8.4 |
| Tier 3: `/finance/v2/bills[/:id]` (GET, POST, PATCH, DELETE draft), POST `/bills/:id/approve`, POST `/bills/:id/void` | view / expenses / approve | §8.4 |
| Tier 3: `/finance/v2/supplier-payments[/:id]` (GET, POST), POST `/supplier-payments/:id/void` | view / money / approve | §8.4 |
| Tier 3: GET `/finance/v2/reports/ap-aging`, GET `/finance/v2/journal-export` | view | §8.4, JOURNAL-EXPORT.md |
| **Admin:** GET `/admin/finance-v2/accounts` | SuperAdmin | Flag state per customer account |
| **Admin:** PATCH `/admin/finance-v2/:accountUserId` | SuperAdmin | The switch (§1.5) |
| **Admin:** POST `/admin/finance-v2/:accountUserId/backfill` | SuperAdmin | §6 (dry-run by default; a dry-run is allowed while the flag is off) |
| **Admin:** GET `/admin/finance-v2/:accountUserId/{events,posting-errors,backfill-runs}` | SuperAdmin | Support view |

**Existing routes that gain a v2 fork** (the flag-off path is byte-identical). Each has a one-line inserted fork or a void hook, marked `// finance-v2:`:

| Route | Change |
|---|---|
| `POST /payments` | fork (E7) |
| `PATCH /payments/:id` | fork (E7) |
| `POST /payments/:id/collections` | hook plus bank meta |
| `GET /payments` list and stats | fork (E4) |
| `POST /simple-invoices/:id/approve` | **not forked for tax invoices and notes.** Three added blocks: (1) at the top, a fork for the two v2 kinds only (`rent_receipt`, `agency_fee`), which never touch ZATCA; (2) the EX-4 refusal of those kinds when the flag is off; (3) after `let commission` (`:1490`), the flag-on block that creates the v2 commission (E1), emits the ledger event and returns the same shape. The ZATCA orchestration (`submitApprovedDocToZatca`, `runZatcaSubmission`, `zatcaLinesFromDoc`, `resolveOwnerId`, `:1574-1876`) keeps a single copy |
| `POST /simple-invoices/:id/submit-zatca` | EX-4 guard via `runZatcaSubmission` |
| `POST /simple-invoices/:id/collect` | hook plus deduction meta |
| `POST /simple-invoices/receipt-voucher` | fork: transaction plus hooks |
| `POST /simple-invoices` | hook (E14 skip) |
| `POST /contracts` | hook (E8 draft, dims capture) |
| `PATCH /contracts/:id` with `rebuild` | hook inside the transaction |
| `POST /contracts/:id/generate-installments` | fork: 409 when a row it would delete is charged or invoiced (E23) |
| `POST /contracts/:id/collect-deposit` | hook |
| `POST /contracts/:id/terminate` | fork (E7, refund PV, forfeit for vouchers, apply deposit) |
| `DELETE /contracts/:id` | fork (E7) |
| `POST` / `DELETE /reports/expenses` | hook, plus EX-3 scope check |
| `POST` / `DELETE /reports/landlord-payouts` | hook, plus EX-3 scope check on `ownerId` |
| `GET /reports/accounting` | fork (E3) |
| `GET /dashboard/summary` | fork (E2, E4) |
| `POST /ejar/import` | fork of `attachEjarInvoices` (E7) |
| `POST /payments/:id/settle-external` / `revert-external` | fork (E27, E33) |
| Admin hard deletes | purge hook, unconditional, after the legacy deletes (§2.4.5) |

### 10.3 Web screens (all flag-gated; `financeV2.*` locale keys in `ar.json` and `en.json`; Dara tokens; RTL-first)

| Screen | Where | Notes |
|---|---|---|
| Beta badge | `_legacy/DashboardPage.tsx:578-582` | §1.3 |
| Reports → **"المحاسبة (تجريبي)"** category | `ReportsView.tsx` `CATEGORIES` (`:341-357`) and `REPORT_DEFS` (`:321-333`), inserted only when enabled; excluded from `needRows` (`:92`) and the no-data shell (`:484`) (D§3.3). A `section === "accounting"` key already exists (`:92,330,495`, the legacy accounting reports), so the v2 category uses a distinct key, `accounting_v2` | Renders `<AccountingV2View report=…/>`: TB, GL, P&L, BS, VAT, aging, tenant ledger, landlord statement, cash book, reconciliation, each with Excel and PDF export, a language toggle and filters |
| Chart of accounts | Settings → "دليل الحسابات" (v2 tab) | Tree with codes and balances; add sub-account; rename or deactivate; system accounts marked |
| Journal (GL) | Finance group → "القيود" tab (v2) | List with filters, entry drawer showing lines, dims, warnings and a source link that opens the existing document modal |
| Manual journal | From the journal tab: "قيد يدوي جديد" | Balanced-lines editor (live Σ debit/credit and difference), attachment, submit/approve/reject, opening-balance mode with the proposal |
| Periods | Settings → "الفترات المالية" | Month grid, close/reopen/lock, year close, pre-close checklist |
| Posting errors | Accounting section header badge, and a page | Retry and dismiss; skipped tab |
| Bank accounts | Settings → "الحسابات البنكية والصندوق" | IBAN validation |
| Money dialogs, "Received into / Paid from" select | `CollectInstallmentModal`, `ConfirmInvoiceModal`, `CreateReceiptVoucherModal`, collect-deposit, payout, expense | v2 wrapper components (lazy) around the legacy forms |
| Expense v2 modal | `ExpensesView` (v2 variant) | VAT, supplier, attachment, date picker, charge-to, edit |
| Tenant credits | Finance → "أرصدة المستأجرين الدائنة" | Refund (PV print) and apply |
| End-contract v2 dialog | Replaces `EndContractDialog` when enabled | Collect remaining / write off / cancel; deposit refund, forfeit, to revenue, or apply to arrears; PV print |
| Rent receipt | "سند استلام إيجار" action on installments for no-VAT landlords; document render | Non-tax band |
| Agency fee | Wizard field; "أتعاب وساطة غير مفوترة" list | |
| Contract summary | `ContractDetailModal` total (E5) and `ContractFinancePanels` | Effective commission rate and source (E1) |
| Installments tabs | `InstallmentsView` v2 mapping (E4) | |
| Exports | `report-export.ts` (EX-1 for all; E6 v2 sheets) | |
| Admin toggle | `components/admin/tabs/CompaniesTab.tsx`, and the Customer-360 drawer | Mode and reason dialog, event history, backfill dry-run viewer |
| Tier 2 | Bank reconciliation screen; reminders settings (disabled toggle and preview) | |

Hooks live in `lib/api-hooks.ts`, in a `financeV2Keys` namespace. Money values stay strings end to end and are formatted with `lib/format.ts` for display only.

---

## 11. Test plan (mapped to brief Phase 5)

### 11.1 Unit tests (`node:test`, no DB)

- **(a) Every rule, in both modes, balances.** A table-driven spec runs every event type (E01–E37) × {principal, agent} × {S, Z, E, O} × {partial, full, over} amounts. It asserts that Σ debit = Σ credit, that no line is negative, that every line carries the event's dims, and, for agent entries, the **mirror** 1122 = −2122.
- **(b) Idempotency.** `emit` twice gives one outbox row. Worker processing of a duplicate key via a simulated `23505` marks it posted with the same entry.
- **(c) A reversal nets to zero** per account and per dim tuple.
- **(d) Closed periods refuse postings.** The engine routes a late event to the next open period with `is_late`. A manual journal in a closed period returns 409. The DB trigger test is in §11.3.
- **(e) Aging buckets.** Fixtures at the 0/30/31/60/61/90/91-day boundaries. A part-paid item ages its remaining amount. Unapplied credit is not netted into a bucket. Documents are not double-counted with the installments they cover.
- **(f) VAT boxes.** A fixture set of S, Z, E and O invoices, a credit note, a debit note, a due-date charge, a charge cancellation, an **advance payment on an uncharged S installment followed by its charge** (VAT counted once, in the quarter the advance arrived), overheads under the apportionment ratio, and recoverable and non-recoverable expenses, with the expected boxes 1–16 computed by hand in the spec.
- **(i) Straight-line releases.** Monthly, quarterly, semi-annual and annual installments; a window crossing a year end; a mid-window credit note; early termination (`ended_on`). Releases sum exactly to the net charge, to the halala.
- **(j) Reverse and replace.** A due-date charge in O followed by an S invoice; an E charge followed by an S invoice; a document for less than the charge. Each ends with the document's own figures only.
- **(k) The VAT split against legacy.** Every gross value from 0.01 to 100,000.00 (§2.1).
- **(g) Money helpers.** `toHalalas` and `fromHalalas` round-trip. VAT split round-half-up at the .5 halala boundary. jsonb numbers with three decimals get flagged.
- **(h) `liveStatusV2`** agrees with `liveStatusV2Sql`, the same pattern as the existing twin rule.

### 11.2 Property and invariant tests

A seeded pseudo-random generator is used, with no new dependency. The seed is printed on failure so the run can be replayed.

- **Sequences.** A contract with a random schedule (monthly, quarterly or semi-annual; VAT on or off; residential or commercial), plus invoices covering random subsets, partial and over-collections, credit and debit notes, advance rent, deposit receive, refund, forfeit or convert, expenses, payouts, rebuild and termination (cancel, refund, write-off). The sequences run through the rules engine against an in-memory ledger in both modes.
- **After every step:**
  - the TB balances
  - **AR control = sub-ledger open items** (R1)
  - **DEP = deposits sub-ledger** (R2)
  - **LP = dues-report formula** restricted to posted items (R3)
  - the agent mirror holds
- **Catch-up equivalence.** After a random sequence posted live, a catch-up run (with a random subset of live enqueues dropped first) leaves the trial balance identical to live posting of the full sequence, and a catch-up on a complete ledger posts nothing. This covers the deposit-refund key (E10), collection classification (§4.4.1) and deleted sources (§6.3).
- **Ordering.** The same events enqueued in a different but valid order (a due-date charge still queued when its invoice is confirmed; a cancellation queued before a pending charge) end at the same balances.
- 500 sequences per mode per CI run, and 10,000 in the nightly (manual) run.

### 11.3 Integration tests (disposable Postgres, **never** a shared DB)

- **Harness:** `src/modules/finance-v2/__tests__/with-db.ts` (one name; the specs live under `src/` so `pnpm test` runs them, `package.json:12`).
  - It reads `FV2_TEST_DATABASE_URL` only, never `DATABASE_URL`, and refuses anything but `localhost` or `127.0.0.1`, as `news.retention.db.spec.ts` does.
  - It asserts `API_PORT !== 4000`.
  - It creates a fresh schema per run: `create schema fv2_test_<rand>` with `search_path`.
  - It builds the legacy tables from the committed schema-only dump (§2.2 point 5), applies `0066` and `0067`, and seeds synthetic data only (hard rule 6).
  - **CI.** `ci.yml` already runs a throwaway `postgres:16` service for the news suite (`:27-39`). The fv2 DB specs use a second database on that service, and `FV2_TEST_DATABASE_URL` is set in the test step. Without it the DB specs would skip themselves and push the skip count over `BASELINE_SKIPPED=94` (`ci.yml:83,124-126`), turning CI red.
- **Cases:**
  - **(a)** DB triggers: an unbalanced entry is rejected at commit; an update or delete of a line is rejected; an entry in a closed period is rejected; posting to a group or inactive account is rejected; changing an account's type after postings is rejected; a cross-account `account_id` is rejected by the composite FK.
  - **(b)** **Backfill of a seeded company reproduces the expected balances.** The seed script mirrors the accountant account's scenario with synthetic values. The expected TB, AR per tenant, DEP, LP and VAT boxes are hand-computed in the spec. A **second backfill run posts nothing** (`new: 0`, identical entry count and TB hash).
  - **(c)** The hooks on each real route, via Nest `TestingModule` and supertest with the flag on, produce the expected entries. With the flag off, the same routes produce **zero** v2 rows.
  - **(d)** Worker retry and backoff: a forced rule error goes through 8 attempts to `failed`; retry then posts. A reversal enqueued while its original is failed stays blocked and posts right after the retried original.
  - **(e) Flag-off write-path parity.** Every legacy POST, PATCH and DELETE route that gained a fork or hook is called with the flag off on the branch and on `master` against identical fixtures; the response bodies and the resulting rows in the legacy tables must be identical. The GET snapshots of §11.4 do not cover write responses.
  - **(f) Locks.** The worker lock and the backfill lock are released when the process that holds them drops its client, and a pooled connection never keeps an fv2 session lock (checked through `pg_locks`).
- **Existing DB specs** must still pass. `chain-head.spec.ts` commits rows, so it runs only against the throwaway DB (D§4.1).

### 11.4 Regression proof of isolation

1. **Snapshot harness** `scripts/finance-v2-snapshot.ts`, read-only GETs only. It calls the 39 GET endpoints the UI uses (D§7), with the exact query strings the web builds, for the **first accountant test account** on a **copy of the staging DB** (the Phase 6 preview DB, or a local restore). It runs:
   - (i) against `master` (API image `3eb2e4a` or the current master)
   - (ii) against `feat/finance-v2` with the first accountant test account off
   - (iii) as (ii), after the beta account has been switched on, backfilled and put through the journey

   It normalises only volatile fields that are not data: `Date` and request-id headers. It diffs the bodies byte for byte. **Every diff must be empty.** Runs (i) and (ii) must happen on the **same Riyadh date**, because legacy code derives values from `Date.now()` (`reports.module.ts:236`) and `riyadhToday()`. The artefacts are stored in `docs/finance-v2/snapshots/`, as hashes only, with no data, because this is a public repo.
2. **Existing suites:** API `pnpm test` (no DB, and the throwaway DB run), with a pass count ≥ the D§4.1 baseline and no new failures. API and web `tsc` at 0 and 7 errors respectively.
3. **The CI additive-diff script** (§1.4 point 5) and the schema-file diff check.

### 11.5 ZATCA

- **No change is planned** to `invoice-signer.service.ts`, `invoice-builder.service.ts`, `qr.service.ts`, `zatca-assets.ts` or the base image.
- **Proof:** `git diff origin/master...feat/finance-v2 -- <those four files> Dockerfile` must be empty, and the output goes into TEST-REPORT.md.
- If any change reaches invoice XML shape anyway, run `gh workflow run zatca-validate.yml --ref feat/finance-v2`, and every sample must PASS.

### 11.6 End-to-end (Playwright, headless Chrome)

- **Where:** on the Phase 6 preview pair (a copy of the staging DB), or locally against a staging-like DB. **Never** against the existing staging apps with the branch deployed. The login reuses `~/Desktop/dara-journey-maps/src/login.mjs`.
- **the beta account journey:**
  1. create invoice
  2. approve
  3. partial collection (with a bank account)
  4. credit note (hint: refund or apply)
  5. expense with VAT
  6. payout

  Then assert TB, P&L, BS, VAT summary, aging and landlord-statement PDF text against **hand-computed values written in the spec before running**. The PDF is checked by text extraction.
  - Also: termination with "mark as paid" is refused and the v2 dialog is shown; a rent receipt for the no-VAT landlord; E1 through E6 visible fixes.
- **the first accountant test account:** no badge, no "المحاسبة (تجريبي)" category, no v2 dialogs, and the key totals equal the private doc's table.
- **Screenshots** of every new screen, in Arabic and in English, at 1440 and 390 widths. E10 at 1440 before and after.
- **No messages:** the run asserts no outbound SMS, email or push through the app logs (`app_logs` sms/mail events), and never touches payment confirmations.

### 11.7 Reviews

Four separate reviewer agents look at correctness, accounting soundness (SOCPA, IFRS for SMEs, VAT), security (every new endpoint's capability and scope, id checks and IDOR probes), and RTL/UI. Their findings are fixed and the tests re-run. The results go in TEST-REPORT.md.

---

## 12. Build order and risks

### 12.1 Order (brief Phase 2 → 4)

1. **The flag:** `finance_settings` and its events; `FinanceFlagService` (resolve-once, stale-if-error) and the guard; the core/v2 module split (§5); `/status`; the admin PATCH plus audit; CI scripts (additive diff with the removed-lines allowlist, schema diff, the `fv2.purge` grep); the fv2 test database in CI. *Tests: flag off returns 404; a missing table reads off; audit row written.*
2. **The chart:** the `accounts` table, template seed and guards; the accounts endpoints. *Tests: trigger guards.*
3. **The ledger:** entries and lines, the balance, immutability, period and account triggers; `JournalRepository`; periods table and `ensurePeriod`. *Tests: §11.3-a.*
4. **The engine:** outbox, emitter, worker, reversal, posting errors, the money helpers and the rules (pure). *Tests: §11.1-a, b, c, g.*
5. **Hooks** per event in §10.2, plus `finance_contract_dims` capture and the recognizer. *Tests: §11.3-c.*
6. **Backfill:** dry-run, full, cutover and catch-up, plus the repair sweep. *Tests: §11.3-b.*
7. **Manual journals and opening balances.**
8. **Periods:** close, reopen, lock, year close.

**Phase 3, in parallel:**
- report groups: TB/GL; P&L/BS; VAT; aging and tenant ledger; landlord statement and cash book; reconciliation
- bug clusters: {E1, E8}, {E2, E4, E5}, {E3, E6}, {E7}, {E9}, {EX-1, EX-2, EX-3}
- tier 1: bank accounts, expenses and tenant credits

**Phase 4:** web.

**Tier 2** only after tier 1 is green. **Tier 3** only after approval (given; built, §8.4).

### 12.2 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| A legacy edit slips in and changes a flag-off response | Breaks the "nothing changes" promise | Side tables only; the additive-diff CI; the snapshot proof (i/ii/iii) |
| The flag read inside a transaction aborts a legacy write when the table is missing | A user action fails | Resolved once per request via the pool, never inside the caller's transaction; `try/catch`; a missing table reads off, a transient error uses the cached value (§1.2); a spec with the table dropped and one with the pool exhausted |
| A crash between a non-transactional write and its enqueue | A missing posting | The nightly catch-up sweep; R6 completeness check |
| Hard deletes (rebuild, terminate `contract_units`) lose dimensions | Wrong landlord or property on later events | `finance_contract_dims` captured at enable and create; payload freezing |
| Revenue timing choice (§4.1) disputed by the accountant | Re-work | It is isolated to the recognizer, the release rule (E35) and the reverse-and-replace step of E01; Q3, Q13, Q23 |
| VAT booked on due-date charges without a tax invoice | Mismatch with ZATCA filings | Warning, R5 and R7 lists, and a VAT report block; the user issues invoices |
| Commission and agency-fee documents are not sent to ZATCA (existing practice extended) | Compliance gap for VAT-registered managers | Flagged as Q6b; beta only; must be resolved before GA |
| Exempt residential invoices are "skipped" for ZATCA today (existing behaviour) | Possible e-invoicing non-compliance (Phase 2 generally requires reporting exempt supplies too) | Out of scope under hard rule 4; raised as Q19 for the accountant and account holder |
| The mode chosen wrongly at enable | Wrong P&L or balance sheet | Admin dialog default plus a confirmation; a mode change is refused after the first posting; re-base in tier 2 |
| The worker falls behind (a big backfill) | Reports lag | Per-account lock; 200 rows per tick; the backfill pauses live posting for that account only; progress in the admin UI |
| CI is already red on master (skip baseline) | False signals | Fix the baseline first, as a separate commit: raise it to the measured 99 or make the skipped specs runnable (D§4.4) |
| Fresh-DB bootstrap is broken (`db/data.sql:36`) | Integration harness friction | The harness applies `0066` directly to its own schema and seeds the minimum |
| `pnpm db:push` / `.env` point at production | Data loss or a production write | Never used; the harness guards the host and port; the backfill CLI guard |
| Staging seeding triggers a notification | Breach of hard rule 5 | Aliases and dummy phones; payment confirmations and email sending never called; a host assert in the seed script |
| Dimension ambiguity (multi-property contracts) | Filtered reports split oddly | First unit, plus the `dimension_ambiguous` warning and a list |
| Flipping a flag-on account back off | Legacy UI shows v2 document kinds (`rent_receipt`, `agency_fee`) in lists; legacy approve or submit-zatca could treat them as tax invoices | EX-4 refuses them on the legacy approve and ZATCA paths in every state; legacy lists render the kind generically; the flip-back test in Phase 5 |
| Tenants of a flag-on account see `rent_receipt` and `agency_fee` documents in the tenant portal and the mobile app | An unknown kind could render badly or crash in `dara-mobile` | Phase 2 checks how `dara-mobile` renders an unknown `kind` (read-only); if it breaks, the tenant-facing lists of flag-on accounts map the two kinds to `invoice` in the v2 layer, without touching the mobile repo |
| Revenue deferral (straight-line) disputed or unwanted | Re-work | One setting (`defer_rent_straight_line`); the releases are separate entries (E35), so turning it off affects only future charges; Q23 |
| The flag read fails during a pool stall | A flag-on account could fall back to legacy writes | Resolved once per request before any transaction; stale-if-error cache; v2 routes return 503 rather than guess (§1.2) |

---

## 13. Open questions for the accountant (defaults used meanwhile)

| # | Question | Default built now |
|---|---|---|
| Q1 (G3-1) | Full double-entry books in Dara, or export to an accounting package, and which? | Full books in Dara (this design). The export stays tier 3, which needs approval. |
| Q2 (G3-2) | For a property **manager**, is collected rent revenue or a landlord payable? | A **landlord payable** (Manager mode, agent) for landlords other than the account holder; the account's own properties are revenue. Owner mode is available per account. |
| Q3 (G3-3) | Revenue at invoice date, due date, or collection? | The tenant is **charged** at the earlier of the document date and the due date; principal rent **revenue** is then released straight-line over the period each installment covers (§4.1, Q23). Collection-basis revenue is not offered. |
| Q4 (G3-4) | Deposit liability per tenant? VAT when a deposit is forfeited? | Per tenant and contract (dims on 2141). A forfeit as compensation is **out of scope (O)**, with a setting for S. A deposit applied to unpaid rent follows the rent's VAT (it is consideration). |
| Q5 (G3-5) | Commission VAT when the manager is not VAT-registered? Who is the seller? | Seller = the account. VAT **only if the account is VAT-registered** (v2), unlike the legacy "always 15%" (`billing.module.ts:1054`). |
| Q6 (G3-6) | What document for landlords without a VAT number? | A **non-tax rent receipt** (E9), labelled, not sent to ZATCA. |
| Q6b (new) | Commission and agency-fee documents from a VAT-registered account are not sent to ZATCA (commission is skipped at `billing.module.ts:1642-1645`). Should they be reported under the account's own ZATCA identity? | Beta: not sent. A ZATCA-integrated account cannot approve an S-rated agency-fee or VAT-bearing v2 commission document (409) until this is decided; an account not integrated prints them as "not a tax invoice" with no VAT. Must be decided before GA; it needs an account-level ZATCA credential. |
| Q7 (G3-7) | Which reports must landlords get monthly? | The landlord statement PDF (§7.8) with its VAT summary, plus aging per landlord. |
| Q8 (G3-8) | Bank reconciliation in Dara or outside? | In Dara (tier 2), CSV import. |
| Q9 (G3-9) | A credit balance after a credit note: refund or carry forward? | **Both are offered.** It stays as a credit until the user chooses (tier 1 c). |
| Q10 (G3-10) | Late-payment penalties, and their VAT? | Not built. If built: 4320, with VAT following the underlying rent (penalties as consideration). |
| Q11 (new) | Commission basis: billed rent (legacy) or collected rent? | `billed`, with an optional `collected` setting and a manual "commission run". |
| Q12 (new) | Who pays the agency fee (tenant or landlord), and is it the manager's revenue? For a **principal** landlord, does the fee follow the rent's VAT category (consideration for the lease)? | Tenant pays; the account's revenue (4220). VAT only if the account is VAT-registered, at 15%, regardless of the rent's category. |
| Q13 (new) | Defer rent invoiced **before** its due date to unearned revenue (2131)? | Superseded by Q23: all principal rent goes through 2131 and is released over its coverage window, whatever the invoice date. |
| Q14 (new) | Owner-mode payouts to third-party landlords: drawings, or a payable? | Moot by design: Owner mode is refused when a third-party landlord has active contracts (§4.2), so Owner-mode payouts are always to the account holder itself and go to drawings (3400). Confirm that a company's payouts to its own landlord rows should be drawings, or a related-party payable (2170). |
| Q15 (new) | Bad-debt VAT relief on write-offs (VAT IR Art. 40)? | Not automatic. VAT stays; the user can post a manual adjustment. |
| Q16 (new) | Input VAT on property costs where rent is exempt (residential), or mixed use? | Direct attribution: non-recoverable for residential, recoverable for commercial. Mixed-use property costs and overheads use the ratio of Q25. The user can override. |
| Q17 (new) | Manual journal approval: attachment threshold, and segregation of duties for small teams? | Attachment required above 10,000 SAR. The approver must differ from the drafter, except the account holder. |
| Q18 (new) | Investment property: IFRS for SMEs s.16.7 **requires** fair value through profit or loss where it can be measured reliably without undue cost or effort. Does the SOCPA endorsement require or allow the cost model for our customers, and at what depreciation rates? | Cost model (s.17), pending confirmation. Depreciation or revaluation is posted manually; no fixed-asset register. |
| Q19 (new) | Exempt residential rent invoices are currently not reported to ZATCA ("skipped"). Is that compliant for VAT-registered landlords? | No change (hard rule 4). Raised for the account holder and the accountant. |
| Q20 (new) | Multi-property contracts: split revenue by unit share, or attribute it to the first property? | First property, with a warning. |
| Q21 (new) | Fiscal year start (January?) and VAT filing frequency (quarterly?) per account. | January; quarterly. Both are settable (the fiscal-year start only until the first period exists). |
| Q22 (new) | VAT on advance payments: book output VAT when an advance is received for an installment not yet due or invoiced (VAT IR Art. 23, to the extent of the payment)? | **Yes.** An advance-VAT entry at the collection date; the later charge is netted (§4.1, E34). |
| Q23 (new) | Straight-line rent: defer principal rent to 2131 at the charge and release it monthly, pro-rata by days over the installment's coverage window (IFRS for SMEs s.20.25)? | **Yes, on by default** (`defer_rent_straight_line`). Agent rent is not affected. |
| Q23b (new) | For leases with rent-free months or escalating rent, average the total rent over the whole lease term (strict s.20.25), rather than per installment window? | Off: per installment window. |
| Q24 (new) | Commission when the underlying rent is reduced: reverse commission proportionally on **credit notes**? On **write-offs** and cancellations? | Credit notes: yes, a draft commission credit note for the rent-proportional share (E36). Write-offs and cancellations: no automatic adjustment until answered. |
| Q25 (new) | Input VAT apportionment on overheads for accounts with both exempt and taxable supplies (VAT IR Art. 51): which ratio, and how is the annual true-up done? | Provisional ratio = taxable ÷ (taxable + exempt) supplies of the previous fiscal year (ledger to date in the first year); an annual true-up proposed as a manual journal, never automatic. |
| Q26 (new) | VAT settlement: post the transfer of output and input VAT to a VAT payable/refundable account when a return is locked, with box 14/15 amounts by manual journal? | Yes (E37), for the account's own return only. |

---

## 14. Decisions for the account holder before building

These are product or policy calls, not accounting questions. The design assumes the default shown; Phase 2 starts on that basis unless the account holder says otherwise.

| # | Decision | Default assumed |
|---|---|---|
| D1 | Approve the four flag-off exceptions **EX-1 … EX-4** and the removed-lines allowlist (§1.4 point 5, §9). | Proposed; applied only after approval at the merge gate. |
| D2 | Should the **accountant** role preset get the `settings` capability (close, reopen and lock periods, lock VAT returns, edit the chart, post adjustments into closed months)? It follows from the preset's existing keys (`permissions.ts:224-226`). | Yes. |
| D3 | **Straight-line rent deferral on by default** (Q23). It changes when revenue appears on the P&L for semi-annual and annual rent. | On. |
| D4 | **Advance VAT** (Q22): VAT booked when an advance arrives will appear in the VAT summary earlier than the invoices do today. | On. |
| D5 | **Owner mode is refused** for an account whose landlords include third parties (§4.2). | Refused. |
| D6 | During the beta, a ZATCA-integrated account **cannot approve** an S-rated agency-fee document or a VAT-bearing v2 commission document (§9 E8, Q6b). | Refused until Q6b is decided. |
| D7 | Terminating a contract under v2 **requires a disposition** for every open installment (§4.6), a stricter dialog than today's. | Required. |
| D8 | The staging bypass codes are published in the public repo's `DARA-NOTES.md` (around line 968 on master). That is outside this design's scope and was not edited; the account holder should decide whether to move them to a private note and rotate them. | Not changed here. |
| D9 | `dara-mobile` is read (not changed) in Phase 2 to see how it renders the two new document kinds (§12.2). | Read-only check. |

---

## Appendix A. Review decisions (revision 2)

Two reviews of revision 1 were applied: an accounting review (Saudi CA view: SOCPA, IFRS for SMEs, KSA VAT) and a staff-engineering review. Each finding was checked against the code on `feat/finance-v2` (`3eb2e4a`) before it was applied. **A** = accounting, **E** = engineering; B = blocking, S = should-fix, N = nit.

### Applied as proposed

| Finding | Where it landed |
|---|---|
| A-B1 advance-payment VAT tax point | §4.1 (4), E34, `finance_installment_vat_points`, §6.3, §7.5 box 1, R1/R5, Q22, §11.1(f) |
| A-B2 straight-line rent (s.20.25) | §4.1 (3), E35, `defer_rent_straight_line`, §4.5, Q13 → Q23 |
| A-B3 no charges after the contract ends | §4.1 exclusions, §4.6, §5.6, `finance_contract_dims.ended_on`, R7 |
| A-B4 `generate-installments` double charge (verified: `contracts.module.ts:1169-1185` deletes every `pending`/`settled_external` row) | E23 fork returns 409 |
| A-B5 reverse and replace instead of the remainder | §4.1, E01, E05, E06, §6.3; `alreadyCharged` removed; R5 |
| A-B6 deposit voucher and collections double cash (verified: `VOUCHER_KINDS` at `billing.module.ts:189`, collections at `:1164-1236`) | §4.4.1 classifier, E09 posts only the unlinked amount |
| A-S1 commission credit notes | E36, §4.5, Q24 (write-offs left as a question) |
| A-S2 / E-S13 closing entry zeroes the P&L | §7.1, §7.3, §7.4, §8.1 |
| A-S3 VAT lock blocks audit adjustments | `vat_locked_at`, period trigger, §4.7, §7.5, §8.1 |
| A-S4 VAT settlement posting | E37, `finance_vat_return_drafts.id`, Q26 |
| A-S5 Owner mode with third-party landlords | §4.2 precondition, §1.5, Q14 |
| A-S7 R1 formula | §7.10 R1 |
| A-S8 R3 explanations | §7.10 R3 (verified `reports.module.ts:99-111`) |
| A-S9 R4 formula | §7.10 R4 |
| A-S10 landlord-charged expense VAT lines | E18, §8.2(b) |
| A-S11 partial-exemption apportionment | §8.2(b), `input_vat_method`, Q25 |
| A-S12 / E-B2 v2 kinds reaching ZATCA or legacy approve (verified: `runZatcaSubmission` skips only `commission`, `:1642-1645`; `submit-zatca` at `:1506-1569`; `TAX_EXEMPT_KINDS` at `:171`) | EX-4 |
| A-S13 agency-fee VAT | E17, §9 E8, Q6b, Q12 |
| A-S14 investment property wording | §3, Q18 |
| A-S15 / same-day divergence | charge only when `due_date < today`, §4.1, §5.6, §6.3 |
| A-S16 period-close checks | §8.1 |
| A-S17 / E-S14 balance-sheet reclass order | §7.4 |
| A-N1 box 2 label | §7.5 |
| A-N2 / E-S16 system-key leaves turning into groups | §2.3.2 guard, §3 |
| A-N3 / E-N3 code layout | taxes recoded 2150–2154, employees 2160–2162, 2170, 2180 |
| A-N4 deleted contracts in the recognizer | §5.6 |
| A-N5 non-recoverable VAT on capitalised items | §3 |
| A-N6 dashboard "revenue" label | §9 E2 |
| A-N7 aging coverage as of `asOf`, de-duplicated collections | §7.6 |
| A-N8 E12b on the landlord statement | §7.8 |
| A-N9 unregistered seller: `vat_unregistered_seller`; residential is O | §4.1 |
| A-N10 cutover opening proposal | §6.2 |
| A-N11 balance trigger O(n²) | §2.4.1 (once per entry per transaction) |
| E-B1 personal data and a working login in a public repo | §1.6 rewritten; account emails, alias pattern and sign-in method removed; D8 for DARA-NOTES |
| E-B3 do not fork approve | §10.2, §9 E1/E9, `GET …/tenant-credit` |
| E-B4 session locks on the shared pool (verified: `createAuxPool` at `db/src/index.ts:63-66`, `news.lock.ts:30,47`) | §5.3, §6.1 |
| E-B5 facts frozen at enqueue | §5.1, §5.3 (state read at post time, `blocked_on`) |
| E-B6 charge key cannot represent a re-charge | `finance_installment_charges` generations; E27 no longer reverses the charge (settlement is E33) |
| E-B7 catch-up double-posts deposit refunds / misclassifies | E10 one key on both paths; §4.4.1 classifier reads every side table; §11.2 catch-up property test |
| E-S1 fail-closed under pool pressure | §1.2 |
| E-S2 additive-diff cannot be satisfied | §1.4 allowlist; barrel not edited |
| E-S3 DI cycle | §5 core/v2 modules |
| E-S4 posting before the dry-run is reviewed | §1.5 `ledger_started_at`, §6.1 |
| E-S5 account-holder test and capability table (verified: owner-mobile `ownerUserId: null`, `jwt-auth.guard.ts:66-78`) | §8.1, §10.1, D2 |
| E-S6 POST actions not audited (verified `audit.module.ts:32`) | §5.5, §7.5, §8.1 |
| E-S7 `23505` inside a transaction | §2.4.4, §5.3 |
| E-S8 reversal after a failed original | §5.3, §5.4 |
| E-S9 catch-up ignores deletions | §6.3 |
| E-S10 `ensurePeriod` / `entry_no` races | §2.3.3, §5.3 |
| E-S12 UTC-stamped collections on hooked paths (verified `payments.module.ts:541`) | §9 other findings, `date_defaulted_utc` |
| E-S15 cutover opening vs one-opening index | §6.2 (draft only) |
| E-S17 default trust bank | `bank_accounts_default_uq` |
| E-S18 `paid` rows without money turning overdue | `paid_unverified`, §9 E4 |
| E-S19 VAT split parity | §2.1, §11.1(k) |
| E-S20 payout `ownerId` unchecked (verified `reports.module.ts:448-460`) | EX-3 |
| E-S21 integration tests would not run in CI (verified `package.json:12`, `ci.yml:27-39,83`) | §2.2, §11.3 |
| E-S22 E5 root cause (verified `contracts.module.ts:876,1200`) | §9 E5 |
| E-N1 generic table names | §2.2 collision guard |
| E-N4 `needRows` line and the existing `accounting` key | §10.3 |
| E-N5 `240638d` on no remote branch | §9 E2 |
| E-N6 kick before commit | §5.1 |
| E-N7 snapshot runs on the same Riyadh date | §11.4 |
| E-N8 dates inferred from `updated_at` drift | E10, E11, §6.3 |
| E-N10 mobile and unknown kinds | §12.2, D9 |
| E-N11 fiscal-year start change | §2.3.3, Q21 |
| E-N12 double audit of the admin PATCH | §1.5 |

### Applied with changes, or rejected

| Finding | Decision and reason |
|---|---|
| A-S6 Ejar-paid should post an "Ejar-reported collection" | **Applied differently.** Posting a ledger-only collection with no `payment_collections` row would leave the sub-ledger open item in place and break R1. Instead the installment stays `settled_external` (closed in the sub-ledger), is **charged** like any other, and a separate settlement entry E33 clears AR: principal Dr 1116 / Cr AR; **agent Dr 2122 / Cr 1122**, not Dr 1116, because the tenant paid the landlord directly and no money passed through the account. |
| E-B6 option "refuse settle/revert on any charged installment" | **Not chosen**; the generation key was adopted instead, and settle/revert no longer touch the charge at all (E27, E33). A second settle after a revert is refused, so the E33 key is never reused. |
| E-S11 "the v2 receipt-voucher override must take `(uid, 1)` because that series is shared with payment confirmations" | **Rejected as stated.** `(uid, 1)` is the **INV** series lock (`billing.module.ts:940-942`; `payment-confirmations.module.ts:46,460` mints INV drafts). RV numbers come from `nextReceiptVoucherNumber` (`src/common/receipt-number.ts`), called under `(uid, 11)` by contract create (`contracts.module.ts:1033,1058`), under `(uid, docId)` by `/collect` (`billing.module.ts:1971,1985`) and under no lock by `createReceiptVoucher` (`:1138`). The v2 override takes `(uid, 11)`; the residual race with legacy `/collect` is documented (§9 other findings). The negative-constant scheme for new series was applied. |
| E-N2 wrap purge and the legacy hard deletes in one transaction | **Rejected.** Wrapping would edit legacy lines. The purge runs unconditionally **after** the legacy deletes succeed; a failed purge only orphans harmless rows (§2.4.5). The other parts (unconditional; `security definer` dropped; honest description of `fv2.purge`) were applied. |
| A-N12 protect `fv2.purge` with `current_user` or a role-owned function | **Rejected.** There is one DB role and the app owns the tables, so neither check adds protection. The setting is documented as an accident guard, with a CI grep that confines it to the purge function. |
| E-N9 DISCOVERY §0.6 "a failed block does not stop boot" is too broad (`PASSIVE_MIGRATIONS` rethrows, `bootstrap.ts:90-93`) | **Agreed; not applied here.** This revision edits only DESIGN.md; the correction belongs in DISCOVERY.md. `0066` runs in its own try/catch block (§2.2), so the design is unaffected. |
| A-S1 commission adjustment on **write-offs** | **Deferred to the accountant** (Q24): whether a manager keeps commission on rent it billed but never collected is a policy question, not an error. |
| Q13 (defer rent invoiced before its due date) | **Superseded** by Q23: with straight-line on, every principal rent charge goes through 2131 regardless of the invoice date. |
