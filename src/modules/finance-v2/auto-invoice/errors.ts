/** Plain Arabic and English per automatic-invoicing failure code (shown on the posting-errors list). */
export const AUTO_INVOICE_ERROR_TEXT: Record<string, { ar: string; en: string }> = {
  NOT_READY: { ar: "بيانات ناقصة تمنع إصدار الفاتورة", en: "Missing data blocks the invoice" },
  LINE_REASON: { ar: "بند بلا سبب إعفاء", en: "A line has no exemption reason" },
  DRAFT_EXISTS: { ar: "توجد مسودة فاتورة لهذا القسط — اعتمدها أو احذفها", en: "A draft invoice already covers this installment — approve or delete it" },
  APPROVE_REFUSED: { ar: "تعذّر اعتماد الفاتورة", en: "The invoice could not be approved" },
  CREATE_REFUSED: { ar: "تعذّر إنشاء الفاتورة", en: "The invoice could not be created" },
  ISSUE_FAILED: { ar: "تعذّر إصدار الفاتورة", en: "Issuing the invoice failed" },
};
