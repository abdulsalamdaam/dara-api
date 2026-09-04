import { Injectable, ExecutionContext } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerRequest, type ThrottlerLimitDetail } from "@nestjs/throttler";
import type { Request } from "express";
import { clientIp } from "./client-ip";
import { appLog } from "./logging/app-log.service";

/**
 * Custom guard that, for OTP-style requests, also keys the rate limit by the
 * `phone` / `email` / `identifier` field in the body — so an attacker cannot
 * circumvent the per-IP limit by rotating IPs against the same target, and
 * cannot brute a single target by rotating IPs.
 *
 * Local-dev bypass: when OTP_DEV_BYPASS=true, the guard short-circuits and
 * skips the rate check entirely. Useful when iterating on the frontend OTP
 * flow without burning the 1/min limit on every reload. NEVER set this in
 * production.
 */
@Injectable()
export class OtpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    // `common/client-ip`, not `x-forwarded-for[0]`. Behind Cloudflare that
    // header names Cloudflare's own edge, so thousands of unrelated users
    // shared one bucket and the per-IP half of this limit did almost nothing.
    // It also refuses a value that is not an IP address, so a forged header
    // cannot put an arbitrary string into a bucket key.
    const ip = clientIp(req);
    const body = (req.body || {}) as { phone?: string; identifier?: string; email?: string };
    const target = (body.phone || body.identifier || body.email || "").toString().toLowerCase().replace(/[^\d+a-zA-Z@._-]/g, "");
    return target ? `${ip}|${target}` : ip;
  }

  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    if (process.env.OTP_DEV_BYPASS === "true") return true;
    return super.handleRequest(requestProps);
  }

  /**
   * A 429 used to be completely silent: the customer sees the app stop
   * working, support hears "it says too many requests", and there is nothing
   * anywhere saying who was limited, on what route, or how close to the limit
   * the traffic actually was. That is now a row.
   *
   * The write goes through the module-level `appLog()` accessor rather than a
   * constructor injection, because adding a fourth parameter to this class
   * means restating `ThrottlerGuard`'s own three (with the library's private
   * injection tokens) and re-checking them on every upgrade. A guard that
   * fails to construct takes the whole API down; a log line is not worth that
   * risk.
   */
  protected async throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    try {
      const req = context.switchToHttp().getRequest<Request>();
      appLog()?.record({
        level: "warn",
        event: "rate_limit_rejected",
        status: 429,
        method: req?.method ?? null,
        path: String(req?.originalUrl ?? req?.url ?? "").split("?")[0] || null,
        ip: clientIp(req),
        message: "request refused by the rate limiter",
        context: "OtpThrottlerGuard",
        meta: {
          // `tracker` is the bucket key — the IP, and for an OTP route the
          // e-mail or phone it was aimed at. That is the whole point of the
          // row: without the target you cannot tell one customer being
          // limited from a spray across many.
          tracker: throttlerLimitDetail?.tracker ?? null,
          limit: throttlerLimitDetail?.limit ?? null,
          ttl: throttlerLimitDetail?.ttl ?? null,
          totalHits: throttlerLimitDetail?.totalHits ?? null,
          timeToExpire: throttlerLimitDetail?.timeToExpire ?? null,
        },
      });
    } catch {
      /* Logging must never change what the caller is told. */
    }
    return super.throwThrottlingException(context, throttlerLimitDetail);
  }
}
