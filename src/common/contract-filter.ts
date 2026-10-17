import { sql, type SQL } from "drizzle-orm";
import { idListSentEmpty, parseIdList } from "./pagination";

/**
 * The finance tabs' "which contracts" filter, resolved in SQL.
 *
 * The portal used to turn a property / unit / tenant / landlord pick into a
 * list of contract ids in the browser — by NAME. Two properties called "Tower"
 * merged, "Unit 1" matched every property's unit 1, and the URL grew with the
 * account. The screens now send the ids they picked and the database resolves
 * them to contracts, the same way the Contracts tab's own filters do:
 *
 *   contractIds   these contracts (still accepted — other callers send it)
 *   propertyId    contracts covering any unit in these properties
 *   unitId        contracts covering these units
 *   ownerId       contracts on properties filed under these landlords
 *   tenantId      contracts for these registered tenants
 *
 * Each also takes the plural spelling (`propertyIds`, …). Every filter given
 * must hold. A parameter that was SENT but holds no usable id (`contractIds=0`
 * is sent on purpose when nothing matches) means "no rows", never "no filter".
 */
export type ContractFilter = {
  /** A filter was sent and can match nothing — the caller must return no rows. */
  none: boolean;
  contractIds?: number[];
  propertyIds?: number[];
  unitIds?: number[];
  ownerIds?: number[];
  tenantIds?: number[];
};

const KEYS = {
  contractIds: ["contractIds"],
  propertyIds: ["propertyId", "propertyIds"],
  unitIds: ["unitId", "unitIds"],
  ownerIds: ["ownerId", "ownerIds"],
  tenantIds: ["tenantId", "tenantIds"],
} as const;

/** The contract filter on a request, or undefined when none of its params was sent. */
export function parseContractFilter(raw: unknown): ContractFilter | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const q = raw as Record<string, unknown>;
  const f: ContractFilter = { none: false };
  let sent = false;
  for (const [field, names] of Object.entries(KEYS) as [keyof typeof KEYS, readonly string[]][]) {
    const ids = names.map((n) => parseIdList(q[n])).find((v) => v !== undefined);
    if (ids) { f[field] = ids; sent = true; }
    else if (names.some((n) => idListSentEmpty(q[n]))) { f.none = true; sent = true; }
  }
  return sent ? f : undefined;
}

const idList = (ids: number[]) => sql.join(ids.map((i) => sql`${i}`), sql`, `);

/**
 * The filter as a condition on a contract-id expression (`payments.contract_id`,
 * `simple_invoices.contract_id`, …). Scoped to the account: a contract, unit or
 * property id from another account matches nothing. A NULL contract id never
 * matches.
 *
 * The column is only ever compared at the OUTER level (`col IN (subquery)`),
 * never inside a sub-query. Drizzle renders a column unqualified when its query
 * has no join (`"contract_id"`), and inside `select … from contract_units` that
 * bare name would bind to contract_units.contract_id — a condition that is
 * always true.
 */
export function contractFilterSql(f: ContractFilter, uid: number, contractId: SQL | unknown): SQL {
  if (f.none) return sql`false`;
  const parts: SQL[] = [];
  if (f.contractIds) parts.push(sql`${contractId} in (${idList(f.contractIds)})`);
  if (f.tenantIds) {
    parts.push(sql`${contractId} in (select cf_c.id from contracts cf_c where cf_c.user_id = ${uid}
      and cf_c.tenant_id in (${idList(f.tenantIds)}))`);
  }
  if (f.propertyIds || f.unitIds || f.ownerIds) {
    const link: SQL[] = [sql`cf_p.user_id = ${uid}`];
    if (f.unitIds) link.push(sql`cf_cu.unit_id in (${idList(f.unitIds)})`);
    if (f.propertyIds) link.push(sql`cf_u.property_id in (${idList(f.propertyIds)})`);
    if (f.ownerIds) link.push(sql`cf_p.owner_id in (${idList(f.ownerIds)})`);
    // A semi-join, not a join: a contract over three units stays one row.
    parts.push(sql`${contractId} in (select cf_cu.contract_id from contract_units cf_cu
      join units cf_u on cf_u.id = cf_cu.unit_id
      join properties cf_p on cf_p.id = cf_u.property_id
      where ${sql.join(link, sql` and `)})`);
  }
  return parts.length ? sql`(${sql.join(parts, sql` and `)})` : sql`true`;
}

/**
 * The same condition as text, for the finance-v2 overrides that build their
 * SQL as strings with positional params. `P` appends a value and returns its
 * placeholder; `uid` is the placeholder already holding the account id.
 */
export function contractFilterText(f: ContractFilter, uid: string, contractId: string, P: (v: unknown) => string): string {
  if (f.none) return "false";
  const parts: string[] = [];
  if (f.contractIds) parts.push(`${contractId} = any(${P(f.contractIds)}::int[])`);
  if (f.tenantIds) {
    parts.push(`${contractId} in (select cf_c.id from contracts cf_c where cf_c.user_id = ${uid}
      and cf_c.tenant_id = any(${P(f.tenantIds)}::int[]))`);
  }
  if (f.propertyIds || f.unitIds || f.ownerIds) {
    const link = [`cf_p.user_id = ${uid}`];
    if (f.unitIds) link.push(`cf_cu.unit_id = any(${P(f.unitIds)}::int[])`);
    if (f.propertyIds) link.push(`cf_u.property_id = any(${P(f.propertyIds)}::int[])`);
    if (f.ownerIds) link.push(`cf_p.owner_id = any(${P(f.ownerIds)}::int[])`);
    parts.push(`${contractId} in (select cf_cu.contract_id from contract_units cf_cu
      join units cf_u on cf_u.id = cf_cu.unit_id
      join properties cf_p on cf_p.id = cf_u.property_id
      where ${link.join(" and ")})`);
  }
  return parts.length ? `(${parts.join(" and ")})` : "true";
}
