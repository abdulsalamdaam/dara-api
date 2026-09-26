import "reflect-metadata";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { apAgingOf, billLineAmounts, dueDateOf, paymentStatusOf, VAT_TOLERANCE_HALALAS } from "./ap-math";
import { BOM, csvCell, formatDate, journalCsv, PRESETS, type ExportLine } from "./journal-csv";
import { FinanceV2Tier3Controller } from "../controllers/tier3.controller";

/** DESIGN §8.4 tier 3, the pure parts. Synthetic values only. */
describe("fv2 tier 3 AP arithmetic", () => {
  it("bill line amounts: net and gross entry, Z/E/O carry no VAT", () => {
    assert.deepEqual(billLineAmounts("net", 100000, "S", 15, null), { net: 100000, vat: 15000, rate: 15 });
    assert.deepEqual(billLineAmounts("gross", 115000, "S", 15, null), { net: 100000, vat: 15000, rate: 15 });
    assert.deepEqual(billLineAmounts("net", 33333, "S", 15, null), { net: 33333, vat: 5000, rate: 15 }, "4999.95 rounds half up to 5000");
    for (const c of ["Z", "E", "O"] as const) assert.deepEqual(billLineAmounts("gross", 25000, c, 15, null), { net: 25000, vat: 0, rate: 0 });
  });

  it("an explicit VAT figure from the tax invoice is accepted within the tolerance, only on S", () => {
    assert.deepEqual(billLineAmounts("net", 100000, "S", 15, 15005), { net: 100000, vat: 15005, rate: 15 });
    assert.deepEqual(billLineAmounts("gross", 115000, "S", 15, 14995), { net: 100005, vat: 14995, rate: 15 }, "gross stays 1,150.00");
    assert.throws(() => billLineAmounts("net", 100000, "S", 15, 15000 + VAT_TOLERANCE_HALALAS + 1), /^Error: VAT_MISMATCH/);
    assert.throws(() => billLineAmounts("net", 100000, "Z", 0, 0), /^Error: VAT_NOT_ALLOWED/);
    assert.throws(() => billLineAmounts("net", 100000, "S", 15, -1), /^Error: BAD_VAT/);
  });

  it("due date = bill date + terms, across month and leap-year ends", () => {
    assert.equal(dueDateOf("2026-01-31", 30), "2026-03-02");
    assert.equal(dueDateOf("2028-02-15", 14), "2028-02-29");
    assert.equal(dueDateOf("2026-12-20", 15), "2027-01-04");
    assert.equal(dueDateOf("2026-05-05", 0), "2026-05-05");
  });

  it("AP aging: due date is day 0; before it the bill is not due; part-paid ages its remainder", () => {
    assert.deepEqual(apAgingOf({ total: 140000, paid: 0, dueDate: "2026-09-04" }, "2026-09-03"), { remaining: 140000, daysPastDue: -1, bucket: "notDue" });
    assert.deepEqual(apAgingOf({ total: 140000, paid: 100000, dueDate: "2026-09-04" }, "2026-09-04"), { remaining: 40000, daysPastDue: 0, bucket: "d0_30" });
    assert.equal(apAgingOf({ total: 1, paid: 0, dueDate: "2026-01-01" }, "2026-03-02").bucket, "d31_60");
    assert.equal(apAgingOf({ total: 1, paid: 0, dueDate: "2026-01-01" }, "2026-04-02").bucket, "d90p");
    assert.equal(paymentStatusOf(140000, 0), "unpaid");
    assert.equal(paymentStatusOf(140000, 1), "partial");
    assert.equal(paymentStatusOf(140000, 140000), "paid");
  });
});

describe("fv2 journal CSV format (docs/finance-v2/JOURNAL-EXPORT.md)", () => {
  const line = (over: Partial<ExportLine> = {}): ExportLine => ({
    date: "2026-08-05", entryNo: "JV-2026-000001", lineNo: 1, accountCode: "2111", accountNameAr: "الموردون", accountNameEn: "Accounts payable – suppliers",
    debit: "0.00", credit: "1400.00", memo: null, entryMemo: "Supplier bill BILL-000001", owner: null, property: null, unit: null, tenant: null,
    contract: null, sourceType: "supplier_bill", sourceRef: "BILL-000001", origin: "auto", status: "posted", originalDate: "2026-08-05",
    vatCategory: null, vatRate: null, taxRole: null, ...over,
  });

  it("BOM, the documented header, CRLF rows and a trailing CRLF", () => {
    const csv = journalCsv([line(), line({ lineNo: 2, accountCode: "5290", debit: "1400.00", credit: "0.00" })]);
    assert.ok(csv.startsWith(BOM));
    const rows = csv.slice(1).split("\r\n");
    assert.equal(rows.at(-1), "", "ends with CRLF");
    assert.equal(rows[0], PRESETS.standard.join(","));
    assert.equal(rows[0], "date,entry_no,line_no,account_code,account_name_ar,account_name_en,debit,credit,memo,owner,property,unit,tenant,contract,source_type,source_ref,entry_memo,origin,status,original_date,vat_category,vat_rate,tax_role");
    assert.equal(rows.length, 4);
    assert.ok(rows[1].startsWith("2026-08-05,JV-2026-000001,1,2111,الموردون,Accounts payable – suppliers,0.00,1400.00,Supplier bill BILL-000001,"));
    assert.ok(!csv.includes("\n\n") && !/[^\r]\n/.test(csv), "no bare LF");
  });

  it("the simple preset, the English account name and the dd/mm/yyyy date", () => {
    const csv = journalCsv([line()], { preset: "simple", lang: "en", dateFormat: "dmy" });
    const rows = csv.slice(1).split("\r\n");
    assert.equal(rows[0], "date,entry_no,account_code,account_name,debit,credit,memo");
    assert.equal(rows[1], "05/08/2026,JV-2026-000001,2111,Accounts payable – suppliers,0.00,1400.00,Supplier bill BILL-000001");
    assert.equal(formatDate("2026-12-31", "dmy"), "31/12/2026");
  });

  it("RFC 4180 quoting, and text that a spreadsheet would evaluate is neutralised; amounts are never touched", () => {
    assert.equal(csvCell('a "quoted", value'), '"a ""quoted"", value"');
    assert.equal(csvCell("two\nlines"), '"two\nlines"');
    assert.equal(csvCell("=HYPERLINK(\"x\")"), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell("+966500000000"), "'+966500000000");
    assert.equal(csvCell("-5"), "'-5");
    assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
    assert.equal(csvCell("-5.00", true), "-5.00");
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(" padded"), '" padded"');
  });
});

describe("fv2 tier 3 routes: every handler needs a capability", () => {
  it("tier3 controller", () => {
    const names = Object.getOwnPropertyNames(FinanceV2Tier3Controller.prototype).filter((x) => x !== "constructor");
    assert.ok(names.length >= 17);
    for (const k of names) {
      assert.ok(Reflect.getMetadata("fv2:capability", (FinanceV2Tier3Controller.prototype as any)[k]), `FinanceV2Tier3Controller.${k} has no capability`);
    }
    const cap = (k: string) => Reflect.getMetadata("fv2:capability", (FinanceV2Tier3Controller.prototype as any)[k]);
    assert.deepEqual(["approveBill", "voidBill", "voidPayment", "createPayment", "createBill", "journalExport"].map(cap), ["approve", "approve", "approve", "money", "expenses", "view"]);
  });
});
