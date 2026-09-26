import { BadRequestException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { FV2_POOL, type Fv2Pool } from "../db";
import { FinanceFlagService } from "../flag.service";
import { isoDate } from "../audit";
import { fromHalalas, toHalalas } from "../money";
import { riyadhToday } from "../dates";
import { DEPOSIT_DESC } from "../hooks/classify";
import { envGateOn, REMINDER_SENDER, type ReminderChannel, type ReminderSender } from "./reminder-sender";

const CHANNELS: readonly ReminderChannel[] = ["sms", "push"];
const DEFAULT_OFFSETS = [-3, 0, 7];
const DEFAULT_AR = "عزيزي {tenant}، نذكّركم بقسط الإيجار بمبلغ {amount} ريال المستحق في {dueDate} للعقد {contract}.";
const DEFAULT_EN = "Dear {tenant}, a reminder that your rent installment of SAR {amount} is due on {dueDate} (contract {contract}).";
const DAY_MS = 86_400_000;

export interface ReminderGates {
  /** Gate 1: FINANCE_REMINDERS_ENABLED=1 in the environment (set nowhere). */
  env: boolean;
  /** Gate 2: reminder_settings.enabled (cannot be turned on while gate 1 is off). */
  setting: boolean;
  /** Gate 3: the account's finance_v2 flag. */
  flag: boolean;
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Scheduled rent reminders (DESIGN §8.3 b): BUILT BUT DISABLED.
 *
 *  - Three independent gates must ALL be true for the scheduler to act: the
 *    env switch (set nowhere), the account's setting (refused while the env
 *    switch is off), and the finance_v2 flag.
 *  - Even then the only sender bound is the dry run: it writes reminder_log
 *    rows with status 'dry_run' and a hashed recipient. Nothing leaves the
 *    server. A real sender is a later, separate change.
 *  - The daily timer is not even created unless gate 1 is on.
 */
@Injectable()
export class RemindersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("FinanceV2Reminders");
  private timer: NodeJS.Timeout | null = null;
  private lastRunDay: string | null = null;

  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly flag: FinanceFlagService,
    @Inject(REMINDER_SENDER) private readonly sender: ReminderSender,
  ) {}

  onModuleInit(): void {
    if (!envGateOn()) return; // gate 1 off: no timer at all
    this.timer = setInterval(() => void this.tick(), 15 * 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async gates(scope: number, settingEnabled?: boolean): Promise<ReminderGates> {
    const setting = settingEnabled ?? (await this.settingsRow(scope)).enabled;
    let flag = false;
    try {
      flag = await this.flag.isOn(scope);
    } catch {
      flag = false;
    }
    return { env: envGateOn(), setting, flag };
  }

  async getSettings(scope: number) {
    const s = await this.settingsRow(scope);
    const gates = await this.gates(scope, s.enabled);
    return {
      ...s, gates, active: gates.env && gates.setting && gates.flag, sender: this.sender.kind,
      canEnable: gates.env, comingSoon: !gates.env,
    };
  }

  async updateSettings(scope: number, body: any) {
    const cur = await this.settingsRow(scope);
    let enabled = cur.enabled;
    if (body?.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") throw new BadRequestException({ error: "BAD_INPUT", message: "enabled must be a boolean" });
      if (body.enabled && !envGateOn()) {
        throw new BadRequestException({
          error: "FINANCE_V2_REMINDERS_DISABLED",
          message: "التذكيرات غير مفعّلة على هذا الخادم (قريباً) · Rent reminders are not enabled on this server (coming soon)",
        });
      }
      enabled = body.enabled;
    }
    let offsets = cur.offsets;
    if (body?.offsets !== undefined) {
      if (!Array.isArray(body.offsets) || !body.offsets.length || body.offsets.length > 5) throw new BadRequestException({ error: "BAD_INPUT", message: "offsets: 1 to 5 whole days" });
      offsets = [...new Set(body.offsets.map(Number))] as number[];
      if (offsets.some((n) => !Number.isInteger(n) || n < -30 || n > 60)) throw new BadRequestException({ error: "BAD_INPUT", message: "offsets must be whole days between -30 and 60" });
      offsets.sort((a, b) => a - b);
    }
    let channels = cur.channels;
    if (body?.channels !== undefined) {
      if (!Array.isArray(body.channels) || !body.channels.length || body.channels.some((c: unknown) => !CHANNELS.includes(c as ReminderChannel))) {
        throw new BadRequestException({ error: "BAD_INPUT", message: `channels must be a non-empty subset of ${CHANNELS.join(", ")}` });
      }
      channels = [...new Set(body.channels as ReminderChannel[])];
    }
    const tpl = (v: unknown, cur: string | null) => {
      if (v === undefined) return cur;
      if (v === null || v === "") return null;
      if (typeof v !== "string" || v.length > 500) throw new BadRequestException({ error: "BAD_INPUT", message: "templates are at most 500 characters" });
      return v;
    };
    const templateAr = tpl(body?.templateAr, cur.templateAr);
    const templateEn = tpl(body?.templateEn, cur.templateEn);
    await this.pool.query(
      `insert into reminder_settings (user_id, enabled, offsets, channels, template_ar, template_en, updated_at) values ($1, $2, $3::int[], $4::text[], $5, $6, now())
       on conflict (user_id) do update set enabled = excluded.enabled, offsets = excluded.offsets, channels = excluded.channels,
         template_ar = excluded.template_ar, template_en = excluded.template_en, updated_at = now()`,
      [scope, enabled, `{${offsets.join(",")}}`, `{${channels.join(",")}}`, templateAr, templateEn],
    );
    return this.getSettings(scope);
  }

  /**
   * The installments that WOULD be reminded on `date` (default tomorrow,
   * Riyadh): open (pending / part-paid) rent installments of live contracts
   * whose due date is `date − offset` for one of the offsets. Read-only.
   */
  async preview(scope: number, dateRaw?: string) {
    const date = dateRaw ? isoDate(dateRaw, "date") : addDays(riyadhToday(), 1);
    const s = await this.settingsRow(scope);
    const rows = await this.candidates(scope, date, s.offsets);
    const gates = await this.gates(scope, s.enabled);
    return {
      date, offsets: s.offsets, channels: s.channels, gates, active: gates.env && gates.setting && gates.flag, sender: this.sender.kind,
      rows: rows.map((r) => ({
        paymentId: r.paymentId, contractId: r.contractId, contractNumber: r.contractNumber, tenantId: r.tenantId, tenantName: r.tenantName,
        dueDate: r.dueDate, offsetDays: r.offsetDays, remaining: r.remaining,
        channels: s.channels.filter((c) => (c === "sms" ? !!r.phone : !!r.pushToken)),
        phoneMasked: r.phone ? maskPhone(r.phone) : null, hasPushToken: !!r.pushToken,
        message: { ar: render(s.templateAr ?? DEFAULT_AR, r), en: render(s.templateEn ?? DEFAULT_EN, r) },
      })),
    };
  }

  /**
   * Run the reminders for `date` through the bound sender — which is the dry
   * run: reminder_log rows with status 'dry_run', nothing sent. Available to
   * the account (settings capability) regardless of the gates, because it
   * cannot send.
   */
  async dryRun(scope: number, dateRaw?: string) {
    const date = dateRaw ? isoDate(dateRaw, "date") : addDays(riyadhToday(), 1);
    return this.runFor(scope, date);
  }

  async log(scope: number, limit = 200) {
    const r = await this.pool.query(
      `select id, payment_id, offset_days, channel, status, created_at from reminder_log where user_id = $1 order by id desc limit $2`,
      [scope, Math.min(1000, Math.max(1, limit))],
    );
    return { rows: r.rows.map((x: any) => ({ id: Number(x.id), paymentId: x.payment_id, offsetDays: x.offset_days, channel: x.channel, status: x.status,
      createdAt: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at) })) };
  }

  /** The scheduler's tick: once per Riyadh day, every account whose three gates are all on. */
  async tick(): Promise<{ accounts: number; logged: number }> {
    if (!envGateOn()) return { accounts: 0, logged: 0 }; // gate 1, re-checked on every tick
    const day = riyadhToday();
    if (this.lastRunDay === day) return { accounts: 0, logged: 0 };
    this.lastRunDay = day;
    let accounts = 0;
    let logged = 0;
    try {
      const r = await this.pool.query(`select user_id from reminder_settings where enabled`);
      for (const x of r.rows) {
        const scope = Number(x.user_id);
        const g = await this.gates(scope, true);
        if (!(g.env && g.setting && g.flag)) continue;
        accounts++;
        logged += (await this.runFor(scope, day)).logged;
      }
    } catch (err: any) {
      if (err?.code !== "42P01") this.logger.warn(`finance v2 reminders tick failed: ${err?.message ?? err}`);
    }
    return { accounts, logged };
  }

  private async runFor(scope: number, date: string) {
    const s = await this.settingsRow(scope);
    const rows = await this.candidates(scope, date, s.offsets);
    let logged = 0;
    let attempts = 0;
    for (const r of rows) {
      for (const channel of s.channels) {
        const recipient = channel === "sms" ? r.phone : r.pushToken;
        if (!recipient) continue;
        attempts++;
        const res = await this.sender.send(this.pool, {
          userId: scope, paymentId: r.paymentId, offsetDays: r.offsetDays, channel, recipient,
          body: render((s.templateAr ?? DEFAULT_AR), r),
        });
        if (res.logged) logged++;
      }
    }
    return { date, sender: this.sender.kind, candidates: rows.length, attempts, logged, sent: 0 };
  }

  private async candidates(scope: number, date: string, offsets: number[]) {
    if (!offsets.length) return [];
    const dues = offsets.map((o) => addDays(date, -o));
    const r = await this.pool.query(
      `select p.id, p.contract_id, to_char(p.due_date,'YYYY-MM-DD') as due, p.amount::text as amount,
              (select coalesce(sum(pc.amount), 0)::text from payment_collections pc where pc.user_id = p.user_id and pc.payment_id = p.id) as collected,
              c.contract_number, c.tenant_id, t.name as tenant_name, t.phone, t.fcm_token
         from payments p join contracts c on c.id = p.contract_id and c.user_id = p.user_id
         left join tenants t on t.id = c.tenant_id and t.user_id = c.user_id
        where p.user_id = $1 and p.deleted_at is null and c.deleted_at is null and c.status::text = 'active'
          and p.status::text in ('pending','partially_paid') and coalesce(p.description, '') <> $2
          and to_char(p.due_date,'YYYY-MM-DD') = any($3::text[])
        order by p.due_date, p.id`,
      [scope, DEPOSIT_DESC, `{${dues.join(",")}}`],
    );
    const out = [];
    for (const x of r.rows) {
      const remaining = toHalalas(x.amount) - toHalalas(x.collected);
      if (remaining <= 0) continue;
      for (const o of offsets) {
        if (addDays(date, -o) !== x.due) continue;
        out.push({
          paymentId: Number(x.id), contractId: Number(x.contract_id), contractNumber: x.contract_number ?? null, tenantId: x.tenant_id ?? null,
          tenantName: x.tenant_name ?? null, dueDate: x.due, offsetDays: o, remaining: fromHalalas(remaining),
          phone: x.phone ? String(x.phone) : null, pushToken: x.fcm_token ? String(x.fcm_token) : null,
        });
      }
    }
    return out;
  }

  private async settingsRow(scope: number) {
    const r = await this.pool.query(
      `select enabled, offsets, channels, template_ar, template_en from reminder_settings where user_id = $1`, [scope]);
    const x = r.rows[0];
    return {
      enabled: x?.enabled === true,
      offsets: (x?.offsets ?? DEFAULT_OFFSETS).map(Number) as number[],
      channels: (x?.channels ?? ["sms"]) as ReminderChannel[],
      templateAr: (x?.template_ar ?? null) as string | null,
      templateEn: (x?.template_en ?? null) as string | null,
    };
  }
}

function render(tpl: string, r: { tenantName: string | null; remaining: string; dueDate: string; contractNumber: string | null }): string {
  return tpl.replace(/\{tenant\}/g, r.tenantName ?? "").replace(/\{amount\}/g, r.remaining).replace(/\{dueDate\}/g, r.dueDate).replace(/\{contract\}/g, r.contractNumber ?? "");
}

function maskPhone(p: string): string {
  const d = p.replace(/\s/g, "");
  return d.length <= 3 ? "***" : `${"*".repeat(Math.max(0, d.length - 3))}${d.slice(-3)}`;
}
