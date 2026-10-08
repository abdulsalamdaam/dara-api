import { Injectable, Logger } from "@nestjs/common";
import {
  EJAR_ENDPOINTS,
  type BaladyEnvelope,
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
// NHC's gateway sits behind Cloudflare; the default undici UA ("node") can trip
// its bot filter with a 403. Present as a normal client. Balady is behind
// Cloudflare too.
const USER_AGENT = "Mozilla/5.0 (compatible; DaraEjarClient/1.0; +https://dara-sa.net)";
// Refresh a Balady token this long before it expires (they last 17,999 s).
const TOKEN_SKEW_MS = 5 * 60_000;

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

/** The caller may not reach Ejar (EJAR_ACCESS). Surfaces as HTTP 403. */
export class EjarAccessError extends EjarApiError {
  constructor(message: string, log?: unknown) {
    super(message, 403, null, null, log);
    this.name = "EjarAccessError";
  }
}

/**
 * Who may make outbound Ejar calls, from `EJAR_ACCESS`:
 * - unset / `all` — any caller the route's permission check lets through;
 * - `allowlist` — only the user ids in `EJAR_ALLOWED_USER_IDS` (comma
 *   separated; empty means nobody), plus the unattended health probe;
 * - `off` — nothing at all, not even the probe.
 * Any other value is treated as `off`: a typo must not open the gate.
 */
export function ejarAccessDenial(userId: number | null | undefined, env = process.env): string | null {
  const mode = (env.EJAR_ACCESS ?? "all").trim().toLowerCase() || "all";
  if (mode === "all") return null;
  if (mode !== "allowlist") return "Ejar access is switched off on this server (EJAR_ACCESS).";
  if (userId == null) return null; // the unattended health probe
  const allowed = (env.EJAR_ALLOWED_USER_IDS ?? "").split(",").map((v) => Number(v.trim())).filter(Number.isInteger);
  return allowed.includes(userId) ? null : `Ejar access is restricted on this server; user ${userId} is not allowed.`;
}

export interface EjarCallResult<T = Record<string, unknown>> {
  body: EjarBody<T> | null;
  log: Record<string, unknown>;
}

type Gateway = "nhc" | "balady";
interface GatewayConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const trimUrl = (u: string) => u.replace(/\/+$/, "");

/**
 * Server-side client for the six whitelisted Ejar endpoints, over two gateways
 * that front the same Ejar backend:
 *
 * - **Balady** (MOMRAH, `EJAR_BALADY_*`): OAuth client-credentials → Bearer
 *   token, cached in memory. Used for every endpoint that has a `balady` route
 *   in `EJAR_ENDPOINTS`, whenever it is configured.
 * - **NHC** (IBM gateway, `EJAR_*`): client id + secret headers plus the
 *   mandatory (undocumented) `RefId: 1`, and `CallerReqTime` for
 *   `/v1/ejarext/*`. Used for the endpoints Balady does not carry yet.
 *
 * Retries 5xx and 429 with exponential backoff, unwraps either envelope to the
 * same JSON:API body, records the `X-Global-Transaction-ID`, and persists
 * every call via EjarLogService. Credentials come from the environment and
 * never leave this service.
 */
@Injectable()
export class EjarClientService {
  private readonly logger = new Logger("Ejar");
  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;
  constructor(private readonly logs: EjarLogService) {}

  private nhcConfig(): GatewayConfig | null {
    const baseUrl = process.env.EJAR_BASE_URL?.trim();
    const clientId = process.env.EJAR_CLIENT_ID?.trim();
    const clientSecret = process.env.EJAR_CLIENT_SECRET?.trim();
    if (!baseUrl || !clientId || !clientSecret) return null;
    if (/nhc\.sa\/nhc\/prod|\/nhc\/prod(\/|$)/i.test(baseUrl)) {
      throw new EjarConfigError(
        "EJAR_BASE_URL points at the production gateway. Prod needs separate credentials and is blocked here.",
      );
    }
    return { baseUrl: trimUrl(baseUrl), clientId, clientSecret };
  }

  private baladyConfig(): GatewayConfig | null {
    const baseUrl = process.env.EJAR_BALADY_BASE_URL?.trim();
    const clientId = process.env.EJAR_BALADY_CLIENT_ID?.trim();
    const clientSecret = process.env.EJAR_BALADY_CLIENT_SECRET?.trim();
    if (!baseUrl || !clientId || !clientSecret) return null;
    if (/\/\/apiservices\.balady\.gov\.sa/i.test(baseUrl)) {
      throw new EjarConfigError(
        "EJAR_BALADY_BASE_URL points at the production Balady gateway. Prod needs separate credentials and is blocked here.",
      );
    }
    return { baseUrl: trimUrl(baseUrl), clientId, clientSecret };
  }

  /** Balady when it carries the endpoint and is configured, else NHC. */
  private route(endpoint: EjarEndpointKey): { gateway: Gateway; cfg: GatewayConfig } {
    const balady = EJAR_ENDPOINTS[endpoint]?.balady ? this.baladyConfig() : null;
    if (balady) return { gateway: "balady", cfg: balady };
    const nhc = this.nhcConfig();
    if (nhc) return { gateway: "nhc", cfg: nhc };
    throw new EjarConfigError(
      EJAR_ENDPOINTS[endpoint]?.balady
        ? "Ejar client is not configured. Set EJAR_BALADY_BASE_URL, EJAR_BALADY_CLIENT_ID and EJAR_BALADY_CLIENT_SECRET (or the NHC EJAR_BASE_URL, EJAR_CLIENT_ID and EJAR_CLIENT_SECRET)."
        : "Ejar client is not configured. Set EJAR_BASE_URL, EJAR_CLIENT_ID and EJAR_CLIENT_SECRET.",
    );
  }

  private envLabel(gateway: Gateway, baseUrl: string): string {
    if (gateway === "balady") return /apiservicesstg\./i.test(baseUrl) ? "balady-stg" : "balady-prod";
    if (/\/prod(\/|$)/i.test(baseUrl)) return "prod";
    return "uat";
  }

  /** A cached Balady access token; one token request at a time. */
  private async baladyToken(cfg: GatewayConfig, force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - TOKEN_SKEW_MS > Date.now()) return this.token.value;
    if (force) this.token = null;
    this.tokenInFlight ??= (async () => {
      try {
        const res = await fetch(`${cfg.baseUrl}/oauth/v1/token`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
          body: "grant_type=client_credentials",
          cache: "no-store",
        });
        const json = (await res.json().catch(() => null)) as
          | { access_token?: string; expires_in?: string | number; Error?: string; ErrorCode?: string }
          | null;
        if (!res.ok || !json?.access_token) {
          throw new EjarApiError(
            `Balady token ${res.status} — ${json?.Error || json?.ErrorCode || "no access_token"}`,
            res.status,
            null,
            json,
          );
        }
        const ttlMs = (Number(json.expires_in) || 3600) * 1000;
        this.token = { value: json.access_token, expiresAt: Date.now() + ttlMs };
        return json.access_token;
      } finally {
        this.tokenInFlight = null;
      }
    })();
    return this.tokenInFlight;
  }

  async request<T = Record<string, unknown>>(
    endpoint: EjarEndpointKey,
    params: Record<string, string | number | undefined> = {},
    opts: { userId?: number | null; skipLog?: boolean } = {},
  ): Promise<EjarCallResult<T>> {
    const def = EJAR_ENDPOINTS[endpoint];
    if (!def) throw new EjarConfigError(`Unknown Ejar endpoint: ${endpoint}`);

    // Every outbound call passes through here — the routes, the replay and the
    // health probe — so this is the one place the access rule cannot be missed.
    // A refused attempt is still logged, so the log shows who tried.
    const denial = ejarAccessDenial(opts.userId);
    if (denial) {
      this.logger.warn(`blocked ${endpoint} for user ${opts.userId ?? "system"}: ${denial}`);
      const log = await this.safeLog(
        {
          userId: opts.userId ?? null, env: "blocked", endpoint, method: def.method, url: def.path,
          params: {}, requestHeaders: {}, status: 403, ejarStatus: null, transactionId: null,
          durationMs: 0, attempts: 0, responseBody: null, bodyTruncated: false, error: denial,
        },
        opts.skipLog,
      );
      throw new EjarAccessError(denial, log);
    }

    const { gateway, cfg } = this.route(endpoint);

    const strParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && `${v}` !== "") strParams[k] = String(v);
    }
    const missing = def.required.filter((r) => !strParams[r]);
    if (missing.length) throw new EjarApiError(`Missing required parameter(s): ${missing.join(", ")}`, 400, null, null);

    const target = gateway === "balady" && def.balady ? def.balady(strParams) : { path: def.path, query: strParams };
    const qs = new URLSearchParams(target.query).toString();
    const url = `${cfg.baseUrl}${target.path}${qs ? `?${qs}` : ""}`;

    const headers: Record<string, string> = { RefId: "1", Accept: "application/json", "User-Agent": USER_AGENT };
    if (gateway === "nhc") {
      headers["X-IBM-Client-Id"] = cfg.clientId;
      headers[SECRET_HEADER] = cfg.clientSecret;
      if (def.path.startsWith("/v1/ejarext/")) headers.CallerReqTime = String(Math.floor(Date.now() / 1000));
    }

    const rec: EjarLogRecordInput = {
      userId: opts.userId ?? null,
      env: this.envLabel(gateway, cfg.baseUrl),
      endpoint,
      method: def.method,
      url,
      params: strParams,
      requestHeaders:
        gateway === "nhc" ? { ...headers, [SECRET_HEADER]: REDACTED } : { ...headers, Authorization: `Bearer ${REDACTED}` },
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
    let refreshedToken = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      rec.attempts = attempt;
      try {
        if (gateway === "balady") headers.Authorization = `Bearer ${await this.baladyToken(cfg)}`;
        const res = await fetch(url, { method: def.method, headers, cache: "no-store" });
        rec.status = res.status;
        rec.transactionId = res.headers.get("X-Global-Transaction-ID");
        this.logger.log(`[${gateway}] ${def.method} ${target.path} → ${res.status} (try ${attempt}) txid=${rec.transactionId ?? "n/a"}`);

        const ct = res.headers.get("content-type") || "";
        const parsed: unknown = ct.includes("application/json") ? await res.json().catch(() => null) : await res.text();

        // A Balady token can be revoked before it expires — fetch a new one once.
        if (gateway === "balady" && res.status === 401 && !refreshedToken) {
          refreshedToken = true;
          await this.baladyToken(cfg, true);
          attempt--;
          continue;
        }
        if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
          lastErr = new EjarApiError(`Ejar ${res.status}`, res.status, rec.transactionId, parsed);
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }

        let unwrapped: EjarBody<T> | null;
        if (gateway === "balady") {
          const envelope = (parsed && typeof parsed === "object" ? parsed : {}) as BaladyEnvelope<T>;
          unwrapped = envelope.data?.result ?? null;
          const code = Number(envelope.statusDetails?.code);
          rec.ejarStatus = Number.isFinite(code) ? code : null;
          rec.transactionId ??= envelope.data?.responseId ?? null;
        } else {
          const envelope = (parsed && typeof parsed === "object" ? parsed : {}) as EjarEnvelope<T>;
          unwrapped = (envelope.Body ?? (parsed as EjarBody<T>)) ?? null;
          rec.ejarStatus = envelope.Header?.Status?.Code ?? null;
        }

        const trunc = truncateBody(parsed);
        rec.responseBody = trunc.value;
        rec.bodyTruncated = trunc.truncated;
        rec.durationMs = Date.now() - startedAt;

        if (!res.ok) {
          rec.error = this.describe(gateway, res.status, parsed);
          const log = await this.safeLog(rec, opts.skipLog);
          throw new EjarApiError(rec.error, res.status, rec.transactionId, parsed, log);
        }

        const log = await this.safeLog(rec, opts.skipLog);
        return { body: unwrapped, log };
      } catch (err) {
        if (err instanceof EjarApiError && err.log !== undefined) throw err;
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

  private describe(gateway: Gateway, status: number, body: unknown): string {
    const hint =
      status === 400 ? (gateway === "nhc" ? "missing required parameter (usually RefId)" : "bad request")
      : status === 401 ? (gateway === "nhc"
          ? "wrong client id/secret, or credential not subscribed to this API product"
          : "token rejected, or the Balady app is not subscribed to this API product")
      : status === 403 ? `IP not whitelisted on the ${gateway === "nhc" ? "NHC" : "Balady"} gateway`
      : status === 404 ? "wrong path"
      : status === 429 ? "rate limit exceeded"
      : status >= 500 ? "backend microservice error (retry, or bad test data)"
      : "";
    let detail = typeof body === "string" ? body.slice(0, 200) : "";
    if (gateway === "balady" && body && typeof body === "object") {
      const b = body as BaladyEnvelope;
      detail = [b.data?.responseCode, b.data?.responseMessage || b.statusDetails?.message].filter(Boolean).join(" ");
    }
    return `Ejar HTTP ${status}${hint ? ` — ${hint}` : ""}${detail ? ` :: ${detail}` : ""}`;
  }
}
