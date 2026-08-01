/**
 * Resolve a stored text value (a lookup key OR an Arabic label) to its
 * lookup row id, so create/update endpoints can keep the `*_lookup_id`
 * foreign keys authoritative regardless of what the client sends.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { lookupsTable } from "@dara/database";
import type { Drizzle } from "../database/database.module";

export async function resolveLookupId(
  db: Drizzle,
  category: string,
  value: unknown,
): Promise<number | null> {
  if (value == null || value === "") return null;
  const v = String(value);
  const [row] = await db
    .select({ id: lookupsTable.id })
    .from(lookupsTable)
    .where(and(
      eq(lookupsTable.category, category),
      isNull(lookupsTable.companyId),
      or(eq(lookupsTable.key, v), eq(lookupsTable.labelAr, v)),
    ))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Reverse direction — given rows that carry `*_lookup_id` fields, attach
 * the human value (lookup `key` or Arabic label) under an output field,
 * so API responses keep the same shape they had with the old text
 * columns. One batched query for all referenced lookups.
 */
export async function attachLookupLabels<T extends Record<string, any>>(
  db: Drizzle,
  rows: T[],
  spec: { idField: string; out: string; mode: "key" | "labelAr" }[],
): Promise<T[]> {
  const ids = new Set<number>();
  for (const r of rows) {
    for (const s of spec) {
      const v = r[s.idField];
      if (typeof v === "number") ids.add(v);
    }
  }
  if (ids.size === 0) {
    for (const r of rows) for (const s of spec) (r as any)[s.out] = null;
    return rows;
  }
  const lks = await db
    .select({ id: lookupsTable.id, key: lookupsTable.key, labelAr: lookupsTable.labelAr })
    .from(lookupsTable)
    .where(inArray(lookupsTable.id, [...ids]));
  const map = new Map(lks.map((l) => [l.id, l]));
  for (const r of rows) {
    for (const s of spec) {
      const v = r[s.idField];
      const l = typeof v === "number" ? map.get(v) : null;
      (r as any)[s.out] = l ? (s.mode === "labelAr" ? l.labelAr : l.key) : null;
    }
  }
  return rows;
}
