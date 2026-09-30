import { ConflictException, ForbiddenException, Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { FV2_POOL, type Fv2Client, type Fv2Pool } from "./db";
import { riyadhToday } from "./dates";
import { auditRow, isoDate, requireReason, settingsEvent } from "./audit";
import { capabilities } from "./capabilities";
import { ReconciliationService } from "./reports/reconciliation.service";
import { riyadhNow } from "./reports/core-math";
import { langOf, type Lang } from "./reports/common";
import { BackfillService } from "./backfill/backfill.service";

/**
 * The accountant's control checks (his sheet "فحوصات الرقابة", 21 checks) and
 * his rule: "the system runs the checks automatically and blocks closing if
 * there is a difference".
 *
 *  - The 21 rows map onto the reconciliation report's checks (R1–R21,
 *    reports/reconciliation.service.ts + reports/control-checks.ts); a few of
 *    his rows are the same v2 check seen from two sides (#4 and #10 → R1,
 *    #5 and #12 → R2, #6 and #11 → R3, #7 and #9 → R11). R4–R7 are v2's own
 *    extra checks, shown under the 21.
 *  - Blocking: a check whose status is `difference` or `attention`, except
 *    R7 (integrity lists, informational). `not_applicable` passes;
 *    `unavailable` (no sub-ledger to compare with) neither passes nor blocks.
 *  - Nightly: after the 03:30 repair sweep (BackfillService.onSweepDone), or at
 *    05:00 Riyadh when the sweep is switched off, every started flag-on account
 *    is checked as of today and the result stored (finance_control_runs).
 *    Nothing is sent to anyone. `FINANCE_V2_WORKER_DISABLED=1` or
 *    `FINANCE_V2_CONTROLS_DISABLED=1` switches the timer off.
 *  - Period close refuses (409 CONTROL_CHECKS_FAILED) while a check blocks. A
 *    user with the `settings` capability (v2's finance-admin capability,
 *    DESIGN §10.1) may override with a written reason; the override is a
 *    finance_settings_events row plus an audit_logs row, and the run is stored
 *    with trigger `period_close_override`.
 */

export interface ControlRow {
  no: number | null;
  checkId: string;
  key: string;
  label: string;
  value1: string | null;
  value2: string | null;
  difference: string | null;
  unit: "money" | "count";
  status: string;
  result: "pass" | "fail" | "not_applicable" | "unavailable";
  blocking: boolean;
  rows: any[];
  explanations: any[];
  notes: string[];
}

export interface ControlEvaluation {
  report: "control-checks";
  lang: Lang;
  generatedAt: string;
  params: { asOf: string };
  checks: ControlRow[];
  additional: ControlRow[];
  summary: { total: number; passed: number; failed: number; notApplicable: number; unavailable: number };
  /** Check ids that block closing. */
  blocking: string[];
}

/** His 21 rows (label text in v2's account codes) → the v2 check behind each. */
export const CONTROL_ROWS: ReadonlyArray<{ no: number; checkId: string; ar: string; en: string }> = [
  { no: 1, checkId: "R8", ar: "دفتر اليومية متوازن (مجموع المدين = مجموع الدائن)", en: "Journal balanced (total debits = total credits)" },
  { no: 2, checkId: "R9", ar: "ميزان المراجعة متوازن (الأرصدة الختامية)", en: "Trial balance balanced (closing balances)" },
  { no: 3, checkId: "R10", ar: "المركز المالي متوازن (الأصول = الخصوم + حقوق الملكية)", en: "Balance sheet balanced (assets = liabilities + equity)" },
  { no: 4, checkId: "R1", ar: "ذمم المستأجرين (1121 + 1122) = مجموع أرصدة المستأجرين", en: "Tenant receivables (1121 + 1122) = sum of tenant balances" },
  { no: 5, checkId: "R2", ar: "تأمينات المستأجرين (2141) = مجموع تأمينات العقود", en: "Tenant deposits (2141) = sum of contract deposits" },
  { no: 6, checkId: "R3", ar: "مستحقات الملاك (2121) = مجموع أرصدة الملاك", en: "Landlord payable (2121) = sum of landlord balances" },
  { no: 7, checkId: "R11", ar: "حصة الملاك من الإيجارات غير المحصّلة (2122) = مجموع أرصدة الملاك", en: "Landlord share of uncollected rent (2122) = sum of landlord balances" },
  { no: 8, checkId: "R12", ar: "الموردون (2111) = مجموع أرصدة الموردين", en: "Suppliers (2111) = sum of supplier balances" },
  { no: 9, checkId: "R11", ar: "ذمم المستأجرين المُدارة (1122) = إيجارات الملاك تحت التحصيل (2122)", en: "Managed tenant receivables (1122) = landlord rent under collection (2122)" },
  { no: 10, checkId: "R1", ar: "أعمار الديون = ذمم المستأجرين", en: "AR aging = tenant receivables" },
  { no: 11, checkId: "R3", ar: "كشف الملاك (الرصيد المستحق) = حساب 2121", en: "Landlord statement (balance due) = account 2121" },
  { no: 12, checkId: "R2", ar: "تقرير التأمينات = حساب 2141", en: "Deposits report = account 2141" },
  { no: 13, checkId: "R13", ar: "النقدية آخر الفترة في التدفقات = أرصدة البنوك والصندوق", en: "Cash-flow closing cash = bank and cash balances" },
  { no: 14, checkId: "R14", ar: "قائمة الدخل = حسابات الإيرادات والمصروفات في الميزان", en: "Income statement = revenue and expense accounts in the trial balance" },
  { no: 15, checkId: "R15", ar: "تسوية البنك: الرصيد المعدل للبنك = الرصيد المعدل للدفاتر", en: "Bank reconciliation: adjusted bank balance = adjusted book balance" },
  { no: 16, checkId: "R16", ar: "أموال العملاء: رصيد الأمانات = مستحق الملاك + التأمينات − تحت التسوية + عمولات لم تُحوّل + مصروفات ملاك غير مسددة", en: "Client money: trust balance = landlord payable + deposits − in transit + commission not transferred + unpaid landlord expenses" },
  { no: 17, checkId: "R17", ar: "لا يوجد تكرار في أرقام المستندات", en: "No duplicate document numbers" },
  { no: 18, checkId: "R18", ar: "كل فاتورة إيجار مرتبطة بقسط من جدول الأقساط", en: "Every rent invoice is linked to an installment" },
  { no: 19, checkId: "R19", ar: "لا توجد أقساط مستحقة لم تُفوتر", en: "No installments due but not invoiced" },
  { no: 20, checkId: "R20", ar: "لا توجد مستندات بتاريخ داخل الفترة المقفلة", en: "No documents dated inside a closed period" },
  { no: 21, checkId: "R21", ar: "كل سطور القيود على حسابات تقبل الترحيل", en: "Every journal line is on a postable account" },
];

/** v2's own checks outside his 21, shown beneath them. */
const ADDITIONAL = ["R4", "R5", "R6", "R7"];
/** Lists only: never blocks. */
const INFORMATIONAL = new Set(["R7"]);

const CHECK_MS = 60_000;
/** The fallback time (Riyadh) when the repair sweep never signals: 05:00. */
const FALLBACK_AT_MIN = 5 * 60;
/** Nightly runs older than this are pruned. */
const KEEP_DAYS = 400;

/** v2's finance-admin capability (`settings`, DESIGN §10.1): may override a failed control check at close. */
export function canOverrideControls(user: AuthUser): boolean {
  return capabilities(user).includes("settings");
}

function resultOf(status: string, id: string): ControlRow["result"] {
  if (status === "ok") return "pass";
  if (status === "not_applicable") return "not_applicable";
  if (status === "unavailable") return "unavailable";
  return INFORMATIONAL.has(id) ? "pass" : "fail";
}

@Injectable()
export class ControlChecksService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("FinanceV2Controls");
  private timer: NodeJS.Timeout | null = null;
  private lastRunDay: string | null = null;
  private running = false;

  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly recon: ReconciliationService,
    @Optional() private readonly backfill?: BackfillService,
  ) {}

  onModuleInit(): void {
    if (process.env.FINANCE_V2_WORKER_DISABLED === "1" || process.env.FINANCE_V2_CONTROLS_DISABLED === "1") return;
    if (this.backfill) this.backfill.onSweepDone = (day) => this.runNightly(day);
    this.timer = setInterval(() => void this.maybeFallback(), CHECK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.backfill?.onSweepDone) this.backfill.onSweepDone = null;
  }

  // ── evaluation ──────────────────────────────────────────────────────────

  /** Every check as of `asOf`, in the accountant's layout. Read-only. */
  async evaluate(scope: number, asOf: string, lang: Lang = "ar", today = riyadhToday()): Promise<ControlEvaluation> {
    const r: any = await this.recon.reconciliation(scope, { asOf, lang });
    const byId = new Map<string, any>(r.checks.map((c: any) => [c.id, c]));
    if (asOf < today && byId.has("R3") && byId.get("R3").status !== "not_applicable") {
      // The landlord-dues report has no history (R3's sub-ledger is always "now"), so a past date would always differ:
      // compare the ledger with it today instead.
      const now: any = await this.recon.reconciliation(scope, { asOf: today, lang, only: "R3" });
      const c = now.checks[0];
      if (c) byId.set("R3", { ...c, notes: [...c.notes.filter((n: string) => n !== "dues_report_is_current_not_as_of"), `compared_today:${today}`] });
    }
    const row = (c: any, no: number | null, label: string): ControlRow => ({
      no, checkId: c.id, key: c.key, label, value1: c.ledger, value2: c.subLedger, difference: c.difference,
      unit: c.unit ?? (c.id === "R6" ? "count" : "money"), status: c.status, result: resultOf(c.status, c.id),
      blocking: resultOf(c.status, c.id) === "fail", rows: c.rows, explanations: c.explanations, notes: c.notes,
    });
    const checks = CONTROL_ROWS.filter((x) => byId.has(x.checkId)).map((x) => row(byId.get(x.checkId), x.no, lang === "en" ? x.en : x.ar));
    const additional = ADDITIONAL.filter((id) => byId.has(id)).map((id) => row(byId.get(id), null, byId.get(id).label));
    const blocking = [...new Set([...checks, ...additional].filter((c) => c.blocking).map((c) => c.checkId))]
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    return {
      report: "control-checks", lang, generatedAt: riyadhNow(), params: { asOf }, checks, additional,
      summary: {
        total: checks.length,
        passed: checks.filter((c) => c.result === "pass" || c.result === "not_applicable").length,
        failed: checks.filter((c) => c.result === "fail").length,
        notApplicable: checks.filter((c) => c.result === "not_applicable").length,
        unavailable: checks.filter((c) => c.result === "unavailable").length,
      },
      blocking,
    };
  }

  /** GET /finance/v2/reports/control-checks?asOf&lang: the checks now, and the last stored run. */
  async report(scope: number, q: Record<string, any> = {}) {
    const asOf = q.asOf ? isoDate(q.asOf, "asOf") : riyadhToday();
    const ev = await this.evaluate(scope, asOf, langOf(q.lang));
    return { ...ev, lastRun: await this.latest(scope) };
  }

  // ── stored runs ─────────────────────────────────────────────────────────

  /** Evaluate and store one run. In `c` when given (a period close stores its run in the close transaction). */
  async run(scope: number, asOf: string, trigger: "nightly" | "manual", actorId: number | null = null) {
    const t0 = Date.now();
    try {
      const ev = await this.evaluate(scope, asOf);
      const id = await this.store(this.pool, scope, asOf, trigger, ev, { actorId, ms: Date.now() - t0 });
      return { runId: id, ...ev };
    } catch (err: any) {
      await this.pool.query(
        `insert into finance_control_runs (user_id, as_of, trigger, ran_by, duration_ms, error) values ($1, $2, $3, $4, $5, $6)`,
        [scope, asOf, trigger, actorId, Date.now() - t0, String(err?.message ?? err).slice(0, 500)]);
      throw err;
    }
  }

  async store(c: Pick<Fv2Client, "query"> | Fv2Pool, scope: number, asOf: string, trigger: string, ev: ControlEvaluation, o: { actorId?: number | null; periodId?: number | null; ms?: number | null } = {}): Promise<number> {
    const results = ev.checks.map((x) => ({ no: x.no, checkId: x.checkId, status: x.status, value1: x.value1, value2: x.value2, difference: x.difference, unit: x.unit }))
      .concat(ev.additional.map((x) => ({ no: null, checkId: x.checkId, status: x.status, value1: x.value1, value2: x.value2, difference: x.difference, unit: x.unit })));
    const r = await c.query(
      `insert into finance_control_runs (user_id, as_of, trigger, period_id, ran_by, total, passed, failed, not_applicable, failing, results, duration_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::jsonb, $12) returning id`,
      [scope, asOf, trigger, o.periodId ?? null, o.actorId ?? null, ev.summary.total, ev.summary.passed, ev.summary.failed, ev.summary.notApplicable,
        ev.blocking, JSON.stringify(results), o.ms ?? null]);
    return Number(r.rows[0].id);
  }

  /** The last stored run (for the dashboard): when, as of when, and how many checks fail. Null before the first run. */
  async latest(scope: number) {
    const r = await this.pool.query(
      `select id, to_char(as_of, 'YYYY-MM-DD') as as_of, trigger, period_id, ran_at, total, passed, failed, not_applicable, failing, error
         from finance_control_runs where user_id = $1 order by ran_at desc, id desc limit 1`, [scope]);
    const x = r.rows[0];
    if (!x) return null;
    return {
      id: Number(x.id), asOf: x.as_of, trigger: x.trigger, periodId: x.period_id ?? null, ranAt: new Date(x.ran_at).toISOString(),
      total: x.total, passed: x.passed, failed: x.failed, notApplicable: x.not_applicable, failing: x.failing ?? [], error: x.error ?? null,
    };
  }

  // ── nightly ─────────────────────────────────────────────────────────────

  /** Every started flag-on account, as of today. Called by the repair sweep when it finishes, or by the fallback. */
  async runNightly(day = riyadhToday()): Promise<number> {
    if (this.running || this.lastRunDay === day) return 0;
    this.running = true;
    let n = 0;
    try {
      const r = await this.pool.query(`select account_user_id from finance_settings where finance_v2_enabled and ledger_started_at is not null order by 1`);
      for (const x of r.rows) {
        try {
          const res = await this.run(Number(x.account_user_id), day, "nightly");
          n++;
          if (res.blocking.length) this.log.log(`finance v2 control checks for scope ${x.account_user_id}: ${res.blocking.join(", ")} failing`);
        } catch (err: any) {
          this.log.warn(`finance v2 control checks failed for scope ${x.account_user_id}: ${err?.message ?? err}`);
        }
      }
      await this.pool.query(`delete from finance_control_runs where trigger in ('nightly','manual') and ran_at < now() - make_interval(days => $1)`, [KEEP_DAYS]);
      this.lastRunDay = day;
    } catch (err: any) {
      if (err?.code !== "42P01") this.log.warn(`finance v2 control checks run failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
    return n;
  }

  private async maybeFallback(): Promise<void> {
    const day = riyadhToday();
    const [h, m] = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Riyadh", hour12: false }).split(":").map(Number);
    if (this.lastRunDay === day || h * 60 + m < FALLBACK_AT_MIN) return;
    await this.runNightly(day);
  }

  // ── the period-close gate ───────────────────────────────────────────────

  /**
   * Run every check as of the period end. Nothing blocks → the evaluation. A check blocks and no override was
   * asked for → 409 CONTROL_CHECKS_FAILED with the failing checks. Override asked for: the finance-admin capability
   * and a written reason (5–500 characters) are required.
   */
  async gate(scope: number, user: AuthUser, period: { id: number; endsOn: string }, body: any, today = riyadhToday()) {
    const ev = await this.evaluate(scope, period.endsOn, langOf(body?.lang), today);
    if (!ev.blocking.length) return { ev, override: null as null | { reason: string } };
    const failing = [...ev.checks, ...ev.additional].filter((c) => c.blocking).map((c) => ({
      no: c.no, checkId: c.checkId, label: c.label, value1: c.value1, value2: c.value2, difference: c.difference, unit: c.unit, status: c.status,
      items: c.rows.slice(0, 20),
    }));
    const allowed = canOverrideControls(user);
    if (body?.override !== true) {
      throw new ConflictException({
        error: "CONTROL_CHECKS_FAILED",
        message: `${ev.blocking.length} control check(s) fail as of ${period.endsOn}: ${ev.blocking.join(", ")}`,
        failing, blocking: ev.blocking, summary: ev.summary, canOverride: allowed,
      });
    }
    if (!allowed) throw new ForbiddenException({ error: "OVERRIDE_NOT_ALLOWED", message: "Only a finance administrator may close a period over failed control checks" });
    const reason = requireReason(body, "overrideReason");
    return { ev, override: { reason } };
  }

  /** In the close transaction: store the run; an override also writes its settings event and audit row. */
  async recordGate(c: Pick<Fv2Client, "query">, scope: number, user: AuthUser, period: { id: number; endsOn: string }, g: { ev: ControlEvaluation; override: { reason: string } | null }, path: string) {
    await this.store(c, scope, period.endsOn, g.override ? "period_close_override" : "period_close", g.ev, { actorId: user.id, periodId: period.id });
    if (g.override) {
      await settingsEvent(c, scope, user.id, "period_close_override", { periodId: period.id, failing: g.ev.blocking },
        { periodId: period.id, status: "closed", asOf: period.endsOn }, g.override.reason);
      await auditRow(c, scope, user.id, "finance_v2_period_override", period.id, path);
    }
    return { passed: g.ev.summary.passed, total: g.ev.summary.total, failing: g.ev.blocking, overridden: !!g.override };
  }
}
