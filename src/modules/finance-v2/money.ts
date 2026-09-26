/**
 * Exact money for the ledger engine (DESIGN §2.1): numeric(14,2) strings in the
 * DB, integer halalas in code. No float ever touches a stored amount.
 */
const MONEY_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/** '1234.5' -> 123450. Throws on anything that is not a plain decimal with at most 2 places. */
export function toHalalas(s: string | number): number {
  const str = typeof s === "number" ? numberToDecimalString(s) : String(s).trim();
  const m = MONEY_RE.exec(str);
  if (!m) throw new Error(`fv2: not a money amount: ${JSON.stringify(s)}`);
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? "").padEnd(2, "0"));
  const n = whole * 100 + frac;
  if (!Number.isSafeInteger(n)) throw new Error(`fv2: amount out of range: ${str}`);
  return m[1] && n !== 0 ? -n : n;
}

/** 123450 -> '1234.50'. */
export function fromHalalas(n: number): string {
  if (!Number.isSafeInteger(n)) throw new Error(`fv2: halalas must be a safe integer, got ${n}`);
  const neg = n < 0;
  const a = Math.abs(n);
  const s = `${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

/**
 * A JS number (e.g. from jsonb) as a decimal string, WITHOUT float arithmetic:
 * String(n) is exact for the shortest round-trip form. More than two decimals
 * throws here; the engine's jsonb path rounds and flags those explicitly.
 */
function numberToDecimalString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`fv2: not a finite amount: ${n}`);
  const s = String(n);
  if (/e/i.test(s)) throw new Error(`fv2: amount in exponent form: ${s}`);
  return s;
}

/**
 * Net/VAT split of a gross amount at an integer percent rate (DESIGN §2.1):
 * net = round-half-up(G·100/(100+r)) computed in integers, vat = G − net.
 * Exhaustively equal to the legacy float `round2(gross/1.15)` for every gross
 * from 0.01 to 100,000.00 (money.spec.ts). Negative amounts split symmetrically.
 */
export function vatSplit(gross: number, ratePercent = 15): { net: number; vat: number } {
  assertHalalas(gross);
  if (!Number.isInteger(ratePercent) || ratePercent < 0) throw new Error(`fv2: bad VAT rate ${ratePercent}`);
  if (ratePercent === 0) return { net: gross, vat: 0 };
  const a = Math.abs(gross);
  const d = 100 + ratePercent;
  // Integer division, exactly: while N = 200·G + d is a safe integer, N % D is
  // exact in doubles and (N − N % D) / D divides evenly; beyond that, BigInt.
  const N = 200 * a + d;
  const D = 2 * d;
  const net = N <= Number.MAX_SAFE_INTEGER
    ? (N - (N % D)) / D
    : Number((200n * BigInt(a) + BigInt(d)) / (2n * BigInt(d)));
  const vat = a - net;
  return gross < 0 ? { net: -net, vat: -vat } : { net, vat };
}

/** round-half-up(a·b/c) for non-negative integers, exact (BigInt). */
export function mulDivRound(a: number, b: number, c: number): number {
  if (c <= 0) throw new Error("fv2: mulDivRound divisor must be positive");
  const neg = (a < 0) !== (b < 0);
  const A = BigInt(Math.abs(a));
  const B = BigInt(Math.abs(b));
  const C = BigInt(c);
  const r = Number((2n * A * B + C) / (2n * C));
  return neg && r !== 0 ? -r : r;
}

/**
 * Split `total` halalas over `weights` proportionally; the remainder goes to
 * the largest fractional parts (ties: earliest index), so Σ parts = total exactly.
 */
export function allocate(total: number, weights: number[]): number[] {
  assertHalalas(total);
  if (!weights.length) throw new Error("fv2: allocate needs at least one weight");
  const w = weights.map((x) => Math.max(0, x));
  const sum = w.reduce((s, x) => s + x, 0);
  if (sum === 0) return w.map((_, i) => (i === w.length - 1 ? total : 0));
  const T = BigInt(Math.abs(total));
  const S = BigInt(sum);
  const base = w.map((x) => (T * BigInt(x)) / S);
  const rem = w.map((x, i) => T * BigInt(x) - base[i] * S);
  let left = T - base.reduce((s, x) => s + x, 0n);
  const order = w.map((_, i) => i).sort((a, b) => (rem[b] > rem[a] ? 1 : rem[b] < rem[a] ? -1 : a - b));
  for (const i of order) {
    if (left <= 0n) break;
    base[i] += 1n;
    left -= 1n;
  }
  return base.map((x) => (total < 0 ? -Number(x) : Number(x)));
}

/**
 * A jsonb number (e.g. simple_invoices.items[].amount) as halalas. More than
 * two decimals is rounded half-up at the third decimal ON THE STRING and
 * reported, so the caller can add the `jsonb_precision` warning (§2.1).
 */
export function jsonbHalalas(v: unknown): { halalas: number; rounded: boolean } {
  const s = typeof v === "number" ? String(v) : String(v ?? "").trim();
  if (/e/i.test(s)) throw new Error(`fv2: amount in exponent form: ${s}`);
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`fv2: not a money amount: ${JSON.stringify(v)}`);
  const frac = m[3] ?? "";
  if (frac.length <= 2) return { halalas: toHalalas(s), rounded: false };
  let n = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) n += 1;
  if (!Number.isSafeInteger(n)) throw new Error(`fv2: amount out of range: ${s}`);
  return { halalas: m[1] && n !== 0 ? -n : n, rounded: true };
}

export function assertHalalas(n: number): void {
  if (!Number.isSafeInteger(n)) throw new Error(`fv2: halalas must be a safe integer, got ${n}`);
}
