import { BadRequestException } from "@nestjs/common";

/**
 * Shared request-input validators for the CRUD controllers.
 *
 * Why this file exists
 * ────────────────────
 * The controllers accept `@Body() body: any` and copy values straight into
 * Drizzle `insert()/set()` calls. Postgres then decides what is acceptable —
 * which means a malformed value is either a 500 (`"abc"` into a numeric column,
 * `999999999999` into `numeric(5,2)`) or, worse, silently stored (a 5,000-char
 * unit number, a −50% management fee, a 1-digit postal code). The web wizards
 * validate all of this client-side; the mobile app and the Ejar import call the
 * same endpoints and do not.
 *
 * Rules of engagement
 * ───────────────────
 * - **Optional means optional.** `undefined`, `null` and `""` are never
 *   rejected — they normalise to `null`. Only a value that is actually present
 *   and actually malformed raises. This keeps every existing valid payload
 *   working, including the sparse ones drafts and imports produce.
 * - **Messages are specific and Arabic-first**, paired with a short English
 *   half after a `·`, matching `common/national-address.ts` and
 *   `common/commercial-reg.ts`. Never a generic "invalid input".
 * - **The same helper runs on create and on update.** The audit found update
 *   paths routinely skipping what the create path enforces; the `apply*`
 *   helpers at the bottom exist so a PATCH allowlist can be sanitised in one
 *   line per field.
 *
 * Patterns mirror `dara-web/src/lib/validation.ts` so a value the web form
 * accepts is never rejected here, and vice-versa.
 *
 * NOTE: Ejar and bulk import insert rows directly, bypassing controllers — see
 * DARA-NOTES.md. Nothing here applies to those paths.
 */

/* ─────────────────────────── patterns ─────────────────────────── */

export const RE = {
  digits: /^\d+$/,
  /** National ID (1…) / Iqama (2…): 10 digits. */
  nationalId: /^[12]\d{9}$/,
  /** Commercial registration (السجل التجاري): 10 digits. */
  commercialReg: /^\d{10}$/,
  /** Saudi mobile in any of the four accepted forms. */
  saudiMobile: /^(?:0?5\d{8}|9665\d{8}|\+9665\d{8})$/,
  /** ZATCA VAT number: 15 digits, first and last both 3. */
  vatNumber: /^3\d{13}3$/,
  /** Saudi IBAN: SA + 22 digits (24 chars total). */
  iban: /^SA\d{22}$/,
  postalCode: /^\d{5}$/,
  /** Building number and additional number are both 4 digits. */
  fourDigits: /^\d{4}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i,
  dateOnly: /^\d{4}-\d{2}-\d{2}$/,
  /** A plain decimal — no thousands separators, no exponent. */
  decimal: /^-?\d+(\.\d+)?$/,
} as const;

/* ─────────────────────────── limits ─────────────────────────── */

/**
 * Maximum lengths for free-text fields, in characters.
 *
 * All of these columns are unbounded Postgres `text`, so nothing but this stops
 * a caller from storing a novel in `unit_number`. The numbers are generous —
 * they exist to refuse abuse, not to fight real data.
 */
export const LIMITS = {
  /** Person / company / property names. */
  name: 200,
  /** Short display name (الاسم المختصر). */
  shortName: 100,
  /** Unit number, contract number, meter numbers, plot/registry references. */
  code: 60,
  /** ID-like values (national ID, CR, unified number, tax number). */
  identifier: 32,
  /** Single-line free text: district, street, city, employer, AC type… */
  line: 200,
  /** Free-text address / a URL-ish document key. */
  address: 500,
  /** Notes and descriptions. */
  notes: 5_000,
  /** JSON-ish blobs stored as text (`amenities`, `amenitiesData`). */
  blob: 20_000,
} as const;

/**
 * Numeric bounds. Each is chosen to sit inside the column's own
 * `numeric(precision, scale)` so a value that passes here can never overflow
 * on insert — the failure mode behind the `999999999999` → 500 report.
 */
export const BOUNDS = {
  /** Money. `contracts.monthly_rent` is numeric(14,6) → 8 integer digits. */
  money: { min: 0, max: 99_999_999 },
  /** Percentages. `management_fee_percent` is numeric(5,2). */
  percent: { min: 0, max: 100 },
  /** Square metres. `units.area` is numeric(10,2). */
  area: { min: 0, max: 1_000_000 },
  /** Linear metres (facade, length, width, height). */
  length: { min: 0, max: 10_000 },
  /** Room / fixture counts: bedrooms, bathrooms, parking spaces, AC units. */
  count: { min: 0, max: 1_000 },
  /** Floor number — negative floors are basements. */
  floor: { min: -50, max: 500 },
  /** Units declared on a property. */
  totalUnits: { min: 0, max: 100_000 },
  /** Year built. */
  year: { min: 1800, max: new Date().getFullYear() + 10 },
  /** A foreign-key id (`serial` → 32-bit signed). */
  foreignKey: { min: 1, max: 2_147_483_647 },
} as const;

export type Bounds = { min: number; max: number };

/* ─────────────────────────── primitives ─────────────────────────── */

function bad(message: string): never {
  throw new BadRequestException(message);
}

/** `undefined` / `null` / blank string — i.e. "the caller said nothing". */
export function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/**
 * Coerce a scalar to its trimmed string form.
 *
 * Objects and arrays are refused rather than stringified: `{"name":{}}` used to
 * reach Postgres as `[object Object]` (or a 500), which is how a JSON object
 * ended up being accepted as a landlord name.
 */
function scalar(v: unknown, label: string): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "bigint") return String(v);
  return bad(`${label} يجب أن يكون نصاً · ${label} must be a text value`);
}

/* ─────────────────────────── text ─────────────────────────── */

/**
 * Optional free text with a length cap. Blank → `null`.
 * `max` defaults to a single line; pass a `LIMITS.*` constant otherwise.
 */
export function text(v: unknown, label: string, max: number = LIMITS.line): string | null {
  if (isBlank(v)) return null;
  const s = scalar(v, label);
  if (s.length > max) {
    bad(`${label} طويل جداً — الحد الأقصى ${max} حرفاً · ${label} must be at most ${max} characters`);
  }
  return s;
}

/** Same as `text`, but blank is refused. */
export function requiredText(v: unknown, label: string, max: number = LIMITS.line): string {
  const s = text(v, label, max);
  if (s === null) bad(`${label} مطلوب · ${label} is required`);
  return s;
}

/** Value must be one of a fixed set (mirrors a Postgres enum column). */
export function oneOf<T extends string>(v: unknown, allowed: readonly T[], label: string): T | null {
  if (isBlank(v)) return null;
  const s = scalar(v, label);
  if (!(allowed as readonly string[]).includes(s)) {
    bad(`${label} غير صالح — القيم المسموحة: ${allowed.join("، ")} · Invalid ${label}`);
  }
  return s as T;
}

/* ─────────────────────── Saudi identity fields ─────────────────────── */

/**
 * Normalise a Saudi mobile number to its canonical stored form `05XXXXXXXX`.
 *
 * Accepted inputs: `+9665XXXXXXXX`, `9665XXXXXXXX`, `05XXXXXXXX`, `5XXXXXXXX`
 * (spaces, dashes and parentheses are stripped first). Anything else is
 * refused — always exactly 9 significant digits starting with 5.
 *
 * `05XXXXXXXX` is one of the variants `phoneVariants()` in
 * `modules/auth/auth.service.ts` expands to when it looks a number up, so a
 * number stored in this form is still found by tenant/landlord OTP login
 * whatever form the caller types. Storing one canonical form also makes the
 * exact-match joins (e.g. maintenance matching `contracts.tenant_phone` to
 * `tenants.phone`) actually match.
 */
export function saudiPhone(v: unknown, label = "رقم الجوال"): string | null {
  if (isBlank(v)) return null;
  const raw = scalar(v, label).replace(/[\s\-()]/g, "");
  if (!RE.saudiMobile.test(raw)) {
    bad(`${label} غير صالح — يجب أن يبدأ بـ 05 ويتكوّن من 10 أرقام (أو +9665…) · Invalid Saudi mobile number`);
  }
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("966")) digits = digits.slice(3);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return `0${digits}`;
}

/** National ID (starts with 1) or Iqama (starts with 2) — exactly 10 digits. */
export function nationalId(v: unknown, label = "رقم الهوية / الإقامة"): string | null {
  if (isBlank(v)) return null;
  const s = scalar(v, label).replace(/[\s-]/g, "");
  if (!RE.digits.test(s) || s.length !== 10) {
    bad(`${label} يجب أن يكون 10 أرقام · ${label} must be exactly 10 digits`);
  }
  if (!RE.nationalId.test(s)) {
    bad(`${label} يجب أن يبدأ بـ 1 (هوية وطنية) أو 2 (إقامة) · ${label} must start with 1 or 2`);
  }
  return s;
}

/** Commercial registration (السجل التجاري) — exactly 10 digits. */
export function commercialReg(v: unknown, label = "السجل التجاري"): string | null {
  if (isBlank(v)) return null;
  const s = scalar(v, label).replace(/[\s-]/g, "");
  if (!RE.commercialReg.test(s)) {
    bad(`${label} يجب أن يكون 10 أرقام · ${label} must be exactly 10 digits`);
  }
  return s;
}

/**
 * The identity number of a party, validated against the party's own type: a
 * company carries a CR, an individual a national ID / Iqama. Both live in the
 * same column (`owners.id_number`, `tenants.national_id`) — that is how the
 * schema and the Ejar party mapping already work.
 *
 * When the type is unknown (a PATCH that does not send it) only the shared
 * "10 digits" rule is enforced, so an edit never fails over a field the caller
 * did not touch.
 */
export function partyIdentityNumber(v: unknown, type: unknown, label = "رقم الهوية / السجل التجاري"): string | null {
  if (isBlank(v)) return null;
  const t = typeof type === "string" ? type : null;
  if (t === "company") return commercialReg(v, "السجل التجاري");
  if (t === "individual") return nationalId(v, "رقم الهوية / الإقامة");
  const s = scalar(v, label).replace(/[\s-]/g, "");
  if (!RE.commercialReg.test(s)) {
    bad(`${label} يجب أن يكون 10 أرقام · ${label} must be exactly 10 digits`);
  }
  return s;
}

/** ZATCA VAT number — 15 digits, starting and ending with 3. */
export function vatNumber(v: unknown, label = "الرقم الضريبي"): string | null {
  if (isBlank(v)) return null;
  const s = scalar(v, label).replace(/[\s-]/g, "");
  if (!RE.digits.test(s) || s.length !== 15) {
    bad(`${label} يجب أن يكون 15 رقماً · ${label} must be exactly 15 digits`);
  }
  if (!RE.vatNumber.test(s)) {
    bad(`${label} يجب أن يبدأ وينتهي بالرقم 3 · ${label} must start and end with 3`);
  }
  return s;
}

/** Postal code (الرمز البريدي) — exactly 5 digits. */
export function postalCode(v: unknown, label = "الرمز البريدي"): string | null {
  if (isBlank(v)) return null;
  const s = scalar(v, label).replace(/[\s-]/g, "");
  if (!RE.postalCode.test(s)) {
    bad(`${label} يجب أن يكون 5 أرقام · ${label} must be exactly 5 digits`);
  }
  return s;
}

/** Building number / additional number (رقم المبنى، الرقم الإضافي) — 4 digits. */
export function fourDigitCode(v: unknown, label: string): string | null {
  if (isBlank(v)) return null;
  const s = scalar(v, label).replace(/[\s-]/g, "");
  if (!RE.fourDigits.test(s)) {
    bad(`${label} يجب أن يكون 4 أرقام · ${label} must be exactly 4 digits`);
  }
  return s;
}

/** Saudi IBAN — `SA` followed by 22 digits. Spaces are stripped, case raised. */
export function iban(v: unknown, label = "رقم الآيبان"): string | null {
  if (isBlank(v)) return null;
  const s = scalar(v, label).replace(/\s+/g, "").toUpperCase();
  if (!RE.iban.test(s)) {
    bad(`${label} يجب أن يبدأ بـ SA متبوعاً بـ 22 رقماً · ${label} must be SA followed by 22 digits`);
  }
  return s;
}

/** Email — shape and length. */
export function email(v: unknown, label = "البريد الإلكتروني"): string | null {
  if (isBlank(v)) return null;
  const s = scalar(v, label);
  if (s.length > 254) {
    bad(`${label} طويل جداً — الحد الأقصى 254 حرفاً · ${label} must be at most 254 characters`);
  }
  if (!RE.email.test(s)) {
    bad(`${label} غير صالح — الصيغة الصحيحة: name@example.com · ${label} is not a valid email address`);
  }
  return s.toLowerCase();
}

/* ─────────────────────────── numbers ─────────────────────────── */

function toNumber(v: unknown, label: string): number {
  const s = typeof v === "number" ? String(v) : scalar(v, label);
  if (!RE.decimal.test(s)) {
    bad(`${label} يجب أن يكون رقماً · ${label} must be a number`);
  }
  const n = Number(s);
  if (!Number.isFinite(n)) bad(`${label} يجب أن يكون رقماً · ${label} must be a number`);
  return n;
}

function checkBounds(n: number, label: string, b: Bounds): void {
  if (n < b.min) {
    bad(`${label} يجب ألا يقل عن ${b.min} · ${label} must be ${b.min} or greater`);
  }
  if (n > b.max) {
    bad(`${label} يجب ألا يتجاوز ${b.max} · ${label} must not exceed ${b.max}`);
  }
}

/**
 * A whole number within bounds. Returns a JS `number` — Drizzle `integer()`
 * columns want a number, not a string.
 */
export function integerIn(v: unknown, label: string, b: Bounds = BOUNDS.count): number | null {
  if (isBlank(v)) return null;
  const n = toNumber(v, label);
  if (!Number.isInteger(n)) {
    bad(`${label} يجب أن يكون رقماً صحيحاً · ${label} must be a whole number`);
  }
  checkBounds(n, label, b);
  return n;
}

/**
 * An id that is about to be used as a foreign key (or a route parameter that
 * addresses a row).
 *
 * Every such column is a `serial` → int4, so anything past 2^31 is a driver
 * error, not a lookup that misses: `parseInt("abc")` reached the query as
 * `NaN` and `9999999999` as an overflow, and both surfaced as 500s. The bound
 * was already being applied to `tenantId` and to the contract's `unitIds`;
 * this is the same rule, named once so every incoming id can use it.
 */
export function foreignKeyId(v: unknown, label: string): number | null {
  return integerIn(v, label, BOUNDS.foreignKey);
}

/** A foreign-key id that must be present — a route parameter, typically. */
export function requiredForeignKeyId(v: unknown, label: string): number {
  const n = foreignKeyId(v, label);
  if (n === null) bad(`${label} مطلوب · ${label} is required`);
  return n;
}

/**
 * A decimal within bounds, returned as a string — that is what Drizzle's
 * `numeric()` columns take, and it avoids float round-tripping on money.
 */
export function decimalIn(v: unknown, label: string, b: Bounds = BOUNDS.money): string | null {
  if (isBlank(v)) return null;
  const n = toNumber(v, label);
  checkBounds(n, label, b);
  return String(n);
}

/** A money amount: non-negative, within the column's range. */
export function money(v: unknown, label: string): string | null {
  return decimalIn(v, label, BOUNDS.money);
}

/** A percentage: 0–100. */
export function percent(v: unknown, label = "النسبة"): string | null {
  return decimalIn(v, label, BOUNDS.percent);
}

/** A boolean flag. Accepts the JSON booleans and the string forms clients send. */
export function boolish(v: unknown, label: string): boolean | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "boolean") return v;
  const s = scalar(v, label).toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return bad(`${label} يجب أن يكون true أو false · ${label} must be a boolean`);
}

/* ─────────────────────────── dates ─────────────────────────── */

/**
 * A calendar date, normalised to `YYYY-MM-DD` (what the `date` columns store).
 * Accepts a full ISO timestamp and keeps only the day part, which is how the
 * existing callers already pass dates around.
 */
export function dateOnly(v: unknown, label: string): string | null {
  if (isBlank(v)) return null;
  const s = scalar(v, label).slice(0, 10);
  if (!RE.dateOnly.test(s)) {
    bad(`${label} غير صالح — الصيغة المطلوبة YYYY-MM-DD · ${label} must be a date in YYYY-MM-DD form`);
  }
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    bad(`${label} غير صالح — تاريخ غير موجود · ${label} is not a real calendar date`);
  }
  return s;
}

/**
 * The end of a period must fall after its start. A same-day or reversed range
 * produced a live contract with an empty rent schedule that still marked the
 * unit rented, so it is refused outright.
 */
export function assertDateOrder(start: string | null, end: string | null): void {
  if (!start || !end) return;
  if (end <= start) {
    bad("تاريخ نهاية العقد يجب أن يكون بعد تاريخ البداية · Contract end date must be after the start date");
  }
}

/* ──────────────────── in-place appliers for allowlists ──────────────────── */

/**
 * The controllers build their insert/update payloads by copying an allowlist of
 * keys off the request body. These helpers sanitise one such key in place:
 * absent keys are left absent (so a PATCH still only touches what it sent),
 * blank values normalise to `null`, and anything malformed raises.
 */
function present(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key) && o[key] !== undefined;
}

export function applyWith<T>(
  o: Record<string, unknown>,
  key: string,
  fn: (v: unknown) => T,
): void {
  if (!present(o, key)) return;
  o[key] = fn(o[key]);
}

/**
 * Like `applyWith`, but a blank value REMOVES the key instead of writing
 * `null`. For `NOT NULL` columns, where `null` is a driver-level crash rather
 * than a meaningful "clear it" — leaving the column untouched is the only
 * sensible reading of `{"status": ""}`.
 */
export function applyWithNonNull<T>(
  o: Record<string, unknown>,
  key: string,
  fn: (v: unknown) => T | null,
): void {
  if (!present(o, key)) return;
  const next = fn(o[key]);
  if (next === null || next === undefined) delete o[key];
  else o[key] = next;
}

export function applyText(o: Record<string, unknown>, key: string, label: string, max: number = LIMITS.line): void {
  applyWith(o, key, (v) => text(v, label, max));
}

/** A `NOT NULL` text column: present-but-blank is refused, not stored. */
export function applyRequiredText(o: Record<string, unknown>, key: string, label: string, max: number = LIMITS.line): void {
  applyWith(o, key, (v) => requiredText(v, label, max));
}

/** A `NOT NULL` enum column — blank leaves the current value alone. */
export function applyOneOfNonNull<T extends string>(
  o: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  label: string,
): void {
  applyWithNonNull(o, key, (v) => oneOf(v, allowed, label));
}

/** A `NOT NULL` integer column — blank leaves the current value alone. */
export function applyIntNonNull(o: Record<string, unknown>, key: string, label: string, b: Bounds = BOUNDS.count): void {
  applyWithNonNull(o, key, (v) => integerIn(v, label, b));
}

/** A `NOT NULL` boolean column — blank leaves the current value alone. */
export function applyBoolNonNull(o: Record<string, unknown>, key: string, label: string): void {
  applyWithNonNull(o, key, (v) => boolish(v, label));
}

export function applyInt(o: Record<string, unknown>, key: string, label: string, b: Bounds = BOUNDS.count): void {
  applyWith(o, key, (v) => integerIn(v, label, b));
}

/** An id column pointing at another row — always `BOUNDS.foreignKey`. */
export function applyForeignKey(o: Record<string, unknown>, key: string, label: string): void {
  applyWith(o, key, (v) => foreignKeyId(v, label));
}

export function applyDecimal(o: Record<string, unknown>, key: string, label: string, b: Bounds = BOUNDS.money): void {
  applyWith(o, key, (v) => decimalIn(v, label, b));
}

export function applyMoney(o: Record<string, unknown>, key: string, label: string): void {
  applyWith(o, key, (v) => money(v, label));
}

export function applyPercent(o: Record<string, unknown>, key: string, label: string): void {
  applyWith(o, key, (v) => percent(v, label));
}

export function applyPhone(o: Record<string, unknown>, key: string, label = "رقم الجوال"): void {
  applyWith(o, key, (v) => saudiPhone(v, label));
}

export function applyEmail(o: Record<string, unknown>, key: string, label = "البريد الإلكتروني"): void {
  applyWith(o, key, (v) => email(v, label));
}

export function applyNationalId(o: Record<string, unknown>, key: string, label?: string): void {
  applyWith(o, key, (v) => nationalId(v, label));
}

export function applyVatNumber(o: Record<string, unknown>, key: string, label?: string): void {
  applyWith(o, key, (v) => vatNumber(v, label));
}

export function applyIban(o: Record<string, unknown>, key: string, label?: string): void {
  applyWith(o, key, (v) => iban(v, label));
}

export function applyPostalCode(o: Record<string, unknown>, key: string, label?: string): void {
  applyWith(o, key, (v) => postalCode(v, label));
}

export function applyFourDigitCode(o: Record<string, unknown>, key: string, label: string): void {
  applyWith(o, key, (v) => fourDigitCode(v, label));
}

export function applyOneOf<T extends string>(
  o: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  label: string,
): void {
  applyWith(o, key, (v) => oneOf(v, allowed, label));
}

export function applyBool(o: Record<string, unknown>, key: string, label: string): void {
  applyWith(o, key, (v) => boolish(v, label));
}

export function applyDate(o: Record<string, unknown>, key: string, label: string): void {
  applyWith(o, key, (v) => dateOnly(v, label));
}
