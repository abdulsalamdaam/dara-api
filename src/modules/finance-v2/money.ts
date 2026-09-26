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
