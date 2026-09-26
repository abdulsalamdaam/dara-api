import { fromHalalas } from "../money";
import { lastDayOfMonth, parseIsoDate, periodFor, periodsOfFiscalYear } from "../dates";

/**
 * Pure helpers for the core reports (DESIGN §7.1–7.4, §7.9): date ranges, the
 * fiscal-year start, debit/credit sides and the account-tree roll-up. All
 * amounts are integer halalas; nothing here touches a float.
 */

const pad = (n: number) => String(n).padStart(2, "0");

function utc(d: string): number {
  const { y, m, day } = parseIsoDate(d);
  return Date.UTC(y, m - 1, day);
}

export function addDays(d: string, n: number): string {
  return new Date(utc(d) + n * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

function addMonths(y: number, m: number, n: number): { y: number; m: number } {
  const i = y * 12 + (m - 1) + n;
  return { y: Math.floor(i / 12), m: (i % 12) + 1 };
}

/**
 * The comparative range "of the same length immediately before" (§7.1). A
 * range of whole calendar months shifts by that many months (so February
 * compares with January, a quarter with the previous quarter); any other range
 * shifts by its length in days.
 */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const f = parseIsoDate(from);
  const t = parseIsoDate(to);
  if (f.day === 1 && t.day === lastDayOfMonth(t.y, t.m)) {
    const months = (t.y - f.y) * 12 + (t.m - f.m) + 1;
    const s = addMonths(f.y, f.m, -months);
    const e = addMonths(f.y, f.m, -1);
    return { from: `${s.y}-${pad(s.m)}-01`, to: `${e.y}-${pad(e.m)}-${pad(lastDayOfMonth(e.y, e.m))}` };
  }
  const len = daysBetween(from, to);
  const cmpTo = addDays(from, -1);
  return { from: addDays(cmpTo, -len), to: cmpTo };
}

/** First day of the fiscal year containing `date`. */
export function fyStartOf(date: string, startMonth: number): string {
  return periodsOfFiscalYear(periodFor(date, startMonth).fiscalYear, startMonth)[0].startsOn;
}

/** The calendar months `YYYY-MM` from `from` to `to`, inclusive. */
export function monthsIn(from: string, to: string): string[] {
  const f = parseIsoDate(from);
  const t = parseIsoDate(to);
  const out: string[] = [];
  let cur = { y: f.y, m: f.m };
  while (cur.y * 12 + cur.m <= t.y * 12 + t.m) {
    out.push(`${cur.y}-${pad(cur.m)}`);
    cur = addMonths(cur.y, cur.m, 1);
  }
  return out;
}

/** A signed balance (debit − credit, halalas) as the TB's two columns. */
export function sides(net: number): { debit: string; credit: string } {
  return net >= 0 ? { debit: fromHalalas(net), credit: "0.00" } : { debit: "0.00", credit: fromHalalas(-net) };
}

export interface TreeNode {
  id: number;
  parentId: number | null;
}

/** Depth of every account in the tree (roots are 0). */
export function depths(nodes: TreeNode[]): Map<number, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<number, number>();
  const depth = (id: number, guard = 0): number => {
    if (out.has(id)) return out.get(id)!;
    const n = byId.get(id);
    const d = !n || n.parentId == null || guard > 32 ? 0 : depth(n.parentId, guard + 1) + 1;
    out.set(id, d);
    return d;
  };
  for (const n of nodes) depth(n.id);
  return out;
}

/** The ancestors of `id`, nearest first. */
export function ancestors(nodes: TreeNode[], id: number): number[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: number[] = [];
  let cur = byId.get(id)?.parentId ?? null;
  while (cur != null && out.length < 32) {
    out.push(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return out;
}

/**
 * Roll leaf vectors up the tree: every group gets the element-wise sum of its
 * descendants. `values` is keyed by leaf id; the result holds leaves and groups.
 */
export function rollUp(nodes: TreeNode[], values: Map<number, number[]>, width: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const addTo = (id: number, v: number[]) => {
    const cur = out.get(id) ?? new Array(width).fill(0);
    for (let i = 0; i < width; i++) cur[i] += v[i] ?? 0;
    out.set(id, cur);
  };
  for (const [id, v] of values) {
    addTo(id, v);
    for (const a of ancestors(nodes, id)) addTo(a, v);
  }
  return out;
}

/** The current time in Riyadh, `YYYY-MM-DD HH:MM:SS`, for report headers. */
export function riyadhNow(now = new Date()): string {
  return now.toLocaleString("sv-SE", { timeZone: "Asia/Riyadh", hour12: false });
}
