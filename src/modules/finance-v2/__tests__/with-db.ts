import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";

/**
 * The Finance v2 DB-spec harness (DESIGN §11.3).
 *
 *  - Reads FV2_TEST_DATABASE_URL ONLY — never DATABASE_URL — and refuses
 *    anything but localhost / 127.0.0.1, so a production URL in .env can never
 *    be reached by `pnpm test`.
 *  - Refuses API_PORT=4000 (the port the real API listens on).
 *  - Every run gets a fresh schema `fv2_test_<rand>` (search_path), dropped
 *    at the end, so runs never see each other's rows.
 *
 *   FV2_TEST_DATABASE_URL=postgres://postgres@localhost:55432/fv2_test pnpm test
 */
export const FV2_URL = process.env.FV2_TEST_DATABASE_URL ?? "";
const LOCAL = /^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)(:\d+)?\//.test(FV2_URL);

export const fv2DbSkip: string | false = !FV2_URL
  ? "FV2_TEST_DATABASE_URL not set"
  : !LOCAL
    ? "FV2_TEST_DATABASE_URL must point at localhost"
    : process.env.API_PORT === "4000"
      ? "API_PORT is 4000 (a real API); refusing to run DB specs"
      : false;

export const MIGRATION_0066 = join(__dirname, "../../../../db/drizzle/0066_finance_v2.sql");
export const MIGRATION_0067 = join(__dirname, "../../../../db/drizzle/0067_finance_v2_tier2.sql");
export const MIGRATION_0068 = join(__dirname, "../../../../db/drizzle/0068_finance_v2_hardening.sql");
export const MIGRATION_0069 = join(__dirname, "../../../../db/drizzle/0069_finance_v2_tier3.sql");
export const MIGRATION_0070 = join(__dirname, "../../../../db/drizzle/0070_finance_v2_commission.sql");
export const MIGRATION_0071 = join(__dirname, "../../../../db/drizzle/0071_finance_v2_controls.sql");
export const MIGRATION_0073 = join(__dirname, "../../../../db/drizzle/0073_finance_v2_autoinvoice.sql");
export const MIGRATION_0074 = join(__dirname, "../../../../db/drizzle/0074_finance_v2_assets.sql");
export const MIGRATION_0075 = join(__dirname, "../../../../db/drizzle/0075_finance_v2_property_commission.sql");
export const MIGRATION_0076 = join(__dirname, "../../../../db/drizzle/0076_finance_v2_trust_mandatory.sql");
export const MIGRATION_0079 = join(__dirname, "../../../../db/drizzle/0079_finance_v2_payout_vouchers.sql");
export const MIGRATION_0080 = join(__dirname, "../../../../db/drizzle/0080_finance_v2_manual_journal_meta.sql");
export const MIGRATION_0094 = join(__dirname, "../../../../db/drizzle/0094_finance_rent_revenue_basis.sql");
/** Second-person approval for large manual journals (0102). Idempotent. */
export const MIGRATION_0102 = join(__dirname, "../../../../db/drizzle/0102_finance_manual_journal_second_approval.sql");
/** Journal bills: a supplier's opening balance from a journal line (0101). */
export const MIGRATION_0101 = join(__dirname, "../../../../db/drizzle/0101_finance_v2_journal_bills.sql");
export const LEGACY_MIN = join(__dirname, "legacy-min.sql");
/** Recurring billing columns on users / subscription_payments — newer than legacy-schema.sql. Idempotent. */
export const MIGRATION_0097 = join(__dirname, "../../../../db/drizzle/0097_moyasar_tokenization.sql");
/** Bank-transfer receipt + review columns on subscription_payments (0099). Idempotent. */
export const MIGRATION_0099 = join(__dirname, "../../../../db/drizzle/0099_bank_transfer.sql");
/** subscription_payments.gateway / gateway_ref / gateway_invoice_id (0103, Dhamen). Idempotent. */
export const MIGRATION_0103 = join(__dirname, "../../../../db/drizzle/0103_subscription_gateway.sql");
/** properties.branch_name (0095) — newer than legacy-schema.sql; drizzle's full-row property selects read it. Idempotent. */
export const MIGRATION_0095 = join(__dirname, "../../../../db/drizzle/0095_property_branch_name.sql");
/** The full legacy schema (schema only, generated from db/src/schema), for the hook specs that run real legacy handlers. */
export const LEGACY_FULL = join(__dirname, "legacy-schema.sql");

export interface TestDb {
  pool: pg.Pool;
  schema: string;
  /** Apply a SQL file in this schema. */
  apply(file: string): Promise<void>;
  drop(): Promise<void>;
}

/** A fresh schema with the minimal legacy tables (optional) and 0066 applied. */
export async function withDb(opts: { legacy?: boolean | "full"; migrate?: boolean } = {}): Promise<TestDb> {
  if (fv2DbSkip) throw new Error(`fv2 DB specs: ${fv2DbSkip}`);
  const schema = `fv2_test_${randomBytes(5).toString("hex")}`;
  const admin = new pg.Client({ connectionString: FV2_URL });
  await admin.connect();
  await admin.query(`create schema ${schema}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: FV2_URL, max: 6, options: `-c search_path=${schema}` });
  const apply = async (file: string) => {
    await pool.query(readFileSync(file, "utf8"));
  };
  if (opts.legacy === "full") {
    await apply(LEGACY_FULL);
    // Full-row selects of users / subscription_payments read the 0097 + 0099 columns.
    await apply(MIGRATION_0097);
    await apply(MIGRATION_0099);
    await apply(MIGRATION_0103);
    await apply(MIGRATION_0095);
  }
  else if (opts.legacy !== false) await apply(LEGACY_MIN);
  if (opts.migrate !== false) {
    await apply(MIGRATION_0066);
    await apply(MIGRATION_0067);
    await apply(MIGRATION_0068);
    await apply(MIGRATION_0069);
    await apply(MIGRATION_0070);
    await apply(MIGRATION_0071);
    await apply(MIGRATION_0073);
    await apply(MIGRATION_0074);
    await apply(MIGRATION_0075);
    await apply(MIGRATION_0076);
    await apply(MIGRATION_0079);
    await apply(MIGRATION_0080);
    await apply(MIGRATION_0094);
    await apply(MIGRATION_0102);
    await apply(MIGRATION_0101);
  }
  return {
    pool,
    schema,
    apply,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: FV2_URL });
      await c.connect();
      await c.query(`drop schema if exists ${schema} cascade`);
      await c.end();
    },
  };
}
