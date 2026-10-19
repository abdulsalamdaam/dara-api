import { BadRequestException } from "@nestjs/common";

/**
 * Deed-number format (business-owner test, 19 Oct 2026: "رقم الصك يجب حده بعدد").
 * Digits only (Arabic-Indic / Persian digits are normalised to Latin first).
 * An electronic deed — the format every new Saudi deed is issued in — is
 * exactly 12 digits; older paper deeds, hujjat esthkam and registry deeds
 * vary in length, so they have no length rule (account holder, 20 Oct 2026).
 *
 * Checked on create, on bulk import, and on edit whenever the number OR the
 * type changes (the resulting number+type pair is validated). An edit that
 * touches neither leaves a legacy row alone, so rows saved before this rule
 * (and Ejar imports, which never pass through here) stay editable.
 */
export const ELECTRONIC_DEED_DIGITS = 12;

export function toLatinDigits(v: unknown): unknown {
  return typeof v === "string"
    ? v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
       .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    : v;
}

/** The error message for a bad number+type pair, or null when it is valid. */
export function deedNumberFormatError(deedNumber: string, deedType: string | null | undefined): string | null {
  if (!/^\d+$/.test(deedNumber)) {
    return "رقم الصك يقبل الأرقام فقط · Deed number must contain digits only";
  }
  if ((deedType ?? "electronic") === "electronic" && deedNumber.length !== ELECTRONIC_DEED_DIGITS) {
    return `رقم الصك الإلكتروني يتكون من ${ELECTRONIC_DEED_DIGITS} رقماً · An electronic deed number is ${ELECTRONIC_DEED_DIGITS} digits`;
  }
  return null;
}

export function assertDeedNumberFormat(deedNumber: string, deedType: string | null | undefined): void {
  const err = deedNumberFormatError(deedNumber, deedType);
  if (err) throw new BadRequestException(err);
}

/**
 * Edit rule: when the number or the type changes, validate the RESULTING
 * number+type (a type-only change from paper to electronic on an 8-digit
 * number must fail). When neither changes, a legacy row is let through.
 */
export function assertDeedUpdateFormat(
  cur: { deedNumber: string; deedType: string | null } | null | undefined,
  body: { deedNumber?: string | null; deedType?: string | null },
): void {
  if (!cur) return; // not found — the update itself 404s
  const nextNumber = body.deedNumber ?? cur.deedNumber;
  const nextType = body.deedType ?? cur.deedType;
  const numberChanged = body.deedNumber != null && body.deedNumber !== cur.deedNumber;
  const typeChanged = body.deedType != null && body.deedType !== (cur.deedType ?? "electronic");
  if (!numberChanged && !typeChanged) return;
  assertDeedNumberFormat(nextNumber, nextType);
}
