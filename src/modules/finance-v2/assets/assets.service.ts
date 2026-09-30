import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { FV2_POOL, withTx, type Fv2Client, type Fv2Pool } from "../db";
import { LedgerEmitter, type LedgerEvent } from "../ledger-emitter.service";
import { auditRow, isoDate, requireReason } from "../audit";
import { fromHalalas, toHalalas } from "../money";
import { riyadhToday } from "../dates";
import { LOCK_KEYS } from "../lock-keys";
import { sqlOf } from "../hooks/sql";
import { loadSettings } from "../hooks/facts-loader";
import { asciiDigits } from "../tier1/iban";
import { BankAccountsService } from "../tier1/bank-accounts.service";
import { ChartService } from "../chart.service";
import { riyadhNow } from "../reports/core-math";
import { langOf } from "../reports/common";
import { ASSET_COLS, ASSET_SOURCE, assetCols, assetEvents, lastDueMonth, scheduleInput, type AssetRow } from "./asset-events";
import { addMonths, depreciableBase, disposalFigures, lastChargeMonth, monthOf, schedule } from "./asset-math";

type Q = Pick<Fv2Client, "query"> | Fv2Pool;

export const ASSET_CATEGORIES = ["buildings", "land", "furniture", "equipment", "computers", "vehicles", "software", "other"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

/**
 * Default accounts per category (chart codes; DESIGN §8.5). Land is never
 * depreciated. Buildings are the investment-property accounts an Owner-mode
 * account depreciates; an office's own furniture, computers and cars share the
 * equipment contra (1229) and expense (5320).
 */
export const CATEGORY_DEFAULTS: Record<AssetCategory, { asset: string; accum: string | null; expense: string | null; lifeMonths: number }> = {
  buildings: { asset: "1212", accum: "1213", expense: "5310", lifeMonths: 480 },
  land: { asset: "1211", accum: null, expense: null, lifeMonths: 0 },
  furniture: { asset: "1221", accum: "1229", expense: "5320", lifeMonths: 120 },
  equipment: { asset: "1224", accum: "1229", expense: "5320", lifeMonths: 60 },
  computers: { asset: "1222", accum: "1229", expense: "5320", lifeMonths: 36 },
  vehicles: { asset: "1223", accum: "1229", expense: "5320", lifeMonths: 60 },
  software: { asset: "1231", accum: "1239", expense: "5340", lifeMonths: 36 },
  other: { asset: "1224", accum: "1229", expense: "5320", lifeMonths: 60 },
};
/** Gain and loss on disposal. */
export const DISPOSAL_ACCOUNTS = { gain: "4420", loss: "5350" } as const;

/** Fields that shape the ledger: frozen once the asset has any queued event. */
const FINANCIAL = [
  "acquisitionDate", "cost", "salvageValue", "usefulLifeMonths", "depreciationStart", "openingAccumulated",
  "assetAccountId", "accumAccountId", "expenseAccountId", "acquisitionMode", "acquisitionBankAccountId",
] as const;

const bad = (error: string, message: string) => new BadRequestException({ error, message });
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function optStr(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw bad("BAD_INPUT", `${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw bad("BAD_INPUT", `${field} is too long (max ${max})`);
  return s || null;
}
function optId(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad("BAD_INPUT", `${field} must be an id`);
  return n;
}
function money(v: unknown, field: string, opts: { positive?: boolean; dflt?: number } = {}): number {
  if ((v === undefined || v === null || v === "") && opts.dflt !== undefined) return opts.dflt;
  let x: number;
  try {
    x = toHalalas(asciiDigits(String(v ?? "")).trim());
  } catch {
    throw bad("BAD_AMOUNT", `المبلغ غير صالح · ${field} must be a decimal with at most 2 places`);
  }
  if (x < 0 || (opts.positive && x === 0)) throw bad("BAD_AMOUNT", `${field} must be ${opts.positive ? "positive" : "zero or more"}`);
  return x;
}
export function monthParam(v: unknown, field = "month"): string {
  const s = typeof v === "string" ? asciiDigits(v).trim() : "";
  if (!MONTH_RE.test(s)) throw bad("BAD_MONTH", `${field} must be YYYY-MM`);
  return s;
}

export interface AssetOut extends AssetRow {
  name: string;
  propertyName: string | null;
  /** Opening accumulated + depreciation booked in the ledger (as of today). */
  accumulated: string;
  nbv: string;
  /** A full month's charge (the pro-rata first and the last month differ). */
  monthlyCharge: string;
  /** The month the depreciable base is used up; null when not depreciated. */
  fullyDepreciatedIn: string | null;
  /** Latest month whose depreciation has posted. */
  lastPostedMonth: string | null;
  pending: number;
  failed: number;
  /** True once the asset has a queued ledger event: its financial fields are frozen. */
  posted: boolean;
}

/**
 * The fixed-asset register (DESIGN §8.5): add / edit / delete, dispose, void,
 * the depreciation preview and run (per month, idempotent per asset and
 * month), the run history and the asset schedule report. Every ledger effect
 * goes through the outbox (rules FA01–FA03), so late events route to the next
 * open period like every other v2 event.
 */
@Injectable()
export class AssetsService {
  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly emitter: LedgerEmitter,
    private readonly banks: BankAccountsService,
    private readonly chart: ChartService,
  ) {}

  /** Riyadh "today" (a seam for the specs; never set in production). */
  clock: () => string = riyadhToday;

  /** Categories with their default account ids (the chart topped up first). */
  async defaults(scope: number) {
    await this.chart.topUp(this.pool, scope);
    const ids = await this.codeIds(this.pool, scope);
    const acc = (code: string | null) => (code ? ids.get(code) ?? null : null);
    return {
      categories: ASSET_CATEGORIES.map((k) => ({
        key: k, lifeMonths: CATEGORY_DEFAULTS[k].lifeMonths, depreciable: CATEGORY_DEFAULTS[k].accum !== null,
        assetAccountId: acc(CATEGORY_DEFAULTS[k].asset), accumAccountId: acc(CATEGORY_DEFAULTS[k].accum), expenseAccountId: acc(CATEGORY_DEFAULTS[k].expense),
      })),
      gainAccountId: acc(DISPOSAL_ACCOUNTS.gain),
      lossAccountId: acc(DISPOSAL_ACCOUNTS.loss),
    };
  }

  /** ?status&category&propertyId&q&lang */
  async list(scope: number, q: any = {}): Promise<{ rows: AssetOut[]; totals: { cost: string; accumulated: string; nbv: string } }> {
    const where = ["a.user_id = $1"];
    const params: unknown[] = [scope];
    if (q?.status && ["active", "disposed", "void"].includes(q.status)) { params.push(q.status); where.push(`a.status = $${params.length}`); }
    else if (q?.status !== "all") where.push(`a.status <> 'void'`);
    if (q?.category && (ASSET_CATEGORIES as readonly string[]).includes(q.category)) { params.push(q.category); where.push(`a.category = $${params.length}`); }
    const pid = optId(q?.propertyId, "propertyId");
    if (pid) { params.push(pid); where.push(`a.property_id = $${params.length}`); }
    const text = optStr(q?.q, "q", 100);
    if (text) { params.push(`%${text}%`); where.push(`(a.name_ar ilike $${params.length} or a.name_en ilike $${params.length} or a.number ilike $${params.length})`); }
    const r = await this.pool.query(`select ${assetCols("a")} from fixed_assets a where ${where.join(" and ")} order by a.acquisition_date desc, a.id desc`, params);
    const rows = await this.decorate(this.pool, scope, r.rows, langOf(q?.lang));
    let cost = 0, acc = 0;
    for (const x of rows) if (x.status === "active") { cost += toHalalas(x.cost); acc += toHalalas(x.accumulated); }
    return { rows, totals: { cost: fromHalalas(cost), accumulated: fromHalalas(acc), nbv: fromHalalas(cost - acc) } };
  }

  /** One asset with its full schedule (each month's posting state) and its ledger entries. */
  async get(scope: number, id: number, lang: "ar" | "en" = "ar", q: Q = this.pool) {
    const a = await this.load(q, scope, id);
    const [out] = await this.decorate(q, scope, [a], lang);
    const s = scheduleInput(a);
    const events = (await q.query(
      `select o.event, to_char(o.occurred_on,'YYYY-MM-DD') as date, o.status, o.last_error_code as "errorCode", o.skip_reason as "skipReason",
              e.id::int as "entryId", e.entry_no as "entryNo", to_char(e.entry_date,'YYYY-MM-DD') as "entryDate", e.status as "entryStatus", e.is_late as "isLate",
              e.total::text as total
         from ledger_outbox o left join journal_entries e on e.id = o.entry_id and e.user_id = o.user_id
        where o.user_id = $1 and o.source_type = $2 and o.source_id = $3 order by o.occurred_on, o.id`,
      [scope, ASSET_SOURCE, id])).rows;
    const byEvent = new Map(events.map((e: any) => [e.event, e]));
    const until = a.status === "disposed" && a.disposedOn ? addMonths(monthOf(a.disposedOn), -1) : undefined;
    const rows = a.status === "void" ? [] : schedule(s, until).map((r) => {
      const e: any = byEvent.get(`dep:${r.month}`);
      const reversed = byEvent.has(`reversal:dep:${r.month}`);
      return {
        month: r.month, charge: fromHalalas(r.charge), accumulated: fromHalalas(r.accumulated), nbv: fromHalalas(r.nbv),
        state: reversed ? "reversed" : e ? e.status : "not_queued", entryId: e?.entryId ?? null, entryNo: e?.entryNo ?? null,
        entryDate: e?.entryDate ?? null, isLate: e?.isLate === true,
      };
    });
    let disposal = null;
    if (a.status === "disposed" && a.disposedOn) {
      const f = disposalFigures(s, a.disposedOn, toHalalas(a.disposalProceeds ?? "0"));
      const e: any = byEvent.get("disposed");
      disposal = {
        date: a.disposedOn, proceeds: fromHalalas(toHalalas(a.disposalProceeds ?? "0")), partial: fromHalalas(f.partial),
        accumulated: fromHalalas(f.accumulated), nbv: fromHalalas(f.nbv), gain: fromHalalas(f.gain),
        state: e?.status ?? "not_queued", entryId: e?.entryId ?? null, entryNo: e?.entryNo ?? null,
      };
    }
    return { ...out, schedule: rows, disposal, events };
  }

  async create(scope: number, user: { id: number }, body: any) {
    const today = this.clock();
    const res = await withTx(this.pool, async (c) => {
      await this.chart.topUp(c, scope);
      const v = await this.normalise(c, scope, body, null);
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.FIXED_ASSET]);
      const [n] = (await c.query(
        `select coalesce(max(cast(substring(number from '^FA-([0-9]+)$') as integer)), 0) + 1 as n from fixed_assets where user_id = $1 and number ~ '^FA-[0-9]+$'`,
        [scope])).rows;
      const number = `FA-${String(n.n).padStart(6, "0")}`;
      const r = await c.query(
        `insert into fixed_assets (user_id, number, name_ar, name_en, category, property_id, acquisition_date, cost, salvage_value, useful_life_months,
                                   depreciation_start, opening_accumulated, asset_account_id, accum_account_id, expense_account_id, acquisition_mode,
                                   acquisition_bank_account_id, notes, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning id`,
        [scope, number, v.nameAr, v.nameEn, v.category, v.propertyId, v.acquisitionDate, fromHalalas(v.cost), fromHalalas(v.salvage), v.life,
          v.depreciationStart, fromHalalas(v.opening), v.assetAccountId, v.accumAccountId, v.expenseAccountId, v.acquisitionMode,
          v.acquisitionBankAccountId, v.notes, user.id]);
      const id = Number(r.rows[0].id);
      await auditRow(c, scope, user.id, "finance_v2_fixed_asset", id, "/finance/v2/assets");
      await this.sync(c, scope, id, today);
      return id;
    });
    this.emitter.kick(scope);
    return this.get(scope, res);
  }

  /** Descriptive fields always; the financial ones only while nothing is queued for the asset. */
  async update(scope: number, user: { id: number }, id: number, body: any) {
    const today = this.clock();
    await withTx(this.pool, async (c) => {
      const cur = await this.lock(c, scope, id);
      if (cur.status !== "active") throw new ConflictException({ error: "ASSET_NOT_ACTIVE", message: "Only an active asset can be edited" });
      const posted = await this.hasEvents(c, scope, id);
      const merged: any = { ...cur, ...Object.fromEntries(Object.entries(body ?? {}).filter(([, x]) => x !== undefined)) };
      // A new category brings its default accounts, unless the body names them (only while nothing is posted).
      if (!posted && body?.category && body.category !== cur.category) {
        for (const k of ["assetAccountId", "accumAccountId", "expenseAccountId"]) if (body[k] === undefined) delete merged[k];
      }
      const v = await this.normalise(c, scope, merged, cur);
      if (posted) {
        const before = await this.normalise(c, scope, cur, cur);
        const changed = FINANCIAL.filter((k) => body?.[k] !== undefined && JSON.stringify((v as any)[fieldKey(k)]) !== JSON.stringify((before as any)[fieldKey(k)]));
        if (changed.length) {
          throw new ConflictException({ error: "ASSET_POSTED", fields: changed,
            message: `للأصل قيود مرحّلة؛ لا يمكن تعديل (${changed.join(", ")}). ألغِ الأصل وأعد إدخاله · The asset has ledger entries; void it and enter it again to change ${changed.join(", ")}` });
        }
      }
      await c.query(
        `update fixed_assets set name_ar = $3, name_en = $4, category = $5, property_id = $6, acquisition_date = $7, cost = $8, salvage_value = $9,
                useful_life_months = $10, depreciation_start = $11, opening_accumulated = $12, asset_account_id = $13, accum_account_id = $14,
                expense_account_id = $15, acquisition_mode = $16, acquisition_bank_account_id = $17, notes = $18, updated_at = now()
          where id = $1 and user_id = $2`,
        [id, scope, v.nameAr, v.nameEn, v.category, v.propertyId, v.acquisitionDate, fromHalalas(v.cost), fromHalalas(v.salvage), v.life,
          v.depreciationStart, fromHalalas(v.opening), v.assetAccountId, v.accumAccountId, v.expenseAccountId, v.acquisitionMode,
          v.acquisitionBankAccountId, v.notes]);
      await auditRow(c, scope, user.id, "finance_v2_fixed_asset", id, `/finance/v2/assets/${id}`, "PATCH");
      await this.sync(c, scope, id, today);
    });
    this.emitter.kick(scope);
    return this.get(scope, id);
  }

  /** Only an asset that never reached the ledger (nothing queued); otherwise void it. */
  async remove(scope: number, user: { id: number }, id: number): Promise<{ ok: true }> {
    await withTx(this.pool, async (c) => {
      await this.lock(c, scope, id);
      if (await this.hasEvents(c, scope, id)) {
        throw new ConflictException({ error: "ASSET_POSTED", message: "للأصل قيود؛ استخدم الإلغاء · The asset has ledger entries; void it instead" });
      }
      await c.query(`delete from fixed_assets where id = $1 and user_id = $2`, [id, scope]);
      await auditRow(c, scope, user.id, "finance_v2_fixed_asset", id, `/finance/v2/assets/${id}`, "DELETE");
    });
    return { ok: true };
  }

  /**
   * {date, proceeds?, bankAccountId?, note?} — sale or scrapping. The month's
   * depreciation up to the date, then cost and accumulated depreciation leave
   * the books with the gain (4420) or loss (5350). No VAT is booked on the
   * proceeds (issue a tax invoice for a taxable sale separately).
   */
  async dispose(scope: number, user: { id: number }, id: number, body: any) {
    const today = this.clock();
    await withTx(this.pool, async (c) => {
      await this.chart.topUp(c, scope);
      const a = await this.lock(c, scope, id);
      if (a.status !== "active") throw new ConflictException({ error: "ASSET_NOT_ACTIVE", message: "Only an active asset can be disposed" });
      const date = isoDate(body?.date, "date");
      if (date < a.acquisitionDate) throw bad("BAD_DATE", "تاريخ الاستبعاد قبل تاريخ الشراء · The disposal date is before the acquisition date");
      if (date > today) throw bad("BAD_DATE", "لا يمكن استبعاد أصل بتاريخ مستقبلي · The disposal date cannot be in the future");
      const s = await loadSettings(sqlOf(c as any), scope);
      if (s?.goLive && date < s.goLive) throw bad("BEFORE_GO_LIVE", `The disposal date is before the ledger go-live date (${s.goLive})`);
      const proceeds = money(body?.proceeds, "proceeds", { dflt: 0 });
      const bankId = await this.banks.assertUsable(c, scope, body?.bankAccountId);
      const ids = await this.codeIds(c, scope);
      const f = disposalFigures(scheduleInput(a), date, proceeds);
      if (f.gain > 0 && !ids.get(DISPOSAL_ACCOUNTS.gain)) throw bad("MISSING_ACCOUNT", "the chart has no gain-on-disposal account (4420)");
      if (f.gain < 0 && !ids.get(DISPOSAL_ACCOUNTS.loss)) throw bad("MISSING_ACCOUNT", "the chart has no loss-on-disposal account (5350)");
      await c.query(
        `update fixed_assets set status = 'disposed', disposed_on = $3, disposal_proceeds = $4, disposal_bank_account_id = $5, disposal_note = $6,
                disposed_by = $7, disposed_at = now(), updated_at = now() where id = $1 and user_id = $2`,
        [id, scope, date, fromHalalas(proceeds), bankId, optStr(body?.note, "note", 500), user.id]);
      await auditRow(c, scope, user.id, "finance_v2_fixed_asset", id, `/finance/v2/assets/${id}/dispose`);
      // Depreciation through the month before the disposal first (catch-up), then the disposal itself.
      await this.sync(c, scope, id, today, addMonths(monthOf(date), -1));
    });
    this.emitter.kick(scope);
    return this.get(scope, id);
  }

  /** {reason} — every ledger event of the asset is reversed (today) and the asset leaves the register. */
  async void(scope: number, user: { id: number }, id: number, body: any) {
    const reason = requireReason(body);
    const today = this.clock();
    await withTx(this.pool, async (c) => {
      const a = await this.lock(c, scope, id);
      if (a.status === "void") throw new ConflictException({ error: "ASSET_VOID", message: "The asset is already void" });
      await c.query(
        `update fixed_assets set status = 'void', voided_on = $3, voided_by = $4, voided_at = now(), void_reason = $5, updated_at = now()
          where id = $1 and user_id = $2`, [id, scope, today, user.id, reason]);
      await auditRow(c, scope, user.id, "finance_v2_fixed_asset", id, `/finance/v2/assets/${id}/void`);
      await this.sync(c, scope, id, today);
    });
    this.emitter.kick(scope);
    return this.get(scope, id);
  }

  // ── Depreciation runs ──

  /** What a run for `month` would queue now: every missing event through that month, per asset. */
  async preview(scope: number, q: any) {
    const today = this.clock();
    const month = q?.month ? monthParam(q.month) : lastDueMonth(today);
    this.assertRunnable(month, today);
    const lang = langOf(q?.lang);
    const qq = sqlOf(this.pool as any);
    const ids = (await this.pool.query(`select id from fixed_assets where user_id = $1 and status <> 'void' order by id`, [scope])).rows;
    const rows: any[] = [];
    for (const x of ids) {
      const r = await assetEvents(qq, scope, Number(x.id), today, month);
      if (!r) continue;
      const missing = await this.missing(this.pool, scope, r.events);
      for (const e of missing) {
        const f: any = (e.payload as any).facts;
        rows.push({
          assetId: r.asset.id, number: r.asset.number, name: lang === "en" ? r.asset.nameEn || r.asset.nameAr : r.asset.nameAr,
          event: e.event, kind: e.event.startsWith("reversal:") ? "reversal" : (e.payload as any).rule, date: e.occurredOn,
          amount: f.amount ?? f.cost ?? null,
        });
      }
    }
    const periods = await this.closedPeriods(scope, rows.map((r) => r.date));
    for (const r of rows) r.late = periods.has(r.date);
    const total = rows.filter((r) => r.kind === "FA02").reduce((s, r) => s + toHalalas(r.amount), 0);
    return { month, generatedAt: riyadhNow(), rows, count: rows.length, depreciationTotal: fromHalalas(total) };
  }

  /**
   * Queue every missing depreciation (and any other missing event) of every
   * asset through `month`. Idempotent: the outbox key is per asset and month,
   * so a second run queues nothing. Logged in fixed_asset_dep_runs (an auto
   * run only when it queued something).
   */
  async runMonth(scope: number, actorId: number | null, month: string, trigger: "auto" | "manual", today = this.clock()) {
    this.assertRunnable(month, today);
    const out = await withTx(this.pool, async (c) => {
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.FIXED_ASSET]);
      const ids = (await c.query(`select id from fixed_assets where user_id = $1 and status <> 'void' order by id for update`, [scope])).rows;
      let queued = 0, total = 0, assets = 0;
      for (const x of ids) {
        const r = await this.sync(c, scope, Number(x.id), today, month);
        if (r.queued.length) assets++;
        queued += r.queued.length;
        for (const e of r.queued) if ((e.payload as any).rule === "FA02") total += toHalalas((e.payload as any).facts.amount);
      }
      let runId: number | null = null;
      if (trigger === "manual" || queued > 0) {
        runId = Number((await c.query(
          `insert into fixed_asset_dep_runs (user_id, month, trigger, run_by, assets, queued, total) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [scope, month, trigger, actorId, assets, queued, fromHalalas(total)])).rows[0].id);
        if (actorId) await auditRow(c, scope, actorId, "finance_v2_depreciation_run", runId, "/finance/v2/depreciation/run");
      }
      return { runId, month, assets, queued, total: fromHalalas(total) };
    });
    if (out.queued) this.emitter.kick(scope);
    return out;
  }

  /** The run log and, per month, what the ledger holds (from the outbox). */
  async runs(scope: number) {
    const runs = (await this.pool.query(
      `select r.id, r.month, r.trigger, r.run_by as "runBy", u.name as "runByName", r.run_at as "runAt", r.assets, r.queued, r.total::text as total
         from fixed_asset_dep_runs r left join users u on u.id = r.run_by
        where r.user_id = $1 order by r.run_at desc, r.id desc limit 100`, [scope])).rows;
    const months = (await this.pool.query(
      `select substring(o.event from 5) as month, count(*)::int as entries,
              coalesce(sum((o.payload->'facts'->>'amount')::numeric(14,2)) filter (where not exists (
                select 1 from ledger_outbox r where r.user_id = o.user_id and r.source_type = o.source_type and r.source_id = o.source_id
                   and r.event = 'reversal:' || o.event and r.status in ('pending','posted'))), 0)::numeric(14,2)::text as total,
              count(*) filter (where o.status = 'posted')::int as posted, count(*) filter (where o.status = 'pending')::int as pending,
              count(*) filter (where o.status = 'failed')::int as failed,
              count(*) filter (where exists (select 1 from ledger_outbox r where r.user_id = o.user_id and r.source_type = o.source_type
                                               and r.source_id = o.source_id and r.event = 'reversal:' || o.event))::int as reversed,
              count(*) filter (where e.is_late)::int as late
         from ledger_outbox o left join journal_entries e on e.id = o.entry_id and e.user_id = o.user_id
        where o.user_id = $1 and o.source_type = $2 and o.event ~ '^dep:[0-9]{4}-[0-9]{2}$'
        group by 1 order by 1 desc limit 120`, [scope, ASSET_SOURCE])).rows;
    return { runs: runs.map((r: any) => ({ ...r, total: fromHalalas(toHalalas(r.total)) })), months };
  }

  // ── Asset schedule report ──

  /**
   * ?from&to&lang&category&propertyId — per asset: cost at the start, additions,
   * disposals, cost at the end; accumulated depreciation at the start, the
   * period's depreciation (from the ledger), removed on disposal, at the end;
   * the net book value at the end. Void assets, and assets disposed before
   * `from`, are left out.
   */
  async scheduleReport(scope: number, q: any = {}) {
    const today = this.clock();
    const to = q?.to ? isoDate(q.to, "to") : today;
    const from = q?.from ? isoDate(q.from, "from") : `${to.slice(0, 4)}-01-01`;
    if (from > to) throw bad("BAD_RANGE", "from must not be after to");
    const lang = langOf(q?.lang);
    const params: unknown[] = [scope, to, from];
    let extra = "";
    if (q?.category && (ASSET_CATEGORIES as readonly string[]).includes(q.category)) { params.push(q.category); extra += ` and a.category = $${params.length}`; }
    const pid = optId(q?.propertyId, "propertyId");
    if (pid) { params.push(pid); extra += ` and a.property_id = $${params.length}`; }
    const assets = (await this.pool.query(
      `select ${assetCols("a")}, p.name as "propertyName"
         from fixed_assets a left join properties p on p.id = a.property_id and p.user_id = a.user_id
        where a.user_id = $1 and a.status <> 'void' and a.acquisition_date <= $2::date
          and not (a.status = 'disposed' and a.disposed_on < $3::date)${extra}
        order by a.category, a.number`, params)).rows as Array<AssetRow & { propertyName: string | null }>;
    const ledger = new Map<number, { accBefore: number; accTo: number; dep: number }>();
    if (assets.length) {
      const r = await this.pool.query(
        `select e.source_id::int as id,
                coalesce(sum(l.credit - l.debit) filter (where l.account_id = a.accum_account_id and l.entry_date < $2::date), 0)::text as acc_before,
                coalesce(sum(l.credit - l.debit) filter (where l.account_id = a.accum_account_id and l.entry_date <= $3::date), 0)::text as acc_to,
                coalesce(sum(l.debit - l.credit) filter (where l.account_id = a.expense_account_id and l.entry_date between $2::date and $3::date), 0)::text as dep
           from journal_entries e
           join journal_lines l on l.entry_id = e.id and l.user_id = e.user_id
           join fixed_assets a on a.id = e.source_id and a.user_id = e.user_id
          where e.user_id = $1 and e.source_type = $4 and e.source_id = any($5::bigint[])
          group by e.source_id`,
        [scope, from, to, ASSET_SOURCE, assets.map((a) => a.id)]);
      for (const x of r.rows) ledger.set(Number(x.id), { accBefore: toHalalas(x.acc_before), accTo: toHalalas(x.acc_to), dep: toHalalas(x.dep) });
    }
    const T = { costOpen: 0, additions: 0, disposals: 0, costClose: 0, accOpen: 0, depreciation: 0, accRemoved: 0, accClose: 0, nbvOpen: 0, nbvClose: 0 };
    const rows = assets.map((a) => {
      const cost = toHalalas(a.cost);
      const opening = toHalalas(a.openingAccumulated);
      const L = ledger.get(a.id) ?? { accBefore: 0, accTo: 0, dep: 0 };
      const acquiredBefore = a.acquisitionDate < from;
      const goneBefore = a.status === "disposed" && !!a.disposedOn && a.disposedOn < from;
      const disposedIn = a.status === "disposed" && !!a.disposedOn && a.disposedOn >= from && a.disposedOn <= to;
      const costOpen = acquiredBefore && !goneBefore ? cost : 0;
      const additions = acquiredBefore ? 0 : cost;
      const disposals = disposedIn ? cost : 0;
      const costClose = costOpen + additions - disposals;
      // Opening accumulated depreciation is part of the balance from the day the asset is on the register.
      const accOpen = goneBefore ? 0 : (acquiredBefore ? opening : 0) + L.accBefore;
      const accClose = opening + L.accTo;
      const depreciation = L.dep;
      const accRemoved = accOpen + (acquiredBefore ? 0 : opening) + depreciation - accClose;
      const row = {
        id: a.id, number: a.number, name: lang === "en" ? a.nameEn || a.nameAr : a.nameAr, category: a.category, propertyId: a.propertyId,
        propertyName: a.propertyName ?? null, acquisitionDate: a.acquisitionDate, status: a.status, disposedOn: a.disposedOn,
        usefulLifeMonths: a.usefulLifeMonths,
        costOpen, additions, disposals, costClose, accOpen, depreciation, accRemoved, accClose, nbvOpen: costOpen - accOpen, nbvClose: costClose - accClose,
      };
      for (const k of Object.keys(T) as Array<keyof typeof T>) T[k] += row[k];
      return row;
    });
    const f = (n: number) => fromHalalas(n);
    const money6 = (r: any) => ({
      ...r, costOpen: f(r.costOpen), additions: f(r.additions), disposals: f(r.disposals), costClose: f(r.costClose), accOpen: f(r.accOpen),
      depreciation: f(r.depreciation), accRemoved: f(r.accRemoved), accClose: f(r.accClose), nbvOpen: f(r.nbvOpen), nbvClose: f(r.nbvClose),
    });
    return {
      report: "asset-schedule", lang, generatedAt: riyadhNow(), params: { from, to, category: q?.category ?? null, propertyId: pid ?? null },
      rows: rows.map(money6), totals: money6(T),
    };
  }

  // ── The daily job (DepreciationJobService) ──

  /** Accounts whose ledger started and that have assets. */
  async jobAccounts(): Promise<number[]> {
    const r = await this.pool.query(
      `select s.account_user_id as id from finance_settings s
        where s.finance_v2_enabled and s.ledger_started_at is not null
          and exists (select 1 from fixed_assets a where a.user_id = s.account_user_id and a.status <> 'void')
        order by 1`);
    return r.rows.map((x: any) => Number(x.id));
  }

  // ── internals ──

  /** Emit the asset's missing events through `through` in the caller's transaction; returns the new ones. */
  private async sync(c: Fv2Client, scope: number, id: number, today: string, through?: string): Promise<{ queued: LedgerEvent[] }> {
    const r = await assetEvents(sqlOf(c as any), scope, id, today, through);
    const queued: LedgerEvent[] = [];
    for (const e of r?.events ?? []) {
      if (await this.emitter.emit({ fv2: true, userId: scope, tx: c as any }, e)) queued.push(e);
    }
    return { queued };
  }

  private async missing(q: Q, scope: number, events: LedgerEvent[]): Promise<LedgerEvent[]> {
    if (!events.length) return [];
    const r = await q.query(
      `select event from ledger_outbox where user_id = $1 and source_type = $2 and source_id = $3 and event = any($4::text[])`,
      [scope, ASSET_SOURCE, events[0].sourceId, events.map((e) => e.event)]);
    const have = new Set(r.rows.map((x: any) => x.event));
    return events.filter((e) => !have.has(e.event));
  }

  private async closedPeriods(scope: number, dates: string[]): Promise<Set<string>> {
    const uniq = [...new Set(dates)];
    if (!uniq.length) return new Set();
    const r = await this.pool.query(
      `select d from unnest($2::date[]) as d
        where exists (select 1 from fiscal_periods p where p.user_id = $1 and d between p.starts_on and p.ends_on and p.status <> 'open')`,
      [scope, uniq]);
    return new Set(r.rows.map((x: any) => (x.d instanceof Date ? x.d.toISOString().slice(0, 10) : String(x.d).slice(0, 10))));
  }

  private assertRunnable(month: string, today: string) {
    if (month > monthOf(today)) throw bad("FUTURE_MONTH", "لا يمكن تشغيل الإهلاك لشهر مستقبلي · Depreciation cannot run for a future month");
  }

  private async decorate(q: Q, scope: number, rows: AssetRow[], lang: "ar" | "en"): Promise<AssetOut[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const led = new Map<number, number>();
    const r = await q.query(
      `select e.source_id::int as id, coalesce(sum(l.credit - l.debit) filter (where l.account_id = a.accum_account_id), 0)::text as acc
         from journal_entries e join journal_lines l on l.entry_id = e.id and l.user_id = e.user_id
         join fixed_assets a on a.id = e.source_id and a.user_id = e.user_id
        where e.user_id = $1 and e.source_type = $2 and e.source_id = any($3::bigint[]) group by e.source_id`,
      [scope, ASSET_SOURCE, ids]);
    for (const x of r.rows) led.set(Number(x.id), toHalalas(x.acc));
    const ob = new Map<number, any>();
    const o = await q.query(
      `select source_id::int as id, count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'failed')::int as failed,
              count(*)::int as n, max(substring(event from 5)) filter (where event ~ '^dep:' and status = 'posted') as last
         from ledger_outbox where user_id = $1 and source_type = $2 and source_id = any($3::bigint[]) group by source_id`,
      [scope, ASSET_SOURCE, ids]);
    for (const x of o.rows) ob.set(Number(x.id), x);
    const pids = [...new Set(rows.map((x) => x.propertyId).filter((x): x is number => x != null))];
    const names = new Map<number, string>();
    if (pids.length) {
      for (const p of (await q.query(`select id, name from properties where user_id = $1 and id = any($2::int[])`, [scope, pids])).rows) names.set(Number(p.id), p.name);
    }
    return rows.map((a) => {
      const s = scheduleInput(a);
      const cost = toHalalas(a.cost);
      const acc = a.status === "active" ? s.opening + (led.get(a.id) ?? 0) : 0;
      const full = s.lifeMonths > 0 ? Math.round(depreciableBase(s) / s.lifeMonths) : 0;
      const x = ob.get(a.id);
      return {
        ...a, name: lang === "en" ? a.nameEn || a.nameAr : a.nameAr, propertyName: a.propertyId ? names.get(a.propertyId) ?? null : null,
        accumulated: fromHalalas(acc), nbv: fromHalalas(a.status === "active" ? cost - acc : 0), monthlyCharge: fromHalalas(full),
        fullyDepreciatedIn: lastChargeMonth(s), lastPostedMonth: x?.last ?? null, pending: x?.pending ?? 0, failed: x?.failed ?? 0, posted: (x?.n ?? 0) > 0,
      };
    });
  }

  private async load(q: Q, scope: number, id: number): Promise<AssetRow> {
    const r = await q.query(`select ${ASSET_COLS} from fixed_assets where id = $1 and user_id = $2`, [id, scope]);
    if (!r.rows[0]) throw new NotFoundException({ error: "ASSET_NOT_FOUND", message: "Asset not found" });
    return r.rows[0];
  }

  private async lock(c: Fv2Client, scope: number, id: number): Promise<AssetRow> {
    const r = await c.query(`select ${ASSET_COLS} from fixed_assets where id = $1 and user_id = $2 for update`, [id, scope]);
    if (!r.rows[0]) throw new NotFoundException({ error: "ASSET_NOT_FOUND", message: "Asset not found" });
    return r.rows[0];
  }

  private async hasEvents(q: Q, scope: number, id: number): Promise<boolean> {
    const r = await q.query(`select 1 from ledger_outbox where user_id = $1 and source_type = $2 and source_id = $3 limit 1`, [scope, ASSET_SOURCE, id]);
    return (r.rowCount ?? 0) > 0;
  }

  private async codeIds(q: Q, scope: number): Promise<Map<string, number>> {
    const codes = [...new Set([...Object.values(CATEGORY_DEFAULTS).flatMap((d) => [d.asset, d.accum, d.expense]), DISPOSAL_ACCOUNTS.gain, DISPOSAL_ACCOUNTS.loss])]
      .filter((x): x is string => !!x);
    const r = await q.query(`select code, id from accounts where user_id = $1 and code = any($2::text[]) and not is_group and is_active`, [scope, codes]);
    return new Map(r.rows.map((x: any) => [x.code, Number(x.id)]));
  }

  /** An active leaf of the right kind: cost (asset, debit, not a bank/cash account), contra (asset, credit) or expense. */
  private async assertAccount(q: Q, scope: number, id: number, kind: "asset" | "accum" | "expense", field: string): Promise<void> {
    const g = (await q.query(`select type, normal_balance, is_group, is_active, bank_account_id from accounts where id = $1 and user_id = $2`, [id, scope])).rows[0];
    if (!g) throw new NotFoundException({ error: "ACCOUNT_NOT_FOUND", message: `${field}: account not found` });
    const ok = !g.is_group && g.is_active && (
      kind === "asset" ? g.type === "asset" && g.normal_balance === "debit" && g.bank_account_id == null
        : kind === "accum" ? g.type === "asset" && g.normal_balance === "credit"
          : g.type === "expense");
    if (!ok) {
      const what = kind === "asset" ? "an active asset leaf (not a bank or cash account)" : kind === "accum" ? "an active contra-asset leaf (accumulated depreciation)" : "an active expense leaf";
      throw bad("BAD_ACCOUNT", `${field} must be ${what}`);
    }
  }

  private async normalise(c: Q, scope: number, body: any, cur: AssetRow | null) {
    const nameAr = optStr(body?.nameAr, "nameAr", 200);
    if (!nameAr) throw bad("BAD_INPUT", "اسم الأصل مطلوب · nameAr is required");
    const category = String(body?.category ?? "") as AssetCategory;
    if (!(ASSET_CATEGORIES as readonly string[]).includes(category)) throw bad("BAD_CATEGORY", `category must be one of ${ASSET_CATEGORIES.join(", ")}`);
    const def = CATEGORY_DEFAULTS[category];
    const propertyId = optId(body?.propertyId, "propertyId");
    if (propertyId) {
      const p = await c.query(`select 1 from properties where id = $1 and user_id = $2`, [propertyId, scope]);
      if (!p.rowCount) throw new NotFoundException({ error: "PROPERTY_NOT_FOUND", message: "propertyId not found" });
    }
    const acquisitionDate = isoDate(body?.acquisitionDate, "acquisitionDate");
    const cost = money(body?.cost, "cost", { positive: true });
    const salvage = money(body?.salvageValue, "salvageValue", { dflt: 0 });
    const opening = money(body?.openingAccumulated, "openingAccumulated", { dflt: 0 });
    if (salvage + opening > cost) throw bad("BAD_AMOUNT", "القيمة التخريدية + الإهلاك المتراكم الافتتاحي أكبر من التكلفة · salvage + opening accumulated exceed the cost");
    const lifeRaw = body?.usefulLifeMonths === undefined || body?.usefulLifeMonths === null || body?.usefulLifeMonths === "" ? def.lifeMonths : Number(asciiDigits(String(body.usefulLifeMonths)));
    if (!Number.isInteger(lifeRaw) || lifeRaw < 0 || lifeRaw > 1200) throw bad("BAD_LIFE", "usefulLifeMonths must be 0 to 1200");
    if (category === "land" && lifeRaw !== 0) throw bad("BAD_LIFE", "الأراضي لا تُهلك · Land is not depreciated (usefulLifeMonths must be 0)");
    if (category !== "land" && lifeRaw === 0 && cost - salvage - opening > 0) throw bad("BAD_LIFE", "usefulLifeMonths is required for a depreciable asset");
    const life = lifeRaw;
    const depreciationStart = body?.depreciationStart ? isoDate(body.depreciationStart, "depreciationStart") : acquisitionDate;
    if (depreciationStart < acquisitionDate) throw bad("BAD_DATE", "depreciationStart cannot be before acquisitionDate");
    const acquisitionMode = body?.acquisitionMode === "bank" ? "bank" : body?.acquisitionMode == null || body.acquisitionMode === "none" ? "none" : null;
    if (!acquisitionMode) throw bad("BAD_INPUT", "acquisitionMode must be none or bank");
    const acquisitionBankAccountId = acquisitionMode === "bank" ? await this.banks.assertUsable(c, scope, body?.acquisitionBankAccountId, "acquisitionBankAccountId") : null;

    const s = await loadSettings(sqlOf(c as any), scope);
    if (s?.goLive) {
      if (acquisitionMode === "bank" && acquisitionDate < s.goLive) {
        throw bad("BEFORE_GO_LIVE", `شراء قبل تاريخ بدء الدفتر (${s.goLive}): سجّله في الأرصدة الافتتاحية واختر «مسجل مسبقاً» · An acquisition before the ledger go-live (${s.goLive}) belongs in the opening balances; choose acquisitionMode none`);
      }
      if (life > 0 && depreciationStart < s.goLive) {
        throw bad("BEFORE_GO_LIVE", `يبدأ الإهلاك قبل تاريخ بدء الدفتر (${s.goLive}): أدخل الإهلاك المتراكم حتى ذلك التاريخ كرصيد افتتاحي وابدأ الإهلاك منه · Depreciation would start before the ledger go-live (${s.goLive}); enter the accumulated depreciation to that date as openingAccumulated and start from it`);
      }
    }

    const ids = await this.codeIds(c, scope);
    const pick = (v: unknown, code: string | null, field: string) => optId(v, field) ?? (code ? ids.get(code) ?? null : null);
    const assetAccountId = pick(body?.assetAccountId, def.asset, "assetAccountId");
    if (!assetAccountId) throw bad("MISSING_ACCOUNT", `no cost account for ${category} (${def.asset}); choose assetAccountId`);
    await this.assertAccount(c, scope, assetAccountId, "asset", "assetAccountId");
    let accumAccountId: number | null = null;
    let expenseAccountId: number | null = null;
    if (life > 0) {
      accumAccountId = pick(body?.accumAccountId, def.accum ?? "1229", "accumAccountId");
      expenseAccountId = pick(body?.expenseAccountId, def.expense ?? "5320", "expenseAccountId");
      if (!accumAccountId || !expenseAccountId) throw bad("MISSING_ACCOUNT", "choose the accumulated depreciation and depreciation expense accounts");
      await this.assertAccount(c, scope, accumAccountId, "accum", "accumAccountId");
      await this.assertAccount(c, scope, expenseAccountId, "expense", "expenseAccountId");
    }
    void cur;
    return {
      nameAr, nameEn: optStr(body?.nameEn, "nameEn", 200), category, propertyId, acquisitionDate, cost, salvage, opening, life,
      depreciationStart, acquisitionMode, acquisitionBankAccountId, assetAccountId, accumAccountId, expenseAccountId,
      notes: optStr(body?.notes, "notes", 2000),
    };
  }
}

/** API field name → key of the normalised object. */
function fieldKey(k: (typeof FINANCIAL)[number]): string {
  return ({ salvageValue: "salvage", usefulLifeMonths: "life", openingAccumulated: "opening" } as Record<string, string>)[k] ?? k;
}
