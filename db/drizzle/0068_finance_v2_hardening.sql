-- Finance v2 (beta): ledger hardening. Design: docs/finance-v2/DESIGN.md §2.4.1.
--
-- Same rules as 0066/0067 (DESIGN §1.4 point 7, §2.2):
--  * ADDITIVE ONLY: it creates or replaces Finance v2 FUNCTIONS and TRIGGERS on
--    the 0066 ledger tables; it alters no table, not even the 0066 ones.
--  * IDEMPOTENT: `ensureSchema` (src/database/bootstrap.ts) runs it on every
--    boot, after 0066 and 0067. 0066 re-installs its own function body on each
--    boot and this file replaces it again right after, in the same boot.
--  * No reference to any legacy table.
--
-- The balance check (0066 §8.1) skipped an entry when the per-transaction
-- setting `fv2.chk_<id>` was '1'. That marker only de-duplicated the check
-- between an entry and its lines, but any session could set it first and
-- commit an unbalanced entry, or add lines to an entry posted earlier.
-- Hardened:
--  1. The entry's own constraint trigger (one per entry) ALWAYS checks it at
--     commit. No setting is consulted.
--  2. A line may only be inserted in the transaction that inserted its entry
--     (posted_at = transaction_timestamp(); posted_at is immutable, 0066 §8.2).
--     A later transaction adding lines is refused at once.
--  3. The lines' constraint trigger therefore has nothing left to check for a
--     same-transaction entry and returns; for any other entry (unreachable
--     after 2) it runs the full check.

create or replace function fv2_check_entry_balanced() returns trigger language plpgsql as $$
declare eid bigint; d numeric(16,2); c numeric(16,2); n int; t numeric(14,2); posted timestamptz; found_entry boolean;
begin
  if tg_table_name = 'journal_entries' then
    eid := new.id;
  else
    eid := new.entry_id;
    select e.posted_at, true into posted, found_entry from journal_entries e where e.id = eid;
    if found_entry is null then return null; end if;                -- purged in the same transaction
    if posted = transaction_timestamp() then return null; end if;   -- checked by the entry's own trigger
  end if;
  select total, true into t, found_entry from journal_entries where id = eid;
  if found_entry is null then return null; end if;                  -- purged in the same transaction
  select coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) into d, c, n from journal_lines where entry_id = eid;
  if n < 2 then raise exception 'fv2: journal entry % has % line(s); at least 2 required', eid, n using errcode = '23514'; end if;
  if d <> c then raise exception 'fv2: journal entry % is unbalanced (debit %, credit %)', eid, d, c using errcode = '23514'; end if;
  if t is distinct from d then raise exception 'fv2: journal entry % total % <> line total %', eid, t, d using errcode = '23514'; end if;
  return null;
end $$;

create or replace function fv2_line_same_tx() returns trigger language plpgsql as $$
declare posted timestamptz; found_entry boolean;
begin
  select e.posted_at, true into posted, found_entry from journal_entries e where e.id = new.entry_id and e.user_id = new.user_id;
  if found_entry is null then return new; end if;                   -- the (entry_id, user_id) foreign key reports it
  if posted is distinct from transaction_timestamp() then
    raise exception 'fv2: journal entry % was posted in an earlier transaction; its lines are immutable (correct with a reversal)', new.entry_id
      using errcode = '55000';
  end if;
  return new;
end $$;
drop trigger if exists journal_lines_same_tx on journal_lines;
create trigger journal_lines_same_tx before insert on journal_lines for each row execute function fv2_line_same_tx();
