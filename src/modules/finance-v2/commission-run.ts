/**
 * The monthly management-commission run on the COLLECTED basis (DESIGN §9 E1
 * "collected basis", Q11; the accountant's workbook, sheet "قواعد القيود",
 * row فاتورة عمولة, and sheet "كشف الملاك"):
 *
 *   at month end, for each AGENT landlord:
 *     commission = Σ over his properties of
 *                  (rent collected in the month, before VAT) × (the property's rate, else the landlord's)
 *     VAT        = 15% of the commission when the ACCOUNT (the office) is VAT-registered and linked
 *
 * and one tax invoice per landlord, issued by the office to the landlord.
 *
 * "Collected" is read from the LEDGER, not from the source tables, so it is
 * exactly what moved the landlord's money: the landlord-payable (2121) side of
 * every tenant-money entry (a collection E03, a refund E04/E20, a deposit
 * applied to arrears E12B — the entries that move 2122 → 2121) and the part
 * Ejar reported paid (E33, 2122 debited: the rent was collected, by Ejar).
 * Reversals of those entries count with their sign, so a deleted collection
 * lowers the next run. Every counted journal line is recorded
 * (`finance_commission_run_items`), so a line is charged commission once, and
 * a line posted after its month's run (late, or a reversal) falls into the
 * next run instead of being lost. The pre-VAT part of a line follows its
 * installment (`payments.vat_enabled`, as the billed basis does); only RENT
 * installments count (fees, deposits and commission itself are not rent).
 *
 * The cutover (`collected_from`): lines before it are never counted, and a
 * line on an installment already covered by a billed-basis COM document is
 * never counted either, so switching basis cannot charge the same rent twice.
 *
 * No Nest here: the service, the settings PATCH and the admin enable share it.
 */
import type { Sql } from "./hooks/sql";
import { installmentNature } from "./hooks/classify";
import { effectiveFeeForProperty, effectiveRate, pctOf, type FeeSource } from "./commission";
import { accountZatcaIntegrated, ownFeeCarriesVat } from "./account-seller";
import { fromHalalas, toHalalas, vatSplit } from "./money";
import { lastDayOfMonth, parseIsoDate, riyadhToday } from "./dates";
import { reversalEvent } from "./hooks/facts-loader";
import type { LedgerEvent } from "./ledger-emitter.service";

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** "2026-01" → { month: "2026-01", start: "2026-01-01", end: "2026-01-31" }, or null. */
export function monthSpan(v: unknown): { month: string; start: string; end: string } | null {
  const m = typeof v === "string" ? MONTH_RE.exec(v.trim().slice(0, 7)) : null;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const month = `${m[1]}-${m[2]}`;
  return { month, start: `${month}-01`, end: `${month}-${String(lastDayOfMonth(y, mo)).padStart(2, "0")}` };
}

/** The first day of the month holding `date`. */
export const monthStartOf = (date: string): string => `${date.slice(0, 7)}-01`;

/** The month before "YYYY-MM". */
export function previousMonth(month: string): string {
  const { y, m } = parseIsoDate(`${month}-01`);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-01" → { ar: "يناير 2026", en: "January 2026" }. */
export function monthLabel(month: string): { ar: string; en: string } {
  const { y, m } = parseIsoDate(`${month}-01`);
  return { ar: `${AR_MONTHS[m - 1]} ${y}`, en: `${EN_MONTHS[m - 1]} ${y}` };
}

// ─── Settings and the cutover ───────────────────────────────────────────────

type Q = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/**
 * Record the collected-basis cutover: the first day of the current Riyadh
 * month. Called when an account switches to (or is created on) the collected
 * basis, inside the caller's transaction. A no-op when 0070 is missing.
 */
export async function recordCollectedCutover(c: Q, scope: number, actorId: number | null): Promise<void> {
  const t = await c.query(`select to_regclass('finance_commission_settings') is not null as ok`);
  if (t.rows[0]?.ok !== true) return;
  await c.query(
    `insert into finance_commission_settings (account_user_id, collected_from, updated_by) values ($1, $2::date, $3)
     on conflict (account_user_id) do update set collected_from = excluded.collected_from, updated_by = excluded.updated_by, updated_at = now()`,
    [scope, monthStartOf(riyadhToday()), actorId],
  );
}

export interface CommissionSettings {
  enabled: boolean;
  ledgerStarted: boolean;
  mode: "manager" | "owner";
  basis: "billed" | "collected";
  /** Lines before this date are never counted (the cutover). */
  collectedFrom: string;
  autoRun: boolean;
  lastAutoMonth: string | null;
}

export async function commissionSettings(q: Sql, scope: number): Promise<CommissionSettings | null> {
  const [r] = await q.rows(
    `select fs.finance_v2_enabled as enabled, fs.ledger_started_at is not null as started, fs.accounting_mode as mode, fs.commission_basis as basis,
            to_char(coalesce(cs.collected_from, date_trunc('month', (coalesce(fs.enabled_at, now()) at time zone 'Asia/Riyadh'))::date),'YYYY-MM-DD') as from_date,
            coalesce(cs.auto_run, true) as auto_run, to_char(cs.last_auto_month,'YYYY-MM') as last_auto
       from finance_settings fs left join finance_commission_settings cs on cs.account_user_id = fs.account_user_id
      where fs.account_user_id = $1`,
    [scope],
  );
  if (!r) return null;
  return {
    enabled: r.enabled === true,
    ledgerStarted: r.started === true,
    mode: r.mode === "owner" ? "owner" : "manager",
    basis: r.basis === "collected" ? "collected" : "billed",
    collectedFrom: r.from_date,
    autoRun: r.auto_run !== false,
    lastAutoMonth: r.last_auto ?? null,
  };
}

// ─── The collected lines ────────────────────────────────────────────────────

export interface CollectedLine {
  lineId: number;
  entryId: number;
  ownerId: number;
  propertyId: number | null;
  contractId: number | null;
  paymentId: number | null;
  entryDate: string;
  /** Signed halalas: + money collected for the landlord, − refunded / reversed. */
  gross: number;
  /** Whether the installment's amount includes 15% VAT. */
  vatEnabled: boolean;
  nature: "rent" | "fee" | "deposit";
  source: "collection" | "ejar";
}

/**
 * The not-yet-counted collected lines of agent landlords dated
 * [from, to]. `ownerId` narrows to one landlord.
 */
export async function collectedLines(q: Sql, scope: number, from: string, to: string, ownerId: number | null = null): Promise<CollectedLine[]> {
  if (from > to) return [];
  const rows = await q.rows(
    `select l.id::text as line_id, l.entry_id::text as entry_id, l.owner_id, l.property_id, l.contract_id, l.payment_id,
            to_char(l.entry_date,'YYYY-MM-DD') as entry_date, a.system_key,
            (case when a.system_key = 'landlord_payable' then l.credit - l.debit else l.debit - l.credit end)::text as gross,
            p.vat_enabled, p.description,
            (select bool_or(pp.vat_enabled) from payments pp where pp.user_id = l.user_id and pp.contract_id = l.contract_id and pp.deleted_at is null) as contract_vat
       from journal_lines l
       join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
       join accounts a on a.id = l.account_id and a.user_id = l.user_id
       join owners o on o.id = l.owner_id and o.user_id = l.user_id and not coalesce(o.is_account_holder, false)
       left join payments p on p.id = l.payment_id and p.user_id = l.user_id
      where l.user_id = $1 and l.entry_date >= $2::date and l.entry_date <= $3::date
        and ($4::int is null or l.owner_id = $4::int)
        and (
          -- tenant money (E03/E04/E12B/E20 and their reversals): the 2121 side of an entry that also moves 2122
          (a.system_key = 'landlord_payable'
             and exists (select 1 from journal_lines l2 join accounts a2 on a2.id = l2.account_id and a2.user_id = l2.user_id
                          where l2.entry_id = l.entry_id and a2.system_key = 'landlord_payable_uncollected'))
          -- rent Ejar reported paid (E33 full or part, and their reversals)
          or (a.system_key = 'landlord_payable_uncollected' and e.source_type = 'payment'
              and regexp_replace(e.event, '^reversal:', '') in ('settled_external', 'ejar_partial'))
        )
        and not exists (select 1 from finance_commission_run_items i where i.user_id = l.user_id and i.line_id = l.id and i.live)
        -- the cutover: rent that already has a billed-basis COM document is never counted again
        and not (l.payment_id is not null and exists (
          select 1 from simple_invoices com
            join simple_invoices rd on rd.user_id = com.user_id and rd.number = com.billing_reference and rd.type = 'invoice' and rd.deleted_at is null
           where com.user_id = l.user_id and com.kind = 'commission' and com.type = 'invoice' and com.contract_id is not null
             and com.deleted_at is null and com.status::text <> 'cancelled'
             and (rd.payment_id = l.payment_id or coalesce(rd.payment_ids, '[]'::jsonb) @> jsonb_build_array(l.payment_id))))
      order by l.entry_date, l.id`,
    [scope, from, to, ownerId],
  );
  return rows.map((r: any) => {
    const nature = r.payment_id ? installmentNature(r.description) : "rent";
    return {
      lineId: Number(r.line_id), entryId: Number(r.entry_id), ownerId: Number(r.owner_id),
      propertyId: r.property_id == null ? null : Number(r.property_id), contractId: r.contract_id == null ? null : Number(r.contract_id),
      paymentId: r.payment_id == null ? null : Number(r.payment_id), entryDate: r.entry_date, gross: toHalalas(r.gross),
      // A line with no installment (a tenant-credit refund) follows its contract's rent.
      vatEnabled: r.payment_id ? r.vat_enabled === true : r.contract_vat === true,
      nature: nature === "deposit" ? "deposit" : nature === "fee" ? "fee" : "rent",
      source: r.system_key === "landlord_payable" ? "collection" : "ejar",
    };
  });
}

/** The pre-VAT part of a collected line (signed). */
export function lineBase(l: Pick<CollectedLine, "gross" | "vatEnabled">): number {
  return l.vatEnabled ? vatSplit(l.gross).net : l.gross;
}

// ─── The plan (pure) ────────────────────────────────────────────────────────

export interface RateInfo {
  pct: string | null;
  source: FeeSource;
}

export interface PropertyPlan {
  propertyId: number | null;
  propertyName: string | null;
  collected: number;
  base: number;
  pct: string | null;
  source: FeeSource;
  commission: number;
  lineIds: number[];
  /** Why the property's lines wait for a later run: no fee agreed, or nothing (net) collected. */
  deferred: null | "no_rate" | "not_positive";
}

export interface LandlordPlan {
  ownerId: number;
  properties: PropertyPlan[];
  collected: number;
  base: number;
  net: number;
  vat: number;
  total: number;
  /** The lines this landlord's invoice counts (the non-deferred properties). */
  lines: CollectedLine[];
  skip: null | "nothing_collected" | "no_rate" | "not_positive";
}

/** 15% of a commission, half-up to the halala (as the billed basis rounds it). */
export const commissionVat = (net: number): number => Math.floor((net * 15 + 50) / 100);

/**
 * One landlord's commission from his collected lines. Rent lines only; per
 * property: base = Σ pre-VAT; commission = base × rate (half-up). A property
 * whose base is not positive (refunds outweigh collections) or has no rate is
 * deferred: its lines stay uncounted for a later run.
 */
export function planLandlord(ownerId: number, lines: CollectedLine[], rateOf: (propertyId: number | null) => RateInfo,
  vatRegistered: boolean, names: Map<number, string> = new Map()): LandlordPlan {
  const rent = lines.filter((l) => l.ownerId === ownerId && l.nature === "rent");
  const byProp = new Map<number | null, CollectedLine[]>();
  for (const l of rent) byProp.set(l.propertyId, [...(byProp.get(l.propertyId) ?? []), l]);
  const properties: PropertyPlan[] = [];
  for (const [propertyId, ls] of [...byProp.entries()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))) {
    const collected = ls.reduce((s, l) => s + l.gross, 0);
    const base = ls.reduce((s, l) => s + lineBase(l), 0);
    const rate = rateOf(propertyId);
    const hasRate = rate.pct != null && toHalalas(rate.pct) > 0;
    const deferred = base <= 0 ? "not_positive" : !hasRate ? "no_rate" : null;
    const commission = deferred ? 0 : pctOf(base, rate.pct!);
    properties.push({
      propertyId, propertyName: propertyId != null ? names.get(propertyId) ?? null : null,
      collected, base, pct: rate.pct, source: rate.source, commission, lineIds: ls.map((l) => l.lineId),
      deferred: deferred ?? (commission > 0 ? null : "not_positive"),
    });
  }
  const counted = properties.filter((p) => !p.deferred);
  const net = counted.reduce((s, p) => s + p.commission, 0);
  const vat = vatRegistered && net > 0 ? commissionVat(net) : 0;
  const countedIds = new Set(counted.flatMap((p) => p.lineIds));
  const skip = !rent.length ? "nothing_collected"
    : net > 0 ? null
    : properties.every((p) => p.deferred === "no_rate") ? "no_rate" : "not_positive";
  return {
    ownerId, properties,
    collected: rent.reduce((s, l) => s + l.gross, 0),
    base: rent.reduce((s, l) => s + lineBase(l), 0),
    net, vat, total: net + vat,
    lines: skip ? [] : rent.filter((l) => countedIds.has(l.lineId)),
    skip,
  };
}

// ─── Preview (DB) ───────────────────────────────────────────────────────────

export interface LandlordInfo {
  id: number;
  name: string;
  taxNumber: string | null;
  idNumber: string | null;
  type: string | null;
  email: string | null;
  phone: string | null;
  landlordPct: string | null;
  /** What the ZATCA invoice would be: standard (the landlord is VAT-registered, B2B, cleared) or simplified (reported). */
  profile: "standard" | "simplified";
  /** A standard invoice needs the landlord's national address. */
  addressComplete: boolean;
}

export async function landlordInfo(q: Sql, scope: number, ids: number[]): Promise<Map<number, LandlordInfo>> {
  if (!ids.length) return new Map();
  const rows = await q.rows(
    `select id, name, nullif(trim(coalesce(tax_number,'')),'') as tax, id_number, type, email, phone, management_fee_percent::text as pct,
            (nullif(trim(coalesce(national_address_street,'')),'') is not null and nullif(trim(coalesce(building_number,'')),'') is not null
             and nullif(trim(coalesce(national_address_city,'')),'') is not null and nullif(trim(coalesce(national_address_district,'')),'') is not null
             and nullif(trim(coalesce(postal_code,'')),'') is not null) as addr
       from owners where user_id = $1 and id = any($2::int[])`,
    [scope, ids],
  );
  return new Map(rows.map((r: any) => [Number(r.id), {
    id: Number(r.id), name: r.name ?? "", taxNumber: r.tax ?? null, idNumber: r.id_number ?? null, type: r.type ?? null,
    email: r.email ?? null, phone: r.phone ?? null, landlordPct: r.pct ?? null,
    profile: r.tax ? "standard" : "simplified", addressComplete: r.addr === true,
  } as LandlordInfo]));
}

/** Rates for a set of properties (property rate, else landlord), and the landlord's own for lines with no property. */
export async function rateResolver(q: Sql, scope: number, lines: CollectedLine[], landlords: Map<number, LandlordInfo>) {
  const cache = new Map<number, RateInfo>();
  const names = new Map<number, string>();
  const props = [...new Set(lines.map((l) => l.propertyId).filter((x): x is number => x != null))];
  for (const p of props) {
    const f = await effectiveFeeForProperty(q, scope, p);
    cache.set(p, { pct: f?.pct ?? null, source: f?.source ?? null });
  }
  if (props.length) {
    for (const r of await q.rows(`select id, name from properties where user_id = $1 and id = any($2::int[])`, [scope, props])) names.set(Number(r.id), r.name);
  }
  const rateFor = (ownerId: number) => (propertyId: number | null): RateInfo =>
    propertyId != null && cache.has(propertyId) ? cache.get(propertyId)! : effectiveRate(null, landlords.get(ownerId)?.landlordPct ?? null);
  return { rateFor, names };
}

export interface MonthPreview {
  month: string;
  label: { ar: string; en: string };
  from: string;
  to: string;
  basis: "billed" | "collected";
  collectedFrom: string;
  /** Why the month cannot be run (null = it can). */
  blocked: null | "NOT_ENABLED" | "LEDGER_NOT_STARTED" | "NOT_MANAGER_MODE" | "BASIS_BILLED" | "MONTH_NOT_ENDED" | "BEFORE_CUTOVER";
  office: { vatRegistered: boolean; zatcaLinked: boolean };
  landlords: Array<{
    ownerId: number;
    name: string;
    taxNumber: string | null;
    profile: "standard" | "simplified";
    addressComplete: boolean;
    collected: string;
    base: string;
    net: string;
    vat: string;
    total: string;
    properties: Array<{ propertyId: number | null; propertyName: string | null; collected: string; base: string; pct: string | null; source: FeeSource; commission: string; deferred: string | null }>;
    skip: string | null;
    existingRunId: number | null;
  }>;
  totals: { collected: string; base: string; net: string; vat: string; total: string };
}

/**
 * The preview of month M: what a run would issue now, per agent landlord.
 * Lines dated from the cutover to M's last day that no live run counted.
 */
export async function previewMonth(q: Sql, scope: number, month: string, today = riyadhToday()): Promise<MonthPreview> {
  const span = monthSpan(month);
  if (!span) throw new Error("fv2: bad month");
  const s = await commissionSettings(q, scope);
  const from = s ? (s.collectedFrom > span.start ? s.collectedFrom : span.start) : span.start;
  const blocked: MonthPreview["blocked"] = !s || !s.enabled ? "NOT_ENABLED"
    : !s.ledgerStarted ? "LEDGER_NOT_STARTED"
    : s.mode !== "manager" ? "NOT_MANAGER_MODE"
    : s.basis !== "collected" ? "BASIS_BILLED"
    : span.end > today ? "MONTH_NOT_ENDED"
    : span.end < s.collectedFrom ? "BEFORE_CUTOVER"
    : null;
  const vatRegistered = await ownFeeCarriesVat(q, scope);
  const zatcaLinked = await accountZatcaIntegrated(q, scope);
  // Carried-over lines (earlier months, posted late or not yet counted) belong to this run too.
  const lines = s ? await collectedLines(q, scope, s.collectedFrom, span.end) : [];
  const owners = [...new Set(lines.map((l) => l.ownerId))].sort((a, b) => a - b);
  const existing = await q.rows(
    `select id, owner_id from finance_commission_runs where user_id = $1 and month = $2::date and status = 'issued'`, [scope, span.start]);
  const existingBy = new Map<number, number>(existing.map((r: any) => [Number(r.owner_id), Number(r.id)]));
  for (const o of existingBy.keys()) if (!owners.includes(o)) owners.push(o);
  const info = await landlordInfo(q, scope, owners);
  const { rateFor, names } = await rateResolver(q, scope, lines, info);
  const landlords: MonthPreview["landlords"] = [];
  const tot = { collected: 0, base: 0, net: 0, vat: 0, total: 0 };
  for (const o of owners) {
    const p = planLandlord(o, lines, rateFor(o), vatRegistered, names);
    const li = info.get(o);
    const existingRunId = existingBy.get(o) ?? null;
    if (!existingRunId && !p.skip) {
      tot.collected += p.collected; tot.base += p.base; tot.net += p.net; tot.vat += p.vat; tot.total += p.total;
    }
    landlords.push({
      ownerId: o, name: li?.name ?? "", taxNumber: li?.taxNumber ?? null, profile: li?.profile ?? "simplified", addressComplete: li?.addressComplete ?? false,
      collected: fromHalalas(p.collected), base: fromHalalas(p.base), net: fromHalalas(p.net), vat: fromHalalas(p.vat), total: fromHalalas(p.total),
      properties: p.properties.map((x) => ({
        propertyId: x.propertyId, propertyName: x.propertyName, collected: fromHalalas(x.collected), base: fromHalalas(x.base),
        pct: x.pct, source: x.source, commission: fromHalalas(x.commission), deferred: x.deferred,
      })),
      skip: existingRunId ? "already_issued" : p.skip,
      existingRunId,
    });
  }
  return {
    month: span.month, label: monthLabel(span.month), from, to: span.end, basis: s?.basis ?? "billed", collectedFrom: s?.collectedFrom ?? span.start,
    blocked, office: { vatRegistered, zatcaLinked }, landlords,
    totals: { collected: fromHalalas(tot.collected), base: fromHalalas(tot.base), net: fromHalalas(tot.net), vat: fromHalalas(tot.vat), total: fromHalalas(tot.total) },
  };
}

// ─── The commission still in the trust account (for تحويل عمولات) ──────────

/**
 * Commission booked out of the landlords' money (E15 less E36 and less
 * commission a landlord paid in cash, E16: the landlord-payable side, from
 * `from`), less every posted commission transfer: what may still move from
 * the trust account to the operating account.
 */
export async function unsentCommission(q: Sql, scope: number): Promise<{ booked: number; transferred: number; unsent: number }> {
  const [b] = await q.rows(
    `select coalesce(sum(l.debit - l.credit), 0)::text as v
       from journal_lines l join journal_entries e on e.id = l.entry_id and e.user_id = l.user_id
       join accounts a on a.id = l.account_id and a.user_id = l.user_id
      where l.user_id = $1 and a.system_key = 'landlord_payable'
        and ((e.source_type = 'simple_invoice' and exists (select 1 from simple_invoices si where si.id = e.source_id and si.user_id = e.user_id and si.kind = 'commission'))
          or (e.source_type = 'payment_collection' and exists (select 1 from payment_collections pc join simple_invoices si on si.id = pc.invoice_id and si.user_id = pc.user_id
                                                                where pc.id = e.source_id and pc.user_id = e.user_id and si.kind = 'commission')))`,
    [scope],
  );
  const [t] = await q.rows(`select coalesce(sum(amount), 0)::text as v from finance_commission_transfers where user_id = $1 and status = 'posted'`, [scope]);
  const booked = toHalalas(b?.v ?? "0");
  const transferred = toHalalas(t?.v ?? "0");
  return { booked, transferred, unsent: Math.max(0, booked - transferred) };
}

/** The ledger events of a commission transfer: E15T `posted`, and its reversal once void (live posting and the backfill share this). */
export async function transferEvents(q: Sql, scope: number, id: number): Promise<LedgerEvent[]> {
  const [t] = await q.rows(
    `select id, number, to_char(transfer_date,'YYYY-MM-DD') as date, amount::text as amount, from_bank_account_id, to_bank_account_id, memo, status,
            to_char(coalesce(voided_at, now()) at time zone 'Asia/Riyadh','YYYY-MM-DD') as void_date
       from finance_commission_transfers where id = $1 and user_id = $2`,
    [id, scope],
  );
  if (!t) return [];
  const facts = {
    date: t.date, amount: t.amount, fromBankAccountId: Number(t.from_bank_account_id), toBankAccountId: Number(t.to_bank_account_id),
    memo: t.memo ? `${t.number} · ${t.memo}` : `${t.number} · تحويل عمولات · Commission transfer`,
  };
  const out: LedgerEvent[] = [{ sourceType: "commission_transfer", sourceId: Number(t.id), event: "posted", occurredOn: t.date, payload: { rule: "E15T", facts } }];
  if (t.status === "void") out.push(reversalEvent("commission_transfer", Number(t.id), "posted", t.void_date < t.date ? t.date : t.void_date, { reason: "void" }));
  return out;
}
