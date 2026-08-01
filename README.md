# dara-backend

Dara property-management API (NestJS 10 + Drizzle ORM + Postgres).

## Quick start

```bash
pnpm install
cp .env.example .env         # set DATABASE_URL, JWT_SECRET, Twilio creds
pnpm db:push                 # apply schema to the configured DATABASE_URL
pnpm dev                     # → http://localhost:4000/api/healthz
```

## Layout

- `src/`  — NestJS application
- `db/`   — Drizzle schema, migrations, seed scripts (inlined; was previously
  a `@dara/database` workspace package)

The compiled output uses `tsc-alias` to rewrite `@dara/database` imports to
relative paths, so source code keeps the original alias and runtime stays
plain Node `require`.

## Deploy

Single Dockerfile-based application on Coolify (or any container platform).
See `coolify.md` for env vars and the health check path.

## Companion web

Frontend lives in **dara-landing** (Next.js). Deploy this API first,
then point the web's `NEXT_PUBLIC_API_URL` at it.
