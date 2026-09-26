import type { SourceProvider } from "./news.types";
import { XApiProvider } from "./providers/x-api.provider";
import { TwitterApiIoProvider } from "./providers/twitterapiio.provider";
import { ApifyProvider, readApifyBudget, readApifyMaxItems } from "./providers/apify.provider";

/**
 * Which sources + filter the job would use, read from the environment each time
 * (so a Coolify env change + restart is all it takes, and a spec can set env).
 *
 *   NEWS_SOURCE_PROVIDER  x | twitterapiio | apify  (default: whichever key is set,
 *                         in this order: X_BEARER_TOKEN, TWITTERAPI_IO_KEY, APIFY_TOKEN —
 *                         a paid X plan someone set up on purpose wins over the free one)
 *   X_BEARER_TOKEN        for `x`
 *   TWITTERAPI_IO_KEY     for `twitterapiio`
 *   APIFY_TOKEN           for `apify` (one actor run per job for every X handle)
 *   NEWS_APIFY_MONTHLY_BUDGET_USD  X is skipped once the Apify cycle's spend reaches
 *                         this (default 4.5; the free plan has $5)
 *   NEWS_APIFY_MAX_ITEMS_PER_RUN   tweets one Apify run may return (default 300)
 *   NEWS_FILTER           auto (default) | keyword | ai — auto = Claude when
 *                         ANTHROPIC_API_KEY is set, else the free keyword filter
 *   ANTHROPIC_API_KEY     the Claude filter
 *   NEWS_AI_MODEL         default DEFAULT_NEWS_MODEL
 *   NEWS_MAX_AI_ITEMS_PER_RUN  posts sent to the AI per run, default
 *                         DEFAULT_MAX_AI_ITEMS (the rest wait for the next run)
 *
 * RSS feeds need no key, so whether the job can run at all also depends on
 * the source rows: pass `rssEnabled` (enabled rss rows). `missing` lists only
 * what blocks EVERY run; a problem that only disables X (no key, a typo in
 * NEWS_SOURCE_PROVIDER) is a `warning` while RSS can carry the run.
 */
export const DEFAULT_NEWS_MODEL = "claude-sonnet-5";
export const DEFAULT_MAX_AI_ITEMS = 150;
const MAX_AI_ITEMS_CEILING = 2000;

export type ProviderName = "x" | "twitterapiio" | "apify";
const PROVIDERS: readonly ProviderName[] = ["x", "twitterapiio", "apify"];
const PROVIDER_KEY: Record<ProviderName, string> = { x: "X_BEARER_TOKEN", twitterapiio: "TWITTERAPI_IO_KEY", apify: "APIFY_TOKEN" };
export type FilterKind = "ai" | "keyword";
export type FilterSetting = "auto" | FilterKind;

export const NO_SOURCE_MISSING = "an enabled RSS source, or X_BEARER_TOKEN / TWITTERAPI_IO_KEY / APIFY_TOKEN";

export interface NewsConfig {
  /** The X provider, when its key is set; null = X rows are skipped. */
  provider: ProviderName | null;
  /** The filter a run would use now. */
  filter: FilterKind;
  /** NEWS_FILTER as read (invalid → auto, with a warning). */
  filterSetting: FilterSetting;
  model: string;
  /** Hard cap on posts sent to the AI in one run — the run's cost bound. */
  maxAiItemsPerRun: number;
  /** X usable (a provider and its key). */
  xConfigured: boolean;
  /** Apify only: the cycle budget (USD) and the per-run tweet cap. */
  apify: { budgetUsd: number; maxItemsPerRun: number };
  /** source = some usable source kind; ai = the chosen filter can run. */
  configured: { source: boolean; ai: boolean; missing: string[] };
  /** Non-blocking problems, for the admin status header. */
  warnings: string[];
}

export function readNewsFilter(raw: string | undefined): FilterSetting | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (!t || t === "auto") return "auto";
  if (t === "keyword" || t === "ai") return t;
  return null;
}

export function readNewsConfig(env: NodeJS.ProcessEnv = process.env, sources: { rssEnabled?: number } = {}): NewsConfig {
  const xKey = (env.X_BEARER_TOKEN ?? "").trim();
  const ioKey = (env.TWITTERAPI_IO_KEY ?? "").trim();
  const apifyKey = (env.APIFY_TOKEN ?? "").trim();
  const wanted = (env.NEWS_SOURCE_PROVIDER ?? "").trim().toLowerCase();
  const aiKey = !!(env.ANTHROPIC_API_KEY ?? "").trim();
  const rss = Math.max(0, sources.rssEnabled ?? 0);
  const missing: string[] = [];
  const warnings: string[] = [];

  // ── X ────────────────────────────────────────────────────────────────
  let provider: ProviderName | null;
  let xProblem: string | null = null;
  const keys: Record<ProviderName, string> = { x: xKey, twitterapiio: ioKey, apify: apifyKey };
  if ((PROVIDERS as readonly string[]).includes(wanted)) provider = wanted as ProviderName;
  else if (wanted) {
    provider = null;
    xProblem = "NEWS_SOURCE_PROVIDER (must be 'x', 'twitterapiio' or 'apify')";
  } else provider = PROVIDERS.find((p) => keys[p]) ?? null;

  let xConfigured = false;
  if (provider) {
    xConfigured = !!keys[provider];
    if (!xConfigured) xProblem = PROVIDER_KEY[provider];
  }
  const source = xConfigured || rss > 0;
  if (!source) missing.push(xProblem && wanted ? `${xProblem}, or an enabled RSS source` : NO_SOURCE_MISSING);
  else if (xProblem) warnings.push(`X sources are skipped — ${xProblem}`);

  // ── filter ───────────────────────────────────────────────────────────
  let filterSetting = readNewsFilter(env.NEWS_FILTER);
  if (!filterSetting) {
    warnings.push("NEWS_FILTER must be 'auto', 'keyword' or 'ai' — using auto");
    filterSetting = "auto";
  }
  const filter: FilterKind = filterSetting === "auto" ? (aiKey ? "ai" : "keyword") : filterSetting;
  const ai = filter === "keyword" || aiKey;
  if (!ai) missing.push("ANTHROPIC_API_KEY");

  return {
    provider: xConfigured ? provider : null,
    filter,
    filterSetting,
    model: (env.NEWS_AI_MODEL ?? "").trim() || DEFAULT_NEWS_MODEL,
    maxAiItemsPerRun: readMaxAiItems(env.NEWS_MAX_AI_ITEMS_PER_RUN),
    xConfigured,
    apify: { budgetUsd: readApifyBudget(env.NEWS_APIFY_MONTHLY_BUDGET_USD), maxItemsPerRun: readApifyMaxItems(env.NEWS_APIFY_MAX_ITEMS_PER_RUN) },
    configured: { source, ai, missing },
    warnings,
  };
}

/** A positive integer up to the ceiling; anything else falls back to the default. */
export function readMaxAiItems(raw: string | undefined): number {
  const t = (raw ?? "").trim();
  if (!/^\d+$/.test(t)) return DEFAULT_MAX_AI_ITEMS;
  const n = Number(t);
  if (n < 1) return DEFAULT_MAX_AI_ITEMS;
  return Math.min(n, MAX_AI_ITEMS_CEILING);
}

export function buildProvider(cfg: NewsConfig, env: NodeJS.ProcessEnv = process.env): SourceProvider | null {
  if (!cfg.xConfigured) return null;
  if (cfg.provider === "x") return new XApiProvider(env.X_BEARER_TOKEN!.trim());
  if (cfg.provider === "twitterapiio") return new TwitterApiIoProvider(env.TWITTERAPI_IO_KEY!.trim());
  if (cfg.provider === "apify") return new ApifyProvider(env.APIFY_TOKEN!.trim(), { budgetUsd: cfg.apify.budgetUsd, maxItemsPerRun: cfg.apify.maxItemsPerRun });
  return null;
}
