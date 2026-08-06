/**
 * The displayed status of an installment.
 *
 * `payments.status` defaults to 'pending' and **nothing ever writes 'overdue'**
 * — there is no sweeper. So a stored value alone reports a long-past
 * installment as "قادم", and, worse, every consumer that filters on
 * `status === 'overdue'` matches zero rows. That was true of the Installments
 * tab's own status filter, the landlord dashboard's overdue counter and the
 * mobile landlord summary.
 *
 * Deriving it — rather than writing 'overdue' at import time and adding a
 * sweeper — means it can never go stale. This module is the single definition:
 * `liveStatus` for rows already in memory, `liveStatusSql` for filtering and
 * aggregating in the database. They must agree, which is why they live
 * together; two copies is exactly how the filter drifted from the display.
 *
 * Both resolve "today" in Asia/Riyadh, the business timezone. Using the
 * server's UTC date instead would flip an installment to overdue three hours
 * early for a Saudi landlord.
 */

import { sql } from "drizzle-orm";
import { paymentsTable } from "@dara/database";

/** Statuses that represent a settled outcome — never re-derived. */
export const SETTLED_STATUSES = ["paid", "cancelled", "settled_external", "partially_paid"] as const;

/** Today's date in Asia/Riyadh as `YYYY-MM-DD`. */
export function riyadhToday(): string {
  // en-CA formats as YYYY-MM-DD, which is also how the column is stored.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Riyadh" });
}

/** Derive an installment's status from its stored value and due date. */
export function liveStatus(stored: string, dueDate: string | null | undefined): string {
  if ((SETTLED_STATUSES as readonly string[]).includes(stored)) return stored;
  if (!dueDate) return stored;
  return String(dueDate).slice(0, 10) < riyadhToday() ? "overdue" : "pending";
}

/**
 * The same derivation as a SQL expression, for WHERE and GROUP BY.
 *
 * Filtering on the stored column instead is what made the "متأخرة" tab
 * permanently empty while the summary card above it counted overdue rows
 * correctly.
 */
export const liveStatusSql = sql<string>`case
  when ${paymentsTable.status} in ('paid','cancelled','settled_external','partially_paid') then ${paymentsTable.status}::text
  when ${paymentsTable.dueDate} < (now() at time zone 'Asia/Riyadh')::date then 'overdue'
  else 'pending' end`;
