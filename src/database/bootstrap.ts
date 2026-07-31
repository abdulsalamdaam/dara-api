import { Logger } from "@nestjs/common";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pool } from "@oqudk/database";

const log = new Logger("DBBootstrap");

/**
 * Run-on-boot schema + data initializer. Two-phase, both idempotent:
 *
 *   1. ensureSchema() — if the `users` table is missing, run db/init.sql
 *      to create all tables, enums, FKs, indexes.
 *   2. ensureData()   — if users-table is empty AND db/data.sql exists,
 *      load it (one-shot data seed for fresh deploys).
 *
 * Both run inside a transaction; failures rollback.
 *
 * Designed for fresh-cluster deploys (Coolify/Docker). For schema changes
 * after initial creation, regenerate `db/init.sql` and apply manually —
 * this does NOT run a real schema diff/migration.
 */
function findSqlFile(name: string): string | null {
  const candidates = [
    // Compiled image: dist/src/database/bootstrap.js → ../../../db/<name>
    join(__dirname, "..", "..", "..", "db", name),
    // Dev runtime: src/database/bootstrap.ts → ../../db/<name>
    join(__dirname, "..", "..", "db", name),
    // Subdirectory variant for ad-hoc migrations under db/sql/<name>.
    join(__dirname, "..", "..", "..", "db", "sql", name),
    join(__dirname, "..", "..", "db", "sql", name),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Idempotent migrations that should run on every boot. New additive changes
 * (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, INSERT ... ON CONFLICT
 * DO NOTHING) go here. Destructive migrations (DROP COLUMN, etc.) should be
 * handled out of band.
 */
const PASSIVE_MIGRATIONS = [
  "2026_05_companies_roles_email_otp.sql",
  "2026_05_drop_legacy_user_columns.sql",
  "2026_06_unit_amenities_data.sql",
  "2026_06_fee_type_utilities.sql",
  "2026_07_ejar_integration.sql",
];

async function runSqlFile(client: any, label: string, file: string) {
  const sql = readFileSync(file, "utf8");
  log.log(`Running ${label}: ${file} (${sql.length} chars)`);
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
    log.log(`${label} applied ✓`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export async function ensureSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    // Phase 1: schema
    const schemaCheck = await client.query<{ exists: boolean }>(
      `select exists (
         select 1 from information_schema.tables
         where table_schema = 'public' and table_name = 'users'
       ) as exists`,
    );
    if (schemaCheck.rows[0]?.exists) {
      log.log("Schema already initialized — skipping init.sql");
    } else {
      const initFile = findSqlFile("init.sql");
      if (!initFile) {
        log.warn("init.sql not found — schema NOT created. API will fail on first query.");
        return;
      }
      await runSqlFile(client, "init.sql", initFile);
    }

    // Phase 1.5: passive migrations — additive, idempotent, run every boot.
    for (const file of PASSIVE_MIGRATIONS) {
      const path = findSqlFile(file);
      if (!path) {
        log.warn(`migration ${file} not found — skipped`);
        continue;
      }
      try {
        await runSqlFile(client, `migration ${file}`, path);
      } catch (err: any) {
        log.error(`migration ${file} failed: ${err?.message || err}`);
        throw err;
      }
    }

    // Additive columns that must run regardless of whether the db/sql migration
    // files were copied into the image — idempotent, applied on every boot.
    try {
      await client.query(`alter table simple_invoices add column if not exists pdf_key text`);
    } catch (err: any) {
      log.warn(`ensure simple_invoices.pdf_key failed: ${err?.message || err}`);
    }
    try {
      await client.query(`alter table simple_invoices add column if not exists zatca_status text`);
      await client.query(`alter table simple_invoices add column if not exists zatca_error text`);
    } catch (err: any) {
      log.warn(`ensure simple_invoices.zatca_status/zatca_error failed: ${err?.message || err}`);
    }

    // Owner (landlord) push token columns — mirrors the tenants.fcm_* columns.
    try {
      await client.query(`alter table owners add column if not exists fcm_token text`);
      await client.query(`alter table owners add column if not exists fcm_platform text`);
    } catch (err: any) {
      log.warn(`ensure owners.fcm_token/fcm_platform failed: ${err?.message || err}`);
    }

    // Owner notifications inbox — mirrors the notifications table but targets an owner.
    try {
      await client.query(`
        create table if not exists owner_notifications (
          id serial primary key,
          user_id integer not null,
          owner_id integer not null,
          title text not null,
          body text not null,
          type text not null default 'custom',
          read_at timestamptz,
          deleted_at timestamptz,
          created_at timestamptz not null default now()
        )
      `);
    } catch (err: any) {
      log.warn(`ensure owner_notifications table failed: ${err?.message || err}`);
    }

    // Ejar (NHC) integration — mark imported contracts + the API request log.
    // Declared inline (not only in db/sql/) because the runtime image copies
    // db/init.sql + db/data.sql but NOT db/sql/*, so the passive-migration
    // file never reaches production. Idempotent, applied on every boot.
    try {
      await client.query(`alter table contracts add column if not exists ejar_source text`);
      // Reuse imported properties/units across contracts (dedupe by Ejar UUID).
      await client.query(`alter table properties add column if not exists ejar_id text`);
      await client.query(`alter table properties add column if not exists ejar_source text`);
      await client.query(`alter table units add column if not exists ejar_id text`);
      await client.query(`alter table units add column if not exists ejar_source text`);
      await client.query(`create index if not exists properties_ejar_id_idx on properties (user_id, ejar_id)`);
      await client.query(`create index if not exists units_ejar_id_idx on units (ejar_id)`);
      // Verbatim Ejar payload per imported entity. Ejar returns many fields we
      // have no typed column for; snapshotting them keeps the import lossless
      // and lets any of them be promoted to a real column later without
      // re-fetching from NHC.
      await client.query(`alter table contracts add column if not exists ejar_raw jsonb`);
      await client.query(`alter table properties add column if not exists ejar_raw jsonb`);
      await client.query(`alter table units add column if not exists ejar_raw jsonb`);
      for (const tbl of ["tenants", "owners", "deeds"]) {
        await client.query(`alter table ${tbl} add column if not exists ejar_source text`);
        await client.query(`alter table ${tbl} add column if not exists ejar_raw jsonb`);
      }
      // Platform settings — the manual-add override and the cached Ejar
      // connectivity verdict that together decide whether the "Add" buttons
      // are live. Global by design (one Ejar connection per deployment).
      await client.query(`
        create table if not exists app_settings (
          id serial primary key,
          key text not null,
          value jsonb,
          updated_at timestamptz not null default now()
        )
      `);
      await client.query(`create unique index if not exists app_settings_key_uniq on app_settings (key)`);
      // Owners named on the deed document itself (co-owners), distinct from
      // deeds.owner_id which is the landlord the deed is filed under.
      await client.query(`alter table deeds add column if not exists deed_owners jsonb`);
      // Optional Google Maps link; Ejar imports fill it from the coordinates.
      await client.query(`alter table properties add column if not exists map_url text`);
      // Deed types move from a hard-coded pair to the central lookups table.
      // The `electronic` / `paper` keys are kept verbatim so existing deeds
      // stay valid and need no backfill; the other two are new options.
      // NOT EXISTS rather than ON CONFLICT: the unique index includes the
      // nullable company_id, and Postgres treats NULLs as distinct, so the
      // conflict target never matches a system row.
      await client.query(`
        insert into lookups (category, key, label_ar, label_en, sort_order, company_id)
        select v.category, v.key, v.label_ar, v.label_en, v.sort_order, null
        from (values
          ('deed_type', 'electronic',           'صك ملكية إلكتروني', 'Electronic Title Deed',           1),
          ('deed_type', 'paper',                'صك ملكية ورقي',     'Paper Title Deed',                2),
          ('deed_type', 'hojjat_esthkam',       'حجة استحكام',       'Hojjat Esthkam',                  3),
          ('deed_type', 'real_estate_registry', 'صك السجل العقاري',  'Real Estate Registry Title Deed', 4)
        ) as v(category, key, label_ar, label_en, sort_order)
        where not exists (
          select 1 from lookups l
          where l.category = v.category and l.key = v.key and l.company_id is null
        )
      `);
      await client.query(`
        create table if not exists ejar_api_logs (
          id serial primary key,
          user_id integer,
          env text not null default 'uat',
          endpoint text not null,
          method text not null,
          url text not null,
          params jsonb,
          request_headers jsonb,
          status integer,
          ejar_status integer,
          transaction_id text,
          duration_ms integer not null default 0,
          attempts integer not null default 1,
          response_body jsonb,
          body_truncated boolean not null default false,
          error text,
          created_at timestamptz not null default now()
        )
      `);
      await client.query(`create index if not exists ejar_api_logs_created_idx on ejar_api_logs (created_at)`);
      await client.query(`create index if not exists ejar_api_logs_endpoint_idx on ejar_api_logs (endpoint)`);
      await client.query(`create index if not exists ejar_api_logs_user_idx on ejar_api_logs (user_id)`);
    } catch (err: any) {
      log.warn(`ensure ejar_source/ejar_api_logs failed: ${err?.message || err}`);
    }

    // Phase 1.6: refresh system role permissions on every boot. Keeps the
    // roles table in sync with code-side ROLE_PRESETS + EMPLOYEE_PRESETS
    // without requiring a hand-written migration each time we add a
    // permission. Upserts (insert if missing, update if present) so a new
    // preset added in code shows up in the DB on next boot.
    try {
      const { ROLE_PRESETS, ALL_PERMISSIONS, EMPLOYEE_PRESETS } = await import("../common/permissions");
      const presets: Array<{ key: string; perms: readonly string[]; labelAr: string; labelEn: string }> = [
        { key: "super_admin", perms: ALL_PERMISSIONS, labelAr: "مدير النظام", labelEn: "Super Admin" },
        { key: "admin",       perms: ROLE_PRESETS.admin, labelAr: "مشرف",         labelEn: "Admin" },
        { key: "user",        perms: ROLE_PRESETS.user,  labelAr: "مالك / مدير",  labelEn: "Owner / Manager" },
        { key: "demo",        perms: ROLE_PRESETS.demo,  labelAr: "تجريبي",       labelEn: "Demo" },
      ];
      // Employee presets become first-class system roles: each one is a
      // distinct row keyed by its preset id (e.g. "accountant"). Linking
      // an employee to it via users.role_id is now the only way to grant
      // them a custom permission set.
      for (const [key, def] of Object.entries(EMPLOYEE_PRESETS)) {
        presets.push({ key, perms: def.permissions, labelAr: def.labelAr, labelEn: def.labelEn });
      }
      for (const r of presets) {
        await client.query(
          `insert into roles (key, label_ar, label_en, permissions, is_system, company_id)
                 values ($1, $3, $4, $2::jsonb, true, null)
           on conflict (key) where company_id is null do update set
             permissions = excluded.permissions,
             label_ar    = excluded.label_ar,
             label_en    = excluded.label_en,
             is_system   = true,
             updated_at  = now()`,
          [r.key, JSON.stringify(r.perms), r.labelAr, r.labelEn],
        );
      }
      log.log("System role presets refreshed ✓");
    } catch (err: any) {
      log.warn(`role refresh skipped: ${err?.message || err}`);
    }

    // Phase 2: seed data (only if users-table is empty and data.sql exists)
    const userCount = await client.query<{ count: string }>(
      `select count(*)::text as count from public.users`,
    );
    if (parseInt(userCount.rows[0]?.count ?? "0", 10) > 0) {
      log.log("Users table not empty — skipping data.sql");
      return;
    }
    const dataFile = findSqlFile("data.sql");
    if (!dataFile) {
      log.log("No data.sql to seed — DB is empty (this is fine for a green-field deploy).");
      return;
    }
    await runSqlFile(client, "data.sql", dataFile);
  } finally {
    client.release();
  }
}
