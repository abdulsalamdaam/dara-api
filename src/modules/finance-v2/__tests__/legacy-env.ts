import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../../db/src/schema";
import { withDb, type TestDb } from "./with-db";
import { PaymentsModule } from "../../payments/payments.module";
import { BillingModule } from "../../billing/billing.module";
import { ContractsModule } from "../../contracts/contracts.module";
import { ReportsModule } from "../../reports/reports.module";
import { DashboardModule } from "../../dashboard/dashboard.module";
import { FinanceFlagService } from "../flag.service";
import { LedgerEmitter } from "../ledger-emitter.service";
import { FinanceV2Hooks } from "../hooks/hooks.service";
import { PeriodsService } from "../periods.service";
import { ChartService } from "../chart.service";
import { FinanceSetupService } from "../setup.service";
import { JournalRepository } from "../journal.repository";
import { PostingEngine } from "../posting.engine";
import { PostingWorker } from "../posting-worker.service";
import { RecognizerService } from "../recognizer.service";
import { withTx } from "../db";

/**
 * A throwaway schema with the FULL legacy schema + 0066, and the REAL legacy
 * controllers wired to it (DESIGN §11.3-c). Controllers are taken from their
 * modules' metadata and constructed directly; `fv2h` is assigned the way Nest's
 * property injection would, or left undefined (`hooks: "none"`) to get the
 * code path exactly as it was before any finance-v2 line existed.
 *
 * ZATCA is never reached: the billing controller's submission step is
 * replaced on the instance, and its ZATCA services are objects that throw.
 * Every value here is synthetic (public repo, hard rule 6).
 */
export type Hooked = "wired" | "none";

export interface LegacyEnv {
  t: TestDb;
  db: any;
  hooks: FinanceV2Hooks;
  flag: FinanceFlagService;
  emitter: LedgerEmitter;
  engine: PostingEngine;
  worker: PostingWorker;
  recognizer: RecognizerService;
  setup: FinanceSetupService;
  payments: any;
  billing: any;
  contracts: any;
  reports: any;
  dashboard: any;
  q: (sql: string, p?: unknown[]) => Promise<any[]>;
}

const ctl = (mod: unknown) => (Reflect as any).getMetadata("controllers", mod)[0];
const refuse = new Proxy({}, { get: () => () => { throw new Error("fv2 spec: ZATCA must not be reached"); } });

export async function legacyEnv(hooked: Hooked): Promise<LegacyEnv> {
  process.env.FINANCE_V2_WORKER_DISABLED = "1";
  const t = await withDb({ legacy: "full" });
  const db = drizzle(t.pool, { schema });
  const flag = new FinanceFlagService(t.pool);
  const emitter = new LedgerEmitter(t.pool);
  const hooks = new FinanceV2Hooks(t.pool, flag, emitter);
  const periods = new PeriodsService(t.pool);
  const chart = new ChartService(t.pool);
  const setup = new FinanceSetupService(chart, periods);
  const engine = new PostingEngine(t.pool, new JournalRepository(periods), periods);
  const worker = new PostingWorker(t.pool, engine, emitter);
  worker.lockPool = t.pool;
  worker.onModuleInit();
  const recognizer = new RecognizerService(t.pool, emitter);

  const Payments = ctl(PaymentsModule);
  const Billing = ctl(BillingModule);
  const Contracts = ctl(ContractsModule);
  const Reports = ctl(ReportsModule);
  const payments = new Payments(db);
  const billing = new Billing(db, refuse, refuse, refuse, refuse, { record: () => undefined });
  billing.submitApprovedDocToZatca = async () => ({ submitted: false, code: "skipped", reason: "fv2 spec: ZATCA stubbed" });
  const contracts = new Contracts(db);
  const reports = new Reports(db);
  const dashboard = new (ctl(DashboardModule))(db);
  if (hooked === "wired") for (const c of [payments, billing, contracts, reports, dashboard]) c.fv2h = hooks;
  const q = async (sql: string, p: unknown[] = []) => (await t.pool.query(sql, p)).rows;
  return { t, db, hooks, flag, emitter, engine, worker, recognizer, setup, payments, billing, contracts, reports, dashboard, q };
}

/** Switch Finance v2 on for an account the way the admin toggle does (seed chart, periods, banks), and start its ledger. */
export async function enableV2(env: LegacyEnv, userId: number, mode: "owner" | "manager" = "manager"): Promise<void> {
  await withTx(env.t.pool, async (c) => {
    await c.query(
      `insert into finance_settings (account_user_id, finance_v2_enabled, accounting_mode, enabled_at, ledger_started_at)
       values ($1, true, $2, now(), now())`,
      [userId, mode],
    );
    await env.setup.firstEnable(c, userId, null);
  });
  env.flag.invalidate(userId);
}

/**
 * An account as it was before the trust account became mandatory (round 3): no trust bank account and trust
 * routing off. For specs about other mechanics ("received into", R4, expenses) that collect a landlord's rent
 * or a deposit into an operating account; the trust rule itself is covered in overrides/installment-docs.db.spec.ts.
 */
export async function withoutTrust(env: LegacyEnv, userId: number): Promise<void> {
  await env.t.pool.query(`update finance_settings set agency_collections_to_trust = false where account_user_id = $1`, [userId]);
  await env.t.pool.query(`update accounts set bank_account_id = null where user_id = $1 and bank_account_id in (select id from bank_accounts where user_id = $1 and is_trust)`, [userId]);
  await env.t.pool.query(`delete from bank_accounts where user_id = $1 and is_trust`, [userId]);
  env.flag.invalidate(userId);
}

export interface Seed {
  user: number;
  /** Agent landlord (not the account holder), VAT-registered, fully addressed, ZATCA-linked (sandbox, dummy). */
  agent: number;
  /** The account-holder landlord (principal). */
  holder: number;
  tenant: number;
  /** Property of the agent landlord, 5% management fee. */
  propA: number;
  /** Property of the account holder. */
  propH: number;
  unitA1: number;
  unitA2: number;
  unitH1: number;
}

/** Synthetic account: one agent landlord, the account-holder landlord, one tenant, two properties, three units. */
export async function seedAccount(env: LegacyEnv, user: number): Promise<Seed> {
  const one = async (sql: string, p: unknown[]) => Number((await env.q(sql, p))[0].id);
  await env.q(`insert into users (id, email, password_hash, name, user_type) values ($1, $2, 'x', 'Synthetic Co', 'company')`,
    [user, `fv2-spec-${user}@example.test`]);
  const addr = [`Synthetic St ${user}`, "1234", "Test District", "Riyadh", "12345"];
  const owner = (name: string, holder: boolean, vat: string, idn: string) => one(
    `insert into owners (user_id, name, email, phone, id_number, tax_number, national_address_street, building_number,
                         national_address_district, national_address_city, postal_code, is_account_holder, type)
     values ($1, $2, $3, '0500000000', $4, $5, $6, $7, $8, $9, $10, $11, 'company') returning id`,
    [user, name, `owner-${idn}@example.test`, idn, vat, ...addr, holder]);
  const agent = await owner("Synthetic Landlord A", false, "300000000000003", `70000${user}`);
  const holder = await owner("Synthetic Holder", true, "310000000000003", `70001${user}`);
  const tenant = await one(
    `insert into tenants (user_id, name, email, phone, national_id, type) values ($1, 'Synthetic Tenant', $2, '0500000001', $3, 'individual') returning id`,
    [user, `tenant-${user}@example.test`, `10000${user}`]);
  const prop = (name: string, ownerId: number, fee: string | null) => one(
    `insert into properties (user_id, name, owner_id, management_fee_percent) values ($1, $2, $3, $4) returning id`, [user, name, ownerId, fee]);
  const propA = await prop("Synthetic Tower", agent, "5");
  const propH = await prop("Synthetic Villa", holder, null);
  const unit = (p: number, n: string) => one(`insert into units (property_id, unit_number) values ($1, $2) returning id`, [p, n]);
  const unitA1 = await unit(propA, "A1");
  const unitA2 = await unit(propA, "A2");
  const unitH1 = await unit(propH, "H1");
  await env.q(
    `insert into zatca_credentials (user_id, owner_id, active_environment, seller_name, seller_vat_number, seller_street, seller_building_no,
       seller_district, seller_city, seller_postal_zone, serial_number, organization_identifier, organization_unit_name, location_address,
       industry_category, common_name, sandbox_private_key_enc, sandbox_binary_security_token, sandbox_secret_enc, sandbox_cert_pem)
     values ($1, $2, 'sandbox', 'Synthetic Landlord A', '300000000000003', 'St', '1234', 'D', 'Riyadh', '12345', '1-X|2-Y|3-Z',
       '300000000000003', 'Unit', 'Riyadh', 'Real estate', 'fv2-spec', 'dummy', 'dummy', 'dummy', 'dummy')`,
    [user, agent]);
  return { user, agent, holder, tenant, propA, propH, unitA1, unitA2, unitH1 };
}

export const userOf = (id: number) => ({ id, ownerUserId: null, email: `fv2-spec-${id}@example.test`, role: "user" }) as any;

/** Run an action; return its value, or the HTTP error it threw as { status, body }. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | { status: number; body: unknown }> {
  try {
    return await fn();
  } catch (err: any) {
    if (typeof err?.getStatus === "function") return { status: err.getStatus(), body: err.getResponse() };
    throw err;
  }
}

/** Replace volatile values (timestamps) so two runs on identical fixtures compare byte for byte. */
export function normalise(v: unknown): unknown {
  if (v instanceof Date) return "<ts>";
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalise(x)]));
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) return "<ts>";
  return v;
}
