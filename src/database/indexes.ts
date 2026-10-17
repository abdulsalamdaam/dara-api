import { Logger } from "@nestjs/common";
import { pool } from "@dara/database";

const log = new Logger("DBIndexes");

/**
 * List / filter indexes, built on every boot with `CREATE INDEX CONCURRENTLY
 * IF NOT EXISTS`.
 *
 * Why not inside `ensureSchema()`: that runs before `listen()`, and a
 * concurrent build waits for every transaction already open against the table
 * (the outgoing container is still serving while the new one boots). Blocking
 * boot on that is how a deploy misses its health check. So these run in the
 * background after the API is listening, one at a time, on one connection.
 *
 * Why CONCURRENTLY: a plain CREATE INDEX holds a SHARE lock — every INSERT /
 * UPDATE / DELETE on the table waits for the whole build. CONCURRENTLY takes
 * SHARE UPDATE EXCLUSIVE, so reads and writes carry on. It cannot run inside a
 * transaction block or a multi-statement query string, hence one
 * `client.query` per statement and no BEGIN.
 *
 * An interrupted concurrent build (container killed mid-build, lock_timeout)
 * leaves an INVALID index behind that `IF NOT EXISTS` would happily skip for
 * ever while the planner never uses it. Each boot therefore checks
 * `pg_index.indisvalid` first and drops + rebuilds an invalid one.
 *
 * Every entry is justified by a query in src/modules — see `serves`. Before
 * adding one, check `pg_indexes` on staging: each index costs write time on
 * every insert/update of its table.
 */
export interface IndexSpec {
  name: string;
  table: string;
  /** Everything after `ON <table>`: `[USING …] (cols) [WHERE …]`. */
  def: string;
  /** The query it is for — documentation, and checked non-empty by the spec. */
  serves: string;
  /**
   * Older indexes this one makes redundant; dropped once this one is valid.
   * Only for an index nothing re-creates on boot — otherwise it would be
   * rebuilt (non-concurrently) and dropped again on every deploy.
   */
  supersedes?: string[];
}

const LIVE = "where deleted_at is null";

export const LIST_INDEXES: IndexSpec[] = [
  // ── contracts ───────────────────────────────────────────────────────────
  { name: "contracts_user_created_idx", table: "contracts", def: `(user_id, created_at desc, id desc) ${LIVE}`,
    serves: "GET /contracts — user_id + deleted_at is null, order by created_at, id (both directions); per-status counts" },
  { name: "contracts_tenant_idx", table: "contracts", def: "(tenant_id)",
    serves: "contracts ?tenantId= filter, tenant detail / delete guards, join from tenants" },

  // ── payments / collections ──────────────────────────────────────────────
  { name: "payments_user_due_idx", table: "payments", def: `(user_id, due_date, id) ${LIVE}`,
    serves: "GET /payments — user_id + deleted_at is null, order by due_date, id; dueFrom/dueTo calendar window" },
  { name: "payments_contract_idx", table: "payments", def: "(contract_id)",
    serves: "installments of a contract (?contractIds=, contract finance panel, schedule regen, ~30 call sites)" },
  { name: "payment_collections_invoice_idx", table: "payment_collections", def: "(invoice_id)",
    serves: "collections by invoice: the not-exists in the Collections union, per-invoice paid sums in GET /billing" },
  { name: "payment_collections_user_date_idx", table: "payment_collections", def: "(user_id, collected_date)",
    serves: "GET /payments/collections and reports — collections by account, ordered by collected_date" },
  { name: "finance_write_offs_payments_idx", table: "finance_write_offs", def: "(user_id, payment_ids)",
    serves: "v2 live status / remaining: `w.user_id = p.user_id and w.payment_ids = array[p.id]`, probed per payment row" },
  { name: "finance_ejar_settlements_payment_idx", table: "finance_ejar_settlements", def: "(payment_id)",
    serves: "v2 ejarSettledSqlV2: `es.payment_id = p.id and es.user_id = p.user_id`, probed per payment row" },

  // ── simple_invoices ─────────────────────────────────────────────────────
  { name: "simple_invoices_user_created_idx", table: "simple_invoices", def: `(user_id, created_at desc, id desc) ${LIVE}`,
    serves: "GET /billing — user_id + deleted_at is null, order by created_at, id desc" },
  { name: "simple_invoices_contract_idx", table: "simple_invoices", def: "(contract_id)",
    serves: "a contract's documents (contract finance, deposit, termination; ~25 call sites)" },
  { name: "simple_invoices_billing_ref_idx", table: "simple_invoices", def: "(user_id, billing_reference) where billing_reference is not null",
    serves: "credit/debit notes against an invoice: user_id + billing_reference = / in (…)" },
  { name: "simple_invoices_payment_ids_gin", table: "simple_invoices",
    def: "using gin ((coalesce(payment_ids, '[]'::jsonb)) jsonb_path_ops)",
    serves: "`coalesce(si.payment_ids, '[]'::jsonb) @> jsonb_build_array(p.id)` — invoiced-installment probes (due-uninvoiced, auto-invoice, recognizer, awaitingCollection)" },

  // ── properties / units / parties / deeds ────────────────────────────────
  { name: "properties_user_created_idx", table: "properties", def: `(user_id, created_at desc, id desc) ${LIVE}`,
    serves: "GET /properties — user_id + deleted_at is null, order by created_at, id" },
  { name: "properties_owner_idx", table: "properties", def: "(owner_id)",
    serves: "a landlord's properties (?ownerIds= on contracts/units, landlord detail and delete guards)" },
  { name: "units_property_idx", table: "units", def: "(property_id)",
    serves: "units of a property (~65 call sites incl. the contracts property filter exists-join)" },
  { name: "owners_user_created_idx", table: "owners", def: `(user_id, created_at desc, id desc) ${LIVE}`,
    serves: "GET /owners — user_id + deleted_at is null, order by created_at, id" },
  { name: "tenants_user_created_idx", table: "tenants", def: `(user_id, created_at desc, id desc) ${LIVE}`,
    serves: "GET /tenants — user_id + deleted_at is null, order by created_at, id" },
  { name: "deeds_user_created_idx", table: "deeds", def: `(user_id, created_at desc, id desc) ${LIVE}`,
    serves: "GET /deeds — user_id + deleted_at is null, default order by created_at, id" },

  // ── tenant-facing / operations lists ────────────────────────────────────
  { name: "payment_confirmations_user_created_idx", table: "payment_confirmations", def: `(user_id, created_at desc, id desc) ${LIVE}`,
    serves: "GET /payment-confirmations (landlord) — order by created_at, id; status filter applied on top" },
  { name: "payment_confirmations_tenant_created_idx", table: "payment_confirmations", def: `(tenant_id, created_at desc, id desc) ${LIVE}`,
    serves: "tenant app: own confirmations by tenant_id, order by created_at, id" },
  { name: "maintenance_requests_user_created_idx", table: "maintenance_requests", def: `(user_id, created_at desc, id desc) ${LIVE}`,
    serves: "GET /maintenance — user_id + deleted_at is null, order by created_at, id; status filter applied on top" },
  { name: "expenses_user_date_idx", table: "expenses", def: `(user_id, expense_date desc, id desc) ${LIVE}`,
    serves: "GET /reports/expenses — user_id + deleted_at is null, order by expense_date, id" },
  { name: "facilities_user_created_idx", table: "facilities", def: `(user_id, created_at desc, id desc) ${LIVE}`,
    serves: "GET /facilities — order by created_at, id" },
  { name: "campaigns_user_created_idx", table: "campaigns", def: `(user_id, created_at desc, id desc) ${LIVE}`,
    serves: "GET /campaigns — order by created_at, id" },
  { name: "notifications_tenant_created_idx", table: "notifications", def: `(tenant_id, created_at desc, id desc) ${LIVE}`,
    serves: "tenant app notifications — tenant_id + deleted_at is null, order by created_at, id" },
  { name: "notifications_user_created_idx", table: "notifications", def: `(user_id, created_at desc, id desc) ${LIVE}`,
    serves: "landlord notifications list — user_id + deleted_at is null, order by created_at, id" },

  // ── support / audit / admin ─────────────────────────────────────────────
  { name: "support_messages_ticket_created_idx", table: "support_messages", def: "(ticket_id, created_at desc, id desc)",
    serves: "last-message subqueries per ticket in GET /support, and a ticket's thread" },
  { name: "support_tickets_user_updated_idx", table: "support_tickets", def: "(user_id, updated_at desc, id desc)",
    serves: "GET /support (customer) — user_id, order by updated_at, id" },
  { name: "audit_logs_owner_created_idx", table: "audit_logs", def: "(owner_user_id, created_at desc, id desc)",
    serves: "GET /audit — owner_user_id, order by created_at, id",
    supersedes: ["audit_logs_owner_idx"] },
  { name: "login_logs_created_idx", table: "login_logs", def: "(created_at desc, id desc)",
    serves: "admin login log — order by created_at desc, id desc; from/to window" },

  // ── news ────────────────────────────────────────────────────────────────
  { name: "news_items_feed_v2_idx", table: "news_items", def: "(status, pinned desc, posted_at desc nulls last, id desc)",
    // Not superseding news_items_feed_idx: 0061 (run on every boot) recreates
    // it, so dropping it here would only rebuild it on the next boot.
    serves: "GET /news — status = 'published', order by pinned desc, posted_at desc nulls last, id desc. The old (status, pinned, posted_at) index cannot return NULLS LAST in a backward scan" },

  // ── finance v2 bank reconciliation ──────────────────────────────────────
  { name: "bank_statement_lines_unmatched_idx", table: "bank_statement_lines",
    def: "(user_id, bank_account_id, txn_date) where match_status = 'unmatched'",
    serves: "reconciliation summary: unrecorded bank items up to period_to for one bank account" },
];

/** The statement that builds one index. Exported for the spec. */
export function createSql(ix: IndexSpec): string {
  return `create index concurrently if not exists "${ix.name}" on "${ix.table}" ${ix.def}`;
}

const LOCK_KEY = 0x6461_7269; // "dari" — one index job per database at a time

async function tableExists(client: any, table: string): Promise<boolean> {
  const r = await client.query(`select to_regclass($1) is not null as ok`, [`public.${table}`]);
  return !!r.rows[0]?.ok;
}

/** `null` = no such index; otherwise whether it is valid. */
async function indexState(client: any, name: string): Promise<boolean | null> {
  const r = await client.query(
    `select i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = $1`, [name]);
  return r.rows.length ? !!r.rows[0].indisvalid : null;
}

/**
 * Build every missing index. Never throws: a failure is logged and the next
 * index is tried — an index is a performance aid, not something to take the
 * API down over.
 */
export async function ensureListIndexes(specs: IndexSpec[] = LIST_INDEXES): Promise<void> {
  let client: any;
  try {
    client = await pool.connect();
  } catch (err: any) {
    log.warn(`index job: no connection: ${err?.message || err}`);
    return;
  }
  let locked = false;
  try {
    // Session-level, so it covers every statement below without a transaction.
    // A second container booting against the same database skips the job
    // rather than racing this one (and mistaking its in-progress build, which
    // is INVALID until it finishes, for a leftover to drop).
    locked = !!(await client.query(`select pg_try_advisory_lock($1) as ok`, [LOCK_KEY])).rows[0]?.ok;
    if (!locked) {
      log.log("index job: another session holds the lock — skipped");
      return;
    }
    // No statement timeout for a build; but do not queue behind a stuck
    // transaction for ever. A build that times out waiting is left INVALID,
    // dropped below, and retried on the next boot.
    await client.query(`set statement_timeout = 0`);
    await client.query(`set lock_timeout = '120s'`);

    let built = 0;
    for (const ix of specs) {
      try {
        if (!(await tableExists(client, ix.table))) continue;
        const state = await indexState(client, ix.name);
        if (state === false) {
          log.warn(`index ${ix.name} is INVALID (interrupted build) — dropping and rebuilding`);
          await client.query(`drop index concurrently if exists "${ix.name}"`);
        }
        if (state !== true) {
          const t0 = Date.now();
          await client.query(createSql(ix));
          built++;
          log.log(`index ${ix.name} built in ${Date.now() - t0} ms`);
        }
        for (const old of ix.supersedes ?? []) {
          if ((await indexState(client, ix.name)) !== true) break;
          if ((await indexState(client, old)) === null) continue;
          await client.query(`drop index concurrently if exists "${old}"`);
          log.log(`index ${old} dropped (superseded by ${ix.name})`);
        }
      } catch (err: any) {
        log.warn(`index ${ix.name} failed: ${err?.message || err}`);
        // A failed concurrent build leaves its INVALID shell behind; clear it
        // now so it is not maintained on every write until the next boot.
        try {
          if ((await indexState(client, ix.name)) === false) await client.query(`drop index concurrently if exists "${ix.name}"`);
        } catch { /* next boot retries */ }
      }
    }
    log.log(built ? `index job: ${built} index(es) built` : "index job: all list indexes present");
  } catch (err: any) {
    log.warn(`index job failed: ${err?.message || err}`);
  } finally {
    try {
      if (locked) await client.query(`select pg_advisory_unlock($1)`, [LOCK_KEY]);
      await client.query(`reset lock_timeout`);
      await client.query(`reset statement_timeout`);
    } catch { /* connection is going back anyway */ }
    client.release();
  }
}
