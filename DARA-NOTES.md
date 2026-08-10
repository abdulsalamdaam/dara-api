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

**Known broken (as of 2026-08-10):** auto-deploy stopped after 07 Aug. The apps
are sourced from the GitHub App `mlika-abdulsalam` (app_id 3660668,
installation 130992358), which is not delivering push events.

- Repo-level webhooks **cannot** substitute. Tried: they return HTTP 200 but
  Coolify queues nothing, because a repo webhook payload has no `installation`
  object so a GithubApp-sourced application never matches. Don't retry this.
- Coolify has **no API tokens** (`personal_access_tokens` is empty), so the
  deploy API is unavailable, and there is no `app:deploy` artisan command.
- Fix is browser-only, by the App owner, at `github.com/settings/apps/` →
  webhook URL `https://coolify.dara-sa.net/webhooks/source/github/events`,
  active, subscribed to Push, installed on both repos. A `gh` user token gets
  403 on App endpoints.

Until then the only route is the **Deploy** button in Coolify. Deploy
`dara-api` before `dara-web` when web changes depend on new API fields.

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

## 3. Packages, roles and account classification

- Packages: `tenant`, `basic`, `advanced` (legacy), `professional`,
  `enterprise`. Two modes: `tenant` (self-tracker) and `landlord` (full portal).
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

---

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

---

## 6. Repo-specific gotchas

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
- Manual record creation is gated by `ManualAddGate` — off unless Ejar is down
  or an admin forces it on. `TENANT_TABS` in `DashboardPage.tsx` whitelists
  which tabs a tenant-package account may open; anything missing silently
  redirects to the dashboard.

**dara-api**
- See CLAUDE.md for the migration procedure (drizzle-kit migrate hangs).
- `ValidationPipe({ whitelist: true })` strips any property not on the DTO.
  Adding a field to a service signature without adding it to the DTO means it
  silently never arrives.

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

## 7. Outstanding / flagged, not resolved

- `TWILIO_DEV_BYPASS=true` in production — the repo's own `coolify.md` says keep
  it `false`. Phone OTP verification is bypassed.
- The SSH private key and the Postgres password were both exposed in a chat
  transcript. **Rotate both.**
- `dara-api` is a **public** GitHub repo — confirm that is deliberate.
- Ejar `/preview` group-A endpoints (financials, invoices, national address) are
  keyed by contract number alone and have no scoping for **landlord-mode**
  accounts. Closed for tenant-package accounts only.
- VAT was applied to new contracts only; existing rows keep their stored
  `vatEnabled` because some have been reported to ZATCA.
- Coolify → Settings → Instance Domain is `https://coolify.dara-sa.net`; the
  legacy `*.oqudk.com` routers live in
  `/data/coolify/proxy/dynamic/dara-rebrand.yaml`, which Coolify does not manage.
