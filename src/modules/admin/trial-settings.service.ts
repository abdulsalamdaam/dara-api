import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { appSettingsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { coerceTrialSettings, DEFAULT_TRIAL_DAYS, TRIAL_SETTING_KEY, type TrialSettings } from "../../common/trial";

/**
 * The platform-wide trial policy, kept in `app_settings` next to the Ejar
 * manual-add override — one row, one JSON value, global by design: how long a
 * free trial runs is a property of the offer, not of a customer.
 */
@Injectable()
export class TrialSettingsService {
  private readonly log = new Logger("TrialSettings");

  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /**
   * The current policy, or the default when nothing has been configured.
   *
   * Every registration approval calls this, so it must never be the reason an
   * approval fails: a missing row, a malformed value or a database hiccup all
   * degrade to the built-in default rather than throwing.
   */
  async getTrialSettings(): Promise<TrialSettings> {
    try {
      const [row] = await this.db
        .select()
        .from(appSettingsTable)
        .where(eq(appSettingsTable.key, TRIAL_SETTING_KEY))
        .limit(1);
      return coerceTrialSettings(row?.value ?? null);
    } catch (err: any) {
      this.log.warn(`reading the trial policy failed, falling back to the default: ${err?.message || err}`);
      return { days: DEFAULT_TRIAL_DAYS, enabled: true };
    }
  }

  /** Save the policy. Coerced on the way in so a bad write can't poison reads. */
  async setTrialSettings(next: TrialSettings): Promise<TrialSettings> {
    const value = coerceTrialSettings(next);
    await this.db
      .insert(appSettingsTable)
      .values({ key: TRIAL_SETTING_KEY, value: value as never })
      .onConflictDoUpdate({
        target: appSettingsTable.key,
        set: { value: value as never, updatedAt: sql`now()` },
      });
    return value;
  }
}
