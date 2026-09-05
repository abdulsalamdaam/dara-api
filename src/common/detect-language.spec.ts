import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectLanguage } from "./detect-language";

/**
 * This function decides whether a string is sent to a paid provider and stored
 * as a translation. Every `null` here is a model call NOT made, and every
 * non-null is a line item a tenant can actually read. Both mistakes are
 * expensive, so the awkward cases are pinned individually rather than covered
 * by one happy-path assertion.
 */

describe("detectLanguage — the ordinary cases", () => {
  it("reads Arabic prose as Arabic", () => {
    assert.equal(detectLanguage("إيجار شهر مارس"), "ar");
    assert.equal(detectLanguage("صيانة المصعد"), "ar");
    assert.equal(detectLanguage("تأمين (وديعة)"), "ar");
  });

  it("reads English prose as English", () => {
    assert.equal(detectLanguage("Rent for March"), "en");
    assert.equal(detectLanguage("Lift maintenance"), "en");
  });

  it("is unaffected by punctuation, brackets and separators around real words", () => {
    // These carry no script, so they must neither add to a tally nor block one.
    assert.equal(detectLanguage("«عمولة إدارة» — 5%"), "ar");
    assert.equal(detectLanguage("Management fee — 5%"), "en");
  });
});

describe("detectLanguage — strings with no language at all", () => {
  /**
   * The whole reason this function exists rather than a `text ? translate() : …`.
   * A quantity column, a price and a dash are the most common values on an
   * invoice line, and each of them would otherwise be a model call per save.
   */
  it("returns null for a bare number", () => {
    assert.equal(detectLanguage("2"), null);
    assert.equal(detectLanguage("1,200.00"), null);
    assert.equal(detectLanguage("-15"), null);
  });

  it("returns null for an amount whose only letters are a currency code", () => {
    // The literal case from the brief: `SAR 1,200` reads the same to both
    // readers, so translating it is pure cost.
    assert.equal(detectLanguage("SAR 1,200"), null);
    assert.equal(detectLanguage("1,200 SAR"), null);
    assert.equal(detectLanguage("SR 500"), null);
    assert.equal(detectLanguage("USD 12.50"), null);
    assert.equal(detectLanguage("500 ر.س"), null);
    assert.equal(detectLanguage("١٢٠٠ ر.س."), null);
  });

  it("returns null for punctuation, symbols and dashes on their own", () => {
    assert.equal(detectLanguage("—"), null);
    assert.equal(detectLanguage("--"), null);
    assert.equal(detectLanguage("%"), null);
    assert.equal(detectLanguage("﷼"), null);
    assert.equal(detectLanguage("15%"), null);
  });

  it("returns null for empty and whitespace-only input", () => {
    assert.equal(detectLanguage(""), null);
    assert.equal(detectLanguage("   "), null);
    assert.equal(detectLanguage("\n\t "), null);
  });

  it("returns null for anything that is not a string", () => {
    // `notes` is nullable and `items[].description` comes out of jsonb, so a
    // null, a number or an object genuinely arrives here.
    assert.equal(detectLanguage(null), null);
    assert.equal(detectLanguage(undefined), null);
    assert.equal(detectLanguage(1200 as unknown), null);
    assert.equal(detectLanguage({} as unknown), null);
  });

  it("returns null for emoji with no words around them", () => {
    // An emoji is a symbol, not a letter — nothing to translate, and the
    // surrogate pair must not be miscounted as two mystery characters either.
    assert.equal(detectLanguage("👍"), null);
    assert.equal(detectLanguage("✅ ✅"), null);
    assert.equal(detectLanguage("🏠🔑"), null);
  });

  it("returns null for a single letter — too short to judge", () => {
    assert.equal(detectLanguage("A"), null);
    assert.equal(detectLanguage("ب"), null);
    assert.equal(detectLanguage("A - 2"), null);
  });

  it("returns null for a string whose only letters are in a third script", () => {
    // We translate between exactly two languages. Russian is not one of them,
    // and guessing "en" because it is not Arabic would produce nonsense.
    assert.equal(detectLanguage("Привет"), null);
    assert.equal(detectLanguage("日本語"), null);
  });

  it("returns null for Arabic-Indic digits, which live in the Arabic block", () => {
    // ٠١٢ are `Script=Arabic` but category Nd. Counting them as letters would
    // make every Arabic-numbered quantity a translatable Arabic string.
    assert.equal(detectLanguage("١٢٣"), null);
    assert.equal(detectLanguage("٢٠٢٦/٠٣/٠١"), null);
  });

  it("returns null for tatweel padding, which Unicode calls a letter", () => {
    // U+0640 is category Lm, so `\p{L}` matches it. It is a drawing device
    // with no sound; a row of them is not a word.
    assert.equal(detectLanguage("ـــــ"), null);
  });
});

describe("detectLanguage — Arabic text carrying Latin digits and codes", () => {
  /**
   * The single most common shape in this database. Every installment
   * description, every dated note and every unit reference is Arabic prose
   * with Western digits in it, and reading those digits as "Latin" would flip
   * short descriptions to English and translate them backwards.
   */
  it("still reads as Arabic when Western digits are embedded", () => {
    assert.equal(detectLanguage("دفعة 2 من 12"), "ar");
    assert.equal(detectLanguage("إيجار الوحدة 14 لشهر 03/2026"), "ar");
    assert.equal(detectLanguage("عمولة إدارة بنسبة 5% على الفاتورة INV-000123"), "ar");
  });

  it("still reads as Arabic when an amount and its code are embedded", () => {
    assert.equal(detectLanguage("إيجار شهر مارس 1,200 SAR"), "ar");
  });

  it("still reads as Arabic with an emoji attached", () => {
    assert.equal(detectLanguage("تم الاستلام 👍"), "ar");
  });
});

describe("detectLanguage — mixed script", () => {
  it("keeps Arabic that carries a Latin fragment", () => {
    // A brand or a unit code sitting inside an Arabic line is ordinary here,
    // and must not cost the string its language: calling this English would
    // translate it OUT of a language it was never in, and show the Arabic
    // reader a machine round-trip of their own text.
    assert.equal(detectLanguage("صيانة مكيف Samsung"), "ar");
    assert.equal(detectLanguage("إيجار شقة في برج Rafal"), "ar");
    assert.equal(detectLanguage("وحدة A"), "ar");
  });

  it("refuses to guess when the two scripts are genuinely mixed", () => {
    // «Rent for the villa in الرياض» is English with an Arabic place name;
    // «شقة Riverside Residences Compound» is Arabic with a Latin property
    // name. The first has MORE Arabic than the second, so no ratio can tell
    // them apart — only meaning can, and this function does not have any.
    //
    // So neither is guessed. The cost is a missed translation on a mixed
    // line; the cost of guessing wrong is a confident translation in the
    // wrong direction, which is the failure nobody notices.
    assert.equal(detectLanguage("Rent for the villa in الرياض"), null);
    assert.equal(detectLanguage("شقة Riverside Residences Compound"), null);
    assert.equal(detectLanguage("Unit ب"), null);
  });

  it("gives an exact tie to Arabic", () => {
    // Documented and deliberate: ties are arbitrary either way, and in an
    // Arabic-first product a Latin fragment inside Arabic is far more common
    // than the reverse. `تأمين` and `Depos` are five letters each.
    assert.equal(detectLanguage("تأمين Depos"), "ar");
  });

  it("never mistakes an ordinary Arabic word for a currency amount", () => {
    // `ر.س` used to be matched as "a ر, optional space, a س", which ate two
    // letters out of «مارس», reduced «درس» to one letter, and left «رسوم» as
    // «وم». Beside a Latin word the remains then counted as English.
    for (const word of ["مارس", "درس", "رسوم", "أجر سنوي"]) {
      assert.equal(detectLanguage(word), "ar", word);
    }
    // The symbol itself, with its dot, is still stripped.
    assert.equal(detectLanguage("500 ر.س"), null);
    assert.equal(detectLanguage("1200 ريال"), "ar");
  });
});

describe("detectLanguage — currency-code stripping does not eat real words", () => {
  it("leaves a code alone when it is part of a longer word", () => {
    // `SR` inside `SRC`, `SAR` inside `SARAH`: stripping those would silently
    // shorten real English text.
    assert.equal(detectLanguage("SRC unit"), "en");
    assert.equal(detectLanguage("SARAH"), "en");
  });

  it("leaves the Arabic word for riyal alone", () => {
    // «ريال» is a word, not a symbol — `1,200 riyals` is a real translation.
    assert.equal(detectLanguage("1200 ريال سعودي"), "ar");
  });

  it("still finds the language when only the amount is stripped", () => {
    assert.equal(detectLanguage("Deposit SAR 5,000"), "en");
  });
});
