/**
 * Test harness for Ejar Import v2: an in-memory EjarLookupStore and a mocked
 * global fetch that plays the Balady staging gateway. Nothing here can reach
 * the network — an unexpected URL throws.
 *
 * All data is synthetic (public repo).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EjarClientService } from "../ejar.client.service";
import { EjarLookupService } from "../ejar.lookup.service";
import type { EjarLookupStore, LinkedParty, LookupMatches, MatchKeys, PartyKey, PartyMatch, SavedLookup } from "../ejar.lookup.store";
import type { LimitAdjustment } from "../../../common/limit-core";
import type { EjarAccountMode } from "../ejar.access";
import type { EjarScope } from "../ejar.scope";
import type { EjarPartyCheck } from "../ejar.party-check";
import type { LookupUsage, PlanPeriod } from "../ejar.budget";

export const CN = "10000000001";
export const UUID = "11111111-2222-4333-8444-555555555555";
export const STG = "https://apiservicesstg.balady.gov.sa";

export const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "..", "__fixtures__", `${name}.json`), "utf8"));

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const baladyOk = (result: unknown) =>
  json(200, { statusDetails: { code: 200, message: "Ok" }, data: { responseCode: "1", responseMessage: "success", responseId: "r-1", result } });
export const baladyErr = (status: number, responseCode: string, responseMessage: string) =>
  json(status, { statusDetails: { code: status, message: "Error" }, data: { responseCode, responseMessage } });
export const tokenOk = () => json(200, { access_token: "tok-1", expires_in: "17999", token_type: "Bearer" });

/** A synthetic UUID per contract number, so several contracts can coexist in one test. */
export const uuidFor = (n: string) => (n === CN ? UUID : `11111111-2222-4333-8444-${n.padStart(12, "0").slice(-12)}`);

/** The Invoices fixture re-keyed to contract `n`. */
export function invoicesFor(n: string) {
  const b = fixture("lookup-invoices");
  b.data[0].id = uuidFor(n);
  b.data[0].attributes.contract_no = n;
  b.included[0].attributes.contract_id = uuidFor(n);
  return b;
}

/** The Details fixture re-keyed to contract `n`. */
export function detailsFor(n: string) {
  const b = fixture("lookup-details");
  b.data.id = uuidFor(n);
  b.data.attributes.contract_number = n;
  return b;
}

/** The Get Contracts fixture re-keyed to contract `n`. */
export function contractsFor(n: string) {
  const b = fixture("lookup-contracts");
  b.data[0].id = uuidFor(n);
  b.data[0].attributes.contract_id = uuidFor(n);
  b.data[0].attributes.contract_number = n;
  return b;
}
export const EMPTY_CONTRACTS = { data: [], meta: { count: 0 } };
export const PROPERTY_UUID = "aaaaaaaa-1111-4222-8333-444444444444";
export const UNIT_UUID = "bbbbbbbb-1111-4222-8333-444444444444";

/** Residential, both parties individuals, no representatives. */
export function individualDetails(n = CN) {
  const b = detailsFor(n);
  b.data.attributes.contract_type = "residential";
  b.data.attributes.security_deposit_amount = "0.0";
  b.data.relationships.contract_parties.data = [{ type: "contract_parties", id: "1" }, { type: "contract_parties", id: "2" }];
  b.included = [
    {
      type: "contract_parties", id: "1",
      attributes: { contract_party_role: "tenant", contract_party_entity_type: "Domain::Contract::Model::ContractPartyIndividualEntity", approved: true },
      relationships: { individual_entity: { data: { type: "contract_individual_entities", id: "701" } } },
    },
    { type: "contract_individual_entities", id: "701", attributes: { full_name: "سارة تجريبية", id_type: "iqama" } },
    {
      type: "contract_parties", id: "2",
      attributes: { contract_party_role: "lessor", contract_party_entity_type: "Domain::Contract::Model::ContractPartyIndividualEntity", approved: true },
      relationships: { individual_entity: { data: { type: "contract_individual_entities", id: "702" } } },
    },
    { type: "contract_individual_entities", id: "702", attributes: { full_name: "فهد تجريبي", id_type: "national_id" } },
    { type: "financial_informations", id: "42", attributes: { security_deposit_amount: "0.0", iban_number: null } },
  ];
  return b;
}

/** Mirrors WRONG_NUMBER_SQL in the real store. */
const isWrongNumber = (l: { endpoint: string; status: number | null; responseBody?: unknown }) => {
  if (l.endpoint !== "rentalContractInvoices") return false;
  if (l.status === 400 || l.status === 404) return true;
  const data = (l.responseBody as { data?: { result?: { data?: unknown } } } | null)?.data?.result?.data;
  return l.status === 200 && Array.isArray(data) && data.length === 0;
};

/** Mirrors SUCCESS_SQL. */
const isSuccess = (l: { endpoint: string; status: number | null; responseBody?: unknown }) =>
  l.status != null && l.status >= 200 && l.status <= 299 && !isWrongNumber(l);

export interface LogRow {
  id: number; userId: number | null; env: string; endpoint: string; attempts: number;
  status: number | null; createdAt: Date; [k: string]: unknown;
}

/** In-memory EjarLookupStore. `logs` is shared with the client's log service. */
export class MemStore implements EjarLookupStore {
  logs: LogRow[] = [];
  lookups = new Map<string, SavedLookup>();
  imported = new Map<string, number>();
  /** user id → account (scope owner) */
  accountOf: Record<number, number> = {};
  scopes: Record<number, EjarScope> = {};
  /** account → plan/period; unset = Enterprise (no plan quota), so the gateway budget alone applies. */
  plans: Record<number, PlanPeriod> = {};
  owners: Array<{ id: number; accountId: number; name: string; idNumber: string | null; phone?: string | null; email?: string | null; isAccountHolder?: boolean }> = [];
  tenants: Array<{ id: number; accountId: number; name: string; nationalId: string | null; phone?: string | null; email?: string | null; isAccountHolder?: boolean }> = [];
  properties: Array<{ id: number; accountId: number; ownerId: number | null; usageLookupId: number | null; ejarId?: string | null; name?: string }> = [];
  units: Array<{ id: number; propertyId: number; unitNumber: string; usageLookupId: number | null; ejarId?: string | null }> = [];
  lookupRows: Array<{ id: number; category: string; key: string; labelAr?: string }> = [
    { id: 1, category: "property_type", key: "apartment_building" },
    { id: 2, category: "property_usage", key: "commercial" },
    { id: 3, category: "property_usage", key: "families" },
    { id: 4, category: "property_usage", key: "mixed" },
    { id: 5, category: "unit_type", key: "shop" },
    { id: 6, category: "city", key: "riyadh", labelAr: "الرياض" },
    { id: 7, category: "property_usage", key: "individuals" },
  ];
  private chain: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  locksTaken = 0;

  logService = {
    insert: async (rec: Record<string, unknown>) => {
      const row = { ...rec, id: this.logs.length + 1, createdAt: new Date() } as LogRow;
      this.logs.push(row);
      return row;
    },
  };

  withBudgetLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => { this.locksTaken++; return fn(); };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** The admin-set gateway pool; null = none. Spent = successful Balady calls. */
  pool: { limit: number; since?: Date } | null = null;

  async callPool(): Promise<{ limit: number; used: number } | null> {
    if (!this.pool) return null;
    const since = this.pool.since;
    const used = this.logs.filter((l) => l.env.startsWith("balady") && isSuccess(l) && (!since || l.createdAt >= since)).length;
    return { limit: this.pool.limit, used };
  }

  async wrongNumbers(since: Date, accountId: number): Promise<number> {
    return this.logs
      .filter((l) => l.env.startsWith("balady") && isWrongNumber(l) && l.createdAt >= since
        && (this.accountOf[l.userId ?? -1] ?? l.userId) === accountId)
      .reduce((s, l) => s + l.attempts, 0);
  }

  async usage(since: Date | null, accountId: number): Promise<LookupUsage> {
    // Mirrors SUCCESS_SQL: only a 2xx that is not a wrong number is deducted, one per row.
    const rows = this.logs.filter((l) => l.env.startsWith("balady") && isSuccess(l) && (!since || l.createdAt >= since));
    const sum = (endpoint: string, acct?: number) =>
      rows.filter((l) => l.endpoint === endpoint && (acct == null || (this.accountOf[l.userId ?? -1] ?? l.userId) === acct)).length;
    return {
      invoices: sum("rentalContractInvoices"),
      contracts: sum("getRentalContracts"),
      details: sum("contractDetails"),
      account: {
        invoices: sum("rentalContractInvoices", accountId),
        contracts: sum("getRentalContracts", accountId),
        details: sum("contractDetails", accountId),
      },
    };
  }

  async scope(accountId: number): Promise<EjarScope> { return this.scopes[accountId] ?? { locked: false, idNumber: null }; }
  /** account → the stored identity its inquiries are pinned to; unset = unpinned (Offices / Companies). */
  partyChecks: Record<number, EjarPartyCheck> = {};
  async partyCheck(accountId: number): Promise<EjarPartyCheck> { return this.partyChecks[accountId] ?? { role: null, idNumber: null }; }
  async planPeriod(accountId: number): Promise<PlanPeriod> {
    return this.plans[accountId] ?? { packagePlan: "enterprise", billingCycle: "yearly", subscriptionStartedAt: null, subscriptionEndsAt: null };
  }
  /** account → Ejar quota override / active add-on total; unset = none. */
  quotaAdjust: Record<number, LimitAdjustment> = {};
  /** account → Ejar switch; unset = default. */
  ejarModes: Record<number, EjarAccountMode> = {};
  /** Whether an Ejar pack is for sale. */
  async ejarQuotaAdjustment(accountId: number): Promise<LimitAdjustment> {
    return this.quotaAdjust[accountId] ?? { override: undefined, addons: 0 };
  }
  async ejarAccountMode(accountId: number): Promise<EjarAccountMode> { return this.ejarModes[accountId] ?? "default"; }
  async getLookup(accountId: number, n: string) { return this.lookups.get(`${accountId}:${n}`) ?? null; }
  async saveLookup(row: Omit<SavedLookup, "id" | "createdAt">) {
    const saved = { ...row, id: this.nextId++, createdAt: new Date() };
    this.lookups.set(`${row.accountId}:${row.contractNumber}`, saved);
    return saved;
  }
  async findImported(accountId: number, n: string) {
    const id = this.imported.get(`${accountId}:${n}`);
    return id ? { contractId: id } : null;
  }
  async findMatches(accountId: number, keys: MatchKeys): Promise<LookupMatches> {
    const o = this.owners.find((r) => r.accountId === accountId && r.idNumber && keys.landlord.includes(r.idNumber));
    const t = this.tenants.find((r) => r.accountId === accountId && r.nationalId && keys.tenant.includes(r.nationalId));
    const p = keys.propertyEjarId ? this.properties.find((r) => r.accountId === accountId && r.ejarId === keys.propertyEjarId) : null;
    const mine = new Set(this.properties.filter((r) => r.accountId === accountId).map((r) => r.id));
    const units = this.units
      .filter((u) => mine.has(u.propertyId) && u.ejarId && keys.unitEjarIds.includes(u.ejarId))
      .map((u) => ({ id: u.id, unitNumber: u.unitNumber, propertyId: u.propertyId, ejarId: u.ejarId ?? null }));
    return {
      landlord: o ? { id: o.id, name: o.name } : null,
      tenant: t ? { id: t.id, name: t.name } : null,
      property: p ? { id: p.id, name: p.name ?? "" } : null,
      units,
    };
  }
  async landlord(accountId: number, id: number): Promise<PartyMatch | null> {
    const o = this.owners.find((r) => r.id === id && r.accountId === accountId);
    return o ? { id: o.id, name: o.name } : null;
  }
  async tenant(accountId: number, id: number): Promise<PartyMatch | null> {
    const t = this.tenants.find((r) => r.id === id && r.accountId === accountId);
    return t ? { id: t.id, name: t.name } : null;
  }
  async property(accountId: number, id: number) {

    const p = this.properties.find((r) => r.id === id && r.accountId === accountId);
    return p ? { id: p.id, ownerId: p.ownerId, usageLookupId: p.usageLookupId } : null;
  }
  async unit(accountId: number, id: number) {
    const u = this.units.find((r) => r.id === id);
    if (!u || !this.properties.some((p) => p.id === u.propertyId && p.accountId === accountId)) return null;
    return { id: u.id, propertyId: u.propertyId, usageLookupId: u.usageLookupId };
  }
  async unitNumberTaken(propertyId: number, unitNumber: string) {
    return this.units.find((u) => u.propertyId === propertyId && u.unitNumber === unitNumber)?.id ?? null;
  }
  async lookupRow(id: number) {
    const r = this.lookupRows.find((x) => x.id === id);
    return r ? { id: r.id, category: r.category, key: r.key, labelAr: r.labelAr ?? null } : null;
  }
  /** Mirrors the writer's match (ID / CR, else name); no landlord cap in memory. */
  async existingParty(accountId: number, role: "landlord" | "tenant", key: PartyKey): Promise<LinkedParty | null> {
    const rows = role === "landlord"
      ? this.owners.map((o) => ({ ...o, idKey: o.idNumber }))
      : this.tenants.map((t) => ({ ...t, idKey: t.nationalId }));
    const r = rows.find((x) => x.accountId === accountId && (key.idNumber ? x.idKey === key.idNumber : !!key.name && x.name === key.name));
    return r ? { id: r.id, name: r.name, phone: r.phone ?? null, email: r.email ?? null, isAccountHolder: !!r.isAccountHolder } : null;
  }
  /** Log row id → the reason its body was withheld. */
  withheld = new Map<number, string>();
  async withholdLogBodies(ids: number[], reason: string): Promise<void> {
    for (const id of ids) {
      const row = this.logs.find((l) => l.id === id);
      if (row) { row.responseBody = { withheld: reason }; row.bodyTruncated = true; }
      this.withheld.set(id, reason);
    }
  }
  async resolveLookup(category: string, value: string) {
    return this.lookupRows.find((x) => x.category === category && (x.key === value || x.labelAr === value))?.id ?? null;
  }
}

const ENV_KEYS = [
  "EJAR_BASE_URL", "EJAR_CLIENT_ID", "EJAR_CLIENT_SECRET",
  "EJAR_BALADY_BASE_URL", "EJAR_BALADY_CLIENT_ID", "EJAR_BALADY_CLIENT_SECRET",
  "EJAR_ACCESS", "EJAR_ALLOWED_USER_IDS",
  "EJAR_LOOKUP_LIMIT", "EJAR_LOOKUP_WINDOW", "EJAR_LOOKUP_LIMIT_PER_ACCOUNT", "EJAR_LOOKUP_CACHE_HOURS", "EJAR_LOOKUP_SECOND_CALL", "EJAR_LOOKUP_WRONG_NUMBERS_PER_DAY",
];

export interface Call { url: string; init: RequestInit }

/**
 * One isolated Balady-staging world. Call `restore()` in afterEach.
 * `respond` decides each DATA call; the token endpoint always answers.
 */
export function world(opts: { env?: Record<string, string>; delayMs?: number } = {}) {
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.EJAR_BALADY_BASE_URL = STG;
  process.env.EJAR_BALADY_CLIENT_ID = "fake-id";
  process.env.EJAR_BALADY_CLIENT_SECRET = "fake-secret";
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;

  const calls: Call[] = [];
  const known = new Set<string>([CN]);
  const details = new Map<string, unknown>();
  /** Contract numbers Get Contracts holds (default: every known one). Remove one to make it answer count 0. */
  const listed = new Set<string>();
  let listAll = true;
  let respond: (url: string) => Response | Promise<Response> = (url) => {
    const inv = url.match(/\/v1\/ejar-services\/contracts\/(\d+)\/invoices/);
    if (inv) return known.has(inv[1]) ? baladyOk(invoicesFor(inv[1])) : baladyErr(400, "E1.11", "رقم العقد غير صحيح");
    const list = url.match(/\/v1\/ejar-services\/contracts\?(.*)$/);
    if (list) {
      const q = new URLSearchParams(list[1]);
      const n = [...known].find((k) => uuidFor(k) === q.get("contract_ids"));
      return baladyOk(n && (listAll || listed.has(n)) ? contractsFor(n) : EMPTY_CONTRACTS);
    }
    const det = url.match(/\/v1\/ejar-services\/contracts\/([0-9a-f-]{36})$/i);
    if (det) {
      const n = [...known].find((k) => uuidFor(k) === det[1]);
      return n ? baladyOk(details.get(n) ?? detailsFor(n)) : baladyErr(500, "E500", "internal");
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const u = String(url);
    if (!u.startsWith(STG)) throw new Error(`test tried to reach a non-staging host: ${u}`);
    calls.push({ url: u, init });
    if (u.endsWith("/oauth/v1/token")) return tokenOk();
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return respond(u);
  }) as typeof fetch;

  const store = new MemStore();
  const client = new EjarClientService(store.logService as never);
  const svc = new EjarLookupService(client, store);
  return {
    store, client, svc, calls, known, details,
    /** Make Get Contracts hold only these contract numbers (others answer count 0). */
    listOnly: (...ns: string[]) => { listAll = false; listed.clear(); for (const n of ns) listed.add(n); },
    /** Data calls only (the OAuth token request is not one). */
    dataCalls: () => calls.filter((c) => !c.url.endsWith("/oauth/v1/token")),
    setRespond: (fn: (url: string) => Response | Promise<Response>) => { respond = fn; },
    restore: () => {
      globalThis.fetch = realFetch;
      for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    },
  };
}

/** The HTTP status and JSON body of a thrown Nest HttpException. */
export async function httpError(p: Promise<unknown>): Promise<{ status: number; body: any }> {
  try {
    await p;
  } catch (e: any) {
    if (typeof e?.getStatus === "function") return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
  throw new Error("expected the call to fail");
}
