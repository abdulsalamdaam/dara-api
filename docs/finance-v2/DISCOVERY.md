# Finance v2: Phase 0 Discovery

Branch `feat/finance-v2` in `dara-api` and `dara-web`. Both are based on `origin/master` (staging, `3eb2e4a`). This phase was read-only: no code was edited, nothing was committed or pushed, and nothing was written to staging or production. The only network call was a read-only `GET /api/healthz` on staging.

Paths are relative to `dara-api/` unless they are marked `dara-web:`. For dara-web, paths under `src/` are written without the `src/` prefix inside §3.

> **Public repo.** This file lives in `dara-api`, which is public. It contains no personal data. Test-account credentials and staging record ids are kept in the private write-up (`STAGING-ACCOUNTANT-TEST-ACCOUNT.md`, outside both repos), not here.

---

## 0. Executive summary

1. **There is no event bus or outbox.** The only cross-cutting hook is `AuditInterceptor`, which is fire-and-forget and skips POST (`src/modules/audit/audit.module.ts:25-51`). Every posting hook will have to be added by hand. Only four money paths run in a transaction:
   - `addCollection`
   - invoice `collect`
   - contract create
   - contract rebuild
2. **Two write sites destroy or mutate money records that may already be posted.**
   - Contract rebuild hard-deletes `payments` and `payment_collections` (`src/modules/contracts/contracts.module.ts:1390-1392`).
   - Terminate flips a confirmed deposit voucher to `cancelled` (`contracts.module.ts:1858`).

   The ledger must post reversals for both, and it cannot rely on the source rows still existing.
3. **Installments become `paid` with no cash behind them in five places** (bug E7):
   - `POST /payments` (`src/modules/payments/payments.module.ts:238-256`)
   - `PATCH /payments/:id` (`payments.module.ts:258-270`)
   - `DELETE /contracts/:id?mode=paid` (`contracts.module.ts:1670`)
   - terminate `mode:"paid"` (`contracts.module.ts:1808`)
   - Ejar `attachEjarInvoices` (`src/modules/ejar/ejar.module.ts:523+`)
4. **Money is stored as `numeric` everywhere**, but all arithmetic is done in JS floats with `round2`. `simple_invoices.items` stores numbers inside jsonb, and `expenses.expense_date` and `landlord_payouts.transfer_date` are `text`. Write paths use UTC for "today" even though `riyadhToday()` exists (`src/common/payment-status.ts:29-32`).
5. **Scope is `users.id`, not `companies.id`.** `scopeId = ownerUserId ?? id` (`src/common/scope.ts:9-11`), and individual accounts have no `companies` row. Recommendation: a new `finance_settings` table keyed by the account's user id, where a missing row means the flag is off, and the flag reader fails closed.
6. **Migrations actually run through `src/database/bootstrap.ts` `ensureSchema()`, not drizzle-kit.** Each DDL block is wrapped in a try/catch, and a failed block does not stop the API from booting. Copy the news pattern: an idempotent `db/drizzle/0066_finance_v2.sql` that bootstrap executes (`bootstrap.ts:564-575`). Never run `pnpm db:push`.
7. **Bugs E1, E3–E9 are confirmed.**
   - E4 is caused by the shared `liveStatus` rule, which treats `partially_paid` as settled.
   - E2 is refuted: the dashboard fields are already on master and on staging.
   - E10 is partly fixed already. What remains is a layout issue: the integrated-row action cell does not wrap.
8. **Tests.**
   - API: 623 pass, 0 fail and 99 skipped without a database. On a local throwaway database, 734 pass and 1 fails because the lookups table is empty.
   - API CI is red on master because of the skip baseline (94 allowed, 99 skipped).
   - `dara-web` has no tests. Its tsc baseline is 7 errors; the API's is 0.
9. **Web.**
   - There is no per-account flag channel today. `GET /api/me/package` is the natural place to carry one, or a new `GET /api/me/features` endpoint, which keeps existing payloads byte-identical.
   - The Reports view can host a flag-gated "المحاسبة (تجريبي)" category without changing the flag-off request set.
   - Two web export bugs were found: a probable 400 on the billing and receipt exports, and E6.
10. **Documentation drift.** The two `DARA-NOTES.md` copies are *not* identical: the dara-api copy is 1299 lines and the dara-web copy is 1191. Use the **dara-api copy** as the source of truth.

### Contradictions between the source reports, resolved against the code

| Topic | Reports said | Code says (resolution) |
|---|---|---|
| `round2` in payments | `payments.module.ts:20` vs `:21` | `:21` |
| Rebuild hard delete | `1390-1392` vs `1388-1392` | Deletes are at `contracts.module.ts:1390-1391` |
| Paid writes without a collection | remove `1667/1668-1671`; terminate `1806-1808/1809` | The `status:"paid"` set is at `:1670` (remove) and `:1808` (terminate) |
| `attachEjarInvoices` | `523-560` vs `521-559`; called at `:509` | Defined at `ejar.module.ts:523`, called at `:509` |
| `contract_units` hard-deleted "on termination at :1663" | pdf-bugs | Both paths do it: `:1663` in `remove()` (DELETE) **and** `:1803` in `terminate()` |
| `useCreatePayment` / `useUpdatePayment` line | `:1091/:1105` vs `:1100` | Hook definitions are at `dara-web: lib/api-hooks.ts:1086` and `:1100`. The other numbers point at the `api()` call inside each hook. No component imports either hook. |
| `collections-all` hook | `api-hooks.ts:2151` vs `:2164` | Hook at `:2151`, fetch URL at `:2164` |
| ZATCA non-wrapping action cell | `:186` vs `:196` (revoked branch "wraps at :176") | Revoked branch wraps at `ZatcaIntegrationView.tsx:170`. **The integrated branch has no wrap, at `:188`.** |
| `excludeDeposit=false` on the Receipt Vouchers screen | web-ui: dropped; pdf-bugs: sent | `buildListQS` drops `false` (`dara-web: lib/api/core.ts:191`), so it is not sent. The API only excludes when the value is `"true"` (`billing.module.ts:380`). The result is the same either way: deposits are included. |
| Bug E2 dashboard fields | "staging lacks them" (brief/PDF) | Refuted. `01ede96` is on master, and staging runs `3eb2e4a`. Production is the environment without them (§5, E2). |
| DARA-NOTES "identical in all repos" | CLAUDE.md files | False. The copies differ around §2b (ICV partial index, refused-document retry). Use the dara-api copy. |
| `TENANT_TABS` whitelist "gone" (DARA-NOTES §3) | web-ui | It still exists in the code: `dara-web: _legacy/DashboardPage.tsx:156`, enforced at `:221`. |

---

## 1. Write paths: where money state changes

The tables that hold money state are `payments`, `payment_collections`, `simple_invoices`, `expenses`, `landlord_payouts`, `invoices`, plus the deposit fields on `contracts`.

### 1.0 Findings that shape the ledger design

1. **No event bus and no outbox.** `AuditInterceptor` writes a fire-and-forget row after a successful PATCH, PUT or DELETE. It ignores POST (`audit.module.ts:25-51`).
2. **Transactional paths are the exception.**
   - These run in a transaction: `POST /payments/:id/collections`, `POST /simple-invoices/:id/collect`, contract create and contract rebuild.
   - These run as sequences of autocommit writes, so a crash part-way through leaves partial state: receipt vouchers, terminate, collect-deposit, Ejar import, bulk import, generate-installments, expenses and payouts.
3. **Rebuild hard-deletes collections and installments** (`contracts.module.ts:1390-1391`). **Terminate cancels a confirmed deposit voucher** (`:1858`). Both need reversal entries.
4. **Paid without a collection** happens at five sites (§1.2.11 and §1.2.7). `settle-external` does the same thing, but on purpose.
5. **`POST /payments`, `PATCH /payments/:id`, `settle-external` and `revert-external` have no UI caller** in `dara-web` or `dara-mobile`. The hooks `useCreatePayment` and `useUpdatePayment` exist (`dara-web: lib/api-hooks.ts:1086,1100`), but nothing imports them. Locking these endpoints down under v2 has no UI impact.
6. **"Today" is computed in UTC on write paths.** The call sites are:
   - `billing.module.ts:44`
   - `payments.module.ts:543`
   - `contracts.module.ts:679, 924, 1149, 1670, 1785`
   - `ejar.module.ts:381`
   - `payment-confirmations.module.ts:474`

   Between 21:00 and 24:00 Riyadh time these stamp the previous day. Posting dates should come from the source row's business date, with `riyadhToday()` as the default.
7. **No finance cron jobs exist.** The only timers are:
   - the app-log sweep (`src/common/logging/app-log.service.ts:72`)
   - the Ejar health refresh (`src/modules/ejar/ejar.policy.service.ts:59`)
   - the news scheduler (`src/modules/news/news.scheduler.service.ts:59`)

   Overdue status is derived when it is read (§1.3).

### 1.1 Amount types and VAT

- **Column types.** All stored amounts are `numeric`:

  | Column | Type | Where |
  |---|---|---|
  | `payments.amount` | numeric(12,2) | `db/src/schema/payments.ts:18` |
  | `payment_collections.amount` | numeric(12,2) | `paymentCollections.ts:21` |
  | `simple_invoices.subtotal`, `total` | numeric(14,2) | `simpleInvoices.ts:34-35` |
  | `expenses.amount` | numeric(12,2) | `expenses.ts:15` |
  | `landlord_payouts.amount` | numeric(12,2) | `landlordPayouts.ts:12` |
  | `contracts.monthly_rent` | numeric(14,**6**) | `contracts.ts:56` |
  | `contracts.deposit_amount` | numeric(12,2) | `contracts.ts:58` |
  | `contracts.agency_fee` | numeric(12,2) | `contracts.ts:98` |
  | `management_fee_percent` | numeric(5,2) | `owners.ts:26`, `properties.ts:63` |

- **Money stored outside numeric columns.**
  - `simple_invoices.items` is jsonb holding JS numbers (`simpleInvoices.ts:33`).
  - `invoices.totals` is jsonb (`invoices.ts:56-64,113`).
  - `contracts.additional_fees[].amount` and `custom_schedule[].amount` are strings inside jsonb.
  - `expense_date` and `transfer_date` are `text` and nullable (`expenses.ts:16`, `landlordPayouts.ts:13`).
- **Arithmetic uses JS floats.** Every module converts with `Number(...)` and rounds with `round2 = Math.round((n+EPSILON)*100)/100`. It is defined in `payments.module.ts:21`, `billing.module.ts:43`, `installments.ts:55` and `contracts.module.ts:15`, and re-declared inline at `contracts.module.ts:1093, 1130, 1707, 1758, 1784`. Results are written back with `.toFixed(2)`, and comparisons use a ±0.01 tolerance (`HALALA`, `billing.module.ts:153`). The ledger should convert to integer halalas at its boundary.
- **VAT on installments.**
  - VAT is included in `payments.amount`; `vat_enabled` marks it (`payments.ts:28-30`).
  - `buildInstallments` multiplies by 1.15 (`installments.ts:129,183,238,257`) and puts the rounding difference on the last row (`:74-82`).
  - Net amounts are recovered by dividing by 1.15 (`billing.module.ts:1067`, `payment-confirmations.module.ts:446`).
- **VAT on `simple_invoices`.**
  - VAT is implied as `total − subtotal`.
  - Each line carries a `vat` flag plus `vatCategory` and `exemptionReason` (`billing.module.ts:47-60`), checked by `assertTotalMatchesItems` (`:170-184`).
  - The items jsonb is the only per-line S/Z/E/O source for simple invoices. `invoice_lines.vat_category` covers only the ZATCA mirror (`invoiceLines.ts:10,22`).
- **Other VAT rules.**
  - Commission VAT is always on: `vatReg = true` at `billing.module.ts:1054`, which makes the lookup at `:1036-1051` dead code.
  - Receipt and deposit vouchers never carry VAT (`billing.module.ts:236-240`).
  - Whether rent carries VAT depends on the property usage, via an allowlist in `src/common/usage-vat.ts` (DARA-NOTES §4).

### 1.2 Write paths by event

All routes are under `/api`. **Perm** is the `@RequirePermissions` value on the route.

Which role presets hold which permission (`src/common/permissions.ts:170-260`):
- `payments.write`: general, collectionOfficer, accountant.
- `contracts.write`: the same, plus propertyManager and leasingOfficer.
- `contracts.delete`: full-admin presets only.

#### 1.2.1 Installment generation

| # | Route | Method (file:line) | Writes | Tx | Perm |
|---|---|---|---|---|---|
| a | `POST /contracts` | `create` `contracts.module.ts:1019-1050` → `materializeContract` `:901-1016` | contracts, contract_units, contract_rent_terms (`:907`), `units.status`, `payments` (`:922`), plus the advance collections and vouchers (see §1.2.4 and §1.2.6) | **Yes**: one tx plus an advisory lock `(ownerId, CONTRACT_NUMBER_LOCK)` at `:1036-1048` | contracts.write |
| b | `PATCH /contracts/:id` with `rebuild:true` | `rebuildContract` `:1255-1490` | **Hard DELETE** of collections and payments (`:1390-1391`); advance voucher set to `cancelled` with `deletedAt` (`:1400`); contract_units deleted (`:1414`); contract rewritten (`:1429`); `materializeContract(tx)` (`:1438`); audit row inside the tx (`:1464-1476`) | **Yes**: tx, lock and `FOR UPDATE` (`:1289-1296`) | contracts.write |
| c | `POST /contracts/:id/generate-installments` | `:1158-1206` | Soft-deletes pending and settled_external payments (`:1179`), then inserts the new schedule (`:1205`) | **No** | contracts.write |
| d | `PATCH /contracts/:id` (plain) | `update` `:1511-1620` | Contract fields including money fields; rent terms (`:1601-1606`). Does not touch payments. | No | contracts.write |
| e | `POST /import/bulk` | `src/modules/import/import.module.ts:58`, row handler `:236-252` | contracts, units, payments (`:251`); VAT always false; deposit amount stored but no voucher created | No | contracts.write |
| f | `POST /ejar/import` | `ejar.module.ts:310-514` | contracts (`:437`), payments (`:502`), then `attachEjarInvoices` (`:509` → `:523`), which sets `paid` or `partially_paid` with **no collection row and no paidDate** and writes `description` onto rent rows (`:544-552`) | No; schedule errors are swallowed (`:511`) | contracts.write |
| g | `POST /admin/demo/reset` | `src/modules/admin/admin.module.ts:1282-1296`, `demo-seed.ts:50,69` | Hard-deletes and reseeds the demo account's data | No | SuperAdmin |

Notes on these paths:
- **Rebuild guard.** Rebuild is refused when ZATCA invoices or foreign billing documents exist (`rebuildBlockReason`, `src/modules/contracts/rebuild.ts:224+`). Under v2, rebuild must post reversals for the destroyed advance collections and voucher. The outbox insert would go inside the tx, around `:1466`.
- **Ejar import.** Under v2 it must either post an opening or settled-outside entry, or leave the rows as receivables.
- **Ejar descriptions.** Ejar writes a `description` onto rent rows. That breaks the rule that rent rows have a null description, which two things depend on:
  - the commission base (`billing.module.ts:1062-1065`)
  - fee-first ordering (`:1206`)

  As a result, rent imported from Ejar is left out of the commission base.

#### 1.2.2 Invoice issued and approved

| Route | Method | Writes | Tx | Perm |
|---|---|---|---|---|
| `POST /simple-invoices` | `create` `billing.module.ts:763-990` | Draft invoice (`:941-962`); then re-points existing advance collections to the new invoice (`:974-981`) | Tx and lock `(uid, typeKey)` for numbering only; the `:975` update runs **outside** the tx | invoices.write |
| `PATCH /simple-invoices/:id` | `update` `:1243-1284` | Drafts only (`:1250`) | No | invoices.write |
| `POST /simple-invoices/:id/approve` | `approve` `:1329-1500` | `status='confirmed'` and `confirmedAt` (`:1480-1482`) → ZATCA mirror (`:1485`) → commission draft (`:1491-1495`) | No; the ZATCA and commission steps are best-effort | invoices.write |
| `POST /simple-invoices/:id/submit-zatca` | `:1506-1568` | ZATCA re-issue; soft-deletes refused attempts (`:1558`). Moves no money. | No | invoices.write |
| `PATCH /payment-confirmations/:id` (approve) | `review` `payment-confirmations.module.ts:382-495` | Status (`:399`); a draft invoice (`:458-481`, tx and lock); **push notification to the tenant** (`:486-499`) | Partial | payments.write |
| `POST /tenant/me/payment-confirmations` | `:129-212` | Pending confirmation only | No | TenantAuthGuard |

- **Where to post:** the `confirmed` update at `billing.module.ts:1480`, before the ZATCA call. Drafts do not post.
- **Accrual date:** `issueDate`, which defaults to UTC today (`:958`).
- **Do not test through confirmation approval.** It notifies a real tenant (hard rule 5).

#### 1.2.3 Collection and receipt voucher

| Route | Method | Writes | Tx | Perm |
|---|---|---|---|---|
| `POST /payments/:id/collections` | `addCollection` `payments.module.ts:516-570` | Collection (`:544`, no invoiceId); installment status, paidDate, receipt number (`:557`) | **Yes**: tx and `pg_advisory_xact_lock(scope, paymentId)` (`:525-526`) | payments.write |
| `POST /simple-invoices/:id/collect` | `collect` `billing.module.ts:1959-2071` | One collection per installment (`:2020`), or an invoice-only collection (`:2047`); installment status (`:2033`); invoice paidDate, RV number and method (`:2065`) | **Yes**: tx and lock `(uid, docId)` (`:1970-1971`) | payments.write |
| `POST /simple-invoices/receipt-voucher` | `createReceiptVoucher` `:1101-1241` | Confirmed voucher (`:1154`, kind `receipt` or `deposit`, validated at `:222-251`); collections on linked installments (`:1180`), or FIFO across them (`:1219`) with the remainder stored as `paymentId:null` (`:1233`); statuses (`:1187,1226`) | **No tx and no lock.** The number is MAX+1 from `src/common/receipt-number.ts:13-27`, so concurrent calls can collide. | **invoices.write** |
| Deposit diversion inside `POST /simple-invoices` | `billing.module.ts:865-878` | Calls `createReceiptVoucher` without a `kind`, so a legacy deposit installment gets a **kind=`receipt`** voucher | No | invoices.write |

- **Where to post:** each collection-row insert. The key is `payment_collections.id`, and the RV `receipt_number` groups rows.
- **Collections with no invoice.** Collections from `addCollection`, vouchers and advance rent have `invoice_id` null, or pointing at a voucher. Under invoice accrual they are cash with no receivable behind them. Design has to choose between:
  - cash-basis revenue: Dr Bank / Cr Rent revenue
  - Dr Bank / Cr Tenant advances

  This is the root of bug E3.
- **Negative collections exist.** Terminate refunds are stored with a negative amount (`contracts.module.ts:1843-1846`).

#### 1.2.4 Advance rent

- **Where it happens:** `materializeContract` at `contracts.module.ts:933-996`, inside the create or rebuild tx.
- **What it writes:**
  - collections with `ADVANCE_NOTE`, dated the contract start (`:957-965`)
  - installment statuses (`:967-969`)
  - a confirmed kind=`receipt` voucher (`:978-989`)
- **Rebuild** tombstones the voucher and deletes the collections, then creates them again (`:1390-1402`).
- **Terminate** can refund the advance as negative collections (`:1822, 1836-1853`).
- **Hook:** inside the tx, near `:996`.

#### 1.2.5 Credit and debit notes

- **Create:** `POST /simple-invoices` with `type` credit or debit (`billing.module.ts:805-838`). The reference must be a confirmed invoice, and a credit note is capped at the amount still creditable.
- **Approve:** `:1461-1475` only sets `status='confirmed'`. The original invoice and its installments are not touched. The note takes effect only when reads apply it (`notesAdjustmentFor` `:715-725`; the collect cap at `:2001`).
- **Where to post:** the confirm step at `:1467-1469`. A credit note on an invoice that has already been collected leaves the tenant with a credit balance, which ties in with the refund or carry-forward decision (G3-9).

#### 1.2.6 Deposits

| Event | Where | Writes | Tx |
|---|---|---|---|
| Received at create or rebuild | `materializeContract` `contracts.module.ts:998-1013` → `createDepositVoucher` `:1063-1080` | Confirmed kind=`deposit` voucher (no installment row); guarded by an existence check | Inside the tx |
| Received later | `POST /contracts/:id/collect-deposit` `:1126-1156` (payments.write) | Voucher (`:1151`), then `deposit_status='collected'` (`:1152`) | **No** |
| Standalone voucher | `POST /simple-invoices/receipt-voucher` with `kind:"deposit"` | Voucher only; does not set `deposit_status` | No |
| Legacy deposit installments | Installment rows with description `تأمين (وديعة)` (`contracts.module.ts:1708-1709`); diverted at `billing.module.ts:865` | Collections on the installment | — |
| Refunded (terminate) | `contracts.module.ts:1814-1862` | Legacy model: negative `RFND-####` collections (`:1843`, `nextRefundNumber` `:1737-1747`). New model: **voucher status set to `cancelled`** (`:1858`), `deposit_status='returned'` (`:1851,1861`). No disbursement record is written. | **No** |
| Forfeited | `:1864-1866` | Only `deposit_status='forfeited'`; no money row | No |
| To revenue | `:1869-1889` | Collection with `paymentId:null` and `invoiceId` = the deposit voucher, dated today (`:1882`); status forfeited | No; re-running is safe |

Under v2, a refund should be a separate refund record, with the original receipt left posted. A forfeit has no money row, so its posting key has to be `(contract_id, 'deposit_forfeited')`.

#### 1.2.7 Termination and "mark as paid" (bug E7)

- **`POST /contracts/:id/terminate`**
  - Handler `terminate` at `contracts.module.ts:1781`. Perm contracts.delete. No tx; about 10 separate writes.
  - Deletes `contract_units` (`:1803`).
  - `mode:"paid"` sets `status='paid'` and `paidDate` to UTC today on pending, overdue and partially paid rows, with **no collection** (`:1806-1808`).
  - `mode:"cancelled"` cancels only rows that have no collections (`:1809-1825`).
  - It then settles the refund, deposit and advance buckets and recomputes statuses (`:1893-1903`).
  - Order problem: the `paid` write happens before the refund recompute.
- **`DELETE /contracts/:id?mode=`**
  - `remove` at `:1642-1690`. Perm contracts.delete. No tx.
  - Deletes `contract_units` (`:1663`) and runs the same `paid` write (`:1670`).
  - The web calls it without `mode` (`dara-web: lib/api-hooks.ts:689-692`), so `mode=paid` is only reachable through the API.
- **v2 proposal:** refuse `mode:"paid"`, or require a real settlement: a collection, a write-off (Dr Bad debt / Cr AR) or a credit note.

#### 1.2.8 Commission invoice

- **Created:** `maybeCreateCommissionInvoice` (`billing.module.ts:1018-1092`) creates it as a draft, called from `approve` (`:1487-1496`), where errors are swallowed.
  - The rate comes from the property only (`:1019-1024`). If it is not positive, the function returns at `:1025`.
  - The base is pre-VAT rent (`:1060-1072`), and `commissionNet = base*pct/100` (`:1074`).
  - VAT is forced on, and the number is `COM-######`.
- **Approved:** through the normal approve route. It is exempt from the readiness gate (`TAX_EXEMPT_KINDS` `:171-174`) and never sent to ZATCA (`:1642-1645`).
- **Collected:** through `/collect` with `paymentId:null` (`:2046-2053`).
- **Posting (Manager mode):** Dr Landlord payable / Cr Commission revenue / Cr Output VAT, at the confirm update `:1480` where `kind='commission'`.

#### 1.2.9 Expenses

- `POST /reports/expenses` (`src/modules/reports/reports.module.ts:363-381`, perm expenses.write) is an insert only.
  - It stores no VAT, supplier or attachment.
  - **`ownerId` and `propertyId` are not checked against the caller's scope.**
- `DELETE /reports/expenses/:id` (`:383-389`) is a soft delete and always returns ok. There is no edit endpoint.
- **Posting:** Dr Expense (or Landlord payable) / Cr Bank. A delete posts a reversal. `expense_date` is free text and must be parsed before it can be a posting date.

#### 1.2.10 Landlord payouts

- `POST /reports/landlord-payouts` (`reports.module.ts:448-461`) and `DELETE` (`:463-469`, soft). Perm **expenses.write**. No tx.
- `transfer_date` is text, and there is no link to a bank account.
- **Posting:** Dr Landlord payable / Cr Bank. A delete posts a reversal.

#### 1.2.11 Other installment writes (bug E7)

| Route | file:line | Effect | Perm |
|---|---|---|---|
| `POST /payments` | `payments.module.ts:238-256` | Accepts any `status`, `paidDate` or receipt number from the body; `amount` is stored as `String(amount)` with no validation | payments.write |
| `PATCH /payments/:id` | `:258-270` | Allowlist at `:262` includes `amount` and `status`, with no validation, no tx and no lock | payments.write |
| `POST /payments/:id/settle-external` | `:277-289` | Pending → `settled_external`, `paidDate = dueDate`; refused if anything has been collected | payments.write |
| `POST /payments/:id/revert-external` | `:292-304` | Back to pending | payments.write |

Under v2, restrict `PATCH` to notes and attachment only. `settled_external` means history from before the account started using Dara, so it posts nothing; the opening balance covers it.

#### 1.2.12 Out of scope for the tenant ledger

- **Dara's own subscription revenue** (`subscription_payments`):
  - `src/modules/subscription/subscription.module.ts:36,210,220,234`
  - `subscription-invoice.service.ts:267,309`
  - `admin.module.ts:1323`
- **Hard deletes of user accounts** (`admin.module.ts:537-543, 929-935`) cascade to payments and collections (`payments.ts:16`, `paymentCollections.ts:18,20`). The ledger must either cascade the same way or block the delete.
- **The ZATCA mirror `invoices`** (`invoice.service.ts:390,398,595,771,868`; `src/modules/invoice/invoices.controller.ts:124`) moves no money and falls under hard rule 4.
- **Money migrations:** only `db/drizzle/0049_payment_vat_enabled.sql:8,15` changed money data.

### 1.3 Installment status derivation (`src/common/payment-status.ts`)

- **The rule.** `liveStatus` (`:35-39`) returns `SETTLED_STATUSES` unchanged. Those are `paid, cancelled, settled_external, partially_paid` (`:26`). Any other row is `overdue` if its due date is before `riyadhToday()`, else `pending`. The SQL twin is `liveStatusSql` (`:48-51`), which uses Riyadh dates.
- **Consequence (E4).** A part-paid installment past its due date never reads as overdue. This affects:
  - the list filter (`payments.module.ts:65-66,160,208`)
  - the dashboard (`src/modules/dashboard/dashboard.module.ts:73`)
- **Other overdue definitions, each different:**
  - the arrears report counts the remaining amount but uses UTC `Date.now()` (`reports.module.ts:236-257`)
  - the mobile landlord view counts the remaining amount using `riyadhToday()` (`src/modules/mobile-landlord/mobile-landlord.module.ts:121-141`)
  - the tenant portal uses UTC (`src/modules/tenant-portal/tenant-portal.module.ts:269-278`)
- **Stored status writes.**
  - Recomputed from Σ collections at:
    - `payments.module.ts:555-565`
    - `billing.module.ts:1185-1189, 1224-1228, 2031-2039`
    - `contracts.module.ts:966-969, 1893-1903`
  - Written with no collections behind it at the five sites in §1.0.
- **For the ledger:** derive AR from postings, not from the status column. The reconciliation report should flag installments where `status='paid'` but Σ collections is less than the amount.

---

## 2. Schema, migrations and scoping

### 2.1 How the schema actually changes

| Piece | Where | What it does |
|---|---|---|
| Drizzle schema | `db/src/schema/*.ts`, barrel `db/src/schema/index.ts:1-37` | ORM definitions (`db/src/index.ts`; provider `src/database/database.module.ts:4-18`) |
| drizzle-kit | `db/drizzle.config.ts`; scripts at `package.json:15-16` | CLAUDE.md:45-47 says `drizzle-kit migrate` hangs |
| Hand-written SQL | `db/drizzle/0000…0065_*.sql` plus `meta/_journal.json` (last entry `0065_re_news_judged_at`) | Convention (CLAUDE.md:45-49): run the SQL with a `pg` client and add a journal entry. **The next file is `0066_…`.** |
| `db/sql/*.sql` | `PASSIVE_MIGRATIONS` (`bootstrap.ts:41-47`) | The Dockerfile copies only `db/drizzle`, `db/init.sql` and `db/data.sql` (`Dockerfile:49-51`), so these files are skipped in deployed images (`bootstrap.ts:85-90`) |
| `db/init.sql` | Runs only when `users` is missing (`bootstrap.ts:67-82`) | Stale: it lacks companies, roles, payment_collections, simple_invoices, expenses and landlord_payouts |
| **`ensureSchema()`** | `bootstrap.ts:63-632`, called from `src/main.ts:31` | The real migration path. Runs inline `add column if not exists` and `create table if not exists`, and for news executes `db/drizzle/0061…0065` (`bootstrap.ts:564-575`). Each block's try/catch only warns, and `main.ts:24-38` starts the API even when it fails. |

`STAGING-WORK-LOG.md:248-256` confirms the migration tracking table is empty and the drizzle files are never read by drizzle-kit. It also says `pnpm db:push` (`package.json:13`) would drop 22 indexes (`:258-260`). **Never run `db:push`.**

What this means for `finance_v2`:
1. **One migration file.** Write an idempotent `db/drizzle/0066_finance_v2.sql` using `IF NOT EXISTS` and `ON CONFLICT DO NOTHING`. Add a journal entry, and have bootstrap execute the file in its own try/catch, as it does for news. The debit = credit check or trigger goes in the same file, using `CREATE OR REPLACE FUNCTION` and `DROP TRIGGER IF EXISTS`.
2. **Fail closed.** A failed DDL still boots and passes health checks. Flag reads must treat a missing table as "off" (DARA-NOTES:695-697).
3. **Deploy the API before the web** (DARA-NOTES:91).
4. **Additive only.** New tables and nullable columns. Keep the Drizzle TS definitions in sync, but never push them.

### 2.2 Tenancy and scoping

- **Scope is a user id.** `scopeId(user) = user.ownerUserId ?? user.id` (`src/common/scope.ts:9-11`); there is a duplicate at `src/modules/properties/properties.module.ts:40-42`.
  - It is used in about 30 files. Every finance table stores it in `user_id`.
  - There is no Postgres RLS and no repository layer. Each query filters by `eq(table.userId, scopeId(user))` and `isNull(deletedAt)` by hand (for example `reports.module.ts:301,358,387,402`; `scope.ts:13-18`).
- **Gap:** ids in request bodies are not always checked against the scope. `POST /reports/expenses` is one example (`reports.module.ts:362-380`), and the finance tables have no FKs to owners or properties (`expenses.ts:10-13`, `landlordPayouts.ts:10-11`). New v2 endpoints must check every referenced id.
- **Principals** (`src/common/guards/jwt-auth.guard.ts`):
  - The `AuthUser` type is at `:19-35`.
  - User and employee tokens load `users` joined to `roles` on every request (`:87-100`). This sets `ownerUserId` and `companyId` (`:106-113`), with `ownerScopeId` set to null (`:114-127`).
  - An owner-mobile token sets `id = owners.user_id` and `ownerScopeId = owner.id` (`:57-79`).
- **Account topology** (DARA-NOTES §3):
  - `isCustomerAccount()` means no `owner_user_id` and a non-staff role (`src/common/permissions.ts:279-282`). The SQL twin is at `admin.module.ts:102`.
  - The admin console's "companies" are top-level `users` rows (`admin.module.ts:374-395, 511-534`).
- **The `companies` table is optional.**
  - A row is created only when `userType === "company"` (`auth.service.ts:501-508`); otherwise it is created lazily, if ever (`companies.module.ts:76-93`, `package.module.ts:185-196`).
  - `owners.company_id` is nullable (`owners.ts:10-16`).

### 2.3 Finance tables

Money is always stored as `numeric`; there are no float or halala-integer columns. Drizzle returns numeric values as strings.

| Table (schema file) | Scope and links | Money | Dates | Notes |
|---|---|---|---|---|
| **invoices**, the ZATCA mirror (`invoices.ts:78-163`) | `user_id` FK cascade `:80`; `contract_id` `:85`; `payment_id` `:86`; `owner_id` (seller) `:90` | `totals` jsonb `:113` | `issue_date` `:97` | ICV/PIH chain `:101-103`; partial unique indexes `:141-159`. **Hard rule 4.** |
| **invoice_lines** (`invoiceLines.ts:12-31`) | `invoice_id` FK cascade | numeric(14,6)/(14,2)/(5,2) `:20-27` | — | `vat_category` S/Z/E/O `:10,22` |
| **simple_invoices** (`simpleInvoices.ts:13-78`) | `user_id` `:15` (no FK); contract, payment, `payment_ids`, tenant `:24-28`, all without FKs; **no landlord column** | `subtotal`, `total` numeric(14,2) `:34-35`; `items` jsonb `:33` | issue, due, paid `:36-39`; `confirmed_at` `:38` | `type` invoice/credit/debit; `status` draft/confirmed/cancelled; `kind` `:22` is null (rent), `commission`, `deposit` or `receipt`; `receipt_number` `:71`; `billing_reference` `:73`; `zatca_invoice_id` `:69` |
| **payments**, the installments (`payments.ts:14-35`) | `user_id` FK `:16`; `contract_id` FK cascade `:17` | `amount` numeric(12,2) `:18`, VAT-inclusive | `due_date`, `paid_date` `:19-20` | `settled_external` is history only (`:7-11`); `overdue` is derived; legacy deposit rows are marked by description (`payments.module.ts:7,78-81`) |
| **payment_collections** (`paymentCollections.ts:14-35`) | `payment_id` FK cascade, nullable `:18`; `user_id` `:20`; `invoice_id` with no FK `:30` | `amount` numeric(12,2) `:21` (can be negative) | `collected_date` `:22` | **No `deleted_at` and no `updated_at`.** Hard-deleted on rebuild. |
| **payment_confirmations** (`paymentConfirmations.ts:20-41`) | user, tenant, payment, contract FKs | `amount` `:27` | `reviewed_at` | Approval inserts a draft invoice (`payment-confirmations.module.ts:461`) |
| Deposits, on **contracts** | — | `deposit_amount` `:58` | `deposit_due_date` `:61` | `deposit_status` `:60`: pending, collected, returned or forfeited (`contracts.module.ts:19`); `deposit_method` `:63` |
| Advance rent, on **contracts** | — | `prepaid_rent` numeric(14,2) | — | Collections plus a voucher (`contracts.module.ts:957-989`) |
| **expenses** (`expenses.ts:8-21`, migration `0054`) | `user_id`, `property_id`, `owner_id`, with no FKs | `amount` `:15` | **`expense_date` text** `:16` | Create and delete only |
| **landlord_payouts** (`landlordPayouts.ts:8-20`) | `user_id`, `owner_id` NOT NULL, no FKs | `amount` `:12` | **`transfer_date` text** `:13` | `method`, `reference` `:15-16` |
| **owners** (landlords) (`owners.ts:7-84`) | `user_id` `:9`; `company_id` nullable `:16` | `management_fee_percent` `:26`, written but **never read for billing** | — | `iban` `:25`; `tax_number` `:27`; `is_account_holder` `:72` (server-owned) |
| **properties** (`properties.ts:14-80`) | `user_id`; `owner_id` FK `:38` | `management_fee_percent` `:63` | — | Overflow guard at `properties.module.ts:54-70` |
| **contracts** (`contracts.ts:10-120`) | `user_id`; `tenant_id` FK. **No landlord FK**: the landlord is reached through contract_units → units → properties.owner_id (`contractUnits.ts:14-15`, `units.ts:14`), plus text snapshots `:80-96` | `monthly_rent` (14,6) `:56`; `agency_fee` `:98` (never billed); `first_payment_amount` `:99`; `escalation_rate` `:73` | start, end, `settled_external_until` | `vat_enabled` `:69`; `additional_fees` jsonb `:101` |
| **contract_rent_terms** (`contractRentTerms.ts:11-19`) | `contract_id` FK | `amount` (14,2) `:15` | — | |
| **companies** (`companies.ts:14-45`) | Linked from `users.company_id` | — | — | Legal identity only |
| **users** (`users.ts:17-105`) | `owner_user_id` `:45`; `company_id` `:47`; `role_id` `:49` | — | — | Package and subscription state `:55-97`. Declared "pure identity rows" (`:5-8`). |
| **subscription_payments** (`subscriptionPayments.ts:10-51`) | `user_id` FK | `amount` `:15` | `paid_at`, `period_*` | Dara's own revenue |
| **roles** (`roles.ts:19-36`) | `company_id` nullable | — | — | Permissions live only in `roles.permissions` jsonb. Presets are refreshed on every boot (`bootstrap.ts:577-613`), so **new permission keys only need adding in code**. |
| **audit_logs** (`auditLogs.ts:8-22`) | `owner_user_id` (scope) `:11`; `actor_user_id` `:13` | — | `created_at` | No meta or diff column. The interceptor logs under the *actor's* scope (`audit.module.ts:41-49`), so an admin flag flip needs an explicit insert with `owner_user_id` set to the target account, as the rebuild does (`contracts.module.ts:1464-1476`). An optional additive `meta jsonb` column would help. |
| **app_settings** (`appSettings.ts:3-19`) | **Global by design** | — | — | Key/value store |
| zatca_credentials (`zatcaCredentials.ts:32-129`) | `user_id`, `owner_id` | — | — | Per-landlord signing identity |

Other money columns: `units.rent_price` (`units.ts:25`), `maintenance.estimated_cost` (`maintenance.ts:16`), `facilities.monthly_opex` (`facilities.ts:12`), `campaigns.budget` (`campaigns.ts:9`).

### 2.4 Where to put the flag: recommendation

```
finance_settings (
  account_user_id    integer primary key references users(id) on delete cascade,  -- = scopeId()
  finance_v2_enabled boolean not null default false,   -- row absent => off
  accounting_mode    text,                              -- 'owner' | 'manager' (null => derive)
  default_bank_account_id integer,
  enabled_at timestamptz, enabled_by integer, updated_at timestamptz not null default now()
)
```

Why this shape:
- **Keyed like everything else.** Every finance row is scoped by the user id, so the flag is a single-row lookup on the scope every query already has.
- **`companies` would miss accounts.** Individual accounts have no `companies` row, and the admin console's "company id" is really a user id.
- **`app_settings` is global**, so it cannot hold a per-account value.
- **A missing row means off**, which gives "off by default" with no backfill. The reader catches a missing table and treats it as off.
- **Why not a `users` column:** `users` is declared as identity-only, the settings need a home anyway, and a nullable boolean would make null mean off. The fallback, if the per-request cost matters, is a nullable `users.finance_v2_enabled_at` column.
- **Default `accounting_mode`:** Manager when the account has `owners` rows with `is_account_holder = false`, otherwise Owner. This is derived from topology; confirm it in the design.
- **New GL tables** carry `user_id` (the scope). Their dimension columns (landlord, property, unit, tenant, contract) and `source_type`/`source_id` should be plain integers **without cascading FKs**, so that posted entries survive the hard deletes on rebuild and termination.

### 2.5 Implications for the ledger

- **Landlord dimension.** Resolve it at event time and freeze it on each journal line. There are three reasons:
  - `simple_invoices` has no landlord column.
  - A contract can span several properties.
  - `contract_units` rows are deleted on both terminate (`:1803`) and DELETE (`:1663`).
- **Text dates.** Parse them defensively. If parsing fails, fall back to `created_at` in Asia/Riyadh and flag the row.
- **What counts as a collection today:**
  - Vouchers of kind `deposit` or `receipt` are "evidence, not collections" (`payments.module.ts:141,415-417`).
  - Legacy deposit installments are excluded (`:363-365`).
  - `settled_external` rows are excluded everywhere.
- **Idempotency.** A collection id can be recycled after a rebuild deletes and re-inserts rows. Add a source fingerprint, and post reversals at the rebuild's delete step.
- **Request payloads.** Because of the ValidationPipe whitelist (DARA-NOTES:1102-1104; CLAUDE.md:50-52), new body fields need `@Body() body: any` or a decorated DTO.

---

## 3. Web UI (`dara-web`, paths relative to `src/`)

### 3.1 Findings to act on first

1. **E2 is the other way round from the brief.** `overdueAmount` and `revenueByMonth` are on master (`dara-api: dashboard.module.ts:93,128-129`, commit `01ede96`) and not on `origin/main`. See §5.
2. **The billing and receipt Excel exports probably fail with a 400.**
   - `lib/report-export.ts:375,380` request `pageSize=1000`.
   - The API caps it at `MAX_PAGE_SIZE = 200` (`dara-api: src/common/pagination.ts:38-42`, applied at `billing.module.ts:352`), and a ZodError is turned into a 400 (`src/common/zod-exception.filter.ts:50`).
   - The user then sees "تعذّر تصدير التقرير" (`components/dashboard/ExportReportButton.tsx:29-30`).
   - This comes from reading the code only; it has not been run.
3. **E6b:** the receipts export keeps only kind `deposit` or `receipt` (`report-export.ts:378-382`). The screen instead lists `type=invoice&status=confirmed&hasReceipt=true` (`ReceiptVouchersView.tsx:48-56`). The export's invoice-number column is hard-coded to "—" (`:302`).
4. **E6a:** the Collections export (`CollectionsView.tsx:133`, `entity="payments"`) outputs installments (`report-export.ts:269-272,393-394`), but the screen lists collection rows (`CollectionsView.tsx:75`).
5. **E5:** the contract "total collected" (`ContractDetailModal.tsx:238-242`) sums only paid rows at face amount and then adds `prepaidRent`. It is shown at `:755` and `:843`.
6. **E4:** the tabs in `InstallmentsView.tsx:39-43` put part-paid installments that are past due under "upcoming".
7. **E1:** `OwnerStatementModal.tsx:36-38` uses the landlord percentage, while the API revenue report uses the property percentage.
8. **E10:** see §5.

### 3.2 Finance tabs, views and modals

The shell is `_legacy/DashboardPage.tsx`.

**Sidebar "finance" group (`:104-116`):**

| Tab id | Permission |
|---|---|
| installments | payments.view |
| invoices | invoices.view |
| collections | payments.view |
| receipts | payments.view |
| settlement | invoices.view |
| expenses | expenses.view |

- `payment-confirmations` sits under operations (`:123`), and `reports` under reports (`:132`).
- Views are mounted at `:819-838`, routed via `FinanceSection.tsx:17-26`.
- `TENANT_TABS` (`:156`, enforced at `:221,286`) hides every finance tab except installments.
- The URL is `/dashboard/<tab>` (`:249`).

| Component | Role | Reads | Writes |
|---|---|---|---|
| `InstallmentsView.tsx` | Installment tabs | `useGetPaymentsPaged` `:225`; `useGetSimpleInvoicesPaged` `:242` | via modals |
| `CollectInstallmentModal.tsx` | Collect one installment | `useGetPaymentCollections` `:61` | `useCollectPayment` |
| `InvoicesManageView.tsx` | Invoices (+ Customers tab on staging builds, `:22`) | — | — |
| `BillingDocsView.tsx` | Invoices and notes | `:83-87` | approve, delete, submit |
| `InvoiceCustomersView.tsx` | Billed parties (staging) | `:51` | — |
| `CreateInvoiceModal.tsx` | Invoice and note editor | `:270`, `:427` | create, update |
| `ApproveInvoiceDialog.tsx`, `InvoiceReadinessGate.tsx` | Approve and readiness | `useInvoiceReadiness` `:61`/`:91` | approve |
| `ConfirmInvoiceModal.tsx` | Collect against an invoice | — | `useCollectSimpleInvoice` |
| `CollectionsView.tsx` | Collections and invoices awaiting collection | `:75`, `:85`, `:45` | — |
| `ReceiptVouchersView.tsx` | Receipt vouchers | `:48` | — |
| `CreateReceiptVoucherModal.tsx` | Standalone voucher | contracts | `useCreateReceiptVoucher` |
| `ReceiptVoucherDocModal.tsx`, `SimpleInvoiceDetailModal.tsx` | Document render and PDF | various; pdfa3 fetch `:253` | submit to ZATCA |
| `ExpensesView.tsx` | Expenses | `:50`, `:88`, `:57`, `:58` | `ExpenseModal` (`AccountingReportsView.tsx:230`), delete |
| `PaymentConfirmationsView.tsx` | Tenant proofs | `:55` | review |
| `ContractDetailModal.tsx` | Contract money panel | `:94`, `:99`, `:81` | collect deposit |
| `ContractFinancePanels.tsx` | Per-contract finance | `:142`, `:154,297,385,507`, `:81` | via modals |
| `EndContractDialog.tsx` | Terminate | `useGetContractSettlement` `:31` | `useEndContract` |
| `ContractsView.tsx` | Rebuild lock | `useContractInvoiceLock` `:132` | — |
| `OwnerStatementModal.tsx` | Client-side landlord statement; PDF via `window.print()` `:152`. Its menu entry is commented out (`OwnersView.tsx:375`). | contracts, properties | — |
| `PropertyDetailModal.tsx`, `UnitDetailsDrawer.tsx` | Totals | `:55`/`:51` | — |
| `TenantProfileModal.tsx`, `TenantDashboardView.tsx` | Tenant totals | `useGetPayments()` `:45`/`:34` | — |
| `TaxInvoicesView.tsx` | Old ZATCA list (nav hidden, `DashboardPage.tsx:114`) | — | — |
| `ZatcaIntegrationView.tsx` | Settings → ZATCA (`SettingsView.tsx:1081`) | `:49` | onboard, verify, unlink |
| `useFinanceFilters.tsx` | Shared filters, resolved to `contractIds` on the client (`:47`) | contracts | — |
| `VatTreatmentPicker.tsx` | Per-line VAT treatment | — | — |

### 3.3 Reports centre, and where "المحاسبة (تجريبي)" fits

**How it is built today.** `components/dashboard/ReportsView.tsx` has no registry. It is driven by three literals:
- `REPORT_DEFS` (`:321-333`, built by `D()` at `:320`)
- `CATEGORIES` (`:341-357`)
- a render switch: `accounting` renders `<AccountingReportsView/>` at `:462`; anything else goes through `EntityReportPanel` (`:471-482`), with the no-data shell at `:484`

Fetch gating is at `:89-90` (`needRows`). Strings are inline via `tr()`/`ui()` (`:74,124`). The export-language toggle is at `:72-73,423-428`.

**Proposal (nothing written):**
1. Add a category to `CATEGORIES` only when the flag is on: `...(financeV2 ? [cat] : [])`.
2. Add `D()` entries with `base: "accounting_v2"`.
3. Exclude the new keys from `needRows` (`:89`) and from the no-data shell (`:484`).
4. Render `<AccountingV2View report={section}/>` in the same way as `:462`.

With the flag off, the literals and requests are unchanged. Leave the existing `AccountingReportsView` alone: it makes one GET (`api-hooks.ts:2171-2173`), has six tabs (`:56-124`), totals on the client (`:148`) and exports everything (`:136-145`).

### 3.4 Export pipeline

- **Excel** (`lib/export-excel.ts`): OOXML stored uncompressed (STORE) inside the zip (`:1-12`). Helpers are `ExportSheet` `:21-25`, `buildSheet` `:47` and `downloadWorkbook(..., {rtl})` `:184`. A cell is typed as a number only when the value is a JS `number` (`:35`).
- **CSV:** `lib/export-csv.ts` (`ReportsView.tsx:367`).
- **Report PDF** (`lib/export-pdf.ts:11-43`): opens a popup and calls `window.print()`. It loads the **stock** Readex Pro from Google Fonts (`:24`), not the patched copy (DARA-NOTES §5). Used by `EntityReportPanel.tsx:156`, `CustomReportBuilder.tsx:384` and `ReportsView.tsx:368`.
- **Per-entity builders** (`lib/report-export.ts`):
  - `makeCtx` `:79-100`
  - sheets `:107-337`
  - `paymentRowCols` `:247-265`, where VAT falls back to a float `amount*0.15` (`:257`)
  - `buildEntitySheet` `:343-395`
  - `exportEntityReport` `:401-406`
- **Arabic document PDF, to reuse for the landlord statement** (`lib/export-invoice.ts`):
  - `buildInvoiceHtml` `:148` declares the self-hosted font at `:185-205`.
  - `generateInvoicePdfBlob` `:354-408` runs `ensureHostFontLoaded()` (`:110`, before html2canvas at `:359-360`), renders an off-screen 794×1123 iframe with html2canvas-pro at scale 2, then paginates with jsPDF.
  - `printInvoice` `:410`.
  - Related: `lib/invoice-doc.ts:52` and `lib/use-invoice-pdf.ts:21`.
  - DARA-NOTES rules to follow: load the host font first, no `foreignObjectRendering`, no Arabic `letter-spacing`, wrap user values in `<bdi>`, and patch both font copies (§5, §6).

### 3.5 Dashboard cards (`DashboardView.tsx`)

- **Overdue card** (`:282-297`):
  - The count comes from `overduePaymentsCount` (`:91`).
  - The SAR figure is `overdueAmount`, shown only when it is defined (`:94,293`).
- **"Collected this month"** (`:300-305`) is `monthlyRevenue`, defaulting to 0 (`:87,95`).
- **Revenue chart:**
  - It is drawn from `revenueByMonth` (`:145-150`).
  - The fallback downloads every installment and sums the paid rows (`:151-161`), which leaves out partial payments.
- **Types:** both fields are optional in `lib/api/types.ts:132-137`.

### 3.6 Admin console (flag toggle and audit)

- **Structure.** `app/admin/page.tsx` renders `components/admin/AdminShell.tsx`, with the nav at `:70-79` and the mounts at `:184-193`.
- **Where the toggle goes.** Copy the active/suspended toggle in `components/admin/tabs/CompaniesTab.tsx:97-99,151-160`. Other places it could go:
  - the Customer 360 drawer (`CustomerOverviewDrawer.tsx`; `customer-hooks.ts:101`)
  - a tab modelled on `ManualAddTab.tsx:36-54`
  - hooks in `lib/admin-hooks.ts` (`adminKeys` `:129-360`)
- **`AdminCompany.id` is a `users.id`, not a `companies.id`** (`lib/admin-hooks.ts:61-66`; `dara-api: admin.module.ts:374-395, 526-535`).
- **Audit.** The audit log is per account: `GET /api/audit` is limited to the owner (`audit.module.ts:77-81`), and the web shows only update and delete entries (`SettingsView.tsx:1050-1079`; `api-hooks.ts:198`). There is no admin audit viewer, so a flag flip needs an explicit row (§2.3).

### 3.7 Permissions

- `hooks/use-permission.tsx:9-30`: `has()` returns **true while loading** (`:15`); `<Can>` is at `:33-45`.
- The permission source is `GET /api/auth/me/permissions` (`api-hooks.ts:274-279`; `types.ts:526-532`).
- The shell gates on `allowedPerm` (`DashboardPage.tsx:183-187`) and `canFetch` (`:312`).
- Permission labels are in `lib/permissions-i18n.ts`:
  - `payments.*` `:19-20`
  - `reports.view` `:42`
  - `invoices.*` `:51-53`
  - `zatca.onboard` `:55`
  - `expenses.*` `:58-60`
- New keys (such as `accounting.view`, `journal.post`, `journal.approve`, `periods.close`) need a label there and an entry in the API catalog.

### 3.8 i18n

- `lib/i18n.ts` loads `ar.json` and `en.json` (38 namespaces each; default and fallback `ar`; the choice persists as `dara_lang`).
- Finance screens mostly use inline `L(ar,en)` and `tr()`/`ui()` rather than locale keys. The brief asks for locale keys, so use a `financeV2.*` namespace.
- RTL: use logical utilities, never `space-x-*`, and set `dir="ltr"` on numbers.
- `lib/format.ts:11,19` (`money`, `round2`) are for display only.

### 3.9 How a per-account flag can reach the web

| Channel | Source | Notes |
|---|---|---|
| Package | `GET /api/me/package` (`types.ts:32-72`), loaded at `DashboardPage.tsx:192` | Best carrier (`features.financeV2`), **but** adding a field changes this JSON |
| User | `GET /api/auth/me` (`types.ts:7-27`; `hooks/use-auth.ts:16`) | |
| Company | `GET /api/companies/me` (`types.ts:648-670`) | Enterprise branding only (`DashboardPage.tsx:196`) |
| Policy gate | `ManualAddGate.tsx:36-48` | Model for "hidden until known, fail closed" |
| Build flag | `isStagingBuild()` (`lib/app-env.ts:14-19`) | Not for per-account behaviour |

For a byte-identical flag-off, prefer a new `GET /api/me/features`. Put the beta badge at `DashboardPage.tsx:578-582`.

---

## 4. Tests, how to run them, and baselines

### 4.1 dara-api

- **Runner:** `node:test` through `tsx`: `"test": "node --import tsx --test 'src/**/*.spec.ts'"` (`package.json:12`). There are 54 spec files under `src/`.
- **tsc:** `package.json:11`. It includes `src` and `db/src` (`tsconfig.json:28`), with `strict:false` (`:10`). The baseline is **0 errors**.
- **Node:** `engines` is `22.x` (`:22-23`).
- **DB-gated specs.** These skip unless `DATABASE_URL` is set. All roll back except `chain-head`:
  - `src/common/invoice-readiness.spec.ts:21`
  - `src/modules/ejar/ejar.import.spec.ts:23`
  - `zatca-onboarding.service.spec.ts:21`
  - `compliance-slot.qa1.spec.ts:60-61`
  - `chain-lock.spec.ts:20`
  - `chain-head.spec.ts:59-60`, which **commits rows and then deletes them**, so it must never run against a shared DB
- **Other gates.** The news retention spec needs `NEWS_TEST_DATABASE_URL` and accepts localhost only (`news.retention.db.spec.ts:17-19,53-54`). The signer suite needs the openssl and xml tools (`invoice-signer.service.spec.ts:25,264`).
- **`.env` safety.** `pnpm test` does not load `.env`. The `.env` `DATABASE_URL` points at production (DARA-NOTES:93-97), and three scripts load it: `db:push` (`:13`), `db:reset` (`:19`, which truncates everything) and `db:seed:test` (`:20`). **Never use them** without an explicit localhost URL.

| Run (26 Sep 2026) | Tests | Pass | Fail | Skip |
|---|---|---|---|---|
| No DB env vars | 722 | 623 | 0 | 99 |
| Local throwaway Postgres 16 on :55432, `API_PORT=4999` | 735 | 734 | 1 | 0 |

- **The one failure** is `ejar.import.spec.ts:156`: the lookups table is empty.
- **A fresh database cannot be fully bootstrapped.** `db/data.sql:36` still inserts the legacy `users.role` column, so `ensureSchema()` fails at that step.
- **How the throwaway database was built:** `initdb` + `pg_ctl -o "-p 55432 -k ''"`, then `drizzle-kit push --force` run through `npx tsx` against the local URL (not the pnpm wrapper), `ensureSchema()`, and one synthetic user.

**CI** (`.github/workflows/`):
- **`ci.yml`**
  - Runs tsc and `pnpm test`, with `BASELINE_SKIPPED=94` and `BASELINE_PASS=338` (`:83-84`).
  - **It is red on master:** the last five runs all failed with 99 skipped.
  - It stays red on this branch until the skip baseline is raised or the extra skips are made runnable.
- **`deploy.yml`**
  - `main` deploys production and `master` deploys staging (`:33-36`).
  - `feat/finance-v2` is not mapped to any environment, so pushes to it deploy nothing.
- **`pdfa3.yml`:** runs veraPDF. It is path-triggered.
- **`zatca-validate.yml`**
  - Manual trigger only.
  - Pins Fatoora SDK R3.4.8 and uses JDK 11.
  - Requires every sample to report `PASSED`, plus a negative control.
  - Run it with `gh workflow run zatca-validate.yml --ref feat/finance-v2`.

### 4.2 dara-web

- **Tests:** there are none, and no runner is installed. Scripts are `dev`, `build`, `start`, `lint` and `typecheck` (`package.json:6-11`).
- **Build settings:** the build ignores both type errors and ESLint (`next.config.mjs:39-40`).
- **tsc:** **7 errors**, which matches `BASELINE_TS_ERRORS=7` (`ci.yml:60`):
  - `NewContractModal.tsx` 675, 743, 2173, 3080
  - `PropertyUnitsModal.tsx` 79, 81
  - `lib/api/core.ts:229`
- **tsbuildinfo:** running tsc rewrites the tracked `tsconfig.tsbuildinfo`. Revert it before committing.
- **CI:** `ci.yml` (the tsc gate and `next build`) is green on master.
- **Existing scripts:**
  - `scripts/check-dashboard-scroll.cjs` is a read-only Playwright check whose default target is staging and which loads Playwright through `NODE_PATH` (`:21-30`). It is a usable pattern.
  - `scripts/ejar-e2e.mjs` **writes data** (`:86`). Do not run it against staging.

### 4.3 Playwright and the staging test account

- **Playwright.** It is not a dependency of either repo, but it is installed locally:
  - a module under `~/Desktop/dara-journey-maps/src/node_modules` (v1.63.0)
  - the ms-playwright browser caches
  - system Chrome
- **Login script.** `~/Desktop/dara-journey-maps/src/login.mjs:1-24` logs into the staging portal as the accountant test account and saves `storageState`. It is ready to reuse for Phase 5.
- **How the `accountant-test` account was seeded.** The private doc `STAGING-ACCOUNTANT-TEST-ACCOUNT.md` records it. **No seeding script was kept.**
  - **SQL:** the user, company, subscription rows and party details. SQL avoided the registration emails.
  - **Staging API:** everything else, including installments, invoices, vouchers and ZATCA sandbox clearance.
  - **What it holds:**
    - 7 contracts
    - 24 invoices: 15 cleared and 9 exempt (VATEX-SA-30)
    - one credit note
    - receipt vouchers
    - three contracts deliberately left overdue
    - no expenses
  - The doc's expected totals can serve as acceptance checks for `accountant-beta`.
  - Contact details are account-holder aliases and dummy phone numbers. Record ids and credentials are in the private doc only.

### 4.4 Gotchas

1. **Safe command for DB-backed tests:**
   ```
   DATABASE_URL=postgres://…@localhost:<port>/<scratch> NEWS_TEST_DATABASE_URL=… API_PORT=<not 4000> node --import tsx --test 'src/**/*.spec.ts'
   ```
2. **The fresh-DB bootstrap is broken** by `db/data.sql:36`. Phase 5 needs a lookups seed, or a fix that applies only to the test harness.
3. **Fix the API CI skip baseline** before relying on CI.
4. **New env-gated suites raise the skip count**, and the CI gate penalises that.

---

## 5. G1–G3 and the §E bug re-check

**Source.** The Read tool shows PDF pages 25–27 as blank, so G1–G3 were taken from the generator `~/Desktop/dara-journey-maps/src/build.mjs`:
- G1 `gapChecklist` L343–367
- G2 `gapFindings` L369–385
- G3 `gapPlan` L387–419

Per-journey notes come from `journeys.mjs`.

### 5.1 G1: the accountant's checklist

| What an accountant expects | Dara | Today |
|---|---|---|
| Chart of accounts | Missing | — |
| Journal / general ledger | Missing | Events are recorded but not posted as debits and credits |
| Trial balance, P&L, balance sheet | Missing | — |
| Invoicing + ZATCA Phase 2 | Have | Standard and simplified, per landlord |
| Credit / debit notes | Have | Against approved invoices |
| Cash receipts + RVs | Have | Every collection gets an RV |
| AR per tenant | Partial | Totals only; no running ledger or opening balances |
| AR aging 30/60/90 | Partial | Days overdue only |
| Security deposits (liability) | Partial | No liability balance |
| Owner statements and payouts | Partial | No landlord PDF statement |
| Management commission | Partial | Property % only; the commission invoice is a draft |
| Expenses | Partial | No VAT, supplier, attachment or approval |
| Suppliers / bills / AP | Missing | Payment vouchers exist only for deposit refunds |
| Bank accounts and reconciliation | Missing | — |
| VAT return summary | Missing | Can only be assembled by hand from the export |
| Period close / lock | Missing | Only individual approved invoices are locked |
| Reminders | Missing | — |
| Invoice delivery by email / WhatsApp | Missing | Mobile app, or print / PDF |
| Accounting-software link | Partial | Excel / CSV |
| Audit trail | Have | Settings activity log |

### 5.2 G2: what was observed on staging

| # | What you see | Why | Kind |
|---|---|---|---|
| 1 | Commission shows 0% | The landlord's % is set but only the property's % is read | BUG (E1) |
| 2 | Dashboard revenue and arrears show 0 | Suspected missing fields (refuted below) | BUG (E2) |
| 3 | Tenant balance −96,000 | Rent was collected on vouchers with no invoice | DECISION (E3) |
| 4 | Overdue 19,400 vs 23,300 | Part-paid rows past due are not counted as overdue | BUG (E4) |
| 5 | Total collected 34,500 vs 37,500 | A 3,000 partial payment is left out | BUG (E5) |
| 6 | Collections and RV exports | Wrong source; missing rows | BUG (E6) |
| 7 | Paid with no money | Mark as paid; Ejar import | DECISION (E7) |
| 8 | Tenant credit after a credit note | No refund or carry-forward | DECISION |
| 9 | Agency fee never invoiced | The field is stored only | DECISION (E8) |
| 10 | Landlord without a VAT number cannot issue anything | Needs a non-tax document | DECISION (E9) |
| 11 | Dara's own invoices lack VAT and CR | Staging configuration | CONFIG |

Related `journeys.mjs` notes: L30, L84, L108–109, L176, L195/198, L199.

### 5.3 G3: draft journal mapping

| Event | Debit | Credit |
|---|---|---|
| Rent invoice approved | Tenant receivable | Rent revenue (or landlord payable)¹ · Output VAT |
| Collection (RV) | Bank / cash | Tenant receivable |
| Credit note approved | Revenue · Output VAT | Tenant receivable |
| Deposit received | Bank / cash | Tenant deposits held |
| Deposit refunded (RFND) | Tenant deposits held | Bank / cash |
| Commission invoice | Landlord payable | Commission revenue · Output VAT |
| Expense on a property | Landlord payable (or expense) | Bank / cash |
| Payout to landlord | Landlord payable | Bank / cash |

**Events G3 does not map, which DESIGN.md must cover:**
- debit notes
- deposit forfeited
- deposit turned into revenue
- advance rent
- termination "mark as paid"
- rebuild reversals
- unbilled collections

**Suggested order in the PDF:**
- **Now:** the G2 fixes, a VAT summary, aging and a landlord PDF.
- **Next:** a chart of accounts and automatic journal entries, leading to a ledger and trial balance.
- **Later:** bank reconciliation, AP, and a link to accounting software.

**Open questions (G3-1…10):**
1. Keep full books in Dara, or export to an accounting package?
2. In Manager mode, is rent revenue or a landlord payable?
3. Recognise revenue at the invoice date, the due date, or collection?
4. Should the deposit liability be tracked per tenant, and is VAT due when a deposit is forfeited?
5. What is the commission VAT when the manager is not registered, and who is the seller?
6. What document should a landlord without a VAT number issue?
7. Which monthly reports?
8. Bank reconciliation in Dara, or outside it?
9. A credit balance after a credit note: refund it or carry it forward?
10. Late-payment penalties, and their VAT?

### 5.4 Bug re-check

| Bug | Verdict |
|---|---|
| E1 commission 0% | Confirmed |
| E2 dashboard zeros | **Refuted** |
| E3 −96,000 statement | Confirmed |
| E4 overdue mismatch | Confirmed (shared definition) |
| E5 total collected | Confirmed (web) |
| E6 exports | Confirmed |
| E7 paid without money | Confirmed (five sites) |
| E8 agency fee | Confirmed |
| E9 no-VAT landlords | Confirmed |
| E10 ZATCA table | Partly fixed |

#### E1: commission 0%. Confirmed.

**Root cause.** `maybeCreateCommissionInvoice` (`billing.module.ts:1018-1024`) reads only `properties.management_fee_percent`, joining contract_units → units → properties with `limit(1)`. It returns early at `:1025`, so `owners.management_fee_percent` (`owners.ts:26`) is never read.

**Every place commission is computed or shown:**

| Where | What it does |
|---|---|
| API `billing.module.ts:1018-1092` | The only place a commission amount is calculated |
| API `billing.module.ts:1487-1496` | Called best-effort from `approve()` |
| API `reports.module.ts:120-126` | Commission = the total (VAT-inclusive) of **confirmed** commission invoices, deducted at `:164,176`. A draft never reduces the landlord's net. |
| API `reports.module.ts:269` | `commissionPct` comes from the property only |
| Web `OwnerStatementModal.tsx:36-38` | A third rule, using the landlord %. The modal is dead UI: its menu entry is commented out (`OwnersView.tsx:375`). |
| Web `PropertyDetailModal.tsx:196-197`, `AccountingReportsView.tsx:119`, `EditPropertyModal.tsx:247-251`, `AddPropertyModal.tsx:244-248` | Show or edit the property % |
| Web `EditOwnerModal.tsx:63,183` | Edits the landlord %. The landlord % column in `OwnersView.tsx:339` is commented out. |
| Web `BillingDocsView.tsx:128-132`, `ContractFinancePanels.tsx:699-704` | Display the commission invoice |

**Fix:**
- Add a helper `effectiveManagementFeePct(db, contractId)`: the property % if set, otherwise the landlord %. Reuse the join from `resolveOwnerId` (`src/common/invoice-readiness.ts:135`, which is not exported).
- Use it in `maybeCreateCommissionInvoice` and at `reports.module.ts:269`.
- Return `commissionPctSource` so the UI can show where the rate came from.
- Flag-gate the change.

**Catch:** `contract_units` rows are deleted on both terminate (`:1803`) and DELETE (`:1663`). A terminated contract therefore loses its property and landlord link, which also affects `contractProp` (`reports.module.ts:74-79`).

#### E2: dashboard zeros. Refuted.

**The commit history:**
- `240638d` is on no branch. It was pushed to `origin/main` and then reset back to `96e3ecf` in the 26 Sep rollback.
- The identical patch is on master as `01ede96` (`git range-diff` shows `240638d = 01ede96`).
- `feat/finance-v2` HEAD is `origin/master` = `3eb2e4a`, and staging healthz reports `version 3eb2e4a904db`.

**Every piece of the patch is present on HEAD:**
- `dashboard.module.ts:93,103-110,128-129`
- `payments.module.ts:68-77`
- `reports.module.ts:353`
- `tenants.module.ts:219`
- `uploads.controller.ts:101`
- `common/pagination.ts:105`

The PDF was generated a minute after the master push, so its screenshots probably predate the staging redeploy.

**Zeros can still appear legitimately, because of how the figures are defined:**
- **`monthlyRevenue`** (`dashboard.module.ts:76-84`):
  - counts only rows with stored `status` of `paid` and a `paidDate` in the current month
  - takes the month from the server clock, not Riyadh time
  - ignores partial payments and invoice-only collections
- **`overdueAmount`** (`:93-95`):
  - sums the full amount of rows whose live status is overdue
  - excludes part-paid rows
  - does not subtract what has already been collected

**Fix, under the flag:** compute both from `payment_collections` using Riyadh dates, sharing the E4 helper. The web side is at `DashboardView.tsx:86,94,139-155,290-296`.

#### E3: −96,000 tenant statement. Confirmed.

The tenant section of `reports.module.ts` `accounting()` is at `:191-231`:
- **Invoiced** (`:207-214`) counts confirmed invoices and notes but excludes kinds `receipt`, `deposit` and `commission`.
- **Collected** (`:216-220`, built at `:89-94,116-118`) counts every collection on the contract.
- **Balance** is invoiced − collected (`:230`).

A tenant paid entirely on receipt vouchers therefore shows collected = 96,000 and invoiced = 0.

**Fix:** use a schedule basis, or split the collected column into collections against invoices and unbilled or advance receipts. It is flag-gated and depends on G3-3.

#### E4: overdue mismatch. Confirmed, caused by the shared definition.

**How each screen computes it:**
- `SETTLED_STATUSES` includes `partially_paid` (`payment-status.ts:26`).
- **List stats** (`payments.module.ts:159-163,222-234`) group by `liveStatusSql` and sum the full amounts, giving 19,400.
- **Arrears** (`reports.module.ts:237-257`) sums the remaining amounts but uses a UTC date, giving 23,300.
- **Mobile `buckets()`** (`mobile-landlord.module.ts:121-141`) is correct.
- **Dashboard** (`dashboard.module.ts:73,93`) has the same fault as the list.
- **Web** reads it at `InstallmentsView.tsx:308`.

**Fix:**
- Add a remaining-based definition in SQL and a TS twin to `payment-status.ts`, modelled on `buckets()`.
- Use it in the payments list and stats, the dashboard and the arrears report.
- Keep it behind the flag: changing `SETTLED_STATUSES` globally would change what the tabs and filters mean.

#### E5: contract "total collected". Confirmed (web only).

- `ContractDetailModal.tsx:237-242` sums the paid rows at face amount and adds `prepaidRent`.
- **Double count:** `applyPrepaid()` (`contracts/installments.ts:207-215`) already takes prepaid rent off the installments, and advance rent is also recorded as collections. So adding `prepaidRent` double-counts.
- **Fix:**
  - The rows already carry `collectedAmount` (`payments.module.ts:187-201`). Sum that, plus invoice-only collections.
  - Better still, add an API `collectedTotal` per contract, mirroring `payments.module.ts:164-180`.

#### E6: Excel exports. Confirmed (§3.1 findings 2–4).

- **(a) Collections export.** It outputs paid installments rather than collection rows: one row per installment instead of per RV, and invoice-only collections are missing.
- **(b) Receipt-vouchers export.**
  - It does not use the screen's filter. The API applies that filter at `billing.module.ts:405`.
  - It is capped at 1000 rows, which also exceeds the API's maximum of 200.
- **Fix:**
  - Add a `collectionsSheet()` that reads `collections-all`, and a new `"collections"` EntityKey.
  - Make the receipts export reuse the screen's query parameters.
  - This is web-only, and a candidate for the approved-exception list.

#### E7: paid without money. Confirmed.

**Where it happens:**
- `remove()` at `:1670`
- `terminate()` at `:1808` (web: `EndContractDialog.tsx:44,56,85`)
- `attachEjarInvoices()` at `ejar.module.ts:523+` (`:535-537,544`), called at `:509`. The CSV import (`import.module.ts:250`) creates pending rows only.
- `PATCH /payments` (`:258-270`) and `POST /payments` (`:238-256`), which have no UI caller

**Fix, under v2:**
- Refuse `mode=paid`, or write real collections and post them.
- Map Ejar's paid status to `settled_external`.
- Restrict `status` and `amount` on the payments CRUD routes.

#### E8: agency fee. Confirmed.

**The field today:**
- The column is `contracts.ts:98`, alongside `first_payment_amount` at `:99`.
- It is written at `contracts.module.ts:110,198,751` and read at `:507`, `tenant-portal.module.ts:109` and `mobile-landlord.module.ts:1366`.
- It appears as an audit fact at `contracts/rebuild.ts:373,398`.

**Why it is never billed:**
- `buildInstallments()` (`installments.ts:98-112`) has no agency-fee parameter. Its callers are `contracts.module.ts:871,1193`, `ejar.module.ts:496` and `import.module.ts:250`.
- In the web, only the retired `NewContractModal.tsx:229,1915` has an input for it. `ContractWizardV2.tsx:845` passes the value through but cannot set it.

**Fix, under the flag:**
- Add a one-off fee row ("أتعاب الوساطة", due at the start, VAT per `feeLineTreatment`), or an invoice line.
- Add the field to the wizard.
- Decide who the seller is.

#### E9: landlords without a VAT number. Confirmed.

**Why nothing can be issued:**
- The readiness gate runs in `approve()` (`billing.module.ts:1379-1459`) for every invoice that is not in `TAX_EXEMPT_KINDS` (`:171-174`).
- In `invoice-readiness.ts`:
  - `:533-534` blocks a landlord with no VAT number
  - `:557-561` blocks one with no ZATCA link (`sellerZatcaBlocker` `:265-289`)
  - `sellerVatBlocker` `:234-262` and `:423-427` cover the standalone path
- The only document issued without the gate is the receipt voucher (`VOUCHER_KINDS` `:180-192`).
- The UI copy states the rule at `ZatcaIntegrationView.tsx:113-116`.

**Fix:**
- Add a new exempt kind, such as `rent_receipt`.
- Skip ZATCA for it, the way commission is skipped at `:1642-1645`.
- Give it its own number series and a "not a tax invoice" label.
- If the builder's kind switch is touched, run the SDK workflow.

#### E10: ZATCA settings table. Partly fixed.

- **Already done.** `dara-web 3ba6f6e` wrapped the table in `overflow-x-auto` (`ZatcaIntegrationView.tsx:119,127-128`), inside `SettingsView.tsx:668` (`flex-1 min-w-0`) beside the `md:w-56` nav (`:654`). The page `<main>` is `overflow-hidden` (`DashboardPage.tsx:568`).
- **What remains.** Six columns with `px-4` padding. On the integrated branch the action cell is `inline-flex items-center gap-2` **with no wrap** (`:188`) and holds up to three buttons plus a badge; the revoked branch wraps (`:170`). At 1440px the table likely still scrolls sideways.
- **Fix (markup only):** add `flex-wrap justify-end` at `:188`, or collapse the actions into a menu. This needs a screenshot check. It is a candidate exception.

### 5.5 Cross-cutting facts

- **Four overdue definitions exist.** Only mobile `buckets()` is right, so use it as the reference.
- **Commission posts on approval.** It posts when the COM invoice is approved, not when it is created, and it is deducted from the landlord's net at its VAT-inclusive total (`reports.module.ts:125`).
- **Test coverage.** `src/modules/reports/` has no spec. Billing has two: `billing.items.spec.ts` and `billing.receipt-voucher.spec.ts`.
- **Freeze dimensions at event time**, because contract links are hard-deleted.

---

## 6. Posting-hook inventory

"Hook point" is where a `ledger_outbox` insert would go, gated by `finance_v2` and unique on `(source_type, source_id, event)`. For paths with no transaction, either wrap them in `db.transaction` under the flag or enqueue after the last write. Both options preserve flag-off behaviour.

| Event | Route | Service file:line | Tx boundary | Hook point | Idempotency key |
|---|---|---|---|---|---|
| Contract created: schedule (+ advance, deposit) | `POST /contracts` | `contracts.module.ts:1019-1050` → `materializeContract` `:901-1016` | One tx + advisory lock `:1036-1048` | Inside the tx before return (`:1047`); advance near `:996`; deposit `:998-1013` | collection ids; voucher id; `(contract, 'deposit_received')` |
| Contract rebuilt: reverse, then re-post | `PATCH /contracts/:id` `rebuild:true` | `rebuildContract` `:1255-1490` (deletes `:1390-1391`, voucher cancel `:1400`) | Tx + lock + `FOR UPDATE` `:1289-1296` | Reversals before `:1390`; re-post near `:1466` | `(contract, 'rebuild', audit_log_id)` |
| Installments regenerated | `POST /contracts/:id/generate-installments` | `:1158-1206` | None | After `:1205` (schedule only; posts only under accrual-by-schedule) | — |
| Bulk import | `POST /import/bulk` | `import.module.ts:236-252` | None | After `:252` | — |
| Ejar import (paid with no cash) | `POST /ejar/import` | `ejar.module.ts:310-514`; `attachEjarInvoices` `:523` | None | After `:513` (opening / settled-outside, or refuse) | `(payment, 'ejar_opening')` |
| Invoice approved (rent) | `POST /simple-invoices/:id/approve` | `billing.module.ts:1329-1500`; confirm `:1480-1482` | None | After `:1482`, **before** ZATCA `:1485` | `(simple_invoice, 'confirmed')` |
| Credit / debit note approved | same | confirm `:1467-1469` | None | After `:1469` | `(simple_invoice, 'credit'\|'debit')` |
| Commission invoice approved | same, `kind='commission'` | created `:1018-1092`; confirm `:1480` | None | After `:1482` | `(simple_invoice, 'commission')` |
| Collection on an installment | `POST /payments/:id/collections` | `addCollection` `payments.module.ts:516-570` | Tx + xact lock `:525-526` | Inside the tx before return (`:567`) | `payment_collections.id` |
| Collection against an invoice | `POST /simple-invoices/:id/collect` | `billing.module.ts:1959-2071` | Tx + lock `:1970-1971` | Inside the tx before return (`:2069`) | `payment_collections.id` |
| Receipt / deposit voucher | `POST /simple-invoices/receipt-voucher` | `createReceiptVoucher` `:1101-1241` | **None, no lock** (MAX+1 numbering) | After `:1239` (wrap in a tx under the flag) | collection ids + voucher id |
| Advance re-pointed to an invoice | `POST /simple-invoices` | `billing.module.ts:974-981` | Outside the numbering tx | After `:981` (reclassify advance → AR) | `(collection, 'repoint', invoice)` |
| Deposit collected later | `POST /contracts/:id/collect-deposit` | `contracts.module.ts:1126-1156` | None | After `:1155` | `(voucher, 'deposit_received')` |
| Termination: mark paid | `POST /contracts/:id/terminate` `mode:"paid"` | `terminate` `:1781`; write `:1806-1808` | None | Refuse, or post a write-off; after `:1904` | `(contract, 'terminate_paid')` |
| Termination: refund (legacy RFND / advance) | same | `:1814-1853` (negative collections `:1843`) | None | After `:1904` | `payment_collections.id` |
| Deposit refunded (voucher cancelled) | same, `deposit:"refund"` | `:1855-1862` | None | Before or after `:1858`; post a refund, never un-post the receipt | `(contract, 'deposit_refunded')` |
| Deposit forfeited | same | `:1864-1866` | None | After `:1866` | `(contract, 'deposit_forfeited')` |
| Deposit to revenue | same | `:1869-1889` | None | After `:1889` | `payment_collections.id` |
| Contract deleted with `mode=paid` | `DELETE /contracts/:id` | `remove` `:1642-1690`; write `:1670` | None | Refuse under v2, or post a write-off | `(contract, 'delete_paid')` |
| Payment confirmation approved | `PATCH /payment-confirmations/:id` | `payment-confirmations.module.ts:382-495` | Partial | None (it only makes a draft; posting happens on approve/collect) | — |
| Installment CRUD (status/amount) | `POST /payments`, `PATCH /payments/:id` | `payments.module.ts:238-256`, `:258-270` | None | Lock down under v2 (no posting) | — |
| Settle / revert external | `POST /payments/:id/settle-external` / `revert-external` | `:277-289`, `:292-304` | None | None (opening balance) | — |
| Expense created / deleted | `POST` / `DELETE /reports/expenses` | `reports.module.ts:363-381`, `:383-389` | None | After `:380` / `:389` | `(expense, 'created'\|'deleted')` |
| Landlord payout created / deleted | `POST` / `DELETE /reports/landlord-payouts` | `:448-461`, `:463-469` | None | After `:460` / `:468` | `(payout, 'created'\|'deleted')` |
| Account/user hard delete | `DELETE /admin/companies/:id`, `/admin/users/:id` | `admin.module.ts:537-543, 929-935` | None | Cascade the ledger, or block | — |

**Worker:** a `setInterval` service following `NewsSchedulerService` (`news.scheduler.service.ts:59`), with retries and a visible list of posting errors.

---

## 7. Finance endpoints the current UI calls

The flag-off snapshot must compare these responses byte for byte. Hook lines are in `dara-web: lib/api-hooks.ts` unless another file is named.

**How the web builds these requests:**
- `buildListQS` (`lib/api/core.ts:188-204`) drops `undefined`, `null`, `""`, `"all"` and `false`, and adds `page=1` when no parameters are left.
- `fetchAllPages` walks pages of 200, up to 25 pages (`api-hooks.ts:519-545`).
- `LIST_PAGE_SIZE` is 25 (`core.ts:177`).

### GET

1. `GET /api/dashboard/summary`: `useGetDashboardSummary` `:369`; `DashboardView.tsx:69`
2. `GET /api/payments` (bare array): `useGetPayments` `:1016`. Called from:
   - `DashboardPage.tsx:313`
   - `DashboardView.tsx:75` (fallback only)
   - `ReportsView.tsx:116`
   - `ContractDetailModal.tsx:99`, `PropertyDetailModal.tsx:60`, `UnitDetailsDrawer.tsx:56` (when there are more than 200 rows)
   - `InstallmentsCalendar.tsx:53`
   - `TenantProfileModal.tsx:45`
   - `TenantDashboardView.tsx:34`
   - `report-export.ts:371,394`
3. `GET /api/payments?dueFrom=&dueTo=`: `useGetPaymentsInRange` `:1029`; `InstallmentsCalendar.tsx:52`
4. `GET /api/payments?page=1&pageSize=5&order=desc`: `DashboardView.tsx:78`
5. `GET /api/payments?page=1&pageSize=1`: `ReportsView.tsx:103`
6. `GET /api/payments?page=N&pageSize=25[&search=]&statusIn=pending,partially_paid|overdue|paid&order=asc|desc[&contractIds=]`: `InstallmentsView.tsx:225-231`. Parameter order is set at `:1047-1055`.
7. `GET /api/payments?page=N&pageSize=25&statusIn=paid,partially_paid` or `statusIn=pending,partially_paid,overdue,paid,cancelled`, then `&order=asc&contractIds=<id>`: `ContractFinancePanels.tsx:142-146`
8. `GET /api/payments?pageSize=200&contractIds=<ids>`: `ContractDetailModal.tsx:94`, `PropertyDetailModal.tsx:55`, `UnitDetailsDrawer.tsx:51`
9. `GET /api/payments/:id/collections`: `:1064`; `CollectInstallmentModal.tsx:61`
10. `GET /api/payments/collections-all?page=N&pageSize=25[&search=][&contractIds=]`: `:2151`/`:2164`; `CollectionsView.tsx:75`
11. `GET /api/simple-invoices?page=N&pageSize=25[&search=]&type=invoice|credit,debit[&status=][&contractIds=][&excludeVouchers=true]`: `BillingDocsView.tsx:83-87`
12. `GET /api/simple-invoices?...&type=invoice&status=confirmed&awaitingCollection=true[&contractIds=]`: `CollectionsView.tsx:85-89`
13. `GET /api/simple-invoices?...&type=invoice&status=confirmed[&contractIds=]&hasReceipt=true`: `ReceiptVouchersView.tsx:48-56` (`excludeDeposit=false` is dropped)
14. `GET /api/simple-invoices?type=invoice&contractIds=<id>&pageSize=200&page=1`: `ContractFinancePanels.tsx:154`
15. `GET /api/simple-invoices?type=invoice&status=confirmed&contractIds=<id>&excludeVouchers=true&page=N&pageSize=25`: `ContractFinancePanels.tsx:297`
16. `GET /api/simple-invoices?contractIds=<id>&type=<t>[&status=confirmed][&excludeVouchers=true][&hasReceipt=true]&page=N&pageSize=25`: `ContractFinancePanels.tsx:385`
17. `GET /api/simple-invoices?contractIds=<id>&type=credit,debit&page=N&pageSize=25`: `ContractFinancePanels.tsx:507`
18. `GET /api/simple-invoices?type=invoice&status=confirmed&pageSize=200[&search=]&excludeVouchers=true[&contractIds=]&page=1`: `CreateInvoiceModal.tsx:427`
19. `GET /api/simple-invoices?type=invoice&contractIds=<page ids>&pageSize=200&page=1`: `InstallmentsView.tsx:242`
20. `GET /api/simple-invoices?page=K&pageSize=200&contractIds=<ids>` (walks pages): `useGetAllSimpleInvoices` `:2011`; `ContractsView.tsx:132`
21. `GET /api/simple-invoices/:id`: `:2034`; `CollectionsView.tsx:45`, `ContractFinancePanels.tsx:81`
22. `GET /api/simple-invoices/readiness?contractId=&paymentId=&tenantId=&ownerId=`: `:820-840`
23. `GET /api/simple-invoices/customers` (bare): `CreateInvoiceModal.tsx:270`
24. `GET /api/simple-invoices/customers?page=N&pageSize=25[&search=]`: `InvoiceCustomersView.tsx:51` (staging builds only)
25. `GET /api/simple-invoices/:id/pdfa3`: `SimpleInvoiceDetailModal.tsx:253`
26. `GET /api/reports/accounting`: `:2171`; `AccountingReportsView.tsx:49`
27. `GET /api/reports/expenses?page=N&pageSize=25[&search=][&ownerId=][&propertyId=][&category=]`: `ExpensesView.tsx:50`
28. `GET /api/reports/expenses?page=1&pageSize=1[&filters]&from=&to=` (reads `totalAmount`): `ExpensesView.tsx:88`
29. `GET /api/reports/expenses/categories`: `ExpensesView.tsx:57`
30. `GET /api/reports/expenses` (bare): `ExpensesView.tsx:58` (fallback); `report-export.ts:389`
31. `GET /api/reports/landlord-payouts`: `:2235` (hook only; no component calls it)
32. `GET /api/contracts/:id/settlement`: `EndContractDialog.tsx:31`
33. `GET /api/contracts/:id/deposit`: `ContractDetailModal.tsx:81`
34. `GET /api/payment-confirmations?page=N&pageSize=25[&search=]&status=pending|approved|rejected`: `PaymentConfirmationsView.tsx:55`
35. `GET /api/payment-confirmations/:id/proof`: `:1216`
36. `GET /api/zatca/landlords` (`ZatcaIntegrationView.tsx:49`) and `GET /api/zatca/credentials` (`TaxInvoicesView.tsx:56`)
37. `GET /api/invoices?page=N&pageSize=25[&search=]`: `TaxInvoicesView.tsx:63` (nav hidden)
38. Export fetches, all from `report-export.ts`:
    - `/api/simple-invoices?pageSize=1000&excludeVouchers=true` (`:375`) and `/api/simple-invoices?pageSize=1000` (`:380`). Both probably return 400 (§3.1).
    - `/api/payments` (`:371,394`)
    - `/api/reports/expenses` (`:389`)
39. Also in scope if the flag rides on it: `GET /api/me/package` (`DashboardPage.tsx:192`) and `GET /api/auth/me/permissions` (`:274-279`).

The finance screens also read these non-finance endpoints: `/api/contracts`, `/api/owners`, `/api/properties`, `/api/units`, `/api/tenants`, `/api/deeds?...`, `/api/companies/me`, `/api/profile`, and the counts at `ReportsView.tsx:95-103`.

### Writes: never replay these against staging during the snapshot

- **Payments:**
  - `POST /api/payments/:id/collections` (`:1077`)
  - `POST /api/payments` (`:1086`)
  - `PATCH /api/payments/:id` (`:1100`)
- **Simple invoices:**
  - `POST /api/simple-invoices` (`:2045`)
  - `PATCH /api/simple-invoices/:id` (`:2059`)
  - `POST /api/simple-invoices/:id/approve` (`:2090`)
  - `POST /api/simple-invoices/:id/submit-zatca` (`:2106`)
  - `POST /api/simple-invoices/:id/collect` (`:2115`)
  - `POST /api/simple-invoices/receipt-voucher` (`:2129`)
  - `DELETE /api/simple-invoices/:id` (`:2141`)
  - `POST /api/simple-invoices/:id/pdf-key` (`:1536`)
- **Contracts:**
  - `POST /api/contracts/:id/terminate` (`:720`)
  - `POST /api/contracts/:id/collect-deposit` (`:858`)
  - `PATCH /api/contracts/:id` with `rebuild:true` (`:907`)
  - `POST /api/contracts/:id/generate-installments` (`:999`)
- **Expenses:** `POST /api/reports/expenses` (`:2220`), `DELETE /api/reports/expenses/:id` (`:2228`)
- **Landlord payouts:** `POST /api/reports/landlord-payouts` (`:2241`)
- **Payment confirmations:** `PATCH /api/payment-confirmations/:id` (`:1204`). **This one notifies the tenant.**
