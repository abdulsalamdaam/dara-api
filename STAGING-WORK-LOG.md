# Staging work log — 28 August 2026

Everything done in one session: two features built, the assessment that came
before them, every bug fixed, and what is still open. Written so someone
picking this up cold can tell what changed, why, and what to trust.

**All of it is on `master` (staging). Production runs `main` and has none of
it** — see [What production is missing](#what-production-is-missing), which
includes a live data leak and an unauthenticated activation endpoint.

---

## 1. Staging access

| | |
|---|---|
| Portal | https://app-staging.dara-sa.net |
| API | https://api-staging.dara-sa.net |
| Landlord | `zatca-test@dara-sa.net` · OTP `111111` |
| Staff sub-user | `zatca-test-staff@dara-sa.net` · OTP `111111` |
| Tenant | phone OTP · bypass code `1234` |

The OTP bypass is armed by `TWILIO_DEV_BYPASS`/`SMS_DEV_BYPASS` on staging and
is `false` on production. `POST /auth/email-otp/verify` accepts `111111`
directly — no `request` call, so **no email is sent to anyone**.

The account is a copy of the production ZATCA landlord (owner 264). Its ZATCA
credentials were deliberately **scrubbed**: the production certificate would
have decrypted on staging (same `APP_ENCRYPTION_KEY`) and filed real tax
invoices. Re-onboard against sandbox to test ZATCA there.

Figures on that account (unit counts, occupancy, totals) include test data
created during the assessment. They are not production numbers.

---

## 2. Features built

### 2.1 Edit a contract by rebuilding it in place

A landlord who got a contract wrong can now walk the **same six-step wizard**
used to create it, every field pre-filled. Saving destroys the schedule and
regenerates it from the corrected values. The contract keeps its row, its id
and its number. `PATCH /api/contracts/:id` with `rebuild: true`; rules live in
`src/modules/contracts/rebuild.ts`.

**What is destroyed and recreated:** installments, `contract_units`,
`contract_rent_terms`, and the advance receipt voucher (voided and re-minted,
carrying its original payment proof). All inside one transaction, under the
same advisory lock creation takes, so a rebuild cannot interleave with a
concurrent create.

**The deposit voucher is never rebuilt.** It is the tenant's proof that trust
money was received. If the deposit amount or its collected status would change,
the whole rebuild is refused instead.

**Eligibility — refused if any of these hold.** Deliberately stricter than "no
ZATCA invoice":

| Refusal | Why |
|---|---|
| Draft | The ordinary save already does the whole job |
| Terminated / cancelled | Units are freed and refunds may be issued |
| Any row in `invoices` — *any status, including draft* | A draft has already consumed an ICV in the landlord's hash chain |
| A billing document that reached ZATCA — `cleared`, `reported`, **or `failed`** | A rejected submission still travelled and consumed an ICV |
| Any other live billing document | It points at installments the rebuild deletes |
| A collection that is not the create path's own advance | Real money against a schedule that is about to disappear |
| The deposit would move, or be marked uncollected | Its receipt already exists |

The refusal names the credit note as the correct route.

**How the advance is identified — do not change this back.** It is recognised
by `payment_collections.invoice_id` being null, *not* by the Arabic note
string. Billing's manual receipt-voucher endpoint copies the caller's note onto
both the voucher and its collections, so a hand-made voucher carrying that note
used to be silently cancelled and its collection deleted. The creation path
never sets `invoice_id`; `createReceiptVoucher` always does. Structural, not
textual. Covered by `rebuild.spec.ts`.

**Audit.** Written to `audit_logs` inside the transaction, `action = "rebuild"`,
with a from/to diff of the fields that drive money. `audit_logs` has no payload
column, so the detail rides as a JSON suffix on `path` — `rebuildAuditPath` is
the single place to change if a `details jsonb` column is ever added.

**In the portal.** The action appears on the contract detail header and the
list row menu. A hook classifies the contract's documents exactly as the server
gate does, so the action is hidden with the reason rather than failing on save.
Before saving, a modal states plainly that the schedule will be regenerated and
the advance receipt reissued.

**One sharp edge worth knowing:** the rebuild rewrites every column from the
payload, so a field the client omits is stored as `null`. The wizard carries
back the tenant tax number, national addresses, signing place, representative
details and agency fee for exactly this reason. Anything new added to the
contract must be added to that carry-over block too, or correcting a rent will
wipe it.

### 2.2 Saudi phone numbers — 9 digits, `+966` shown not stored

Stored as `502907100`. The country code is part of the field, not part of the
data.

- One shared input in each client normalises every keystroke and paste:
  `+966…`, `966…`, `00966…`, `05…`, `5…`, spaces, dashes, and Arabic-Indic or
  Persian digits all land the same way. Legacy values normalise on the way in,
  so a form opened and saved untouched writes clean data.
- Display is `+966 50 290 7100` in an explicit LTR run so it reads correctly
  inside Arabic text. `tel:` and WhatsApp links are built from the canonical
  digits and re-add the country code.
- The server accepts exactly what the clients promise — verified by a
  differential test against `dara-web/src/lib/phone.ts`.
- **Drafts normalise but never refuse.** A half-typed number still saves; a
  recognisable one is stored canonically. This matters because
  `contracts.tenant_phone` joins to `tenants.phone` by exact string equality
  and drafts are visible in the portal.

**Staging data migrated:** 240 rows across 9 columns. The exact-match join went
**93 → 95 rows — two tenants who could not see their own contracts now can.**

Three rows were left alone deliberately, being unrecognisable: `owners.phone`
id 249 = `12`, `users.phone` id 20 = `050000089`, and `users.phone` id 28,
which holds a stored SQL-injection probe string worth deleting separately.

**Production migration:** `db/sql/2026_08_phone_bare_9_digits.sql` is
idempotent, but `db/sql/*` **never self-applies** — see §5. It must be run by
hand **at the same time as** the API deploy carrying the new validation. While
the two disagree, new writes use one format and old rows another, and the
tenant-portal join goes blind for the affected tenants.

---

## 3. Bugs fixed

Grouped by what they cost. Every one was reproduced against staging before
being fixed, and re-verified against the deployed build afterwards.

### Security

| Bug | Detail |
|---|---|
| **Tenant portal leaked across accounts** | Contracts matched on phone alone with no account scoping. Any tenant whose number also appeared on another landlord's contract read that landlord's name, national ID, their other tenants' contracts and signed deed links. Proven: one token returned 11 contracts across 3 accounts; now 3, all their own. |
| **Subscription webhook activated on an anonymous request** | Unauthenticated by design (Moyasar calls it) and meant to verify rather than trust — but it only did when the payload carried an `invoice_id`. Without one, `paid` came straight from the request body. The secret guard rejected a *wrong* token but only warned on an *omitted* one. |
| **Contract accepted another account's units** | It linked, showed their property, and flipped their unit to "rented" — a cross-account write. |
| **Employee created without a `preset` got the owner role** | The resolver defaulted to `"user"` — 40 permissions including deletes and `subscription.manage`. |
| **Rate limits were switched off** | Every per-route `@Throttle({ default: … })` was a no-op: no bucket by that name existed, so register, reset-password and OTP-verify ran on the loose global limit. |
| **Invoice readiness could be bypassed** | The gate read `!body?.kind`, so passing *any* value skipped it. Only receipt, deposit and commission are genuinely not tax invoices. Staging holds 12 documents issued through the old bypass. |
| Individual could buy the company-only `tenant` plan | The one path to `users.package_plan` that skipped the user-type check |
| Phone-OTP login resolved to an arbitrary identity | Duplicate numbers, no ordering. Worse after canonicalisation — numbers that differed only by format now collide exactly. Soft-deleted tenants could also still log in. |
| Deed delete revealed another account's rows exist | 409 instead of 404 |
| Team endpoint returned internal token columns | `emailVerifyTokenHash`, `tokenVersion` and friends |

### Money

| Bug | Detail |
|---|---|
| **The same collection could be recorded 5×** | Read-then-insert with no lock, on **both** paths. Eight parallel requests each passed the cap: 4,000 recorded against a 1,000 invoice. The installment path was locked first; its invoice-level twin was missed and caught by QA. |
| **VAT charged on exempt rent** | The contract row stored the derived VAT flag while the installments were built from the raw request flag — one contract could read "exempt" and still bill 15%, on its way to a ZATCA invoice. |
| **Credit notes were unbounded** | A 5,000 note on a 1,000 invoice was accepted, as was a note referencing a non-existent or draft invoice, and one with no reference at all. The accounting statement reported negative revenue under a nameless tenant. |
| **Collection ignored credit/debit notes** | Money could be collected on an invoice owing nothing, while a genuine 500 balance was refused as "fully collected". |
| **An invoice could be stamped paid with zero money** | It consumed a receipt-voucher number and then appeared in Collections as money that never arrived. |
| **Cancelling a contract voided collected money** | Part-collected installments were swept to "cancelled", so real receipts vanished from every status-derived total. |
| **Mobile totals understated by 13,300 SAR** | Derived from installment status rather than actual receipts. A partial collection fell into no bucket at all — a 1,000 receipt made 57,500 of overdue disappear and counted the 1,000 nowhere. |
| **Money with no installment behind it was invisible** | The rebuilt mobile figures read collections by installment, so invoice-only receipts stayed unseen — 23,300 SAR short. Caught by QA. |
| **Schedules lost halalas** | Each period rounded independently with no reconciliation: 10,000/year billed 9,999.96. The remainder now lands on the final row. |
| **Advance rent above the schedule was swallowed** | 987,999 recorded as received with no receipt and no error. |
| **The API would mint any VAT figure** | Line items totalling 100 with a stated total of 999,999 was accepted. |
| Deleting an invoice left its money in every total | A confirmed, collected invoice could be deleted; its collections survived and kept counting |
| Free-invoice money missing from the accounting statement | The tenant statement said they still owed what they had already paid |
| Commission numbers reused after a delete | `COUNT(*)+1` instead of `MAX+1` |

### Correctness and stability

| Bug | Detail |
|---|---|
| **A malformed schedule date left a live contract with no installments** | An unparseable custom-schedule date threw a `RangeError` → 500, and creation committed the contract and unit links *before* materialising the schedule. The contract survived, holding a unit as "rented", with nothing in it. Creation is atomic now. |
| **B2C tax invoices could not be printed at all** | The template hand-rolled a QR encoder whose alignment table stopped at version 10; a signed 9-tag QR is version 15. Every simplified invoice 500'd from `/html` and `/pdf`. |
| **The invoice PDF had no browser to render with** | The endpoint shells out to headless Chrome and the image had none. |
| **A cleared invoice printed the wrong QR** | The download path printed our placeholder instead of the QR ZATCA stamped — unverifiable by any scanner. |
| **Draft laundering** | Drafts are exempt from identity validation, and nothing re-checked when they went live. A contract reached production state with phone `+966500000001` and id `99`. Every draft→live transition now re-runs full validation on the merged row. |
| Concurrent contract creation returned 500s | Numbers came from `COUNT(*)`; six parallel creates → four failures |
| A unit could be double-booked | Two active contracts, overlapping dates, both billing |
| Deleting a property orphaned live contracts | Property gone, contract still active with pending installments |
| Reversed dates and negative rent accepted | A live contract billing −60,000 |
| Several 500s on malformed input | Non-numeric and out-of-range ids, empty PATCH bodies, oversized numbers — all 400s now |
| Deleted units resurfaced through the contracts endpoint | Tombstone and all |
| Unit status colours inverted between screens | Green "available" in the list became amber in its own drawer, where green meant "rented" |

### Input validation

One shared module (`src/common/validation.ts`), applied on **create and
update** across landlords, tenants, properties, units and contracts — update
paths had been skipping what create enforced.

Saudi mobile · national ID and iqama (10 digits, 1 or 2) · CR (10 digits) ·
VAT (15 digits, starts and ends with 3) · IBAN (`SA` + 22) · postal code (5) ·
building and additional numbers (4) · email shape and length · text length caps
(a 5,000-character unit number used to be accepted) · numeric bounds inside
each column's precision · real calendar dates · unit number unique per
property.

Drafts keep their exemption from identity formats. Length caps, bounds and
enums always apply.

### Accessibility and theming

414 pieces of text failed contrast at 2.94:1 (icons deliberately untouched) ·
416 of 417 form controls had no programmatic label · 36 modals had no dialog
semantics, no Escape and no focus trap · 43 icon-only buttons were unnamed ·
six controls were mouse-only, including opening a deed and the amenities step
of both property forms · 13 inputs removed the focus ring and replaced it with
nothing · status colours disagreed across 23 files · 63 stock-Tailwind hex
values bypassed the re-anchored Dara ramp, so every exported invoice was drawn
in the wrong greys.

**The palette itself was not the problem.** Tailwind's `blue`/`slate`/`indigo`
ramps are deliberately re-anchored onto the Dara colours in `globals.css`, so
the ~5,300 uses of those class names are visually correct. Do not "fix" them.

### Figures that lied

Several screens computed a number from a query with a fixed page size, so past
that many rows the figure was simply wrong and nothing said so. The API caps
`pageSize` at 200, so raising it was never an option — these walk the pages and
show the bound when one still bites.

The damaging one: the contract finance panel built its invoice map from the
first 200 rows, so an installment whose invoice sat past that looked
un-invoiced and offered "create invoice" again — **a duplicate invoice, one
click away**.

---

## 4. Still open

| Sev | Item | Note |
|---|---|---|
| MED | Cross-account DELETE answers 200 | Deletes nothing; siblings answer 404 |
| MED | ~180 labels on custom controls | Needs `id` plumbing through each product component — a refactor, not a fix |
| LOW | 1,220 UI strings bypass the translation files | Written inline as Arabic/English ternaries; mechanical but large |
| LOW | An advance recorded on a draft never produces its artefacts when the draft is finalised | The update path does not rebuild the schedule |
| LOW | Tenant statement shows a negative balance when money is collected with no invoice issued | `balance = invoiced − collected`. A reporting-definition question, not a defect |
| — | `InstallmentsPanel` still caps its own installment list at 200 | Bounded, no longer a duplicate-invoice path |

---

## 5. Operational notes

**Migrations do not run.** The 61 files in `db/drizzle/` are shipped into the
image and never read; the migration tracking table is empty in both databases.
The real mechanism is ~30 hand-written `ALTER … IF NOT EXISTS` statements in
`src/database/bootstrap.ts` that run at boot — and **every failure is
swallowed**, so a broken schema change still passes the health check and takes
traffic. Files under `db/sql/` are never executed at all; the runtime image
does not even copy them.

**Never run `pnpm db:push`.** The Drizzle schema is not the source of truth for
indexes: a push would drop 22 of them, including the uniques protecting
contract numbers and default landlords.

**`main` and `master` have diverged** and are documented as identical. They are
not. This bit twice in one session — the same fix existed on both branches
written differently, and one merge silently dropped a guard until it was
checked by hand. Reconcile them before more work lands.

**Confirm a deploy by behaviour, never by the green tick.** Rolling updates
leave two containers serving for 25–65s, and Coolify logs a failed cleanup as
hidden while still reporting success. An old build served traffic for five
minutes during this session.

```bash
sudo -n docker ps --format '{{.Names}}\t{{.Status}}' | grep <uuid-prefix>
```

**Deploys now fire once per push.** Coolify's GitHub App auto-deploy was
disabled for all four apps; the Actions workflow is the only trigger, kept
because it fails loudly. Revert by setting
`application_settings.is_auto_deploy_enabled = true`.

**Deploy speed — what was actually changed.** Four of the measured costs:

| Change | Cost it removes |
|---|---|
| Coolify's GitHub App auto-deploy disabled | Every push deployed twice; the second built nothing and blocked the queue (~470s per push) |
| BuildKit cache mount on `.next/cache` | `next build` started from zero every deploy — 146s alone, 209s under contention, 41% of a web deploy |
| pnpm store cache mount, both images | A lockfile change re-downloaded all 554 packages; the layer cache cannot help, since that same change invalidates the layer |
| `SIGTERM` handled in the API | Nothing listened, so every deploy sat out Docker's full 30s grace period and was killed — 34.5s, 14% of an API deploy |

The `.next/cache` mount also stops 1.5 GB of build state being copied into the
runtime image: a cache mount is unmounted before the layer is committed.

**Still not done:** `output: "standalone"` on the web image (it ships the whole
450–550 MB dependency tree), and `react-icons` (83 MB, zero importers) plus a
duplicated `date-fns`.

**Docker cleanup is now threshold-driven, not unconditional.** It ran nightly
regardless of disk and wiped 100% of the BuildKit cache, so the first builds of
each day were fully cold — which would have defeated the mounts above.
`force_docker_cleanup` is off; the 80% threshold still protects the disk.
Watch this: the disk reached **79%** during this session's build churn and was
reclaimed to 58% by pruning stale images and build cache older than 12h. Note
the API image tripled (534 MB → 1.67 GB) when Chromium was added for invoice
PDFs.

Full measurements, including the duplicate-container mechanism, are in
`DEPLOY-PERFORMANCE.md`.

---

## 6. What production is missing

Production runs `main`. **None of the above is on it.** Two items are not
merely improvements:

1. **The tenant-portal account-scoping fix.** The unscoped code is live, so the
   cross-account leak is live.
2. **The subscription webhook fix.** An anonymous POST can still activate a
   subscription.

Also production-only: the ZATCA B2C signing fix and the production CSID for
owner 264 **are** on production (shipped earlier), so ZATCA compliance itself
is not affected by the branch split.

---

## 7. How this was verified

Every fix was reproduced against staging first and re-checked against the
deployed build afterwards, by agents that had not written the code. Two rounds
of that verification each found real defects the authors had missed — including
an incomplete fix of mine, where the collections lock went onto one path and
not its twin, and a rebuild that voided a voucher it did not own. Assume the
same of anything added next.
