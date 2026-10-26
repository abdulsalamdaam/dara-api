import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { appSettingsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import {
  ADDON_CATALOG_KEY, catalogView, coerceCatalogEntry, readAddonCatalog, type CatalogEntry, type CatalogItem,
} from "../../common/addon-catalog";

/**
 * The add-on catalog in `app_settings` (`limit_addon_catalog`), like
 * TrialSettingsService. Reads degrade to the defaults; writes are validated
 * strictly — a bad item is a 400, never silently dropped.
 */
@Injectable()
export class AddonCatalogService {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /** Stored entries (no VAT figures). */
  entries(): Promise<CatalogEntry[]> {
    return readAddonCatalog(this.db);
  }

  async get(): Promise<{ items: CatalogItem[] }> {
    return { items: catalogView(await this.entries()) };
  }

  async find(key: string): Promise<CatalogEntry | null> {
    return (await this.entries()).find((e) => e.key === key) ?? null;
  }

  async set(body: unknown): Promise<{ items: CatalogItem[] }> {
    const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).items : null;
    if (!Array.isArray(raw)) throw new BadRequestException("items must be an array");
    if (raw.length > 50) throw new BadRequestException("at most 50 catalog items");
    const items: CatalogEntry[] = [];
    const seen = new Set<string>();
    raw.forEach((r, i) => {
      const e = coerceCatalogEntry(r);
      if (!e) throw new BadRequestException(`items[${i}] is invalid (key, limitKey, quantity > 0, priceSar ≥ 0 or null)`);
      if (seen.has(e.key)) throw new BadRequestException(`items[${i}]: duplicate key ${e.key}`);
      seen.add(e.key);
      items.push(e);
    });
    await this.db
      .insert(appSettingsTable)
      .values({ key: ADDON_CATALOG_KEY, value: { items } as never })
      .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: { items } as never, updatedAt: sql`now()` } });
    return { items: catalogView(items) };
  }
}
