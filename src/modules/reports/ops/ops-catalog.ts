/**
 * The operational-report catalog (`GET /reports/ops`). Ids are fixed by the
 * shared contract; the web keys on them.
 */
import type { DateDefault, OpsReportId, OpsReportMeta, OpsParams } from "./ops-core";
import { addMonthsFirst, firstOfMonth, lastOfMonth } from "./ops-core";

type Def = Omit<OpsReportMeta, "defaults"> & { dates: DateDefault; statuses?: readonly string[]; days?: boolean };

export const INST_STATUSES = ["paid", "partial", "pending", "overdue", "cancelled"] as const;
export const CONTRACT_STATUSES = ["active", "expired", "terminated", "cancelled", "pending"] as const;
export const MAINT_STATUSES = ["open", "in_progress", "pending_approval", "completed"] as const;

export const OPS_DEFS: Def[] = [
  {
    id: "tenant_balances", category: "people", dates: "none",
    label: { ar: "أرصدة المستأجرين", en: "Tenant balances" },
    description: { ar: "لكل مستأجر: المستحق حتى التاريخ، المحصّل، المتبقي والمتأخر", en: "Per tenant: billed to date, collected, outstanding and overdue" },
    filters: ["asOf", "ownerId", "propertyId"],
  },
  {
    id: "defaulting_tenants", category: "people", dates: "none",
    label: { ar: "المستأجرون المتعثرون", en: "Defaulting tenants" },
    description: { ar: "المستأجرون الذين لديهم أقساط متأخرة مع أعمار الديون", en: "Tenants with overdue installments, with aging" },
    filters: ["asOf", "ownerId", "propertyId"],
  },
  {
    id: "tenant_payment_behavior", category: "people", dates: "last12",
    label: { ar: "سلوك السداد", en: "Payment behavior" },
    description: { ar: "نسبة السداد في الموعد ومتوسط أيام التأخير لكل مستأجر", en: "On-time rate and average days late per tenant" },
    filters: ["from", "to", "ownerId", "propertyId"],
  },
  {
    id: "landlord_portfolio", category: "people", dates: "last12",
    label: { ar: "محافظ المؤجرين", en: "Landlord portfolio" },
    description: { ar: "لكل مؤجر: العقارات والوحدات والإشغال والإيجار والتحصيل", en: "Per landlord: properties, units, occupancy, rent and collection" },
    filters: ["from", "to", "ownerId", "propertyId"],
  },
  {
    id: "vacant_units", category: "properties", dates: "none",
    label: { ar: "الوحدات الشاغرة", en: "Vacant units" },
    description: { ar: "الوحدات غير المؤجرة بعقد سارٍ ومدة شغورها", en: "Units not under an active contract and how long they have been vacant" },
    filters: ["asOf", "ownerId", "propertyId"],
  },
  {
    id: "property_performance", category: "properties", dates: "last12",
    label: { ar: "أداء العقارات", en: "Property performance" },
    description: { ar: "الإشغال والإيجار المتعاقد عليه والتحصيل لكل عقار", en: "Occupancy, contracted rent and collection per property" },
    filters: ["from", "to", "asOf", "ownerId", "propertyId"],
  },
  {
    id: "occupancy_trend", category: "properties", dates: "last12",
    label: { ar: "اتجاه الإشغال", en: "Occupancy trend" },
    description: { ar: "نسبة الإشغال شهراً بشهر", en: "Occupancy month by month" },
    filters: ["from", "to", "ownerId", "propertyId"],
  },
  {
    id: "contracts_report", category: "contracts", dates: "none", statuses: CONTRACT_STATUSES,
    label: { ar: "تقرير العقود", en: "Contracts report" },
    description: { ar: "العقود مع حالتها والإيجار السنوي والأيام المتبقية", en: "Contracts with status, annual rent and days remaining" },
    filters: ["status", "asOf", "from", "to", "ownerId", "propertyId"],
  },
  {
    id: "expiring_contracts", category: "contracts", dates: "none", days: true,
    label: { ar: "العقود القريبة من الانتهاء", en: "Expiring contracts" },
    description: { ar: "العقود السارية التي تنتهي خلال المدة المحددة", en: "Active contracts ending within the chosen window" },
    filters: ["asOf", "days", "ownerId", "propertyId"],
  },
  {
    id: "contract_movement", category: "contracts", dates: "last12",
    label: { ar: "حركة العقود", en: "Contract movement" },
    description: { ar: "العقود الجديدة والمنتهية والمفسوخة شهرياً", en: "New, expired and terminated contracts per month" },
    filters: ["from", "to", "ownerId", "propertyId"],
  },
  {
    id: "collections_summary", category: "collections", dates: "last12",
    label: { ar: "ملخص التحصيل", en: "Collections summary" },
    description: { ar: "المستحق والمحصّل والمتبقي ونسبة التحصيل شهرياً", en: "Due, collected, outstanding and collection rate per month" },
    filters: ["from", "to", "ownerId", "propertyId"],
  },
  {
    id: "installments_schedule", category: "collections", dates: "thisMonth", statuses: INST_STATUSES,
    label: { ar: "جدول الأقساط", en: "Installments schedule" },
    description: { ar: "الأقساط المستحقة في الفترة مع حالتها الفعلية", en: "Installments due in the period with their live status" },
    filters: ["from", "to", "status", "ownerId", "propertyId"],
  },
  {
    id: "maintenance_requests", category: "operations", dates: "last12", statuses: MAINT_STATUSES,
    label: { ar: "طلبات الصيانة", en: "Maintenance requests" },
    description: { ar: "طلبات الصيانة في الفترة وحالتها ومدة معالجتها", en: "Maintenance requests in the period, status and time to resolve" },
    filters: ["from", "to", "status", "ownerId", "propertyId"],
  },
  {
    id: "data_quality", category: "operations", dates: "none",
    label: { ar: "جودة البيانات", en: "Data quality" },
    description: { ar: "السجلات الناقصة لبيانات أساسية", en: "Records missing critical data" },
    filters: ["ownerId", "propertyId"],
  },
];

export const OPS_IDS = new Set<OpsReportId>(OPS_DEFS.map((d) => d.id));
export const defOf = (id: string) => OPS_DEFS.find((d) => d.id === id);

export function catalog(today: string): { reports: OpsReportMeta[] } {
  return {
    reports: OPS_DEFS.map(({ dates, statuses, days, ...meta }) => {
      const defaults: Partial<OpsParams> = {};
      if (meta.filters.includes("asOf")) defaults.asOf = today;
      if (dates === "last12") { defaults.from = addMonthsFirst(today, -11); defaults.to = today; }
      if (dates === "thisMonth") { defaults.from = firstOfMonth(today); defaults.to = lastOfMonth(today); }
      if (days) defaults.days = 90;
      void statuses;
      return { ...meta, defaults };
    }),
  };
}
