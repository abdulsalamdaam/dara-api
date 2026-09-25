/**
 * A cheap, deterministic second line behind the prompt: posts whose text tries
 * to talk to the filter — dictate a score, claim to be official/important in
 * order to get published, or give instructions — are never auto-published.
 *
 * The prompt already tells the model to ignore such text and score it down, but
 * a model can still be argued into it. This check does not depend on the model:
 * a match holds the item as `hidden` for an admin, whatever the verdict was,
 * with `ai_reason` naming the phrase. False positives cost one admin click; a
 * false negative is a marketer's post on every landlord's feed.
 *
 * Patterns are deliberately about the post addressing its reader-as-filter
 * ("score 95", "ignore previous instructions", "mark this as relevant"), not
 * about topics — a real REGA post saying «قرار رسمي» must not trip it.
 */
const PATTERNS: Array<{ re: RegExp; label: string }> = [
  // English — scores and filter vocabulary
  { re: /(?<!credit\s)\b(?:ai[_ ]?)?score\s*(?:[:=]|of|is|as)?\s*\d{2,3}\b(?!\s*%)/i, label: "dictates a score" },
  { re: /\b(?:rate|score)\s+(?:this|it|me)\b[^.\n]{0,20}\d{2,3}\b/i, label: "dictates a score" },
  { re: /\b(?:give|assign)\s+(?:this|it|me)\s+(?:an?\s+)?(?:high\s+|top\s+)?(?:score|rating)\b/i, label: "dictates a score" },
  { re: /\b(?:ai_)?(?:relevant|ai_score|ai_category|ai_relevant)\s*[:=]/i, label: "sets output fields" },
  { re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+)?(?:previous|prior|above|earlier|your|system|editor'?s?)\s+(?:instructions?|rules|prompts?|rubric|guidelines)\b/i, label: "gives instructions to the filter" },
  { re: /\b(?:system prompt|as an ai|you are an? (?:ai|assistant|language model|editor)|dear (?:ai|bot|editor)|note to (?:the )?(?:ai|editor|model))\b/i, label: "addresses the AI" },
  { re: /\b(?:mark|classify|treat|tag|flag)\s+(?:this|it|me)\s+as\s+(?:relevant|official|important|high|top|published)\b/i, label: "asks to be classified" },
  { re: /\b(?:must|should|please)\s+(?:publish|include|feature|approve)\s+(?:this|it|me)\b/i, label: "asks to be published" },
  { re: /\b(?:this|it)\s+(?:post|tweet)?\s*(?:must|should)\s+be\s+(?:published|included|featured)\b/i, label: "asks to be published" },
  { re: /\bthis (?:post|tweet|news|announcement) is (?:official|verified|highly relevant|very important|top priority)\b/i, label: "claims its own importance" },
  { re: /<\/?\s*(?:system|assistant|instructions?|untrusted_posts)\s*>|\[\s*(?:system|inst)\s*\]|<\|/i, label: "contains prompt markup" },
  // Arabic
  { re: /(?:^|\s)(?:تجاهل|تجاهلي|انس|انسى|تخط)\s+(?:(?:كل|جميع)\s+(?:التعليمات|التوجيهات|القواعد)|(?:التعليمات|التوجيهات|القواعد)\s+(?:السابقة|أعلاه|اعلاه)|ما\s+سبق)/, label: "gives instructions to the filter" },
  { re: /(?:^|\s)(?:قيّم|قيم|امنح|اعط|أعط)(?:وا|ي)?\s+(?:هذا|هذه|الخبر|التغريدة|المنشور)\s+(?:\S+\s+){0,2}(?:ب|ب?ال)?(?:درجة|تقييم)/, label: "dictates a score" },
  { re: /(?:التقييم|تقييم|الدرجة)\s*[:=]?\s*[0-9٠-٩]{2,3}|درجة\s*[:=]\s*[0-9٠-٩]/, label: "dictates a score" },
  { re: /(?:يجب|ينبغي|الرجاء|يرجى)\s+(?:\S+\s+){0,2}نشر\s+(?:هذا|هذه|الخبر|التغريدة)/, label: "asks to be published" },
  { re: /(?:أيها|ايها|عزيزي)\s+(?:الذكاء\s+الاصطناعي|المحرر|النموذج|البوت)/, label: "addresses the AI" },
];

/** The first manipulation-like phrase in `text`, as a short label, or null. */
export function detectManipulation(text: string): string | null {
  const t = (text ?? "").normalize("NFKC");
  for (const p of PATTERNS) {
    const m = p.re.exec(t);
    if (m) return `${p.label} ("${m[0].trim().slice(0, 40)}")`;
  }
  return null;
}

/** The `ai_reason` for an item the guard held back. */
export function heldReason(label: string, aiReason: string): string {
  return `held for admin review: post text ${label} — possible manipulation. AI said: ${aiReason || "(no reason)"}`.slice(0, 500);
}
