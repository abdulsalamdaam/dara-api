/**
 * Finance v2 (DESIGN §9 E4): ONE definition of an installment's status, built
 * from the money actually collected rather than the stored status. A new file
 * so `payment-status.ts` (the legacy definition every flag-off screen uses)
 * stays byte-identical; only the v2 overrides read this one.
 *
 *  - `cancelled`, `settled_external` are taken as stored (checked first);
 *  - `written_off`      the uncollected remainder was written off (E24);
 *  - `paid_unverified`  stored `paid` but Σ collections < amount (legacy
 *                       "mark as paid", Ejar imports, PATCH): shown as paid
 *                       with a "not verified" badge, never overdue, listed by
 *                       reconciliation R7 — historical rows are never re-derived
 *                       into arrears;
 *  - `paid`             remaining ≤ 0.005;
 *  - `overdue`          due before Riyadh today with money still owed —
 *                       INCLUDING a part-paid row (legacy calls it partially_paid);
 *  - `partially_paid`   some collected, not yet due;
 *  - `pending`          otherwise.
 *
 * Amounts are exact: numeric strings in, a 2-decimal string out (halalas inside).
 */

export type LiveStatusV2 =
  | "cancelled" | "settled_external" | "written_off" | "paid_unverified" | "paid" | "overdue" | "partially_paid" | "pending";

const toH = (v: string | number | null | undefined): number => {
  const s = String(v ?? "0").trim() || "0";
  const neg = s.startsWith("-");
  const [i, f = ""] = s.replace(/^[-+]/, "").split(".");
  const h = Number(i || "0") * 100 + Number((f + "00").slice(0, 2)) + (Number(f.charAt(2) || "0") >= 5 ? 1 : 0);
  return neg ? -h : h;
};
const fromH = (h: number): string => {
  const neg = h < 0;
  const a = Math.abs(h);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
};

/** `YYYY-MM-DD` in Asia/Riyadh. */
export function riyadhTodayV2(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Riyadh" });
}

export function liveStatusV2(
  row: { amount: string | number; dueDate: string | null | undefined; status: string },
  collected: string | number | null | undefined,
  today: string = riyadhTodayV2(),
  writtenOff: string | number | null | undefined = 0,
): { status: LiveStatusV2; remaining: string } {
  const remainingH = Math.max(0, toH(row.amount) - toH(collected) - toH(writtenOff));
  const remaining = fromH(remainingH);
  if (row.status === "cancelled" || row.status === "settled_external") return { status: row.status, remaining: "0.00" };
  if (toH(writtenOff) > 0 && remainingH === 0) return { status: "written_off", remaining };
  if (remainingH === 0) return { status: "paid", remaining };
  if (row.status === "paid") return { status: "paid_unverified", remaining };
  const due = String(row.dueDate ?? "").slice(0, 10);
  if (due && due < today) return { status: "overdue", remaining };
  if (toH(collected) > 0) return { status: "partially_paid", remaining };
  return { status: "pending", remaining };
}

/**
 * The SQL twin, for raw queries over `payments <alias>`. `$today` is the SQL
 * text of a date expression (a bound parameter such as `$2::date`).
 * `remaining` = amount − Σ collections − Σ written off, never below 0.
 */
export function remainingSqlV2(p: string): string {
  return `greatest(0, ${p}.amount
    - coalesce((select sum(pc.amount) from payment_collections pc where pc.payment_id = ${p}.id and pc.user_id = ${p}.user_id), 0)
    - coalesce((select sum(w.amount) from finance_write_offs w where w.user_id = ${p}.user_id and w.payment_ids = array[${p}.id]), 0))`;
}

export function collectedSqlV2(p: string): string {
  return `coalesce((select sum(pc.amount) from payment_collections pc where pc.payment_id = ${p}.id and pc.user_id = ${p}.user_id), 0)`;
}

export function liveStatusV2Sql(p: string, today: string): string {
  const rem = remainingSqlV2(p);
  const col = collectedSqlV2(p);
  return `(case
    when ${p}.status::text in ('cancelled','settled_external') then ${p}.status::text
    when ${rem} <= 0.005 and exists (select 1 from finance_write_offs w where w.user_id = ${p}.user_id and w.payment_ids = array[${p}.id]) then 'written_off'
    when ${rem} <= 0.005 then 'paid'
    when ${p}.status::text = 'paid' then 'paid_unverified'
    when ${p}.due_date < ${today} then 'overdue'
    when ${col} > 0.005 then 'partially_paid'
    else 'pending' end)`;
}
