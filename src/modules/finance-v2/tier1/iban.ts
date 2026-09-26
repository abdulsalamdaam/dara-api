/**
 * Saudi IBANs (DESIGN §8.2 a): `SA` + 2 check digits + 2-digit bank code + 18
 * account characters (24 in all), validated with ISO 13616 mod-97 = 1. The
 * bank code (characters 5-6) is derived for display only.
 */

/** Arabic-Indic (U+0660..) and Eastern Arabic-Indic (U+06F0..) digits → ASCII. */
export function asciiDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Upper-case, digits normalised, spaces and dashes removed. */
export function normaliseIban(raw: string): string {
  return asciiDigits(String(raw)).replace(/[\s-]/g, "").toUpperCase();
}

/** ISO 13616 mod-97 over the rearranged IBAN (letters A=10 … Z=35), in chunks so it stays exact. */
export function ibanMod97(iban: string): number {
  const re = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of re) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem;
}

/** Saudi bank codes (IBAN characters 5-6) → display names. Unknown codes show no name. */
export const SA_BANKS: Record<string, { ar: string; en: string }> = {
  "05": { ar: "مصرف الإنماء", en: "Alinma Bank" },
  "10": { ar: "البنك الأهلي السعودي", en: "Saudi National Bank" },
  "15": { ar: "بنك البلاد", en: "Bank AlBilad" },
  "20": { ar: "بنك الرياض", en: "Riyad Bank" },
  "30": { ar: "البنك العربي الوطني", en: "Arab National Bank" },
  "45": { ar: "البنك السعودي الأول", en: "Saudi Awwal Bank" },
  "55": { ar: "البنك السعودي الفرنسي", en: "Banque Saudi Fransi" },
  "60": { ar: "بنك الجزيرة", en: "Bank AlJazira" },
  "65": { ar: "البنك السعودي للاستثمار", en: "Saudi Investment Bank" },
  "80": { ar: "مصرف الراجحي", en: "Al Rajhi Bank" },
};

export type IbanCheck =
  | { ok: true; iban: string; bankCode: string; bank: { ar: string; en: string } | null }
  | { ok: false; reason: "format" | "checksum" };

export function checkSaudiIban(raw: string): IbanCheck {
  const iban = normaliseIban(raw);
  if (!/^SA[0-9]{2}[0-9]{2}[0-9A-Z]{18}$/.test(iban)) return { ok: false, reason: "format" };
  if (ibanMod97(iban) !== 1) return { ok: false, reason: "checksum" };
  const bankCode = iban.slice(4, 6);
  return { ok: true, iban, bankCode, bank: SA_BANKS[bankCode] ?? null };
}

/** The last 4 characters, for matching a payer's IBAN tail in a statement line (§8.3 a). */
export const ibanTail = (iban: string | null | undefined): string | null => (iban && iban.length >= 4 ? iban.slice(-4) : null);

/** A valid synthetic Saudi IBAN for a bank code and an 18-char account part (tests and seeds). */
export function makeSaudiIban(bankCode: string, account: string): string {
  const body = `${bankCode}${account}`;
  const rem = ibanMod97(`SA00${body}`);
  const check = String(98 - rem).padStart(2, "0");
  return `SA${check}${body}`;
}
