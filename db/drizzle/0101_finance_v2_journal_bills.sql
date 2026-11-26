-- Finance v2 (beta): a supplier's opening balance (accountant, 27 Nov 2026, note 14: «ما أقدر أفتح رصيد افتتاحي لمورد
-- معين … الرصيد ذهب لحساب الموردين 2111 بدون مورد، وR12 يظهر فرق 1,500»).
--
-- A manual or opening journal line that credits 2111 (accounts payable) with a supplier («المورد») becomes, when the
-- journal is approved, an open item of that supplier: a supplier_bills row (approved, no own ledger entry — the journal
-- already credited 2111) so the AP aging, the supplier statement, supplier payments and R12 all see it. This 1:1 side
-- table of supplier_bills (0069) marks those bills and links them to their journal:
--  - billEvents (tier3/ap-events.ts) posts nothing for such a bill (the journal is its entry);
--  - the bill cannot be voided on its own: reversing the journal entry voids it (refused while a payment settles it).
--
-- Additive only: one new table, nothing existing altered. Applied at boot by bootstrap.ts after 0100, in its own
-- try/catch. Idempotent.
create table if not exists finance_journal_bills (
  bill_id integer primary key,
  user_id integer not null,
  manual_journal_id integer not null,
  entry_id bigint not null,
  line_no smallint not null,
  created_at timestamptz not null default now()
);
create index if not exists finance_journal_bills_entry_idx on finance_journal_bills (user_id, entry_id);
