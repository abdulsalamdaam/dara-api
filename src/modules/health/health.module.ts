import { Controller, Get, Module, Res } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { pool } from "@dara/database";

/** How long the probe waits for `select 1` before calling the database down. */
const DB_PROBE_TIMEOUT_MS = 2_000;

/**
 * The commit this image was built from, when the platform tells us. Coolify
 * tags images with the SHA, so this is what turns "the fix didn't take" into a
 * one-request answer: `docker ps` image tags have repeatedly disagreed with
 * what is actually serving traffic (DARA-NOTES §2b-i).
 */
function version(): string {
  const raw = process.env.SOURCE_COMMIT || process.env.GIT_COMMIT || process.env.APP_VERSION || "";
  return raw ? raw.slice(0, 12) : "unknown";
}

@ApiTags("health")
@Controller()
class HealthController {
  /**
   * `GET /api/healthz` — a real check, not a hardcoded `ok`.
   *
   * It used to `return { status: "ok" }` unconditionally, which meant the
   * Docker healthcheck reported a container serving 500s off a dead pool as
   * healthy. The probe is one `select 1` with a short timeout: nothing else in
   * the API can work if that fails, so nothing else is worth probing.
   *
   * The success body is a superset of the old one, so the Dockerfile's
   * `r.ok ? 0 : 1` healthcheck is unaffected. The trade-off it introduces,
   * stated plainly: a database outage now makes the container report
   * unhealthy. Docker's HEALTHCHECK does not restart anything (that is a Swarm
   * behaviour), so the consequence is the proxy pulling a container that
   * genuinely cannot serve — which is the point — and the 30s `start-period`
   * still covers a slow database at boot.
   */
  @Get("healthz")
  async health(@Res({ passthrough: true }) res: Response) {
    const startedAt = Date.now();
    let dbUp = false;
    let dbError: string | null = null;

    try {
      await withTimeout(pool.query("select 1"), DB_PROBE_TIMEOUT_MS);
      dbUp = true;
    } catch (err) {
      dbError = (err as Error)?.message ?? String(err);
    }

    if (!dbUp) res.status(503);
    return {
      status: dbUp ? "ok" : "error",
      db: dbUp ? "up" : "down",
      dbLatencyMs: Date.now() - startedAt,
      ...(dbError ? { dbError } : {}),
      uptime: Math.round(process.uptime()),
      version: version(),
    };
  }
}

/**
 * A hung pool must not hang the probe: `pool.query` waits on
 * `connectionTimeoutMillis` (10s), which is longer than the healthcheck's own
 * 5s timeout — so without this the check fails by timing out rather than by
 * answering, and says nothing about why.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`db probe timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
