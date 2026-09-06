import { Logger } from "@nestjs/common";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pool } from "@dara/database";

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
      // The signed Phase-2 QR for this document. Additive and nullable: every
      // existing row keeps printing the Phase-1 fallback untouched.
      await client.query(`alter table simple_invoices add column if not exists zatca_qr text`);
      await client.query(`alter table simple_invoices add column if not exists zatca_invoice_id integer`);
    } catch (err: any) {
      log.warn(`ensure simple_invoices.zatca_status/zatca_error/zatca_qr failed: ${err?.message || err}`);
    }

    // ZATCA link health. The taxpayer can remove our EGS device in the Fatoora
    // portal, and nothing tells us — the row keeps its certificate, so every
    // local check passes while every submission is refused. These two columns
    // are the only record of that state; both nullable, so existing rows read
    // as "link fine", which is the correct default.
    try {
      await client.query(`alter table zatca_credentials add column if not exists link_invalid_at timestamptz`);
      await client.query(`alter table zatca_credentials add column if not exists link_invalid_reason text`);
    } catch (err: any) {
      log.warn(`ensure zatca_credentials.link_invalid_at/link_invalid_reason failed: ${err?.message || err}`);
    }

    // The subscription tax invoice we issue when a customer pays. All four are
    // nullable and stamped at activation, so every historical row simply has no
    // invoice — which is correct: none was ever issued for it.
    try {
      await client.query(`alter table subscription_payments add column if not exists invoice_number text`);
      await client.query(`alter table subscription_payments add column if not exists invoice_issued_at timestamptz`);
      await client.query(`alter table subscription_payments add column if not exists period_start timestamptz`);
      await client.query(`alter table subscription_payments add column if not exists period_end timestamptz`);
    } catch (err: any) {
      log.warn(`ensure subscription_payments invoice columns failed: ${err?.message || err}`);
    }

    // "This account has already had its free trial." `subscription_is_trial`
    // is cleared by the first payment, so without this column nothing on the
    // row remembers a trial was ever granted and an account could be given a
    // fresh one on every approval or package change. Nullable, so every
    // existing row reads as "no trial consumed" — correct for accounts that
    // predate the automatic grant.
    try {
      await client.query(`alter table users add column if not exists trial_consumed_at timestamptz`);
    } catch (err: any) {
      log.warn(`ensure users.trial_consumed_at failed: ${err?.message || err}`);
    }

    // Unit-level usage override. NULL keeps the historical behaviour of
    // inheriting the property's usage; only mixed-use properties set it.
    try {
      await client.query(`alter table units add column if not exists usage_lookup_id integer references lookups(id) on delete set null`);
    } catch (err: any) {
      log.warn(`ensure units.usage_lookup_id failed: ${err?.message || err}`);
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
      // Property/unit taxonomy. Rows are matched by KEY and relabelled rather
      // than replaced: properties and units point here through *_lookup_id, so
      // swapping in a fresh set would blank the type on every existing record.
      await client.query(`
        with target(category, key, label_ar, label_en, sort_order) as (values
          ('property_type', 'land', 'أرض', 'Land', 1),
          ('property_type', 'apartment_building', 'عمارة', 'Building', 2),
          ('property_type', 'tower', 'برج', 'Tower', 3),
          ('property_type', 'villa', 'فيلا', 'Villa', 4),
          ('property_type', 'plaza', 'مجمع تجاري مفتوح (بلازا)', 'Open Commercial Complex (Plaza)', 5),
          ('property_type', 'mall', 'مجمع تجاري مغلق (مول)', 'Closed Commercial Complex (Mall)', 6),
          ('property_type', 'factory', 'مصنع', 'Factory', 7),
          ('property_type', 'chalet', 'استراحة', 'Rest House', 8),
          ('property_type', 'farm', 'مزرعة', 'Farm', 9),
          ('property_usage', 'families', 'سكن عائلات', 'Family Residential', 1),
          ('property_usage', 'individuals', 'سكن أفراد', 'Individual Residential', 2),
          ('property_usage', 'commercial', 'تجاري', 'Commercial', 3),
          ('property_usage', 'mixed', 'سكني - تجاري', 'Residential - Commercial', 4),
          ('property_usage', 'group_housing', 'السكن الجماعي', 'Group Housing', 5),
          ('property_usage', 'residential_investment', 'سكن استثماري', 'Residential Investment', 6),
          ('property_usage', 'industrial', 'صناعي', 'Industrial', 7),
          ('property_usage', 'agricultural', 'زراعي', 'Agricultural', 8),
          ('unit_type', 'kiosk', 'كشك', 'Kiosk', 1),
          ('unit_type', 'shop', 'محل', 'Shop', 2),
          ('unit_type', 'workshop', 'ورشة', 'Workshop', 3),
          ('unit_type', 'land', 'أرض', 'Land', 4),
          ('unit_type', 'leasedLand', 'أرض مسورة', 'Fenced Land', 5),
          ('unit_type', 'station', 'محطة', 'Station', 6),
          ('unit_type', 'office', 'مكتب', 'Office', 7),
          ('unit_type', 'warehouse', 'مستودع', 'Warehouse', 8),
          ('unit_type', 'showroom', 'معرض', 'Showroom', 9),
          ('unit_type', 'atm', 'صراف', 'Exchange Office', 10),
          ('unit_type', 'cinema', 'سينما', 'Cinema', 11),
          ('unit_type', 'powerStation', 'محطة كهرباء', 'Power Station', 12),
          ('unit_type', 'telecomTower', 'برج اتصالات', 'Telecommunications Tower', 13),
          ('unit_type', 'hotel', 'فندق', 'Hotel', 14),
          ('unit_type', 'parkingLot', 'مواقف سيارات', 'Car Parking', 15),
          ('unit_type', 'plaza', 'مجمع تجاري مفتوح (بلازا)', 'Open Commercial Complex (Plaza)', 16),
          ('unit_type', 'mall', 'مجمع تجاري مغلق (مول)', 'Closed Commercial Complex (Mall)', 17),
          ('unit_type', 'floor', 'دور', 'Floor', 18),
          ('unit_type', 'apartment', 'شقة', 'Apartment', 19),
          ('unit_type', 'villa', 'فيلا', 'Villa', 20),
          ('unit_type', 'building', 'عمارة', 'Building', 21),
          ('unit_type', 'tower', 'برج', 'Tower', 22),
          ('unit_type', 'duplex', 'شقة ثنائية الدور (دوبلكس)', 'Duplex Apartment', 23),
          ('unit_type', 'studio', 'شقة صغيرة (استوديو)', 'Studio Apartment', 24),
          ('unit_type', 'annex', 'شقة ملحق', 'Annex Apartment', 25),
          ('unit_type', 'apartmentWithAnnex', 'شقة وملحق علوي', 'Apartment with Upper Annex', 26),
          ('unit_type', 'floorWithAnnex', 'دور وملحق علوي', 'Floor with Upper Annex', 27),
          ('unit_type', 'rooftopVilla', 'فيلا سطح', 'Rooftop Villa', 28),
          ('unit_type', 'driverRoom', 'غرفة سائق', 'Driver''s Room', 29),
          ('unit_type', 'chalet', 'استراحة', 'Rest House', 30),
          ('unit_type', 'sharedRoom', 'غرفة بمساحة مشتركة', 'Shared Room', 31),
          ('unit_type', 'hotelRoom', 'غرفة فندقية', 'Hotel Room', 32),
          ('unit_type', 'traditionalHouse', 'بيت شعبي', 'Traditional House', 33),
          ('unit_type', 'twoFloorApartment', 'شقة دورين', 'Two-Floor Apartment', 34),
          ('unit_type', 'educational_complex', 'مجمع تعليمي', 'Educational Complex', 35),
          ('unit_type', 'car_wash', 'مغسلة سيارات', 'Car Wash', 36)
        )
        insert into lookups (category, key, label_ar, label_en, sort_order, is_active, company_id)
        select t.category, t.key, t.label_ar, t.label_en, t.sort_order, true, null
        from target t
        where not exists (
          select 1 from lookups l
          where l.category = t.category and l.key = t.key and l.company_id is null
        )
      `);
      await client.query(`
        with target(category, key, label_ar, label_en, sort_order) as (values
          ('property_type', 'land', 'أرض', 'Land', 1),
          ('property_type', 'apartment_building', 'عمارة', 'Building', 2),
          ('property_type', 'tower', 'برج', 'Tower', 3),
          ('property_type', 'villa', 'فيلا', 'Villa', 4),
          ('property_type', 'plaza', 'مجمع تجاري مفتوح (بلازا)', 'Open Commercial Complex (Plaza)', 5),
          ('property_type', 'mall', 'مجمع تجاري مغلق (مول)', 'Closed Commercial Complex (Mall)', 6),
          ('property_type', 'factory', 'مصنع', 'Factory', 7),
          ('property_type', 'chalet', 'استراحة', 'Rest House', 8),
          ('property_type', 'farm', 'مزرعة', 'Farm', 9),
          ('property_usage', 'families', 'سكن عائلات', 'Family Residential', 1),
          ('property_usage', 'individuals', 'سكن أفراد', 'Individual Residential', 2),
          ('property_usage', 'commercial', 'تجاري', 'Commercial', 3),
          ('property_usage', 'mixed', 'سكني - تجاري', 'Residential - Commercial', 4),
          ('property_usage', 'group_housing', 'السكن الجماعي', 'Group Housing', 5),
          ('property_usage', 'residential_investment', 'سكن استثماري', 'Residential Investment', 6),
          ('property_usage', 'industrial', 'صناعي', 'Industrial', 7),
          ('property_usage', 'agricultural', 'زراعي', 'Agricultural', 8),
          ('unit_type', 'kiosk', 'كشك', 'Kiosk', 1),
          ('unit_type', 'shop', 'محل', 'Shop', 2),
          ('unit_type', 'workshop', 'ورشة', 'Workshop', 3),
          ('unit_type', 'land', 'أرض', 'Land', 4),
          ('unit_type', 'leasedLand', 'أرض مسورة', 'Fenced Land', 5),
          ('unit_type', 'station', 'محطة', 'Station', 6),
          ('unit_type', 'office', 'مكتب', 'Office', 7),
          ('unit_type', 'warehouse', 'مستودع', 'Warehouse', 8),
          ('unit_type', 'showroom', 'معرض', 'Showroom', 9),
          ('unit_type', 'atm', 'صراف', 'Exchange Office', 10),
          ('unit_type', 'cinema', 'سينما', 'Cinema', 11),
          ('unit_type', 'powerStation', 'محطة كهرباء', 'Power Station', 12),
          ('unit_type', 'telecomTower', 'برج اتصالات', 'Telecommunications Tower', 13),
          ('unit_type', 'hotel', 'فندق', 'Hotel', 14),
          ('unit_type', 'parkingLot', 'مواقف سيارات', 'Car Parking', 15),
          ('unit_type', 'plaza', 'مجمع تجاري مفتوح (بلازا)', 'Open Commercial Complex (Plaza)', 16),
          ('unit_type', 'mall', 'مجمع تجاري مغلق (مول)', 'Closed Commercial Complex (Mall)', 17),
          ('unit_type', 'floor', 'دور', 'Floor', 18),
          ('unit_type', 'apartment', 'شقة', 'Apartment', 19),
          ('unit_type', 'villa', 'فيلا', 'Villa', 20),
          ('unit_type', 'building', 'عمارة', 'Building', 21),
          ('unit_type', 'tower', 'برج', 'Tower', 22),
          ('unit_type', 'duplex', 'شقة ثنائية الدور (دوبلكس)', 'Duplex Apartment', 23),
          ('unit_type', 'studio', 'شقة صغيرة (استوديو)', 'Studio Apartment', 24),
          ('unit_type', 'annex', 'شقة ملحق', 'Annex Apartment', 25),
          ('unit_type', 'apartmentWithAnnex', 'شقة وملحق علوي', 'Apartment with Upper Annex', 26),
          ('unit_type', 'floorWithAnnex', 'دور وملحق علوي', 'Floor with Upper Annex', 27),
          ('unit_type', 'rooftopVilla', 'فيلا سطح', 'Rooftop Villa', 28),
          ('unit_type', 'driverRoom', 'غرفة سائق', 'Driver''s Room', 29),
          ('unit_type', 'chalet', 'استراحة', 'Rest House', 30),
          ('unit_type', 'sharedRoom', 'غرفة بمساحة مشتركة', 'Shared Room', 31),
          ('unit_type', 'hotelRoom', 'غرفة فندقية', 'Hotel Room', 32),
          ('unit_type', 'traditionalHouse', 'بيت شعبي', 'Traditional House', 33),
          ('unit_type', 'twoFloorApartment', 'شقة دورين', 'Two-Floor Apartment', 34),
          ('unit_type', 'educational_complex', 'مجمع تعليمي', 'Educational Complex', 35),
          ('unit_type', 'car_wash', 'مغسلة سيارات', 'Car Wash', 36)
        )
        update lookups l
           set label_ar = t.label_ar, label_en = t.label_en,
               sort_order = t.sort_order, is_active = true
          from target t
         where l.category = t.category and l.key = t.key and l.company_id is null
           and (l.label_ar is distinct from t.label_ar
             or l.label_en is distinct from t.label_en
             or l.sort_order is distinct from t.sort_order
             or l.is_active is not true)
      `);
      // Owners named on the deed document itself (co-owners), distinct from
      // deeds.owner_id which is the landlord the deed is filed under.
      await client.query(`alter table deeds add column if not exists deed_owners jsonb`);
      // Optional Google Maps link; Ejar imports fill it from the coordinates.
      await client.query(`alter table properties add column if not exists map_url text`);
      // Landlord's representative — mirrors the tenant's rep_name/rep_id_number.
      await client.query(`alter table contracts add column if not exists landlord_rep_name text`);
      await client.query(`alter table contracts add column if not exists landlord_rep_id_number text`);
      // Backfill properties imported before map_url existed — their coordinates
      // are already in the ejar_raw snapshot, which is exactly what that column
      // was for. Idempotent: only fills rows that have none.
      await client.query(`
        update properties
           set map_url = 'https://www.google.com/maps?q=' || (ejar_raw->>'latitude') || ',' || (ejar_raw->>'longitude')
         where map_url is null
           and ejar_raw ? 'latitude' and ejar_raw ? 'longitude'
           and (ejar_raw->>'latitude') ~ '^-?[0-9.]+$'
           and (ejar_raw->>'longitude') ~ '^-?[0-9.]+$'
           and (ejar_raw->>'latitude')::numeric <> 0
      `);
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

    // Phase 1.5c: app_logs — the request/error log that outlives the container.
    //
    // Additive and idempotent like everything else here; there is no migration
    // file for it. Its writer (`common/logging/app-log.service.ts`) is
    // fire-and-forget and mutes itself after repeated failures, so a container
    // that boots before this ALTER succeeds degrades to stdout-only logging
    // rather than 500ing anything.
    //
    // No foreign keys on user_id / owner_user_id on purpose: a log row must be
    // insertable after the user it describes has been deleted.
    try {
      await client.query(`
        create table if not exists app_logs (
          id serial primary key,
          created_at timestamptz not null default now(),
          level text not null,
          event text,
          request_id text,
          method text,
          path text,
          status integer,
          duration_ms integer,
          user_id integer,
          owner_user_id integer,
          ip text,
          user_agent text,
          message text,
          context text,
          error text,
          stack text,
          meta jsonb
        )
      `);
      // `created_at desc` because every read of this table is "the most recent
      // N", and the retention sweep deletes from the old end of the same
      // index. The rest are the four columns the admin view filters on.
      await client.query(`create index if not exists app_logs_created_idx on app_logs (created_at desc)`);
      await client.query(`create index if not exists app_logs_level_idx on app_logs (level)`);
      await client.query(`create index if not exists app_logs_request_idx on app_logs (request_id)`);
      await client.query(`create index if not exists app_logs_user_idx on app_logs (user_id)`);
      await client.query(`create index if not exists app_logs_event_idx on app_logs (event)`);
    } catch (err: any) {
      log.warn(`ensure app_logs failed: ${err?.message || err}`);
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
