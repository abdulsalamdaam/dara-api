import { ProviderError } from "../news.types";

const TIMEOUT_MS = 20_000;

/**
 * GET JSON with a timeout, mapping every failure onto a `ProviderError` kind.
 * The body of an error response is kept (truncated) in the message: X and
 * twitterapi.io both explain themselves there, and that sentence is what the
 * admin reads in the run log.
 */
export async function getJson(url: string, headers: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<any> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ProviderError("other", `network error: ${(err as Error)?.message ?? err}`);
  }
  const raw = await res.text().catch(() => "");
  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (res.ok) {
    if (body == null) throw new ProviderError("other", `unparseable response (${res.status})`, res.status);
    return body;
  }
  const detail = describe(body) ?? raw.slice(0, 300);
  const retry = Number(res.headers.get("retry-after"));
  const reset = Number(res.headers.get("x-rate-limit-reset"));
  const retryAfterSec = Number.isFinite(retry) && retry > 0 ? retry
    : Number.isFinite(reset) && reset > 0 ? Math.max(0, Math.round(reset - Date.now() / 1000)) : null;
  if (res.status === 429) throw new ProviderError("rate_limit", `rate limited (429) ${detail}`.trim(), 429, retryAfterSec);
  if (res.status === 401 || res.status === 403) {
    // X answers 403 both for a bad token and for "your plan does not include
    // this endpoint"; twitterapi.io uses 402 for "out of credits".
    const quota = /quota|credit|plan|usage cap|client-not-enrolled/i.test(detail);
    throw new ProviderError(quota ? "quota" : "auth", `${res.status} ${detail}`.trim(), res.status);
  }
  if (res.status === 402) throw new ProviderError("quota", `402 ${detail}`.trim(), 402);
  if (res.status === 404) throw new ProviderError("not_found", `404 ${detail}`.trim(), 404);
  throw new ProviderError("other", `${res.status} ${detail}`.trim(), res.status);
}

function describe(body: any): string | null {
  if (!body || typeof body !== "object") return null;
  const parts = [body.title, body.detail, body.message, body.msg, body.error, body.errors?.[0]?.message]
    .filter((v) => typeof v === "string" && v);
  return parts.length ? [...new Set(parts)].join(" — ").slice(0, 300) : null;
}
