import { Injectable, type NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { clientIp, clientUserAgent } from "../client-ip";
import { runWithRequestContext, type RequestContext } from "../request-context";
import { AppLogService } from "./app-log.service";
import { logLine } from "./logger";

/**
 * Marks a response whose row has already been written by the exception filter.
 *
 * The filter's row is strictly richer — it carries the stack — so when a
 * request ends in an exception the middleware must not write a second, poorer
 * row describing the same event. A symbol rather than a property name so it
 * cannot collide with anything Express or a library puts on the response.
 */
export const PERSISTED = Symbol("dara.appLogPersisted");

/** A request id we were handed must be safe to echo in a header and store. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,120}$/;

/** Anything slower than this is worth keeping even when it succeeded. */
function slowRequestMs(): number {
  const raw = Number(process.env.SLOW_REQUEST_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3_000;
}

function persistEverything(): boolean {
  return String(process.env.APP_LOG_ALL_REQUESTS ?? "").trim().toLowerCase() === "true";
}

/**
 * **The DB-write policy.** stdout gets one line per request; this decides
 * which of those also becomes a row that outlives the container.
 *
 * A row per request would be tens of thousands a day to answer questions
 * nobody asks, so what is kept is what someone will come back to look for:
 *
 *  · every **5xx** — the thing this whole exercise exists for;
 *  · every **429** — a throttled customer reports "the app stopped working",
 *    and until now the rejection left no trace at all;
 *  · every request slower than `SLOW_REQUEST_MS` — a timeout is reported as a
 *    failure by the user and as a success by the server;
 *  · **401 and 403, but not 404 or 400.** 401/403 are the shape of a real
 *    complaint ("it says I'm not allowed") and of an attack, and both need the
 *    history. 404 and 400 are overwhelmingly bots probing paths and clients
 *    sending malformed queries — high volume, near-zero diagnostic value, and
 *    they would be most of the table. They still get their stdout line.
 *
 * `APP_LOG_ALL_REQUESTS=true` overrides all of it and persists everything, for
 * while we are actively chasing something. It is meant to be turned back off.
 */
export function shouldPersistRequest(status: number, durationMs: number): boolean {
  if (persistEverything()) return true;
  if (status >= 500) return true;
  if (status === 429 || status === 401 || status === 403) return true;
  if (durationMs >= slowRequestMs()) return true;
  return false;
}

@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  constructor(private readonly appLog: AppLogService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = String(req.headers["x-request-id"] ?? "").trim();
    // Honour a client-supplied id so a trace can be followed from the web app
    // into the API — but only when it is a shape we are willing to echo in a
    // response header and store in a column. Otherwise mint our own.
    const requestId = SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader("x-request-id", requestId);

    const startedAt = Date.now();
    // Path only. The query string carries e-mail verification tokens, reset
    // tokens and search terms; none of that belongs in a log that outlives the
    // request.
    const path = String(req.originalUrl ?? req.url ?? "").split("?")[0]!;
    const ip = clientIp(req);
    const userAgent = clientUserAgent(req);

    const ctx: RequestContext = {
      requestId,
      ip,
      userAgent,
      method: req.method,
      path,
      startedAt,
      // Live getters: middleware runs before the guards, so `req.user` does
      // not exist yet. Reading it lazily means a line logged after
      // authentication carries the user and one logged before it carries null,
      // rather than the whole context being useless until the guard finishes.
      get userId() {
        return (req as Request & { user?: { id?: number } }).user?.id ?? null;
      },
      get ownerUserId() {
        const u = (req as Request & { user?: { id?: number; ownerUserId?: number | null } }).user;
        return u?.ownerUserId ?? u?.id ?? null;
      },
    };

    runWithRequestContext(ctx, () => {
      res.on("finish", () => {
        const durationMs = Date.now() - startedAt;
        const status = res.statusCode;
        const level = status >= 500 ? "error" : status >= 400 ? "warn" : "log";

        // Exactly one stdout line per request, always — this is the access log
        // the API has never had.
        logLine(level, "Request", `${req.method} ${path} ${status} ${durationMs}ms`, {
          status,
          durationMs,
          event: "request",
        });

        if ((res as Response & { [PERSISTED]?: boolean })[PERSISTED]) return;
        if (!shouldPersistRequest(status, durationMs)) return;

        this.appLog.record({
          level,
          event: "request",
          requestId,
          method: req.method,
          path,
          status,
          durationMs,
          userId: ctx.userId,
          ownerUserId: ctx.ownerUserId,
          ip,
          userAgent,
          message: `${req.method} ${path} → ${status}`,
          context: "Request",
        });
      });
      next();
    });
  }
}
