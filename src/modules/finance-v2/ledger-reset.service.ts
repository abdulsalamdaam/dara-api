import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "./db";
import { FinanceFlagService, type AccountingMode } from "./flag.service";
import { FinanceSetupService } from "./setup.service";
import { FinanceV2AdminService, toSettingsDto } from "./admin.service";
import { PostingWorker } from "./posting-worker.service";
import { LOCK_KEYS } from "./lock-keys";
import { auditRow, settingsEvent } from "./audit";

/**
 * Admin "reset ledger & change accounting mode" (super admin only).
 *
 * The accounting mode is frozen at the first posting (admin.service.ts toggle),
 * because Owner and Manager post the same rent differently (own income vs money
 * held for a landlord). Flipping the column on a posted ledger would leave the
 * history in one mode and new postings in the other, so the only way to change
 * it is to throw the ledger away and post the history again with the backfill.
 *
 * What is deleted is ONLY what the backfill rebuilds from the account's own
 * records (`fv2_purge_account(id, true)`, 0066): journal entries and lines, the
 * posting queue (ledger_outbox, including its posting errors), the installment
 * charge and VAT-point markers the posting writes; plus the stored control-check
 * results of the old ledger (nightly/manual runs, a cache the nightly job
 * re-creates). `ledger_started_at` is cleared, so nothing posts until the admin
 * runs the backfill (dry run, then real) — this service never runs it.
 *
 * Kept: the chart, periods, bank accounts, settings (except the mode) and their
 * history, backfill-run history, and every record or document (legacy or v2).
 *
 * Refused (BLOCKERS) when the rebuild would lose or contradict something that
 * is not derivable: a closed/locked or VAT-locked period, a locked VAT return,
 * a posted manual or opening journal, a cutover ledger, any entry the backfill
 * cannot re-create, bank reconciliation matches against journal lines,
 * commission runs (they point at ledger lines), issued v2 vouchers (payout,
 * deposit refund, tenant credit, supplier payment, commission transfer), fixed
 * assets; and for Owner mode its precondition and any commission document.
 *
 * Concurrency: the whole reset runs under the account's posting lock (the
 * worker, backfill, repair sweep and catch-up all take it), the SETUP lock the
 * toggle takes, a try-lock on the auto-provisioning key, and a row lock on
 * finance_settings; blockers are re-checked inside that transaction.
 */

export type BlockerCode =
  | "NOT_ENABLED_BEFORE" | "PERIODS_CLOSED" | "VAT_RETURNS_LOCKED" | "MANUAL_JOURNALS" | "CUTOVER_LEDGER"
  | "NON_REBUILDABLE_ENTRIES" | "BANK_MATCHES" | "COMMISSION_RUNS" | "PAYOUT_VOUCHERS" | "DEPOSIT_REFUNDS"
  | "TENANT_CREDIT_ACTIONS" | "SUPPLIER_PAYMENTS" | "COMMISSION_TRANSFERS" | "FIXED_ASSETS"
  | "OWNER_MODE_PRECONDITION" | "COMMISSION_DOCUMENTS";

export interface Blocker {
  code: BlockerCode;
  count: number;
  message: string;
  /** Up to 20 ids of the offending rows. */
  sample: Array<number | string>;
}

export interface ResetPreview {
  accountUserId: number;
  current: { enabled: boolean; accountingMode: AccountingMode | null; ledgerStartedAt: string | null };
  targetMode: AccountingMode;
  modeChanges: boolean;
  /** Rows the reset deletes. */
  willDelete: {
    journalEntries: number;
    journalLines: number;
    outbox: number;
    postingErrors: number;
    installmentCharges: number;
    installmentVatPoints: number;
    controlRuns: number;
  };
  /** Kept as they are (informational). */
  kept: {
    backfillRuns: number;
    chartAccounts: number;
    fiscalPeriods: number;
    bankAccounts: number;
    documents: number;
    zatcaReportedDocuments: number;
  };
  /** Manager mode needs an active default trust bank account; the reset creates it as the enable path does. */
  trust: { required: boolean; exists: boolean; willCreate: boolean };
  blockers: Blocker[];
  canReset: boolean;
}

/** Source types the backfill extracts (backfill/extract.ts); an entry of any other kind cannot be re-created. */
export const REBUILDABLE_SOURCES = [
  "simple_invoice", "payment", "payment_collection", "expense", "landlord_payout", "write_off",
  "tenant_credit_action", "supplier_bill", "supplier_payment", "commission_transfer", "contract",
] as const;
/** Journal origins the live posting and the backfill produce (a reversal of one of the above included). */
const REBUILDABLE_ORIGINS = ["auto", "backfill", "reversal"];

const NEXT_STEP = "Run History and backfill next: a dry run first, then the real run with the same settings.";

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

export function parseMode(v: unknown): AccountingMode {
  if (v !== "owner" && v !== "manager") throw new BadRequestException({ error: "BAD_MODE", message: "accountingMode must be 'owner' or 'manager'" });
  return v;
}

export function parseResetBody(accountUserId: number, body: any): { accountingMode: AccountingMode; reason: string } {
  const accountingMode = parseMode(body?.accountingMode);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 5 || reason.length > 500) throw new BadRequestException({ error: "REASON_REQUIRED", message: "reason is required (5–500 characters)" });
  const confirm = body?.confirm == null ? "" : String(body.confirm).trim();
  if (confirm !== String(accountUserId)) {
    throw new BadRequestException({ error: "CONFIRM_MISMATCH", message: `Type the account id (${accountUserId}) in confirm to reset its ledger` });
  }
  return { accountingMode, reason };
}

@Injectable()
export class LedgerResetService {
  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly flag: FinanceFlagService,
    private readonly setup: FinanceSetupService,
    private readonly admin: FinanceV2AdminService,
    private readonly worker: PostingWorker,
  ) {}

  /** GET /admin/finance-v2/:id/reset-preview?mode= — read only. */
  async preview(accountUserId: number, rawMode: unknown): Promise<ResetPreview> {
    await this.admin.loadTarget(this.pool, accountUserId);
    return this.inspect(this.pool, accountUserId, parseMode(rawMode));
  }

  /** POST /admin/finance-v2/:id/reset-ledger — body { accountingMode, reason, confirm: "<id>" }. */
  async reset(actorUserId: number, accountUserId: number, rawBody: any) {
    const body = parseResetBody(accountUserId, rawBody);
    const target = await this.admin.loadTarget(this.pool, accountUserId);

    const result = await this.worker.withAccountLock(accountUserId, () => withTx(this.pool, async (c) => {
      const busy = (await c.query(`select pg_try_advisory_xact_lock($1, $2) as ok`, [accountUserId, LOCK_KEYS.AUTO_PROVISION])).rows[0]?.ok !== true;
      if (busy) throw new ConflictException({ error: "LEDGER_BUSY", message: "Automatic provisioning is running for this account; try again in a minute" });
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [accountUserId, LOCK_KEYS.SETUP]);
      const cur = (await c.query(`select * from finance_settings where account_user_id = $1 for update`, [accountUserId])).rows[0];

      const pre = await this.inspect(c, accountUserId, body.accountingMode);
      if (pre.blockers.length) {
        throw new ConflictException({ error: "RESET_BLOCKED", message: "The ledger cannot be reset", blockers: pre.blockers });
      }

      // Derived ledger rows only (0066 fv2_purge_account, ledger-only form).
      await c.query(`select fv2_purge_account($1, true)`, [accountUserId]);
      let controlRuns = 0;
      if (await tableExists(c, "finance_control_runs")) {
        controlRuns = (await c.query(`delete from finance_control_runs where user_id = $1 and trigger in ('nightly','manual')`, [accountUserId])).rowCount ?? 0;
      }

      const oldMode: AccountingMode | null = cur.accounting_mode ?? null;
      await c.query(
        `update finance_settings set accounting_mode = $2, ledger_started_at = null, updated_at = now() where account_user_id = $1`,
        [accountUserId, body.accountingMode],
      );

      // What the enable path does for the new mode (Manager: the default trust account and trust routing). Idempotent.
      let trustBankAccountId: number | null = null;
      if (body.accountingMode === "manager") {
        if (cur.finance_v2_enabled) await this.setup.firstEnable(c, accountUserId, actorUserId);
        trustBankAccountId = await this.setup.ensureTrust(c, accountUserId, actorUserId);
      }

      const deleted = { ...pre.willDelete, controlRuns };
      await settingsEvent(c, accountUserId, actorUserId, "ledger_reset",
        { accountingMode: oldMode, ledgerStartedAt: cur.ledger_started_at ?? null },
        { accountingMode: body.accountingMode, deleted }, body.reason);
      if (oldMode !== body.accountingMode) {
        await settingsEvent(c, accountUserId, actorUserId, "accounting_mode", oldMode, body.accountingMode, body.reason);
      }
      // An automatically provisioned account would be re-backfilled by the auto-provisioning sweep (enabled, not
      // started, last enable by actor 0). The reset hands it to the admin: record the enable as the admin's.
      const lastEnable = (await c.query(
        `select actor_user_id, new_value from finance_settings_events where account_user_id = $1 and field = 'finance_v2_enabled'
          order by created_at desc, id desc limit 1`, [accountUserId])).rows[0];
      if (cur.finance_v2_enabled && lastEnable && Number(lastEnable.actor_user_id) === 0) {
        await settingsEvent(c, accountUserId, actorUserId, "finance_v2_enabled", true, true, `ledger reset: ${body.reason}`.slice(0, 500));
      }
      await auditRow(c, accountUserId, actorUserId, "finance_v2", accountUserId, `/admin/finance-v2/${accountUserId}/reset-ledger`);

      const settings = (await c.query(`select * from finance_settings where account_user_id = $1`, [accountUserId])).rows[0];
      return { previousMode: oldMode, deleted, trustBankAccountId, settings: toSettingsDto(settings) };
    }));

    this.flag.invalidate(accountUserId);
    return {
      reset: true,
      account: { id: target.id, userType: target.userType },
      previousMode: result.previousMode,
      accountingMode: body.accountingMode,
      deleted: result.deleted,
      trustBankAccountId: result.trustBankAccountId,
      settings: result.settings,
      next: { backfill: { mode: "full", dryRunFirst: true }, message: NEXT_STEP },
    };
  }

  /** Counts and blockers, on the pool (preview) or inside the reset's transaction (re-check). */
  async inspect(q: Q, id: number, targetMode: AccountingMode): Promise<ResetPreview> {
    const cur = (await q.query(`select * from finance_settings where account_user_id = $1`, [id])).rows[0];
    const blockers: Blocker[] = [];
    const add = (code: BlockerCode, rows: Array<{ id: number | string }>, total: number, message: string) => {
      if (total > 0) blockers.push({ code, count: total, message, sample: rows.slice(0, 20).map((r) => r.id) });
    };
    const n = async (sql: string, p: unknown[] = [id]) => Number((await q.query(sql, p)).rows[0]?.n ?? 0);
    const listed = async (table: string, sql: string): Promise<{ rows: Array<{ id: number | string }>; total: number }> => {
      if (!(await tableExists(q, table))) return { rows: [], total: 0 };
      const r = (await q.query(`with x as (${sql}) select id, count(*) over () as total from x order by id limit 20`, [id])).rows;
      return { rows: r, total: Number(r[0]?.total ?? 0) };
    };
    const block = async (code: BlockerCode, table: string, sql: string, message: string) => {
      const r = await listed(table, sql);
      add(code, r.rows, r.total, message);
    };

    if (!cur?.accounting_mode) {
      blockers.push({ code: "NOT_ENABLED_BEFORE", count: 1, sample: [], message: "Accounting has never been set up for this account; use the switch instead" });
    }
    await block("PERIODS_CLOSED", "fiscal_periods",
      `select id from fiscal_periods where user_id = $1 and (status <> 'open' or vat_locked_at is not null)`,
      "Closed, locked or VAT-locked periods: the rebuilt ledger could not post into them");
    await block("VAT_RETURNS_LOCKED", "finance_vat_return_drafts",
      `select id from finance_vat_return_drafts where user_id = $1 and locked_at is not null`,
      "Locked (filed) VAT returns were computed from this ledger");
    await block("MANUAL_JOURNALS", "manual_journals",
      `select id from manual_journals where user_id = $1 and (status = 'posted' or (kind = 'opening' and status not in ('void','rejected')))`,
      "Posted manual or opening journals are not re-created by the backfill");
    if (cur?.ledger_go_live_date) {
      blockers.push({ code: "CUTOVER_LEDGER", count: 1, sample: [], message: "The ledger was started at a cutover date with an opening balance" });
    }
    await block("NON_REBUILDABLE_ENTRIES", "journal_entries",
      `select id from journal_entries where user_id = $1
          and (origin not in (${sqlList(REBUILDABLE_ORIGINS)}) or source_type not in (${sqlList(REBUILDABLE_SOURCES)}))`,
      "Journal entries the backfill cannot re-create (manual, closing, VAT settlement, fixed assets …)");
    await block("BANK_MATCHES", "bank_matches",
      `select id from bank_matches where user_id = $1 and journal_line_id is not null`,
      "Bank reconciliation matches point at journal lines");
    await block("COMMISSION_RUNS", "finance_commission_runs",
      `select id from finance_commission_runs where user_id = $1`,
      "Commission runs count specific ledger lines; a rebuild would count them again");
    await block("PAYOUT_VOUCHERS", "finance_payout_vouchers",
      `select payout_id as id from finance_payout_vouchers where user_id = $1`,
      "Issued landlord payout vouchers (PV-)");
    await block("DEPOSIT_REFUNDS", "finance_deposit_refunds",
      `select id from finance_deposit_refunds where user_id = $1`,
      "Issued deposit refund vouchers (PV-)");
    await block("TENANT_CREDIT_ACTIONS", "tenant_credit_actions",
      `select id from tenant_credit_actions where user_id = $1`,
      "Tenant credit refunds / applications");
    await block("SUPPLIER_PAYMENTS", "supplier_payments",
      `select id from supplier_payments where user_id = $1`,
      "Issued supplier payment vouchers (PV-)");
    await block("COMMISSION_TRANSFERS", "finance_commission_transfers",
      `select id from finance_commission_transfers where user_id = $1`,
      "Commission transfers (TRF-)");
    await block("FIXED_ASSETS", "fixed_assets",
      `select id from fixed_assets where user_id = $1 and status <> 'void'`,
      "Fixed assets and their depreciation runs");
    if (targetMode === "owner") {
      const v = await this.admin.ownerModeViolations(q, id);
      add("OWNER_MODE_PRECONDITION", v.map((x) => ({ id: x })), v.length,
        "Owner mode needs every landlord with an active contract to be the account holder; use Manager mode");
      await block("COMMISSION_DOCUMENTS", "simple_invoices",
        `select id from simple_invoices where user_id = $1 and kind = 'commission' and status = 'confirmed' and deleted_at is null`,
        "Issued commission documents exist; Owner mode has no commission");
    }

    const ex = async (table: string, sql: string) => ((await tableExists(q, table)) ? n(sql) : 0);
    const willDelete = {
      journalEntries: await ex("journal_entries", `select count(*)::int as n from journal_entries where user_id = $1`),
      journalLines: await ex("journal_lines", `select count(*)::int as n from journal_lines where user_id = $1`),
      outbox: await ex("ledger_outbox", `select count(*)::int as n from ledger_outbox where user_id = $1`),
      postingErrors: await ex("ledger_outbox", `select count(*)::int as n from ledger_outbox where user_id = $1 and status in ('failed','dismissed')`),
      installmentCharges: await ex("finance_installment_charges", `select count(*)::int as n from finance_installment_charges where user_id = $1`),
      installmentVatPoints: await ex("finance_installment_vat_points", `select count(*)::int as n from finance_installment_vat_points where user_id = $1`),
      controlRuns: await ex("finance_control_runs", `select count(*)::int as n from finance_control_runs where user_id = $1 and trigger in ('nightly','manual')`),
    };
    const kept = {
      backfillRuns: await ex("finance_backfill_runs", `select count(*)::int as n from finance_backfill_runs where user_id = $1`),
      chartAccounts: await ex("accounts", `select count(*)::int as n from accounts where user_id = $1`),
      fiscalPeriods: await ex("fiscal_periods", `select count(*)::int as n from fiscal_periods where user_id = $1`),
      bankAccounts: await ex("bank_accounts", `select count(*)::int as n from bank_accounts where user_id = $1`),
      documents: await ex("simple_invoices", `select count(*)::int as n from simple_invoices where user_id = $1 and deleted_at is null`),
      zatcaReportedDocuments: await ex("simple_invoices",
        `select count(*)::int as n from simple_invoices where user_id = $1 and zatca_status in ('reported','cleared')`),
    };
    const trustExists = (await tableExists(q, "bank_accounts"))
      && (await n(`select count(*)::int as n from bank_accounts where user_id = $1 and kind = 'bank' and is_trust and is_active and is_default`)) > 0;
    const required = targetMode === "manager";
    return {
      accountUserId: id,
      current: { enabled: cur?.finance_v2_enabled === true, accountingMode: cur?.accounting_mode ?? null, ledgerStartedAt: cur?.ledger_started_at ?? null },
      targetMode,
      modeChanges: (cur?.accounting_mode ?? null) !== targetMode,
      willDelete,
      kept,
      trust: { required, exists: trustExists, willCreate: required && !trustExists },
      blockers,
      canReset: blockers.length === 0,
    };
  }
}

/** A constant list as SQL literals (the values are fixed identifiers in this file, never input). */
function sqlList(xs: readonly string[]): string {
  return xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(", ");
}

async function tableExists(q: Q, table: string): Promise<boolean> {
  return (await q.query(`select to_regclass($1) is not null as ok`, [table])).rows[0]?.ok === true;
}
