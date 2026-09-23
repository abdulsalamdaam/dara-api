/**
 * Where a seller's ZATCA chain actually stands.
 *
 * Two places record it, and nothing used to make them agree:
 *
 *   · `zatca_credentials.{sandbox,prod}_{icv,pih}` — the counter `issue()` reads
 *     and advances;
 *   · the `invoices` rows ZATCA accepted — which `invoices_user_owner_env_icv_uniq`
 *     holds to one row per (user, owner, environment, icv).
 *
 * The counter lives on the credentials ROW, so anything that produces a fresh
 * row — `upsertProfile` inserting because none exists (the column defaults are
 * 0 / seed), a credentials row removed out of band, `resetChain` — starts the
 * counter at 0 while the accepted invoices of that same chain stay live. The
 * next document is then signed as ICV 1 on the seed PIH, sent, ACCEPTED by
 * ZATCA, the counter is committed — and only then does the insert collide with
 * the ICV 1 already on file. That is the 23 Sep 2026 staging incident (user 1,
 * owner 4, sandbox): the document is filed with ZATCA and lost locally, and the
 * next two approvals are set to collide the same way.
 *
 * So the head is the LATER of the two. The accepted rows are the stronger
 * record — each is a document we signed and ZATCA holds — and ZATCA requires an
 * EGS's ICV to be monotonic and never reset; this repo already continues a
 * chain across a new CSID (unlink keeps the counter, re-link bumps the EGS
 * serial and carries on), so continuing from the last accepted row is the same
 * policy, applied to the one path that forgot it. Only the ICV and PIH VALUES
 * change; the XML built from them has exactly the shape it always had.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { invoicesTable } from "@dara/database";
import type { Drizzle } from "../../../database/database.module";
import { ZATCA_ACCEPTED_STATUSES } from "../../../common/zatca-acceptance";
import type { ZatcaEnv } from "./zatca-api.service";

export interface ChainHead {
  icv: number;
  pih: string;
}

export interface AcceptedTail {
  icv: number;
  invoiceHash: string | null;
}

/**
 * The later of the stored counter and the last accepted document.
 *
 * `healed` is true when the counter was BEHIND the accepted rows — the caller
 * must then write the returned head back, and should say so in the logs,
 * because a counter that went backwards is a fault somewhere else.
 *
 * A tail with no hash cannot be chained onto (the PIH of the next document IS
 * that hash), so it is refused rather than guessed: an invented PIH is a break
 * in the chain that nothing downstream will notice until an audit does.
 */
export function reconcileChainHead(
  stored: ChainHead,
  tail: AcceptedTail | null,
): ChainHead & { healed: boolean } {
  if (!tail || tail.icv <= stored.icv) return { ...stored, healed: false };
  if (!tail.invoiceHash) {
    throw new Error(
      `ZATCA chain head is behind accepted invoice ICV ${tail.icv}, which has no stored hash to chain onto`,
    );
  }
  return { icv: tail.icv, pih: tail.invoiceHash, healed: true };
}

/**
 * The highest-ICV document ZATCA accepted on this chain — scoped exactly as
 * `invoices_user_owner_env_icv_uniq` is (user, coalesce(owner, 0), environment,
 * live, accepted status), so "ahead of the counter" here means precisely "would
 * collide on insert".
 */
export async function lastAcceptedInChain(
  db: Drizzle,
  userId: number,
  ownerId: number | null,
  environment: ZatcaEnv,
): Promise<AcceptedTail | null> {
  const [row] = await db
    .select({ icv: invoicesTable.icv, invoiceHash: invoicesTable.invoiceHash })
    .from(invoicesTable)
    .where(and(
      eq(invoicesTable.userId, userId),
      sql`coalesce(${invoicesTable.ownerId}, 0) = ${ownerId ?? 0}`,
      eq(invoicesTable.environment, environment),
      isNull(invoicesTable.deletedAt),
      inArray(invoicesTable.status, [...ZATCA_ACCEPTED_STATUSES]),
    ))
    .orderBy(desc(invoicesTable.icv))
    .limit(1);
  return row ? { icv: row.icv, invoiceHash: row.invoiceHash ?? null } : null;
}

/**
 * Marker on an `invoices` row that ZATCA accepted but that could not be stored
 * as a live row. It is written soft-deleted (so neither unique index can refuse
 * it) with the full signed XML, hash and QR, and the marker is what lets the
 * retry path recognise it: re-issuing that document would file it with ZATCA a
 * second time under a new UUID.
 */
export const ACCEPTED_NOT_RECORDED_NOTE = "[zatca_accepted_not_recorded]";
