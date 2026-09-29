import { BadRequestException } from "@nestjs/common";
import { sqlOf } from "./hooks/sql";

/**
 * The v2 GET forks (DESIGN §9 E2/E3/E4) re-use the legacy handler's own
 * result and replace only the values the bug decisions change. The fork
 * calls the handler once more with the user marked, so that inner call takes
 * the legacy path and the legacy body stays untouched.
 */
export const FV2_LEGACY_CALL = Symbol("fv2.legacyCall");
export const isLegacyCall = (user: unknown): boolean => !!(user as any)?.[FV2_LEGACY_CALL];
export const asLegacyCall = <T extends object>(user: T): T => ({ ...user, [FV2_LEGACY_CALL]: true });

/**
 * EX-3 (DESIGN §9 "Other findings"): an expense or a landlord payout may only
 * name a landlord / property of the caller's own account. Legacy stored a
 * foreign id unchecked (a cross-account reference, and v2 would stamp it as a
 * dimension). Applies in every flag state: a legitimate caller never sends a
 * foreign id, so nothing visible changes for them. Pure SQL on the legacy
 * handler's own Drizzle handle, so it runs even with no finance-v2 provider.
 */
export async function assertOwnScope(db: any, scope: number, ids: { ownerId?: unknown; propertyId?: unknown }): Promise<void> {
  const q = sqlOf(db);
  const check = async (table: "owners" | "properties", raw: unknown, label: string) => {
    if (raw == null || raw === "") return;
    const id = Number(raw);
    const [r] = Number.isInteger(id) && id > 0
      ? await q.rows(`select 1 as ok from ${table} where id = $1 and user_id = $2`, [id, scope])
      : [];
    if (!r) throw new BadRequestException(`${label} غير موجود في هذا الحساب`);
  };
  await check("owners", ids.ownerId, "المؤجر");
  await check("properties", ids.propertyId, "العقار");
}
