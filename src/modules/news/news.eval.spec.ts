import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scoreKeywords } from "./news.keyword-filter";

/**
 * Regression set for the free keyword filter (filter tuning, 26 Sep 2026).
 *
 * 260 public headlines, labelled by hand: everything the staging runs of
 * 25–26 Sep scored ≥ 15, the 12:50 UTC run's 47 new items, a sample of the
 * rest, and the 26 Sep feed corpus (lexicon-proto) from 15 up plus samples.
 * `label`: 1 = a Saudi real-estate story a landlord should see, 0 = not,
 * null = borderline (not counted). The headline and the first 400 characters
 * of the description are what a run scores; links are stripped.
 *
 * Before tuning: precision 0.929 (52/56), recall 0.536 (52/97).
 * After:         precision 1.000 (84/84), recall 0.866 (84/97).
 * The floors below leave room for a later lexicon change to trade a little of
 * one for the other — tighten them, never loosen them without a reason.
 */
type Labelled = { title: string; desc: string; source: string | null; label: 0 | 1 | null; origin: string };
const SET: Labelled[] = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "news-eval-labelled.json"), "utf8"));
const publishes = (title: string, desc = "", source: string | null = null) => scoreKeywords(title, desc, source).score >= 60;

describe("keyword filter — labelled evaluation set", () => {
  it("has the labelled set it claims", () => {
    assert.ok(SET.length >= 80, `${SET.length} items`);
    assert.ok(SET.filter((x) => x.label === 1).length >= 80);
    assert.ok(SET.some((x) => x.origin === "staging"));
  });

  it("precision ≥ 0.9 on what publishes, recall ≥ 0.8 on the positives", () => {
    let tp = 0, fp = 0, fn = 0;
    const fps: string[] = [];
    const fns: string[] = [];
    for (const x of SET) {
      if (x.label == null) continue;
      const k = scoreKeywords(x.title, x.desc, x.source);
      const p = k.score >= 60;
      if (p && x.label) tp++;
      else if (p) { fp++; fps.push(`${k.score} ${x.title.slice(0, 80)}`); }
      else if (x.label) { fn++; fns.push(`${k.score} ${x.title.slice(0, 80)}`); }
    }
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    assert.ok(precision >= 0.9, `precision ${precision.toFixed(3)} — false positives:\n${fps.join("\n")}`);
    assert.ok(recall >= 0.8, `recall ${recall.toFixed(3)} — false negatives:\n${fns.join("\n")}`);
  });
});

describe("keyword filter — the stories staging lost (must publish)", () => {
  for (const t of [
    "البلديات : اتفاقيات لتطوير 4 مشاريع سكنية في حيي العارض والنرجس بالرياض",
    "أساس العقارية تباشر أعمال تطوير البنية التحتية في 11 مشروعاً",
    "Al Aziziah REIT signs SAR 11.3M lease with Amlak",
    "Al Aziziah REIT signs a new lease contract with Amlak for SAR 11.28 million. The contract runs from Oct. 25, 2026, to Dec. 31, 2030, at an annual rental value of SAR 2.7 million—a 70.5% increase over the previous rent for the leased space.",
    "الأراضي تبتلع نصف السوق.. «نايت فرانك» ترصد تباطؤ العقارات السعودية",
    "«طلعت مصطفى» توقع اتفاقًا مبدئيًا مع «روشن» لتطوير مشروع متكامل في الرياض يضم أكثر من 55 ألف وحدة",
    "«البلديات»: إصدار 34 ألف رخصة بناء خلال النصف الأول من 2026",
    "RCRC closes Real Estate Balance Program applications; results due Sept. 30",
  ]) it(t.slice(0, 70), () => assert.ok(publishes(t), `${scoreKeywords(t).score}: ${scoreKeywords(t).reason}`));
});

describe("keyword filter — must stay rejected", () => {
  const cases: Array<[string, string?]> = [
    // Sakani centre events / National Day / promos
    ["بين أهازيج الفرح، وإيقاع العرضة، وأصالة الحِرف.. فعالياتنا مستمرة في مركز #سكني الشامل بجدة✨ ننتظر زيارتكم في اليوم الأخير لتشاركونا أجمل الأوقات وتعيشوا معنا تفاصيل تراثنا الأصيل 💚حياكم الله، ونسعد بلقائكم. #عزنا_بطبعنا"],
    ["على إيقاع الطبول وبريق السيوف تكمل فرحتنا 💚 جانب من تفاعل زوارنا مع العرضة السعودية في مركز #سكني الشامل بجدة، حيث يلتقي التراث بأصدق مشاعر حب الوطن. #عزنا_بطبعنا #اليوم_الوطني_السعودي"],
    ["جمعتنا فرحة الوطن.. وكمّلها شركاؤنا 🇸🇦✨", "تتكامل جهودنا في مركز #سكني الشامل بجدة لتقديم تجربة استثنائية تجمع بين كرم الضيافة والفرص والعروض الحصرية التي تلبي تطلعاتكم. ننتظركم لنشارككم أجمل اللحظات. #عزنا_بطبعنا #اليوم_الوطني_السعودي"],
    ["أبرز مختارات سكني✨ اطّلع على أفضل معروضات السوق العقاري في سكني، واستفد من خصم يصل إلى 25% من همّه."],
    ["من جيل وضع الأساس إلى جيل يكمل المسير، نفخر في الشركة السعودية لإعادة التمويل العقاري (SRC) بمساهمتنا في تطوير سوق التمويل العقاري ودعم نمو قطاع الإسكان، استمرارًا لجهود أثمرت في وطن يواصل التقدم. السعودية، استثمارها يثمر #تستثمر_للأفضل"],
    ["نلتقي بكم في معرض فيوتشر بيلد العقاري بالطائف، لنشارككم أبرز الحلول التمويلية والسكنية التي نقدمها لدعم رحلة التملك."],
    // foreign / markets / stocks
    ["Mortgage rates surpass 7% for first time since January 2025"],
    // Borderline, decided: an arbitration abroad is not Saudi property news for a landlord.
    ["Egypt defeats Saudi real estate investors’ mega-claim"],
    ["تغيرات ملكية المستثمرين الأجانب بالسوق السعودي يوم الإثنين 21 سبتمبر.. ارتفاع الملكية في 122 شركة وانخفاضها في 150 شركة"],
    ["سعر سهم دراية ريت اليوم"],
    ["سعر سهم دار الأركان اليوم"],
    ["إدانة مانشستر سيتي بـ 114 تهمة .. الهبوط والتجريد والغرامة خيارات"],
    ["ارتفاع أسعار النفط وبرنت يغلق فوق 106 دولارات"],
    ["قانون الإيجار القديم 2026.. موعد انتهاء عقود الشقق والمحلات والزيادة السنوية"],
    ["ألمانيا تقر حزمة ثانية لدعم الوقود في مواجهة أزمة الشرق الأوسط"],
    ["المركزي الروسي يُخَفض سعر صرف الروبل أمام العملات الرئيسة"],
    ["دبي تشهد تحولًا تاريخيًا في سوق الإيجارات.. العقود الجديدة تتفوق على التجديدات"],
    ["\"CISI\": الحذر يسيطر على القطاع العقاري في الإمارات"],
    ["الكويت تدين استهداف السعودية.. ومجلس الوزراء يقر مشروع التمويل العقاري"],
    ["هل نزل الدعم السكني اليوم 24 سبتمبر 2026؟"],
    ["سكني: فحص استحقاق الدعم السكني وطريقة الاعتراض على عدم الأهلية"],
    ["تغيير يهمّ المراجعين... السجل العقاري يوحّد آلية العمل"],
  ];
  for (const [t, d] of cases) it(t.slice(0, 70), () => {
    const k = scoreKeywords(t, d ?? "");
    assert.ok(k.score < 60, `${k.score}: ${k.reason}`);
  });
});

describe("weak Saudi signals", () => {
  it("count as Saudi only when the title names no foreign market", () => {
    // «البلديات» + a riyal figure, no place: Saudi.
    assert.ok(scoreKeywords("«البلديات»: إصدار 38 ألف شهادة إشغال خلال النصف الأول بنمو 55%").reason.indexOf("foreign") === -1);
    // The same weak words next to a foreign market do not rescue it.
    assert.ok(scoreKeywords("أكثر من 370 مليون ريال حجم تداول العقارات بقطر في أسبوع").score < 60);
    assert.ok(scoreKeywords("ملك البحرين يصدر مرسوماً بتعيين وكيل مساعد في وزارة الإسكان والتخطيط العمراني").score < 60);
  });
});
