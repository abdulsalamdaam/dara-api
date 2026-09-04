import { ArgumentsHost, Catch, HttpException, Injectable } from "@nestjs/common";
import { BaseExceptionFilter, HttpAdapterHost } from "@nestjs/core";
import { ZodError } from "zod/v4";
import type { Request, Response } from "express";
import { zodErrorResponse } from "../zod-exception.filter";
import { currentRequestContext } from "../request-context";
import { AppLogService } from "./app-log.service";
import { logLine } from "./logger";
import { PERSISTED } from "./request-log.middleware";

/**
 * Catches everything, and changes nothing about what the client is told.
 *
 * Before this, an unhandled exception reached Nest's built-in handler, which
 * printed `exception.message` and a stack to stdout with no indication of
 * which request produced it, which user was making it, or what they had asked
 * for. That is the log we have been debugging from: a stack with no subject.
 *
 * Two rules this filter holds to, in order of importance:
 *
 *  1. **Every existing error path keeps its exact status and body.** A
 *     `HttpException` is replied to by `BaseExceptionFilter` — the same code
 *     that answered it before — and an unknown error still becomes
 *     `500 {"statusCode":500,"message":"Internal server error"}`. A `ZodError`
 *     still becomes the same 400 the `ZodExceptionFilter` produces; the two
 *     share `zodErrorResponse` so it cannot drift, and so it does not matter
 *     which of the two filters Nest reaches first.
 *  2. **Logging cannot fail the request.** `AppLogService.record` is
 *     fire-and-forget and swallows its own errors, and everything around it
 *     here is inside a try/catch — the response is sent regardless.
 *
 * Note that `super.catch` still emits Nest's own `ExceptionsHandler` line for
 * an unknown error. That is deliberate: nothing that used to print stops
 * printing, and it now prints through the structured logger like everything
 * else.
 */
@Injectable()
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly appLog: AppLogService;

  constructor(appLog: AppLogService, adapterHost: HttpAdapterHost) {
    // `BaseExceptionFilter` can resolve the adapter from its own optional
    // property injection, but only once the container has finished wiring it.
    // Handing it over explicitly removes the ordering question entirely — and
    // it still falls back to the injected host if this is somehow undefined.
    super(adapterHost?.httpAdapter);
    this.appLog = appLog;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.getType() === "http" ? host.switchToHttp() : null;
    const req = http?.getRequest<Request>();
    const res = http?.getResponse<Response>();
    const ctx = currentRequestContext();
    const path = ctx?.path ?? String(req?.originalUrl ?? req?.url ?? "").split("?")[0] ?? null;

    if (exception instanceof ZodError) {
      // Identical to what ZodExceptionFilter returns, by construction. Not
      // persisted: a rejected query string is a 400, and 400s are the noise
      // this table deliberately does not carry (see the middleware's policy).
      const { status, body, summary } = zodErrorResponse(exception);
      logLine("warn", "ZodExceptionFilter", summary, { status, path });
      if (res && !res.headersSent) res.status(status).json(body);
      return;
    }

    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const err = exception instanceof Error ? exception : null;
    const message = err?.message ?? String(exception);

    try {
      const durationMs = ctx ? Date.now() - ctx.startedAt : null;

      logLine(status >= 500 ? "error" : "warn", "Exception", message, {
        status,
        durationMs,
        event: "exception",
        stack: err?.stack ?? null,
      });

      // The one thing that must survive the container: what actually broke,
      // with enough context to find the customer and the request it belonged
      // to. 4xx below 500 is kept only where the middleware would keep it
      // anyway (401/403/429) — the rest is client noise.
      const persist = status >= 500 || status === 401 || status === 403 || status === 429;
      if (persist) {
        // Tell the middleware's `finish` handler not to write a second, poorer
        // row for the same request.
        if (res) (res as Response & { [PERSISTED]?: boolean })[PERSISTED] = true;
        this.appLog.record({
          level: status >= 500 ? "error" : "warn",
          event: "exception",
          status,
          durationMs,
          method: req?.method ?? null,
          path,
          message,
          context: err?.name ?? "Exception",
          error: exception,
          // The response body of an HttpException is often the only place the
          // real reason lives — `invoice_not_ready` carries its whole readiness
          // payload there. Redacted like everything else in `meta`.
          meta: exception instanceof HttpException ? { response: exception.getResponse() } : undefined,
        });
      }
    } catch {
      /* Logging must never be the reason a response is not sent. */
    }

    super.catch(exception, host);
  }
}
