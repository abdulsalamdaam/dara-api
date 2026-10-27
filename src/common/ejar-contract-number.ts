import { and, desc, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { contractsTable } from "@dara/database";
import type { Drizzle } from "../database/database.module";

/**
 * One Ejar contract number, however it was typed: a manual contract's
 * optional "رقم عقد إيجار" is free text, so the same number can be stored as
 * "٢٠٤٩٨٣٧٣٢٦٨", "20498 373268", "2049-8373268" or with leading zeros.
 * Compared on its key — Latin digits, no spaces or dashes, no leading zeros.
 * The SQL side (`ejarNumberKeySql`) applies exactly the same steps.
 */
export function ejarNumberKey(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s-]/g, "")
    .replace(/^0+/, "");
  return s || null;
}

/** `ejarNumberKey` in SQL, for a text column. */
export function ejarNumberKeySql(col: unknown): SQL {
  return sql`ltrim(regexp_replace(translate(coalesce(${col}, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[[:space:]-]', '', 'g'), '0')`;
}

export interface ContractWithEjarNumber {
  contractId: number;
  /** Dara's own number for that contract (what the user sees in the list). */
  contractNumber: string | null;
  deleted: boolean;
}

/**
 * The account's contract that already carries this Ejar number — entered by
 * hand on a manual contract, or set by an Ejar import (which stores the
 * number as both `contract_number` and `ejar_contract_number`). A live
 * contract wins over a soft-deleted one.
 *
 * `includeDeleted` keeps soft-deleted rows: `(user_id, contract_number)` is
 * unique across them, so an import of that number would collide anyway.
 */
export async function findContractByEjarNumber(
  db: Drizzle, accountId: number, raw: unknown,
  opts: { excludeId?: number | null; includeDeleted?: boolean } = {},
): Promise<ContractWithEjarNumber | null> {
  const key = ejarNumberKey(raw);
  if (!key) return null;
  const conds: SQL[] = [
    eq(contractsTable.userId, accountId),
    or(
      sql`${ejarNumberKeySql(contractsTable.ejarContractNumber)} = ${key}`,
      // An imported contract's own number is the Ejar number (digits only).
      eq(contractsTable.contractNumber, key),
    )!,
  ];
  if (!opts.includeDeleted) conds.push(isNull(contractsTable.deletedAt));
  if (opts.excludeId != null) conds.push(ne(contractsTable.id, opts.excludeId));
  const [row] = await db
    .select({ id: contractsTable.id, contractNumber: contractsTable.contractNumber, deletedAt: contractsTable.deletedAt })
    .from(contractsTable)
    .where(and(...conds))
    .orderBy(sql`${contractsTable.deletedAt} is not null`, desc(contractsTable.id))
    .limit(1);
  return row ? { contractId: row.id, contractNumber: row.contractNumber ?? null, deleted: row.deletedAt != null } : null;
}

/** "Already registered" — the Ejar lookup's refusal (409 `contract_exists`). */
export function ejarNumberTakenMessage(ejarNumber: string, contractNumber: string | null): string {
  const ref = contractNumber && contractNumber !== ejarNumber ? ` (${contractNumber})` : "";
  return `هذا العقد مسجّل مسبقاً برقم إيجار ${ejarNumber}${ref} — لا حاجة لاستيراده مرة أخرى · ` +
    `A contract with Ejar number ${ejarNumber} is already in your account${ref} — no need to import it again.`;
}

/** The manual form: the number typed is already on another contract. */
export function ejarNumberDuplicateMessage(ejarNumber: string, contractNumber: string | null): string {
  const ref = contractNumber ? ` (${contractNumber})` : "";
  return `رقم عقد إيجار ${ejarNumber} مسجّل مسبقاً على عقد آخر في حسابك${ref} · ` +
    `Ejar contract number ${ejarNumber} is already on another contract in your account${ref}.`;
}
