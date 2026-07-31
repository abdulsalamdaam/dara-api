/**
 * DANGER — wipes the database, then seeds the system roles and ONE super-admin.
 *
 *   1. TRUNCATE every table in the `public` schema (RESTART IDENTITY CASCADE).
 *      The `drizzle.__drizzle_migrations` bookkeeping table lives in the
 *      `drizzle` schema, so migration history is preserved.
 *   2. Re-seed the system role presets (super_admin / admin / user / demo +
 *      employee presets) — identical to what the API does on boot.
 *   3. Create a single super-admin user.
 *
 * Run (from the milkia-api repo root):
 *
 *   tsx --env-file=.env scripts/reset-and-seed-admin.ts --yes \
 *       --email=admin@dara-sa.net --password='YourStrongPass123' --name='مدير النظام'
 *
 * or via the package script:
 *
 *   pnpm db:reset -- --yes --email=admin@dara-sa.net --password='YourStrongPass123'
 *
 * Flags / env:
 *   --yes                 REQUIRED. Without it the script refuses to run.
 *   --email=    | SUPER_ADMIN_EMAIL      (default: admin@dara-sa.net)
 *   --password= | SUPER_ADMIN_PASSWORD   (default: a random strong one, printed)
 *   --name=     | SUPER_ADMIN_NAME       (default: "مدير النظام")
 *
 * Lookups and any other on-boot seed data are re-created the next time the API
 * starts — so restart the API (or your Coolify service) after running this.
 */

import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { db, pool, usersTable, rolesTable } from "../db/src/index";
import { ROLE_PRESETS, ALL_PERMISSIONS, EMPLOYEE_PRESETS } from "../src/common/permissions";

const args = process.argv.slice(2);
const hasFlag = (f: string) => args.includes(f);
const argVal = (name: string, env: string, def: string) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return process.env[env] ?? def;
};

function maskUrl(url: string) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main() {
  if (!hasFlag("--yes")) {
    console.error(
      "\n✋ Refusing to run without --yes.\n" +
        "   This DELETES ALL DATA in: " + maskUrl(process.env.DATABASE_URL || "") + "\n" +
        "   Re-run with --yes once you're sure.\n",
    );
    process.exit(1);
  }

  const email = argVal("email", "SUPER_ADMIN_EMAIL", "admin@dara-sa.net").trim().toLowerCase();
  const name = argVal("name", "SUPER_ADMIN_NAME", "مدير النظام");
  let password = argVal("password", "SUPER_ADMIN_PASSWORD", "");
  let generated = false;
  if (!password) {
    // A printable, no-ambiguous-chars random password when none is supplied.
    password = "Oq" + randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "") + "9!";
    generated = true;
  }

  console.log("\n⚠️  RESET TARGET:", maskUrl(process.env.DATABASE_URL || ""));

  // 1. Truncate every public table (keep migration history in `drizzle` schema).
  console.log("→ Truncating all tables in schema `public` …");
  const { rows: tableRows } = await pool.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' and tablename <> '__drizzle_migrations'`,
  );
  const names = tableRows.map((r) => r.tablename);
  if (names.length) {
    const list = names.map((n) => `public."${n.replace(/"/g, '""')}"`).join(", ");
    await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
  console.log(`   cleared ${names.length} table(s).`);

  // 2. Re-seed system role presets (mirrors src/database/bootstrap.ts).
  console.log("→ Seeding system role presets …");
  const presets: Array<{ key: string; perms: readonly string[]; labelAr: string; labelEn: string }> = [
    { key: "super_admin", perms: ALL_PERMISSIONS, labelAr: "مدير النظام", labelEn: "Super Admin" },
    { key: "admin", perms: ROLE_PRESETS.admin, labelAr: "مشرف", labelEn: "Admin" },
    { key: "user", perms: ROLE_PRESETS.user, labelAr: "مالك / مدير", labelEn: "Owner / Manager" },
    { key: "demo", perms: ROLE_PRESETS.demo, labelAr: "تجريبي", labelEn: "Demo" },
  ];
  for (const [key, def] of Object.entries(EMPLOYEE_PRESETS)) {
    presets.push({ key, perms: def.permissions, labelAr: def.labelAr, labelEn: def.labelEn });
  }
  for (const r of presets) {
    await pool.query(
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
  console.log(`   ${presets.length} role(s) seeded.`);

  // 3. Create the single super-admin user.
  const [superRole] = await db
    .select({ id: rolesTable.id })
    .from(rolesTable)
    .where(and(eq(rolesTable.key, "super_admin"), isNull(rolesTable.companyId)))
    .limit(1);
  if (!superRole) throw new Error("super_admin role missing after seeding — aborting.");

  const passwordHash = await bcrypt.hash(password, 10);
  const [admin] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      name,
      isActive: true,
      accountStatus: "active",
      roleId: superRole.id,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      // Admins aren't gated by subscription — keep them unlocked.
      subscriptionStatus: "active",
    })
    .returning({ id: usersTable.id, email: usersTable.email });

  console.log("\n✅ Done.");
  console.log("   Super-admin created:");
  console.log("     email:    " + admin!.email);
  console.log("     password: " + password + (generated ? "   (randomly generated — save it now)" : ""));
  console.log("     role:     super_admin\n");
  console.log("   Restart the API afterwards so lookups & other on-boot seed data are recreated.\n");
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("\n❌ Reset failed:", err?.message || err);
    try { await pool.end(); } catch {}
    process.exit(1);
  });
