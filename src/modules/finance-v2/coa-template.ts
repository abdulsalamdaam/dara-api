/**
 * The chart-of-accounts template (DESIGN §3): a SOCPA-style four-digit chart
 * for a Saudi property manager or landlord, seeded per account on the first
 * enable of `finance_v2` (§1.5) by `ChartService.seedChart`.
 *
 * This list is the design's §3 table verbatim (116 accounts, 30 groups);
 * `coa-template.spec.ts` holds it to that count and checks the hierarchy.
 * Contra accounts (1124, 1213, 1229, 1239) carry a normal balance opposite
 * to their type. Groups (`isGroup`) never take postings.
 */
export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";
export type NormalBalance = "debit" | "credit";

export interface TemplateAccount {
  code: string;
  nameAr: string;
  nameEn: string;
  type: AccountType;
  normalBalance: NormalBalance;
  /** Parent code, or null for the five roots. */
  parent: string | null;
  /** Stable handle the posting engine resolves; null for accounts it never posts to. */
  systemKey: string | null;
  isGroup: boolean;
}

export const COA_TEMPLATE: readonly TemplateAccount[] = [
  { code: "1000", nameAr: "الأصول", nameEn: "Assets", type: "asset", normalBalance: "debit", parent: null, systemKey: null, isGroup: true },
  { code: "1100", nameAr: "الأصول المتداولة", nameEn: "Current assets", type: "asset", normalBalance: "debit", parent: "1000", systemKey: null, isGroup: true },
  { code: "1110", nameAr: "النقد وما في حكمه", nameEn: "Cash and cash equivalents", type: "asset", normalBalance: "debit", parent: "1100", systemKey: null, isGroup: true },
  { code: "1111", nameAr: "الصندوق الرئيسي", nameEn: "Main cash box", type: "asset", normalBalance: "debit", parent: "1110", systemKey: "cash", isGroup: false },
  { code: "1112", nameAr: "العُهد النقدية", nameEn: "Petty cash", type: "asset", normalBalance: "debit", parent: "1110", systemKey: "petty_cash", isGroup: false },
  { code: "1113", nameAr: "الحساب البنكي الرئيسي", nameEn: "Main bank account", type: "asset", normalBalance: "debit", parent: "1110", systemKey: "bank_default", isGroup: false },
  { code: "1114", nameAr: "حساب أموال العملاء (أمانات)", nameEn: "Client money (trust) bank account", type: "asset", normalBalance: "debit", parent: "1110", systemKey: "trust_bank", isGroup: false },
  { code: "1115", nameAr: "شيكات تحت التحصيل", nameEn: "Cheques under collection", type: "asset", normalBalance: "debit", parent: "1110", systemKey: "cheques_under_collection", isGroup: false },
  { code: "1116", nameAr: "نقدية في الطريق", nameEn: "Cash in transit", type: "asset", normalBalance: "debit", parent: "1110", systemKey: "cash_in_transit", isGroup: false },
  { code: "1120", nameAr: "الذمم المدينة", nameEn: "Receivables", type: "asset", normalBalance: "debit", parent: "1100", systemKey: null, isGroup: true },
  { code: "1121", nameAr: "ذمم المستأجرين", nameEn: "Tenant receivables", type: "asset", normalBalance: "debit", parent: "1120", systemKey: "tenant_receivable", isGroup: false },
  { code: "1122", nameAr: "ذمم المستأجرين – عقارات مُدارة لحساب الملاك", nameEn: "Tenant receivables – managed for landlords", type: "asset", normalBalance: "debit", parent: "1120", systemKey: "tenant_receivable_agency", isGroup: false },
  { code: "1123", nameAr: "ذمم الملاك المدينة", nameEn: "Due from landlords", type: "asset", normalBalance: "debit", parent: "1120", systemKey: "landlord_receivable", isGroup: false },
  { code: "1124", nameAr: "مخصص الخسائر الائتمانية المتوقعة", nameEn: "Allowance for expected credit losses (contra)", type: "asset", normalBalance: "credit", parent: "1120", systemKey: "ecl_allowance", isGroup: false },
  { code: "1125", nameAr: "سلف وعُهد الموظفين", nameEn: "Employee advances", type: "asset", normalBalance: "debit", parent: "1120", systemKey: "employee_advances", isGroup: false },
  { code: "1126", nameAr: "ذمم مدينة أخرى", nameEn: "Other receivables", type: "asset", normalBalance: "debit", parent: "1120", systemKey: "other_receivables", isGroup: false },
  { code: "1130", nameAr: "المدفوعات المقدمة والتأمينات", nameEn: "Prepayments and deposits paid", type: "asset", normalBalance: "debit", parent: "1100", systemKey: null, isGroup: true },
  { code: "1131", nameAr: "مصروفات مدفوعة مقدماً", nameEn: "Prepaid expenses", type: "asset", normalBalance: "debit", parent: "1130", systemKey: "prepaid_expenses", isGroup: false },
  { code: "1132", nameAr: "دفعات مقدمة للموردين", nameEn: "Advances to suppliers", type: "asset", normalBalance: "debit", parent: "1130", systemKey: "supplier_advances", isGroup: false },
  { code: "1133", nameAr: "تأمينات مستردة لدى الغير", nameEn: "Refundable deposits paid (utilities, etc.)", type: "asset", normalBalance: "debit", parent: "1130", systemKey: "deposits_paid", isGroup: false },
  { code: "1150", nameAr: "ضريبة القيمة المضافة المدينة", nameEn: "VAT receivable", type: "asset", normalBalance: "debit", parent: "1100", systemKey: null, isGroup: true },
  { code: "1151", nameAr: "ضريبة القيمة المضافة – المدخلات", nameEn: "Input VAT", type: "asset", normalBalance: "debit", parent: "1150", systemKey: "input_vat", isGroup: false },
  { code: "1152", nameAr: "ضريبة القيمة المضافة المستردة من الهيئة", nameEn: "VAT refundable from ZATCA", type: "asset", normalBalance: "debit", parent: "1150", systemKey: "vat_refundable", isGroup: false },
  { code: "1200", nameAr: "الأصول غير المتداولة", nameEn: "Non-current assets", type: "asset", normalBalance: "debit", parent: "1000", systemKey: null, isGroup: true },
  { code: "1210", nameAr: "العقارات الاستثمارية", nameEn: "Investment property", type: "asset", normalBalance: "debit", parent: "1200", systemKey: null, isGroup: true },
  { code: "1211", nameAr: "أراضٍ", nameEn: "Land", type: "asset", normalBalance: "debit", parent: "1210", systemKey: "investment_land", isGroup: false },
  { code: "1212", nameAr: "مبانٍ", nameEn: "Buildings", type: "asset", normalBalance: "debit", parent: "1210", systemKey: "investment_buildings", isGroup: false },
  { code: "1213", nameAr: "مجمع إهلاك المباني", nameEn: "Accumulated depreciation – buildings (contra)", type: "asset", normalBalance: "credit", parent: "1210", systemKey: "investment_accum_dep", isGroup: false },
  { code: "1220", nameAr: "الممتلكات والمعدات", nameEn: "Property and equipment", type: "asset", normalBalance: "debit", parent: "1200", systemKey: null, isGroup: true },
  { code: "1221", nameAr: "الأثاث والتجهيزات", nameEn: "Furniture and fixtures", type: "asset", normalBalance: "debit", parent: "1220", systemKey: null, isGroup: false },
  { code: "1222", nameAr: "أجهزة الحاسب الآلي", nameEn: "Computer equipment", type: "asset", normalBalance: "debit", parent: "1220", systemKey: null, isGroup: false },
  { code: "1223", nameAr: "السيارات", nameEn: "Vehicles", type: "asset", normalBalance: "debit", parent: "1220", systemKey: null, isGroup: false },
  { code: "1229", nameAr: "مجمع إهلاك الممتلكات والمعدات", nameEn: "Accumulated depreciation – equipment (contra)", type: "asset", normalBalance: "credit", parent: "1220", systemKey: null, isGroup: false },
  { code: "1230", nameAr: "الأصول غير الملموسة", nameEn: "Intangible assets", type: "asset", normalBalance: "debit", parent: "1200", systemKey: null, isGroup: true },
  { code: "1231", nameAr: "البرامج والأنظمة", nameEn: "Software", type: "asset", normalBalance: "debit", parent: "1230", systemKey: null, isGroup: false },
  { code: "1239", nameAr: "مجمع الإطفاء", nameEn: "Accumulated amortisation (contra)", type: "asset", normalBalance: "credit", parent: "1230", systemKey: null, isGroup: false },
  { code: "2000", nameAr: "الخصوم", nameEn: "Liabilities", type: "liability", normalBalance: "credit", parent: null, systemKey: null, isGroup: true },
  { code: "2100", nameAr: "الخصوم المتداولة", nameEn: "Current liabilities", type: "liability", normalBalance: "credit", parent: "2000", systemKey: null, isGroup: true },
  { code: "2110", nameAr: "الذمم الدائنة والمستحقات", nameEn: "Payables and accruals", type: "liability", normalBalance: "credit", parent: "2100", systemKey: null, isGroup: true },
  { code: "2111", nameAr: "الموردون", nameEn: "Accounts payable – suppliers", type: "liability", normalBalance: "credit", parent: "2110", systemKey: "accounts_payable", isGroup: false },
  { code: "2112", nameAr: "مصروفات مستحقة", nameEn: "Accrued expenses", type: "liability", normalBalance: "credit", parent: "2110", systemKey: "accrued_expenses", isGroup: false },
  { code: "2120", nameAr: "مستحقات الملاك", nameEn: "Landlord balances", type: "liability", normalBalance: "credit", parent: "2100", systemKey: null, isGroup: true },
  { code: "2121", nameAr: "مستحقات الملاك – إيجارات محصّلة", nameEn: "Landlord payable – collected rent", type: "liability", normalBalance: "credit", parent: "2120", systemKey: "landlord_payable", isGroup: false },
  { code: "2122", nameAr: "حصة الملاك من إيجارات غير محصّلة", nameEn: "Landlord share of uncollected rent", type: "liability", normalBalance: "credit", parent: "2120", systemKey: "landlord_payable_uncollected", isGroup: false },
  { code: "2130", nameAr: "إيرادات مقدمة", nameEn: "Deferred income", type: "liability", normalBalance: "credit", parent: "2100", systemKey: null, isGroup: true },
  { code: "2131", nameAr: "إيرادات إيجار مقدمة (غير مكتسبة)", nameEn: "Unearned rent", type: "liability", normalBalance: "credit", parent: "2130", systemKey: "unearned_rent", isGroup: false },
  { code: "2140", nameAr: "التأمينات المحتفظ بها", nameEn: "Deposits held", type: "liability", normalBalance: "credit", parent: "2100", systemKey: null, isGroup: true },
  { code: "2141", nameAr: "تأمينات المستأجرين", nameEn: "Tenant security deposits held", type: "liability", normalBalance: "credit", parent: "2140", systemKey: "deposits_held", isGroup: false },
  { code: "2150", nameAr: "الضرائب والزكاة", nameEn: "Taxes and zakat", type: "liability", normalBalance: "credit", parent: "2100", systemKey: null, isGroup: true },
  { code: "2151", nameAr: "ضريبة القيمة المضافة – المخرجات", nameEn: "Output VAT", type: "liability", normalBalance: "credit", parent: "2150", systemKey: "output_vat", isGroup: false },
  { code: "2152", nameAr: "تسوية ضريبة القيمة المضافة (مستحقة للهيئة)", nameEn: "VAT settlement (payable to ZATCA)", type: "liability", normalBalance: "credit", parent: "2150", systemKey: "vat_settlement", isGroup: false },
  { code: "2153", nameAr: "ضريبة الاستقطاع المستحقة", nameEn: "Withholding tax payable", type: "liability", normalBalance: "credit", parent: "2150", systemKey: "wht_payable", isGroup: false },
  { code: "2154", nameAr: "الزكاة المستحقة", nameEn: "Zakat payable", type: "liability", normalBalance: "credit", parent: "2150", systemKey: "zakat_payable", isGroup: false },
  { code: "2160", nameAr: "مستحقات الموظفين", nameEn: "Employee liabilities", type: "liability", normalBalance: "credit", parent: "2100", systemKey: null, isGroup: true },
  { code: "2161", nameAr: "رواتب مستحقة", nameEn: "Accrued salaries", type: "liability", normalBalance: "credit", parent: "2160", systemKey: null, isGroup: false },
  { code: "2162", nameAr: "التأمينات الاجتماعية المستحقة", nameEn: "GOSI payable", type: "liability", normalBalance: "credit", parent: "2160", systemKey: null, isGroup: false },
  { code: "2170", nameAr: "مستحق لأطراف ذات علاقة", nameEn: "Due to related parties", type: "liability", normalBalance: "credit", parent: "2100", systemKey: null, isGroup: false },
  { code: "2180", nameAr: "قروض قصيرة الأجل", nameEn: "Short-term borrowings", type: "liability", normalBalance: "credit", parent: "2100", systemKey: null, isGroup: false },
  { code: "2300", nameAr: "الخصوم غير المتداولة", nameEn: "Non-current liabilities", type: "liability", normalBalance: "credit", parent: "2000", systemKey: null, isGroup: true },
  { code: "2310", nameAr: "مخصص مكافأة نهاية الخدمة", nameEn: "End-of-service benefits provision", type: "liability", normalBalance: "credit", parent: "2300", systemKey: "eosb_provision", isGroup: false },
  { code: "2320", nameAr: "قروض طويلة الأجل", nameEn: "Long-term borrowings", type: "liability", normalBalance: "credit", parent: "2300", systemKey: null, isGroup: false },
  { code: "3000", nameAr: "حقوق الملكية", nameEn: "Equity", type: "equity", normalBalance: "credit", parent: null, systemKey: null, isGroup: true },
  { code: "3100", nameAr: "رأس المال", nameEn: "Capital", type: "equity", normalBalance: "credit", parent: "3000", systemKey: "capital", isGroup: false },
  { code: "3200", nameAr: "الاحتياطيات", nameEn: "Reserves", type: "equity", normalBalance: "credit", parent: "3000", systemKey: "reserves", isGroup: false },
  { code: "3300", nameAr: "الأرباح المبقاة", nameEn: "Retained earnings", type: "equity", normalBalance: "credit", parent: "3000", systemKey: "retained_earnings", isGroup: false },
  { code: "3400", nameAr: "جاري المالك / المسحوبات", nameEn: "Owner's current account / drawings", type: "equity", normalBalance: "credit", parent: "3000", systemKey: "owner_drawings", isGroup: false },
  { code: "3900", nameAr: "حساب الأرصدة الافتتاحية", nameEn: "Opening balance equity", type: "equity", normalBalance: "credit", parent: "3000", systemKey: "opening_balance_equity", isGroup: false },
  { code: "4000", nameAr: "الإيرادات", nameEn: "Revenue", type: "revenue", normalBalance: "credit", parent: null, systemKey: null, isGroup: true },
  { code: "4100", nameAr: "إيرادات الإيجار", nameEn: "Rental revenue", type: "revenue", normalBalance: "credit", parent: "4000", systemKey: null, isGroup: true },
  { code: "4110", nameAr: "إيرادات إيجار سكني", nameEn: "Residential rent revenue", type: "revenue", normalBalance: "credit", parent: "4100", systemKey: "rent_revenue_residential", isGroup: false },
  { code: "4120", nameAr: "إيرادات إيجار تجاري", nameEn: "Commercial rent revenue", type: "revenue", normalBalance: "credit", parent: "4100", systemKey: "rent_revenue_commercial", isGroup: false },
  { code: "4130", nameAr: "إيرادات رسوم الخدمات", nameEn: "Service charge revenue", type: "revenue", normalBalance: "credit", parent: "4100", systemKey: "service_charge_revenue", isGroup: false },
  { code: "4140", nameAr: "إيرادات أخرى من المستأجرين", nameEn: "Other tenant charges", type: "revenue", normalBalance: "credit", parent: "4100", systemKey: "other_tenant_revenue", isGroup: false },
  { code: "4200", nameAr: "إيرادات إدارة الأملاك والوساطة", nameEn: "Property management and brokerage revenue", type: "revenue", normalBalance: "credit", parent: "4000", systemKey: null, isGroup: true },
  { code: "4210", nameAr: "إيرادات عمولة إدارة الأملاك", nameEn: "Management commission revenue", type: "revenue", normalBalance: "credit", parent: "4200", systemKey: "commission_revenue", isGroup: false },
  { code: "4220", nameAr: "إيرادات أتعاب الوساطة (السعي)", nameEn: "Brokerage (agency) fee revenue", type: "revenue", normalBalance: "credit", parent: "4200", systemKey: "agency_fee_revenue", isGroup: false },
  { code: "4300", nameAr: "إيرادات تشغيلية أخرى", nameEn: "Other operating income", type: "revenue", normalBalance: "credit", parent: "4000", systemKey: null, isGroup: true },
  { code: "4310", nameAr: "إيرادات تأمينات مُصادرة", nameEn: "Forfeited deposit income", type: "revenue", normalBalance: "credit", parent: "4300", systemKey: "deposit_forfeit_revenue", isGroup: false },
  { code: "4320", nameAr: "غرامات التأخير", nameEn: "Late payment charges", type: "revenue", normalBalance: "credit", parent: "4300", systemKey: "late_fee_revenue", isGroup: false },
  { code: "4390", nameAr: "إيرادات متنوعة", nameEn: "Miscellaneous income", type: "revenue", normalBalance: "credit", parent: "4300", systemKey: "misc_revenue", isGroup: false },
  { code: "4400", nameAr: "إيرادات غير تشغيلية", nameEn: "Non-operating income", type: "revenue", normalBalance: "credit", parent: "4000", systemKey: null, isGroup: true },
  { code: "4410", nameAr: "عوائد الودائع البنكية", nameEn: "Bank deposit returns", type: "revenue", normalBalance: "credit", parent: "4400", systemKey: null, isGroup: false },
  { code: "4420", nameAr: "أرباح بيع أصول", nameEn: "Gain on disposal of assets", type: "revenue", normalBalance: "credit", parent: "4400", systemKey: null, isGroup: false },
  { code: "5000", nameAr: "المصروفات", nameEn: "Expenses", type: "expense", normalBalance: "debit", parent: null, systemKey: null, isGroup: true },
  { code: "5100", nameAr: "مصروفات تشغيل العقارات", nameEn: "Property operating expenses", type: "expense", normalBalance: "debit", parent: "5000", systemKey: null, isGroup: true },
  { code: "5110", nameAr: "الصيانة والإصلاحات", nameEn: "Maintenance and repairs", type: "expense", normalBalance: "debit", parent: "5100", systemKey: "expense_maintenance", isGroup: false },
  { code: "5120", nameAr: "الكهرباء والمياه", nameEn: "Electricity and water", type: "expense", normalBalance: "debit", parent: "5100", systemKey: "expense_utilities", isGroup: false },
  { code: "5130", nameAr: "النظافة", nameEn: "Cleaning", type: "expense", normalBalance: "debit", parent: "5100", systemKey: "expense_cleaning", isGroup: false },
  { code: "5140", nameAr: "الحراسة والأمن", nameEn: "Security and guarding", type: "expense", normalBalance: "debit", parent: "5100", systemKey: "expense_security", isGroup: false },
  { code: "5150", nameAr: "التأمين على العقارات", nameEn: "Property insurance", type: "expense", normalBalance: "debit", parent: "5100", systemKey: "expense_insurance", isGroup: false },
  { code: "5160", nameAr: "أتعاب إدارة مدفوعة للغير", nameEn: "Management fees paid to third parties", type: "expense", normalBalance: "debit", parent: "5100", systemKey: "expense_management_fees", isGroup: false },
  { code: "5170", nameAr: "رسوم حكومية وبلدية وتراخيص", nameEn: "Government, municipal and licence fees", type: "expense", normalBalance: "debit", parent: "5100", systemKey: "expense_government_fees", isGroup: false },
  { code: "5180", nameAr: "رسوم منصة إيجار", nameEn: "Ejar platform fees", type: "expense", normalBalance: "debit", parent: "5100", systemKey: "expense_ejar_fees", isGroup: false },
  { code: "5190", nameAr: "مصروفات عقارات أخرى", nameEn: "Other property expenses", type: "expense", normalBalance: "debit", parent: "5100", systemKey: "expense_property_other", isGroup: false },
  { code: "5200", nameAr: "المصروفات العمومية والإدارية", nameEn: "General and administrative expenses", type: "expense", normalBalance: "debit", parent: "5000", systemKey: null, isGroup: true },
  { code: "5210", nameAr: "الرواتب والأجور", nameEn: "Salaries and wages", type: "expense", normalBalance: "debit", parent: "5200", systemKey: null, isGroup: false },
  { code: "5211", nameAr: "التأمينات الاجتماعية", nameEn: "GOSI contributions", type: "expense", normalBalance: "debit", parent: "5200", systemKey: null, isGroup: false },
  { code: "5212", nameAr: "مكافأة نهاية الخدمة", nameEn: "End-of-service benefits expense", type: "expense", normalBalance: "debit", parent: "5200", systemKey: null, isGroup: false },
  { code: "5213", nameAr: "رسوم الإقامات والتأشيرات ومكتب العمل", nameEn: "Iqama, visa and labour-office fees", type: "expense", normalBalance: "debit", parent: "5200", systemKey: null, isGroup: false },
  { code: "5220", nameAr: "إيجار المكتب", nameEn: "Office rent", type: "expense", normalBalance: "debit", parent: "5200", systemKey: null, isGroup: false },
  { code: "5230", nameAr: "الاتصالات والإنترنت", nameEn: "Telecom and internet", type: "expense", normalBalance: "debit", parent: "5200", systemKey: null, isGroup: false },
  { code: "5240", nameAr: "اشتراكات البرامج", nameEn: "Software subscriptions", type: "expense", normalBalance: "debit", parent: "5200", systemKey: "expense_software", isGroup: false },
  { code: "5250", nameAr: "الأتعاب المهنية", nameEn: "Professional fees", type: "expense", normalBalance: "debit", parent: "5200", systemKey: null, isGroup: false },
  { code: "5260", nameAr: "التسويق والإعلان", nameEn: "Marketing and advertising", type: "expense", normalBalance: "debit", parent: "5200", systemKey: null, isGroup: false },
  { code: "5270", nameAr: "العمولات والرسوم البنكية", nameEn: "Bank charges", type: "expense", normalBalance: "debit", parent: "5200", systemKey: "bank_charges", isGroup: false },
  { code: "5280", nameAr: "القرطاسية والمطبوعات", nameEn: "Stationery and printing", type: "expense", normalBalance: "debit", parent: "5200", systemKey: null, isGroup: false },
  { code: "5290", nameAr: "مصروفات عمومية أخرى", nameEn: "Other general expenses", type: "expense", normalBalance: "debit", parent: "5200", systemKey: "expense_general_other", isGroup: false },
  { code: "5300", nameAr: "الإهلاك والمخصصات", nameEn: "Depreciation and impairment", type: "expense", normalBalance: "debit", parent: "5000", systemKey: null, isGroup: true },
  { code: "5310", nameAr: "إهلاك العقارات الاستثمارية", nameEn: "Depreciation – investment property", type: "expense", normalBalance: "debit", parent: "5300", systemKey: null, isGroup: false },
  { code: "5320", nameAr: "إهلاك الممتلكات والمعدات", nameEn: "Depreciation – property and equipment", type: "expense", normalBalance: "debit", parent: "5300", systemKey: null, isGroup: false },
  { code: "5330", nameAr: "الخسائر الائتمانية المتوقعة والديون المعدومة", nameEn: "Expected credit losses and bad debts", type: "expense", normalBalance: "debit", parent: "5300", systemKey: "bad_debt_expense", isGroup: false },
  { code: "5400", nameAr: "تكاليف التمويل", nameEn: "Finance costs", type: "expense", normalBalance: "debit", parent: "5000", systemKey: null, isGroup: false },
  { code: "5500", nameAr: "ضريبة القيمة المضافة غير القابلة للاسترداد", nameEn: "Non-recoverable VAT", type: "expense", normalBalance: "debit", parent: "5000", systemKey: "vat_non_recoverable", isGroup: false },
  { code: "5600", nameAr: "الزكاة وضريبة الدخل", nameEn: "Zakat and income tax", type: "expense", normalBalance: "debit", parent: "5000", systemKey: null, isGroup: true },
  { code: "5610", nameAr: "مصروف الزكاة", nameEn: "Zakat expense", type: "expense", normalBalance: "debit", parent: "5600", systemKey: "zakat_expense", isGroup: false },
  { code: "5620", nameAr: "مصروف ضريبة الدخل", nameEn: "Income tax expense", type: "expense", normalBalance: "debit", parent: "5600", systemKey: null, isGroup: false },];

/** System keys every flag-on account must be able to resolve. */
export const REQUIRED_SYSTEM_KEYS = [
  "cash", "bank_default", "trust_bank", "tenant_receivable", "tenant_receivable_agency",
  "landlord_receivable", "input_vat", "landlord_payable", "landlord_payable_uncollected",
  "unearned_rent", "deposits_held", "output_vat", "vat_settlement", "retained_earnings",
  "owner_drawings", "opening_balance_equity", "rent_revenue_residential", "rent_revenue_commercial",
  "service_charge_revenue", "other_tenant_revenue", "commission_revenue", "agency_fee_revenue",
  "deposit_forfeit_revenue", "bad_debt_expense", "vat_non_recoverable", "expense_property_other",
  "expense_general_other",
] as const;
