import { NEWS_CATEGORIES, NEWS_ITEM_STATUSES, type NewsCategory, type NewsItemStatus } from "./news.types";
import { parseDaysOfWeek, RUN_TIME_RE } from "./news.schedule";

/**
 * Request-body parsing for the admin endpoints. Bodies arrive as `any` (the
 * global whitelist ValidationPipe would strip an undecorated DTO — see
 * CLAUDE.md), so every field is checked here by hand.
 *
 * Keys are camelCase like the rest of this API; the snake_case spelling from
 * the feature contract is accepted too, so either client shape works.
 *
 * Each parser returns `{ patch }` or `{ error }` — never a partial patch — and
 * an empty patch is an error (DARA-NOTES §7: `set({})` crashes the driver).
 */
export class NewsValidationError extends Error {}

function pick(body: any, camel: string, snake?: string): unknown {
  if (!body || typeof body !== "object") return undefined;
  if (body[camel] !== undefined) return body[camel];
  return snake ? body[snake] : undefined;
}

function bool(v: unknown, name: string): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new NewsValidationError(`${name} must be true or false`);
}

function intIn(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new NewsValidationError(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function optText(v: unknown, name: string, max: number): string | null {
  if (v == null) return null;
  if (typeof v !== "string") throw new NewsValidationError(`${name} must be text`);
  const t = v.trim();
  if (t.length > max) throw new NewsValidationError(`${name} must be at most ${max} characters`);
  return t || null;
}

export interface SettingsPatch {
  enabled?: boolean;
  runTime?: string;
  daysOfWeek?: number[];
  lookbackHours?: number;
  maxPerAccount?: number;
  minScore?: number;
  extraInstructions?: string | null;
}

export function parseSettingsPatch(body: any): SettingsPatch {
  const p: SettingsPatch = {};
  const enabled = pick(body, "enabled");
  if (enabled !== undefined) p.enabled = bool(enabled, "enabled");

  const runTime = pick(body, "runTime", "run_time");
  if (runTime !== undefined) {
    if (typeof runTime !== "string" || !RUN_TIME_RE.test(runTime.trim())) throw new NewsValidationError("runTime must be HH:MM (24h, Asia/Riyadh)");
    p.runTime = runTime.trim();
  }

  const days = pick(body, "daysOfWeek", "days_of_week");
  if (days !== undefined) {
    const parsed = parseDaysOfWeek(days);
    if (!parsed) throw new NewsValidationError("daysOfWeek must be a list of weekday numbers 0 (Sun) … 6 (Sat)");
    if (!parsed.length) throw new NewsValidationError("daysOfWeek must include at least one day (disable the job with enabled=false instead)");
    p.daysOfWeek = parsed;
  }

  const lookback = pick(body, "lookbackHours", "lookback_hours");
  if (lookback !== undefined) p.lookbackHours = intIn(lookback, "lookbackHours", 1, 168);
  const maxPer = pick(body, "maxPerAccount", "max_per_account");
  if (maxPer !== undefined) p.maxPerAccount = intIn(maxPer, "maxPerAccount", 1, 100);
  const minScore = pick(body, "minScore", "min_score");
  if (minScore !== undefined) p.minScore = intIn(minScore, "minScore", 0, 100);
  const extra = pick(body, "extraInstructions", "extra_instructions");
  if (extra !== undefined) p.extraInstructions = optText(extra, "extraInstructions", 2000);

  if (!Object.keys(p).length) throw new NewsValidationError("nothing to update");
  return p;
}

export interface SourcePatch {
  displayName?: string | null;
  notes?: string | null;
  enabled?: boolean;
}

export function parseSourcePatch(body: any): SourcePatch {
  const p: SourcePatch = {};
  const dn = pick(body, "displayName", "display_name");
  if (dn !== undefined) p.displayName = optText(dn, "displayName", 120);
  const notes = pick(body, "notes");
  if (notes !== undefined) p.notes = optText(notes, "notes", 1000);
  const enabled = pick(body, "enabled");
  if (enabled !== undefined) p.enabled = bool(enabled, "enabled");
  if (!Object.keys(p).length) throw new NewsValidationError("nothing to update");
  return p;
}

export interface ItemPatch {
  status?: NewsItemStatus;
  pinned?: boolean;
  aiCategory?: NewsCategory;
}

export function parseItemPatch(body: any): ItemPatch {
  const p: ItemPatch = {};
  const status = pick(body, "status");
  if (status !== undefined) {
    if (!(NEWS_ITEM_STATUSES as readonly unknown[]).includes(status)) throw new NewsValidationError(`status must be one of ${NEWS_ITEM_STATUSES.join(", ")}`);
    p.status = status as NewsItemStatus;
  }
  const pinned = pick(body, "pinned");
  if (pinned !== undefined) p.pinned = bool(pinned, "pinned");
  const cat = pick(body, "aiCategory", "ai_category");
  if (cat !== undefined) {
    if (!(NEWS_CATEGORIES as readonly unknown[]).includes(cat)) throw new NewsValidationError(`aiCategory must be one of ${NEWS_CATEGORIES.join(", ")}`);
    p.aiCategory = cat as NewsCategory;
  }
  if (!Object.keys(p).length) throw new NewsValidationError("nothing to update");
  return p;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `sourceIds` for POST /run: undefined (all enabled) or a non-empty uuid list. */
export function parseSourceIds(body: any): string[] | undefined {
  const raw = pick(body, "sourceIds", "source_ids");
  if (raw == null) return undefined;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !UUID_RE.test(v))) {
    throw new NewsValidationError("sourceIds must be a list of account ids");
  }
  return raw.length ? [...new Set(raw as string[])] : undefined;
}
