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
export const MIGRATION_0071 = join(__dirname, "../../../../db/drizzle/0071_finance_v2_controls.sql");
export const LEGACY_MIN = join(__dirname, "legacy-min.sql");
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
  if (opts.legacy === "full") await apply(LEGACY_FULL);
  else if (opts.legacy !== false) await apply(LEGACY_MIN);
  if (opts.migrate !== false) {
    await apply(MIGRATION_0066);
    await apply(MIGRATION_0067);
    await apply(MIGRATION_0068);
    await apply(MIGRATION_0069);
    await apply(MIGRATION_0071);
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
