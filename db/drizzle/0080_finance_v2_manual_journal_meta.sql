-- Finance v2 (beta): what a manual journal touching client money carries (accountant, 15 Oct 2026: «تنبيه
-- وقت الحفظ وتعمل سبب او مرفق يكون اجباري … القيد يعتمد من محاسب آخر غير اللي عمل القيد»).
--
-- Additive only: one new 1:1 side table of manual_journals (0066), nothing existing is altered. Applied at boot by
-- bootstrap.ts after 0079, in its own try/catch (a failure means a journal that sets trust against an office account
-- cannot be saved — the reason has nowhere to go; every other journal is unchanged). Idempotent.
--
--  - trust_reason: the reason given for a journal that sets a trust account against an office account
--    (TRUST_WITH_OFFICE_ACCOUNT); a reason of 10+ characters or an attachment is required for such a journal;
--  - last_actor_id: the user who last created, edited or submitted it — with created_by, the people who may NOT
--    approve such a journal (maker-checker).
create table if not exists finance_manual_journal_meta (
  manual_journal_id integer primary key,
  user_id integer not null,
  trust_reason text,
  last_actor_id integer,
  updated_at timestamptz not null default now()
);
create index if not exists finance_manual_journal_meta_user_idx on finance_manual_journal_meta (user_id);
