import type { SourceProvider } from "./news.types";
import { XApiProvider } from "./providers/x-api.provider";
import { TwitterApiIoProvider } from "./providers/twitterapiio.provider";

/**
 * Which source + AI the job would use, read from the environment each time
 * (so a Coolify env change + restart is all it takes, and a spec can set env).
 *
 *   NEWS_SOURCE_PROVIDER  x | twitterapiio   (default: whichever key is set, X first)
 *   X_BEARER_TOKEN        for `x`
 *   TWITTERAPI_IO_KEY     for `twitterapiio`
 *   ANTHROPIC_API_KEY     the AI filter
 *   NEWS_AI_MODEL         default DEFAULT_NEWS_MODEL
 */
export const DEFAULT_NEWS_MODEL = "claude-sonnet-5";

export type ProviderName = "x" | "twitterapiio";

export interface NewsConfig {
  provider: ProviderName | null;
  model: string;
  configured: { source: boolean; ai: boolean; missing: string[] };
}

export function readNewsConfig(env: NodeJS.ProcessEnv = process.env): NewsConfig {
  const xKey = (env.X_BEARER_TOKEN ?? "").trim();
  const ioKey = (env.TWITTERAPI_IO_KEY ?? "").trim();
  const wanted = (env.NEWS_SOURCE_PROVIDER ?? "").trim().toLowerCase();
  const missing: string[] = [];

  let provider: ProviderName | null;
  if (wanted === "x" || wanted === "twitterapiio") provider = wanted;
  else if (wanted) {
    provider = null;
    missing.push("NEWS_SOURCE_PROVIDER (must be 'x' or 'twitterapiio')");
  } else provider = xKey ? "x" : ioKey ? "twitterapiio" : null;

  let source = false;
  if (provider === "x") {
    source = !!xKey;
    if (!source) missing.push("X_BEARER_TOKEN");
  } else if (provider === "twitterapiio") {
    source = !!ioKey;
    if (!source) missing.push("TWITTERAPI_IO_KEY");
  } else if (!wanted) {
    missing.push("X_BEARER_TOKEN or TWITTERAPI_IO_KEY");
  }

  const ai = !!(env.ANTHROPIC_API_KEY ?? "").trim();
  if (!ai) missing.push("ANTHROPIC_API_KEY");

  return {
    provider,
    model: (env.NEWS_AI_MODEL ?? "").trim() || DEFAULT_NEWS_MODEL,
    configured: { source, ai, missing },
  };
}

export function buildProvider(cfg: NewsConfig, env: NodeJS.ProcessEnv = process.env): SourceProvider | null {
  if (!cfg.configured.source) return null;
  if (cfg.provider === "x") return new XApiProvider(env.X_BEARER_TOKEN!.trim());
  if (cfg.provider === "twitterapiio") return new TwitterApiIoProvider(env.TWITTERAPI_IO_KEY!.trim());
  return null;
}
