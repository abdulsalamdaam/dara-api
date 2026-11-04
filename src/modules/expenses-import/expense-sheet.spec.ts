import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
  EXAMPLE_NOTE, LISTS_SHEET, MAIN_SHEET, MAX_ROWS, SheetError, cellValue, columnsFor, headerText, mapRow, parseAmount, parseDate,
  readSheet, refLabel, resolveRef, type MapCtx, type RawRow,
} from "./expense-sheet";
import { buildTemplate } from "./expense-template";

/** The expenses spreadsheet: parsing, row mapping, and the template read back. Synthetic data only (public repo). */
const owners = [{ id: 11, name: "Synthetic Landlord A" }, { id: 12, name: "Synthetic Landlord B" }, { id: 13, name: "Synthetic Landlord B" }];
const properties = [
  { id: 21, name: "Synthetic Tower", ownerId: 11 },
  { id: 22, name: "Synthetic Villa", ownerId: 12 },
  { id: 23, name: "Unowned Block", ownerId: null },
];
const legacy: MapCtx = { mode: "legacy", owners, properties };
const v2: MapCtx = { mode: "v2", owners, properties };
const raw = (o: Partial<RawRow>): RawRow => ({ row: 2, ...o });

describe("expense sheet: cell parsing", () => {
  it("dates: Excel dates and serials, ISO, DD/MM/YYYY, Arabic-Indic digits", () => {
    assert.equal(parseDate(new Date(Date.UTC(2026, 0, 15))), "2026-01-15");
    assert.equal(parseDate(new Date(Date.UTC(2026, 0, 15) + 3)), "2026-01-15"); // a float serial's stray milliseconds
    assert.equal(parseDate(46037), "2026-01-15");
    assert.equal(parseDate("2026-01-15"), "2026-01-15");
    assert.equal(parseDate("2026/1/5"), "2026-01-05");
    assert.equal(parseDate("15/01/2026"), "2026-01-15");
    assert.equal(parseDate("5-1-2026"), "2026-01-05");
    assert.equal(parseDate("١٥/٠١/٢٠٢٦"), "2026-01-15");
    for (const bad of ["31/02/2026", "2026-13-01", "1447-05-12", "next week", "01/15/2026", ""]) assert.equal(parseDate(bad), null, bad);
    assert.equal(parseDate(null), null);
  });

  it("amounts: numbers, strings with separators / currency / Arabic digits; positive, two decimals", () => {
    assert.equal(parseAmount(1150), "1150.00");
    assert.equal(parseAmount(0.1 + 0.2), "0.30");
    assert.equal(parseAmount("1,250.5"), "1250.50");
    assert.equal(parseAmount("١٬٢٥٠٫٧٥"), "1250.75");
    assert.equal(parseAmount("300 ر.س"), "300.00");
    assert.equal(parseAmount("300 SAR"), "300.00");
    for (const bad of [0, -5, 1.005, "1.005", "abc", "-10", "0", "1e3", "1000000000"]) assert.equal(parseAmount(bad as any), null, String(bad));
    assert.equal(parseAmount(new Date()), null);
  });

  it("cell values: rich text, formula results, hyperlinks, errors", () => {
    assert.equal(cellValue({ richText: [{ text: "صي" }, { text: "انة" }] }), "صيانة");
    assert.equal(cellValue({ formula: "A1*2", result: 40 }), 40);
    assert.equal(cellValue({ formula: "A1*2" }), null);
    assert.equal(cellValue({ text: "Synthetic", hyperlink: "https://example.test" }), "Synthetic");
    assert.equal(cellValue({ error: "#N/A" }), null);
    assert.equal(cellValue("   "), null);
    assert.equal(cellValue(true), "true");
  });

  it("refs: by (#id) label, by a unique exact name; ambiguous and unknown are errors", () => {
    assert.equal(resolveRef(refLabel(owners[1]), owners, "المؤجر").ref?.id, 12);
    assert.equal(resolveRef("anything (#١١)", owners, "المؤجر").ref?.id, 11);
    assert.equal(resolveRef("  synthetic   landlord a ", owners, "المؤجر").ref?.id, 11);
    assert.match(resolveRef("Synthetic Landlord B", owners, "المؤجر").error!, /أكثر من/);
    assert.match(resolveRef("Nobody", owners, "المؤجر").error!, /غير موجود/);
    assert.match(resolveRef("Synthetic Landlord A (#99)", owners, "المؤجر").error!, /غير موجود/);
  });
});

describe("expense sheet: row mapping", () => {
  it("a full legacy row → the POST /reports/expenses body", () => {
    const m = mapRow(raw({ expenseDate: "15/01/2026", category: " صيانة ", amount: "1,150", ownerId: refLabel(owners[0]), propertyId: refLabel(properties[0]), notes: "مكيفات" }), legacy);
    assert.deepEqual(m.errors, []);
    assert.deepEqual(m.body, { expenseDate: "2026-01-15", category: "صيانة", amount: "1150.00", ownerId: 11, propertyId: 21, notes: "مكيفات" });
    assert.equal(m.preview.ownerName, "Synthetic Landlord A");
  });

  it("legacy: landlord and property required; a property alone names its landlord", () => {
    const none = mapRow(raw({ expenseDate: "2026-01-15", category: "x", amount: 5 }), legacy);
    assert.deepEqual(none.errors.map((e) => e.field).sort(), ["ownerId", "propertyId"]);
    const prop = mapRow(raw({ expenseDate: "2026-01-15", category: "x", amount: 5, propertyId: "Synthetic Tower" }), legacy);
    assert.deepEqual(prop.errors, []);
    assert.equal(prop.body.ownerId, 11);
    const unowned = mapRow(raw({ expenseDate: "2026-01-15", category: "x", amount: 5, propertyId: refLabel(properties[2]) }), legacy);
    assert.deepEqual(unowned.errors.map((e) => e.field), ["ownerId"]);
  });

  it("a property of another landlord is refused; required fields and bad values say which column", () => {
    const mis = mapRow(raw({ expenseDate: "2026-01-15", category: "x", amount: 5, ownerId: refLabel(owners[0]), propertyId: refLabel(properties[1]) }), legacy);
    assert.deepEqual(mis.errors, [{ field: "propertyId", message: "العقار لا يتبع هذا المؤجر" }]);
    const bad = mapRow(raw({ expenseDate: "2026-02-30", amount: "abc", ownerId: refLabel(owners[0]), propertyId: refLabel(properties[0]) }), legacy);
    assert.deepEqual(bad.errors.map((e) => e.field), ["expenseDate", "category", "amount"]);
    assert.equal(bad.preview.expenseDate, "2026-02-30"); // what was typed, for the preview table
    assert.ok(bad.errors.every((e) => /[؀-ۿ]/.test(e.message)));
  });

  it("v2: landlord / property optional, choices mapped, defaults gross / O / company", () => {
    const bare = mapRow(raw({ expenseDate: "2026-01-15", category: "قرطاسية", amount: 100 }), v2);
    assert.deepEqual(bare.errors, []);
    assert.equal(bare.body.ownerId, null);
    assert.equal(bare.body.propertyId, null);
    assert.equal(bare.body.amountMode, "gross");
    assert.equal(bare.body.vatCategory, "O");
    assert.equal(bare.body.chargeTo, "company");
    const full = mapRow(raw({
      expenseDate: "2026-01-15", category: "صيانة", amount: "1150", ownerId: refLabel(owners[0]), propertyId: refLabel(properties[0]),
      chargeTo: "المؤجر", amountMode: "غير شامل الضريبة", vatCategory: "خاضعة 15%", supplierName: "Synthetic Supplier",
      supplierVatNumber: "٣٠٠٠٠٠٠٠٠٠٠٠٠٠٣", supplierInvoiceNo: "INV-1",
    }), v2);
    assert.deepEqual(full.errors, []);
    assert.equal(full.body.chargeTo, "landlord");
    assert.equal(full.body.amountMode, "net");
    assert.equal(full.body.vatCategory, "S");
    assert.equal(full.body.vatRate, 15);
    assert.equal(full.body.supplierVatNumber, "300000000000003");
    assert.equal(mapRow(raw({ expenseDate: "2026-01-15", category: "x", amount: 1, vatCategory: "معفى", chargeTo: "الشركة" }), v2).body.vatCategory, "E");
  });

  it("v2: «حساب المصروف» resolves to one of the account's expense accounts, or is a row error", () => {
    const ctx: MapCtx = { ...v2, expenseAccounts: [{ id: 501, name: "5110 صيانة" }, { id: 777, name: "5199 مصروف أنشأه المستخدم" }] };
    const ok = mapRow(raw({ expenseDate: "2026-01-15", category: "x", amount: 1, glAccountId: "5199 مصروف أنشأه المستخدم (#777)" }), ctx);
    assert.deepEqual([ok.errors.length, ok.body.glAccountId, ok.preview.glAccountName], [0, 777, "5199 مصروف أنشأه المستخدم"]);
    assert.equal(mapRow(raw({ expenseDate: "2026-01-15", category: "x", amount: 1 }), ctx).body.glAccountId, null, "blank: from the item");
    assert.equal(mapRow(raw({ expenseDate: "2026-01-15", category: "x", amount: 1, glAccountId: "حساب غير موجود" }), ctx).errors[0].field, "glAccountId");
  });

  it("v2: an unknown choice or a bad supplier VAT number is a row error", () => {
    const m = mapRow(raw({ expenseDate: "2026-01-15", category: "x", amount: 1, vatCategory: "10%", chargeTo: "someone", supplierVatNumber: "123" }), v2);
    assert.deepEqual(m.errors.map((e) => e.field), ["chargeTo", "vatCategory", "supplierVatNumber"]);
  });
});

describe("expense sheet: template and reader", () => {
  const lists = { owners: owners.slice(0, 2), properties, categories: ["سباكة"] };

  it("the v2 template: RTL, headers, lists sheet, dropdowns; reads back with the examples skipped", async () => {
    const buf = await buildTemplate({ mode: "v2", ...lists });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const ws = wb.getWorksheet(MAIN_SHEET)!;
    assert.equal((ws.views[0] as any).rightToLeft, true);
    assert.deepEqual((ws.getRow(1).values as unknown[]).slice(1), columnsFor("v2").map(headerText));
    const l = wb.getWorksheet(LISTS_SHEET)!;
    assert.equal(l.getCell("A2").value, "Synthetic Landlord A (#11)");
    assert.equal(l.getCell("B4").value, "Unowned Block (#23)");
    assert.ok((l.getColumn(3).values as unknown[]).includes("سباكة"));
    assert.ok((l.getColumn(6).values as unknown[]).includes("خارج النطاق"));
    const dv = ws.getCell("D5").dataValidation;
    assert.equal(dv.type, "list");
    assert.equal(dv.formulae[0], `'${LISTS_SHEET}'!$A$2:$A$3`);
    await assert.rejects(readSheet(buf), (e: any) => e instanceof SheetError && e.code === "EMPTY");
  });

  it("the legacy template has no Accounting columns; a filled copy reads back by header", async () => {
    const buf = await buildTemplate({ mode: "legacy", owners: [], properties: [], categories: [] });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const ws = wb.getWorksheet(MAIN_SHEET)!;
    assert.deepEqual((ws.getRow(1).values as unknown[]).slice(1), ["التاريخ*", "البند*", "المبلغ*", "المؤجر", "العقار", "ملاحظات"]);
    assert.equal(ws.getCell("D5").dataValidation?.type, undefined); // no landlords: no dropdown pointing at an empty list
    ws.getRow(4).values = [new Date(Date.UTC(2026, 2, 1)), "نظافة", 250, "Synthetic Landlord A", "Synthetic Tower", null];
    ws.getRow(6).values = ["02/03/2026", { richText: [{ text: "مياه" }] }, "٣٠٠", null, null, "x"];
    const { rows, skipped } = await readSheet(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.equal(skipped, 2);
    assert.deepEqual(rows.map((r) => r.row), [4, 6]);
    assert.equal(rows[1].category, "مياه");
    assert.equal(parseDate(rows[0].expenseDate!), "2026-03-01");
  });

  it("columns are found by header in any order; a missing required column, a non-xlsx and too many rows are refused", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["ملاحظات", "المبلغ", "البند *", "التاريخ"]);
    ws.addRow(["n", 10, "صيانة", "2026-01-01"]);
    const { rows } = await readSheet(Buffer.from(await wb.xlsx.writeBuffer()));
    assert.deepEqual({ a: rows[0].amount, c: rows[0].category, n: rows[0].notes }, { a: 10, c: "صيانة", n: "n" });

    const w2 = new ExcelJS.Workbook();
    w2.addWorksheet(MAIN_SHEET).addRow(["التاريخ", "البند"]);
    await assert.rejects(readSheet(Buffer.from(await w2.xlsx.writeBuffer())), (e: any) => e.code === "BAD_TEMPLATE" && /المبلغ/.test(e.message));
    await assert.rejects(readSheet(Buffer.from("not a workbook")), (e: any) => e.code === "BAD_FILE");

    const w3 = new ExcelJS.Workbook();
    const s3 = w3.addWorksheet(MAIN_SHEET);
    s3.addRow(["التاريخ", "البند", "المبلغ"]);
    for (let i = 0; i <= MAX_ROWS; i++) s3.addRow(["2026-01-01", "x", 1]);
    await assert.rejects(readSheet(Buffer.from(await w3.xlsx.writeBuffer())), (e: any) => e.code === "TOO_MANY_ROWS");
    s3.spliceRows(2, 1);
    assert.equal((await readSheet(Buffer.from(await w3.xlsx.writeBuffer()))).rows.length, MAX_ROWS);
  });

  it("example rows carry the marker the reader skips on", async () => {
    const buf = await buildTemplate({ mode: "v2", ...lists });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as any);
    const notesCol = columnsFor("v2").length;
    assert.ok(String(wb.getWorksheet(MAIN_SHEET)!.getCell(2, notesCol).value).startsWith(EXAMPLE_NOTE));
  });
});
