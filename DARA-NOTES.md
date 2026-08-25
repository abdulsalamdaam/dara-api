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

**Everything is sandbox. Production has never submitted a real e-invoice.**
Every row in `zatca_credentials` — production database included — has
`active_environment = 'sandbox'` and a NULL `prod_onboarded_at`, so every
submission goes to the developer-portal gateway with a test CSID. Verified
20 Aug 2026 against both databases.

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
