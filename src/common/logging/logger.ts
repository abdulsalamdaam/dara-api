import type { LoggerService } from "@nestjs/common";
import { currentRequestContext } from "../request-context";

/**
 * One JSON object per line on stdout — the sink, not the call sites.
 *
 * Nothing about `new Logger("Foo").warn(...)` changes anywhere in the codebase:
 * `app.useLogger()` swaps what Nest does with the message, and every existing
 * `Logger` call keeps working exactly as written. What changes is the output.
 * A stack printed as free text with a timestamp is unsearchable once it is one
 * of forty thousand lines in a container's log buffer; a JSON line can be
 * filtered by `requestId`, `userId` or `path` by anything that reads it.
 *
 * The request fields are read from the AsyncLocalStorage context rather than
 * passed in, so a log line written five services deep carries the request id
 * without a single signature changing.
 *
 * `LOG_FORMAT=pretty` restores human-readable output for local development.
 * The deployed container gets JSON; nobody reads its stdout with their eyes.
 */

export type LogLevelName = "error" | "warn" | "log" | "debug" | "verbose";

/** Ascending verbosity. A level is emitted when its rank ≤ the configured rank. */
const RANK: Record<LogLevelName, number> = {
  error: 0,
  warn: 1,
  log: 2,
  debug: 3,
  verbose: 4,
};

function configuredLevel(): LogLevelName {
  const raw = String(process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  return (raw in RANK ? raw : "log") as LogLevelName;
}

function pretty(): boolean {
  return String(process.env.LOG_FORMAT ?? "").trim().toLowerCase() === "pretty";
}

/** Extra structured fields a caller wants on the line, beyond the standard set. */
export type LogFields = Record<string, unknown>;

/**
 * Everything goes to **stdout**, errors included.
 *
 * Splitting error/warn onto stderr is the conventional choice and is wrong for
 * a container: the two streams are collected independently and interleave in
 * whatever order the collector happens to flush them, so the one thing you
 * want from a log — what happened immediately before the failure — is exactly
 * what you lose. One stream keeps the order.
 */
function write(line: string): void {
  try {
    process.stdout.write(line + "\n");
  } catch {
    /* A broken stdout must never take the process down. */
  }
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Emit one structured line. Exported so the request middleware and the
 * exception filter can attach their own fields (status, duration, event)
 * without inventing a second format.
 */
export function logLine(
  level: LogLevelName,
  context: string | undefined,
  message: unknown,
  fields?: LogFields,
): void {
  if (RANK[level] > RANK[configuredLevel()]) return;

  const ctx = currentRequestContext();
  const msg = serialize(message);

  if (pretty()) {
    const head = `${new Date().toISOString()} ${level.toUpperCase().padEnd(7)}`;
    const where = context ? `[${context}] ` : "";
    const rid = ctx?.requestId ? `(${ctx.requestId.slice(0, 8)}) ` : "";
    const extra = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
    write(`${head} ${rid}${where}${msg}${extra}`);
    return;
  }

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    context: context ?? null,
    msg,
    requestId: ctx?.requestId ?? null,
    userId: ctx?.userId ?? null,
    ip: ctx?.ip ?? null,
    method: ctx?.method ?? null,
    path: ctx?.path ?? null,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      // Never let a caller-supplied field overwrite the identity of the line.
      if (k in entry && v == null) continue;
      entry[k] = v;
    }
  }
  try {
    write(JSON.stringify(entry));
  } catch {
    // A field that cannot be serialised must not cost us the message.
    write(JSON.stringify({ ts: entry.ts, level, context: context ?? null, msg }));
  }
}

/**
 * Split `(message, ...optionalParams)` the way Nest's own ConsoleLogger does.
 *
 * Matching it exactly is the point of this whole class: several hundred
 * existing `new Logger("Foo").warn(...)` / `Logger.error(msg, "Bootstrap")`
 * call sites must mean the same thing after the sink is swapped as before it.
 * Nest's rule, from `getContextAndStackAndMessagesToPrint`, is:
 *
 *   · a trailing string argument is the CONTEXT, at every level;
 *   · of what remains, a trailing string containing a newline is the STACK.
 *
 * The second rule is what distinguishes `logger.error(msg, stack, context)`
 * from `logger.error(msg, context)` — a stack has newlines and a context name
 * does not.
 */
function splitParams(params: unknown[]): { context?: string; stack?: string; rest: unknown[] } {
  if (params.length === 0) return { rest: [] };
  let rest = params;
  let context: string | undefined;
  const last = rest[rest.length - 1];
  if (typeof last === "string") {
    context = last;
    rest = rest.slice(0, -1);
  }
  const maybeStack = rest[rest.length - 1];
  if (typeof maybeStack === "string" && maybeStack.includes("\n")) {
    return { context, stack: maybeStack, rest: rest.slice(0, -1) };
  }
  return { context, rest };
}

export class StructuredLogger implements LoggerService {
  private emit(level: LogLevelName, message: unknown, params: unknown[]): void {
    const { context, stack, rest } = splitParams(params);
    const fields: LogFields = {};
    if (stack) fields.stack = stack;
    if (rest.length > 0) fields.details = rest.map(serialize);
    logLine(level, context, message, Object.keys(fields).length ? fields : undefined);
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit("log", message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit("error", message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit("warn", message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit("debug", message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit("verbose", message, params);
  }
}
