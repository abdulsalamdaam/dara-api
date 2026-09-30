# Finance v2: journal CSV export format

Status: built (tier 3, DESIGN §8.4). The code is `src/modules/finance-v2/tier3/journal-csv.ts` (the format) and `journal-export.service.ts` (the query). This file is the contract for anyone importing the file into other accounting software. A change to it is a versioned change: add columns only at the end of a preset, and never rename or reorder existing ones.

## 1. Endpoint

```
GET /api/finance/v2/journal-export
```

| Parameter | Values | Default | Meaning |
|---|---|---|---|
| `from` | `YYYY-MM-DD` | first day of `to`'s month | First entry date included |
| `to` | `YYYY-MM-DD` | today (Asia/Riyadh) | Last entry date included |
| `preset` | `standard`, `simple`, `external` | `standard` | The column set (§3) |
| `lang` | `ar`, `en` | `ar` | Account-name language in the `simple` and `external` presets (`standard` always carries both) |
| `dateFormat` | `iso`, `dmy` | `iso` | `2026-08-05` or `05/08/2026` in the date columns |
| `excludeReversed` | `true` / `false` | `false` | Leave out reversed entries **and** their reversals (the net effect is the same; the file is shorter) |
| `format` | `csv`, `xlsx`, `json` | `csv` | `xlsx` returns the same columns as an Excel workbook (§2.1); `json` returns a preview (§6) instead of the file |

- **Access:** the finance-v2 flag must be on for the account (otherwise 404) and the caller needs the `view` capability. Owner-mobile tokens are refused (403). The export only ever reads the caller's own account.
- **Errors:** 400 `BAD_DATE`, `BAD_RANGE` (from after to), `BAD_PRESET`, `BAD_INPUT` (dateFormat), `EXPORT_TOO_LARGE` (more than 200,000 lines; the body carries `count` and `max`: narrow the range).

## 2. File

- **Encoding:** UTF-8 with a byte-order mark (`EF BB BF`), so Excel opens Arabic text correctly.
- **Quoting:** RFC 4180. The separator is a comma. A cell is quoted with `"` when it contains a comma, a quote, CR or LF, or starts or ends with whitespace; an embedded quote is doubled.
- **Lines:** CRLF (`\r\n`) after every row, including the last. The first row is the header.
- **Rows:** one per journal **line**, ordered by entry date, then entry number, then line number. All lines of an entry are consecutive, and the entry's debits equal its credits.
- **Amounts:** non-negative decimals with exactly two places, a dot as the decimal mark and no thousands separator (`1400.00`). On every row exactly one of `debit` and `credit` is non-zero; the other is `0.00`. SAR only.
- **Dates:** the entry date (the date the entry posts in the ledger, Asia/Riyadh) in the chosen `dateFormat`.
- **Formula guard:** a text cell that begins with `=`, `+`, `-`, `@`, a tab or a CR is prefixed with an apostrophe (`'`) so that a spreadsheet never evaluates it. Amount, date, line-number and VAT-rate cells are never altered. An importer that reads text columns should strip one leading apostrophe.
- **Filename** (`Content-Disposition`): `dara-journal_<from>_<to>.csv`.
- **Control totals** (response headers, also exposed to browsers): `X-Export-Rows` (line count), `X-Export-Debit`, `X-Export-Credit` (the two are always equal).

### 2.1 Excel (`format=xlsx`)

The same columns, rows, order and values as the CSV of the same parameters, in one sheet (`القيود`, or `Journal` with `lang=en`) with a bold, frozen header row. `debit` and `credit` are numeric cells formatted `#,##0.00`; `line_no` and `vat_rate` are numeric; dates are text in the chosen `dateFormat`; every other cell is an inline text cell. Text is never evaluated as a formula, so the apostrophe guard of the CSV is not applied. Filename `dara-journal_<from>_<to>.xlsx`, the same control-total headers, the same 200,000-line limit.

## 3. Columns

### 3.1 `standard` (default)

| # | Column | Content |
|---|---|---|
| 1 | `date` | Entry date |
| 2 | `entry_no` | Journal entry number, `JV-<fiscal year>-<6 digits>`, unique per account |
| 3 | `line_no` | Line number within the entry, from 1 |
| 4 | `account_code` | Chart-of-accounts code (e.g. `2111`; bank leaves are `1110xx`) |
| 5 | `account_name_ar` | Account name in Arabic |
| 6 | `account_name_en` | Account name in English (may be empty for a user-added account) |
| 7 | `debit` | Debit amount |
| 8 | `credit` | Credit amount |
| 9 | `memo` | The line's memo, or the entry memo when the line has none |
| 10 | `owner` | Landlord name (the landlord dimension), or empty |
| 11 | `property` | Property name, or empty |
| 12 | `unit` | Unit number, or empty |
| 13 | `tenant` | Tenant name, or empty |
| 14 | `contract` | Contract number (e.g. `EQ-000003`), or empty |
| 15 | `source_type` | What created the entry (§4) |
| 16 | `source_ref` | The source document's number where it has one (invoice, receipt, bill, payment voucher, contract), else `<source_type>#<id>` |
| 17 | `entry_memo` | The entry memo |
| 18 | `origin` | `auto`, `backfill`, `manual`, `opening`, `closing`, `reversal` |
| 19 | `status` | `posted`, or `reversed` for an entry a later reversal cancelled |
| 20 | `original_date` | The business date of the event; differs from `date` when a late event was routed to the next open period |
| 21 | `vat_category` | `S`, `Z`, `E`, `O` on VAT-relevant lines, else empty |
| 22 | `vat_rate` | VAT percent on those lines (e.g. `15`), else empty |
| 23 | `tax_role` | `output`, `input` or `input_nonrecoverable` on the lines the VAT return reads, else empty |
| 24 | `account_code_external` | The account's code in the external accounting system (كود النظام الخارجي, set per account in the chart), or empty. Added in the fixed-asset round; files from before it have 23 columns |

### 3.2 `simple`

`date, entry_no, account_code, account_name, debit, credit, memo`. `account_name` is Arabic, or English with `lang=en` (falling back to Arabic when there is no English name). This is the lowest-common-denominator layout most packages can map in their generic "import journal" screen. It is unchanged by the external code.

### 3.3 `external`

The accountant's "تصدير القيود" layout, for importing with the other system's own account codes:

| # | Column | Content |
|---|---|---|
| 1 | `date` | Entry date |
| 2 | `entry_no` | Journal entry number |
| 3 | `account_code_external` | The external system's account code, or empty when the account has none (map it before importing) |
| 4 | `account_code` | Dara's account code |
| 5 | `account_name` | Arabic, or English with `lang=en` (Arabic when there is none) |
| 6 | `debit` | Debit amount |
| 7 | `credit` | Credit amount |
| 8 | `cost_center` | The property (cost centre), or empty |
| 9 | `party` | The tenant, else the landlord, or empty |
| 10 | `reference` | As `source_ref` |
| 11 | `memo` | The line's memo, or the entry memo |

## 4. `source_type` values

`simple_invoice` (tax invoice, credit/debit note, commission, rent receipt, agency fee, receipt/deposit voucher), `fixed_asset` (acquisition, monthly depreciation, disposal; `source_ref` is the asset number `FA-######`), `payment` (an installment's due-date charge, release or cancellation), `payment_collection`, `contract` (deposit forfeit), `expense`, `landlord_payout`, `tenant_credit_action`, `write_off`, `manual_journal`, `opening_balance`, `vat_return`, `fiscal_year` (the year-end closing entry and its refreshes), `supplier_bill`, `supplier_payment`.

## 5. Reversals

The ledger is immutable: a correction is a reversal entry that mirrors the original, and the original's `status` becomes `reversed`. By default both are exported, so the file reproduces the ledger and every account balance exactly. `excludeReversed=true` drops both the reversed original and its reversal (their net is zero), which gives a shorter file with the same balances.

## 6. JSON preview (`format=json`)

```
{ report: "journal-export", lang, generatedAt, params: {from, to, preset, lang, dateFormat, excludeReversed},
  columns: string[], count, truncated, maxLines,
  totals: { debit, credit, balanced },
  lines: [{ date, entryNo, lineNo, accountCode, accountNameAr, accountNameEn, debit, credit, memo, entryMemo,
            owner, property, unit, tenant, contract, sourceType, sourceRef, origin, status, originalDate,
            vatCategory, vatRate, taxRole, accountCodeExternal }] }
```

`lines` holds the first 200 lines; `count` and `totals` cover the whole range.

## 7. Importing: checks

1. The sum of `debit` equals the sum of `credit` (also `X-Export-Debit` = `X-Export-Credit`).
2. Every `entry_no` balances on its own.
3. Map `account_code` to the target chart once; Dara's codes are stable (a bank account's leaf code never changes).
4. The first export of a company should start at the ledger's first entry (the opening entry, `origin=opening`), or be preceded by an opening balance in the target package.

Vendor-specific presets (column names and date formats of particular Saudi packages) are not provided: their import specifications were not verified. Use `simple` or `standard` and the target package's column mapping.
