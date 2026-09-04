# Open work — ZATCA, observability, data

Raised while debugging owner 264's e-invoicing (28 Aug – 03 Sep 2026). Each item
says what is wrong, why it matters, and where to start. Ordered by what hurts
first, not by effort.

Nothing here is speculative: every line was observed on production or reproduced
in a test. Where a decision is needed rather than a fix, it says so.

---

## 1. Blocking a customer right now

### 1.1 Resend `INV-000002` for owner 264
The only invoice ever submitted for him was refused `401
Invalid-Authentication-Certificate` on 30 Aug, because it was signed with a
compliance certificate. He re-linked on 2 Sep and his device is active in Fatoora
(serial `…02000295EE`). The document is already `confirmed`, so **اعتماد will not
resend it** — it needs the *submit to ZATCA* action. Until then he has no cleared
invoice, and believes he does.

### 1.2 Decide: does the strict ZATCA rule stay?
Since 01 Sep, approving any tax invoice requires the seller to be linked,
regardless of VAT registration. Measured on production: **1 of 48 landlords is
onboarded**, so 47 cannot approve anything. Deliberate and reaffirmed, but it is
the single largest behavioural change in the product and nobody outside this
work knows it. Revert point: the VAT condition on `sellerZatcaBlocker`'s call
sites — `DARA-NOTES.md` §2b-iii.

Related, same decision: a document whose lines are **all exempt** (residential
rent — the majority case) still needs the link, even though
`runZatcaSubmission` would skip it as `not_required`. The seller must onboard to
unlock a button for a document ZATCA declines to receive.

---

## 2. Correctness — wrong data reaching ZATCA

### 2.1 Seller has no `PartyIdentification` (BR-KSA-08)
`invoice-builder.service.ts` omits the seller's `<cac:PartyIdentification>`
when `sellerCrn` is blank, and onboarding never required it. ZATCA warns on
**every invoice** from such a seller. Decide: require the CR at onboarding, or
fall back to `OTH` with the national ID the way an individual seller already
does. Note the seller block is frozen at onboarding, so fixing the record is not
enough — the landlord must re-link.

### 2.2 A cleared standard invoice prints an unverifiable QR
The signer emits a Phase-2 (9-tag) QR only for simplified invoices; a standard
one is meant to print the QR ZATCA stamps and returns. When `cleared_xml` is
null — which it is on every production row today — the document falls back to a
locally built **Phase-1** QR: five display fields, nothing to verify. It scans
in ZATCA's app and looks correct, which is exactly how owner 264 concluded his
rejected invoice had been filed. `invoice-doc.ts:145`.

### 2.3 `saveProfile` wipes the EGS generation
`upsertProfile` writes `serialNumber` straight from the request, and the web
always sends the base `1-Dara|2-PMS|3-<ownerId>`. So the generation that
`unlink` and `issueComplianceCsid` carefully bump is discarded by the very next
onboarding step. Observed on production: a serial set to `…-264-2` was back to
`…-264` after re-onboarding. Keep the stored generation when the incoming serial
is the same base.

### 2.4 One `serial_number` column, two device slots
Sandbox and prod/simulation are separate EGS units with separate certificates,
but share one column, written unconditionally on every branch. A sandbox
re-onboard after a live production link rewrites the column, and nothing records
the serial ZATCA actually holds for production.

### 2.5 Certificates issued before 02 Sep may be missing mandated fields
`utf8 = yes` never applied to the `subjectAltName` dirName, so Arabic there was
double-encoded and, past ~40 bytes, openssl dropped the attribute **and every
attribute after it** while exiting 0. Certificates minted before the fix can be
missing `registeredAddress` and `businessCategory`. Visible in Fatoora: owner
264's cancelled device shows its organisation name as `Ø±ØŞÙ‰ÙˆÙ‰Ù`. Only that
one certificate existed, and it is gone — but re-check if any seller onboards
from a backup.

### 2.6 Three fields are hard-coded and untrue
- `PaymentMeansCode` is always `10` (cash), whatever the invoice was paid by.
- `ActualDeliveryDate` always equals the issue date.
- `PlotIdentification` is filled with the building number — a different field.

None is flagged by ZATCA. None is correct.

---

## 3. Observability — we are debugging blind

These cost six queries and a day of guessing on the owner-264 question. Each is
small.

**Most of this section shipped on `master` (05 Sep 2026).** There is now a
structured stdout log carrying a request id, an `app_logs` table that outlives
the container, a catch-all exception filter, a real health check, and
`GET /admin/logs` to read it back. What each item below still owes is noted on
it. See `src/common/logging/` and `src/common/client-ip.ts`.

### 3.1 Record the real client IP — DONE
`clientCtx` (`auth.controller.ts:25`) and `common/throttler.ts` read the first
entry of `x-forwarded-for`, which behind Cloudflare is **Cloudflare's own edge**.
Every IP in `login_logs` and `phone_otp_tokens` is `172.69.x.x`. Read
`cf-connecting-ip` first, fall back to XFF. This also weakens per-IP rate
limiting today, since many users share one edge address.

Fixed: `src/common/client-ip.ts` is the single definition
(`cf-connecting-ip` → `x-real-ip` → XFF[0] → socket), validated with
`net.isIP` so a forged header cannot become a rate-limit bucket key, and all
three duplicate call sites now import it. **Rows written before this still
hold the edge address** — nothing backfills them.

### 3.2 Keep the user agent on OTP requests — still open
`clientCtx` captures `ua` and then throws it away — `phoneOtp.start` takes only
the IP. `login_logs` keeps a coarse `device` string and nothing else.

Partly covered: the user agent is now on every `app_logs` row, so an OTP
request has one somewhere. `phone_otp_tokens` still does not carry it.

### 3.3 Log a refused approval — DONE
A readiness-gate refusal leaves **no trace anywhere**. From the database it is
indistinguishable from the user never having tried, which is precisely the
ambiguity we could not resolve for owner 264.

Fixed: both refusals on `POST /simple-invoices/:id/approve` now write an
`invoice_approval_refused` row naming the document and which blockers fired.
Read it with `GET /admin/logs?event=invoice_approval_refused`.

### 3.4 Log onboarding on production
`issueComplianceCsid` / `issueProductionCsid` write nothing. Owner 264's
re-link at 11:20 on 2 Sep is visible only as a timestamp on a row. The
compliance-check logging fix exists; onboarding still does not log.

---

## 4. Security and data hygiene

### 4.1 `createReceiptVoucher` does not validate `kind`
`billing.module.ts` — `body?.kind ?? "receipt"`, no `KNOWN_DOC_KINDS` check, and
the row is inserted `status: "confirmed"`. A caller can mint a **confirmed**
`kind: "invoice"` tax document with taxable lines, past both gates, in one call.

### 4.2 Tenant login with a shared phone
`0502907100` is on **five tenant records across five accounts** and five
landlord records across five more. `findOwnerByLoginPhone` resolves by lowest
id. There was a prior fix for *"a tenant could read every account sharing their
phone number"* — worth re-checking how the tenant path picks among five.

### 4.3 Clean the test data off a real phone number
That number is the account holder's own, seeded into records named `Test`,
`dsdssd dsdsdsds`, `safra`, `حساب مستأجر تجريبي`. Each is a live route to an SMS
at a real phone, and for the tenant path a candidate identity to log in as.

### 4.4 ICV allocation outside the chain lock
`complianceCheck` and `complianceSuite` read `decrypted.icv + 1` and submit
outside `withSellerChainLock`. They persist nothing and production is guarded,
so this is a note rather than a bug — but it is the one remaining reader of that
counter that is not serialized.

---

## 4b. The subscription window is not enforced on the server

Raised 04 Sep 2026, when the 14-day trial made it matter.

`deriveSubscription` has exactly two callers, both GET handlers
(`subscription.module.ts`, `package.module.ts`). `src/common/guards/` holds
only `jwt-auth`, `roles` and `tenant-auth`, and the single `APP_GUARD` in
`app.module.ts` is `OtpThrottlerGuard`. So `locked` is **advisory**: the
restriction is one `setActiveTab("settings")` in `DashboardPage.tsx`. The same
JWT still succeeds against `POST /api/properties`, `/api/contracts` and
everything else.

This is pre-existing — but it used to catch only lapsed payers, of whom there
were none. Now that every account starts on a free trial, it is the
monetisation boundary for the entire platform: when a trial expires, nothing
server-side stops the account from carrying on through the API.

Fix is a guard that reads the same derivation and refuses writes on a locked
account, with settings/usage/pay exempted. The care needed is in the exemption
list — too broad and it does nothing, too narrow and it locks a paying customer
out of paying.

## 5. Smaller, known, not urgent

- **`POST /invoices` skips the gate when there is no `contractId`** — fixed for
  the seller and buyer, but `resubmit` still never clears `linkInvalidAt` after a
  successful resend.
- **Leading-zero EGS generations collide**: `…3-264-01` and `…3-264` both bump to
  `…3-264-2`. Only reachable via a hand-written serial through the profile API.
- **The 64-character CSR cap** is measured in code points and enforced at CSR
  time — i.e. after the OTP has been spent. A long company legal name fails
  mid-onboarding rather than at profile save.
- **Buyer gate vs approve path**: `POST /invoices` demands `id` + `idScheme` for
  a standard invoice, while the approve path sets `idScheme: null` when the
  party type is neither company nor individual. Same document, two answers.
