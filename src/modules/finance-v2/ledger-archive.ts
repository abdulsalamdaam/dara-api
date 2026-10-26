import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Fv2Client } from "./db";

/**
 * Archive and restore of an account's DERIVED ledger (plan transitions, §3 "Reversibility").
 *
 * The automatic Owner→Manager migration (mode-migration.service.ts) throws the Owner-mode ledger away and posts
 * the history again in Manager mode — the same rows `fv2_purge_account(id, true)` deletes: journal entries and
 * lines, the posting queue, and the installment charge / VAT-point markers. Before it does, `archiveLedger`
 * copies exactly those rows (and the settings row) into `finance_ledger_archives`, in the same transaction, so
 * an admin can put the Owner ledger back (`restoreLedger`).
 *
 * Restore re-inserts the archived rows with their original ids, in id order: entries before lines (the balance
 * check is a deferred constraint trigger, run at commit). Two things cannot be byte-identical, by design of the
 * ledger's guards (0066/0068), and are restored as follows:
 *  - `posted_at` is the restore transaction's time: a line may only be inserted in the transaction that posted
 *    its entry (`fv2_line_same_tx`). The original is kept in the archive.
 *  - a reversed entry is inserted as posted and then marked reversed (`posted → reversed` with its reversal is
 *    the one update the immutability trigger allows), because `reversed_by` points at a later entry.
 * The caller holds the account's posting lock and checks the blockers in the same transaction.
 */

/** The tables archived, in restore order, with their stable ordering. */
const TABLES = [
  { key: "journal_entries", table: "journal_entries", order: "id" },
  { key: "journal_lines", table: "journal_lines", order: "id" },
  { key: "ledger_outbox", table: "ledger_outbox", order: "id" },
  { key: "installment_charges", table: "finance_installment_charges", order: "payment_id, generation" },
  { key: "installment_vat_points", table: "finance_installment_vat_points", order: "collection_id" },
] as const;

export interface LedgerCounts {
  journalEntries: number;
  journalLines: number;
  outbox: number;
  installmentCharges: number;
  installmentVatPoints: number;
  /** Σ debit of the archived lines, a 2-dp string (a quick equality check after a restore). */
  debit: string;
}

type Q = Pick<Fv2Client, "query">;

/** Counts of the account's live derived ledger (the same shape the archive stores). */
export async function ledgerCounts(c: Q, acct: number): Promise<LedgerCounts> {
  const n = async (sql: string) => Number((await c.query(sql, [acct])).rows[0]?.n ?? 0);
  return {
    journalEntries: await n(`select count(*)::int as n from journal_entries where user_id = $1`),
    journalLines: await n(`select count(*)::int as n from journal_lines where user_id = $1`),
    outbox: await n(`select count(*)::int as n from ledger_outbox where user_id = $1`),
    installmentCharges: await n(`select count(*)::int as n from finance_installment_charges where user_id = $1`),
    installmentVatPoints: await n(`select count(*)::int as n from finance_installment_vat_points where user_id = $1`),
    debit: String((await c.query(`select coalesce(sum(debit), 0)::numeric(16,2)::text as d from journal_lines where user_id = $1`, [acct])).rows[0]?.d ?? "0.00"),
  };
}

/** Copy the account's derived ledger into `finance_ledger_archives` (in the caller's transaction). Returns the archive id. */
export async function archiveLedger(c: Q, acct: number, planChangeId: number | null, reason: string, actorUserId: number | null = 0): Promise<number> {
  const counts = await ledgerCounts(c, acct);
  const agg = (t: (typeof TABLES)[number]) =>
    `(select coalesce(jsonb_agg(to_jsonb(x) order by ${t.order.split(",").map((k) => `x.${k.trim()}`).join(", ")}), '[]'::jsonb) from ${t.table} x where x.user_id = $1)`;
  const r = await c.query(
    `insert into finance_ledger_archives (account_user_id, plan_change_id, reason, settings, journal_entries, journal_lines, ledger_outbox,
                                          installment_charges, installment_vat_points, counts, created_by)
     values ($1, $2, $3,
             coalesce((select to_jsonb(fs) from finance_settings fs where fs.account_user_id = $1), '{}'::jsonb),
             ${TABLES.map(agg).join(", ")},
             $4::jsonb, $5)
     returning id`,
    [acct, planChangeId, reason.slice(0, 500), JSON.stringify(counts), actorUserId],
  );
  return Number(r.rows[0].id);
}

async function columns(c: Q, table: string): Promise<string[]> {
  const r = await c.query(
    `select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = $1 and is_generated = 'NEVER'
      order by ordinal_position`,
    [table],
  );
  return r.rows.map((x: any) => String(x.column_name));
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function bumpSequence(c: Q, table: string): Promise<void> {
  const [s] = (await c.query(`select pg_get_serial_sequence($1, 'id') as seq`, [table])).rows;
  if (!s?.seq) return;
  await c.query(
    `select setval($1::regclass, greatest((select coalesce(max(id), 1) from ${ident(table)}), (select last_value from ${s.seq})))`,
    [s.seq],
  );
}

/**
 * Put an archived ledger back: purge the account's current derived ledger, re-insert the archive, restore the
 * mode / `ledger_started_at` / trust routing from the archived settings row, and stamp the archive restored.
 * The caller has checked the blockers (the current ledger must be fully rebuildable) inside this transaction.
 */
export async function restoreLedger(c: Q, archiveId: number, actorUserId: number, reason: string): Promise<{ restored: true; accountUserId: number; counts: LedgerCounts }> {
  const [a] = (await c.query(`select id, account_user_id, restored_at, settings, counts from finance_ledger_archives where id = $1 for update`, [archiveId])).rows;
  if (!a) throw new NotFoundException({ error: "ARCHIVE_NOT_FOUND", message: "Ledger archive not found" });
  if (a.restored_at) throw new ConflictException({ error: "RESTORE_BLOCKED", code: "RESTORE_BLOCKED", message: "This ledger archive was already restored", blockers: [] });
  const acct = Number(a.account_user_id);

  await c.query(`select fv2_purge_account($1, true)`, [acct]);

  for (const t of TABLES) {
    const cols = await columns(c, t.table);
    const order = t.order.split(",").map((k) => `x.${k.trim()}`).join(", ");
    const sel = cols.map((col) => {
      if (t.key === "journal_entries") {
        if (col === "posted_at") return "transaction_timestamp()";
        if (col === "status") return "case when x.status = 'reversed' then 'posted' else x.status end";
        if (col === "reversed_by" || col === "reversed_at") return "null";
      }
      return `x.${ident(col)}`;
    });
    await c.query(
      `insert into ${ident(t.table)} (${cols.map(ident).join(", ")})
       select ${sel.join(", ")}
         from finance_ledger_archives a, jsonb_populate_recordset(null::${ident(t.table)}, a.${t.key}) x
        where a.id = $1 and x.user_id = $2
        order by ${order}`,
      [archiveId, acct],
    );
    if (t.key === "journal_lines") {
      // Every entry and its lines are in; now the reversals can be marked (the one update the ledger allows).
      await c.query(
        `update journal_entries e set status = 'reversed', reversed_by = x.reversed_by, reversed_at = x.reversed_at
           from finance_ledger_archives a, jsonb_populate_recordset(null::journal_entries, a.journal_entries) x
          where a.id = $1 and x.user_id = $2 and x.status = 'reversed' and e.id = x.id and e.user_id = x.user_id`,
        [archiveId, acct],
      );
    }
  }
  for (const t of ["journal_entries", "journal_lines", "ledger_outbox"]) await bumpSequence(c, t);

  const s = a.settings ?? {};
  await c.query(
    `update finance_settings set accounting_mode = coalesce($2, accounting_mode), ledger_started_at = $3::timestamptz,
            agency_collections_to_trust = coalesce($4::boolean, agency_collections_to_trust), updated_at = now()
      where account_user_id = $1`,
    [acct, s.accounting_mode ?? null, s.ledger_started_at ?? null, s.agency_collections_to_trust ?? null],
  );
  const hasRuns = (await c.query(`select to_regclass('finance_control_runs') is not null as ok`)).rows[0]?.ok === true;
  if (hasRuns) await c.query(`delete from finance_control_runs where user_id = $1 and trigger in ('nightly','manual')`, [acct]);
  await c.query(`update finance_ledger_archives set restored_at = now(), restored_by = $2 where id = $1`, [archiveId, actorUserId]);
  void reason;
  return { restored: true, accountUserId: acct, counts: await ledgerCounts(c, acct) };
}
