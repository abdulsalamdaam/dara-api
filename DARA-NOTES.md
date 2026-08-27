# Dara — cross-repo working notes

Shared across `dara-web`, `dara-api`, `dara-mobile`. Identical copy in each.
This is hard-won context: things that cost real debugging time, and the
reasoning behind decisions that look arbitrary from the code alone.

---

## 1. Deployment — read this before promising anything is "live"

**Pushing to `main` does not deploy.** Coolify hosts both apps on one server
(`87.237.226.107`, ssh alias `dara-server`), and there is **no staging** — two
apps, both tracking `main`, both on production domains:

| app | domain |
|---|---|
| `dara-api` | `api.dara-sa.net` |
| `dara-web` | `dara-sa.net`, `app.dara-sa.net` |

Running images are tagged with the commit SHA, so what is actually live is:

```sh
ssh dara-server 'sudo -n docker ps --format "{{.Image}}" | grep -E "^(c7uop|q3orr)"'
```

Deployment history (read-only):

```sh
ssh dara-server 'sudo -n docker exec -i coolify-db psql -U coolify -d coolify -c \
  "select a.name, substring(q.commit,1,8), q.status, q.created_at \
   from application_deployment_queues q \
   join applications a on a.id::varchar = q.application_id \
   order by q.created_at desc limit 5;"'
```

**Auto-deploy now runs through GitHub Actions**, not the GitHub App.
`.github/workflows/deploy.yml` in `dara-api` and `dara-web` calls Coolify's
deploy API on every push to `main`, using a `COOLIFY_TOKEN` repository secret.
The job fails loudly on any non-200 or a response that did not queue a
deployment, so it cannot report green while nothing ships.

Manual deploy (same call the workflow makes):

```sh
curl -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "https://coolify.dara-sa.net/api/v1/deploy?uuid=<app-uuid>&force=false"
```

App UUIDs: `dara-api` = `c7uop7f14t07mtrsn5060uoj`,
`dara-web` = `q3orrxshi028shi2eo6i79tg`.

**There is a staging pair now** — four apps, not two. `main` deploys
production, `master` deploys staging (both branches are kept identical):

| app | uuid | domain | database |
|---|---|---|---|
| `dara-api` | `c7uop7f14t07mtrsn5060uoj` | `api.dara-sa.net` | `postgres` on `qsihs45oexmpmiy7m237kict` |
| `dara-api-staging` | `rg2fzzvc8wnxd8njnyi1bqxu` | `api-staging.dara-sa.net` | `dara` on `d449y09yue9iiqkxfjmb9ymf` |
| `dara-web` | `q3orrxshi028shi2eo6i79tg` | `dara-sa.net`, `app.dara-sa.net` | — |
| `dara-web-staging` | `w1483fpizyf29c7dkzs5d1wf` | `staging.dara-sa.net`, `app-staging.dara-sa.net` | — |

**Two Postgres containers.** `qsihs45…` holds production; `d449y09…` is
staging and looks plausibly real (users, payments, contracts), so it is easy
to debug the wrong database for twenty minutes. Confirm which one an app uses
before believing a query: `docker exec <app> sh -lc 'echo $DATABASE_URL'`.

**Staging hostnames are single-label on purpose.** Cloudflare Universal SSL
covers `dara-sa.net` and `*.dara-sa.net`, and a wildcard matches exactly ONE
label — so `app.staging.dara-sa.net` has no certificate and the browser fails
the handshake (`ERR_SSL_VERSION_OR_CIPHER_MISMATCH`) without ever reaching
Coolify. It looks like a Coolify problem and is not one. Hence
`app-staging.dara-sa.net`, not `app.staging.…`. Multi-level wildcards need
Cloudflare Advanced Certificate Manager (paid). `dara-web/src/lib/portal-host.ts`
encodes the landing↔portal mapping so the middleware can never mint a host the
certificate cannot cover — it previously prefixed a literal `app.` and
redirected staging to `app.app-staging.dara-sa.net`.

**Why not the GitHub App:** the App `mlika-abdulsalam` (app_id 3660668,
installation 130992358) stopped delivering push events after 07 Aug, leaving a
week of commits undeployed.

- Repo-level webhooks **cannot** substitute. Tried: they return HTTP 200 but
  Coolify queues nothing, because a repo webhook payload has no `installation`
  object so a GithubApp-sourced application never matches. Don't retry this.
- **No personal access token can manage a GitHub App** — `/user/installations`
  returns 403 even for a classic PAT with full admin scopes. Repairing the App's
  webhook URL is browser-only, by the App owner, at `github.com/settings/apps/`
  → `https://coolify.dara-sa.net/webhooks/source/github/events`. Worth doing
  eventually, but the Actions workflow makes it non-blocking.

Deploy `dara-api` before `dara-web` when web changes depend on new API fields.

**The API `.env` `DATABASE_URL` points at production.** Running the API locally
with default env writes to the live database. Override `DATABASE_URL` *and*
`API_PORT` inline (`API_PORT` wins over `PORT`); do not rely on sourcing an env
file — a parse error mid-file silently leaves the old values and the app
happily connects to production.

---

## 2. Ejar (NHC) integration — verified behaviour

Six whitelisted endpoints in two groups, each keyed by exactly one identifier:

| group | endpoints | required |
|---|---|---|
| `/v1/ejarext/*` | GetRentalContracts, GetProperties, GetUnits | `id_number` |
| `/v1/ejar/*` | NationalAddress, RentalContractInvoices, RentalFinancialData | `contractNumber` |

**Tested live against UAT from the server:**

- `GetRentalContracts` honours **only** `id_number`. `contract_number` is
  **silently ignored** — passing it returns the entire 12,460-row dataset,
  byte-identical to an unfiltered call, HTTP 200, no warning. Combining
  CR + contract number does **not** work; the combined query returns exactly
  the same rows as `id_number` alone.
- `skip_filter_id_number=true` disables Ejar's own scoping. Alone it returns
  everything.
- `property_ids` on `GetProperties` **is** honoured (filtering by one id
  returns exactly that one).
- `RefId: 1` header is mandatory and undocumented. `/v1/ejarext/*` also needs
  `CallerReqTime`. A default undici User-Agent can trip Cloudflare with 403.
- Credentials live only in the API container's env; `EJAR_BASE_URL` is guarded
  against pointing at the production NHC gateway.

To probe Ejar, run a Node script **inside the API container** (it holds the
credentials and the allow-listed IP). `curl` is not installed there, and
`node /dev/stdin` fails on a piped fd — base64 the script to a file first.

**Scoping:** tenant-package accounts are locked to their own CR
(`ejar.scope.ts`) at `/contracts`, `/preview` **and** `/call`. `/call` is a
generic passthrough and is the obvious way around the other two — never add a
new Ejar route without applying the scope. It fails closed when no CR is on
file; degrading to an unscoped search is the thing it exists to prevent.

**Ejar field locks** (`ejar.locks.ts`) are **advisory only** — computed by one
GET endpoint so the UI can render fields read-only. There is no write-side
rejection. Phone and email are deliberately exempt (contact details go stale);
identity fields — name, ID/CR, tax number — stay locked.

Ejar and bulk import **insert rows directly**, bypassing the controllers. New
controller-level validation therefore does not affect imports — which is
usually what you want, but check before assuming a rule is universal.

---

## 2b. ZATCA (Fatoora) — which environment we are actually in

**Production has never submitted a real e-invoice.** Audited against the
production database on 25 Aug 2026:

| | |
|---|---|
| VAT-registered landlords | 22 |
| …with any `zatca_credentials` row | 7 |
| …actually on `active_environment = 'production'` | **1** |
| …still on `sandbox` (with sandbox certs) | 6 |
| e-invoices ever submitted | 7 — **all** `environment = 'sandbox'` |
| e-invoices submitted to production | **0** |

The six sandbox rows are internally consistent — sandbox env, sandbox cert — so
they look fine in isolation. They are not: those landlords are live in the
product and every invoice they approve goes to the **developer portal**, which
means that to ZATCA the invoice does not exist. Consistency is not correctness,
and this is the trap to check for first. Each needs real production onboarding
with its own OTP, generated by that taxpayer in the Fatoora portal.

The remaining 15 VAT-registered landlords have no credentials row at all, so
their invoices skip submission entirely (`not_linked`).

**`active_environment` must always name a slot that HAS credentials.** It is
the only thing `isOnboarded()` (`common/invoice-readiness.ts`) and
`submitZatca()` read to pick which certificate columns to use, and neither
falls back. On 25 Aug 2026 the first real production onboarding (owner 264)
produced a row with a complete production CSID, `prod_slot_env = 'production'`
— and `active_environment` still `'sandbox'`, whose columns were empty:
`isOnboarded()` returned false, the readiness gate refused **every** invoice
that landlord tried to issue, and a valid production certificate sat unused in
the next column. `saveProfile` hardcodes `'sandbox'` on insert; issuing the
production CSID now moves the pointer, because the only other writer —
`switchEnvironment()` — is absent from the production UI *and* refuses to flip
to production until a test cycle the blocked seller cannot run. A dead end with
no way out of it from the app.

Simulation deliberately does **not** move the pointer: it fills the same
`prod_*` columns, and a record marked live while holding a simulation
certificate signs every real invoice with something `/core` rejects.

`seller_id_scheme` is per-INVOICE (`PartyIdentification/@schemeID`), not baked
into the CSR — so it can be corrected on a live seller without re-onboarding.
An individual landlord is `NAT` (national ID) or `IQA` (iqama), never `CRN`.

The three environments differ by URL prefix *and* by CSR certificate template
(`zatca-api.service.ts` + `csr.service.ts`), and both must match or onboarding
fails in ways that look like a credential problem:

| env | path prefix | CSR template | OTP |
|---|---|---|---|
| sandbox | `/e-invoicing/developer-portal` | `TSTZATCA-Code-Signing` | fixed `123456` |
| simulation | `/e-invoicing/simulation` | `PREZATCA-Code-Signing` | from Fatoora simulation portal |
| production | `/e-invoicing/core` | `ZATCA-Code-Signing` | issued per taxpayer, out of band |

Going live is **not** a config flip. Per ZATCA's own guidance each seller has
to: onboard against simulation, pass the compliance cycle (3+ invoices of each
type: standard, simplified, credit, debit) on that compliance CSID, then
request a production CSID with an OTP the taxpayer generates in the Fatoora
portal. That OTP cannot be automated — it belongs to the taxpayer, per VAT
number. Only then does `activeEnvironment` move to `production`.

Also: e-invoicing only applies to VAT-registered sellers, and the billing
module deliberately skips documents whose lines are all exempt/out-of-scope
(residential rent) — a skipped submission there is correct behaviour, not a
broken integration. In production 12 of 19 VAT-registered landlords have no
credentials row at all, so their invoices skip with `not_linked`.

### 2b-i. ZATCA onboarding flow, the B2C signing wall, and how to test it

Hard-won from a full production debugging run for owner 264 (ابراهيم العقيل,
user 47, VAT 310404305800003). Read this before touching ZATCA onboarding.

**The correct onboarding sequence (what ZATCA requires):**
1. `saveProfile` — seller profile (name, VAT, CRN/ID, national address, EGS
   serial `1-Dara|2-PMS|3-<ownerId>`, invoiceType).
2. `issueComplianceCsid(env, otp)` — CSR + OTP → a COMPLIANCE CSID. On
   production the OTP is generated by the taxpayer in the Fatoora portal, is
   single-use, and expires in ~1h. Stored in the prod_* columns for env=production
   (prodSlotEnv="production"); issueComplianceCsid now also sets
   active_environment to the env so the suite below can read this CSID.
3. **compliance suite** — sign + submit ALL doc types the CSR declared, to
   `/core/compliance/invoices`, and they must ALL pass. This step was MISSING
   and is the whole saga below.
4. `issueProductionCsid` — exchanges the compliance CSID for the PRODUCTION
   CSID at `/core/production/csids`. ZATCA refuses (`Missing-ComplianceSteps`)
   unless step 3 passed for every declared type. Issuing it OVERWRITES the
   prod_* columns (the compliance CSID is gone) and sets active_environment
   "production". The EGS device then appears in Fatoora.

**invoiceType decides how many docs step 3 needs.** `1100` = standard(B2B) +
simplified(B2C) → all 6 (invoice/credit/debit × both). `1000` = standard only →
3 docs. A B2B-only landlord (VAT-registered tenant) can onboard as `1000` and
skip B2C entirely.

**Fixes shipped (production, in order): c5b6669** run the suite before the
production CSID; **a1f0966** correct SignedProperties attribute order + count
"already completed" as a pass. (7240fc2 was a wrong C14N attempt, superseded by
a1f0966.) The onboarding UI (ZatcaIntegrationView.submit) still calls
doOnboard → promoteToProduction; the suite now runs server-side inside
`POST /zatca/onboarding/production`.

**The B2C wall — closed (28 Aug 2026).** It was never a ZATCA quirk. Three of
our signing recipes were wrong, and the reporting endpoint was the only caller
strict enough to notice — clearance re-stamps a standard invoice and never
checks ours, which is exactly why only B2C failed.

Settled against ZATCA's OWN published signed sample rather than by argument:
`Data/Samples/Simplified/Invoice/Simplified_Invoice.xml` in the e-invoicing SDK
(mirrored at `mrsool/zatca`, `einvoicing-sdk/`). Its numbers are reproducible
offline and now pinned in `invoice-signer.service.spec.ts`:

| recipe | what we did | what ZATCA's sample proves |
|---|---|---|
| SignedProperties digest | `sha256 → base64` (44 chars) | `sha256 → hex text → base64` (88 chars) — the same encoding the cert hash already used |
| `ds:SignatureValue` | signed the C14N `SignedInfo` (plain XMLDSig) | signs the **invoice hash bytes**; the sample verifies against those and not against SignedInfo |
| `X509IssuerName` | `CN=…,DC=…` | `CN=…, DC=…` — RDNs joined with `", "`, and the issuer is one of the four values the digest is built from |

The wrong stamp also went into QR tag 7, so the QR was wrong on every B2C
invoice we ever signed.

Two more things the sample settles, both of which we already had right:
the invoice hash (XSL strip → `--c14n11` → sha256 reproduces its DigestValue
byte-for-byte) and the SignedProperties indentation (36/40/44/48/52 spaces,
closing tag at 32). **ZATCA does not canonicalize SignedProperties** — a real
exclusive-C14N differs from the string it hashed by exactly one thing, `<a/>`
expanded to `<a></a>`, so it rebuilds the element from a fixed template.
Indentation and the `", "` in the issuer are therefore load-bearing bytes, not
formatting. The element goes INTO the document without namespace declarations
(both prefixes are already in scope) and is hashed WITH them.

Result on production, owner 264, 28 Aug 2026: **6/6**. The three simplified
documents report REPORTED; the three standard ones return `NOT_CLEARED` with no
errors, which is what the compliance endpoint says for a document it validated
but was never asked to clear.

**Owner 264 is now live.** The production CSID was issued straight after
(`/core/production/csids`, HTTP 200) — which is the only proof that matters,
because ZATCA answers `Missing-ComplianceSteps` unless it has all six on
record. The stored certificate is issued by `CN=PRZEINVOICESCA1-CA` (the
production CA; the test one is `TSZEINVOICE-SubCA-1`) and runs to 26 Aug 2031.
`active_environment` and `prod_slot_env` are both `production`.

**The certificate subject is double-encoded** — `ابراهيم العقيل` appears as
`Ø§Ø¨Ø±Ø§Ù‡ÙŠÙ……`. The CSR config has no `utf8 = yes`, so openssl reads
already-UTF-8 Arabic as Latin-1 and re-encodes it. Harmless for invoices (the
seller name on the document comes from the XML, not the certificate) and not
worth a re-onboard, which would cost a fresh taxpayer OTP — but fix
`ZATCA_CSR_TEMPLATE` before onboarding the remaining 21 sellers.

**How to test all 6 on production WITHOUT a new OTP or creating invoices.**
The compliance suite persists nothing and simplified is re-runnable; standard,
once passed, returns "already completed" (now counted as a pass). Owner 264
already holds a compliance CSID (prod_compliance_request_id 1787837521875,
active_environment=production). To run the suite + attempt promotion:
1. Mint a 5-min JWT INSIDE the API container (secret never leaves it):
   `ssh dara-server 'n=$(sudo -n docker ps --format "{{.Names}}"|grep ^c7uop|head -1); sudo -n docker exec "$n" sh -lc "cd /app && node -e \"const p=require(\\\"/app/node_modules/.pnpm/jsonwebtoken@9.0.3/node_modules/jsonwebtoken\\\");console.log(p.sign({id:47,email:\\\"alageel2006@hotmail.com\\\",role:\\\"user\\\",kind:\\\"user\\\",tv:0},process.env.JWT_SECRET,{expiresIn:\\\"5m\\\"}))\""'`
2. `POST https://api.dara-sa.net/api/zatca/onboarding/production {"source":"production","ownerId":264}` with that Bearer token. Returns the per-doc suite result; issues the production CSID if all 6 pass.
   Add `"dryRun":true` to get the six verdicts and stop there — no promotion,
   nothing spent. Inside the container the API listens on **4000**, not 3000,
   and there is no `curl` in the image; use `node -` with `fetch`.
   (The public `/zatca/compliance-suite` is guarded off for a "live-looking"
   record — 409 — so use the onboarding endpoint, which passes skipLiveGuard.)
A temporary `debug-sign` endpoint that returns the signed XML was added then
reverted (commit 9629227 + its revert) — re-add it on a branch to capture the
signed simplified XML for analysis; it reads getActiveCredentials, so set
active_environment to the slot holding the compliance CSID first.

**Do NOT trust `docker ps` image tags alone.** Coolify repeatedly left a STALE
old container running beside the new one on `dara-api-staging` (and once on
`dara-web`), so Traefik load-balanced between builds and a fix "didn't take" for
half the requests. Always confirm by BEHAVIOUR, and stop the stale container:
`sudo -n docker ps --format '{{.Names}}\t{{.Image}}'|grep <uuid>` → `docker stop <old>`.

**seller_id_scheme = OTH is correct** for a national ID. ZATCA's only valid
schemes are CRN, MOM, MLS, SAG, OTH, 700 (verified against its validator). NAT
and IQA are NOT valid — they were briefly added to the UI and removed (859d2a7).

**Onboarding is not logged on production.** The compliance-check logging fix
(534cfc0) is on master/staging only. Cherry-pick it if you need the endpoint
responses server-side; otherwise read the HTTP response the call returns.

## 3. Packages, roles and account classification

- Packages: `tenant`, `basic`, `advanced` (legacy), `professional`,
  `enterprise`. Two modes: `tenant` (self-tracker) and `landlord` (full portal).
- **A package is a quota, not a different product.** The tenant plan used to get
  a whitelist of tabs (`TENANT_TABS`) and a two-step getting-started list; both
  are gone — every plan opens the same portal, and only the limits differ
  (tenant is 50 units / 3 seats). `mode` still shapes *content* (the dashboard
  widget, who the contract wizard treats as the account holder), not access.
- **Admin approval grants the package it displays.** `PATCH
  /admin/registrations/:id/approve` 400s on an unknown plan key rather than
  falling back to `basic` — it used to accept the legacy `broker` a fresh row
  carries, fail `isPackagePlan`, and silently grant something else. Approval
  without a grant leaves `pending_payment`, and then **the plan the user PAYS
  for wins**; `trialDays` / `grantWithoutPayment` / `subscriptionEndsAt` grant
  the chosen plan outright and clear the user's `desired*` selection.
  `users.subscription_is_trial` marks a granted window as a trial and is
  cleared by any real payment.
- **`tenant` is company-only** (`PackageDef.requiresUserType`). Enforced on all
  three paths that write `users.package_plan`: self-registration, admin
  approval, admin package change. Fails closed on a missing account type.
- A company registration creates a `companies` row and links `users.company_id`.
  The registrant **is** the General Manager — they get the `general` role (43
  permissions vs `user`'s 40). There is no separate employee row; employees are
  `users` rows and email is unique, so a second row would need a second email.
- **Account classification is by topology, not role key.** `isCustomerAccount()`
  = no owner above it, and not staff. The old `roleKey === "user"` test broke
  the moment a company owner held the `general` role — such an account vanished
  from the admin's registrations list and could never be approved. Four call
  sites in `admin.module.ts` depend on this.
- Permissions resolve **only** from `roles.permissions`, joined at request time.
  Changing a user's permissions means changing their role.
- `listEmployees` includes the account holder, flagged `isOwner`. Owner-first
  ordering is done in JS: the owner's `ownerUserId` is NULL and Postgres sorts
  NULLs last. The employee quota counts `ownerUserId = owner` separately, so the
  owner is not billed against `maxUsers`.

---

## 4. Money, VAT and installment status

- **Rent VAT is decided by usage, not by the client.** Residential is exempt,
  everything else taxable — expressed as an allowlist of residential usages so a
  new usage defaults to **taxable**. Under-charging VAT is a liability;
  over-charging is visible and gets corrected. Mirrored in
  `dara-api/src/common/usage-vat.ts` and `dara-web/src/lib/usage-vat.ts`.
- A `mixed` (سكني - تجاري) property resolves VAT from the **unit's** usage. Units
  on mixed properties must declare one; elsewhere `NULL` means "inherit".
- **Nothing ever writes `payments.status = 'overdue'`.** It is derived from the
  due date at read time — `common/payment-status.ts`, a TS helper plus a
  matching SQL expression. Use `liveStatusSql` for filtering and aggregating;
  filtering the stored column is how the "متأخرة" tab ended up permanently
  empty while the summary card above it counted correctly. Both resolve "today"
  in **Asia/Riyadh**, not UTC.

### Moyasar webhooks

`secret_token` from the Moyasar dashboard must equal `MOYASAR_WEBHOOK_SECRET`
in the API container **exactly**. When it does not, the guard returns before any
database work and the subscription never activates. Nothing looks wrong from
Moyasar's side: the response is a 2xx, so its dashboard records "delivered
successfully".

Subscriptions still activate, which hides this — `POST /me/subscription/pay`
re-checks the invoice and self-heals a paid one. The tell is timing and a NULL
column: activation lags payment by however long the user took to return to the
billing page, and `subscription_payments.moyasar_payment_id` stays NULL because
only the webhook path passes it. A user who pays and closes the tab is never
activated at all.

Staging and production share one Moyasar account (same `MOYASAR_SECRET_KEY`).
The webhook looks up `metadata.subscriptionPaymentId` **by primary key with no
user scoping**, so a staging payment can activate an unrelated production
account. Scope that lookup before relying on staging for payment testing.

---

## 4b. SMS — Taqnyat, and why the OTP lifecycle is ours

**The SMS provider is Taqnyat (taqnyat.sa), not Twilio.** Twilio Verify was a
verification *service* (it generated, expired and checked codes for us);
Taqnyat is a plain gateway that sends text. So the code lifecycle now lives in
`PhoneOtpService` + the `phone_otp_tokens` table: 4 digits, bcrypt hash only,
10-minute expiry, 5 attempts then the row is burned, single use, 60-second
resend cooldown enforced in the DB, and the code is bound to
(phone, purpose) so a tenant's code cannot be replayed against the landlord
login. Same hardening as the email OTP, deliberately — these are the product's
only two login paths.

Env on the API: `TAQNYAT_API_KEY` + `TAQNYAT_SENDER`. It **fails closed** —
without both, phone login 503s rather than falling back to anything, so set
the env BEFORE deploying a container that expects it.

Gotchas that cost real time:

- Recipients must be `9665XXXXXXXX` — **no `+`, no `00`**, the opposite of what
  Twilio wanted. A wrong shape is a 400 or a silent `rejected: [...]` inside a
  2xx, so `TaqnyatService.send` treats a non-empty `rejected` as a failure.
- `sender` must be a name already approved on the account and is
  **case-sensitive**. We use `DaamTech`, NOT `DaamTech-AD` — the `-AD` suffix
  marks an advertising sender under CITC rules and OTP is transactional.
- An expired account, an empty balance and an unapproved sender name all look
  identical from the app ("the code never arrived"). `GET /api/admin/sms/status`
  answers all three without sending anything.
- Their `/verify.php` API would have been a smaller change but answers
  "number already verified" (19) / "already activated" (13) — states designed
  for one-time activation, not a login people repeat daily. Don't reach for it.
- Arabic is UCS-2, so ~70 chars per segment. The OTP body is one segment
  (0.092 SAR); lengthen it and every login costs double.

### The QA login bypasses, and the only honest staging signal

`TWILIO_DEV_BYPASS` (legacy name; `SMS_DEV_BYPASS` is the current one) is
**"true" on both staging apps and "false" on production**, which makes it the
one env var that actually distinguishes the two. Nothing else does: `APP_ENV`
is literally `staging` on the production containers and `NODE_ENV` is
`production` on all four, so any code that tries to infer the environment
infers it wrong. When something must be staging-only on the API, hang it off
this flag and let it **fail closed**.

Armed, it accepts fixed codes for a real login and sends nothing: `1234` for
the phone OTP, `111111` for the email OTP. That is a full authentication
bypass, which is why it is env-driven.

It has burned us once already: the email-OTP path had `code === "111111"`
hardcoded with no flag at all, under a `TODO: remove before production` that
was never actioned — so for as long as it was deployed, **every account on the
live API could be entered with a six-character constant**. Fixed by routing it
through `src/common/qa-bypass.ts`. Do not reintroduce a code-level bypass; the
flag exists precisely so nobody has to remember to flip one back.

## 5. Fonts and Arabic typography

Readex Pro carries Arabic and Latin. `dara-web/scripts/patch_font_metrics.py`
rewrites its vertical metrics and **must be re-run if the font is replaced**.

- The shipped font declares descent −250 while Arabic ي reaches −499, so
  anything clipping at the line box cut the bottoms off ي ج ح خ (`تجاري`
  rendered as `تجارى`).
- Metrics are derived from the **repertoire the product renders** — Arabic,
  presentation forms, Latin-1, punctuation, currency — deliberately excluding
  Latin Extended Additional. Taking them from every glyph in the font yields
  1157/−555, driven by ~60 glyphs that never render, and inflates the line box
  to 1.71em.
- Current: uniform **1080/−520 = 1.600 em** across all weights, so mixed-weight
  text shares a baseline grid.
- **CSS overflows its line box; React Native does not.** RN maps `lineHeight`
  onto NSParagraphStyle and iOS *trims the glyph, from the top*, when the font's
  box is taller. Mobile line heights are therefore derived from `LINE_BOX_EM`
  (`dara-mobile/src/theme`), never hand-tuned, and the Heading components
  compute line height from whatever `fontSize` actually applies — call sites
  override the size inline and used to keep the old size's line height.
- Fonts are bundled into the binary: a font change needs a **new mobile build**.
- The web font exists **twice**: `src/fonts` for next/font (hashed, app-only)
  and `public/fonts` for the invoice PDF export, which cannot use a hashed URL.
  `patch_font_metrics.py` lists both — patch one and the printed documents
  regress to stock metrics (clipped Arabic descenders) with nothing wrong on
  screen to show it.

---

## 6. Invoice / voucher PDFs

Rendered client-side: the document HTML (`lib/export-invoice.ts`) is written
into a detached iframe, rasterized by html2canvas-pro and wrapped by jsPDF. No
server Chromium. Two failure modes, both of which produce *plausible-looking*
Arabic rather than an obvious error:

- **html2canvas does not rasterize where the element lives.** It clones the
  subtree into a sandbox parented to the HOST document and measures text there.
  The iframe names `'Readex Pro'`; the host page loads that same file under
  next/font's *hashed* family, so the literal name resolves to nothing in the
  host. It then measures Tahoma and paints Readex, and every word lands at a
  slightly wrong offset — real spaces collapse (`فاتورةإلى`) and phantom ones
  open inside Latin runs (`a.alsbr406 @gmail .com`). It reads exactly like a
  bidi or shaping bug and is neither. `ensureHostFontLoaded()` declares the
  face in the host document; it must run **before** html2canvas.
- **`foreignObjectRendering: true` is worse, not better** — it drops most of
  the document. Do not reach for it.

Also: `letter-spacing` on Arabic makes html2canvas fall back to per-character
rendering (isolated forms at mismatched advances), which is why
`latinOnlyTracking` is empty in RTL. Wrap user-supplied values in `<bdi>` —
names, addresses, phones, emails, VAT ids — or the surrounding Arabic reorders
their punctuation.

Two entry points share all of this: the modal's download button and
`use-invoice-pdf.ts` (auto-store on approve / voucher create).

**The render is cached per open document and the mobile upload is
fire-and-forget.** Download used to rebuild the page from scratch on every
click — rasterize, JPEG-encode, upload to MinIO, PATCH the key — and hand the
file over only after both round trips. Measured on staging: 2169 ms cold,
~115 ms once cached; a confirmed document pre-renders on open, so the first
click is ~123 ms. The cache key is every input the page can change under
(status, credit notes, the signed QR, language, and the queries that may not
have resolved at first render — the logo especially). Speed must never serve a
PDF that disagrees with the screen.

**PDF/A-3 buyer copy** — `GET /simple-invoices/:id/pdfa3` (`PdfA3Service`).
ZATCA lets the e-invoice be shared as XML **or** PDF/A-3 carrying that XML, and
this builds the second form by wrapping the already-stored PDF: attachment as
`/AF` with `AFRelationship /Alternative`, an sRGB OutputIntent (sRGB-v2-micro,
CC0, 456 bytes, inlined), XMP claiming PDF/A-3B, and a trailer `/ID`. **No
Chromium** — it wraps rather than renders, which is why it runs in the API
image as it stands. The XML is embedded verbatim: it is the stamped document,
and a changed byte no longer matches what ZATCA cleared.

Two things measured rather than assumed, both of which contradicted a
confident guess:

- **The `/ID` is load-bearing.** PDF/A clause 6.1.3 wants a file identifier.
  jsPDF writes one, so the current renderer passed *by luck*; pdf-lib adds none.
- **Stripping jsPDF's 14 unembedded standard-font dicts is NOT.** veraPDF passes
  either way — embedding rules bind fonts actually used for rendering — and
  stripping them corrupts any PDF whose content stream draws text. Removed.

`.github/workflows/pdfa3.yml` runs veraPDF over a freshly built file on every
change, against `dist/`. It also asserts the UNWRAPPED source still FAILS: a
broken validator install would otherwise leave a green tick that can never go
red. The XMP claims PDF/A-3B to whoever receives the invoice; the gate is what
makes that claim true rather than aspirational.

---

## 7. Repo-specific gotchas

**dara-web**
- Tailwind v4. `@theme inline` substitutes values, it does **not** emit
  variables. Brand colours are applied by retuning the ramps (blue-600 = Royal,
  indigo-600 = Cobalt) rather than editing thousands of colour classes.
- The fetch client throws `ApiError` with the reason in `.message`. Use
  `apiErrorMessage(err, fallback)` — **never** `err.response.data.error`, an
  axios shape this app never produces (it silently swallowed the real
  registration error for months).
- shadcn primitives ship LTR-hardcoded. Prefer logical utilities (`text-start`,
  `end-4`, `gap-*`); Tailwind's `space-x-*` emits a physical `margin-left` that
  does not flip in RTL.
- App Router: `_`-prefixed folders are non-routable; `styled-jsx` breaks
  page-data collection.
- `tsc --noEmit` has a **7-error baseline** (NewContractModal, PropertyUnitsModal,
  api/core.ts). Compare against 7, not 0.
- The account's own landlord/tenant record is the row flagged
  `is_account_holder` — **never** `owners[0]` and never `is_default`. Ejar
  imports insert a party row per imported contract and the list endpoints
  return newest-first, so `[0]` is usually an imported stranger; `is_default`
  means "new properties auto-link here" and the user can move it anywhere.
- Manual record creation is gated by `ManualAddGate` — off unless Ejar is down
  or an admin forces it on. `TENANT_TABS` in `DashboardPage.tsx` whitelists
  which tabs a tenant-package account may open; anything missing silently
  redirects to the dashboard.

**dara-api**
- See CLAUDE.md for the migration procedure (drizzle-kit migrate hangs).
- `ValidationPipe({ whitelist: true })` strips any property not on the DTO.
  Adding a field to a service signature without adding it to the DTO means it
  silently never arrives.
- `is_account_holder` (owners/tenants) is **server-owned**: deliberately absent
  from every controller field allowlist, claimable once on create while the
  account has none, and the row cannot be deleted. Keep it out of `FIELDS` —
  the whole point is that no request body can move the account's identity onto
  an Ejar-imported party.
- A PATCH whose keys all fall outside `FIELDS` used to reach `set({})` and
  crash the driver. Both owners and tenants now 400 instead; add the same guard
  to any new controller that builds an update from an allowlist.

**dara-mobile**
- Expo SDK 54, EAS builds. `appVersionSource: remote` — `autoIncrement` moves
  the **build number only**, never `CFBundleShortVersionString`. Bump the
  version by hand in `app.json`.
- **Check whether the current version is already released before building.**
  Apple closes a version's train once approved: `ITMS-90186` / `ITMS-90062`.
  `curl "https://itunes.apple.com/lookup?id=6778570855&country=sa"` shows the
  live version.
- EAS submissions are **server-side jobs**. Killing the CLI does not cancel
  them — check the submission record before retrying, or you queue duplicates
  that Apple rejects.
- App icon is generated by `scripts/generate_icon.py` from the same polygon
  geometry the web `Logo` draws. iOS output must be opaque RGB (no alpha, no
  pre-applied rounding).
- `react-native-maps` on iOS uses Apple Maps and needs no key. **Android needs
  `android.config.googleMaps.apiKey`** or the map renders blank.

---

## 8. Outstanding / flagged, not resolved

- Moyasar `secret_token` does not match `MOYASAR_WEBHOOK_SECRET` — every
  webhook is rejected and subscriptions activate only via the pay-endpoint
  fallback. Fix in Coolify (both API apps), then redeploy. See §1.
- The Moyasar webhook resolves `metadata.subscriptionPaymentId` by primary key
  with no user scoping, and staging shares the production Moyasar account.
- ~~`TWILIO_DEV_BYPASS=true` in production~~ — **resolved 20 Aug 2026.** The
  hardcoded "SMS paused / accept 1234" block in `auth.service.ts` is gone and
  phone OTP is live. The env flag is the only bypass: `false` on `dara-api`,
  `true` on `dara-api-staging` (QA, code `1234`). Never set it true in
  production — tenant and landlord phone login is a full login path, so a
  bypass there is an authentication bypass.
- **Import from Ejar is switched off in the product** and presented as
  paid-packages-only, behind `dara-web/src/lib/ejar-import-lock.ts`. The API's
  `/ejar/*` routes are untouched — the lock is presentational, so don't treat
  it as authorization.
- **Nationality (الجنسية) is lookup-backed on both parties.** `owners
  .nationality_lookup_id` (the text column was dropped in 0024) and, since
  0058, `tenants.nationality_lookup_id` alongside the legacy text. Clients send
  a human value under `nationality`; the controller resolves it, responses
  return the Arabic label. Ejar imports fill it from the payload, or infer
  "سعودي" from `id_type = national_id` — an iqama/passport says the holder is
  not Saudi but not what they are, so those stay null.
- The SSH private key and the Postgres password were both exposed in a chat
  transcript. **Rotate both.**
- `dara-api` is a **public** GitHub repo — confirm that is deliberate.
- Ejar `/preview` group-A endpoints (financials, invoices, national address) are
  keyed by contract number alone and have no scoping for **landlord-mode**
  accounts. Closed for tenant-package accounts only.
- VAT was applied to new contracts only; existing rows keep their stored
  `vatEnabled` because some have been reported to ZATCA.
- `APP_ENV=staging` is set on the **production** API and web apps too. Nothing
  in the code reads it (there is no `APP_ENV`/`NODE_ENV` branch anywhere in
  `dara-api`), so it is misleading rather than harmful — but it makes a
  container's env useless for telling prod from staging. Use `COOLIFY_FQDN` or
  `DATABASE_URL` instead.
- Coolify → Settings → Instance Domain is `https://coolify.dara-sa.net`; the
  legacy `*.oqudk.com` routers live in
  `/data/coolify/proxy/dynamic/dara-rebrand.yaml`, which Coolify does not manage.

- **ZATCA B2C (simplified) onboarding is fixed** (28 Aug 2026, `8891e1e`) —
  three signing recipes were wrong; owner 264 now passes 6/6 on production.
  See §2b-i for what they were and the sample that proves each one. Every
  simplified invoice signed before that commit carries a wrong QR tag 7 and a
  wrong SignedProperties digest, so anything already sent to sandbox is not a
  usable precedent. Owner 264 has since been promoted and holds a real
  PRODUCTION CSID.

### ZATCA — what "compliant" still needs (25 Aug 2026)

The mechanics are fixed and tested. Compliance is a separate claim and is **not
established**. Do not tell anyone it is until at least the first item is done.

1. **No invoice has ever cleared in production.** Zero rows in `invoices` with
   `environment = 'production'`. One real clearance is the gate on everything
   else here: it proves the submission path, and it produces the first genuine
   cleared XML. `ابراهيم العقيل` (owner 264) is currently the only account that
   can do it — and as of 28 Aug 2026 it now can: it passes the compliance suite
   6/6 and holds a production CSID (§2b-i). What is left is a real invoice
   through `/core`, which nothing has done yet.
2. **Six landlords are live on the sandbox** (see §2b). Their invoices are not
   e-invoices. Each needs production onboarding with its own Fatoora OTP.
3. **15 VAT-registered landlords have no credentials at all.**
4. **PDF/A-3 is staging-only.** `main` and `master` are diverged; production has
   neither the endpoint nor the button. It has only ever been validated against
   a **synthetic** cleared XML (staging `invoices` id 12, `is_demo = true`) —
   re-run veraPDF against a real clearance before promoting.
5. **The printed QR is only as good as the submission.** A cleared standard
   invoice shows ZATCA's stamped QR; anything unsubmitted falls back to a 5-tag
   Phase-1 QR that no verifier can check. That fallback is correct for drafts
   and exempt supplies and wrong to rely on for anything else.
6. ~~`seller_id_scheme` should be `NAT`~~ — **wrong, and left here because it
   was acted on.** `NAT` is not a scheme ZATCA accepts; `OTH` is correct for a
   national ID (see §2b-i, commit 859d2a7). Nothing to change on owner 264.
7. Beyond this repo entirely: onboarding every VAT-registered seller, reporting
   simplified invoices within 24h, and archiving. Those belong to a ZATCA
   advisor, not to the code.
