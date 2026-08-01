# ─── Builder ────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

# Install pnpm.
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Cache deps layer.
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod=false

# Build.
COPY . .
RUN pnpm build

# Strip dev deps for the runtime layer.
RUN pnpm prune --prod

# ─── Runtime ───────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# ZATCA e-invoicing shells out to these for CSR generation, the hash transform
# (XSLT) and C14N canonicalization. node:22-slim doesn't ship them.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl xsltproc libxml2-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/db/drizzle ./db/drizzle
COPY --from=builder /app/db/init.sql ./db/init.sql
COPY --from=builder /app/db/data.sql ./db/data.sql
COPY --from=builder /app/package.json ./package.json

EXPOSE 4000

# Neither container declared a healthcheck, so the proxy had no readiness
# signal and routed to the container the moment it started — before Nest was
# listening. That is the ~5s window at every deploy where requests (login
# included) came back 502/503. start-period covers ensureSchema + the module
# graph; the endpoint itself is a pure liveness probe with no DB dependency.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/main.js"]
