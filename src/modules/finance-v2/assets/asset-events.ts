/**
 * Ledger events of one fixed asset (DESIGN §8.5). One builder, used by the
 * live paths (register, dispose, void), the depreciation job, the manual
 * "run for month" and the backfill/catch-up extraction, so all of them key
 * and freeze the events identically.
 *
 * Keys (source_type `fixed_asset`, source_id = the asset id):
 *   `acquired`      FA01, on the acquisition date (acquisition_mode 'bank' only)
 *   `dep:YYYY-MM`   FA02, on the month end — one per asset and month (the
 *                   idempotency of the monthly run)
 *   `disposed`      FA03, on the disposal date
 *   `reversal:<e>`  a void reverses every event of the asset; a disposal
 *                   reverses the depreciation of its own month and any later
 *                   month already queued (the disposal books that month up to
 *                   the date itself).
 */
import type { LedgerEvent } from "../ledger-emitter.service";
import type { Sql } from "../hooks/sql";
import { reversalEvent } from "../hooks/facts-loader";
import { fromHalalas, toHalalas } from "../money";
import type { AssetAcquiredFacts, AssetDepreciationFacts, AssetDisposalFacts } from "../rules/assets";
import { addMonths, disposalFigures, monthCharge, monthEnd, monthOf, lastChargeMonth, type ScheduleInput } from "./asset-math";

export const ASSET_SOURCE = "fixed_asset";

export interface AssetRow {
  id: number;
  number: string;
  nameAr: string;
  nameEn: string | null;
  category: string;
  propertyId: number | null;
  acquisitionDate: string;
  cost: string;
  salvageValue: string;
  usefulLifeMonths: number;
  depreciationStart: string;
  openingAccumulated: string;
  assetAccountId: number;
  accumAccountId: number | null;
  expenseAccountId: number | null;
  acquisitionMode: "none" | "bank";
  acquisitionBankAccountId: number | null;
  status: "active" | "disposed" | "void";
  disposedOn: string | null;
  disposalProceeds: string | null;
  disposalBankAccountId: number | null;
  disposalNote: string | null;
  voidedOn: string | null;
  voidReason: string | null;
  notes: string | null;
  createdAt: string;
}

const COL_LIST: ReadonlyArray<[string, string]> = [
  ["id", "id"], ["number", "number"], ["name_ar", "nameAr"], ["name_en", "nameEn"], ["category", "category"], ["property_id", "propertyId"],
  ["to_char(#acquisition_date,'YYYY-MM-DD')", "acquisitionDate"], ["#cost::text", "cost"], ["#salvage_value::text", "salvageValue"],
  ["useful_life_months", "usefulLifeMonths"], ["to_char(#depreciation_start,'YYYY-MM-DD')", "depreciationStart"],
  ["#opening_accumulated::text", "openingAccumulated"], ["asset_account_id", "assetAccountId"], ["accum_account_id", "accumAccountId"],
  ["expense_account_id", "expenseAccountId"], ["acquisition_mode", "acquisitionMode"], ["acquisition_bank_account_id", "acquisitionBankAccountId"],
  ["status", "status"], ["to_char(#disposed_on,'YYYY-MM-DD')", "disposedOn"], ["#disposal_proceeds::text", "disposalProceeds"],
  ["disposal_bank_account_id", "disposalBankAccountId"], ["disposal_note", "disposalNote"], ["to_char(#voided_on,'YYYY-MM-DD')", "voidedOn"],
  ["void_reason", "voidReason"], ["notes", "notes"], ["#created_at::text", "createdAt"],
];

/** The register's columns in API naming; `alias` qualifies them (e.g. "a"). */
export function assetCols(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  return COL_LIST.map(([expr, as]) => `${expr.includes("#") ? expr.replace("#", p) : p + expr} as "${as}"`).join(", ");
}

export const ASSET_COLS = assetCols();

export function scheduleInput(a: Pick<AssetRow, "cost" | "salvageValue" | "openingAccumulated" | "usefulLifeMonths" | "depreciationStart">): ScheduleInput {
  return {
    cost: toHalalas(a.cost), salvage: toHalalas(a.salvageValue), opening: toHalalas(a.openingAccumulated),
    lifeMonths: Number(a.usefulLifeMonths), start: a.depreciationStart,
  };
}

/** The last month whose depreciation is due on `today`: the month before today's (its end has passed). */
export const lastDueMonth = (today: string) => addMonths(monthOf(today), -1);

const label = (a: AssetRow) => `${a.number} ${a.nameAr}`;
const labelEn = (a: AssetRow) => `${a.number} ${a.nameEn || a.nameAr}`;

/**
 * The asset's events up to and including month `through` (YYYY-MM; default:
 * the last month whose end is before `today`). Existing outbox rows of the
 * asset decide which reversals are needed (a void, or depreciation already
 * queued for the disposal month or later).
 */
export async function assetEvents(
  q: Sql, userId: number, assetId: number, today: string, through: string = lastDueMonth(today),
): Promise<{ events: LedgerEvent[]; createdAt: string; asset: AssetRow } | null> {
  const [a] = await q.rows<AssetRow>(`select ${ASSET_COLS} from fixed_assets where id = $1 and user_id = $2`, [assetId, userId]);
  if (!a) return null;
  const queued = await q.rows<{ event: string; occurred_on: string }>(
    `select event, to_char(occurred_on,'YYYY-MM-DD') as occurred_on from ledger_outbox where user_id = $1 and source_type = $2 and source_id = $3`,
    [userId, ASSET_SOURCE, assetId],
  );
  const has = new Set(queued.map((r) => r.event));
  const reverseIfQueued = (event: string, occurredOn: string, date: string, reason: string, out: LedgerEvent[]) => {
    if (has.has(event) && !has.has(`reversal:${event}`)) {
      out.push(reversalEvent(ASSET_SOURCE, a.id, event, date > occurredOn ? date : occurredOn, { reason }));
    }
  };

  const events: LedgerEvent[] = [];
  if (a.status === "void") {
    const date = a.voidedOn ?? today;
    for (const r of queued) if (!r.event.startsWith("reversal:")) reverseIfQueued(r.event, r.occurred_on, date, "asset_voided", events);
    return { events, createdAt: a.createdAt, asset: a };
  }

  const dims = { propertyId: a.propertyId ?? null };
  if (a.acquisitionMode === "bank") {
    const facts: AssetAcquiredFacts = {
      date: a.acquisitionDate, assetId: a.id, amount: fromHalalas(toHalalas(a.cost)), assetAccountId: Number(a.assetAccountId),
      bank: { bankAccountId: a.acquisitionBankAccountId ?? null }, dims,
      memo: `شراء أصل ${label(a)} · Asset acquired ${labelEn(a)}`.slice(0, 500),
    };
    events.push({ sourceType: ASSET_SOURCE, sourceId: a.id, event: "acquired", occurredOn: a.acquisitionDate, payload: { rule: "FA01", facts } as any });
  }

  const sched = scheduleInput(a);
  const last = lastChargeMonth(sched);
  if (last && a.accumAccountId && a.expenseAccountId) {
    let end = through < last ? through : last;
    if (a.status === "disposed" && a.disposedOn) {
      const before = addMonths(monthOf(a.disposedOn), -1);
      if (before < end) end = before;
    }
    for (let ym = monthOf(a.depreciationStart); ym <= end; ym = addMonths(ym, 1)) {
      const x = monthCharge(sched, ym);
      if (x <= 0) continue;
      const facts: AssetDepreciationFacts = {
        date: monthEnd(ym), assetId: a.id, month: ym, amount: fromHalalas(x),
        expenseAccountId: Number(a.expenseAccountId), accumAccountId: Number(a.accumAccountId), dims,
        memo: `إهلاك ${label(a)} لشهر ${ym} · Depreciation ${labelEn(a)} ${ym}`.slice(0, 500),
      };
      events.push({ sourceType: ASSET_SOURCE, sourceId: a.id, event: `dep:${ym}`, occurredOn: monthEnd(ym), payload: { rule: "FA02", facts } as any });
    }
  }

  if (a.status === "disposed" && a.disposedOn) {
    const dm = monthOf(a.disposedOn);
    for (const r of queued) {
      const m = /^dep:(\d{4}-\d{2})$/.exec(r.event);
      if (m && m[1] >= dm) reverseIfQueued(r.event, r.occurred_on, a.disposedOn, "asset_disposed", events);
    }
    const proceeds = toHalalas(a.disposalProceeds ?? "0");
    const f = disposalFigures(sched, a.disposedOn, proceeds);
    const facts: AssetDisposalFacts = {
      date: a.disposedOn, assetId: a.id, cost: fromHalalas(sched.cost), partial: fromHalalas(f.partial),
      accumulated: fromHalalas(f.accumulated), proceeds: fromHalalas(proceeds),
      assetAccountId: Number(a.assetAccountId), accumAccountId: a.accumAccountId ?? null, expenseAccountId: a.expenseAccountId ?? null,
      gainAccountId: 0, lossAccountId: 0, bank: { bankAccountId: a.disposalBankAccountId ?? null }, dims,
      memo: `استبعاد أصل ${label(a)} · Asset disposed ${labelEn(a)}`.slice(0, 500),
    };
    const [g] = await q.rows(
      `select (select id from accounts where user_id = $1 and code = '4420') as gain, (select id from accounts where user_id = $1 and code = '5350') as loss`,
      [userId],
    );
    facts.gainAccountId = Number(g?.gain ?? 0);
    facts.lossAccountId = Number(g?.loss ?? 0);
    events.push({ sourceType: ASSET_SOURCE, sourceId: a.id, event: "disposed", occurredOn: a.disposedOn, payload: { rule: "FA03", facts } as any });
  }
  return { events, createdAt: a.createdAt, asset: a };
}
