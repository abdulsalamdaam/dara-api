/**
 * Operational reports — one pure builder per report id. Each takes the scoped
 * dataset (ops-data.ts) and the resolved params, and returns the report body.
 *
 * Shared definitions (every report that shows the figure uses the same one):
 *  - billed / due        Σ amount of non-cancelled installments in the window
 *  - collected           money in against THOSE installments (capped at each
 *                        installment's amount); a row stored paid/settled
 *                        without collection rows counts as fully collected
 *  - outstanding         billed − collected (per installment, never negative)
 *  - overdue             outstanding on installments whose due date is before
 *                        the reference day (Riyadh), incl. partly-paid ones
 *  - rented / occupied   a unit covered by a contract in force on the day
 *  - deposits are not installments; draft contracts are not leases
 */
import {
  type ContractLike, type Installment, type Lbl, type OpsChart, type OpsColumn, type OpsKpi, type OpsReport, type OpsReportId,
  type OpsRow, type ResolvedParams, type Tone, type Unit,
  EPS, agingBucket, collectedOf, completionDate, contractStatusAt, daysBetween, daysOverdue, expiryBucket, inForceOn,
  instStatus, monthLabel, monthsIn, occupancyDay, occupiedUnits, pct, remainingOf, round1, round2, addDays, moneyEvents,
  LEASE_STATUSES,
} from "./ops-core";
import type { DsContract, OpsDataset } from "./ops-data";
import { CONTRACT_STATUSES, INST_STATUSES, MAINT_STATUSES } from "./ops-catalog";

export type Body = Omit<OpsReport, "id" | "params" | "generatedAt">;

/* ── shared labels ──────────────────────────────────────────────────────── */

const C = { cobalt: "#042698", sky: "#20bdef", good: "#16a34a", bad: "#dc2626", warn: "#f59e0b", gray: "#94a3b8", midnight: "#010f35" };

export const INST_STATUS_MAP: Record<string, Lbl & { tone?: Tone }> = {
  paid: { ar: "مدفوع", en: "Paid", tone: "good" },
  partial: { ar: "مدفوع جزئياً", en: "Partially paid", tone: "warn" },
  pending: { ar: "قادم", en: "Upcoming", tone: "neutral" },
  overdue: { ar: "متأخر", en: "Overdue", tone: "bad" },
  cancelled: { ar: "ملغى", en: "Cancelled", tone: "neutral" },
};
export const CONTRACT_STATUS_MAP: Record<string, Lbl & { tone?: Tone }> = {
  active: { ar: "ساري", en: "Active", tone: "good" },
  upcoming: { ar: "لم يبدأ بعد", en: "Not started yet", tone: "brand" },
  expired: { ar: "منتهي", en: "Expired", tone: "warn" },
  terminated: { ar: "مفسوخ", en: "Terminated", tone: "bad" },
  cancelled: { ar: "ملغى", en: "Cancelled", tone: "neutral" },
  pending: { ar: "قيد الانتظار", en: "Pending", tone: "brand" },
};
const UNIT_STATUS_MAP: Record<string, Lbl & { tone?: Tone }> = {
  available: { ar: "متاحة", en: "Available", tone: "good" },
  rented: { ar: "مؤجرة (بلا عقد ساري)", en: "Rented (no active contract)", tone: "warn" },
  maintenance: { ar: "صيانة", en: "Maintenance", tone: "warn" },
  reserved: { ar: "محجوزة", en: "Reserved", tone: "brand" },
};
const AGING_MAP: Record<string, Lbl & { tone?: Tone }> = {
  d1_30: { ar: "1–30 يوم", en: "1–30 days", tone: "warn" },
  d31_60: { ar: "31–60 يوم", en: "31–60 days", tone: "warn" },
  d61_90: { ar: "61–90 يوم", en: "61–90 days", tone: "bad" },
  d90_plus: { ar: "أكثر من 90 يوم", en: "90+ days", tone: "bad" },
};
const EXPIRY_MAP: Record<string, Lbl & { tone?: Tone }> = {
  d0_30: { ar: "0–30 يوم", en: "0–30 days", tone: "bad" },
  d31_60: { ar: "31–60 يوم", en: "31–60 days", tone: "warn" },
  d61_90: { ar: "61–90 يوم", en: "61–90 days", tone: "warn" },
  d90_plus: { ar: "أكثر من 90 يوم", en: "90+ days", tone: "neutral" },
};
const MAINT_STATUS_MAP: Record<string, Lbl & { tone?: Tone }> = {
  open: { ar: "مفتوح", en: "Open", tone: "bad" },
  in_progress: { ar: "قيد التنفيذ", en: "In progress", tone: "warn" },
  pending_approval: { ar: "بانتظار الموافقة", en: "Pending approval", tone: "brand" },
  completed: { ar: "مكتمل", en: "Completed", tone: "good" },
};
const PRIORITY_MAP: Record<string, Lbl & { tone?: Tone }> = {
  low: { ar: "منخفضة", en: "Low", tone: "neutral" },
  medium: { ar: "متوسطة", en: "Medium", tone: "warn" },
  high: { ar: "عالية", en: "High", tone: "bad" },
};
const FREQ: Record<string, Lbl> = {
  monthly: { ar: "شهري", en: "Monthly" }, quarterly: { ar: "ربع سنوي", en: "Quarterly" },
  semi_annual: { ar: "نصف سنوي", en: "Semi-annual" }, annual: { ar: "سنوي", en: "Annual" }, custom: { ar: "مخصص", en: "Custom" },
};
const ENTITY_MAP: Record<string, Lbl & { tone?: Tone }> = {
  contract: { ar: "عقد", en: "Contract", tone: "brand" },
  unit: { ar: "وحدة", en: "Unit", tone: "neutral" },
  tenant: { ar: "مستأجر", en: "Tenant", tone: "neutral" },
  property: { ar: "عقار", en: "Property", tone: "brand" },
  landlord: { ar: "مؤجر", en: "Landlord", tone: "neutral" },
};

const NOTE = {
  drafts: { ar: "العقود المسودة مستبعدة من جميع التقارير.", en: "Draft contracts are excluded from every report." },
  deposits: { ar: "مبالغ التأمين (الوديعة) ليست دفعاتاً ولا تدخل في المستحق أو المحصّل.", en: "Security deposits are not installments and are not counted as due or collected." },
  cancelled: { ar: "الدفعات الملغاة مستبعدة من المستحق والمتبقي.", en: "Cancelled installments are excluded from due and outstanding." },
  overdue: { ar: "المتأخر = المتبقي على دفعات تاريخ استحقاقها قبل اليوم المرجعي (توقيت الرياض)، ويشمل المدفوعة جزئياً.", en: "Overdue = the unpaid remainder of installments due before the reference day (Riyadh time), including partly-paid ones." },
  paidNoCollections: { ar: "الدفعة المسجّلة مدفوعة دون سندات تحصيل يُحسب محصّلاً بالكامل في تاريخ سداده.", en: "An installment marked paid without collection records counts as fully collected on its paid date." },
  dueBasis: { ar: "المحصّل = ما حُصّل حتى الآن مقابل الدفعات المستحقة في الفترة (وليس كل ما قُبض خلال الفترة).", en: "Collected = money received to date against the installments due in the period (not all cash received during it)." },
  occupancy: { ar: "الوحدة مشغولة إذا غطّاها عقد ساري في ذلك اليوم؛ المقام = جميع الوحدات في النطاق دون استثناء.", en: "A unit is occupied when an in-force contract covers it that day; the denominator is every unit in scope, none excluded." },
  terminatedUnlinked: { ar: "العقد المفسوخ تُفك وحداته عند الفسخ، لذا لا يُنسب إلى عقار ولا يظهر عند التصفية بالعقار أو المؤجر.", en: "A terminated contract has its units unlinked at termination, so it cannot be attributed to a property and drops out under a property or landlord filter." },
  firstUnit: { ar: "العقد متعدد الوحدات يُنسب مالياً إلى عقار أول وحدة فيه (وعند التصفية: أول وحدة له ضمن التصفية).", en: "A multi-unit contract's money is attributed to the property of its first unit (under a filter, its first unit inside the filter)." },
  annual: { ar: "الإيجار السنوي = الإيجار الشهري × 12 قبل الزيادات.", en: "Annual rent = monthly rent × 12, before escalation." },
};

const col = (key: string, ar: string, en: string, type: OpsColumn["type"], statusMap?: OpsColumn["statusMap"]): OpsColumn =>
  statusMap ? { key, label: { ar, en }, type, statusMap } : { key, label: { ar, en }, type };
const kpi = (key: string, ar: string, en: string, value: number | null, unit: Unit, tone?: Tone): OpsKpi =>
  tone ? { key, label: { ar, en }, value: value ?? 0, unit, tone } : { key, label: { ar, en }, value: value ?? 0, unit };
const sum = (xs: number[]) => round2(xs.reduce((s, x) => s + x, 0));
const opts = (map: Record<string, Lbl>, keys: readonly string[]) => keys.map((k) => ({ value: k, label: { ar: map[k].ar, en: map[k].en } }));

/* ── shared lookups over the dataset ────────────────────────────────────── */

class Ctx {
  propById; unitById; ownerById; tenantById; instByContract;
  constructor(public ds: OpsDataset) {
    this.propById = new Map(ds.properties.map((p) => [p.id, p]));
    this.unitById = new Map(ds.units.map((u) => [u.id, u]));
    this.ownerById = new Map(ds.owners.map((o) => [o.id, o]));
    this.tenantById = new Map(ds.tenants.map((t) => [t.id, t]));
    this.instByContract = new Map<number, Installment[]>();
    for (const i of ds.installments) {
      const arr = this.instByContract.get(i.contractId) ?? [];
      arr.push(i);
      this.instByContract.set(i.contractId, arr);
    }
  }
  tenantKey(c: DsContract) { return c.tenantId != null ? `t:${c.tenantId}` : `n:${c.tenantName.trim()}`; }
  tenantName(c: DsContract) { return (c.tenantId != null ? this.tenantById.get(c.tenantId)?.name : null) || c.tenantName || "—"; }
  tenantPhone(c: DsContract) { return (c.tenantId != null ? this.tenantById.get(c.tenantId)?.phone : null) || c.tenantPhone || null; }
  propertyName(c: DsContract) { return c.propertyId != null ? this.propById.get(c.propertyId)?.name ?? "—" : "—"; }
  unitLabel(c: DsContract) {
    const nums = c.unitIds.map((u) => this.unitById.get(u)?.unitNumber).filter(Boolean);
    return nums.length ? nums.join("، ") : "—";
  }
  landlordName(c: DsContract) {
    const p = c.propertyId != null ? this.propById.get(c.propertyId) : undefined;
    const o = p?.ownerId != null ? this.ownerById.get(p.ownerId) : undefined;
    return o?.name || c.landlordName || "—";
  }
  insts(c: DsContract) { return this.instByContract.get(c.id) ?? []; }
  contractById = () => new Map(this.ds.contracts.map((c) => [c.id, c]));
}

/** Installments due in [from, to], cancelled excluded. */
const dueIn = (xs: Installment[], from: string, to: string) => xs.filter((i) => i.status !== "cancelled" && i.dueDate >= from && i.dueDate <= to);
type Money = { billed: number; collected: number; outstanding: number };
function money(xs: Installment[], asOf?: string): Money {
  const billed = sum(xs.filter((i) => i.status !== "cancelled").map((i) => i.amount));
  const collected = sum(xs.map((i) => collectedOf(i, asOf)));
  return { billed, collected, outstanding: round2(billed - collected) };
}

/* ── people ─────────────────────────────────────────────────────────────── */

function tenantBalances(ds: OpsDataset, p: ResolvedParams): Body {
  const x = new Ctx(ds);
  type R = { tenant: string; phone: string | null; activeContracts: number; billed: number; collected: number; outstanding: number; overdue: number; oldestOverdueDays: number };
  const rows = new Map<string, R>();
  for (const c of ds.contracts) {
    const k = x.tenantKey(c);
    const r = rows.get(k) ?? { tenant: x.tenantName(c), phone: x.tenantPhone(c), activeContracts: 0, billed: 0, collected: 0, outstanding: 0, overdue: 0, oldestOverdueDays: 0 };
    if (inForceOn(c, p.asOf)) r.activeContracts++;
    const billed = x.insts(c).filter((i) => i.status !== "cancelled" && i.dueDate <= p.asOf);
    const m = money(billed, p.asOf);
    r.billed = round2(r.billed + m.billed);
    r.collected = round2(r.collected + m.collected);
    r.outstanding = round2(r.outstanding + m.outstanding);
    for (const i of billed) {
      if (i.dueDate < p.asOf) r.overdue = round2(r.overdue + remainingOf(i, p.asOf));
      r.oldestOverdueDays = Math.max(r.oldestOverdueDays, daysOverdue(i, p.asOf));
    }
    if (!r.phone) r.phone = x.tenantPhone(c);
    rows.set(k, r);
  }
  const list = [...rows.values()].sort((a, b) => b.outstanding - a.outstanding || a.tenant.localeCompare(b.tenant));
  const out: OpsRow[] = list.map((r) => ({ ...r, oldestOverdueDays: r.oldestOverdueDays > 0 ? r.oldestOverdueDays : null }));
  const t = {
    activeContracts: list.reduce((s, r) => s + r.activeContracts, 0),
    billed: sum(list.map((r) => r.billed)), collected: sum(list.map((r) => r.collected)),
    outstanding: sum(list.map((r) => r.outstanding)), overdue: sum(list.map((r) => r.overdue)),
  };
  const top = list.filter((r) => r.outstanding > EPS).slice(0, 10);
  return {
    kpis: [
      kpi("tenants", "المستأجرون", "Tenants", list.length, "count", "brand"),
      kpi("billed", "المستحق حتى التاريخ", "Billed to date", t.billed, "sar", "neutral"),
      kpi("collected", "المحصّل", "Collected", t.collected, "sar", "good"),
      kpi("outstanding", "المتبقي", "Outstanding", t.outstanding, "sar", "warn"),
      kpi("overdue", "المتأخر", "Overdue", t.overdue, "sar", "bad"),
      kpi("collectionRate", "نسبة التحصيل", "Collection rate", pct(t.collected, t.billed), "pct", "brand"),
    ],
    charts: [{
      key: "top_outstanding", type: "hbar", unit: "sar",
      title: { ar: "أعلى المستأجرين رصيداً", en: "Highest outstanding balances" },
      series: [{ key: "outstanding", label: { ar: "المتبقي", en: "Outstanding" }, color: C.warn }, { key: "overdue", label: { ar: "المتأخر", en: "Overdue" }, color: C.bad }],
      data: top.map((r) => ({ label: r.tenant, outstanding: r.outstanding, overdue: r.overdue })),
    }],
    columns: [
      col("tenant", "المستأجر", "Tenant", "text"), col("phone", "الجوال", "Phone", "phone"),
      col("activeContracts", "العقود السارية", "Active contracts", "number"),
      col("billed", "المستحق حتى التاريخ", "Billed to date", "sar"), col("collected", "المحصّل", "Collected", "sar"),
      col("outstanding", "المتبقي", "Outstanding", "sar"), col("overdue", "المتأخر", "Overdue", "sar"),
      col("oldestOverdueDays", "أقدم تأخير (يوم)", "Oldest overdue (days)", "days"),
    ],
    rows: out, totals: t,
    notes: [
      { ar: "المستحق = الدفعات التي حلّ موعدها في التاريخ المرجعي أو قبله، والمحصّل = ما قُبض عليها حتى ذلك التاريخ.", en: "Billed = installments due on or before the as-of date; collected = money received against them by that date." },
      NOTE.overdue, NOTE.cancelled, NOTE.deposits, NOTE.paidNoCollections, NOTE.drafts,
    ],
  };
}

function defaultingTenants(ds: OpsDataset, p: ResolvedParams): Body {
  const x = new Ctx(ds);
  type R = { tenant: string; phone: string | null; overdueCount: number; overdueAmount: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number; maxDaysLate: number; lastPaymentDate: string | null };
  const rows = new Map<string, R>();
  const lastPay = new Map<string, string>();
  for (const c of ds.contracts) {
    const k = x.tenantKey(c);
    for (const i of x.insts(c)) {
      if (i.status === "cancelled") continue;
      for (const e of moneyEvents(i)) if (e.date <= p.asOf && e.amount > 0 && (!lastPay.has(k) || e.date > lastPay.get(k)!)) lastPay.set(k, e.date);
      const days = daysOverdue(i, p.asOf);
      const b = agingBucket(days);
      if (!b) continue;
      const amt = remainingOf(i, p.asOf);
      const r = rows.get(k) ?? { tenant: x.tenantName(c), phone: x.tenantPhone(c), overdueCount: 0, overdueAmount: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, maxDaysLate: 0, lastPaymentDate: null };
      r.overdueCount++;
      r.overdueAmount = round2(r.overdueAmount + amt);
      r[b] = round2(r[b] + amt);
      r.maxDaysLate = Math.max(r.maxDaysLate, days);
      rows.set(k, r);
    }
  }
  for (const [k, r] of rows) r.lastPaymentDate = lastPay.get(k) ?? null;
  const list = [...rows.values()].sort((a, b) => b.overdueAmount - a.overdueAmount || b.maxDaysLate - a.maxDaysLate);
  const t = {
    overdueCount: list.reduce((s, r) => s + r.overdueCount, 0), overdueAmount: sum(list.map((r) => r.overdueAmount)),
    d1_30: sum(list.map((r) => r.d1_30)), d31_60: sum(list.map((r) => r.d31_60)), d61_90: sum(list.map((r) => r.d61_90)), d90_plus: sum(list.map((r) => r.d90_plus)),
  };
  const bucketCount = (b: string) => list.filter((r) => (r as any)[b] > EPS).length;
  return {
    kpis: [
      kpi("tenants", "مستأجرون متعثرون", "Defaulting tenants", list.length, "count", "bad"),
      kpi("overdueAmount", "إجمالي المتأخر", "Total overdue", t.overdueAmount, "sar", "bad"),
      kpi("overdueCount", "دفعات متأخرة", "Overdue installments", t.overdueCount, "count", "warn"),
      kpi("d90_plus", "متأخر أكثر من 90 يوم", "Overdue 90+ days", t.d90_plus, "sar", "bad"),
    ],
    charts: [{
      key: "aging", type: "bar", unit: "sar",
      title: { ar: "أعمار المتأخرات", en: "Overdue aging" },
      series: [{ key: "amount", label: { ar: "المبلغ", en: "Amount" }, color: C.bad }, { key: "tenants", label: { ar: "المستأجرون", en: "Tenants" }, color: C.gray }],
      data: (["d1_30", "d31_60", "d61_90", "d90_plus"] as const).map((b) => ({ label: AGING_MAP[b].ar, labelEn: AGING_MAP[b].en, amount: t[b], tenants: bucketCount(b) })),
    }],
    columns: [
      col("tenant", "المستأجر", "Tenant", "text"), col("phone", "الجوال", "Phone", "phone"),
      col("overdueCount", "دفعات متأخرة", "Overdue installments", "number"), col("overdueAmount", "المبلغ المتأخر", "Overdue amount", "sar"),
      col("d1_30", "1–30 يوم", "1–30 days", "sar"), col("d31_60", "31–60 يوم", "31–60 days", "sar"),
      col("d61_90", "61–90 يوم", "61–90 days", "sar"), col("d90_plus", "+90 يوم", "90+ days", "sar"),
      col("maxDaysLate", "أقصى تأخير (يوم)", "Max days late", "days"), col("lastPaymentDate", "آخر سداد", "Last payment", "date"),
    ],
    rows: list as unknown as OpsRow[], totals: t,
    notes: [NOTE.overdue, { ar: "تُصنّف كل دفعة في عمرها حسب أيام تأخره عن تاريخ استحقاقه.", en: "Each installment is aged by its own days past due." }, NOTE.cancelled, NOTE.deposits, NOTE.drafts],
  };
}

function tenantPaymentBehavior(ds: OpsDataset, p: ResolvedParams): Body {
  const x = new Ctx(ds);
  type R = { tenant: string; phone: string | null; due: number; onTime: number; late: number; unpaid: number; lateDays: number };
  const rows = new Map<string, R>();
  for (const c of ds.contracts) {
    const k = x.tenantKey(c);
    for (const i of dueIn(x.insts(c), p.from, p.to)) {
      const done = completionDate(i);
      // Not yet due (or due today and still open) is not behaviour yet.
      if (!done && i.dueDate >= p.today) continue;
      const r = rows.get(k) ?? { tenant: x.tenantName(c), phone: x.tenantPhone(c), due: 0, onTime: 0, late: 0, unpaid: 0, lateDays: 0 };
      r.due++;
      if (!done) r.unpaid++;
      else if (done <= i.dueDate) r.onTime++;
      else { r.late++; r.lateDays += daysBetween(i.dueDate, done); }
      rows.set(k, r);
    }
  }
  const list = [...rows.values()].sort((a, b) => (pct(a.onTime, a.due) ?? 0) - (pct(b.onTime, b.due) ?? 0) || b.due - a.due);
  const t = { due: 0, onTime: 0, late: 0, unpaid: 0, lateDays: 0 };
  for (const r of list) { t.due += r.due; t.onTime += r.onTime; t.late += r.late; t.unpaid += r.unpaid; t.lateDays += r.lateDays; }
  const DIST = [
    { k: "onTime", ar: "في الموعد", en: "On time", color: C.good },
    { k: "late", ar: "متأخر", en: "Paid late", color: C.warn },
    { k: "unpaid", ar: "غير مسدد", en: "Unpaid", color: C.bad },
  ] as const;
  return {
    kpis: [
      kpi("due", "دفعات مستحقة", "Installments due", t.due, "count", "brand"),
      kpi("onTimeRate", "نسبة السداد في الموعد", "On-time rate", pct(t.onTime, t.due), "pct", "good"),
      kpi("late", "مسددة متأخرة", "Paid late", t.late, "count", "warn"),
      kpi("unpaid", "غير مسددة", "Unpaid", t.unpaid, "count", "bad"),
      kpi("avgDaysLate", "متوسط أيام التأخير", "Avg days late", t.late ? round1(t.lateDays / t.late) : 0, "days", "warn"),
    ],
    charts: [{
      key: "distribution", type: "donut", unit: "count",
      title: { ar: "توزيع السداد", en: "Payment distribution" },
      series: [{ key: "value", label: { ar: "الدفعات", en: "Installments" } }],
      data: DIST.map((d) => ({ label: d.ar, labelEn: d.en, value: t[d.k], color: d.color })),
    }],
    columns: [
      col("tenant", "المستأجر", "Tenant", "text"), col("phone", "الجوال", "Phone", "phone"),
      col("due", "دفعات مستحقة", "Due", "number"), col("onTime", "في الموعد", "On time", "number"),
      col("late", "متأخرة", "Paid late", "number"), col("unpaid", "غير مسددة", "Unpaid", "number"),
      col("onTimeRate", "نسبة الالتزام", "On-time rate", "pct"), col("avgDaysLate", "متوسط التأخير (يوم)", "Avg days late", "days"),
    ],
    rows: list.map((r) => ({
      tenant: r.tenant, phone: r.phone, due: r.due, onTime: r.onTime, late: r.late, unpaid: r.unpaid,
      onTimeRate: pct(r.onTime, r.due), avgDaysLate: r.late ? round1(r.lateDays / r.late) : null,
    })),
    totals: { due: t.due, onTime: t.onTime, late: t.late, unpaid: t.unpaid },
    notes: [
      { ar: "تُحتسب الدفعات المستحقة في الفترة حتى اليوم؛ الدفعة القادمة أو المستحقة اليوم دون سداد لا يُحتسب بعد.", en: "Counts installments due in the period up to today; one not yet due (or due today and unpaid) is not counted yet." },
      { ar: "في الموعد = اكتمل سداده في تاريخ الاستحقاق أو قبله؛ المدفوع جزئياً يُعد غير مسدد.", en: "On time = fully paid on or before the due date; a partly-paid installment counts as unpaid." },
      NOTE.paidNoCollections, NOTE.cancelled, NOTE.deposits, NOTE.drafts,
    ],
  };
}

function landlordPortfolio(ds: OpsDataset, p: ResolvedParams): Body {
  const x = new Ctx(ds);
  const rows: OpsRow[] = [];
  const agg = { properties: 0, units: 0, rented: 0, activeContracts: 0, annualRent: 0, billed: 0, collected: 0, outstanding: 0 };
  for (const o of ds.owners) {
    const props = ds.properties.filter((pr) => pr.ownerId === o.id);
    if (!props.length) continue;
    const pset = new Set(props.map((pr) => pr.id));
    const units = ds.units.filter((u) => pset.has(u.propertyId));
    const rented = occupiedUnits(ds.contracts, p.asOf, new Set(units.map((u) => u.id))).size;
    const contracts = ds.contracts.filter((c) => c.propertyId != null && pset.has(c.propertyId));
    const active = contracts.filter((c) => inForceOn(c, p.asOf));
    const m = money(contracts.flatMap((c) => dueIn(x.insts(c), p.from, p.to)));
    const r = {
      landlord: o.name, phone: o.phone, properties: props.length, units: units.length, rented,
      occupancy: pct(rented, units.length), activeContracts: active.length,
      annualRent: sum(active.map((c) => c.annualRent)), billed: m.billed, collected: m.collected, outstanding: m.outstanding,
    };
    rows.push(r);
    agg.properties += r.properties; agg.units += r.units; agg.rented += r.rented; agg.activeContracts += r.activeContracts;
    agg.annualRent = round2(agg.annualRent + r.annualRent); agg.billed = round2(agg.billed + r.billed);
    agg.collected = round2(agg.collected + r.collected); agg.outstanding = round2(agg.outstanding + r.outstanding);
  }
  rows.sort((a, b) => (b.annualRent as number) - (a.annualRent as number) || String(a.landlord).localeCompare(String(b.landlord)));
  return {
    kpis: [
      kpi("landlords", "المؤجرون", "Landlords", rows.length, "count", "brand"),
      kpi("units", "الوحدات", "Units", agg.units, "count", "neutral"),
      kpi("occupancy", "نسبة الإشغال", "Occupancy", pct(agg.rented, agg.units), "pct", "brand"),
      kpi("annualRent", "الإيجار السنوي المتعاقد", "Annual contracted rent", agg.annualRent, "sar", "neutral"),
      kpi("collected", "المحصّل في الفترة", "Collected in period", agg.collected, "sar", "good"),
      kpi("outstanding", "المتبقي", "Outstanding", agg.outstanding, "sar", "warn"),
    ],
    charts: [{
      key: "collection_by_landlord", type: "stacked", unit: "sar",
      title: { ar: "التحصيل حسب المؤجر", en: "Collection by landlord" },
      series: [{ key: "collected", label: { ar: "المحصّل", en: "Collected" }, color: C.cobalt }, { key: "outstanding", label: { ar: "المتبقي", en: "Outstanding" }, color: C.sky }],
      data: rows.slice(0, 12).map((r) => ({ label: String(r.landlord), collected: r.collected as number, outstanding: r.outstanding as number })),
    }],
    columns: [
      col("landlord", "المؤجر", "Landlord", "text"), col("phone", "الجوال", "Phone", "phone"),
      col("properties", "العقارات", "Properties", "number"), col("units", "الوحدات", "Units", "number"),
      col("rented", "المؤجرة", "Rented", "number"), col("occupancy", "الإشغال", "Occupancy", "pct"),
      col("activeContracts", "العقود السارية", "Active contracts", "number"), col("annualRent", "الإيجار السنوي", "Annual rent", "sar"),
      col("billed", "المستحق في الفترة", "Billed in period", "sar"), col("collected", "المحصّل في الفترة", "Collected in period", "sar"),
      col("outstanding", "المتبقي", "Outstanding", "sar"),
    ],
    rows, totals: agg,
    notes: [
      { ar: "يظهر المؤجر الذي يملك عقاراً واحداً على الأقل في النطاق.", en: "Lists landlords who own at least one property in scope." },
      { ar: "الإشغال والعقود السارية في التاريخ المرجعي (اليوم افتراضياً).", en: "Occupancy and active contracts are as of the reference date (today by default)." },
      NOTE.dueBasis, NOTE.firstUnit, NOTE.annual, NOTE.terminatedUnlinked, NOTE.cancelled, NOTE.deposits, NOTE.drafts,
    ],
  };
}

/* ── properties ─────────────────────────────────────────────────────────── */

/** The last lease to have covered a unit before `asOf`, with the day it stopped. */
function lastLease(contracts: DsContract[], unitId: number, asOf: string): { end: string; annualRent: number } | null {
  let best: { end: string; annualRent: number } | null = null;
  for (const c of contracts) {
    if (!LEASE_STATUSES.has(c.status) || !c.unitIds.includes(unitId) || c.startDate > asOf) continue;
    let end = c.endDate;
    if (c.status === "terminated" && c.endedOn && addDays(c.endedOn, -1) < end) end = addDays(c.endedOn, -1);
    if (end >= asOf) continue;
    if (!best || end > best.end) best = { end, annualRent: c.annualRent };
  }
  return best;
}

function vacantUnits(ds: OpsDataset, p: ResolvedParams): Body {
  const x = new Ctx(ds);
  const occ = occupiedUnits(ds.contracts, p.asOf);
  let lost = 0;
  const rows: OpsRow[] = [];
  const byProp = new Map<number, number>();
  for (const u of ds.units) {
    if (occ.has(u.id)) continue;
    const last = lastLease(ds.contracts, u.id, p.asOf);
    const daysVacant = last ? daysBetween(last.end, p.asOf) : null;
    if (last && daysVacant != null) lost += (last.annualRent * daysVacant) / 365;
    byProp.set(u.propertyId, (byProp.get(u.propertyId) ?? 0) + 1);
    rows.push({
      property: x.propById.get(u.propertyId)?.name ?? "—", unit: u.unitNumber,
      type: u.typeAr, typeEn: u.typeEn, usage: u.usageAr, usageEn: u.usageEn, area: u.area,
      daysVacant, lastAnnualRent: last ? last.annualRent : null, status: u.status,
    });
  }
  rows.sort((a, b) => ((b.daysVacant as number) ?? -1) - ((a.daysVacant as number) ?? -1) || String(a.property).localeCompare(String(b.property)));
  return {
    kpis: [
      kpi("vacant", "الوحدات الشاغرة", "Vacant units", rows.length, "count", "warn"),
      kpi("units", "إجمالي الوحدات", "Total units", ds.units.length, "count", "neutral"),
      kpi("vacancy", "نسبة الشغور", "Vacancy rate", pct(rows.length, ds.units.length), "pct", "bad"),
      kpi("lostRent", "الإيجار الفائت (تقديري)", "Lost rent (estimate)", round2(lost), "sar", "bad"),
    ],
    charts: [{
      key: "vacant_by_property", type: "bar", unit: "count",
      title: { ar: "الشواغر حسب العقار", en: "Vacant units by property" },
      series: [{ key: "vacant", label: { ar: "شاغرة", en: "Vacant" }, color: C.sky }],
      data: [...byProp.entries()].sort((a, b) => b[1] - a[1]).map(([pid, n]) => ({ label: x.propById.get(pid)?.name ?? "—", vacant: n })),
    }],
    columns: [
      col("property", "العقار", "Property", "text"), col("unit", "الوحدة", "Unit", "text"),
      col("type", "النوع", "Type", "text"), col("usage", "الاستخدام", "Usage", "text"), col("area", "المساحة (م²)", "Area (m²)", "number"),
      col("daysVacant", "أيام الشغور", "Days vacant", "days"), col("lastAnnualRent", "آخر إيجار سنوي", "Last annual rent", "sar"),
      col("status", "حالة الوحدة", "Unit status", "status", UNIT_STATUS_MAP),
    ],
    rows,
    notes: [
      { ar: "الوحدة شاغرة إذا لم يغطها عقد ساري في التاريخ المرجعي، بصرف النظر عن حالتها المسجلة.", en: "A unit is vacant when no in-force contract covers it on the as-of date, whatever its stored status says." },
      { ar: "أيام الشغور من نهاية آخر عقد؛ فارغة إن لم تؤجر الوحدة قط (أو كان عقدها الأخير مفسوخاً وفُكّت وحداته).", en: "Days vacant count from the last contract's end; empty when the unit was never leased (or its last contract was terminated and unlinked)." },
      { ar: "الإيجار الفائت = آخر إيجار سنوي × أيام الشغور ÷ 365، للوحدات المعروف إيجارها السابق فقط.", en: "Lost rent = last annual rent × days vacant ÷ 365, only for units with a known previous rent." },
      NOTE.drafts,
    ],
  };
}

function propertyPerformance(ds: OpsDataset, p: ResolvedParams): Body {
  const x = new Ctx(ds);
  const occ = occupiedUnits(ds.contracts, p.asOf);
  const rows = ds.properties.map((pr) => {
    const units = ds.units.filter((u) => u.propertyId === pr.id);
    const rented = units.filter((u) => occ.has(u.id)).length;
    const contracts = ds.contracts.filter((c) => c.propertyId === pr.id);
    const active = contracts.filter((c) => inForceOn(c, p.asOf));
    const m = money(contracts.flatMap((c) => dueIn(x.insts(c), p.from, p.to)));
    return {
      property: pr.name, units: units.length, rented, vacant: units.length - rented, occupancy: pct(rented, units.length),
      activeContracts: active.length, annualRent: sum(active.map((c) => c.annualRent)),
      billed: m.billed, collected: m.collected, outstanding: m.outstanding, collectionRate: pct(m.collected, m.billed),
    };
  }).sort((a, b) => b.annualRent - a.annualRent || a.property.localeCompare(b.property));
  const t = {
    units: rows.reduce((s, r) => s + r.units, 0), rented: rows.reduce((s, r) => s + r.rented, 0), vacant: rows.reduce((s, r) => s + r.vacant, 0),
    activeContracts: rows.reduce((s, r) => s + r.activeContracts, 0), annualRent: sum(rows.map((r) => r.annualRent)),
    billed: sum(rows.map((r) => r.billed)), collected: sum(rows.map((r) => r.collected)), outstanding: sum(rows.map((r) => r.outstanding)),
  };
  return {
    kpis: [
      kpi("properties", "العقارات", "Properties", rows.length, "count", "brand"),
      kpi("units", "الوحدات", "Units", t.units, "count", "neutral"),
      kpi("occupancy", "نسبة الإشغال", "Occupancy", pct(t.rented, t.units), "pct", "brand"),
      kpi("annualRent", "الإيجار السنوي المتعاقد", "Annual contracted rent", t.annualRent, "sar", "neutral"),
      kpi("billed", "المستحق في الفترة", "Billed in period", t.billed, "sar", "neutral"),
      kpi("collected", "المحصّل في الفترة", "Collected in period", t.collected, "sar", "good"),
      kpi("collectionRate", "نسبة التحصيل", "Collection rate", pct(t.collected, t.billed), "pct", "brand"),
    ],
    charts: [
      {
        key: "occupancy_by_property", type: "bar", unit: "pct",
        title: { ar: "الإشغال حسب العقار", en: "Occupancy by property" },
        series: [{ key: "occupancy", label: { ar: "الإشغال", en: "Occupancy" }, color: C.cobalt }],
        data: rows.map((r) => ({ label: r.property, occupancy: r.occupancy ?? 0 })),
      },
      {
        key: "collected_vs_billed", type: "bar", unit: "sar",
        title: { ar: "المحصّل مقابل المستحق", en: "Collected vs billed" },
        series: [{ key: "billed", label: { ar: "المستحق", en: "Billed" }, color: C.sky }, { key: "collected", label: { ar: "المحصّل", en: "Collected" }, color: C.cobalt }],
        data: rows.map((r) => ({ label: r.property, billed: r.billed, collected: r.collected })),
      },
    ],
    columns: [
      col("property", "العقار", "Property", "text"), col("units", "الوحدات", "Units", "number"),
      col("rented", "المؤجرة", "Rented", "number"), col("vacant", "الشاغرة", "Vacant", "number"), col("occupancy", "الإشغال", "Occupancy", "pct"),
      col("activeContracts", "العقود السارية", "Active contracts", "number"), col("annualRent", "الإيجار السنوي", "Annual rent", "sar"),
      col("billed", "المستحق في الفترة", "Billed in period", "sar"), col("collected", "المحصّل في الفترة", "Collected in period", "sar"),
      col("outstanding", "المتبقي", "Outstanding", "sar"), col("collectionRate", "نسبة التحصيل", "Collection rate", "pct"),
    ],
    rows, totals: t,
    notes: [NOTE.occupancy, NOTE.dueBasis, NOTE.firstUnit, NOTE.annual, NOTE.terminatedUnlinked, NOTE.cancelled, NOTE.deposits, NOTE.drafts],
  };
}

function occupancyTrend(ds: OpsDataset, p: ResolvedParams): Body {
  const scope = new Set(ds.units.map((u) => u.id));
  const rows = monthsIn(p.from, p.to).map((m) => {
    const day = occupancyDay(m, p.today);
    const occupied = occupiedUnits(ds.contracts, day, scope).size;
    const l = monthLabel(m.ym);
    return { month: l.ar, monthEn: l.en, ym: m.ym, measuredOn: day, units: scope.size, occupied, occupancy: pct(occupied, scope.size) };
  });
  const last = rows[rows.length - 1];
  const vals = rows.map((r) => r.occupancy).filter((v): v is number => v != null);
  return {
    kpis: [
      kpi("units", "الوحدات", "Units", scope.size, "count", "neutral"),
      kpi("latest", "الإشغال في آخر شهر", "Latest occupancy", last?.occupancy ?? 0, "pct", "brand"),
      kpi("average", "متوسط الإشغال", "Average occupancy", vals.length ? round1(vals.reduce((s, v) => s + v, 0) / vals.length) : 0, "pct", "neutral"),
    ],
    charts: [{
      key: "occupancy", type: "line", unit: "pct",
      title: { ar: "نسبة الإشغال الشهرية", en: "Monthly occupancy" },
      series: [{ key: "occupancy", label: { ar: "الإشغال", en: "Occupancy" }, color: C.cobalt }],
      data: rows.map((r) => ({ label: r.month, labelEn: r.monthEn, occupancy: r.occupancy ?? 0, occupied: r.occupied })),
    }],
    columns: [
      col("month", "الشهر", "Month", "text"), col("measuredOn", "تاريخ القياس", "Measured on", "date"),
      col("units", "الوحدات", "Units", "number"), col("occupied", "المشغولة", "Occupied", "number"), col("occupancy", "الإشغال", "Occupancy", "pct"),
    ],
    rows,
    notes: [
      { ar: "يُقاس كل شهر في آخر يوم منه (أو اليوم للشهر الجاري).", en: "Each month is measured on its last day (today for the current month)." },
      { ar: "المقام هو الوحدات الحالية في النطاق لكل الأشهر.", en: "The denominator is the units currently in scope, for every month." },
      NOTE.occupancy, NOTE.terminatedUnlinked, NOTE.drafts,
    ],
  };
}

/* ── contracts ──────────────────────────────────────────────────────────── */

function contractsReport(ds: OpsDataset, p: ResolvedParams): Body {
  const x = new Ctx(ds);
  const inWindow = ds.contracts.filter((c) => (!p.from || c.endDate >= p.from) && (!p.to || c.startDate <= p.to));
  // The status filter narrows the KPIs and the chart too, not only the table:
  // "Expired" chosen and the tiles still counting every active lease read as a
  // filter that did nothing.
  const withStatus = inWindow.map((c) => ({ c, st: contractStatusAt(c, p.asOf) })).filter((w) => !p.status || w.st === p.status);
  const counts: Record<string, number> = Object.fromEntries(CONTRACT_STATUSES.map((s) => [s, 0]));
  for (const { st } of withStatus) counts[st] = (counts[st] ?? 0) + 1;
  const activeRent = sum(withStatus.filter((w) => w.st === "active").map((w) => w.c.annualRent));
  const rows = withStatus.map(({ c, st }) => ({
    contractNumber: c.contractNumber, ejarNumber: c.ejarNumber, tenant: x.tenantName(c), landlord: x.landlordName(c),
    property: x.propertyName(c), unit: x.unitLabel(c), startDate: c.startDate, endDate: c.endDate, annualRent: c.annualRent,
    paymentFrequency: FREQ[c.paymentFrequency]?.ar ?? c.paymentFrequency, paymentFrequencyEn: FREQ[c.paymentFrequency]?.en ?? c.paymentFrequency,
    status: st, daysRemaining: st === "active" ? daysBetween(p.asOf, c.endDate) : null,
  })).sort((a, b) => (a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0));
  const tone: Record<string, Tone> = { active: "good", upcoming: "brand", expired: "warn", terminated: "bad", cancelled: "neutral", pending: "brand" };
  return {
    kpis: [
      kpi("total", "إجمالي العقود", "Total contracts", withStatus.length, "count", "brand"),
      ...CONTRACT_STATUSES.map((s) => kpi(s, CONTRACT_STATUS_MAP[s].ar, CONTRACT_STATUS_MAP[s].en, counts[s], "count", tone[s])),
      kpi("activeAnnualRent", "الإيجار السنوي للعقود السارية", "Annual rent of active contracts", activeRent, "sar", "neutral"),
    ],
    charts: [{
      key: "by_status", type: "donut", unit: "count",
      title: { ar: "العقود حسب الحالة", en: "Contracts by status" },
      series: [{ key: "value", label: { ar: "العقود", en: "Contracts" } }],
      data: CONTRACT_STATUSES.map((s) => ({ label: CONTRACT_STATUS_MAP[s].ar, labelEn: CONTRACT_STATUS_MAP[s].en, value: counts[s] })),
    }],
    columns: [
      col("contractNumber", "رقم العقد", "Contract no.", "text"), col("ejarNumber", "رقم إيجار", "Ejar no.", "text"),
      col("tenant", "المستأجر", "Tenant", "text"), col("landlord", "المؤجر", "Landlord", "text"),
      col("property", "العقار", "Property", "text"), col("unit", "الوحدة", "Unit", "text"),
      col("startDate", "البداية", "Start", "date"), col("endDate", "النهاية", "End", "date"),
      col("annualRent", "الإيجار السنوي", "Annual rent", "sar"), col("paymentFrequency", "دورية السداد", "Payment frequency", "text"),
      col("status", "الحالة", "Status", "status", CONTRACT_STATUS_MAP), col("daysRemaining", "الأيام المتبقية", "Days remaining", "days"),
    ],
    rows, totals: { annualRent: sum(rows.map((r) => r.annualRent)) },
    statusOptions: opts(CONTRACT_STATUS_MAP, CONTRACT_STATUSES),
    notes: [
      { ar: "الحالة محسوبة في تاريخ «كما في»: العقد الذي لم يبدأ بعد يظهر «لم يبدأ بعد»، والذي تجاوز تاريخ نهايته يظهر «منتهياً».", en: "Status is read on the as-of date: a contract that has not started yet shows as not started yet; one past its end date shows as expired." },
      { ar: "فلتر الحالة يطبّق على المؤشرات والرسم والجدول؛ عند تحديد فترة تظهر العقود المتداخلة معها (السارية في أي يوم منها).", en: "The status filter applies to the KPIs, the chart and the table; a from/to window keeps contracts overlapping it (in force on any day of it)." },
      NOTE.annual, NOTE.terminatedUnlinked, NOTE.drafts,
    ],
  };
}

function expiringContracts(ds: OpsDataset, p: ResolvedParams): Body {
  const x = new Ctx(ds);
  const horizon = addDays(p.asOf, p.days);
  const rows = ds.contracts
    .filter((c) => inForceOn(c, p.asOf) && c.endDate <= horizon)
    .map((c) => {
      const daysRemaining = daysBetween(p.asOf, c.endDate);
      return {
        contractNumber: c.contractNumber, tenant: x.tenantName(c), phone: x.tenantPhone(c), property: x.propertyName(c), unit: x.unitLabel(c),
        endDate: c.endDate, daysRemaining, annualRent: c.annualRent, bucket: expiryBucket(daysRemaining) as string,
      };
    }).sort((a, b) => a.daysRemaining - b.daysRemaining);
  const buckets = ["d0_30", "d31_60", "d61_90", "d90_plus"] as const;
  const n = (b: string) => rows.filter((r) => r.bucket === b).length;
  return {
    kpis: [
      kpi("expiring", "عقود تنتهي قريباً", "Expiring contracts", rows.length, "count", "warn"),
      kpi("d0_30", "خلال 30 يوماً", "Within 30 days", n("d0_30"), "count", "bad"),
      kpi("d31_60", "31–60 يوماً", "31–60 days", n("d31_60"), "count", "warn"),
      kpi("d61_90", "61–90 يوماً", "61–90 days", n("d61_90"), "count", "warn"),
      kpi("annualRent", "الإيجار السنوي المعرّض", "Annual rent at stake", sum(rows.map((r) => r.annualRent)), "sar", "neutral"),
    ],
    charts: [{
      key: "buckets", type: "bar", unit: "count",
      title: { ar: "العقود حسب المدة المتبقية", en: "Contracts by time remaining" },
      series: [{ key: "contracts", label: { ar: "العقود", en: "Contracts" }, color: C.warn }],
      data: buckets.map((b) => ({ label: EXPIRY_MAP[b].ar, labelEn: EXPIRY_MAP[b].en, contracts: n(b) })),
    }],
    columns: [
      col("contractNumber", "رقم العقد", "Contract no.", "text"), col("tenant", "المستأجر", "Tenant", "text"), col("phone", "الجوال", "Phone", "phone"),
      col("property", "العقار", "Property", "text"), col("unit", "الوحدة", "Unit", "text"), col("endDate", "تاريخ الانتهاء", "End date", "date"),
      col("daysRemaining", "الأيام المتبقية", "Days remaining", "days"), col("annualRent", "الإيجار السنوي", "Annual rent", "sar"),
      col("bucket", "الفئة", "Bucket", "status", EXPIRY_MAP),
    ],
    rows, totals: { annualRent: sum(rows.map((r) => r.annualRent)) },
    notes: [
      { ar: "العقود السارية في التاريخ المرجعي التي تنتهي خلال عدد الأيام المحدد (90 افتراضياً).", en: "Contracts in force on the as-of date that end within the chosen number of days (90 by default)." },
      NOTE.annual, NOTE.drafts,
    ],
  };
}

function contractMovement(ds: OpsDataset, p: ResolvedParams): Body {
  const rows = monthsIn(p.from, p.to).map((m) => {
    const inM = (d: string | null) => d != null && d >= m.start && d <= m.end;
    const started = ds.contracts.filter((c) => LEASE_STATUSES.has(c.status) && inM(c.startDate)).length;
    const ended = ds.contracts.filter((c) => (c.status === "active" || c.status === "expired") && inM(c.endDate) && c.endDate < p.today).length;
    const terminated = ds.contracts.filter((c) => c.status === "terminated" && inM(c.endedOn)).length;
    const l = monthLabel(m.ym);
    return { month: l.ar, monthEn: l.en, ym: m.ym, started, ended, terminated, net: started - ended - terminated };
  });
  const t = { started: 0, ended: 0, terminated: 0, net: 0 };
  for (const r of rows) { t.started += r.started; t.ended += r.ended; t.terminated += r.terminated; t.net += r.net; }
  return {
    kpis: [
      kpi("started", "عقود جديدة", "New contracts", t.started, "count", "good"),
      kpi("ended", "عقود منتهية", "Expired", t.ended, "count", "warn"),
      kpi("terminated", "عقود مفسوخة", "Terminated early", t.terminated, "count", "bad"),
      kpi("net", "صافي التغير", "Net change", t.net, "count", t.net >= 0 ? "good" : "bad"),
      kpi("activeNow", "العقود السارية الآن", "Active now", ds.contracts.filter((c) => inForceOn(c, p.today)).length, "count", "brand"),
    ],
    charts: [{
      key: "movement", type: "stacked", unit: "count",
      title: { ar: "حركة العقود الشهرية", en: "Monthly contract movement" },
      series: [
        { key: "started", label: { ar: "جديدة", en: "New" }, color: C.good },
        { key: "ended", label: { ar: "منتهية", en: "Expired" }, color: C.warn },
        { key: "terminated", label: { ar: "مفسوخة", en: "Terminated" }, color: C.bad },
      ],
      data: rows.map((r) => ({ label: r.month, labelEn: r.monthEn, started: r.started, ended: r.ended, terminated: r.terminated, net: r.net })),
    }],
    columns: [
      col("month", "الشهر", "Month", "text"), col("started", "جديدة", "New", "number"), col("ended", "منتهية", "Expired", "number"),
      col("terminated", "مفسوخة", "Terminated", "number"), col("net", "صافي التغير", "Net change", "number"),
    ],
    rows, totals: t,
    notes: [
      { ar: "الجديد = عقد بدأ في الشهر؛ المنتهي = عقد انتهت مدته في الشهر (حتى أمس)؛ المفسوخ = عقد فُسخ في الشهر.", en: "New = started in the month; expired = term ended in the month (up to yesterday); terminated = ended early in the month." },
      { ar: "لا يحفظ النظام تاريخ الفسخ، فيُستخدم تاريخ آخر تعديل على العقد المفسوخ.", en: "The schema keeps no termination date, so a terminated contract's last-update date stands in for it." },
      { ar: "العقود الملغاة وقيد الانتظار لا تُحتسب.", en: "Cancelled and pending contracts are not counted." },
      NOTE.terminatedUnlinked, NOTE.drafts,
    ],
  };
}

/* ── collections ────────────────────────────────────────────────────────── */

function collectionsSummary(ds: OpsDataset, p: ResolvedParams): Body {
  const x = new Ctx(ds);
  const all = dueIn(ds.installments, p.from, p.to);
  const rows = monthsIn(p.from, p.to).map((m) => {
    const mm = money(all.filter((i) => i.dueDate >= m.start && i.dueDate <= m.end));
    const l = monthLabel(m.ym);
    return { month: l.ar, monthEn: l.en, ym: m.ym, due: mm.billed, collected: mm.collected, outstanding: mm.outstanding, collectionRate: pct(mm.collected, mm.billed) };
  });
  const t = money(all);
  const overdue = sum(all.filter((i) => i.dueDate < p.today).map((i) => remainingOf(i)));
  const cById = x.contractById();
  // Keyed by property id (two properties may share a name); "—" = no linked unit.
  // A terminated contract's units are unlinked, so its money has no property: say so instead of a bare "—".
  const byProp = new Map<number | null, Money & { label: string; labelEn: string }>();
  for (const i of all) {
    const c = cById.get(i.contractId);
    const key = c?.propertyId ?? null;
    const name = key != null && c ? x.propertyName(c) : null;
    const cur = byProp.get(key) ?? { label: name ?? "بلا عقار مرتبط", labelEn: name ?? "No linked property", billed: 0, collected: 0, outstanding: 0 };
    const mm = money([i]);
    byProp.set(key, { ...cur, billed: round2(cur.billed + mm.billed), collected: round2(cur.collected + mm.collected), outstanding: round2(cur.outstanding + mm.outstanding) });
  }
  return {
    kpis: [
      kpi("due", "المستحق", "Due", t.billed, "sar", "neutral"),
      kpi("collected", "المحصّل", "Collected", t.collected, "sar", "good"),
      kpi("outstanding", "المتبقي", "Outstanding", t.outstanding, "sar", "warn"),
      kpi("overdue", "منه متأخر", "Of which overdue", overdue, "sar", "bad"),
      kpi("collectionRate", "نسبة التحصيل", "Collection rate", pct(t.collected, t.billed), "pct", "brand"),
    ],
    charts: [
      {
        key: "monthly", type: "bar", unit: "sar",
        title: { ar: "المستحق والمحصّل شهرياً", en: "Due and collected by month" },
        series: [{ key: "due", label: { ar: "المستحق", en: "Due" }, color: C.sky }, { key: "collected", label: { ar: "المحصّل", en: "Collected" }, color: C.cobalt }],
        data: rows.map((r) => ({ label: r.month, labelEn: r.monthEn, due: r.due, collected: r.collected })),
      },
      {
        key: "by_property", type: "stacked", unit: "sar",
        title: { ar: "التحصيل حسب العقار", en: "Collection by property" },
        series: [{ key: "collected", label: { ar: "المحصّل", en: "Collected" }, color: C.cobalt }, { key: "outstanding", label: { ar: "المتبقي", en: "Outstanding" }, color: C.sky }],
        data: [...byProp.values()].sort((a, b) => b.billed - a.billed).map((v) => ({ label: v.label, labelEn: v.labelEn, collected: v.collected, outstanding: v.outstanding })),
      },
    ],
    columns: [
      col("month", "الشهر", "Month", "text"), col("due", "المستحق", "Due", "sar"), col("collected", "المحصّل", "Collected", "sar"),
      col("outstanding", "المتبقي", "Outstanding", "sar"), col("collectionRate", "نسبة التحصيل", "Collection rate", "pct"),
    ],
    rows, totals: { due: t.billed, collected: t.collected, outstanding: t.outstanding },
    notes: [
      { ar: "تُجمع الدفعات حسب شهر استحقاقها؛ هذا تقرير تشغيلي من جدول الدفعات وليس دفتر المحاسبة.", en: "Installments are grouped by due month; this is an operational view of the installment schedule, not the accounting ledger." },
      NOTE.dueBasis, NOTE.overdue, NOTE.paidNoCollections, NOTE.firstUnit, NOTE.cancelled, NOTE.deposits, NOTE.drafts,
    ],
  };
}

function installmentsSchedule(ds: OpsDataset, p: ResolvedParams): Body {
  const x = new Ctx(ds);
  const cById = x.contractById();
  const inWin = ds.installments.filter((i) => i.dueDate >= p.from && i.dueDate <= p.to);
  const all = inWin.map((i) => {
    const c = cById.get(i.contractId)!;
    const st = instStatus(i);
    const collected = collectedOf(i);
    const remaining = remainingOf(i);
    let daysLate: number | null = null;
    if (st !== "cancelled") {
      if (remaining > EPS && i.dueDate < p.today) daysLate = daysBetween(i.dueDate, p.today);
      else { const done = completionDate(i); if (done && done > i.dueDate) daysLate = daysBetween(i.dueDate, done); }
    }
    return {
      contractNumber: c.contractNumber, tenant: x.tenantName(c), property: x.propertyName(c), unit: x.unitLabel(c),
      dueDate: i.dueDate, amount: i.amount, collected, remaining, status: st as string, daysLate,
    };
  });
  // The status filter narrows the KPIs and the chart too, not only the table.
  const rows = all.filter((r) => !p.status || r.status === p.status);
  const live = rows.filter((r) => r.status !== "cancelled");
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const liveRows = live;
  return {
    kpis: [
      kpi("due", "المستحق", "Due", sum(live.map((r) => r.amount)), "sar", "neutral"),
      kpi("collected", "المحصّل", "Collected", sum(live.map((r) => r.collected)), "sar", "good"),
      kpi("remaining", "المتبقي", "Remaining", sum(live.map((r) => r.remaining)), "sar", "warn"),
      kpi("overdueAmount", "المتأخر", "Overdue", sum(live.filter((r) => r.dueDate < p.today).map((r) => r.remaining)), "sar", "bad"),
      ...INST_STATUSES.map((s) => kpi(`${s}Count`, INST_STATUS_MAP[s].ar, INST_STATUS_MAP[s].en, count(s), "count", INST_STATUS_MAP[s].tone)),
    ],
    charts: [{
      key: "by_status", type: "donut", unit: "count",
      title: { ar: "الدفعات حسب الحالة", en: "Installments by status" },
      series: [{ key: "value", label: { ar: "الدفعات", en: "Installments" } }],
      data: INST_STATUSES.map((s) => ({ label: INST_STATUS_MAP[s].ar, labelEn: INST_STATUS_MAP[s].en, value: count(s) })),
    }],
    columns: [
      col("contractNumber", "رقم العقد", "Contract no.", "text"), col("tenant", "المستأجر", "Tenant", "text"),
      col("property", "العقار", "Property", "text"), col("unit", "الوحدة", "Unit", "text"), col("dueDate", "تاريخ الاستحقاق", "Due date", "date"),
      col("amount", "المبلغ", "Amount", "sar"), col("collected", "المحصّل", "Collected", "sar"), col("remaining", "المتبقي", "Remaining", "sar"),
      col("status", "الحالة", "Status", "status", INST_STATUS_MAP), col("daysLate", "أيام التأخير", "Days late", "days"),
    ],
    rows,
    totals: { amount: sum(liveRows.map((r) => r.amount)), collected: sum(liveRows.map((r) => r.collected)), remaining: sum(liveRows.map((r) => r.remaining)) },
    statusOptions: opts(INST_STATUS_MAP, INST_STATUSES),
    notes: [
      { ar: "الحالة مشتقة لحظياً (توقيت الرياض): الدفعة غير المسددة بعد تاريخ استحقاقه «متأخر».", en: "Status is derived live (Riyadh time): an unsettled installment past its due date is overdue." },
      { ar: "فلتر الحالة يطبّق على المؤشرات والرسم والجدول.", en: "The status filter applies to the KPIs, the chart and the table." },
      { ar: "المجاميع تستبعد الدفعات الملغاة؛ أيام التأخير للمتبقي حتى اليوم أو للسداد المتأخر حتى تاريخ اكتماله.", en: "Totals exclude cancelled rows; days late run to today for an open remainder, or to the completion date for a late payment." },
      NOTE.paidNoCollections, NOTE.deposits, NOTE.drafts,
    ],
  };
}

/* ── operations ─────────────────────────────────────────────────────────── */

function maintenanceRequests(ds: OpsDataset, p: ResolvedParams): Body {
  const x = new Ctx(ds);
  const cById = x.contractById();
  const inWin = ds.maintenance.filter((m) => m.openedOn >= p.from && m.openedOn <= p.to);
  const all = inWin.map((m) => {
    const c = m.contractId != null ? cById.get(m.contractId) : undefined;
    const closed = m.status === "completed" ? m.updatedOn : null;
    return {
      number: `#${m.id}`, description: m.description, status: m.status, priority: m.priority,
      property: c ? x.propertyName(c) : "—", unit: m.unitLabel || "—", tenant: c ? x.tenantName(c) : "—",
      opened: m.openedOn, closed, daysOpen: daysBetween(m.openedOn, closed ?? p.today),
    };
  });
  // The status filter narrows the KPIs and the charts too, not only the table.
  const rows = all.filter((r) => !p.status || r.status === p.status).sort((a, b) => (a.opened < b.opened ? 1 : a.opened > b.opened ? -1 : 0));
  const closedRows = rows.filter((r) => r.closed);
  const count = (k: keyof typeof all[number], v: string) => rows.filter((r) => r[k] === v).length;
  return {
    kpis: [
      kpi("total", "إجمالي الطلبات", "Total requests", rows.length, "count", "brand"),
      kpi("open", "مفتوحة", "Open", rows.length - closedRows.length, "count", "warn"),
      kpi("closed", "مكتملة", "Completed", closedRows.length, "count", "good"),
      kpi("avgResolutionDays", "متوسط أيام الإنجاز", "Avg resolution days", closedRows.length ? round1(closedRows.reduce((s, r) => s + r.daysOpen, 0) / closedRows.length) : 0, "days", "neutral"),
    ],
    charts: [
      {
        key: "by_status", type: "donut", unit: "count", title: { ar: "الطلبات حسب الحالة", en: "Requests by status" },
        series: [{ key: "value", label: { ar: "الطلبات", en: "Requests" } }],
        data: MAINT_STATUSES.map((s) => ({ label: MAINT_STATUS_MAP[s].ar, labelEn: MAINT_STATUS_MAP[s].en, value: count("status", s) })),
      },
      {
        key: "by_priority", type: "bar", unit: "count", title: { ar: "الطلبات حسب الأولوية", en: "Requests by priority" },
        series: [{ key: "requests", label: { ar: "الطلبات", en: "Requests" }, color: C.cobalt }],
        data: (["high", "medium", "low"] as const).map((k) => ({ label: PRIORITY_MAP[k].ar, labelEn: PRIORITY_MAP[k].en, requests: count("priority", k) })),
      },
    ],
    columns: [
      col("number", "الرقم", "No.", "text"), col("description", "الوصف", "Description", "text"),
      col("status", "الحالة", "Status", "status", MAINT_STATUS_MAP), col("priority", "الأولوية", "Priority", "status", PRIORITY_MAP),
      col("property", "العقار", "Property", "text"), col("unit", "الوحدة", "Unit", "text"), col("tenant", "المستأجر", "Tenant", "text"),
      col("opened", "تاريخ الفتح", "Opened", "date"), col("closed", "تاريخ الإنجاز", "Closed", "date"), col("daysOpen", "مدة المعالجة (يوم)", "Days open", "days"),
    ],
    rows,
    statusOptions: opts(MAINT_STATUS_MAP, MAINT_STATUSES),
    notes: [
      { ar: "لا تحفظ طلبات الصيانة تصنيفاً ولا تاريخ إغلاق: تُعرض الأولوية بدل التصنيف، ويُستخدم تاريخ آخر تعديل للطلب المكتمل كتاريخ إنجاز.", en: "Maintenance requests store no category and no closing date: priority is shown instead of category, and a completed request's last-update date stands in for its close date." },
      { ar: "يُنسب الطلب إلى عقار عقده؛ الطلب غير المرتبط بعقد لا يظهر عند التصفية بالعقار أو المؤجر.", en: "A request is attributed to its contract's property; one with no contract drops out under a property or landlord filter." },
    ],
  };
}

type Issue = { key: string; entity: string; ar: string; en: string };
/** `ar`/`en` name the missing field (the row's "missing" cell); `kAr`/`kEn` are the KPI / chart labels. */
type IssueDef = Issue & { kAr: string; kEn: string };
const ISSUES: IssueDef[] = [
  { key: "contract_no_ejar", entity: "contract", ar: "رقم عقد إيجار", en: "Ejar contract number", kAr: "عقود بلا رقم إيجار", kEn: "Contracts without an Ejar number" },
  { key: "contract_no_unit", entity: "contract", ar: "وحدة مرتبطة", en: "Linked unit", kAr: "عقود سارية بلا وحدة", kEn: "Active contracts without a unit" },
  { key: "unit_no_type", entity: "unit", ar: "نوع الوحدة", en: "Unit type", kAr: "وحدات بلا نوع", kEn: "Units without a type" },
  { key: "unit_no_usage", entity: "unit", ar: "استخدام الوحدة", en: "Unit usage", kAr: "وحدات بلا استخدام", kEn: "Units without a usage" },
  { key: "tenant_no_phone", entity: "tenant", ar: "رقم الجوال", en: "Phone", kAr: "مستأجرون بلا رقم جوال", kEn: "Tenants without a phone" },
  { key: "tenant_no_id", entity: "tenant", ar: "رقم الهوية", en: "National ID", kAr: "مستأجرون بلا رقم هوية", kEn: "Tenants without a national ID" },
  { key: "property_no_deed", entity: "property", ar: "الصك", en: "Title deed", kAr: "عقارات بلا صك", kEn: "Properties without a title deed" },
  { key: "property_no_landlord", entity: "property", ar: "المؤجر", en: "Landlord", kAr: "عقارات بلا مؤجر", kEn: "Properties without a landlord" },
  { key: "landlord_no_iban", entity: "landlord", ar: "الآيبان", en: "IBAN", kAr: "مؤجرون بلا آيبان", kEn: "Landlords without an IBAN" },
  { key: "landlord_no_id", entity: "landlord", ar: "رقم الهوية/السجل", en: "ID / CR number", kAr: "مؤجرون بلا رقم هوية/سجل", kEn: "Landlords without an ID / CR number" },
];

function dataQuality(ds: OpsDataset, _p: ResolvedParams): Body {
  const x = new Ctx(ds);
  const blank = (v: string | null | undefined) => !v || !String(v).trim();
  const rows: OpsRow[] = [];
  const counts: Record<string, number> = Object.fromEntries(ISSUES.map((i) => [i.key, 0]));
  const add = (entity: string, record: string, keys: string[]) => {
    if (!keys.length) return;
    const iss = keys.map((k) => ISSUES.find((i) => i.key === k)!);
    for (const k of keys) counts[k]++;
    rows.push({ entity, record, missing: iss.map((i) => i.ar).join("، "), missingEn: iss.map((i) => i.en).join(", "), issues: keys.length });
  };
  for (const c of ds.contracts) {
    if (c.status === "cancelled") continue;
    const k: string[] = [];
    if (!c.ejarNumber) k.push("contract_no_ejar");
    if (c.status === "active" && c.unitIds.length === 0) k.push("contract_no_unit");
    add("contract", `${c.contractNumber} — ${x.tenantName(c)}`, k);
  }
  for (const u of ds.units) {
    const k: string[] = [];
    if (blank(u.typeAr)) k.push("unit_no_type");
    if (blank(u.usageAr)) k.push("unit_no_usage");
    add("unit", `${x.propById.get(u.propertyId)?.name ?? "—"} / ${u.unitNumber}`, k);
  }
  const tenantIds = ds.filtered ? new Set(ds.contracts.map((c) => c.tenantId).filter((t): t is number => t != null)) : null;
  for (const t of ds.tenants) {
    if (tenantIds && !tenantIds.has(t.id)) continue;
    const k: string[] = [];
    if (blank(t.phone)) k.push("tenant_no_phone");
    if (blank(t.nationalId)) k.push("tenant_no_id");
    add("tenant", t.name, k);
  }
  for (const pr of ds.properties) {
    const k: string[] = [];
    if (!pr.hasDeed) k.push("property_no_deed");
    if (pr.ownerId == null) k.push("property_no_landlord");
    add("property", pr.name, k);
  }
  for (const o of ds.owners) {
    const k: string[] = [];
    if (blank(o.iban)) k.push("landlord_no_iban");
    if (blank(o.idNumber)) k.push("landlord_no_id");
    add("landlord", o.name, k);
  }
  const ent = Object.keys(ENTITY_MAP);
  rows.sort((a, b) => ent.indexOf(String(a.entity)) - ent.indexOf(String(b.entity)));
  return {
    kpis: [
      kpi("records", "سجلات ناقصة", "Records with gaps", rows.length, "count", rows.length ? "warn" : "good"),
      ...ISSUES.map((i) => kpi(i.key, i.kAr, i.kEn, counts[i.key], "count", counts[i.key] ? "warn" : "good")),
    ],
    charts: [{
      key: "by_issue", type: "hbar", unit: "count",
      title: { ar: "النواقص حسب النوع", en: "Gaps by type" },
      series: [{ key: "records", label: { ar: "السجلات", en: "Records" }, color: C.warn }],
      data: ISSUES.map((i) => ({ label: i.kAr, labelEn: i.kEn, records: counts[i.key] })),
    }],
    columns: [
      col("entity", "النوع", "Entity", "status", ENTITY_MAP), col("record", "السجل", "Record", "text"),
      col("missing", "البيانات الناقصة", "Missing", "text"), col("issues", "عدد النواقص", "Gaps", "number"),
    ],
    rows, totals: { issues: rows.reduce((s, r) => s + (r.issues as number), 0) },
    notes: [
      { ar: "العقود الملغاة لا تُفحص؛ «وحدة مرتبطة» تُفحص للعقود السارية فقط. الوحدة بلا استخدام خاص تأخذ استخدام عقارها.", en: "Cancelled contracts are not checked; \"linked unit\" is checked for active contracts only. A unit with no usage of its own inherits its property's." },
      { ar: "عند التصفية يظهر المستأجرون المرتبطون بعقود ضمن النطاق فقط.", en: "Under a filter, only tenants on contracts in scope are checked." },
      NOTE.drafts,
    ],
  };
}

export const BUILDERS: Record<OpsReportId, (ds: OpsDataset, p: ResolvedParams) => Body> = {
  tenant_balances: tenantBalances,
  defaulting_tenants: defaultingTenants,
  tenant_payment_behavior: tenantPaymentBehavior,
  landlord_portfolio: landlordPortfolio,
  vacant_units: vacantUnits,
  property_performance: propertyPerformance,
  occupancy_trend: occupancyTrend,
  contracts_report: contractsReport,
  expiring_contracts: expiringContracts,
  contract_movement: contractMovement,
  collections_summary: collectionsSummary,
  installments_schedule: installmentsSchedule,
  maintenance_requests: maintenanceRequests,
  data_quality: dataQuality,
};

/** Which reports need the installment / maintenance reads (the rest skip them). */
export const NEEDS: Partial<Record<OpsReportId, { installments?: boolean; maintenance?: boolean }>> = {
  tenant_balances: { installments: true }, defaulting_tenants: { installments: true },
  tenant_payment_behavior: { installments: true }, landlord_portfolio: { installments: true },
  property_performance: { installments: true }, collections_summary: { installments: true },
  installments_schedule: { installments: true }, maintenance_requests: { maintenance: true },
};

export type { ContractLike };
