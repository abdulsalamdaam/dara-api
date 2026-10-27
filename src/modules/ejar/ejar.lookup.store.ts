import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type pg from "pg";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  createAuxPool, contractsTable, ejarApiLogsTable, ejarLookupsTable, lookupsTable, ownersTable, propertiesTable, tenantsTable, unitsTable, usersTable,
} from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { resolveLookupId } from "../../common/lookups-resolve";
import { resolveEjarScope, type EjarScope } from "./ejar.scope";
import type { LookupUsage, PlanPeriod } from "./ejar.budget";
import { ejarLookupUsage, WRONG_NUMBER_SQL } from "./ejar.usage";
import { readPool, type EjarPool } from "./ejar.pool";
import { readAdjustments, type LimitAdjustment } from "../../common/limit-core";
import { accountEjarMode, type EjarAccountMode } from "./ejar.access";
import { resolvePartyCheck, type EjarPartyCheck } from "./ejar.party-check";
import { ejarLandlordCapPeek, type CapIdentity } from "./ejar.landlord-cap";
import { findContractByEjarNumber } from "../../common/ejar-contract-number";

/** An existing contract with the looked-up Ejar number (`contractNumber`: Dara's own number for it). */
export interface ImportedContract { contractId: number; contractNumber?: string | null; deleted?: boolean }

/**
 * Advisory-lock key serialising budget check + Ejar calls across every API
 * container (a rolling deploy runs two). Single-bigint keys do not share a
 * keyspace with the two-int `(userId, n)` locks used elsewhere.
 */
const EJAR_LOOKUP_LOCK = "7301202610";
/** How long a lookup waits for another container's lookup before giving up. */
const LOCK_WAIT_MS = 30_000;

/**
 * The lock is held across two Ejar calls, so its connection comes from a tiny
 * pool of its own (the reason chain-lock.ts spells out: a connection parked
 * across a network call must not be one the request pool needs).
 */
let lockPool: pg.Pool | null = null;
function getLockPool(): pg.Pool {
  if (!lockPool) lockPool = createAuxPool(2, "ejar-lookup-lock pool");
  return lockPool;
}

/** Tests only: close the lock pool so the process can exit. */
export async function closeEjarLookupLockPool(): Promise<void> {
  const p = lockPool;
  lockPool = null;
  await p?.end();
}

export interface SavedLookup {
  id: number;
  accountId: number;
  contractNumber: string;
  ejarUuid: string;
  invoicesBody: Record<string, unknown> | null;
  detailsBody: Record<string, unknown> | null;
  /** Get Contracts body; absent/null for Details-mode (and pre-0078) lookups. */
  contractsBody?: Record<string, unknown> | null;
  lookedUpBy: number | null;
  createdAt: Date;
}

export interface PartyMatch { id: number; name: string }
export interface UnitMatch { id: number; unitNumber: string; propertyId: number; ejarId: string | null }
export interface LookupMatches {
  landlord: PartyMatch | null;
  tenant: PartyMatch | null;
  /** The account's property already carrying this Ejar property UUID. */
  property: PartyMatch | null;
  /** The account's units already carrying these Ejar unit UUIDs. */
  units: UnitMatch[];
}
/** An existing landlord / tenant record the import will link instead of creating one. */
export interface LinkedParty {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  /** The account's own record (is_account_holder). */
  isAccountHolder: boolean;
}

/** Who Ejar names, as the writer matches it: the ID (or an organization's CR), else the name. */
export interface PartyKey {
  idNumber: string | null;
  name: string | null;
  /** Every identifier Ejar gave (for the landlord cap's looser match). */
  ids: string[];
}

export interface MatchKeys { landlord: string[]; tenant: string[]; propertyEjarId: string | null; unitEjarIds: string[] }

/** Everything the lookup and import need from the database, behind one seam so tests can fake it. */
export interface EjarLookupStore {
  /** Run `fn` with the lookup budget locked (one lookup at a time, everywhere). */
  withBudgetLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Calls actually sent in the window (null = all time), and this account's share. */
  usage(since: Date | null, accountId: number): Promise<LookupUsage>;
  /** The admin-set gateway call pool (ejar.pool.ts); null when none is configured. */
  callPool(): Promise<EjarPool | null>;
  /** Invoices calls Ejar answered "no such contract" for this account since `since`. */
  wrongNumbers(since: Date, accountId: number): Promise<number>;
  scope(accountId: number): Promise<EjarScope>;
  /** The stored identity an inquiry is pinned to (عقاري: its landlord; tenant plan: itself). */
  partyCheck(accountId: number): Promise<EjarPartyCheck>;
  /** The account's plan and paid period — what its Ejar lookup quota is cut from. */
  planPeriod(accountId: number): Promise<PlanPeriod | null>;
  /** The account's override / active add-ons for its Ejar lookup quota (common/limits.ts). */
  ejarQuotaAdjustment(accountId: number): Promise<LimitAdjustment>;
  /** The account's Ejar switch (ejar.access.ts). */
  ejarAccountMode(accountId: number): Promise<EjarAccountMode>;
  getLookup(accountId: number, contractNumber: string): Promise<SavedLookup | null>;
  saveLookup(row: Omit<SavedLookup, "id" | "createdAt">): Promise<SavedLookup>;
  /**
   * The account's contract already carrying this Ejar number — imported, or
   * a manual contract whose optional Ejar number matches (normalised).
   */
  findImported(accountId: number, contractNumber: string): Promise<ImportedContract | null>;
  findMatches(accountId: number, keys: MatchKeys): Promise<LookupMatches>;
  landlord(accountId: number, id: number): Promise<PartyMatch | null>;
  tenant(accountId: number, id: number): Promise<PartyMatch | null>;
  property(accountId: number, id: number): Promise<{ id: number; ownerId: number | null; usageLookupId: number | null } | null>;
  unit(accountId: number, id: number): Promise<{ id: number; propertyId: number; usageLookupId: number | null } | null>;
  unitNumberTaken(propertyId: number, unitNumber: string): Promise<number | null>;
  lookupRow(id: number): Promise<{ id: number; category: string; key: string; labelAr?: string | null } | null>;
  /** A global lookup option by key or Arabic label. */
  resolveLookup(category: string, value: string): Promise<number | null>;
  /**
   * The record the import's writer will reuse for this party (same match:
   * ID / CR number, else name; the landlord cap's looser match at the cap) —
   * null when it will create a new one.
   */
  existingParty(accountId: number, role: "landlord" | "tenant", key: PartyKey): Promise<LinkedParty | null>;
  /**
   * Replace the response bodies of these call-log rows with a marker: the
   * account received a contract it was not verified for, and its call log
   * must not hand it back. Marked truncated, so EJAR_REPLAY never serves them.
   */
  withholdLogBodies(ids: number[], reason: string): Promise<void>;
}

@Injectable()
export class DrizzleEjarLookupStore implements EjarLookupStore {
  /** In-process queue, so waiting lookups don't each hold a pool connection. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  withBudgetLock<T>(fn: () => Promise<T>): Promise<T> {
    // In-process queue first, so this process holds at most one lock
    // connection; then the session advisory lock across processes. Call logs
    // are written on the request pool by EjarLogService and commit at once,
    // so the next holder counts them.
    const run = async () => {
      const client = await getLockPool().connect();
      let broken = false;
      try {
        const deadline = Date.now() + LOCK_WAIT_MS;
        for (;;) {
          const { rows } = await client.query<{ got: boolean }>("select pg_try_advisory_lock($1::bigint) as got", [EJAR_LOOKUP_LOCK]);
          if (rows[0]?.got) break;
          if (Date.now() > deadline) {
            throw new ServiceUnavailableException({ code: "busy", message: "Another Ejar lookup is in progress; try again." });
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        try {
          return await fn();
        } finally {
          try {
            await client.query("select pg_advisory_unlock($1::bigint)", [EJAR_LOOKUP_LOCK]);
          } catch {
            broken = true; // destroy the session so the lock cannot linger
          }
        }
      } finally {
        client.release(broken || undefined);
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async wrongNumbers(since: Date, accountId: number): Promise<number> {
    const res: any = await this.db.execute(sql`
      select coalesce(sum(l.attempts), 0)::int as n
        from ejar_api_logs l
        left join users u on u.id = l.user_id
       where l.env like 'balady%'
         and ${WRONG_NUMBER_SQL}
         and coalesce(u.owner_user_id, u.id) = ${accountId}
         and l.created_at >= ${since.toISOString()}::timestamptz`);
    const rows: Array<{ n: number }> = Array.isArray(res) ? res : res?.rows ?? [];
    return Number(rows[0]?.n ?? 0);
  }

  usage(since: Date | null, accountId: number): Promise<LookupUsage> {
    return ejarLookupUsage(this.db, since, accountId);
  }

  callPool(): Promise<EjarPool | null> {
    return readPool(this.db);
  }

  scope(accountId: number): Promise<EjarScope> {
    return resolveEjarScope(this.db, accountId);
  }

  partyCheck(accountId: number): Promise<EjarPartyCheck> {
    return resolvePartyCheck(this.db, accountId);
  }

  async planPeriod(accountId: number): Promise<PlanPeriod | null> {
    const [row] = await this.db
      .select({
        packagePlan: usersTable.packagePlan, billingCycle: usersTable.billingCycle,
        subscriptionStartedAt: usersTable.subscriptionStartedAt, subscriptionEndsAt: usersTable.subscriptionEndsAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, accountId))
      .limit(1);
    return row ?? null;
  }

  async ejarQuotaAdjustment(accountId: number): Promise<LimitAdjustment> {
    return (await readAdjustments(this.db, accountId)).ejar_lookups;
  }

  ejarAccountMode(accountId: number): Promise<EjarAccountMode> {
    return accountEjarMode(this.db, accountId);
  }

  async getLookup(accountId: number, contractNumber: string): Promise<SavedLookup | null> {
    const [row] = await this.db
      .select()
      .from(ejarLookupsTable)
      .where(and(eq(ejarLookupsTable.accountId, accountId), eq(ejarLookupsTable.contractNumber, contractNumber)))
      .limit(1);
    return (row as SavedLookup | undefined) ?? null;
  }

  async saveLookup(row: Omit<SavedLookup, "id" | "createdAt">): Promise<SavedLookup> {
    const values = { ...row, createdAt: new Date() };
    const [saved] = await this.db
      .insert(ejarLookupsTable)
      .values(values as never)
      .onConflictDoUpdate({
        target: [ejarLookupsTable.accountId, ejarLookupsTable.contractNumber],
        set: {
          ejarUuid: row.ejarUuid,
          invoicesBody: row.invoicesBody as never,
          detailsBody: row.detailsBody as never,
          contractsBody: (row.contractsBody ?? null) as never,
          lookedUpBy: row.lookedUpBy,
          createdAt: values.createdAt,
        },
      })
      .returning();
    return saved as SavedLookup;
  }

  async findImported(accountId: number, contractNumber: string): Promise<ImportedContract | null> {
    // Soft-deleted rows included: (user_id, contract_number) is unique across
    // them too, so a deleted contract still blocks the insert. A manual
    // contract's typed Ejar number is compared normalised (ejar-contract-number.ts).
    const row = await findContractByEjarNumber(this.db, accountId, contractNumber, { includeDeleted: true });
    return row ? { contractId: row.contractId, contractNumber: row.contractNumber, deleted: row.deleted } : null;
  }

  async findMatches(accountId: number, keys: MatchKeys): Promise<LookupMatches> {
    const { landlord: landlordIds, tenant: tenantIds } = keys;
    const landlord = landlordIds.length
      ? (await this.db
          .select({ id: ownersTable.id, name: ownersTable.name })
          .from(ownersTable)
          .where(and(eq(ownersTable.userId, accountId), inArray(ownersTable.idNumber, landlordIds), isNull(ownersTable.deletedAt)))
          .limit(1))[0] ?? null
      : null;
    const tenant = tenantIds.length
      ? (await this.db
          .select({ id: tenantsTable.id, name: tenantsTable.name })
          .from(tenantsTable)
          .where(and(eq(tenantsTable.userId, accountId), inArray(tenantsTable.nationalId, tenantIds), isNull(tenantsTable.deletedAt)))
          .limit(1))[0] ?? null
      : null;
    const property = keys.propertyEjarId
      ? (await this.db
          .select({ id: propertiesTable.id, name: propertiesTable.name })
          .from(propertiesTable)
          .where(and(eq(propertiesTable.userId, accountId), eq(propertiesTable.ejarId, keys.propertyEjarId), isNull(propertiesTable.deletedAt)))
          .limit(1))[0] ?? null
      : null;
    const units = keys.unitEjarIds.length
      ? await this.db
          .select({ id: unitsTable.id, unitNumber: unitsTable.unitNumber, propertyId: unitsTable.propertyId, ejarId: unitsTable.ejarId })
          .from(unitsTable)
          .innerJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
          .where(and(
            eq(propertiesTable.userId, accountId), inArray(unitsTable.ejarId, keys.unitEjarIds),
            isNull(unitsTable.deletedAt), isNull(propertiesTable.deletedAt),
          ))
      : [];
    return { landlord, tenant, property, units };
  }

  async landlord(accountId: number, id: number) {
    const [row] = await this.db
      .select({ id: ownersTable.id, name: ownersTable.name })
      .from(ownersTable)
      .where(and(eq(ownersTable.id, id), eq(ownersTable.userId, accountId), isNull(ownersTable.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async tenant(accountId: number, id: number) {
    const [row] = await this.db
      .select({ id: tenantsTable.id, name: tenantsTable.name })
      .from(tenantsTable)
      .where(and(eq(tenantsTable.id, id), eq(tenantsTable.userId, accountId), isNull(tenantsTable.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async property(accountId: number, id: number) {
    const [row] = await this.db
      .select({ id: propertiesTable.id, ownerId: propertiesTable.ownerId, usageLookupId: propertiesTable.usageLookupId })
      .from(propertiesTable)
      .where(and(eq(propertiesTable.id, id), eq(propertiesTable.userId, accountId), isNull(propertiesTable.deletedAt)))
      .limit(1);
    return row ?? null;
  }

  async unit(accountId: number, id: number) {
    const [row] = await this.db
      .select({ id: unitsTable.id, propertyId: unitsTable.propertyId, usageLookupId: unitsTable.usageLookupId })
      .from(unitsTable)
      .innerJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
      .where(and(
        eq(unitsTable.id, id), eq(propertiesTable.userId, accountId),
        isNull(unitsTable.deletedAt), isNull(propertiesTable.deletedAt),
      ))
      .limit(1);
    return row ?? null;
  }

  async unitNumberTaken(propertyId: number, unitNumber: string) {
    const [row] = await this.db
      .select({ id: unitsTable.id })
      .from(unitsTable)
      .where(and(eq(unitsTable.propertyId, propertyId), eq(unitsTable.unitNumber, unitNumber), isNull(unitsTable.deletedAt)))
      .limit(1);
    return row?.id ?? null;
  }

  resolveLookup(category: string, value: string) {
    return resolveLookupId(this.db, category, value);
  }

  async existingParty(accountId: number, role: "landlord" | "tenant", key: PartyKey): Promise<LinkedParty | null> {
    if (!key.idNumber && !key.name) return null;
    if (role === "landlord") {
      const cols = {
        id: ownersTable.id, name: ownersTable.name, phone: ownersTable.phone, email: ownersTable.email,
        isAccountHolder: ownersTable.isAccountHolder,
      };
      const where = key.idNumber
        ? and(eq(ownersTable.userId, accountId), eq(ownersTable.idNumber, key.idNumber), isNull(ownersTable.deletedAt))
        : and(eq(ownersTable.userId, accountId), eq(ownersTable.name, key.name!), isNull(ownersTable.deletedAt));
      let [row] = await this.db.select(cols).from(ownersTable).where(where).limit(1);
      if (!row) {
        const who: CapIdentity = { name: key.name?.replace(/\s+/g, " ").trim() || null, ids: key.ids };
        const capped = await ejarLandlordCapPeek(this.db, accountId, who);
        if (capped != null) [row] = await this.db.select(cols).from(ownersTable).where(eq(ownersTable.id, capped)).limit(1);
      }
      return row ? { ...row, isAccountHolder: !!row.isAccountHolder } : null;
    }
    const where = key.idNumber
      ? and(eq(tenantsTable.userId, accountId), eq(tenantsTable.nationalId, key.idNumber), isNull(tenantsTable.deletedAt))
      : and(eq(tenantsTable.userId, accountId), eq(tenantsTable.name, key.name!), isNull(tenantsTable.deletedAt));
    const [row] = await this.db
      .select({
        id: tenantsTable.id, name: tenantsTable.name, phone: tenantsTable.phone, email: tenantsTable.email,
        isAccountHolder: tenantsTable.isAccountHolder,
      })
      .from(tenantsTable)
      .where(where)
      .limit(1);
    return row ? { ...row, isAccountHolder: !!row.isAccountHolder } : null;
  }

  async withholdLogBodies(ids: number[], reason: string): Promise<void> {
    if (!ids.length) return;
    await this.db
      .update(ejarApiLogsTable)
      .set({ responseBody: { withheld: reason } as never, bodyTruncated: true })
      .where(inArray(ejarApiLogsTable.id, ids));
  }

  async lookupRow(id: number) {
    const [row] = await this.db
      .select({ id: lookupsTable.id, category: lookupsTable.category, key: lookupsTable.key, labelAr: lookupsTable.labelAr })
      .from(lookupsTable)
      .where(eq(lookupsTable.id, id))
      .limit(1);
    return row ?? null;
  }
}
