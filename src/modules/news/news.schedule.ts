/**
 * When the daily job next runs.
 *
 * The admin sets a wall-clock time ('HH:MM') and a set of weekdays, both in
 * `tz` (Asia/Riyadh in production). The answer is the first instant strictly
 * after `now` whose local time is `runTime` on an allowed local weekday, as a
 * UTC Date — or null when no weekday is allowed.
 *
 * Written against the IANA zone through Intl rather than a hard-coded +03:00:
 * Riyadh has no DST today, but the function is the same one the specs run
 * against DST zones, and a fixed offset is the kind of shortcut that is right
 * until it is not.
 */
export const NEWS_TZ = "Asia/Riyadh";
export const RUN_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

type LocalParts = { y: number; m: number; d: number; hh: number; mm: number; ss: number; dow: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(at: Date, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(at)) parts[p.type] = p.value;
  return {
    y: +parts.year, m: +parts.month, d: +parts.day,
    hh: +parts.hour, mm: +parts.minute, ss: +parts.second,
    dow: DOW[parts.weekday] ?? 0,
  };
}

/** Offset of `tz` from UTC at `at`, in ms (Riyadh → +3h). */
function offsetMs(at: Date, tz: string): number {
  const p = localParts(at, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** A local wall-clock time in `tz` → the UTC instant. */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let utc = guess - offsetMs(new Date(guess), tz);
  // Second pass: the offset at the real instant can differ across a DST edge.
  const off2 = offsetMs(new Date(utc), tz);
  utc = guess - off2;
  return new Date(utc);
}

export function computeNextRunAt(
  now: Date,
  runTime: string,
  daysOfWeek: readonly number[],
  tz: string = NEWS_TZ,
): Date | null {
  const m = RUN_TIME_RE.exec(runTime);
  if (!m) return null;
  const hh = +m[1];
  const mm = +m[2];
  const days = new Set(daysOfWeek.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  if (days.size === 0) return null;

  const today = localParts(now, tz);
  // 8 days covers "only today's weekday, and today's slot has passed".
  for (let i = 0; i <= 8; i++) {
    // Calendar arithmetic on a UTC date so month/year rollover is free.
    const cal = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const dow = cal.getUTCDay();
    if (!days.has(dow)) continue;
    const at = zonedToUtc(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), hh, mm, tz);
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}

/** `[1, "3", 3, 9]` → `[1, 3]`, or null if the input is not a usable list. */
export function parseDaysOfWeek(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out = new Set<number>();
  for (const v of raw) {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > 6) return null;
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}
