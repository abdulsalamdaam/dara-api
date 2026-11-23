/**
 * What the landlord is told when an offer for one of their units changes
 * (Nov 2026). The landlord app never shows drafts, so:
 *   - draft (or new) → sent           "a new offer was submitted"
 *   - draft (or new) → accepted / …   that status (the landlord sees it now)
 *   - visible → another visible status that status
 *   - anything → draft                nothing (it disappears from the app)
 * `expired` is derived from the date, never stored, so it raises no event.
 */
export type OfferEvent = "submitted" | "accepted" | "rejected" | "cancelled" | "reopened";

const VISIBLE = new Set(["sent", "accepted", "rejected", "cancelled"]);

export function landlordOfferEvent(prev: string | null | undefined, next: string | null | undefined): OfferEvent | null {
  if (!next || !VISIBLE.has(next) || prev === next) return null;
  const wasVisible = !!prev && VISIBLE.has(prev);
  if (next === "sent") return wasVisible ? "reopened" : "submitted";
  return next as OfferEvent;
}

export function landlordOfferMessage(
  event: OfferEvent,
  o: { number: string; clientName?: string | null; unitLabel?: string | null },
): { title: string; body: string } {
  const client = o.clientName?.trim() || "الجهة";
  const on = o.unitLabel?.trim() ? ` على ${o.unitLabel.trim()}` : "";
  switch (event) {
    case "submitted": return { title: "عرض تأجير جديد", body: `قُدِّم العرض ${o.number} لـ${client}${on}.` };
    case "accepted": return { title: "تم قبول عرض التأجير", body: `قبلت ${client} العرض ${o.number}${on}.` };
    case "rejected": return { title: "تم رفض عرض التأجير", body: `رُفض العرض ${o.number} المقدَّم لـ${client}${on}.` };
    case "cancelled": return { title: "تم إلغاء عرض التأجير", body: `أُلغي العرض ${o.number} المقدَّم لـ${client}${on}.` };
    case "reopened": return { title: "تحديث على عرض التأجير", body: `عاد العرض ${o.number} المقدَّم لـ${client}${on} إلى حالة «مُرسل».` };
  }
}
