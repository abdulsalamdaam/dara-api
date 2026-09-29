import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "./db";
import { FinanceFlagService, type AccountingMode } from "./flag.service";
import { FinanceSetupService } from "./setup.service";
import { isCustomerAccount } from "../../common/permissions";
import { LOCK_KEYS } from "./lock-keys";

export interface ToggleBody {
  enabled: boolean;
  accountingMode?: AccountingMode;
  reason: string;
}

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

export function parseToggleBody(body: any): ToggleBody {
  if (typeof body?.enabled !== "boolean") throw new BadRequestException("enabled must be a boolean");
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 5 || reason.length > 500) throw new BadRequestException("reason is required (5–500 characters)");
  const mode = body?.accountingMode;
  if (mode !== undefined && mode !== null && mode !== "owner" && mode !== "manager") {
    throw new BadRequestException("accountingMode must be 'owner' or 'manager'");
  }
  return { enabled: body.enabled, accountingMode: mode ?? undefined, reason };
}

/**
 * The admin switch (DESIGN §1.5): `PATCH /api/admin/finance-v2/:accountUserId`.
 * One transaction: upsert finance_settings, a finance_settings_events row per
 * changed field, an `audit_logs` row under the TARGET account (so it shows in
 * that account's activity log), and on enable the idempotent first-enable
 * setup. The flag cache is invalidated after the commit.
 */
@Injectable()
export class FinanceV2AdminService {
  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly flag: FinanceFlagService,
    private readonly setup: FinanceSetupService,
  ) {}

  async toggle(actorUserId: number, accountUserId: number, rawBody: any) {
    const body = parseToggleBody(rawBody);
    const target = await this.loadTarget(this.pool, accountUserId);

    const result = await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [accountUserId, LOCK_KEYS.SETUP]);
      const cur = (await c.query(`select * from finance_settings where account_user_id = $1 for update`, [accountUserId])).rows[0];
      const wasOn = cur?.finance_v2_enabled === true;
      const oldMode: AccountingMode | null = cur?.accounting_mode ?? null;
      const newMode: AccountingMode | null = body.accountingMode ?? oldMode;

      if (body.enabled && !newMode) throw new BadRequestException("accountingMode is required on the first enable");
      if (newMode !== oldMode && oldMode !== null) {
        const posted = await c.query(`select 1 from journal_entries where user_id = $1 limit 1`, [accountUserId]);
        if (posted.rowCount) throw new ConflictException("The accounting mode cannot change after the first posting");
      }
      if (newMode === "owner" && newMode !== oldMode) {
        const offending = await this.ownerModeViolations(c, accountUserId);
        if (offending.length) {
          throw new BadRequestException(
            `Owner mode needs every landlord with an active contract to be the account holder (${offending.length} are not); use manager mode`);
        }
      }

      const turningOn = body.enabled && !wasOn;
      const s = (await c.query(
        `insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode, enabled_at, enabled_by)
         values ($1, $2, $3, case when $2 then now() end, case when $2 then $4::int end)
         on conflict (account_user_id) do update set
           finance_v2_enabled = excluded.finance_v2_enabled,
           accounting_mode    = excluded.accounting_mode,
           enabled_at = case when $5 then now() else finance_settings.enabled_at end,
           enabled_by = case when $5 then $4::int else finance_settings.enabled_by end,
           updated_at = now()
         returning *`,
        [accountUserId, body.enabled, newMode, actorUserId, turningOn],
      )).rows[0];

      await this.event(c, accountUserId, actorUserId, "finance_v2_enabled", cur ? wasOn : null, body.enabled, body.reason);
      if (newMode !== oldMode) await this.event(c, accountUserId, actorUserId, "accounting_mode", oldMode, newMode, body.reason);

      await c.query(
        `insert into audit_logs (owner_user_id, actor_user_id, action, entity, entity_id, method, path)
         values ($1, $2, 'update', 'finance_v2', $3, 'PATCH', $4)`,
        [accountUserId, actorUserId, String(accountUserId), `/admin/finance-v2/${accountUserId}`],
      );

      const setup = body.enabled ? await this.setup.firstEnable(c, accountUserId, actorUserId) : null;
      const settings = (await c.query(`select * from finance_settings where account_user_id = $1`, [accountUserId])).rows[0] ?? s;
      return { settings: toSettingsDto(settings), setup, firstEnable: turningOn && !cur?.enabled_at };
    });

    this.flag.invalidate(accountUserId);
    return { ...result, account: { id: target.id, userType: target.userType }, backfill: { suggested: body.enabled && !result.settings.ledgerStartedAt } };
  }

  /** Flag state per customer account, with the suggested mode for the enable dialog. */
  async listAccounts() {
    const r = await this.pool.query(
      `select u.id, u.name, u.email, u.user_type as "userType",
              coalesce(fs.finance_v2_enabled, false) as enabled, fs.accounting_mode as mode,
              fs.enabled_at as "enabledAt", fs.ledger_started_at as "ledgerStartedAt"
         from users u
         left join roles r on r.id = u.role_id
         left join finance_settings fs on fs.account_user_id = u.id
        where u.owner_user_id is null and u.deleted_at is null
          and coalesce(r.key, '') not in ('super_admin', 'admin')
        order by u.id`,
    );
    return r.rows;
  }

  async events(accountUserId: number) {
    const r = await this.pool.query(
      `select id, actor_user_id as "actorUserId", field, old_value as "oldValue", new_value as "newValue", reason, created_at as "createdAt"
         from finance_settings_events where account_user_id = $1 order by created_at desc, id desc limit 200`,
      [accountUserId],
    );
    return r.rows;
  }

  /**
   * DESIGN §4.2 default: manager when the account is a company with a
   * third-party landlord who holds a property; owner otherwise, and only when
   * the Owner-mode precondition holds.
   */
  async suggestMode(accountUserId: number, q: Q = this.pool): Promise<AccountingMode> {
    const t = await this.loadTarget(q, accountUserId);
    if (t.userType === "company") {
      const third = await q.query(
        `select 1 from owners o where o.user_id = $1 and o.deleted_at is null and not o.is_account_holder
            and exists (select 1 from properties p where p.owner_id = o.id and p.deleted_at is null) limit 1`,
        [accountUserId],
      );
      if (third.rowCount) return "manager";
    }
    return (await this.ownerModeViolations(q, accountUserId)).length ? "manager" : "owner";
  }

  /**
   * Owner-mode precondition (DESIGN §4.2): every landlord with an active
   * contract is the account-holder landlord, or carries the same VAT number
   * (when unregistered, the same ID/CR number) as it. Returns the offending
   * owner ids.
   */
  async ownerModeViolations(q: Q, accountUserId: number): Promise<number[]> {
    const r = await q.query(
      `with holder as (
         select nullif(trim(tax_number), '') as vat, nullif(trim(id_number), '') as idn
           from owners where user_id = $1 and is_account_holder and deleted_at is null order by id limit 1
       ), active_owners as (
         select distinct p.owner_id
           from contracts c
           join contract_units cu on cu.contract_id = c.id
           join units u on u.id = cu.unit_id
           join properties p on p.id = u.property_id
          where c.user_id = $1 and c.status = 'active' and c.deleted_at is null and p.owner_id is not null
       )
       select o.id from owners o join active_owners a on a.owner_id = o.id
         left join holder h on true
        where not o.is_account_holder
          and not coalesce(h.vat is not null and nullif(trim(o.tax_number), '') = h.vat, false)
          and not coalesce(h.vat is null and h.idn is not null and nullif(trim(o.id_number), '') = h.idn, false)
        order by o.id`,
      [accountUserId],
    );
    return r.rows.map((x: any) => x.id);
  }

  private async loadTarget(q: Q, accountUserId: number) {
    if (!Number.isInteger(accountUserId) || accountUserId <= 0) throw new BadRequestException("Invalid account id");
    const r = await q.query(
      `select u.id, u.owner_user_id as "ownerUserId", r.key as "roleKey", u.user_type as "userType"
         from users u left join roles r on r.id = u.role_id where u.id = $1 and u.deleted_at is null`,
      [accountUserId],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundException("Account not found");
    if (!isCustomerAccount(row)) throw new BadRequestException("Finance v2 applies to customer accounts only");
    return row as { id: number; ownerUserId: number | null; roleKey: string | null; userType: string };
  }

  private async event(c: Fv2Client, acct: number, actor: number, field: string, oldV: unknown, newV: unknown, reason: string) {
    await c.query(
      `insert into finance_settings_events (account_user_id, actor_user_id, field, old_value, new_value, reason)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [acct, actor, field, JSON.stringify(oldV ?? null), JSON.stringify(newV ?? null), reason],
    );
  }
}

export function toSettingsDto(r: any) {
  if (!r) return null;
  return {
    accountUserId: r.account_user_id,
    enabled: r.finance_v2_enabled,
    accountingMode: r.accounting_mode,
    fiscalYearStartMonth: r.fiscal_year_start_month,
    vatFilingFrequency: r.vat_filing_frequency,
    defaultBankAccountId: r.default_bank_account_id,
    defaultCashAccountId: r.default_cash_account_id,
    agencyCollectionsToTrust: r.agency_collections_to_trust,
    commissionBasis: r.commission_basis,
    depositForfeitVat: r.deposit_forfeit_vat,
    ledgerGoLiveDate: r.ledger_go_live_date,
    ledgerStartedAt: r.ledger_started_at,
    deferRentStraightLine: r.defer_rent_straight_line,
    inputVatMethod: r.input_vat_method,
    enabledAt: r.enabled_at,
    enabledBy: r.enabled_by,
  };
}
