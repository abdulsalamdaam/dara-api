import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The per-request facts every log line wants, carried without threading a
 * parameter through every service signature.
 *
 * The problem this solves: an unhandled 500 printed a bare stack to stdout with
 * nothing saying which request produced it, which user was making it, or what
 * they were doing. Adding a `requestId` argument to every method between the
 * controller and the failure is not a change anybody would make, so the request
 * id travels out of band instead — `AsyncLocalStorage` keeps it attached across
 * every `await` inside the request, and `currentRequestContext()` reads it from
 * arbitrary depth.
 *
 * `userId` / `ownerUserId` are declared optional because the context is opened
 * by middleware, which runs BEFORE the guards that authenticate the request.
 * The middleware supplies them as live getters over `req.user`, so a line
 * logged after the guard has run carries the user and one logged before it
 * carries null — rather than the whole context being unavailable until auth
 * finishes.
 */
export interface RequestContext {
  requestId: string;
  ip: string;
  userAgent: string | null;
  method: string;
  /** Path only — never the query string; see `request-log.middleware.ts`. */
  path: string;
  userId?: number | null;
  ownerUserId?: number | null;
  /** `Date.now()` when the request entered the middleware. */
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` (and everything it awaits) with `ctx` as the ambient request context. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * The context of the request currently being served, or undefined.
 *
 * Undefined is normal and must never be treated as an error: boot-time
 * logging, the retention sweep and any background timer all run outside a
 * request.
 */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
