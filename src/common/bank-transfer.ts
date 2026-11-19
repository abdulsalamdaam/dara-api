/**
 * Pay by bank transfer (0099) — Dara's receiving account and the receipt rules.
 * The flow itself lives in modules/subscription/bank-transfer.module.ts; these
 * are here so `/me/subscription` can show them without importing that module.
 */

/** Dara's receiving account — Al Rajhi IBAN letter of 15 Nov 2026 (Daam Altiqnia Co., CR 7053341751). */
export const DARA_BANK = {
  bankAr: "مصرف الراجحي",
  bankEn: "Al Rajhi Bank",
  accountNameAr: "شركة دعم التقنية",
  accountNameEn: "Daam Altiqnia Co.",
  iban: "SA4380000361608011482208",
  accountNumber: "361000010006081482208",
} as const;

/** On unless BANK_TRANSFER_ENABLED=false. */
export function bankTransferEnabled(): boolean {
  return String(process.env.BANK_TRANSFER_ENABLED ?? "true").toLowerCase() !== "false";
}

/** What `/me/subscription` shows the customer. */
export function bankTransferView() {
  return { enabled: bankTransferEnabled(), ...DARA_BANK };
}

export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
const RECEIPT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

/** A receipt the customer may upload: a PDF or a photo, up to 10 MB. */
export function receiptProblem(file: { mimetype?: string; size?: number } | null | undefined): string | null {
  if (!file || !file.size) return "أرفق إيصال التحويل · Attach the transfer receipt";
  if (file.size > RECEIPT_MAX_BYTES) return "حجم الإيصال أكبر من 10 ميجابايت · The receipt is larger than 10 MB";
  if (!RECEIPT_TYPES.has(String(file.mimetype || "").toLowerCase())) return "الإيصال يجب أن يكون صورة أو PDF · The receipt must be an image or a PDF";
  return null;
}
