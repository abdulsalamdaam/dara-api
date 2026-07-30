import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { appSettingsTable } from "@oqudk/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { EjarClientService } from "./ejar.client.service";

/** Admin override for manual record creation. */
export type ManualAddOverride = "auto" | "force_enabled" | "force_disabled";

export interface EjarHealthState {
  ok: boolean;
  checkedAt: string | null;
  status: number | null;
  detail: string | null;
}

export interface ManualAddPolicy {
  /** Whether the six "Add" buttons should work right now. */
  enabled: boolean;
  /** Why — drives the status indicator the user sees. */
  reason: "admin_forced_on" | "admin_forced_off" | "ejar_down" | "ejar_healthy" | "unknown";
  override: ManualAddOverride;
  health: EjarHealthState;
}

const KEY_OVERRIDE = "manual_add_override";
const KEY_HEALTH = "ejar_health";
/** UAT contract used purely as a cheap "is the gateway answering" ping. */
const HEALTH_CONTRACT = "10732702933";
const HOUR_MS = 60 * 60 * 1000;

/**
 * Owns two pieces of state and the rule that combines them:
 *
 *   - the hourly Ejar connectivity check (cached, never blocking a request)
 *   - the super-admin override
 *
 * Precedence is **admin override > health > default (disabled)**. The default
 * is disabled because every record is supposed to come from Ejar; the health
 * fallback exists so a gateway outage doesn't stop the business from working.
 *
 * The interval is a plain timer rather than @nestjs/schedule — one job does not
 * justify a new dependency, and unref() keeps it from holding the process open.
 */
@Injectable()
export class EjarPolicyService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("EjarPolicy");
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly client: EjarClientService,
  ) {}

  onModuleInit() {
    // Probe shortly after boot (not during it — a slow gateway must not delay
    // startup), then hourly.
    setTimeout(() => void this.refreshHealth(), 10_000).unref?.();
    this.timer = setInterval(() => void this.refreshHealth(), HOUR_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Ping Ejar and cache the verdict. Never throws — this runs unattended. */
  async refreshHealth(): Promise<EjarHealthState> {
    let state: EjarHealthState;
    try {
      const { log } = await this.client.request(
        "nationalAddress",
        { contractNumber: HEALTH_CONTRACT, partyType: 0 },
        { skipLog: true },
      );
      const status = (log as { status?: number }).status ?? null;
      state = { ok: true, checkedAt: new Date().toISOString(), status, detail: null };
    } catch (err) {
      const e = err as { status?: number; message?: string };
      state = {
        ok: false,
        checkedAt: new Date().toISOString(),
        status: e?.status ?? null,
        detail: e?.message ?? "unreachable",
      };
      this.log.warn(`Ejar health check failed: ${state.detail}`);
    }
    await this.put(KEY_HEALTH, state);
    return state;
  }

  async getHealth(): Promise<EjarHealthState> {
    return (await this.get<EjarHealthState>(KEY_HEALTH)) ?? { ok: false, checkedAt: null, status: null, detail: null };
  }

  async getOverride(): Promise<ManualAddOverride> {
    const v = await this.get<{ value: ManualAddOverride }>(KEY_OVERRIDE);
    const val = v?.value;
    return val === "force_enabled" || val === "force_disabled" ? val : "auto";
  }

  async setOverride(value: ManualAddOverride): Promise<ManualAddOverride> {
    await this.put(KEY_OVERRIDE, { value });
    return value;
  }

  /** The rule. Admin wins; otherwise a failing gateway unlocks manual entry. */
  async getPolicy(): Promise<ManualAddPolicy> {
    const [override, health] = await Promise.all([this.getOverride(), this.getHealth()]);
    if (override === "force_enabled") return { enabled: true, reason: "admin_forced_on", override, health };
    if (override === "force_disabled") return { enabled: false, reason: "admin_forced_off", override, health };
    // Never checked yet → treat as unknown and keep manual entry available
    // rather than locking everyone out on a fresh deploy.
    if (!health.checkedAt) return { enabled: true, reason: "unknown", override, health };
    return health.ok
      ? { enabled: false, reason: "ejar_healthy", override, health }
      : { enabled: true, reason: "ejar_down", override, health };
  }

  private async get<T>(key: string): Promise<T | null> {
    const [row] = await this.db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key)).limit(1);
    return (row?.value as T) ?? null;
  }

  private async put(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(appSettingsTable)
      .values({ key, value: value as never })
      .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: value as never, updatedAt: sql`now()` } });
  }
}
