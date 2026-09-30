import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "./db";
import { toSettingsDto } from "./admin.service";
import { auditRow, requireReason, settingsEvent } from "./audit";
import { LOCK_KEYS } from "./lock-keys";
import { BankAccountsService } from "./tier1/bank-accounts.service";
import { FinanceFlagService } from "./flag.service";

/** The fields `PATCH /finance/v2/settings` may change (DESIGN §10.2), camelCase → column. */
const EDITABLE = {
  defaultBankAccountId: "default_bank_account_id",
  defaultCashAccountId: "default_cash_account_id",
  vatFilingFrequency: "vat_filing_frequency",
  commissionBasis: "commission_basis",
  depositForfeitVat: "deposit_forfeit_vat",
  agencyCollectionsToTrust: "agency_collections_to_trust",
} as const;
type Editable = keyof typeof EDITABLE;

/**
 * Settings the account can see but not change here: the mode is set by the
 * admin toggle and refused after the first posting (§4.2, §1.5); the fiscal
 * year start cannot move once periods exist (§2.3.3), and they are seeded at
 * the first enable; straight-line deferral and the input-VAT method are
 * accountant decisions (Q23, Q25) with no account-level switch in §10.2.
 */
export const READ_ONLY_SETTINGS = ["accountingMode", "fiscalYearStartMonth", "deferRentStraightLine", "inputVatMethod"] as const;
/** Status fields of the DTO; not settings. */
const STATUS_FIELDS = ["accountUserId", "enabled", "ledgerGoLiveDate", "ledgerStartedAt", "enabledAt", "enabledBy"];

const bad = (error: string, message: string) => new BadRequestException({ error, message });

/**
 * GET / PATCH /api/finance/v2/settings (DESIGN §10.2): the account's own
 * finance settings. GET needs `view`, PATCH `settings` (§10.1: the account
 * holder, or a role holding invoices.delete + expenses.approve +
 * payments.write). A PATCH needs a reason, changes only the fields that differ,
 * and writes one `finance_settings_events` row per changed field plus one
 * `audit_logs` row, in one transaction.
 */
@Injectable()
export class FinanceSettingsService {
  private readonly banks: BankAccountsService;

  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    @Optional() banks?: BankAccountsService,
    @Optional() private readonly flag?: FinanceFlagService,
  ) {
    this.banks = banks ?? new BankAccountsService(pool);
  }

  async get(scope: number) {
    const r = await this.pool.query(`select * from finance_settings where account_user_id = $1`, [scope]);
    if (!r.rows[0]) throw new NotFoundException();
    return this.shape(r.rows[0]);
  }

  async patch(scope: number, actorId: number, body: any) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("BAD_INPUT", "The body must be an object");
    const keys = Object.keys(body).filter((k) => k !== "reason");
    for (const k of keys) {
      if ((READ_ONLY_SETTINGS as readonly string[]).includes(k) || STATUS_FIELDS.includes(k)) {
        throw bad("FIELD_READ_ONLY", k === "accountingMode"
          ? "accountingMode is set by the Dara admin and cannot change after the first posting"
          : k === "fiscalYearStartMonth"
            ? "fiscalYearStartMonth cannot change once fiscal periods exist"
            : `${k} cannot be changed here`);
      }
      if (!(k in EDITABLE)) throw bad("UNKNOWN_FIELD", `Unknown field: ${k}`);
    }
    const reason = requireReason(body);
    if (!keys.length) throw bad("NOTHING_TO_CHANGE", "Name at least one setting to change");
    const want = this.parse(body, keys as Editable[]);

    const out = await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.SETUP]);
      const cur = (await c.query(`select * from finance_settings where account_user_id = $1 for update`, [scope])).rows[0];
      if (!cur) throw new NotFoundException();
      const changed = (Object.keys(want) as Editable[]).filter((k) => cur[EDITABLE[k]] !== want[k]);

      for (const k of changed) {
        if (k === "defaultBankAccountId" || k === "defaultCashAccountId") {
          await this.assertBox(c, scope, want[k] as number, k === "defaultCashAccountId" ? "cash" : "bank", k);
        }
        if (k === "vatFilingFrequency") {
          const locked = await c.query(`select 1 from fiscal_periods where user_id = $1 and vat_locked_at is not null limit 1`, [scope]);
          if (locked.rowCount) {
            throw new ConflictException({ error: "VAT_RETURN_LOCKED", message: "A VAT return is already locked; the filing frequency can no longer change" });
          }
        }
        if (k === "agencyCollectionsToTrust" && want[k] === true) {
          if (cur.accounting_mode !== "manager") throw bad("NOT_MANAGER_MODE", "Trust routing applies in Manager mode only");
          const t = await c.query(
            `select 1 from bank_accounts where user_id = $1 and kind = 'bank' and is_trust and is_default and is_active limit 1`, [scope]);
          if (!t.rowCount) throw bad("TRUST_ACCOUNT_REQUIRED", "Add a default client-money (trust) bank account first");
        }
      }

      for (const k of changed) {
        if (k === "defaultBankAccountId" || k === "defaultCashAccountId") {
          // Keeps bank_accounts.is_default and finance_settings in step, exactly as the bank-accounts screen does.
          await this.banks.makeDefault(c, scope, want[k] as number, k === "defaultCashAccountId" ? "cash" : "bank", false);
        } else {
          await c.query(`update finance_settings set ${EDITABLE[k]} = $2, updated_at = now() where account_user_id = $1`, [scope, want[k]]);
        }
        await settingsEvent(c, scope, actorId, EDITABLE[k], cur[EDITABLE[k]], want[k], reason);
      }
      if (changed.length) await auditRow(c, scope, actorId, "finance_v2_settings", scope, "/finance/v2/settings", "PATCH");
      return (await c.query(`select * from finance_settings where account_user_id = $1`, [scope])).rows[0];
    });
    this.flag?.invalidate(scope);
    return this.shape(out);
  }

  private parse(body: any, keys: Editable[]): Partial<Record<Editable, unknown>> {
    const want: Partial<Record<Editable, unknown>> = {};
    const oneOf = (k: Editable, allowed: string[]) => {
      if (typeof body[k] !== "string" || !allowed.includes(body[k])) throw bad("BAD_VALUE", `${k} must be one of ${allowed.join(", ")}`);
      return body[k];
    };
    for (const k of keys) {
      switch (k) {
        case "defaultBankAccountId":
        case "defaultCashAccountId": {
          const n = Number(body[k]);
          if (!Number.isSafeInteger(n) || n <= 0 || typeof body[k] === "boolean") throw bad("BAD_VALUE", `${k} must be a bank account id`);
          want[k] = n;
          break;
        }
        case "vatFilingFrequency": want[k] = oneOf(k, ["monthly", "quarterly"]); break;
        case "depositForfeitVat": want[k] = oneOf(k, ["O", "S", "E"]); break;
        case "commissionBasis":
          want[k] = oneOf(k, ["billed", "collected"]);
          // The collected basis needs the commission run (§9 E1, POST /landlords/:id/commission-run), which is not built:
          // accepting it would silently stop nothing and start nothing.
          if (want[k] === "collected") {
            throw new ConflictException({ error: "COMMISSION_BASIS_UNAVAILABLE", message: "The collected commission basis is not available yet" });
          }
          break;
        case "agencyCollectionsToTrust":
          if (typeof body[k] !== "boolean") throw bad("BAD_VALUE", `${k} must be a boolean`);
          want[k] = body[k];
          break;
      }
    }
    return want;
  }

  /** An active, non-trust box of this scope and kind; a miss is 404 (§10.2), a wrong kind 400. */
  private async assertBox(c: Fv2Client, scope: number, id: number, kind: "bank" | "cash", field: string) {
    const r = await c.query(`select kind, is_trust, is_active from bank_accounts where id = $1 and user_id = $2`, [id, scope]);
    const b = r.rows[0];
    if (!b) throw new NotFoundException({ error: "BANK_ACCOUNT_NOT_FOUND", message: "Bank account not found" });
    if (b.kind !== kind || b.is_trust || !b.is_active) {
      throw bad("BAD_BANK_ACCOUNT", `${field} must be an active ${kind === "cash" ? "cash box" : "operating (non-trust) bank account"}`);
    }
  }

  private shape(row: any) {
    const d: any = toSettingsDto(row);
    return {
      accountingMode: d.accountingMode,
      fiscalYearStartMonth: d.fiscalYearStartMonth,
      vatFilingFrequency: d.vatFilingFrequency,
      defaultBankAccountId: d.defaultBankAccountId,
      defaultCashAccountId: d.defaultCashAccountId,
      agencyCollectionsToTrust: d.agencyCollectionsToTrust,
      commissionBasis: d.commissionBasis,
      depositForfeitVat: d.depositForfeitVat,
      deferRentStraightLine: d.deferRentStraightLine,
      inputVatMethod: d.inputVatMethod,
      ledgerGoLiveDate: d.ledgerGoLiveDate,
      ledgerStarted: d.ledgerStartedAt != null,
      editable: Object.keys(EDITABLE),
      readOnly: [...READ_ONLY_SETTINGS],
    };
  }
}
