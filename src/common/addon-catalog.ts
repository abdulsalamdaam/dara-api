/**
 * The add-on catalog: what an account can buy (or be offered) on top of its
 * package limits. Stored in `app_settings` under `limit_addon_catalog` as
 * `{ items: [...] }` and edited from the admin console.
 *
 * Prices are BEFORE VAT; VAT is added at charge time with chargedVatRate(), so
 * the catalog never has to change when Dara's VAT status does. A null price
 * means "not for sale" — the item exists (an admin can still grant it free)
 * but self-serve purchase and the auto-offer skip it. Both defaults ship
 * unpriced.
 *
 * Seat items (`period: subscription_period`) are priced PER MONTH and
 * pro-rated to the rest of the paid period by the billing side; one-off items
 * (Ejar packs) are priced as a whole.
 */
import { eq } from "drizzle-orm";
import { appSettingsTable } from "@dara/database";
import type { Drizzle } from "../database/database.module";
import { chargedVatRate } from "./packages";
import { isLimitKey, type LimitKey } from "./limit-core";

export const ADDON_CATALOG_KEY = "limit_addon_catalog";

export type CatalogPeriod = "subscription_period" | "one_off";

/** One catalog entry as stored. */
export interface CatalogEntry {
  key: string;
  limitKey: LimitKey;
  quantity: number;
  /** SAR before VAT (per month for subscription_period items); null = not for sale. */
  priceSar: number | null;
  period: CatalogPeriod;
  labelAr: string;
  labelEn: string;
  active: boolean;
}

/** As the API returns it: plus the VAT-inclusive amount of `priceSar`. */
export interface CatalogItem extends CatalogEntry {
  amountInclVat: number | null;
}

export const DEFAULT_ADDON_CATALOG: readonly CatalogEntry[] = [
  { key: "seat_1", limitKey: "users", quantity: 1, priceSar: null, period: "subscription_period", labelAr: "مستخدم إضافي", labelEn: "Extra user", active: true },
  { key: "ejar_50", limitKey: "ejar_lookups", quantity: 50, priceSar: null, period: "one_off", labelAr: "50 استعلام إيجار", labelEn: "50 Ejar lookups", active: true },
];

const KEY_RE = /^[a-z0-9_]{1,40}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** One entry, or null when it cannot be used. Never throws (stored JSON is hostile input). */
export function coerceCatalogEntry(raw: unknown): CatalogEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const key = str(r.key, 40);
  if (!KEY_RE.test(key) || !isLimitKey(r.limitKey)) return null;
  const quantity = Math.floor(Number(r.quantity));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 100_000) return null;
  let priceSar: number | null = null;
  if (r.priceSar != null && r.priceSar !== "") {
    const p = Number(r.priceSar);
    if (!Number.isFinite(p) || p < 0 || p > 1_000_000) return null;
    priceSar = Math.round(p * 100) / 100;
  }
  const period: CatalogPeriod = r.period === "one_off" ? "one_off" : "subscription_period";
  return {
    key, limitKey: r.limitKey, quantity, priceSar, period,
    labelAr: str(r.labelAr, 120) || key, labelEn: str(r.labelEn, 120) || key,
    active: r.active !== false,
  };
}

/**
 * The stored blob → entries. Missing / unreadable → the defaults; an explicit
 * empty list stays empty. Duplicate keys keep the first.
 */
export function coerceCatalog(value: unknown): CatalogEntry[] {
  const items = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).items : value;
  if (!Array.isArray(items)) return DEFAULT_ADDON_CATALOG.map((e) => ({ ...e }));
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const raw of items) {
    const e = coerceCatalogEntry(raw);
    if (e && !seen.has(e.key)) { seen.add(e.key); out.push(e); }
  }
  return out;
}

/** `priceSar` with VAT added (to the halala), or the price itself while no VAT is charged. */
export function amountInclVat(priceSar: number | null, vatRate: number | null = chargedVatRate()): number | null {
  if (priceSar == null) return null;
  return vatRate == null ? priceSar : Math.round(priceSar * (100 + vatRate)) / 100;
}

export function catalogView(entries: CatalogEntry[], vatRate: number | null = chargedVatRate()): CatalogItem[] {
  return entries.map((e) => ({ ...e, amountInclVat: amountInclVat(e.priceSar, vatRate) }));
}

/** The catalog. A read failure degrades to the defaults — a gate's 400 must never turn into a 500 here. */
export async function readAddonCatalog(db: Drizzle): Promise<CatalogEntry[]> {
  try {
    const [row] = await db.select({ value: appSettingsTable.value }).from(appSettingsTable)
      .where(eq(appSettingsTable.key, ADDON_CATALOG_KEY)).limit(1);
    return coerceCatalog(row?.value ?? null);
  } catch {
    return DEFAULT_ADDON_CATALOG.map((e) => ({ ...e }));
  }
}

/** Whether something is for sale for `key` — what a refusing gate reports as `addonAvailable`. */
export function catalogHasAddon(entries: CatalogEntry[], key: LimitKey): boolean {
  return entries.some((e) => e.active && e.limitKey === key && e.priceSar != null);
}

export async function addonAvailable(db: Drizzle, key: LimitKey): Promise<boolean> {
  return catalogHasAddon(await readAddonCatalog(db), key);
}
