import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { FV2_POOL, type Fv2Pool } from "../db";
import { isoDate } from "../audit";
import { fromHalalas, toHalalas } from "../money";
import { riyadhToday } from "../dates";
import { riyadhNow } from "../reports/core-math";
import { langOf } from "../reports/common";
import { journalCsv, PRESETS, type DateFormat, type ExportLine, type Preset } from "./journal-csv";

/** A bigger export is refused (400 EXPORT_TOO_LARGE): narrow the range instead. */
export const EXPORT_MAX_LINES = 200_000;
/** `format=json` returns this many lines (a preview) with the full-range totals. */
export const PREVIEW_LINES = 200;

export interface ExportParams {
  from: string;
  to: string;
  preset: Preset;
  lang: "ar" | "en";
  dateFormat: DateFormat;
  excludeReversed: boolean;
}

/**
 * Accounting-software export (DESIGN §8.4, docs/finance-v2/JOURNAL-EXPORT.md):
 * the general journal, one CSV row per journal line, for entries whose entry
 * date is in [from, to]. Read-only; scoped to the account.
 */
@Injectable()
export class JournalExportService {
  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool) {}

  params(q: any): ExportParams {
    const today = riyadhToday();
    const to = q?.to ? isoDate(q.to, "to") : today;
    const from = q?.from ? isoDate(q.from, "from") : `${to.slice(0, 7)}-01`;
    if (from > to) throw new BadRequestException({ error: "BAD_RANGE", message: "from must not be after to" });
    const preset = (q?.preset ?? "standard") as Preset;
    if (!(preset in PRESETS)) throw new BadRequestException({ error: "BAD_PRESET", message: `preset must be one of ${Object.keys(PRESETS).join(", ")}` });
    const dateFormat = (q?.dateFormat ?? "iso") as DateFormat;
    if (dateFormat !== "iso" && dateFormat !== "dmy") throw new BadRequestException({ error: "BAD_INPUT", message: "dateFormat must be iso or dmy" });
    const excludeReversed = q?.excludeReversed === "true" || q?.excludeReversed === true || q?.excludeReversed === "1";
    return { from, to, preset, lang: langOf(q?.lang), dateFormat, excludeReversed };
  }

  async lines(scope: number, p: ExportParams, limit?: number): Promise<{ lines: ExportLine[]; count: number; debit: number; credit: number }> {
    const where = `e.user_id = $1 and e.entry_date between $2::date and $3::date${p.excludeReversed ? " and e.status = 'posted' and e.reversal_of is null" : ""}`;
    const [agg] = (await this.pool.query(
      `select count(*)::int as n, coalesce(sum(l.debit), 0)::text as d, coalesce(sum(l.credit), 0)::text as c
         from journal_entries e join journal_lines l on l.entry_id = e.id and l.user_id = e.user_id where ${where}`,
      [scope, p.from, p.to])).rows;
    if (limit == null && agg.n > EXPORT_MAX_LINES) {
      throw new BadRequestException({ error: "EXPORT_TOO_LARGE", count: agg.n, max: EXPORT_MAX_LINES,
        message: `عدد القيود كبير (${agg.n} سطراً)؛ ضيّق الفترة · ${agg.n} lines is more than ${EXPORT_MAX_LINES}; narrow the date range` });
    }
    const rows = (await this.pool.query(
      `select to_char(e.entry_date,'YYYY-MM-DD') as date, e.entry_no, l.line_no, a.code, a.name_ar, coalesce(a.name_en, '') as name_en,
              l.debit::text as debit, l.credit::text as credit, l.memo, e.memo as entry_memo,
              o.name as owner, p.name as property, u.unit_number as unit, t.name as tenant, c.contract_number as contract,
              e.source_type, e.source_id::text as source_id, e.origin, e.status, to_char(e.original_date,'YYYY-MM-DD') as original_date,
              l.vat_category, rtrim(rtrim(l.vat_rate::text, '0'), '.') as vat_rate, l.tax_role,
              case e.source_type
                when 'simple_invoice' then (select si.number from simple_invoices si where si.id = e.source_id and si.user_id = e.user_id)
                when 'payment_collection' then (select pc.receipt_number from payment_collections pc where pc.id = e.source_id and pc.user_id = e.user_id)
                when 'contract' then (select cc.contract_number from contracts cc where cc.id = e.source_id and cc.user_id = e.user_id)
                when 'tenant_credit_action' then (select x.number from tenant_credit_actions x where x.id = e.source_id and x.user_id = e.user_id)
                when 'supplier_bill' then (select x.number from supplier_bills x where x.id = e.source_id and x.user_id = e.user_id)
                when 'supplier_payment' then (select x.number from supplier_payments x where x.id = e.source_id and x.user_id = e.user_id)
                when 'fiscal_year' then 'FY' || e.source_id::text
              end as source_ref
         from journal_entries e
         join journal_lines l on l.entry_id = e.id and l.user_id = e.user_id
         join accounts a on a.id = l.account_id and a.user_id = l.user_id
         left join owners o on o.id = l.owner_id and o.user_id = l.user_id
         left join properties p on p.id = l.property_id and p.user_id = l.user_id
         left join units u on u.id = l.unit_id and exists (select 1 from properties up where up.id = u.property_id and up.user_id = l.user_id)
         left join tenants t on t.id = l.tenant_id and t.user_id = l.user_id
         left join contracts c on c.id = l.contract_id and c.user_id = l.user_id
        where ${where}
        order by e.entry_date, e.entry_no, l.line_no
        ${limit != null ? `limit ${Math.max(0, Math.floor(limit))}` : ""}`,
      [scope, p.from, p.to])).rows;
    const two = (v: string) => fromHalalas(toHalalas(v));
    return {
      count: agg.n, debit: toHalalas(agg.d), credit: toHalalas(agg.c),
      lines: rows.map((r: any): ExportLine => ({
        date: r.date, entryNo: r.entry_no, lineNo: Number(r.line_no), accountCode: r.code, accountNameAr: r.name_ar, accountNameEn: r.name_en,
        debit: two(r.debit), credit: two(r.credit), memo: r.memo ?? null, entryMemo: r.entry_memo ?? null,
        owner: r.owner ?? null, property: r.property ?? null, unit: r.unit ?? null, tenant: r.tenant ?? null, contract: r.contract ?? null,
        sourceType: r.source_type, sourceRef: r.source_ref ?? `${r.source_type}#${r.source_id}`, origin: r.origin, status: r.status,
        originalDate: r.original_date, vatCategory: r.vat_category ?? null, vatRate: r.vat_rate ?? null, taxRole: r.tax_role ?? null,
      })),
    };
  }

  /** The CSV file and its control totals. */
  async csv(scope: number, q: any): Promise<{ body: string; filename: string; rows: number; debit: string; credit: string }> {
    const p = this.params(q);
    const r = await this.lines(scope, p);
    return {
      body: journalCsv(r.lines, { preset: p.preset, lang: p.lang, dateFormat: p.dateFormat }),
      filename: `dara-journal_${p.from}_${p.to}.csv`, rows: r.count, debit: fromHalalas(r.debit), credit: fromHalalas(r.credit),
    };
  }

  /** `format=json`: the first PREVIEW_LINES lines and the totals over the whole range. */
  async preview(scope: number, q: any) {
    const p = this.params(q);
    const r = await this.lines(scope, p, PREVIEW_LINES);
    return {
      report: "journal-export", lang: p.lang, generatedAt: riyadhNow(), params: p, columns: PRESETS[p.preset],
      count: r.count, truncated: r.count > r.lines.length, maxLines: EXPORT_MAX_LINES,
      totals: { debit: fromHalalas(r.debit), credit: fromHalalas(r.credit), balanced: r.debit === r.credit },
      lines: r.lines,
    };
  }
}
