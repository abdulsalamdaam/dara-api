import { BadRequestException } from "@nestjs/common";
import type { RentalOfferFee, RentalOfferUnitSnapshot } from "@dara/database";

/**
 * Body → row for a rental offer. Pure, so it is tested without a database.
 *
 * Every field is optional on PATCH; `partial=false` (create) additionally
 * requires a client name. Values the table constrains (status, frequency,
 * commission type, duration, grace months) are checked here so a bad request is
 * a 400 with a reason rather than a constraint-violation 500.
 */

export const OFFER_STATUSES = ["draft", "sent", "accepted", "rejected", "cancelled"] as const;
/** The contract wizard's cycle keys, minus monthly and custom (an offer quotes in periods). */
export const OFFER_FREQUENCIES = ["quarterly", "semi_annual", "annual"] as const;
export const FEE_RECURRENCES = ["one_time", "quarterly", "semi_annual", "annual"] as const;
export const ESCALATION_TYPES = ["percent", "amount"] as const;
export const COMMISSION_TYPES = ["none", "percent", "amount"] as const;

const MAX_TEXT = 500;
const MAX_LONG_TEXT = 4000;
const MAX_TERMS = 40;
const MAX_FEES = 20;
/**
 * The grace period EXTENDS the lease (grace + duration months, full rent
 * billed after it), so it is no longer bounded by the duration — only by a
 * sane cap. Same cap as the web's MAX_GRACE_MONTHS and the 0089 constraint.
 */
export const MAX_GRACE_MONTHS = 36;

const bad = (ar: string, en: string) => new BadRequestException(`${ar} · ${en}`);

function text(v: unknown, max = MAX_TEXT): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function money(v: unknown, field: string): string {
  if (v === null || v === undefined || v === "") return "0";
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e11) throw bad(`قيمة غير صالحة: ${field}`, `Invalid amount: ${field}`);
  return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
}

function int(v: unknown, field: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`قيمة غير صالحة: ${field}`, `Invalid value: ${field}`);
  return n;
}

function isoDate(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad(`تاريخ غير صالح: ${field}`, `Invalid date: ${field}`);
  return s;
}

function oneOf<T extends readonly string[]>(v: unknown, allowed: T, field: string): T[number] {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw bad(`قيمة غير صالحة: ${field}`, `Invalid value: ${field}`);
  }
  return v as T[number];
}

function fees(v: unknown): RentalOfferFee[] {
  if (!Array.isArray(v)) throw bad("الرسوم غير صالحة", "Invalid fees");
  if (v.length > MAX_FEES) throw bad("عدد الرسوم كبير جداً", "Too many fees");
  return v
    .map((f: any): RentalOfferFee => ({
      typeKey: text(f?.typeKey, 100),
      label: text(f?.label, 200) ?? "",
      amount: Number(money(f?.amount, "fee")),
      recurrence: (FEE_RECURRENCES as readonly string[]).includes(f?.recurrence) ? f.recurrence : "one_time",
      vat: !!f?.vat,
    }))
    .filter((f) => f.label || f.typeKey || f.amount > 0);
}

function terms(v: unknown): string[] {
  if (!Array.isArray(v)) throw bad("الشروط غير صالحة", "Invalid terms");
  const out = v.map((t) => text(t, 1000)).filter((t): t is string => !!t);
  if (out.length > MAX_TERMS) throw bad("عدد الشروط كبير جداً", "Too many terms");
  return out;
}

const SNAPSHOT_KEYS = ["propertyName", "unitNumber", "unitType", "area", "city", "district", "street", "usage", "usageKey", "deedNumber", "description"] as const;

function snapshot(v: unknown): RentalOfferUnitSnapshot {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const src = v as Record<string, unknown>;
  const out: RentalOfferUnitSnapshot = {};
  for (const k of SNAPSHOT_KEYS) {
    const val = text(src[k], k === "description" ? 1000 : 200);
    if (val) (out as any)[k] = val;
  }
  if (src.floor !== undefined && src.floor !== null && src.floor !== "" && Number.isInteger(Number(src.floor))) {
    out.floor = Number(src.floor);
  }
  return out;
}

export type OfferWrite = Record<string, unknown>;

export function normalizeOffer(body: any, partial: boolean): OfferWrite {
  const b = body && typeof body === "object" ? body : {};
  const out: OfferWrite = {};
  const has = (k: string) => b[k] !== undefined;

  if (!partial || has("clientName")) {
    const name = text(b.clientName);
    if (!name) throw bad("اسم الجهة المستأجرة مطلوب", "Client name is required");
    out.clientName = name;
  }
  for (const k of ["title", "landlordName", "clientCr", "clientVat", "clientContactName", "clientContactTitle", "clientPhone", "clientEmail", "clientAddress"] as const) {
    if (has(k)) out[k] = text(b[k]);
  }
  if (has("notes")) out.notes = text(b.notes, MAX_LONG_TEXT);
  if (has("issueDate")) out.issueDate = isoDate(b.issueDate, "issueDate") ?? undefined;
  if (has("validUntil")) out.validUntil = isoDate(b.validUntil, "validUntil");
  if (has("startDate")) out.startDate = isoDate(b.startDate, "startDate");
  if (has("annualRent")) out.annualRent = money(b.annualRent, "annualRent");
  if (has("depositAmount")) out.depositAmount = money(b.depositAmount, "depositAmount");
  if (has("commissionValue")) out.commissionValue = money(b.commissionValue, "commissionValue");
  if (has("escalationPercent")) {
    const e = Number(b.escalationPercent || 0);
    if (!Number.isFinite(e) || e < 0 || e > 100) throw bad("نسبة الزيادة غير صالحة", "Invalid escalation");
    out.escalationPercent = e.toFixed(2);
  }
  if (has("escalationType")) out.escalationType = oneOf(b.escalationType, ESCALATION_TYPES, "escalationType");
  if (has("escalationAmount")) out.escalationAmount = money(b.escalationAmount, "escalationAmount");
  if (has("durationMonths")) out.durationMonths = int(b.durationMonths, "durationMonths", 1, 360);
  if (has("freeMonths")) {
    const g = Number(b.freeMonths || 0);
    if (!Number.isInteger(g) || g < 0 || g > MAX_GRACE_MONTHS) {
      throw bad(`فترة السماح يجب ألا تتجاوز ${MAX_GRACE_MONTHS} شهراً`, `Grace period must be 0–${MAX_GRACE_MONTHS} months`);
    }
    out.freeMonths = g;
  }
  if (has("paymentFrequency")) out.paymentFrequency = oneOf(b.paymentFrequency, OFFER_FREQUENCIES, "paymentFrequency");
  if (has("commissionType")) out.commissionType = oneOf(b.commissionType, COMMISSION_TYPES, "commissionType");
  if (has("status")) out.status = oneOf(b.status, OFFER_STATUSES, "status");
  if (has("vatApplies")) out.vatApplies = !!b.vatApplies;
  if (has("commissionVat")) out.commissionVat = !!b.commissionVat;
  if (has("language")) out.language = b.language === "en" ? "en" : "ar";
  if (has("fees")) out.fees = fees(b.fees);
  if (has("terms")) out.terms = terms(b.terms);
  if (has("unitSnapshot")) out.unitSnapshot = snapshot(b.unitSnapshot);

  if (out.commissionType === "percent" && Number(out.commissionValue ?? 0) > 100) {
    throw bad("نسبة العمولة يجب ألا تتجاوز 100%", "Commission percent must not exceed 100");
  }
  if (out.issueDate && out.validUntil && String(out.validUntil) < String(out.issueDate)) {
    throw bad("تاريخ انتهاء العرض قبل تاريخ إصداره", "Valid-until is before the issue date");
  }
  return out;
}

/** `RO-2026-0007` → 7 for the given year prefix; anything else → 0. */
export function offerSeq(number: string, prefix: string): number {
  if (!number.startsWith(prefix)) return 0;
  const n = Number(number.slice(prefix.length));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export const offerPrefix = (year: number) => `RO-${year}-`;
export const formatOfferNumber = (year: number, seq: number) => `${offerPrefix(year)}${String(seq).padStart(4, "0")}`;
