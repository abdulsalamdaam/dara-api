import ExcelJS from "exceljs";
import {
  AMOUNT_MODE, CHARGE_TO, EXAMPLE_NOTE, HELP_SHEET, LISTS_SHEET, MAIN_SHEET, MAX_ROWS, VAT_CATEGORY,
  columnsFor, headerText, refLabel, type Field, type ImportMode, type PropertyRef, type Ref,
} from "./expense-sheet";

const COBALT = "FF042698";
const COOL_GRAY = "FFE6EAF2";

/** Common items offered next to the account's own, so a new account's dropdown is not empty. The cell still takes free text. */
export const DEFAULT_CATEGORIES = ["صيانة", "نظافة", "كهرباء", "مياه", "أمن وحراسة", "مصاعد"];

export interface TemplateInput {
  mode: ImportMode;
  owners: readonly Ref[];
  properties: readonly PropertyRef[];
  categories: readonly string[];
}

/**
 * The per-account template: one Arabic (RTL) sheet to fill, a lists sheet
 * with this account's landlords / properties / items and the fixed choices,
 * dropdowns on the main sheet pointing at those lists, and example rows the
 * parser skips (their notes say so).
 */
export async function buildTemplate(input: TemplateInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Dara";
  const cols = columnsFor(input.mode);
  const ws = wb.addWorksheet(MAIN_SHEET, { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
  const lists = wb.addWorksheet(LISTS_SHEET, { views: [{ rightToLeft: true }] });
  const help = wb.addWorksheet(HELP_SHEET, { views: [{ rightToLeft: true }] });

  ws.columns = cols.map((c) => ({ header: headerText(c), key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.alignment = { vertical: "middle", horizontal: "center" };
  head.height = 22;
  head.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COBALT } }; });

  // The lists sheet: one column per list, header in row 1.
  const categories = [...new Set([...input.categories.map((c) => c.trim()).filter(Boolean), ...DEFAULT_CATEGORIES])];
  const listCols: { key: string; title: string; values: string[] }[] = [
    { key: "ownerId", title: "المؤجرون", values: input.owners.map(refLabel) },
    { key: "propertyId", title: "العقارات", values: input.properties.map(refLabel) },
    { key: "category", title: "البنود", values: categories },
  ];
  if (input.mode === "v2") {
    listCols.push(
      { key: "chargeTo", title: "يتحمّلها", values: CHARGE_TO.map((c) => c.label) },
      { key: "amountMode", title: "طريقة المبلغ", values: AMOUNT_MODE.map((c) => c.label) },
      { key: "vatCategory", title: "نوع الضريبة", values: VAT_CATEGORY.map((c) => c.label) },
    );
  }
  const rangeOf = new Map<string, string>();
  listCols.forEach((l, i) => {
    const col = lists.getColumn(i + 1);
    col.width = Math.max(14, ...l.values.map((v) => Math.min(60, v.length + 2)));
    const h = lists.getCell(1, i + 1);
    h.value = l.title;
    h.font = { bold: true };
    h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COOL_GRAY } };
    l.values.forEach((v, j) => { lists.getCell(j + 2, i + 1).value = v; });
    if (l.values.length) rangeOf.set(l.key, `'${LISTS_SHEET}'!$${col.letter}$2:$${col.letter}$${l.values.length + 1}`);
  });

  // Dropdowns and formats over the rows a user may fill.
  const colIdx = (k: Field) => cols.findIndex((c) => c.key === k) + 1;
  const strict = (k: Field, title: string): ExcelJS.DataValidation | null => {
    const range = rangeOf.get(k);
    return range ? {
      type: "list", allowBlank: true, formulae: [range], showErrorMessage: true, errorStyle: "stop",
      errorTitle: title, error: `اختر ${title} من القائمة`,
    } : null;
  };
  const validations: [Field, ExcelJS.DataValidation | null][] = [
    ["ownerId", strict("ownerId", "المؤجر")],
    ["propertyId", strict("propertyId", "العقار")],
    // Items are free text: the list only suggests.
    ["category", rangeOf.has("category") ? { type: "list", allowBlank: true, formulae: [rangeOf.get("category")], showErrorMessage: false } : null],
    ["amount", {
      type: "decimal", operator: "greaterThan", allowBlank: true, formulae: [0], showErrorMessage: true, errorStyle: "stop",
      errorTitle: "المبلغ", error: "المبلغ رقم أكبر من صفر",
    }],
  ];
  if (input.mode === "v2") {
    validations.push(["chargeTo", strict("chargeTo", "من يتحمّلها")], ["amountMode", strict("amountMode", "طريقة المبلغ")], ["vatCategory", strict("vatCategory", "نوع الضريبة")]);
  }
  const dateCol = colIdx("expenseDate");
  const amountCol = colIdx("amount");
  for (let r = 2; r <= MAX_ROWS + 1; r++) {
    const row = ws.getRow(r);
    row.getCell(dateCol).numFmt = "yyyy-mm-dd";
    row.getCell(amountCol).numFmt = "#,##0.00";
  }
  // One range per column. Not per cell: exceljs merges per-cell validations by string-sorted address
  // ("B10" before "B2") and writes overlapping ranges, which Excel reports as a damaged file.
  const dvs = (ws as unknown as { dataValidations: { add(range: string, dv: ExcelJS.DataValidation): void } }).dataValidations;
  for (const [k, dv] of validations) {
    const letter = colIdx(k) > 0 ? ws.getColumn(colIdx(k)).letter : null;
    if (dv && letter) dvs.add(`${letter}2:${letter}${MAX_ROWS + 1}`, dv);
  }

  // Example rows (skipped by the parser: their notes start with EXAMPLE_NOTE).
  const owner = input.owners[0];
  const property = (owner && input.properties.find((p) => p.ownerId === owner.id)) ?? input.properties[0];
  const examples: Partial<Record<Field, unknown>>[] = [
    {
      expenseDate: new Date(Date.UTC(2026, 0, 15)), category: "صيانة", amount: 1150,
      ownerId: owner ? refLabel(owner) : null, propertyId: property ? refLabel(property) : null,
      ...(input.mode === "v2" ? {
        chargeTo: CHARGE_TO[0].label, amountMode: AMOUNT_MODE[0].label, vatCategory: VAT_CATEGORY[0].label,
        supplierName: "مؤسسة الصيانة (مثال)", supplierVatNumber: "300000000000003", supplierInvoiceNo: "INV-1001",
      } : {}),
      notes: `${EXAMPLE_NOTE}: صيانة مكيفات`,
    },
    {
      expenseDate: "31/01/2026", category: "نظافة", amount: "250.00",
      ownerId: owner ? refLabel(owner) : null, propertyId: property ? refLabel(property) : null,
      ...(input.mode === "v2" ? { vatCategory: VAT_CATEGORY[3].label } : {}),
      notes: `${EXAMPLE_NOTE}: التاريخ نصاً بصيغة يوم/شهر/سنة يُقبل أيضاً`,
    },
  ];
  examples.forEach((ex, i) => {
    const row = ws.getRow(i + 2);
    for (const c of cols) if (ex[c.key] != null) row.getCell(colIdx(c.key)).value = ex[c.key] as ExcelJS.CellValue;
    row.font = { italic: true, color: { argb: "FF6B7280" } };
  });

  help.getColumn(1).width = 110;
  const lines = [
    "طريقة تعبئة قالب المصروفات",
    "",
    `• عبّئ ورقة «${MAIN_SHEET}»: صف لكل مصروف، بحد أقصى ${MAX_ROWS} صف في الملف.`,
    "• الأعمدة المعلّمة بـ * مطلوبة. احذف صفوف المثال (ملاحظاتها تبدأ بكلمة «مثال») أو اتركها؛ فهي لا تُستورد.",
    "• التاريخ ميلادي: تاريخ Excel، أو نص بصيغة YYYY-MM-DD أو DD/MM/YYYY.",
    "• المبلغ رقم موجب بخانتين عشريتين على الأكثر (تُقبل الأرقام العربية).",
    `• اختر المؤجر والعقار من القائمة؛ القوائم في ورقة «${LISTS_SHEET}» وتخص حسابك وقت تنزيل القالب.`,
    input.mode === "legacy"
      ? "• المؤجر والعقار مطلوبان، والعقار يجب أن يتبع المؤجر المختار."
      : "• المؤجر والعقار اختياريان (مصروف عام للمكتب)، وإن ذُكرا معاً فيجب أن يتبع العقار المؤجر.",
    ...(input.mode === "v2" ? [
      "• نوع الضريبة: خاضعة 15% / صفرية / معفاة / خارج النطاق (الافتراضي: خارج النطاق).",
      "• طريقة المبلغ: شامل الضريبة (الافتراضي) أو غير شامل الضريبة.",
      "• يتحمّلها: المكتب (الافتراضي) أو المؤجر — التحميل على المؤجر لمؤجري الوكالة في وضع المدير فقط.",
    ] : []),
    "• ارفع الملف من «استيراد من إكسل» في تبويب المصروفات: تُفحص الصفوف أولاً، ولا يُستورد شيء حتى تصبح كل الصفوف سليمة.",
  ];
  lines.forEach((l, i) => {
    const c = help.getCell(i + 1, 1);
    c.value = l;
    c.alignment = { wrapText: true, vertical: "top" };
    if (i === 0) c.font = { bold: true, size: 14, color: { argb: COBALT } };
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
