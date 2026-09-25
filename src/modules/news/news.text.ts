/**
 * Text normalisation + term matching for the keyword filter (lexicon.md §1–2,
 * a 1:1 port of the business spec's Python reference `kw.py`).
 *
 * Arabic headlines mix optional diacritics, the stretching tatweel, several
 * alef forms and two spellings of final ya / ta marbuta. Both the text and
 * every lexicon term go through the same `normaliseForMatch`, so «العقارية»,
 * «العَقاريّة» and «العقاريه» are the same word.
 *
 * Matching is word-boundary aware: a term matches whole words only, so «ريت»
 * does not match inside «بريطانيا» and "rent" not inside "parent". Two
 * controlled exceptions, both part of the term:
 *   - an Arabic term may carry ONE attached proclitic on its first word
 *     (و ف ب ل ك ال وال فال بال كال لل ولل فلل وب ول) — «بالإيجار» ~ «ايجار»;
 *   - a trailing `*` = any word suffix — «عقار*» matches «عقارات», «العقارية».
 */

// U+0610–U+061A, U+064B–U+065F, U+0670, U+06D6–U+06ED (tashkeel, Quranic marks), U+0640 tatweel.
export const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/** Arabic + English normalisation used on both sides of every match. */
export function normaliseForMatch(input: string): string {
  return (input ?? "")
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(TASHKEEL, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ڤ/g, "ف")
    .replace(/گ/g, "ك")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_%]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Python's Unicode `\w`, as a JS class body. */
export const WORD = "\\p{L}\\p{N}_";
const AR_CLITIC = "(?:و|ف|ب|ل|ك|ال|وال|فال|بال|كال|لل|ولل|فلل|وب|ول)?";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One lexicon term → a regex over NORMALISED text. */
export function compileTerm(term: string): RegExp {
  const star = term.endsWith("*");
  const t = normaliseForMatch(term.replace(/\*+$/, ""));
  if (!t) throw new Error(`empty lexicon term: "${term}"`);
  const arabic = /[؀-ۿ]/.test(t);
  const body = t.split(" ").map(esc).join("\\s+");
  return new RegExp(`(?<![${WORD}])${arabic ? AR_CLITIC : ""}${body}${star ? `[${WORD}]*` : ""}(?![${WORD}])`, "u");
}

/**
 * A Python regex source → a JS RegExp with the same meaning on normalised
 * text: `\b` and `\w` are Unicode-aware in Python but ASCII-only in JS.
 */
export function compilePyRegex(src: string): RegExp {
  const b = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
  return new RegExp(src.replace(/\\b/g, b).replace(/\\w/g, `[${WORD}]`), "u");
}
