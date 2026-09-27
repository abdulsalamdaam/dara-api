# Finance v2 (beta): Test report

Phase 5 of the Finance v2 brief, plus the Phase 6 local preview. Date: 2026-09-27.

- Branch `feat/finance-v2`. Final heads: `dara-api` `e65e220` (plus this file), `dara-web` `d7b1e5f`. Base: `origin/master` `3eb2e4a` (API) and `69a7312` (web).
- **Public repo.** This report names no person, address, phone, email, VAT/CR/ID number or database id from staging. The two staging test accounts are called **the flag-off test account** (the accountant's existing account, never switched on) and **the beta test account** (its synthetic twin, seeded through the staging API with the same amounts). Every amount below comes from that synthetic seed or from generated test data. Screenshots, snapshots, logs and PDFs are kept locally, outside both repos.
- Every run used a local, disposable Postgres 16 (port 55432). No run loaded `dara-api/.env`; `DATABASE_URL` and `API_PORT` were passed explicitly and echoed before each start. Local copies of staging were neutered before any API started on them (no push tokens, no OTP rows, foreign emails rewritten to `@example.invalid`, dummy phones, no ZATCA or Ejar credentials, no third-party keys), and every local API ran with SMTP, SMS, push, ZATCA, Ejar, X, Anthropic and Apify variables unset and the news and finance-v2 schedulers disabled by their env flags. The preview API also ran behind a loopback-only network guard; it blocked 0 connections.
- Nothing was pushed, merged or deployed. `main` and `master` are untouched in both repos.

## 1. Summary

| Check (brief Phase 5) | Result |
|---|---|
| Unit tests (every rule balances in both modes, idempotency, reversal nets to zero, closed periods refuse, aging buckets, VAT boxes) | All present and passing; 5 rule tests added in Phase 5 |
| Property / invariant tests | 1,100 randomized sequences across 4 seeds (about 35,000 entries) before the reviews; 500 re-run after the review fixes (seeds 20260927 and 1, 125 with a trust account). 0 failures. 9 engine bugs found and fixed |
| Integration: backfill reproduces expected balances; a second run posts nothing | Pass (hand-computed balances matched exactly; second run 0 entries) |
| Flag-off snapshot, master vs branch | 90 endpoints, 89 byte-identical; the 1 difference is master's own boot timestamp (§5) |
| Flag-off write parity | 17 cases, 16 identical; the 1 difference is the EX-3 security fix (§5) |
| Existing suites | `dara-api` 1,295 tests, 1,294 pass; the 1 failure is a pre-existing test-database gap that fails identically on master (§6) |
| ZATCA | The four signing files and the Dockerfile: 0-byte diff against `origin/master` (§7) |
| E2E journey, beta account | 6/6 steps done in the UI; every report figure equals the hand calculation (§8) |
| E2E, flag-off account | No beta UI in 22 page reads; key totals equal master's (§8.4) |
| Reviews | Correctness, accounting, security, RTL/UI: 4 blocking + 18 should-fix found; all fixed, one (A3) only in part (§10) |
| Final gates | All pass (§11) |

## 2. Unit tests

Specs live next to the code in `src/modules/finance-v2/` (32 spec files: 18 pure, 14 DB-backed). The pure ones use `node:test` with no DB.

- **Posting rules** (`rules/rules.spec.ts`): every event in DESIGN §4.4 is posted in both Owner and Manager mode, and each resulting entry is asserted to balance to the halala. Phase 5 added 5 cases for advance VAT and for the revenue account of released rent.
- **Idempotency** (`posting.db.spec.ts`, `ledger.db.spec.ts`): replaying an event key posts nothing and marks the outbox row posted; the same key with a different payload is refused (`KEY_COLLISION`).
- **Reversal nets to zero**: every reversal is checked line by line against its original, per account and dimension.
- **Closed periods** (`manual-periods.db.spec.ts`): the DB trigger refuses a posting into a closed period; a late event moves to the next open period and is flagged.
- **Aging buckets** (`reports/core-math.spec.ts`, `reports/core-reports.db.spec.ts`): 0–30 / 31–60 / 61–90 / 90+ with part-paid installments counted at their remaining amount.
- **VAT boxes** (`reports/sub-math.spec.ts`, `reports/sub-reports.db.spec.ts`): boxes 1–16, including adjustments, exempt and out-of-scope supplies, input VAT and apportionment.
- **Bug fixes E1–E9** (`overrides/bugs.db.spec.ts`, `overrides/payment-status-v2.spec.ts`): each started as a failing test and pins the legacy behaviour next to the fixed one.

At `fc2aad1` the pure finance-v2 unit tests were 138/138.

## 3. Property and invariant tests

`src/modules/finance-v2/invariants.db.spec.ts` drives seeded random event sequences through the real routes and the posting engine, on a fresh schema per run. Events: contract create, invoices, partial and full collections, credit notes, deposits received, refunded and forfeited, advance rent, expenses, payouts, termination with every disposition, and cancellations. Half the sequences run in each accounting mode; since the A3 fix every fourth sequence also keeps client money in a trust account.

After each sequence it asserts:
- the trial balance and every entry balance;
- the reconciliation checks R1–R8 are zero (R3 after its own listed explanations, see §12);
- no failed or pending outbox rows, and a second recognizer/worker pass posts nothing;
- a rebuild of the ledger by backfill gives the same balances per account and dimension, VAT bases included;
- a second backfill posts nothing.

| Run | Seed | Sequences | Result |
|---|---|---|---|
| Default (`pnpm test`) | 20260927 | 200 | pass |
| Extra | 1 | 300 | pass |
| Extra | 424242 | 300 | pass |
| Extra | 77000 | 300 | pass |
| **Total before the reviews** | | **1,100** (about 35,000 journal entries) | **0 failures** |
| After the review fixes | 20260927 | 200 | pass |
| After the review fixes | 1 | 300 (125 with a trust account across both runs) | pass |

**Bugs the property tests found** (all fixed in `d4e74ac`, each with a fixed regression scenario that fails on the old code; 7 scenarios for the 7 engine bugs, plus 2 reconciliation fixes):
1. Backfill of a written-off installment cleared money never charged to the tenant.
2. Backfill of a cancelled installment with a payment on it booked the payment as an advance with advance VAT, unlike live posting.
3. A refund on a charged installment reversed advance VAT that the charge had already absorbed.
4. Cancelling an installment reversed its advance VAT only if the daily charge job had not run yet.
5. A write-off plus an advance refund in the same termination left the refunded part owed.
6. Straight-line release booked to 4120 even when the charge went to 4110 (non-VAT invoice).
7. R1 kept a written-off invoiced installment as an open item.
8. R1 counted an installment due today as receivable, though the charge job books it tomorrow.
9. R3 left out payouts to a landlord with no contract; they are now added and listed under a new explanation (label added in both web locale files, `dara-web` `8000131`).

DESIGN.md was updated for fixes 3 and 4.

## 4. Integration tests (disposable Postgres) and backfill

- `backfill/backfill.db.spec.ts`: a company built with Finance v2 **off** through the legacy routes is then switched on and backfilled. The result matches hand-computed balances exactly: 1111 1,650; 1113 1,100; 1122 1,800; 2121 −750; 2122 −1,800; 2141 −2,000; output VAT 450 on a base of 3,000. A second run posts 0 entries. Dry-run output is checked against the real run.
- The DB specs use `FV2_TEST_DATABASE_URL` (a local throwaway database) and refuse any non-local URL.

**Backfill of the beta test account** (local preview, a neutered copy of staging): dry run, then the real run posted 114 events as 100 entries, 0 failed, 14 skipped as already charged; total debits = total credits = 1,476,834.12. A second dry run after the E2E journey found 0 new events (103 already posted, 15 already handled).

## 5. Regression proof of isolation (flag off)

**Setup.** Two local APIs against two identical neutered copies of the staging database (same row fingerprints): `origin/master` `3eb2e4a` on one port, the branch on another. Both ran with `TZ=UTC`, the same local JWT secret and encryption key, from an empty working directory (so no `.env` could load), with every outbound integration unset. The branch applied migrations 0066–0069 at boot (35 new tables). Requests used a locally minted token for the flag-off test account, and both servers were hit at the same moment for each URL. The snapshot was taken at `d781b6f` and **re-run after the review fixes** (because `main.ts` changed) with the same result.

**Read snapshot: 90 endpoints, 89 byte-identical** (body bytes, status and content type compared by sha256; nothing normalised).
- 82 are every finance call the current UI makes (DISCOVERY §7 items 1–39 with their query variants, plus `me/package`, `auth/me/permissions`, `auth/me`): all 82 identical.
- 8 are the non-finance reads those screens also make: 7 identical. `GET /api/profile` differs only in `role.updatedAt`. Cause: master's `bootstrap.ts` (unchanged by the branch) rewrites the system roles on every boot with `updated_at = now()`, so the field is the server's start time; restarting master alone changes it too. With that one field masked, identical.
- Items 38a/38b (the export's `pageSize=1000`) return 400 on both, as DISCOVERY predicted; this is what EX-1 fixes on the web side.
- Database level: 39 of master's 42 tables identical row for row after the reads; the other 3 differ only in clock values (`app_logs`, the Ejar health check time in `app_settings`, `roles.updated_at`). All 35 new tables held 0 rows, and there were 0 `finance_settings` rows.

**Write parity: 17 cases, 16 identical** after masking request-time `createdAt`/`updatedAt` (partial collection, full collection, collection over the balance → 400, credit-note draft, credit note over the invoice total → 400, expense, expense with no category → 400, landlord payout, then 8 reads). The resulting rows (timestamp columns dropped) are identical in every table except `expenses`, because of the one intended difference:
- **W9**: an expense naming another account's landlord and property. Master stores it (201); the branch refuses it (400). This is **EX-3**, the security fix proposed in DESIGN §9 for approval.

**Cross-account check.** With the beta account's full journey already posted in the same database, the flag-off account's 69 GET endpoints were compared with master: 65 byte-identical, 4 differ only in startup timestamps or the key order of `stats.byType` with equal values. Key totals equal on both builds (overdue, collected, pending, three tenant arrears, 7 tenant-statement rows).

**Flag-off behaviour changes that do exist** (all listed for approval): EX-1 (web exports walk pages of 200), EX-2 (ZATCA settings action cell wraps), EX-3 (expense and payout ids must belong to the caller's account), EX-4 (the two v2 document kinds are refused by legacy approve and skipped by ZATCA submission; no-ops for accounts that never had v2). Also: 4 new migrations and 35 tables at boot; three new schedulers that skip every account whose ledger has not started; one extra `GET /finance/v2/status` per portal load; and a 3 MB JSON body limit on the two v2 bank-statement routes only (every other route keeps 100 KB).

**Artifacts** (kept locally outside both repos; paths in the private merge-gate brief): the summary and normalisation notes, raw bodies for all 90 endpoints on both builds, the write replay, table and row hashes, and the test and build logs.

## 6. Existing suites

| Suite | Master (`3eb2e4a`) | Branch |
|---|---|---|
| `dara-api` `pnpm test` (local `dara_test` + `fv2_test`) | 735 tests, 734 pass | 1,295 tests, 1,294 pass (final) |
| `dara-api` type check | 0 errors | 0 errors |
| `dara-web` type check | 7 errors (baseline: `NewContractModal`, `PropertyUnitsModal`, `api/core.ts`) | the same 7 |
| `dara-web` `next build` | pass | pass, 12/12 pages |
| `dara-web` pure tests (`node --test`) | n/a | 5 files, 60/60 |

The one API failure, on both builds, is `ejar.import.spec` ("region resolves to a lookup FK"): the local `dara_test` database has no region/city lookups. Against a database that has them it passes 10/10 on both.

## 7. ZATCA

No invoice XML path changed, so the SDK workflow was not needed; the proof is the empty diff. `git diff origin/master` of `invoice-signer.service.ts`, `invoice-builder.service.ts`, `qr.service.ts`, `zatca-assets.ts` and the `Dockerfile` is **0 bytes** at HEAD and in the working tree, and the file hashes are identical. The two new document kinds (`rent_receipt`, `agency_fee`) never reach the ZATCA orchestration (EX-4, tested with the flag off).

## 8. End-to-end journey (Phase 6 option b: local)

Run locally against a neutered copy of staging (option b), with the branch API and a separate copy of the web, in headless Chrome (Playwright). Dates are as of 2026-09-27.

### 8.1 Switch and backfill (admin console)
The flag was turned on for the beta test account only, in Manager mode with a reason: 2 audit events (enabled, mode set). Dry run, then real run (§4).

### 8.2 Journey as the beta test account (the café contract, October installment)

| Step | Entry posted (= hand-computed) |
|---|---|
| Invoice → approve (6,000 + VAT 900) | Dr 1121 6,900 / Cr 2131 6,000 / Cr 2151 900 |
| Partial collection, cash | Dr 1111 3,000 / Cr 1121 3,000 |
| Credit note (1,000 + VAT 150) | Dr 2131 1,000 / Dr 2151 150 / Cr 1121 1,150 |
| Expense with VAT | Dr 5190 2,000 / Dr 1151 300 / Cr 1113 2,300 |
| Payout to the individual landlord | Dr 2121 40,000 / Cr 1113 40,000 |

### 8.3 Expected vs actual
Expected = the post-backfill figure plus the journey entries; actual = what the API, the UI (Arabic and English, 1440 px and 390 px) and the landlord statement PDF showed. **Identical in every row.**

| Report | Line | Expected = actual |
|---|---|---|
| TB | 1111 cash | 43,500 + 3,000 = 46,500 |
| TB | 1113 bank | 493,175 − 2,300 − 40,000 = 450,875 |
| TB | 1121 receivables | 22,150 + 6,900 − 3,000 − 1,150 = 24,900 |
| TB | 1151 input VAT | 300 |
| TB | 2121 landlord payable | 96,000 − 40,000 = 56,000 |
| TB | 2131 unearned rent | 50,465.88 + 6,000 − 1,000 = 55,465.88 |
| TB | 2141 deposits | 41,000 |
| TB | 2151 output VAT | 42,825 + 900 − 150 = 43,575 |
| TB | Closing totals | 524,575.00 = 524,575.00 |
| P&L (1 Jan – 27 Sep) | Revenue / expenses / net | 286,023.13 / 2,000 / 284,023.13 |
| Balance sheet | Assets | 522,575 |
| Balance sheet | Liabilities / equity | 196,040.88 / 326,534.12 (this year 284,023.13 + prior years 42,510.99) |
| VAT Q3 | Box 1 | sales 49,500 + 6,000 = 55,500; adjustment −1,000; VAT 7,425 + 900 − 150 = 8,175 |
| VAT Q3 | Box 5 exempt / box 7 purchases | 16,500 / 2,000 (VAT 300) |
| VAT Q3 | Net due (box 13 = box 16) | 8,175 − 300 = 7,875 |
| AR aging | Not due / 0–30 / 31–60 | 2,750 / 8,900 / 14,400 |
| AR aging | Open / unapplied credit / net | 26,050 / −1,150 / 24,900 (ties to the ledger) |
| Landlord statement, individual landlord (screen and PDF) | Opening / payout / closing | 96,000 / 40,000 / 56,000 (the legacy dues report also says 56,000) |
| Reconciliation | R1–R8 | all OK, 0 difference |

The starting figures were checked against their source records: cash + bank 536,675 = collected 495,675 + deposits 41,000; output VAT 42,825 = 42,975 on 15 invoices − 150 credit note; unearned rent 50,465.88 = the unreleased days of each covered installment, contract by contract.

### 8.4 Flag-off test account
- No beta badge and no "المحاسبة (تجريبي)" section in 22 page reads (11 pages × Arabic and English).
- API parity with master: see §5, cross-account check.

### 8.5 Bugs found by the E2E
- **Fixed** (`fc2aad1`, failing test first): a fee line named "<fee> — <month>" was classified as rent, deferred to 2131 and never released (4,500 of service fees missing from the P&L on the beta account).
- **Fixed** (`dara-web` `552903c`): the beta badge slid under the language switcher at 360–768 px; a Playwright overlap check failed at 6 of 8 sizes before and passes 8/8 after.
- **Fixed after review** (`dara-web` `cc8513b`): the backfill report showed a green "controls reconcile" when it had compared nothing.
- Not fixed: see §12.

## 9. Screenshots

135 screenshots (80 Arabic, 55 English) and 3 landlord-statement PDFs, kept locally outside both repos:
- all 26 "المحاسبة (تجريبي)" screens in both languages at 1440 px;
- 10 main screens at 390 px in both languages (TB, P&L, balance sheet, VAT, AR aging, landlord statement, chart of accounts, journal, v2 documents, bank accounts);
- the dashboard with the badge, and the new "paid from" parts of the collect, expense and payout dialogs;
- the admin switch, history and backfill screens (dry-run and real results);
- Arabic only: each journey step, the second dry run, and the flag-off account's pages.

## 10. Reviews

Four independent reviewers read the full diff of both repos against `origin/master`. Every finding was verified against the code before it was fixed; each fix has a test that failed before it.

### 10.1 Correctness (0 blocking, 3 should-fix, 5 nits)
| Finding | Outcome |
|---|---|
| C1 two terminates (or terminate + collect) at once collect the same installment twice | **Fixed** `ce8a416`: per-installment advisory locks in id order, remaining re-read under the lock |
| C2 rows blocked behind a failed/backing-off row fill every batch and stall the account | **Fixed** `47343d6` |
| C3 backfills hold both lock-pool clients and freeze posting for every account | **Fixed** `f553a16`: separate pool for long-held locks |
| Nits: flag-off EX changes are in the code (to present at the gate), lost kicks during a tick, refund-number race, per-process flag cache, per-instance schedulers | Not changed; listed in §12 and in the merge-gate brief |

### 10.2 Accounting (1 blocking, 5 should-fix, 5 nits)
| Finding | Outcome |
|---|---|
| A1 (blocking) agency-fee collection under an agent contract credited the landlord with the manager's fee | **Fixed** `c4c85e3`: Dr operating bank / Cr 1121 |
| A2 closing December as a month locked out the year's closing entry; prior unclosed years ignored | **Fixed** `ab714e3`, web `ab3fa8f` (`USE_CLOSE_YEAR`, `PRIOR_YEAR_OPEN`) |
| A3 agent money flows ignored the trust account | **Fixed in part** `0d46523` (deposits, refunds, credit refunds, agent payouts). **Rejected** for commission cash: it is the account's own fee and belongs in the operating account |
| A4 "no VAT" line always exempt | **Fixed** `86e729b`: E only for a registered seller's residential rent, otherwise O (warning for commercial) |
| A5 input VAT claimed without a supplier VAT number | **Fixed** `f57015f`, web `5e98dc5` (`SUPPLIER_VAT_REQUIRED`; default not recoverable) |
| A6 VAT settlement booked box 13 only | **Fixed** `ad39c56`: box-15 credit taken off 1152, so 2152 = box 16; box 14 warns `box14_needs_manual_journal` |
| Nits 7–11 (advance-VAT reversals in the sales column, hard-coded 15% on forfeits/commission/agency fee, landlord-charged expense VAT tag, bad-debt relief hint, transient R1 on due date) | Not changed; §12 |

### 10.3 Security (0 blocking, 3 should-fix, 5 nits)
Tested with 104 cross-account requests (every new resource and report, plus foreign ids nested in bodies): all refused or empty. 34 routes × 3 employee roles: every write route 403 without its capability. Landlord mobile-app token: 403 on every finance route except its own statement. Admin switch: super-admin only, reason required, audited. Attachments, amount parsing, SQL parameterization, CSV formula neutralization, PDF/print escaping: all sound. History scan of all branch commits (30,440 changed lines) for personal data and secrets: only synthetic values.

| Finding | Outcome |
|---|---|
| S1 some POST actions left no `audit_logs` row (write-offs, chart accounts, rent-receipt and agency-fee drafts, real backfill runs) | **Fixed** `bbc8bdf`; backfill also writes a history row under the target account |
| S2 VAT return draft accepted another account's landlord as seller | **Fixed** `21aaf8d` (404) |
| S3 bank statements over about 100 KB were refused (413) | **Fixed** `be00cee`: 3 MB on the two statement routes only; a 120 KB body on another route still returns 413 |
| Nits: unvalidated limit/offset → 500, extreme dates → 500, permission-check consistency on two draft routes, report iframe not sandboxed, `fv2.purge` bypass for direct DB users | Not changed; §12 |

### 10.4 RTL / UI (3 blocking, 7 should-fix, 8 nits)
Passed: ar/en key parity (2,261 `t()` calls, none missing), 26 screens × 2 languages × 2 widths with no horizontal scroll, correct `dir`, no physical left/right classes, no raw Tailwind blues/slates, PDF shaping and font, Excel RTL sheets.

| Finding | Outcome |
|---|---|
| U1 (blocking) reconciliation notes never translated (`keySeparator:false`) | **Fixed** `707233e` |
| U2 (blocking) VAT apportionment reason shown as a raw code | **Fixed** `707233e` |
| U3 (blocking) six posting skip reasons unlabeled | **Fixed** `707233e`; API `bec5019` lists every reason and a source scan fails on an unlisted one |
| U4 VAT document check printed raw codes; U5 `dismissed` unlabeled; U7 raw payment method in the v2 receipts export | **Fixed** `707233e`, `77f09a0` |
| U6 printed vouchers not in the brand font | **Fixed** `96f5166` |
| U8 payout dialog and export menu hid the server's error | **Fixed** `4175fd5` |
| U9 user text pointed to a repo file | **Fixed** `63e7472` |
| U10 badge squeezed the page title on phones | **Fixed** `0ae65ac` (hidden below `sm`) |
| Nits: plural forms, Arabic comma in English, deposit detection by Arabic text, inline `L(ar,en)` pairs, raw status colours, ISO dates, near-duplicate card names, skeleton column count | Not changed; §12 |

Two gate issues were also fixed: `707233e` had edited the legacy billing export by mistake (caught by the additive-diff gate, restored in `77f09a0`), and the additive-diff gate's `fv2.purge` string check now exempts spec files (`e65e220`). A build artifact committed by accident in `77f09a0` (`tsconfig.tsbuildinfo`) was restored in `d7b1e5f`.

## 11. Final gate results (after the review fixes)

| Check | Result |
|---|---|
| `dara-api` full suite, local DB only | 1,295 tests, 1,294 pass (the known `ejar.import.spec` lookup gap) |
| Property tests | 200/200 (seed 20260927) and 300/300 (seed 1) |
| API type check | 0 errors |
| Web type check | 7 errors, the same baseline files |
| Web tests | 5 files, 60/60 |
| `next build` | pass, 12/12 pages |
| Additive-diff gate | OK in both repos |
| ZATCA four files + Dockerfile vs `origin/master` | 0 bytes |
| Flag-off read snapshot (re-run) | 89/90 identical; the only difference is still master's boot timestamp |

## 12. Known gaps

**Not fixed, by decision**
- **Collect dialog ignores an applied credit note** (existing master screen, visible under v2): it shows 3,900 remaining where the ledger says 2,750. The API refuses anything above 2,750, so over-collection cannot happen; changing the display would change a flag-off screen.
- **UTC "today" on legacy write paths** (`billing.module.ts` `today()` and web date defaults): between midnight and 03:00 Riyadh, documents default to yesterday. Existing master code used with the flag off; the v2 dialogs use Riyadh dates.
- **R3 residual differences** come from the legacy dues report (it ignores forfeited deposits and counts a commission credit note the wrong way). The v2 reconciliation lists them as explanations; the legacy report is left alone so flag-off screens stay identical.

**Test limits**
- Revenue timing can differ between live posting and backfill when a document is back-dated after releases have posted (the unearned/revenue split differs; the total per contract is equal). The property test compares the two together per contract.
- Receipts on a contract that has already ended cannot be reproduced by backfill; the property test records receipts only on running contracts.
- Seeds 424242 and 77000 were run before the review fixes only.
- The E2E ran locally (option b), not on a staging deploy. Locally, ZATCA shows `failed` on the new invoice (a dummy credential; nothing was sent) and file uploads are off, so the collection was made in cash.
- The Playwright scripts and screenshots are kept outside the repos; there is no committed browser suite.

**Open review nits** (none blocks the beta)
- Correctness: kicks lost during a running tick (≤ 5 s delay); a concurrent deposit-refund number can drop its refund record; the flag cache is per process (15 s); each API instance runs its own recognizer and sweep (duplicate history rows only).
- Accounting: advance-VAT reversals land in the box 1 sales column rather than adjustments; 15% is hard-coded for forfeits, commission and agency fee; landlord-charged expense VAT is always non-recoverable on the landlord statement; write-off dialog should mention bad-debt relief (Art. 40, Q15); a transient R1 difference on an installment's due date.
- Security: `limit`/`offset` and extreme dates can cause 500s; two draft routes use `invoices.write` rather than the `draft` capability; the report iframe has no `sandbox`; `fv2.purge` can be set by anyone with direct DB access.
- UI: missing plural forms, Arabic comma in English lists, deposit detection by Arabic wording, raw status colours, ISO dates, near-duplicate card names, an 8-column skeleton on a 9-column table.
- Minor E2E notes: with no category mapping an expense goes to 5190 though the dialog suggests the category decides; two clear buttons on the admin companies search; a hydration warning on the admin console in dev (not compared with master).
