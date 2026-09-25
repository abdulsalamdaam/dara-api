# Real-estate News: business spec

Companion to `CONTRACT.md`. The rubric in §2 is written to be pasted into the AI system prompt as-is.

---

## 1. Who sees the feed

**Decision: every signed-in portal account. No permission gate, no package gate.**

- **Landlord-mode accounts (basic / professional / enterprise):** yes. They are the core audience.
- **Team members (employees under a company):** yes. The feed is read-only public news with no customer data, so no role permission is needed. Do **not** add a new permission key. That would mean editing every role row, since permissions resolve only from `roles.permissions` (DARA-NOTES §3).
- **Tenant-package accounts (`mode === "tenant"`):** yes. They are companies tracking their own leases, and rent-freeze, Ejar and tax news matters just as much to them.
  - **Code gotcha:** DARA-NOTES §3 says the `TENANT_TABS` whitelist is gone, but `src/_legacy/DashboardPage.tsx:230,360` still bounces tenant-mode users to `dashboard` for any tab not in the set. **Add `"news"` to `TENANT_TABS`**, or tenant accounts will see the sidebar item and get redirected.
- **Demo accounts:** yes, since the feed shows the product's value. It is read-only, so there is nothing to lock.
- **Mobile (tenant app):** out of scope for v1.

Sidebar placement: near the bottom, above Settings. It is informational, not a workflow.

---

## 2. AI relevance rubric (paste into the system prompt)

```
You are the editor of a real-estate news feed for landlords and property managers
in Saudi Arabia. Readers own or manage residential/commercial rental units and use
Dara to manage deeds, properties, units, leases (Ejar) and rent collection. They
want to know what changes their obligations, their costs, their income, or the
value of their assets. Judge each post ONLY on that.

KEEP (relevant) — news that is Saudi-specific and concerns one of:
- Real-estate regulation: REGA (الهيئة العامة للعقار) rules, laws, executive
  regulations, licensing (فال), brokerage rules, compliance deadlines, penalties.
- Ejar (إيجار): new lease rules, mandatory registration, contract templates,
  fees, platform changes affecting landlords/tenants, rental dispute rules.
- Rent controls: the Riyadh rent-freeze / annual-increase rules, any city's
  rent caps, eviction rules, tenant/landlord rights.
- Taxes & fees: real-estate transaction tax (RETT, 5%), VAT on real estate,
  white-land and vacant-property fees (رسوم الأراضي البيضاء والعقارات الشاغرة),
  zakat on real estate, municipal fees affecting property.
- Registration: Real Estate Registry (السجل العقاري) first registration zones,
  deed (صك) rules, Ministry of Justice real-estate transaction data.
- Market data: official price indices (GASTAT real-estate price index), rent
  inflation in CPI, transaction volumes/values, REGA market indicators, quarterly
  sector reports, supply/absorption figures from credible sources.
- Finance: SAMA mortgage data, interest/SAIBOR moves as they affect mortgages,
  SRC (Saudi Real Estate Refinance) programmes/issuances, REDF subsidy changes,
  real-estate REITs and listed developers' material results/disclosures on Tadawul.
- Housing policy: Sakani, Ministry of Municipalities and Housing (MOMAH), NHC
  programmes, home-ownership rate targets, new housing supply that shifts a market.
- Projects: giga projects and large developments (NEOM, ROSHN, Diriyah, Red Sea,
  King Salman Park, New Murabba, Qiddiya) WHEN the post contains concrete news
  (launch, units, dates, financing, handover), and major urban planning decisions.
- Off-plan sales (وافي), real-estate funds, foreign ownership rules, Premium
  Residency as it affects property ownership.

DROP (not relevant) — even when posted by a real-estate account:
- Advertising: individual listings, "for sale/for rent", unit promos, open days,
  discounts, "book now", developer marketing without market-level news.
- Contests, giveaways, polls with no information, "retweet to win".
- Greetings and occasions: Eid, National Day, Founding Day, Ramadan, Friday
  greetings, condolences, congratulations, "happy weekend".
- Motivational, awareness slogans or tips with no new fact ("do you know that you
  can register your lease on Ejar?"), recycled evergreen explainers.
- Customer-service replies, "contact us on 199011", hours of operation, app
  outage notices under 24h.
- Event PR with no substance: "we participated in", "our booth at", MoU photo-ops
  with no stated scope, award announcements, staff visits, workshops.
- Pure retweets/quotes with no added text; link-only posts where the text gives
  no fact (judge only what is in the text + link title).
- Non-Saudi real estate (Dubai, Egypt, global) unless it explicitly compares to or
  affects the Saudi market.
- General stock-market moves, oil, geopolitics, politics, royal news, sports,
  weather, crime — unless the post explicitly ties it to Saudi real estate.
- Opinion/speculation by anonymous commentators, rumours, "sources say" with no
  named outlet.

SCORING (ai_score 0–100) — score the value to a Saudi landlord TODAY:
- 90–100  Changes obligations or money directly and soon: a new/amended law or
          fee, a rent-increase rule, an Ejar requirement with a deadline, a tax
          change, a white-land billing phase in a city.
          e.g. "REGA: Riyadh rent freeze extended 5 years for residential and
          commercial"; "RETT rules amended, effective 1 Jan".
- 75–89   Official market data or a policy decision that shapes the market:
          quarterly price index, SAMA mortgage totals, new Registry zone,
          REDF subsidy change, REIT distribution.
          e.g. "GASTAT: residential prices up 3.2% YoY in Q2".
- 60–74   Useful context: a named project milestone with numbers, a listed
          developer's results, a credible analyst report with figures, an Ejar
          platform feature landlords will use.
- 40–59   Weakly related: generic sector commentary, a conference with one
          quotable figure, a project teaser without specifics.
- 0–39    Anything in the DROP list.
Set ai_relevant = (score >= 60). When unsure between two bands, pick the lower.
Official source (REGA, Ejar, SAMA, MOMAH, GASTAT…) announcing a rule outranks
a news outlet repeating it.

OUTPUT per post: ai_relevant, ai_score, ai_category (one key from the list),
ai_title_ar, ai_title_en, ai_summary_ar, ai_summary_en, ai_tags (3–5 short
lowercase English tags, e.g. "rent-freeze","riyadh","ejar"), ai_reason (one
English sentence explaining the score, for admins). Write titles/summaries even
for rejected posts only if cheap; otherwise leave them empty.
```

---

## 3. Categories

| key | Arabic | English | Covers |
|---|---|---|---|
| `regulation` | الأنظمة والتشريعات | Regulation | REGA rules, laws, licensing, fees and taxes (RETT, white land), Registry, penalties |
| `rental` | سوق الإيجار | Rental | Ejar requirements, rent increases and freezes, landlord and tenant rights, rent levels |
| `market` | السوق والمؤشرات | Market | Price indices, transaction volumes and values, sector reports, supply data |
| `finance` | التمويل والاستثمار | Finance | Mortgages, SAMA data, rates, SRC, REDF, REITs, listed developers |
| `housing` | الإسكان | Housing | Sakani, MOMAH, NHC, home-ownership programmes, housing supply |
| `projects` | المشاريع والتطوير | Projects | Giga projects, major developments, launches, urban planning |
| `other` | أخرى | Other | Relevant items that fit none of the above. Use sparingly. |

Tie-break order when a post fits two categories: **rental > regulation > finance > market > housing > projects > other**. Rental-specific news is the most actionable for Dara users, so it wins.

---

## 4. Title and summary style

- **Arabic:** Modern Standard Arabic, neutral news register. No colloquial Arabic, no emoji, no hashtags, no exclamation marks.
- **English:** plain news English, sentence case, and not a literal translation. It should read naturally.
- **Title:** at most 90 characters. Put the actor first when the actor is official: «الهيئة العامة للعقار تمدد…» / "REGA extends…". State the fact, not the topic. Bad: "أخبار الإيجار". Good: «تمديد إيقاف زيادة الإيجارات في الرياض 5 سنوات».
- **Summary:** 1 to 2 sentences, about 280 characters or less. Cover what changed, who it applies to, and from when. End with the source entity if the title does not name it («…بحسب الهيئة العامة للإحصاء» / "…according to GASTAT").
- Keep every number, percentage, date and city exactly as posted. Keep Hijri and Gregorian dates as given. Do not convert currency, and write "SAR"/«ريال».
- No hype words: «عاجل», «مفاجأة», «ضخم», "huge", "game-changer". Add no advice or opinion, and invent nothing that is not in the post or its link title.
- Proper names: الهيئة العامة للعقار = REGA, إيجار = Ejar, سكني = Sakani, وزارة البلديات والإسكان = MOMAH, البنك المركزي السعودي = SAMA, الهيئة العامة للإحصاء = GASTAT, السجل العقاري = Real Estate Registry, الشركة الوطنية للإسكان = NHC, صندوق التنمية العقارية = REDF, هيئة الزكاة والضريبة والجمارك = ZATCA.

---

## 5. Default schedule and thresholds

| Setting | Default | Why |
|---|---|---|
| `run_time` | **07:00** Asia/Riyadh | Catches the previous evening's announcements (government bodies often post in the evening), and the feed is fresh before the working day starts. |
| `days_of_week` | all (0–6) | Posting drops on Fri/Sat but does not stop, and an empty run costs almost nothing. |
| `lookback_hours` | **36** | One day plus a 12h overlap, so a delayed or failed run loses nothing. `external_id` uniqueness absorbs the overlap. After an outage, an admin can raise it to 72 for one manual run. |
| `max_per_account` | **20** | News outlets (Argaam, Aleqtisadiah, Asharq) post 50 to 150 times a day, and almost all of it is off-topic. Twenty capped per day is enough for official bodies, which post under 10 a day, and keeps API and AI cost bounded: about 20 accounts × 20 = at most 400 posts a day. |
| `min_score` | **60** | Matches the rubric band where content is useful to a landlord. Lower it to 50 if the feed is too thin during the first two weeks, not below that. |

Fetch rules, which matter for quality:
- **Exclude replies and pure retweets** at fetch time (`exclude=replies,retweets` on X v2). The `@ejar_sa`, `@sakani` and `@redfksa` timelines are mostly customer-service replies.
- **Keep quote-tweets** that add text.

---

## 6. Admin workflows

- **Daily check (about 2 minutes):** open Overview, check the last run's status and counts, skim Published, and hide anything off-topic.
- **Moderation:** set an item to `hidden` to remove it from the feed. Promote a `rejected` item to `published` when the AI missed it. Change the category. Pin at most 3 items for major rules such as rent-freeze changes, and unpin after about 14 days.
- **Tuning:** use `extra_instructions` for temporary focus, for example "Treat anything about the Jeddah rent rules as score ≥ 80 this month". Review it monthly, because it is easy to forget.
- **Adding an account:** always click **Test** first. It validates the handle and shows real posts. Add a note explaining why the account is followed.
- **Run now:** for after changing sources or instructions, or after an outage. It returns 409 while a run is in progress, and the UI should say "a run is already in progress".

## 7. Edge cases

| Case | Behaviour |
|---|---|
| **Same story from several accounts** (REGA announces it, then Argaam, Aleqtisadiah and SPA repeat it) | Within one run, give the AI the batch together with the titles of the last 72h of published items, and tell it: "if a post reports the same event as an item already kept, reject it with ai_reason `duplicate of <external_id>`; prefer the official source." Count these in `duplicates`. An admin can still publish a duplicate if it adds numbers. |
| **Same tweet fetched twice** (overlapping lookback) | Skipped by the `external_id` unique constraint and counted in `duplicates`. It never reaches the AI, so it costs nothing. |
| **Tweet deleted after we saved it** | Keep it. We store the text, and the feed is a digest, not an embed. The "View on X" link will 404, which is acceptable. An admin can hide it. No re-checking in v1. |
| **Account renamed** | Fetch by `x_user_id`, not by handle. When the returned username differs, update `handle` and `display_name` and log an info line. |
| **Account suspended, protected or not found** | Set `last_error`, and the run becomes `partial`. Other accounts continue. The admin Accounts list shows a red badge. Do not auto-disable, because suspensions are often temporary. |
| **API quota or rate limit exhausted** | Stop fetching the remaining accounts and mark the run `partial`, logging which handles were skipped. Do not advance `last_seen_tweet_id` for skipped accounts, so the next run's 36h lookback picks them up. |
| **AI down or erroring** | **Never publish unreviewed tweets.** Save nothing for the affected posts, and do not advance `last_seen_tweet_id`, so the next run retries them. Mark the run `partial` or `failed` with the error. |
| **What landlords see if a run fails** | The existing feed stays as it is, with "Updated <relative time>" from `last_updated_at`. No error is shown to landlords. If `last_updated_at` is more than 72h old, just show the timestamp. Do not alarm users. |
| **Feature not configured** (missing keys) | Portal tab still renders the empty state (below). Admin sees exact missing vars. |
| **AI output malformed or category not in the list** | Map it to `other`. If a title is missing, use the first 90 characters of the tweet text and set the status to `rejected`, so an admin can promote it. |
| **Very long threads** | Treat each tweet on its own. Only the first tweet of a self-thread is fetched, because replies are excluded. That is acceptable. |

---

## 8. Copy

**Page header**
- AR: **الأخبار العقارية**. Subtitle: «أهم مستجدات السوق العقاري والأنظمة في المملكة، من المصادر الرسمية، ملخّصة لك يوميًا.»
- EN: **Real-estate news**. Subtitle: "The Saudi property market and rule changes that matter to landlords, from official sources, summarised daily."

**Footer / disclaimer (small print)**
- AR: «ملخّصات مولّدة آليًا من منشورات عامة. راجع المصدر الأصلي قبل اتخاذ أي قرار.»
- EN: "Automatically summarised from public posts. Check the original source before acting on it."

**Empty state (no items yet)**
- AR: title «لا توجد أخبار بعد». Body: «نتابع يوميًا حسابات الهيئة العامة للعقار وإيجار وسكني وغيرها، ونعرض هنا ما يهمّ المؤجر فقط. عُد قريبًا.»
- EN: title "No news yet". Body: "Every day we follow REGA, Ejar, Sakani and other official sources, and show only what matters to landlords here. Check back soon."

**Empty filter result**
- AR: «لا أخبار في هذا التصنيف حاليًا.»
- EN: "No news in this category right now."
