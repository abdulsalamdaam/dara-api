import { Injectable, Logger } from "@nestjs/common";
import {
  EJAR_ENDPOINTS,
  type EjarBody,
  type EjarEndpointKey,
  type EjarEnvelope,
  type EjarLogRecordInput,
} from "./ejar.types";
import { EjarLogService, truncateBody } from "./ejar.log.service";

const SECRET_HEADER = "X-IBM-Client-Secret";
const REDACTED = "***redacted***";
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 400;

export class EjarConfigError extends Error {}
export class EjarApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly transactionId: string | null,
    readonly body: unknown,
    public log?: unknown,
  ) {
    super(message);
    this.name = "EjarApiError";
  }
}

export interface EjarCallResult<T = Record<string, unknown>> {
  body: EjarBody<T> | null;
  log: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Server-side client for the six whitelisted Ejar endpoints. Injects the IBM
 * gateway credentials + the mandatory (undocumented) `RefId: 1`, adds
 * `CallerReqTime` for `/v1/ejarext/*`, retries 5xx with exponential backoff,
 * unwraps the Header/Body envelope, records the `X-Global-Transaction-ID`, and
 * persists every call via EjarLogService. Credentials come from the
 * environment and never leave this service.
 */
@Injectable()
export class EjarClientService {
  private readonly logger = new Logger("Ejar");
  constructor(private readonly logs: EjarLogService) {}

  private config() {
    const baseUrl = process.env.EJAR_BASE_URL?.trim();
    const clientId = process.env.EJAR_CLIENT_ID?.trim();
    const clientSecret = process.env.EJAR_CLIENT_SECRET?.trim();
    if (!baseUrl || !clientId || !clientSecret) {
      throw new EjarConfigError(
        "Ejar client is not configured. Set EJAR_BASE_URL, EJAR_CLIENT_ID and EJAR_CLIENT_SECRET.",
      );
    }
    if (/nhc\.sa\/nhc\/prod|\/nhc\/prod(\/|$)/i.test(baseUrl)) {
      throw new EjarConfigError(
        "EJAR_BASE_URL points at the production gateway. Prod needs separate credentials and is blocked here.",
      );
    }
    return { baseUrl: baseUrl.replace(/\/+$/, ""), clientId, clientSecret };
  }

  private envLabel(baseUrl: string): string {
    if (/\/prod(\/|$)/i.test(baseUrl)) return "prod";
    return "uat";
  }

  async request<T = Record<string, unknown>>(
    endpoint: EjarEndpointKey,
    params: Record<string, string | number | undefined> = {},
    opts: { userId?: number | null; skipLog?: boolean } = {},
  ): Promise<EjarCallResult<T>> {
    const cfg = this.config();
    const def = EJAR_ENDPOINTS[endpoint];
    if (!def) throw new EjarConfigError(`Unknown Ejar endpoint: ${endpoint}`);

    const strParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && `${v}` !== "") strParams[k] = String(v);
    }
    const missing = def.required.filter((r) => !strParams[r]);
    if (missing.length) throw new EjarApiError(`Missing required parameter(s): ${missing.join(", ")}`, 400, null, null);

    const qs = new URLSearchParams(strParams).toString();
    const url = `${cfg.baseUrl}${def.path}${qs ? `?${qs}` : ""}`;
    const isExt = def.path.startsWith("/v1/ejarext/");

    const headers: Record<string, string> = {
      "X-IBM-Client-Id": cfg.clientId,
      [SECRET_HEADER]: cfg.clientSecret,
      RefId: "1",
      Accept: "application/json",
      // NHC's gateway sits behind Cloudflare; the default undici UA ("node")
      // can trip its bot filter with a 403. Present as a normal client.
      "User-Agent": "Mozilla/5.0 (compatible; DaraEjarClient/1.0; +https://dara-sa.net)",
    };
    if (isExt) headers.CallerReqTime = String(Math.floor(Date.now() / 1000));

    const rec: EjarLogRecordInput = {
      userId: opts.userId ?? null,
      env: this.envLabel(cfg.baseUrl),
      endpoint,
      method: def.method,
      url,
      params: strParams,
      requestHeaders: { ...headers, [SECRET_HEADER]: REDACTED },
      status: null,
      ejarStatus: null,
      transactionId: null,
      durationMs: 0,
      attempts: 0,
      responseBody: null,
      bodyTruncated: false,
      error: null,
    };

    const startedAt = Date.now();
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      rec.attempts = attempt;
      try {
        const res = await fetch(url, { method: def.method, headers, cache: "no-store" });
        rec.status = res.status;
        rec.transactionId = res.headers.get("X-Global-Transaction-ID");
        this.logger.log(`${def.method} ${def.path} → ${res.status} (try ${attempt}) txid=${rec.transactionId ?? "n/a"}`);

        const ct = res.headers.get("content-type") || "";
        const parsed: unknown = ct.includes("application/json") ? await res.json().catch(() => null) : await res.text();

        if (res.status >= 500 && attempt < MAX_RETRIES) {
          lastErr = new EjarApiError(`Ejar ${res.status}`, res.status, rec.transactionId, parsed);
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }

        const envelope = (parsed && typeof parsed === "object" ? parsed : {}) as EjarEnvelope<T>;
        const unwrapped = (envelope.Body ?? (parsed as EjarBody<T>)) ?? null;
        rec.ejarStatus = envelope.Header?.Status?.Code ?? null;

        const trunc = truncateBody(parsed);
        rec.responseBody = trunc.value;
        rec.bodyTruncated = trunc.truncated;
        rec.durationMs = Date.now() - startedAt;

        if (!res.ok) {
          rec.error = this.describe(res.status, parsed);
          const log = await this.safeLog(rec, opts.skipLog);
          throw new EjarApiError(rec.error, res.status, rec.transactionId, parsed, log);
        }

        const log = await this.safeLog(rec, opts.skipLog);
        return { body: unwrapped, log };
      } catch (err) {
        if (err instanceof EjarApiError) throw err;
        lastErr = err;
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
      }
    }

    rec.error = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown error");
    rec.durationMs = Date.now() - startedAt;
    const log = await this.safeLog(rec, opts.skipLog);
    if (lastErr instanceof EjarApiError) {
      lastErr.log = log;
      throw lastErr;
    }
    throw new EjarApiError(rec.error, rec.status, rec.transactionId, null, log);
  }

  /**
   * Persist the log row, but NEVER let a logging failure break the actual
   * Ejar call. On a DB error we log a warning and return the in-memory record
   * (with a synthetic id) so the caller still gets its data.
   */
  private async safeLog(rec: EjarLogRecordInput, skip?: boolean): Promise<Record<string, unknown>> {
    if (skip) return rec as unknown as Record<string, unknown>;
    try {
      return (await this.logs.insert(rec)) as unknown as Record<string, unknown>;
    } catch (e) {
      this.logger.warn(`ejar log insert failed (call still succeeded): ${(e as Error)?.message || e}`);
      return { ...rec, id: 0, ts: new Date().toISOString() };
    }
  }

  private describe(status: number, body: unknown): string {
    const hint =
      status === 400 ? "missing required parameter (usually RefId)"
      : status === 401 ? "wrong client id/secret, or credential not subscribed to this API product"
      : status === 403 ? "IP not whitelisted on the NHC gateway"
      : status === 404 ? "wrong path"
      : status >= 500 ? "backend microservice error (retry, or bad test data)"
      : "";
    const detail = typeof body === "string" ? body.slice(0, 200) : "";
    return `Ejar HTTP ${status}${hint ? ` — ${hint}` : ""}${detail ? ` :: ${detail}` : ""}`;
  }
}
