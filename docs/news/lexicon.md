# Keyword filter: lexicon and scoring spec (v2, free)

This spec is for `news.keyword-filter.ts` and `news.lexicon.ts` (CONTRACT-v2-FREE §Filter).

A working Python reference lives in `lexicon-proto/` (`kw.py` is the scorer, `lex.py` the data, and `items.json` holds 608 real items fetched from the feeds in `rss-feeds.json` on 2026-09-26). Every score in §6 was produced by that code, so port it 1:1 and reuse §6 as unit-test fixtures. Run it with `python3 kw.py items.json | sort -rn`.

At the time of checking, 111 of the 593 unique items scored 60 or more, which is about 19%.

---

## 1. Normalisation (apply to lexicon terms, title and description)

1. Convert Arabic-Indic digits (٠-٩ and ۰-۹) to ASCII digits.
2. Strip tashkeel `[ؐ-ًؚ-ٰٟۖ-ۭ]` and tatweel `ـ`.
3. Unify letters: `أ إ آ ٱ` → `ا`, `ة` → `ه`, `ى` → `ي`, `ؤ` → `و`, `ئ` → `ي`, `ڤ` → `ف`, `گ` → `ك`.
4. Lowercase the text.
5. Replace every character that is not a letter, digit, `_` or `%` with a space, then collapse runs of spaces. In JS: `/[^\p{L}\p{N}_%]+/gu`.

**Title cleaning happens before normalisation, and it is required:**

- **Google News suffix.** Each Google News item has a `<source>` element. If the title ends with `" - " + source`, cut that suffix off. Do not use a regex split on " - ". Publisher names contain dashes, and Argaam's name contains «السعودي», which would otherwise count as a Saudi signal on every Argaam item, including Dubai and Qatar stories.
- **SPA prefix.** Drop a leading `عام / `, `اقتصادي / `, `اليوم الوطني / ` or `منوعات عالمية / `.
- **Google News description.** For Google News items, ignore `<description>`. It only repeats the title and the source. For publisher feeds, use the description with HTML stripped and entities decoded.

## 2. Matching

- Each term is a phrase of one or more words, already in normalised form. A trailing `*` means "any word suffix" (`\p{L}*`).
- **Arabic terms** may carry one attached proclitic on the first word: `(?:و|ف|ب|ل|ك|ال|وال|فال|بال|كال|لل|ولل|فلل|وب|ول)?`. Words inside a phrase are joined by `\s+`.
- **Boundaries.** Use `(?<![\p{L}\p{N}_])` before the term and `(?![\p{L}\p{N}_])` after it, so `ريت` does not match inside `بريطانيا`.
- **English terms** get no proclitic, and matching is case-insensitive because the text is already lowercased.
- **Title vs description.** A term found in the title counts at its full weight. A term found only in the description counts at half weight.
- **Overlapping matches.** Sort all hits by weight, descending. Drop any hit whose span overlaps a hit you have already kept in the same field. For example, `عقار*` inside `السجل العقاري` counts once, as the heavier term.
- **Precompile once.** Compile one RegExp per term (flag `u`) when the module loads.

## 3. Scoring (0–100)

```
if PAGE_RE matches the cleaned title        → score 0  ("blocked: index page")
if any BLOCK_RE matches title or desc       → score 0  ("blocked: ...")
hits  = positive matches after the overlap dedupe, sorted by effective weight desc
if hits is empty                            → score 0, category 'other'

P     = Σ hits[i].w × DIM[i],  DIM = [1.0, 0.6, 0.4, 0.25, 0.25, …]   (diminishing returns)

saudi   = any SAUDI_GEO term in title or desc  OR  any kept hit with sa:true
foreign = any FOREIGN_GEO term in the title
G     = saudi ? +10 : (foreign ? −60 : −10)

D     = +8 if DATA_RE matches the title (a figure with a unit: %, مليار, مليون, ألف, ريال, قطعة, وحدة, SAR, bn …)
N     = Σ penalty of every NEGATIVE term found in title or desc
        + 40 if the cleaned title has fewer than 4 words

score = clamp(round(P + G + D − N), 0, 100)
relevant = score ≥ 60
```

**Category.** Sum the effective weights of the kept hits per category and pick the highest. Break ties in this order: `regulation > rental > finance > housing > market > projects > other`.

**Tags.** Take the `tag` of each kept hit in hit order, de-duplicate, and keep at most 5. If you want a city tag, append it when a SAUDI_GEO city matched (`riyadh`, `jeddah` and so on).

**Reason.** Use `matched: t1, t2, t3[ | neg: n1, n2][ | foreign: x]`, listing up to 5 terms.

**Output.** Everything else follows CONTRACT-v2-FREE:

- `title_<lang>` is the cleaned title. Detect the language as `ar` if more than 30% of its letters are Arabic.
- `summary_<lang>` is the first ~220 characters of the cleaned description. It is empty for Google News items.
- Set `ai_model` / `filter_kind` to `'keyword'`.

### Why these numbers

- A single Saudi-only entity (weight 50–60) plus the +10 Saudi bonus clears 60 on its own, e.g. «هيئة العقار» or «منصة إيجار».
- A generic term (`عقار*` at 20) plus Saudi geography reaches only ~38, so it needs a second real signal.
- Foreign stories carry −60, which sinks even strong terms: «ضريبة التصرفات العقارية في مصر» scores 0.
- The −10 for "no geography" pushes out the many wire items that never say where they are.
- Diminishing returns stop a headline stuffed with generic words from adding its way to 100.

## 4. Weight bands (for anyone editing the lexicon)

| Weight | Meaning | Examples |
|---|---|---|
| 50–60 | Saudi-only entity or rule that changes landlord money or obligations | هيئه العقار, منصه ايجار, تثبيت الايجار*, الاراضي البيضاء, العقارات الشاغره, الصندوق العقاري |
| 35–49 | Strong topical phrase | التمويل العقاري, التسجيل العيني, زياده الايجار*, تكاليف البناء, تملك الاجانب |
| 20–34 | Topical but ambiguous | عقار*, ايجار*, المستاجر*, روشن, سكني |
| 5–19 | Context or modifier (adds only alongside something stronger) | لايح*, رسوم, قرار, مهله, غرام*, مشروع*, وحدات |

`sa: true` marks terms that are proof on their own that the story is Saudi. Do not add a term that other Arab states also use to `sa`. «ضريبة التصرفات العقارية» and «السجل العقاري» exist in Egypt and Lebanon, and «التمويل العقاري» in Kuwait.

## 5. Lexicon data (paste into `news.lexicon.ts`)

Terms are already normalised. Per term: `t` = term, `w` = weight, `tag` = English tag (optional), `sa` = implies Saudi.

### `regulation`

```ts
regulation: [
  { t: 'الهيئه العامه للعقار', w: 55, tag: 'rega', sa: true },
  { t: 'هيئه العقار', w: 55, tag: 'rega', sa: true },
  { t: 'real estate general authority', w: 55, tag: 'rega', sa: true },
  { t: 'rega', w: 35, tag: 'rega' },
  { t: 'السجل العقاري', w: 50, tag: 'real-estate-registry' },
  { t: 'التسجيل العيني', w: 45, tag: 'real-estate-registry' },
  { t: 'real estate registry', w: 50, tag: 'real-estate-registry' },
  { t: 'التصرفات العقاريه', w: 45, tag: 'rett' },
  { t: 'ضريبه التصرفات العقاريه', w: 60, tag: 'rett' },
  { t: 'rett', w: 50, tag: 'rett' },
  { t: 'real estate transaction tax', w: 60, tag: 'rett' },
  { t: 'الاراضي البيضاء', w: 55, tag: 'white-land', sa: true },
  { t: 'الارض البيضاء', w: 55, tag: 'white-land', sa: true },
  { t: 'رسوم الاراضي', w: 50, tag: 'white-land', sa: true },
  { t: 'white land*', w: 55, tag: 'white-land', sa: true },
  { t: 'العقارات الشاغره', w: 55, tag: 'vacant-property-fee', sa: true },
  { t: 'vacant real estate', w: 55, tag: 'vacant-property-fee' },
  { t: 'vacant property', w: 50, tag: 'vacant-property-fee' },
  { t: 'الوساطه العقاريه', w: 40, tag: 'brokerage' },
  { t: 'رخصه فال', w: 45, tag: 'fal-license', sa: true },
  { t: 'نظام الوساطه', w: 45, tag: 'brokerage' },
  { t: 'البيع على الخارطه', w: 45, tag: 'off-plan' },
  { t: 'وافي', w: 30, tag: 'off-plan', sa: true },
  { t: 'off plan', w: 35, tag: 'off-plan' },
  { t: 'تملك الاجانب', w: 45, tag: 'foreign-ownership' },
  { t: 'للاجانب', w: 20, tag: 'foreign-ownership' },
  { t: 'foreign buyers', w: 40, tag: 'foreign-ownership' },
  { t: 'foreign real estate ownership', w: 45, tag: 'foreign-ownership' },
  { t: 'تملك غير السعوديين', w: 40, tag: 'foreign-ownership' },
  { t: 'foreign ownership', w: 30, tag: 'foreign-ownership' },
  { t: 'non saudi buyers', w: 40, tag: 'foreign-ownership', sa: true },
  { t: 'ملاك العقارات', w: 30, tag: 'owners-associations' },
  { t: 'اتحاد الملاك', w: 45, tag: 'owners-associations' },
  { t: 'ادارة وصيانه', w: 10 },
  { t: 'قواعد', w: 10 },
  { t: 'تنظم', w: 8 },
  { t: 'يعتمد', w: 8 },
  { t: 'الوزراء', w: 10 },
  { t: 'property registration', w: 45, tag: 'real-estate-registry' },
  { t: 'الاعلانات العقاريه', w: 35, tag: 'brokerage' },
  { t: 'وزاره العدل', w: 15, tag: 'moj' },
  { t: 'الصكوك العقاريه', w: 35, tag: 'deeds' },
  { t: 'صك*', w: 8 },
  { t: 'لايح*', w: 15 },
  { t: 'اللايحه التنفيذيه', w: 20 },
  { t: 'مسوده', w: 12 },
  { t: 'نظام', w: 6 },
  { t: 'قرار', w: 8 },
  { t: 'مجلس الوزراء', w: 15 },
  { t: 'رسوم', w: 12 },
  { t: 'غرام*', w: 12 },
  { t: 'مخالف*', w: 6 },
  { t: 'حصر', w: 10 },
  { t: 'مهله', w: 12 },
  { t: 'العقوبات', w: 12 },
  { t: 'ملاك الاراضي', w: 25, tag: 'white-land' },
  { t: 'الاراضي الفضاء', w: 35, tag: 'white-land' },
  { t: 'التوازن العقاري', w: 45, tag: 'rcrc-balance', sa: true },
  { t: 'real estate balance', w: 45, tag: 'rcrc-balance', sa: true },
  { t: 'الزام*', w: 10 },
  { t: 'استطلاع', w: 6 },
  { t: 'regulation*', w: 12 },
  { t: 'law', w: 8 },
  { t: 'fee*', w: 10 },
  { t: 'tax', w: 12 },
],
```

### `rental`

```ts
rental: [
  { t: 'منصه ايجار', w: 60, tag: 'ejar', sa: true },
  { t: 'ejar', w: 55, tag: 'ejar', sa: true },
  { t: 'تثبيت الايجار*', w: 60, tag: 'rent-freeze', sa: true },
  { t: 'rent freeze', w: 60, tag: 'rent-freeze', sa: true },
  { t: 'زياده الايجار*', w: 45, tag: 'rent-increase' },
  { t: 'العلاقه الايجاريه', w: 50, tag: 'tenancy-law' },
  { t: 'عقد ايجار*', w: 30, tag: 'lease' },
  { t: 'عقود الايجار', w: 30, tag: 'lease' },
  { t: 'عقود ايجار', w: 30, tag: 'lease' },
  { t: 'ايجار*', w: 20, tag: 'rent' },
  { t: 'الايجارات السكنيه', w: 45, tag: 'residential-rent' },
  { t: 'الايجارات التجاريه', w: 40, tag: 'commercial-rent' },
  { t: 'المستاجر*', w: 25, tag: 'tenants' },
  { t: 'المؤجر*', w: 30, tag: 'landlords' },
  { t: 'المستاجرين', w: 25, tag: 'tenants' },
  { t: 'المالك والمستاجر', w: 40, tag: 'tenancy-law' },
  { t: 'اخلاء', w: 20, tag: 'eviction' },
  { t: 'تاجير', w: 12, tag: 'rent' },
  { t: 'rent', w: 20, tag: 'rent' },
  { t: 'rents', w: 25, tag: 'rent' },
  { t: 'rental*', w: 25, tag: 'rent' },
  { t: 'lease*', w: 15, tag: 'lease' },
  { t: 'tenant*', w: 25, tag: 'tenants' },
  { t: 'landlord*', w: 30, tag: 'landlords' },
  { t: 'rent burden', w: 40, tag: 'rent' },
  { t: 'ايجار شهري', w: 20, tag: 'rent' },
  { t: 'الدفع الشهري للايجار', w: 35, tag: 'rent' },
],
```

### `finance`

```ts
finance: [
  { t: 'صندوق التنميه العقاريه', w: 50, tag: 'redf', sa: true },
  { t: 'الصندوق العقاري', w: 50, tag: 'redf', sa: true },
  { t: 'redf', w: 50, tag: 'redf', sa: true },
  { t: 'التمويل العقاري', w: 45, tag: 'mortgage' },
  { t: 'الرهن العقاري', w: 40, tag: 'mortgage' },
  { t: 'mortgage*', w: 40, tag: 'mortgage' },
  { t: 'home loan*', w: 35, tag: 'mortgage' },
  { t: 'الشركه السعوديه لاعاده التمويل العقاري', w: 55, tag: 'src', sa: true },
  { t: 'اعاده التمويل العقاري', w: 50, tag: 'src' },
  { t: 'saudi real estate refinance', w: 55, tag: 'src', sa: true },
  { t: 'src', w: 25, tag: 'src' },
  { t: 'ساما', w: 25, tag: 'sama', sa: true },
  { t: 'البنك المركزي السعودي', w: 30, tag: 'sama' },
  { t: 'sama', w: 25, tag: 'sama', sa: true },
  { t: 'سايبور', w: 25, tag: 'saibor', sa: true },
  { t: 'saibor', w: 25, tag: 'saibor', sa: true },
  { t: 'ريت', w: 25, tag: 'reit' },
  { t: 'reit*', w: 25, tag: 'reit' },
  { t: 'صناديق الاستثمار العقاري', w: 35, tag: 'reit' },
  { t: 'صندوق عقاري', w: 25, tag: 'reit' },
  { t: 'real estate fund', w: 30, tag: 'reit' },
  { t: 'توزيعات', w: 8 },
  { t: 'dividend*', w: 8 },
  { t: 'صكوك', w: 12 },
  { t: 'sukuk', w: 12 },
],
```

### `housing`

```ts
housing: [
  { t: 'الدعم السكني', w: 50, tag: 'sakani', sa: true },
  { t: 'سكني', w: 35, tag: 'sakani' },
  { t: 'المسكن الاول', w: 30, tag: 'home-ownership' },
  { t: 'المسكن', w: 12, tag: 'housing' },
  { t: 'sakani', w: 45, tag: 'sakani', sa: true },
  { t: 'برنامج الاسكان', w: 40, tag: 'housing-program' },
  { t: 'housing program', w: 35, tag: 'housing-program' },
  { t: 'وزاره البلديات والاسكان', w: 40, tag: 'momah', sa: true },
  { t: 'البلديات والاسكان', w: 40, tag: 'momah', sa: true },
  { t: 'وزير البلديات والاسكان', w: 30, tag: 'momah', sa: true },
  { t: 'وزير الاسكان', w: 25, tag: 'momah' },
  { t: 'momah', w: 40, tag: 'momah', sa: true },
  { t: 'ministry of municipalities and housing', w: 40, tag: 'momah', sa: true },
  { t: 'الشركه الوطنيه للاسكان', w: 45, tag: 'nhc', sa: true },
  { t: 'national housing company', w: 45, tag: 'nhc', sa: true },
  { t: 'nhc', w: 35, tag: 'nhc' },
  { t: 'التملك السكني', w: 40, tag: 'home-ownership' },
  { t: 'تملك المساكن', w: 40, tag: 'home-ownership' },
  { t: 'نسبه التملك', w: 40, tag: 'home-ownership' },
  { t: 'homeownership', w: 35, tag: 'home-ownership' },
  { t: 'home ownership', w: 35, tag: 'home-ownership' },
  { t: 'الاسكان التنموي', w: 35, tag: 'developmental-housing' },
  { t: 'جود الاسكان', w: 20, tag: 'developmental-housing' },
  { t: 'اسكان', w: 18, tag: 'housing' },
  { t: 'housing', w: 18, tag: 'housing' },
  { t: 'وحده سكنيه', w: 20, tag: 'housing' },
  { t: 'وحدات سكنيه', w: 25, tag: 'housing' },
  { t: 'مخطط* سكني*', w: 25, tag: 'land' },
  { t: 'قطعه ارض', w: 15, tag: 'land' },
  { t: 'قطع اراض*', w: 15, tag: 'land' },
  { t: 'residential', w: 15, tag: 'housing' },
  { t: 'السكني*', w: 12, tag: 'housing' },
  { t: 'مستفيدي*', w: 15, tag: 'sakani' },
  { t: 'own their home', w: 25, tag: 'home-ownership' },
],
```

### `market`

```ts
market: [
  { t: 'مؤشر اسعار العقارات', w: 55, tag: 'price-index' },
  { t: 'الرقم القياسي لاسعار العقارات', w: 55, tag: 'price-index' },
  { t: 'real estate price index', w: 55, tag: 'price-index' },
  { t: 'الصفقات العقاريه', w: 40, tag: 'transactions' },
  { t: 'صفقات الاسكان', w: 35, tag: 'transactions' },
  { t: 'صفقات عقاريه', w: 35, tag: 'transactions' },
  { t: 'real estate transactions', w: 45, tag: 'transactions' },
  { t: 'property transactions', w: 40, tag: 'transactions' },
  { t: 'اسعار العقارات', w: 35, tag: 'prices' },
  { t: 'اسعار الايجارات', w: 40, tag: 'rent' },
  { t: 'تضخم الايجارات', w: 55, tag: 'rent-inflation' },
  { t: 'property prices', w: 35, tag: 'prices' },
  { t: 'home sales', w: 30, tag: 'transactions' },
  { t: 'تكاليف البناء', w: 45, tag: 'construction-costs' },
  { t: 'construction costs', w: 45, tag: 'construction-costs' },
  { t: 'رخص البناء', w: 35, tag: 'building-permits' },
  { t: 'building permits', w: 35, tag: 'building-permits' },
  { t: 'الرقم القياسي', w: 15 },
  { t: 'المبيعات العقاريه', w: 35, tag: 'transactions' },
  { t: 'مبيعات العقارات', w: 30, tag: 'transactions' },
  { t: 'التداولات العقاريه', w: 30, tag: 'transactions' },
  { t: 'sales', w: 8 },
  { t: 'القطاع العقاري', w: 25, tag: 'market' },
  { t: 'السوق العقاري*', w: 30, tag: 'market' },
  { t: 'سوق العقار*', w: 30, tag: 'market' },
  { t: 'real estate market', w: 30, tag: 'market' },
  { t: 'property market', w: 30, tag: 'market' },
  { t: 'الهيئه العامه للاحصاء', w: 20, tag: 'gastat' },
  { t: 'gastat', w: 20, tag: 'gastat' },
],
```

### `projects`

```ts
projects: [
  { t: 'روشن', w: 30, tag: 'roshn', sa: true },
  { t: 'roshn', w: 30, tag: 'roshn', sa: true },
  { t: 'مشروع*', w: 6 },
  { t: 'شركه مشتركه', w: 10 },
  { t: 'joint venture', w: 10 },
  { t: 'نيوم', w: 15, tag: 'neom', sa: true },
  { t: 'neom', w: 15, tag: 'neom', sa: true },
  { t: 'الدرعيه', w: 15, tag: 'diriyah' },
  { t: 'diriyah', w: 15, tag: 'diriyah' },
  { t: 'المربع الجديد', w: 25, tag: 'new-murabba', sa: true },
  { t: 'new murabba', w: 25, tag: 'new-murabba', sa: true },
  { t: 'القديه', w: 12, tag: 'qiddiya', sa: true },
  { t: 'qiddiya', w: 12, tag: 'qiddiya', sa: true },
  { t: 'البحر الاحمر', w: 8 },
  { t: 'حديقه الملك سلمان', w: 20, tag: 'king-salman-park' },
  { t: 'مسار', w: 10 },
  { t: 'وحده', w: 10 },
  { t: 'وحدات', w: 12 },
  { t: 'مجتمع* سكني*', w: 25, tag: 'development' },
  { t: 'homes', w: 12, tag: 'housing' },
  { t: 'units', w: 10 },
  { t: 'development', w: 12, tag: 'development' },
  { t: 'community', w: 8 },
  { t: 'جبل عمر', w: 15 },
  { t: 'التطوير العقاري', w: 25, tag: 'development' },
  { t: 'مطور* عقاري*', w: 25, tag: 'development' },
  { t: 'مشروع* سكني*', w: 25, tag: 'development' },
  { t: 'real estate develop*', w: 25, tag: 'development' },
  { t: 'developer', w: 15, tag: 'development' },
  { t: 'البنيه التحتيه', w: 8 },
  { t: 'مخطط*', w: 8 },
  { t: 'تطوير', w: 6 },
  { t: 'ابراج', w: 8 },
  { t: 'برج*', w: 6 },
],
```

### `other`

```ts
other: [
  { t: 'عقار*', w: 20, tag: 'real-estate' },
  { t: 'العقاري*', w: 20, tag: 'real-estate' },
  { t: 'real estate', w: 20, tag: 'real-estate' },
  { t: 'property', w: 12, tag: 'real-estate' },
  { t: 'properties', w: 12, tag: 'real-estate' },
  { t: 'اراض*', w: 10, tag: 'land' },
  { t: 'ارض', w: 8, tag: 'land' },
  { t: 'land', w: 8, tag: 'land' },
  { t: 'مستودع*', w: 8 },
  { t: 'مكاتب', w: 6 },
  { t: 'office*', w: 5 },
],
```

### Saudi geography (`SAUDI_GEO`)

```ts
['السعوديه', 'السعودي', 'سعودي*', 'المملكه', 'الرياض', 'جده', 'مكه المكرمه', 'مكه', 'المدينه المنوره', 'الدمام', 'الشرقيه', 'المنطقه الشرقيه', 'القصيم', 'حايل', 'عسير', 'ابها', 'تبوك', 'جازان', 'نجران', 'الباحه', 'الجوف', 'الاحساء', 'الطايف', 'بريده', 'الدرعيه', 'ينبع', 'الخرج', 'saudi*', 'ksa', 'riyadh', 'jeddah', 'makkah', 'mecca', 'madinah', 'dammam', 'khobar', 'eastern province', 'hail', 'qassim', 'tabuk', 'diriyah', 'tadawul', 'tasi', 'تاسي']
```

### Foreign markers (`FOREIGN_GEO`)

```ts
['مصر', 'المصري*', 'القاهره', 'دبي', 'ابوظبي', 'الامارات*', 'الاماراتي*', 'الكويت*', 'قطر', 'القطري*', 'البحرين*', 'عمان', 'سلطنه عمان', 'الاردن', 'لبنان', 'سوريا', 'العراق', 'تركيا', 'المغرب', 'تونس', 'الجزاير', 'اليمن', 'تعز', 'بريطانيا', 'لندن', 'امريكا', 'اميركا', 'الامريكي*', 'الاميركي*', 'الولايات المتحده', 'اوروبا', 'الاوروبي*', 'المانيا', 'فرنسا', 'برشلونه', 'اسبانيا', 'الصين', 'اليابان', 'كندا', 'استراليا', 'السويد', 'المالديف', 'فيتنام', 'الهند', 'egypt*', 'cairo', 'dubai', 'abu dhabi', 'uae', 'emirat*', 'kuwait*', 'qatar*', 'bahrain*', 'oman', 'jordan', 'lebanon', 'syria', 'turkey', 'uk', 'london', 'britain', 'us', 'america*', 'europe*', 'germany', 'france', 'spain', 'china', 'japan', 'canada', 'australia', 'sweden', 'maldives', 'vietnam', 'india', 'nj', 'switzerland', 'florida', 'جبل لبنان', 'هانوي', 'الايجار القديم', 'قانون 164', 'برلماني', 'الرعايه السكنيه', 'درهم', 'د ك', 'الجنيه', 'جنيه']
```

### Negative terms (`NEGATIVE`, penalty points)

```ts
[['للبيع', 60], ['للايجار', 45], ['for sale', 50], ['for rent', 45], ['احجز', 40], ['احجز الان', 50], ['book now', 50], ['سارع', 30], ['عرض خاص', 45], ['خصم', 25], ['تخفيض*', 20], ['مسابقه', 50], ['سحب علي', 50], ['جوايز', 30], ['ريتويت', 50], ['giveaway', 50], ['win', 20], ['عيد مبارك', 60], ['كل عام وانتم', 60], ['اليوم الوطني', 35], ['يوم التاسيس', 35], ['رمضان كريم', 60], ['جمعه مباركه', 60], ['تهنئه', 35], ['يهني*', 35], ['تعزيه', 60], ['national day', 35], ['معرض', 15], ['تكرم', 40], ['خريجي', 40], ['بحضور', 20], ['ملتقي', 10], ['يزور', 25], ['زياره', 15], ['يدشن مقره', 40], ['مقره الجديد', 40], ['يفتتح', 10], ['يستقبل', 30], ['يراس', 20], ['يطلع على', 25], ['ورشه عمل', 25], ['جناح', 25], ['نشارك', 25], ['جايزه', 20], ['award*', 20], ['السيره الذاتيه', 60], ['معلومات الشركه', 60], ['الهاشتاجات', 80], ['الوسايط', 60], ['مباراه', 50], ['الدوري', 50], ['كره القدم', 50], ['منتخب', 40], ['ملاكمه', 50], ['بطوله', 30], ['match', 30], ['league', 40], ['football', 40], ['soccer', 50], ['النفط', 25], ['الذهب', 30], ['برنت', 30], ['crude', 25], ['oil', 15], ['gold', 25], ['bitcoin', 40], ['بتكوين', 40], ['سعر صرف', 30], ['الاسترليني', 40], ['الين', 20], ['الروبل', 40], ['مقذوف', 40], ['وفاه', 40], ['وفاتان', 40], ['اصابه', 25], ['اصابات', 25], ['مخدرات', 50], ['سلاح', 40], ['الحوثي*', 40], ['هجوم', 20], ['attack*', 25], ['الطقس', 40], ['امطار', 40], ['الارصاد', 40], ['تداولات المطلعين', 40], ['محضر اجتماع', 40], ['الجمعيه العموميه', 25], ['stock price and chart', 80], ['ex dividend', 15], ['52 week low*', 30], ['all time low*', 25], ['lowest since debut', 25], ['نصايح', 20], ['هل تعلم', 40], ['خبير يحذر', 15], ['كل ما تريد معرفته', 25], ['الابل', 60], ['المركبه', 40], ['سياره', 40], ['السيارات', 40]]
```

### Hard blocks (`BLOCK_RE`, on normalised text; score 0)

```ts
/(?:\+?966|\b0)5\d{8}\b/u,
/\b9200\d{5}\b/u,
/\b05\d\s?\d{3}\s?\d{4}\b/u,
/(?:للبيع|للايجار|for sale|for rent)\b.*\b\d{3,}/u,
/واتساب|whatsapp|wa me/u,
/(?:رتويت|ريتويت|retweet)\s/u,
```

### Index-page block (`PAGE_RE`, on normalised cleaned title)

```ts
/(?:الاخبار|الافصاحات|تقارير ارقام|معلومات الشركه|stock price and chart|الوسايط|الهاشتاجات)$/u
```

### Data bonus (`DATA_RE`)

```ts
/\d[\d\.,]*\s*(?:وحده|اسره|قطعه|homes?|units?|families|%|مليار|مليون|الف|ريال|قطعه|sar|bn|billion|million|pc)|%\s*\d/u
```

**Penalty guide.** These are the penalty values used in `NEGATIVE` above.

- **Ads.** «للبيع» −60, «للإيجار» −45, «احجز» −40, «احجز الآن» −50.
- **Giveaways and greetings.** −50 to −60.
- **Protocol and PR.** «يستقبل» −30, «يدشن مقره» −40, «تكرم» −40, «معرض» −15.
- **Sports, crime, weather.** −40 to −50.
- **Oil, gold, FX.** −25 to −40.
- **Stock-page noise.** «تداولات المطلعين» −40, «stock price and chart» −80.
- **Evergreen explainers.** «هل تعلم» −40, «كل ما تريد معرفته» −25.

Because penalties are subtracted, an ad that also mentions «منصة إيجار» still falls below 60. The hard blocks (phone numbers, WhatsApp, "للبيع/للإيجار … <price>", retweet-to-win) short-circuit to 0.

## 6. Worked examples (unit-test fixtures)

These are real headlines from the feeds on 2026-09-26, apart from S1–S6, which are synthetic ads and tweets. Scores are the reference implementation's output, and ✅ means publishable (score ≥ 60).

`feed` is the key from `lexicon-proto/items.json`. The `source` column is the Google News `<source>` text to strip; `—` means a publisher feed.

| # | Headline (raw) | source | Score | Cat | Tags | Why |
|---|---|---|---|---|---|---|
| 1 | بالفيديو.. رئيس الهيئة العامة للعقار يعلق على مخاوف البعض بشأن آثار تثبيت الإيجارات في الرياض لمدة خمس سنوات | صحيفة المرصد | **100** ✅ | rental | rent-freeze, rega | two Saudi-only entities |
| 2 | البلديات والإسكان تدعو العموم لإبداء آرائهم حول مسودة لائحة رسوم العقارات الشاغرة | ارقام : اخبار ومعلومات سوق الأسهم السعودي - تاسي | **100** ✅ | regulation | vacant-property-fee, momah | fee regulation draft |
| 3 | "الصندوق العقاري" يودع نحو 292 مليون دولار لمستفيدي الدعم السكني في سبتمبر | العربية | **100** ✅ | housing | redf, sakani | REDF + Sakani + figure |
| 4 | REGA limits property transactions in Hail, Eastern Province to real estate registry | argaam.com | **98** ✅ | regulation | real-estate-registry, transactions, rega | English, strong entities |
| 5 | حصر تنفيذ التصرفات العقارية في حائل والشرقية على السجل العقاري | جريدة الرياض | **91** ✅ | regulation | real-estate-registry, rett | registry + transactions + حصر |
| 6 | Saudi Sakani program to help 140,000 families own their home this year | Arab News | **78** ✅ | housing | sakani, home-ownership | Sakani + data |
| 7 | Saudi property: ROSHN opens Riyadh, Jeddah and Makkah homes to foreign buyers | Arabian Business | **76** ✅ | projects | foreign-ownership, roshn | foreign-ownership news |
| 8 | 5.87 مليار ريال.. حجم التمويل العقاري للأفراد من المصارف خلال يوليو | — (Alyaum RE) | **74** ✅ | finance | mortgage | mortgage volume + figure + desc |
| 9 | ارتفاع الرقم القياسي لتكاليف البناء في السعودية 2.3% خلال أغسطس | العربية | **72** ✅ | market | construction-costs | official index + figure |
| 10 | حصري \| عام على تثبيت الإيجارات في الرياض.. من دفع الكلفة ومن كسب المعركة؟ | أريبيان بزنس | **70** ✅ | rental | rent-freeze | one Saudi-only entity alone clears 60 |
| 11 | استمرارًا لتوجيهات ولي العهد.. إعلان موعد استقبال طلبات السنة الثانية من برنامج التوازن العقاري - عاجل | — (Alyaum RE) | **66** ✅ | regulation | rcrc-balance | Riyadh land programme |
| 12 | 45 يوما مهلة تصحيحية لملاك الأراضي الفضاء قبل تطبيق العقوبات | — (Alyaum RE) | **66** ✅ | regulation | white-land, momah | deadline + penalties; MOMAH from desc |
| 13 | قرارات التوازن تقلص تضخم الإيجارات في الرياض | الاقتصادية | **65** ✅ | market | rent-inflation | rent inflation, Riyadh |
| 14 | Saudi real estate transactions fall 15% to SAR 24.4B in August | argaam.com | **63** ✅ | market | transactions | market data |
| 15 | يومان على انتهاء مهلة تسجيل 204 قطع عقارية في مكة المكرمة والشرقية | — (Alyaum RE) | **62** ✅ | regulation | rega, real-estate-registry | entities only in description (half weight) + deadline |
| 16 | Saudi Arabia plans massive 55,000-home Riyadh development as ROSHN signs deal | Arabian Business | **55** ✗ | projects | roshn, development | **known miss**: a real project with numbers; admin can approve by hand |
| 17 | TASI: 10 stocks, 2 REIT fall to historical lows | argaam.com | **35** ✗ | finance | reit | stock-move noise |
| 18 | اقتصادي / وزير البلديات والإسكان يفتتح المؤتمر والمعرض الدولي الثالث لإدارة المرافق 2026 | وكالة الأنباء السعودية | **25** ✗ | housing | momah | event PR (يفتتح, معرض) |
| 19 | ضريبة التصرفات العقارية في مصر.. كيف تستفيد من الإعفاءات المتاحة؟ | al-ain.com | **0** ✗ | regulation | rett | foreign: مصر |
| 20 | ارتفاع جديد لفائدة التمويل العقاري في أميركا | العربية | **0** ✗ | finance | mortgage | foreign: اميركا |
| 21 | توحيد عمل أمانات السجل العقاري في جبل لبنان | المركزية | **0** ✗ | regulation | real-estate-registry | foreign: لبنان |
| 22 | زيادة الإيجار القديم سنويًا.. كيف تُحسب القيمة المستحقة على المستأجر؟ | dostor.org | **0** ✗ | rental | rent-increase, tenants | foreign marker «الإيجار القديم» (Egypt) |
| 23 | 14 مليار درهم تصرفات عقارات دبي في أسبوع | ارقام : اخبار ومعلومات سوق الأسهم السعودي - تاسي | **0** ✗ | other | real-estate | foreign: دبي, درهم (only after the source suffix is stripped) |
| 24 | الصمصام العقاري يدشّن مقره الجديد في مكة المكرمة تزامنًا مع اليوم الوطني الـ96 | شاهد الآن | **0** ✗ | other | real-estate | PR + National Day |
| 25 | عام / نائب أمير الشرقية يستقبل مدير فرع الهيئة العامة لعقارات الدولة بالدمام | وكالة الأنباء السعودية | **0** ✗ | other | real-estate | protocol visit (note: State Properties ≠ REGA) |
| 26 | السعودية: وفاتان و12 إصابة بسقوط مقذوف على مبنى سكني في الخرج | الشرق الأوسط | **0** ✗ | housing | sakani | crime/attack negatives |
| 27 | الراجحي ريت - الاخبار | ارقام : … - تاسي | **0** ✗ | other | — | PAGE_RE index page |
| 28 | الكويت تدين استهداف السعودية.. ومجلس الوزراء يقر مشروع التمويل العقاري | mubasher.info | **66** ⚠ | finance | mortgage | **known false positive**: a Kuwaiti law. «السعودية» appears in an unrelated clause, and Saudi geography overrides the foreign marker |
| S1 | فيلا للبيع في حي النرجس بالرياض 3 أدوار السعر 2,500,000 للتواصل 0551234567 | synthetic | **0** ✗ | other | — | BLOCK: phone number |
| S2 | شقة للإيجار بجدة حي الصفا 4 غرف — احجز الآن واتساب | synthetic | **0** ✗ | other | — | BLOCK: واتساب |
| S3 | 🎉 مسابقة اليوم الوطني: ريتويت وتابعنا واربح إيجار شهر مجاناً | synthetic | **0** ✗ | other | — | BLOCK: retweet |
| S4 | كل عام وأنتم بخير بمناسبة عيد الفطر المبارك من فريق إيجار | synthetic | **0** ✗ | rental | rent | greeting −60 |
| S5 | هل تعلم أنه يمكنك توثيق عقدك عبر منصة إيجار؟ | synthetic | **30** ✗ | rental | ejar | evergreen tip −40 |
| S6 | منصة إيجار: إلزام المؤجرين بتسجيل عقود الإيجار التجارية ابتداءً من 1 يناير 2027 وغرامة على المخالفين | synthetic | **100** ✅ | rental | ejar, lease, landlords | new obligation with a deadline |

## 7. Known limits and how to tune

- **Syndication duplicates.** The same REGA or REDF announcement arrives 10–15 times across Google News. Near-duplicate dedupe (CONTRACT) must collapse them. That is expected, not a filter bug.
- **Foreign check reads the title only.** A Kuwaiti or Egyptian story whose title names no country slips through when it uses Saudi-sounding terms (see #28, and «مجلس الوزراء يوافق على … التمويل العقاري لمستحقي الرعاية السكنية», where «الرعايه السكنيه» was added as a Kuwaiti marker). Add markers to `FOREIGN_GEO` when admins reject such items.
- **Project news under-scores** (#16). Giga-project stories need numbers plus the project name, and ROSHN at 30 is deliberately modest. If admins keep approving these, raise `روشن`/`roshn` to 40.
- **Deterministic by design.** Same input, same output, with no stemming library and no network access.
- **Wrong verdicts.** Fix them by editing weights or adding terms, then add the headline to §6 as a fixture.
