import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { riyadhToday } from "../dates";
import { AssetsService } from "./assets.service";
import { lastDueMonth } from "./asset-events";

const CHECK_MS = 60_000;
/** Minutes after Riyadh midnight when the daily run is due: 00:20, after the recognizer (00:10). */
const RUN_AFTER_MIN = 20;

/**
 * Automatic monthly depreciation (DESIGN §8.5; the accountant's "إهلاك
 * (شهري) — آلي نهاية كل شهر"). Once a day, for every account whose flag is on,
 * whose ledger has started and that has assets, it queues every missing
 * `dep:YYYY-MM` through the last month whose end has passed (so on the 1st it
 * books the month just ended, dated its last day, and it catches up any month
 * missed while the API was down). Idempotent per asset and month.
 *
 * Kill switches (value `1`): FINANCE_V2_WORKER_DISABLED (all v2 jobs) or
 * FINANCE_V2_DEPRECIATION_DISABLED (this job only). The manual "run for
 * month" in the UI works either way; the worker must be running to post.
 */
@Injectable()
export class DepreciationJobService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("FinanceV2Depreciation");
  private timer: NodeJS.Timeout | null = null;
  private lastRunDay: string | null = null;
  private running = false;

  constructor(private readonly assets: AssetsService) {}

  static disabled(): boolean {
    return process.env.FINANCE_V2_WORKER_DISABLED === "1" || process.env.FINANCE_V2_DEPRECIATION_DISABLED === "1";
  }

  onModuleInit(): void {
    if (DepreciationJobService.disabled()) return;
    this.timer = setInterval(() => void this.maybeRunDaily(), CHECK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async maybeRunDaily(): Promise<void> {
    const day = riyadhToday();
    const [h, m] = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Riyadh", hour12: false }).split(":").map(Number);
    if (this.lastRunDay === day || h * 60 + m < RUN_AFTER_MIN || this.running) return;
    this.running = true;
    try {
      await this.runAll(day);
      this.lastRunDay = day;
    } catch (err: any) {
      if (err?.code !== "42P01") this.log.warn(`depreciation run failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  /** Every eligible account, as of `today` (Riyadh). One account's failure never stops the others. */
  async runAll(today = riyadhToday()): Promise<Record<number, number>> {
    const out: Record<number, number> = {};
    for (const scope of await this.assets.jobAccounts()) {
      try {
        out[scope] = (await this.assets.runMonth(scope, null, lastDueMonth(today), "auto", today)).queued;
      } catch (err: any) {
        this.log.warn(`depreciation failed for scope ${scope}: ${err?.message ?? err}`);
      }
    }
    return out;
  }
}
