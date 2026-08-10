# Working agreement

## Autonomy
- Complete tasks end-to-end without asking for confirmation between steps.
- Do not summarize progress and wait — keep going until the work is done.
- Only stop if blocked by missing information that cannot be inferred; in
  that case, read the relevant files first and try to resolve it before asking.

# Project: Dara (دارا) — API

Saudi property-management SaaS. This repo is the **backend API**. It is one
of three repos:

- `dara-web` — Next.js landlord/admin portal + landing page.
- `dara-api` — this repo (NestJS + Drizzle + Postgres).
- `dara-mobile` — Expo app for tenants.

Brand is **Dara / دارا**. Folder names still say "milkia" (legacy).

## Stack
- NestJS 10, TypeScript.
- Drizzle ORM + PostgreSQL. The schema package is imported as
  `@dara/database` — a tsconfig `paths` alias to `db/src`, rewritten at
  build time by `tsc-alias`.
- Run: `pnpm dev`, `pnpm build`, `pnpm typecheck`.
- Global prefix `/api`. Swagger at `/api/docs`. Deployed via Coolify.

## Structure (`src/`)
- `main.ts` — bootstrap (global `/api` prefix, CORS, ValidationPipe, Swagger).
- `app.module.ts` — registers every feature module.
- `modules/<feature>/` — one folder per domain: contracts, properties, units,
  deeds, owners, tenants, payments, payment-confirmations, lookups, invoice,
  notifications, auth, etc. Each is a self-contained controller + `@Module`.
- `common/` — guards (`JwtAuthGuard`, `PermissionsGuard`), `scopeId`,
  decorators, the permissions list.
- `database/` — the Drizzle provider (`DRIZZLE` token, `db`).
- `db/src/schema/*.ts` — Drizzle tables. `db/drizzle/*.sql` + `meta/_journal.json`
  — hand-written migrations.

## Domain model
Hierarchy: **Deed → Property → Unit → Contract** (Landlord ↔ Tenant).
Data is scoped per landlord via `scopeId(user) = user.ownerUserId ?? user.id`.

## Conventions & gotchas
- **Migrations:** `drizzle-kit migrate` HANGS in this environment — the DB was
  set up via push. Apply new migrations by **running the SQL directly** with a
  `pg` Client: `node --env-file=.env -e "...readFileSync('./db/drizzle/NNNN.sql')...c.query(sql)..."`.
  The DB connects **without SSL** (`ssl: false`).
- After adding a migration, also add its entry to `db/drizzle/meta/_journal.json`.
- Controllers read the body as `@Body() body: any` — do NOT use undecorated
  DTO classes: the global `ValidationPipe({ whitelist: true })` strips every
  property off an undecorated DTO.
- Fixed, code-coupled sets stay as `pgEnum` (contract status, deed type,
  payment frequency). Extensible user-facing lists live in the `lookups` table.
- Commit style: conventional prefixes + a `Co-Authored-By` trailer; push to
  `origin/main`. The deployed build can lag — redeploy on Coolify after backend
  changes.

## Cross-repo notes
Read **`DARA-NOTES.md`** in this repo before non-trivial work. It is an
identical copy in all three Dara repos and covers what the code does not say:
how deployment actually works (pushing to `main` does NOT deploy), verified
Ejar API behaviour and its scoping rules, the package/role model and why
account classification is by topology rather than role key, VAT and derived
installment status, the Arabic font-metric fix, and per-repo gotchas including
the tsc baseline and the ValidationPipe whitelist.
