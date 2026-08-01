# Deploying dara-api on Coolify

## Resource type
**Application → Dockerfile**. Source: this repo. Branch: `main`.

## Build
- **Dockerfile location**: `./Dockerfile`
- **Build context**: `.`
- No build command override needed; the Dockerfile handles it.

## Runtime
- **Port**: `4000` (exposed by the Dockerfile, mapped to whatever Coolify gives publicly).
- **Health check path**: `/api/healthz`
- **Health check expected**: `{"status":"ok"}`

## Environment variables
Required:
- `DATABASE_URL` — Postgres connection string. Coolify-managed DB or external.
- `JWT_SECRET` — `openssl rand -hex 64`
- `NODE_ENV=production`
- `API_PORT=4000`

Twilio (OTP):
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_VERIFY_SERVICE_SID`
- `TWILIO_VERIFY_CHANNEL=sms`
- `TWILIO_DEV_BYPASS=false` (keep `false` in production)

## Database migrations
Schema is managed by Drizzle. Two ways to apply:

1. **One-shot from your laptop** (with the production DATABASE_URL):
   ```bash
   DATABASE_URL='postgresql://...' pnpm db:push
   ```

2. **Coolify pre-deploy command** (Settings → "Pre-deployment Command"):
   ```bash
   pnpm db:push:force
   ```
   Note: this runs against the live DB on every deploy. Use with care.

## Post-deploy verification
```bash
curl https://api.dara-sa.net/api/healthz
# → {"status":"ok"}
```

## Ejar / NHC integration (this service is the whitelisted caller)
The "Add Contract using Ejar" feature lives here (`src/modules/ejar`). Outbound
NHC calls originate from this API container, so it must run on the server whose
IP NHC whitelisted. Set as **runtime** env vars (never committed):

- `EJAR_BASE_URL` = `https://integration-gw.housingapps.sa/nhc/uat` (prod is blocked in code)
- `EJAR_CLIENT_ID` = IBM gateway client id
- `EJAR_CLIENT_SECRET` = IBM gateway client secret

Verify after deploy (needs a user JWT): `GET /api/ejar/health` → `{ "ok": true }`.
The `contracts.ejar_source` column + `ejar_api_logs` table are created
automatically on boot (passive migration `db/sql/2026_07_ejar_integration.sql`).
