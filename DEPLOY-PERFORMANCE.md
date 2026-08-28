# Deploy performance — measured, and what to do about it

Measured on 28 Aug 2026 against the live Coolify instance. Every number here
came from `application_deployment_queues` logs or from the server itself; none
of it is estimated unless it says so.

## The box

2 vCPU, 7.9 GB RAM, 87 GB disk (61 GB free), 110 days uptime. It runs **four
apps, two Postgres containers and Coolify itself**. It is CPU-starved and
nothing else: disk reads at 262 MB/s with 61 GB free, RAM has headroom.

`concurrent_builds = 2` on 2 cores means two builds each get about one core.
Measured contention penalty: `next build` 146s alone → **209s** when another
build runs (+43%); `nest build` 41s → 57s (+39%).

## Where a deploy actually goes

`dara-web` production, deployment `4gpy3812srhzffiv0gpginue`, 512s total:

| phase | seconds | share |
|---|---|---|
| helper container, `git ls-remote` | 7.3 | 1.4% |
| git clone + prep | 12.1 | 2.4% |
| **docker build** | **463.8** | **90.5%** |
| ├─ `pnpm install` | 48.9 | |
| ├─ **`next build`** | **209.4** | **40.9%** |
| ├─ `pnpm prune` + snapshot | 53.2 | |
| ├─ runtime COPY | 21.4 | |
| └─ **image export + unpack** | **118.5** | **23.1%** |
| container start | 4.1 | 0.8% |
| health-check start-period sleep | 20.7 | 4.0% |
| old container removal | 4.4 | 0.9% |

Medians per app: **dara-web 502s (worst 874s)**, dara-web-staging 456s,
**dara-api 264s (worst 378s)**, dara-api-staging 214s.

## Causes, ranked by measured cost

### 1. Every push deployed twice — ~470s of pure queue wait ✅ FIXED

Coolify's GitHub App auto-deploy **and** `.github/workflows/deploy.yml` both
fired, 5–7 seconds apart, on every push. The second one builds nothing —
`No build configuration changed & image found with the same Git Commit SHA` —
it just waits out the first build (median **469s** for dara-web), then does a
redundant container swap. It also put four jobs into a two-slot queue on two
cores, which is what inflated the real builds by 39–43%.

**Done 28 Aug 2026:** `application_settings.is_auto_deploy_enabled = false` for
all four apps. The Actions workflow is now the only trigger — deliberately the
one that was kept, because it fails loudly. The GitHub App went silent once
before and left a week of commits undeployed with nothing to show for it.

To revert: set that column back to `true` (Coolify UI → app → Settings, or the
`application_settings` table).

### 2. `next build` from cold, every time — 146–209s, 41% of a web deploy

`COPY . .` precedes it, so no Docker layer cache can ever help. The fix is a
BuildKit cache mount so webpack/SWC state survives between builds:

```dockerfile
RUN --mount=type=cache,target=/app/.next/cache pnpm build
```

This also fixes #3 for free: a cache mount is unmounted before the layer is
committed, so `.next/cache` lands in the image empty.

### 3. `.next/cache` is baked into the image — hundreds of MB per deploy

`COPY --from=builder /app/.next ./.next` copies it wholesale. Locally that
directory is **1.5 GB** against 5.9 MB of `.next/server` and 5.3 MB of
`.next/static` — the only parts `next start` reads. It inflates the export, the
disk, and therefore the cleanup in #5.

### 4. Image export and unpack — 118.5s for web, 31.6s for api

74.0s exporting layers plus 43.8s unpacking into the containerd snapshotter, on
a **1.8 GB** image. The image is that big because the runtime stage carries the
whole pruned `node_modules` (~450–550 MB); `output: "standalone"` in
`next.config.mjs` would trace it down to 80–150 MB. dara-api's image is 534 MB
and exports in 31.6s, which is the shape to aim for.

Cheap wins in the same area: `react-icons` (83 MB) has **zero importers**, and
`date-fns` is installed twice (v3 36 MB + v4 38 MB) for a single file.

### 5. A daily cleanup wipes 100% of the BuildKit cache

`force_docker_cleanup = t`, `docker_cleanup_frequency = '0 0 * * *'`. Verified:
no build-cache record survives midnight UTC. The first builds of each day get
**0 CACHED steps** and pay +49s on `pnpm install` and +19s on `apt-get`. Worth
raising the cleanup threshold rather than running it unconditionally — the
server has 61 GB free and 12 GB reclaimable, so it is not disk pressure.

### 6. No pnpm store cache mount

`reused 0, downloaded 226` (web) / `554` (api) whenever the install layer
misses. Fix:

```dockerfile
ENV PNPM_HOME=/pnpm
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile
```

### 7. dara-api ignores SIGTERM — 34.5s of every API deploy

`docker stop` waits out the full 30s grace period, then SIGKILLs. Consistent on
every deploy, 14% of an API deploy. Nest needs `app.enableShutdownHooks()` and
a SIGTERM handler that closes the server.

### 8. The health check is a fixed sleep

`start-period` is 20s (web) / 30s (api) and Coolify sleeps all of it before the
first probe — which then passes in **0.39s**, on attempt 1 of 3, every time.
Lowering the start period is safe money.

## Expected result

Items 2, 4 and 6 together: **dara-web ~8min → ~2–3min**, **dara-api ~4.5min →
~1.5min**. Item 1 is already done and halves the number of deploys.

## Why there are always two containers

This one is **expected**, not a fault. Rolling updates start the new container,
wait for it to go healthy, then remove the old — a **25–65s** overlap on every
deploy. Every container for an app emits identical Traefik labels
(`traefik.http.services.https-0-<uuid>...`), so Traefik round-robins across all
of them: during the overlap, a fraction of requests genuinely hit the old build.

**The fault is when the overlap does not end.** Coolify's own cleanup sweep is
the only thing that removes the old container (it runs `docker compose up`
without `--remove-orphans`, and each deploy invents a new compose service name,
so the previous container is treated as an orphan and left running). On
28 Aug 2026, dara-web production:

```
00:02:26  new container (a4b7722) starts
00:03:48  "Removing container ... timed out after 60 seconds"
00:04:07  next deploy starts a THIRD container
00:04:29  "Could not remove old container: rw layer snapshot not found"
00:04:29  "Rolling update completed."     ← green, with 3 containers live
00:08:48  the old container finally dies
```

For five minutes `dara-sa.net` served commits `4bada9a` and `a4b7722`
simultaneously. Coolify logs that failure with `hidden: true` and still reports
the deploy successful — which is exactly how "the fix only worked for half the
requests" happens. Same warning on deploys 841 and 843 (20 Aug).

**So: always confirm a deploy by behaviour, never by the green tick.**

```bash
sudo -n docker ps --format '{{.Names}}\t{{.Status}}' | grep <uuid-prefix>
```

More than one row for an app, more than a minute after a deploy, means the
sweep failed. Stopping the older container by hand is safe.
