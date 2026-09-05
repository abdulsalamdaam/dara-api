/**
 * Which language a user typed a piece of free text in — decided by looking at
 * the characters, not by asking a model.
 *
 * The rule the translation layer runs on is "if it is Arabic produce English,
 * if it is English produce Arabic", so this function is the thing that decides
 * whether a provider is called at all. Getting it wrong is expensive in both
 * directions: a false positive spends a model call (and stores a translation)
 * on a line reading `2` or `SAR 1,200`, and a false negative leaves a real
 * sentence untranslated forever. It is also the cheapest piece here to test,
 * which is why it is pure, dependency-free and specced hard in
 * `detect-language.spec.ts`.
 *
 * Deterministic and offline on purpose. A model call to find out whether to
 * make a model call would double the cost and add a failure mode to a decision
 * that character counting answers correctly.
 */

export type DetectedLanguage = "ar" | "en";

/**
 * Below this many letters in the winning script there is nothing to judge from.
 *
 * Two, not one: a lone letter is almost always an initial, a bullet or a
 * leftover from a code, while two already distinguishes «لا» from `no`. Both of
 * those are worth translating; `A` is not.
 */
const MIN_LETTERS = 2;

/**
 * Alphabetic currency codes, removed before anything is counted.
 *
 * `SAR 1,200` is an AMOUNT. It has no language — it reads identically to both
 * users and there is nothing for a translator to do — but the three Latin
 * letters in `SAR` would otherwise make it English and send a price to the
 * provider on every invoice line in the system. Bounded by "not adjacent to
 * another letter" rather than `\b`, so `SR` is stripped from `SR 500` and left
 * alone inside `SRC`.
 *
 * `ريال` is deliberately NOT in this list: it is an ordinary Arabic word and
 * «1,200 ريال» → `1,200 riyals` is a translation worth having. `ر.س` is the
 * symbol form and is stripped.
 */
const CURRENCY_CODES =
  /(?<![\p{L}\p{M}])(?:SAR|SR|USD|AED|EUR|GBP|KWD|QAR|BHD|OMR|JOD|EGP|TRY|CHF|CAD|AUD|JPY|CNY|INR)(?![\p{L}\p{M}])/giu;

/**
 * The Arabic riyal symbol written as letters: `ر.س`, `ر.س.`, `﷼`.
 *
 * The boundary guards and the REQUIRED dot are both load-bearing. Without
 * them this pattern is just "a ر, then optional space, then a س", which
 * matches inside perfectly ordinary words: it ate two letters out of «مارس»
 * (March), turned «درس» into a single letter, and cut «رسوم» down to «وم».
 * Text that then sat beside a Latin word was counted as English and sent to
 * be translated *out of* a language it was never in.
 */
const ARABIC_CURRENCY_SYMBOL =
  /(?<![\p{L}\p{M}])(?:ر\s*\.\s*س\s*\.?|﷼)(?![\p{L}\p{M}])/gu;

/** Any letter, in any script. Excludes digits, marks, punctuation, symbols, emoji. */
const IS_LETTER = /\p{L}/u;
const IS_ARABIC = /\p{Script=Arabic}/u;
const IS_LATIN = /\p{Script=Latin}/u;

/**
 * ARABIC TATWEEL (U+0640) — a kashida, drawn to stretch a word to fit a line.
 * Unicode classifies it as a modifier LETTER, so `\p{L}` says yes and a row of
 * them would read as Arabic prose. It carries no sound and no meaning.
 */
const TATWEEL = "ـ";

/**
 * Share of letters that must be Arabic before a mixed string counts as Arabic.
 *
 * Deliberately low, and deliberately asymmetric with the Latin side. A Latin
 * fragment inside Arabic — a brand, a unit code, «برج Rafal» — is ordinary
 * here; Arabic inside an otherwise English sentence is not. So a minority of
 * Arabic letters still carries the verdict, while a lone Arabic word beside a
 * long Latin name («شقة Riverside Residences Compound») does not make the
 * string English either: it makes it mixed, and mixed text is left alone.
 */
const ARABIC_SHARE = 0.30;

/**
 * The language of `text`, or `null` when there is nothing worth translating.
 *
 * `null` means: not a string, empty, whitespace only, digits only (Latin or
 * Arabic-Indic), punctuation/currency/symbols/emoji only, or fewer than
 * `MIN_LETTERS` letters to go on.
 *
 * Mixed text is decided by MAJORITY of letters, and a tie goes to Arabic. Ties
 * are rare and arbitrary either way; Arabic wins them because this is an
 * Arabic-first product where Latin fragments (brand names, unit codes, «Split»,
 * «VIP») are routinely embedded in Arabic sentences far more often than the
 * reverse. Latin digits inside Arabic text — «دفعة 2 من 12», which is how
 * almost every installment description is written here — are not letters at
 * all, so they never pull the verdict.
 */
export function detectLanguage(text: unknown): DetectedLanguage | null {
  if (typeof text !== "string" || text.length === 0) return null;

  // Amounts are stripped before counting, never after: the point is that the
  // letters inside a currency code must not reach the tally at all.
  const stripped = text.replace(CURRENCY_CODES, " ").replace(ARABIC_CURRENCY_SYMBOL, " ");

  let arabic = 0;
  let latin = 0;
  // Iterated by code point (`for…of` on a string), so an astral character —
  // an emoji, or Arabic mathematical letters — is examined once rather than as
  // two lone surrogates that match nothing.
  for (const ch of stripped) {
    if (ch === TATWEEL) continue;
    if (!IS_LETTER.test(ch)) continue;
    if (IS_ARABIC.test(ch)) arabic += 1;
    else if (IS_LATIN.test(ch)) latin += 1;
    // A letter in any third script (Cyrillic, Han, …) is counted for neither.
    // We translate between exactly two languages; anything else is out of
    // scope and must not be guessed at.
  }

  // A plain majority was the wrong rule. One Arabic word beside a long Latin
  // brand — «شقة Riverside Residences Compound», «دار Property Management
  // Services» — loses the vote, and the text is then translated in the wrong
  // direction: an Arabic reader is shown a machine round-trip of Arabic while
  // the English reader gets the untouched Arabic. That is worse than leaving
  // it alone.
  //
  // So a verdict now requires DOMINANCE, not a majority. Genuinely mixed text
  // returns null and is never sent anywhere: it is the case machine
  // translation handles worst, and the case where being wrong is least
  // visible to whoever typed it.
  const letters = arabic + latin;
  if (letters < MIN_LETTERS) return null;
  if (arabic > 0 && arabic / letters >= ARABIC_SHARE) return "ar";
  // No Arabic at all: plain Latin text, safe to call English.
  if (arabic === 0) return "en";
  // Some Arabic, but too little to call the string Arabic — and its presence
  // means we cannot call it English either. Mixed: translate nothing.
  return null;
}
