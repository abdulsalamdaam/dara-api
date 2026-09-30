import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import {
  cumulativeAt, disposalFigures, lastChargeMonth, monthCharge, partialCharge, schedule, addMonths, monthEnd, type ScheduleInput,
} from "./asset-math";
import { assetAcquired, assetDepreciation, assetDisposal } from "../rules/assets";
import { runRule, EMPTY_STATE } from "../rules";
import { journalCsv, journalXlsxRows, PRESETS, type ExportLine } from "../tier3/journal-csv";
import { crc32, xlsxWorkbook } from "../tier3/xlsx";

/** Balanced, in halalas. */
function balance(lines: Array<{ debit: number; credit: number }>) {
  return lines.reduce((s, l) => s + l.debit - l.credit, 0);
}

/**
 * DESIGN §8.5 straight-line depreciation, by hand:
 *   A: cost 12,000.00, salvage 0, 12 months from 2026-01-01 → 1,000.00 a month, Jan…Dec, nothing in 2027.
 *   B: cost 36,000.00, salvage 6,000.00, 36 months from 2026-01-16 (31-day January):
 *      base 30,000 → 833.33⅓ a month; January 16/31 of a month = 430.11; the last charge in January 2029
 *      (month 37) takes the remainder; the NBV never goes below the 6,000 salvage.
 */
describe("fixed assets: straight-line math (pure)", () => {
  const A: ScheduleInput = { cost: 1_200_000, salvage: 0, opening: 0, lifeMonths: 12, start: "2026-01-01" };
  const B: ScheduleInput = { cost: 3_600_000, salvage: 600_000, opening: 0, lifeMonths: 36, start: "2026-01-16" };

  it("a start on the 1st: equal months, done after lifeMonths", () => {
    const rows = schedule(A);
    assert.equal(rows.length, 12);
    assert.ok(rows.every((r) => r.charge === 100_000));
    assert.equal(lastChargeMonth(A), "2026-12");
    assert.equal(monthCharge(A, "2027-01"), 0);
    assert.equal(monthCharge(A, "2025-12"), 0, "nothing before the start");
  });

  it("pro-rata first month by day (start day included), the remainder in month life+1, the total exact", () => {
    assert.equal(monthCharge(B, "2026-01"), 43_011, "30,000 × (16/31) / 36 = 430.107… → 430.11");
    assert.equal(monthCharge(B, "2026-02"), 83_333);
    const rows = schedule(B);
    assert.equal(rows[0].month, "2026-01");
    assert.equal(rows.at(-1)!.month, "2029-01", "36 months from mid-January end in mid-January three years on");
    assert.equal(rows.reduce((s, r) => s + r.charge, 0), 3_000_000, "no rounding drift: the charges add up to the base exactly");
    assert.equal(rows.at(-1)!.nbv, 600_000, "stops at salvage");
    assert.ok(rows.every((r) => r.nbv >= 600_000));
    assert.equal(monthCharge(B, "2029-02"), 0, "nothing after the base is used up");
    // monthly charges only ever differ by rounding
    assert.ok(rows.slice(1, -1).every((r) => r.charge === 83_333 || r.charge === 83_334));
  });

  it("opening accumulated depreciation reduces the base; land (life 0) is never depreciated", () => {
    const C: ScheduleInput = { cost: 1_000_000, salvage: 100_000, opening: 300_000, lifeMonths: 24, start: "2026-01-01" };
    assert.equal(schedule(C).reduce((s, r) => s + r.charge, 0), 600_000);
    assert.equal(schedule(C)[0].accumulated, 325_000, "accumulated includes the opening 3,000");
    const land: ScheduleInput = { cost: 5_000_000, salvage: 0, opening: 0, lifeMonths: 0, start: "2026-01-01" };
    assert.deepEqual(schedule(land), []);
    assert.equal(lastChargeMonth(land), null);
    assert.equal(monthCharge(land, "2026-05"), 0);
  });

  it("disposal mid-life: that month up to the date, accumulated removed, gain or loss", () => {
    // A disposed 2026-06-15 (30-day June): Jan–May 5,000 + 15/30 of June (500) = 5,500 accumulated; NBV 6,500
    assert.equal(partialCharge(A, "2026-06-15"), 50_000);
    const sale = disposalFigures(A, "2026-06-15", 700_000);
    assert.deepEqual(sale, { partial: 50_000, accumulatedBefore: 500_000, accumulated: 550_000, nbv: 650_000, gain: 50_000 });
    const scrap = disposalFigures(A, "2026-06-15", 0);
    assert.equal(scrap.gain, -650_000, "scrapped for nothing: a loss of the NBV");
    // disposed in the pro-rata first month
    assert.equal(partialCharge(B, "2026-01-20"), cumulativeAt(B, "2026-01-20"));
    assert.equal(cumulativeAt(B, "2026-01-15"), 0, "before the start");
    // disposal after it is fully depreciated: nothing more to charge, NBV = salvage
    const late = disposalFigures(B, "2030-03-10", 600_000);
    assert.deepEqual([late.partial, late.nbv, late.gain], [0, 600_000, 0]);
  });

  it("month helpers", () => {
    assert.equal(addMonths("2026-11", 3), "2027-02");
    assert.equal(addMonths("2026-01", -1), "2025-12");
    assert.equal(monthEnd("2028-02"), "2028-02-29");
  });
});

describe("fixed assets: posting rules FA01–FA03 balance", () => {
  const dims = { propertyId: 7 };
  it("FA01 acquisition: Dr asset / Cr bank", () => {
    const out = assetAcquired({ date: "2026-03-01", assetId: 1, amount: "12000.00", assetAccountId: 11, bank: { bankAccountId: 3 }, dims });
    assert.equal(balance(out.lines), 0);
    assert.deepEqual(out.lines.map((l) => [l.account, l.debit, l.credit]), [[{ id: 11 }, 1_200_000, 0], [{ bank: { bankAccountId: 3 } }, 0, 1_200_000]]);
    assert.ok(out.lines.every((l) => l.dims.propertyId === 7), "the property dimension on every line");
  });

  it("FA02 depreciation: Dr expense / Cr accumulated; a zero month skips", () => {
    const out = runRule({ rule: "FA02", facts: { date: "2026-03-31", assetId: 1, month: "2026-03", amount: "1000.00", expenseAccountId: 20, accumAccountId: 21, dims } }, EMPTY_STATE);
    assert.equal(balance(out.lines), 0);
    assert.deepEqual(out.lines.map((l) => [l.account, l.debit, l.credit]), [[{ id: 20 }, 100_000, 0], [{ id: 21 }, 0, 100_000]]);
    assert.equal(assetDepreciation({ date: "2026-03-31", assetId: 1, month: "2026-03", amount: "0.00", expenseAccountId: 20, accumAccountId: 21, dims }).skip, "zero_amount");
  });

  it("FA03 disposal: gain and loss both balance; the month's charge is booked inside the entry", () => {
    const base = { date: "2026-06-15", assetId: 1, cost: "12000.00", partial: "500.00", accumulated: "5500.00", assetAccountId: 11, accumAccountId: 21,
      expenseAccountId: 20, gainAccountId: 30, lossAccountId: 31, bank: { bankAccountId: 3 }, dims };
    const gain = assetDisposal({ ...base, proceeds: "7000.00" });
    assert.equal(balance(gain.lines), 0);
    assert.deepEqual(gain.lines.map((l) => [(l.account as any).id ?? "bank", l.debit, l.credit]), [
      [20, 50_000, 0], [21, 0, 50_000], [21, 550_000, 0], ["bank", 700_000, 0], [11, 0, 1_200_000], [30, 0, 50_000],
    ]);
    const loss = assetDisposal({ ...base, proceeds: "0" });
    assert.equal(balance(loss.lines), 0);
    assert.deepEqual(loss.lines.at(-1)!.account, { id: 31 });
    assert.equal(loss.lines.at(-1)!.debit, 650_000);
    // land: no accumulated lines at all
    const land = assetDisposal({ ...base, partial: "0", accumulated: "0", accumAccountId: null, expenseAccountId: null, proceeds: "12000.00" });
    assert.deepEqual(land.lines.map((l) => [(l.account as any).id ?? "bank", l.debit, l.credit]), [["bank", 1_200_000, 0], [11, 0, 1_200_000]]);
    assert.throws(() => assetDisposal({ ...base, accumulated: "13000.00", proceeds: "0" }), /inconsistent/);
  });
});

describe("journal export: external code column, external preset, Excel variant", () => {
  const line: ExportLine = {
    date: "2026-08-05", entryNo: "JV-2026-000001", lineNo: 1, accountCode: "1113", accountNameAr: "البنك", accountNameEn: "Bank",
    debit: "1400.00", credit: "0.00", memo: null, entryMemo: "=cmd", owner: "Landlord A", property: "Tower", unit: null, tenant: null,
    contract: null, sourceType: "supplier_bill", sourceRef: "BILL-000001", origin: "auto", status: "posted", originalDate: "2026-08-05",
    vatCategory: null, vatRate: null, taxRole: null, accountCodeExternal: "EXT-1113",
  };

  it("standard gains account_code_external as its last (24th) column; simple is unchanged", () => {
    assert.equal(PRESETS.standard.length, 24);
    assert.equal(PRESETS.standard[23], "account_code_external");
    assert.deepEqual(PRESETS.simple, ["date", "entry_no", "account_code", "account_name", "debit", "credit", "memo"]);
    const csv = journalCsv([line]);
    const [head, row] = csv.slice(1).split("\r\n");
    assert.ok(head.endsWith(",tax_role,account_code_external"));
    assert.ok(row.endsWith(",EXT-1113"));
    assert.ok(journalCsv([{ ...line, accountCodeExternal: null }]).split("\r\n")[1].endsWith(","), "empty when not set");
  });

  it("the external preset is the accountant's layout", () => {
    assert.deepEqual(PRESETS.external, ["date", "entry_no", "account_code_external", "account_code", "account_name", "debit", "credit", "cost_center", "party", "reference", "memo"]);
    const row = journalCsv([line], { preset: "external", dateFormat: "dmy" }).split("\r\n")[1];
    assert.equal(row, "05/08/2026,JV-2026-000001,EXT-1113,1113,البنك,1400.00,0.00,Tower,Landlord A,BILL-000001,'=cmd");
  });

  it("Excel: the same columns, amounts as numbers, a valid ZIP whose sheet carries the values", () => {
    const t = journalXlsxRows([line], { preset: "external" });
    assert.deepEqual(t.header, PRESETS.external);
    assert.deepEqual(t.rows[0][5], { t: "n", v: "1400.00", money: true });
    assert.deepEqual(t.rows[0][10], { t: "s", v: "=cmd" }, "no apostrophe: an inline string is never a formula");
    const buf = xlsxWorkbook("القيود", t.header, t.rows);
    assert.equal(buf.readUInt32LE(0), 0x04034b50, "ZIP local header");
    // read the entries back (deflate) and check the sheet and the CRCs
    const files = new Map<string, string>();
    let off = 0;
    while (buf.readUInt32LE(off) === 0x04034b50) {
      const crc = buf.readUInt32LE(off + 14), csize = buf.readUInt32LE(off + 18), nlen = buf.readUInt16LE(off + 26), xlen = buf.readUInt16LE(off + 28);
      const name = buf.subarray(off + 30, off + 30 + nlen).toString("utf8");
      const data = inflateRawSync(buf.subarray(off + 30 + nlen + xlen, off + 30 + nlen + xlen + csize));
      assert.equal(crc32(data), crc, name);
      files.set(name, data.toString("utf8"));
      off += 30 + nlen + xlen + csize;
    }
    assert.deepEqual([...files.keys()].sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    assert.match(sheet, /<c r="F2" s="2"><v>1400<\/v><\/c>/);
    assert.match(sheet, /<c r="C2" t="inlineStr"><is><t xml:space="preserve">EXT-1113<\/t><\/is><\/c>/);
    assert.match(sheet, /<t xml:space="preserve">=cmd<\/t>/);
    assert.match(files.get("xl/workbook.xml")!, /name="القيود"/);
  });
});
