/**
 * Finance v2 "additive diff" gate (docs/finance-v2/DESIGN.md §1.4 points 1, 5, 7
 * and §2.4.5). Run in CI:
 *
 *   pnpm exec tsx scripts/finance-v2-additive-diff.ts            # base = origin/master
 *   FV2_DIFF_BASE=<ref> pnpm exec tsx scripts/finance-v2-additive-diff.ts
 *
 * It fails the build when:
 *  1. a PROTECTED legacy file (the finance modules and three common helpers)
 *     has a removed line whose hunk is not in the reviewed allowlist
 *     `scripts/finance-v2-removed-lines.allow`;
 *  2. an added hunk in a protected file lacks the marker `finance-v2:`
 *     (new files are exempt: they cannot change legacy behaviour);
 *  3. a pre-existing Drizzle schema file changed (`db/src/schema/*.ts`);
 *  4. a Finance v2 migration contains ALTER TABLE on a table it did not create;
 *  5. the string `fv2.purge` appears outside the 0066 migration (specs, which
 *     run on throwaway schemas, are exempt), or 0066 turns it on more than
 *     once (only fv2_purge_account may).
 *
 * The web repo reuses the same logic with `--profile web` (protected:
 * src/components/dashboard/**, src/lib/**; checks 3–5 do not apply there).
 *
 * Allowlist format, one entry per line (`#` comments allowed):
 *   <file>\t<hunk hash>\t<one-line reason>
 * The hash is the first 16 hex chars of sha256 over the hunk's removed lines
 * (without the leading '-') joined by '\n'. A failing run prints the exact
 * line to add, so an entry is always a deliberate, reviewed act. The list is
 * printed at the merge gate next to the flag-off exceptions.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MARKER = "finance-v2:";

export const PROFILES = {
  api: {
    protected: [
      "src/modules/billing/", "src/modules/payments/", "src/modules/contracts/", "src/modules/reports/",
      "src/modules/dashboard/", "src/modules/ejar/", "src/modules/import/", "src/modules/admin/",
      "src/modules/payment-confirmations/", "src/modules/tenant-portal/", "src/modules/mobile-landlord/",
      "src/common/payment-status.ts", "src/common/scope.ts", "src/common/permissions.ts",
    ],
    repoChecks: true,
  },
  web: {
    protected: ["src/components/dashboard/", "src/lib/"],
    repoChecks: false,
  },
} as const;

export interface Hunk {
  file: string;
  header: string;
  removed: string[];
  added: string[];
}

export interface FileDiff {
  file: string;
  status: "A" | "M" | "D" | "R";
  hunks: Hunk[];
}

/** Parse `git diff -U0` output. */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.*)$/.exec(line);
      cur = { file: m ? m[1] : line, status: "M", hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) { cur.status = "A"; continue; }
    if (line.startsWith("deleted file mode")) { cur.status = "D"; continue; }
    if (line.startsWith("rename from")) { cur.status = "R"; continue; }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("@@")) {
      hunk = { file: cur.file, header: line, removed: [], added: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("-")) hunk.removed.push(line.slice(1));
    else if (line.startsWith("+")) hunk.added.push(line.slice(1));
  }
  return files;
}

export function hunkHash(h: Pick<Hunk, "removed">): string {
  return createHash("sha256").update(h.removed.join("\n")).digest("hex").slice(0, 16);
}

export function parseAllowlist(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [file, hash, reason] = line.split("\t");
    if (!file || !hash || !reason?.trim()) throw new Error(`allowlist line needs file<TAB>hash<TAB>reason: ${raw}`);
    out.add(`${file}\t${hash}`);
  }
  return out;
}

export function isProtected(file: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));
}

/** Rules 1 and 2 over parsed diffs. Returns the problems found. */
export function checkProtected(files: FileDiff[], prefixes: readonly string[], allow: Set<string>): string[] {
  const problems: string[] = [];
  for (const f of files) {
    if (!isProtected(f.file, prefixes)) continue;
    if (f.status === "D" || f.status === "R") {
      problems.push(`${f.file}: a protected legacy file was ${f.status === "D" ? "deleted" : "renamed"}`);
      continue;
    }
    for (const h of f.hunks) {
      if (h.removed.length) {
        const hash = hunkHash(h);
        if (!allow.has(`${f.file}\t${hash}`)) {
          problems.push(
            `${f.file} ${h.header}: removes ${h.removed.length} legacy line(s). Only added lines are allowed.\n` +
            `    If this is a reviewed exception, add to scripts/finance-v2-removed-lines.allow:\n` +
            `    ${f.file}\t${hash}\t<reason>`,
          );
        }
      }
      if (f.status !== "A" && h.added.length && !h.removed.length && !h.added.some((l) => l.includes(MARKER))) {
        problems.push(`${f.file} ${h.header}: added hunk without the "// ${MARKER}" marker`);
      }
    }
  }
  return problems;
}

/** Rule 4: ALTER TABLE only on tables the same file creates. */
export function checkMigrationAlters(rawSql: string, file: string): string[] {
  const sql = rawSql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const created = new Set([...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi)].map((m) => m[1].toLowerCase()));
  const problems: string[] = [];
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    if (!created.has(m[1].toLowerCase())) problems.push(`${file}: ALTER TABLE ${m[1]} — Finance v2 migrations may not alter an existing table`);
  }
  return problems;
}

/** Rule 5 over the 0066 text: the purge switch is turned on exactly once. */
export function checkPurgeInMigration(sql: string): string[] {
  const ons = sql.match(/set_config\(\s*'fv2\.purge'\s*,\s*'on'/g) ?? [];
  return ons.length === 1 ? [] : [`0066_finance_v2.sql: fv2.purge is turned on ${ons.length} times; only fv2_purge_account may do it`];
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function main(): void {
  const argv = process.argv.slice(2);
  const profileName = (argv[argv.indexOf("--profile") + 1] && argv.includes("--profile") ? argv[argv.indexOf("--profile") + 1] : "api") as keyof typeof PROFILES;
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown profile ${profileName}`);
  const cwd = argv.includes("--repo") ? argv[argv.indexOf("--repo") + 1] : process.cwd();
  const base = process.env.FV2_DIFF_BASE ?? "origin/master";
  const mergeBase = git(["merge-base", base, "HEAD"], cwd).trim();

  const allowFile = join(cwd, "scripts", "finance-v2-removed-lines.allow");
  const allow = existsSync(allowFile) ? parseAllowlist(readFileSync(allowFile, "utf8")) : new Set<string>();

  const problems: string[] = [];
  const diff = parseDiff(git(["diff", "-U0", "--no-color", "--find-renames", mergeBase, "--", ...profile.protected], cwd));
  problems.push(...checkProtected(diff, profile.protected, allow));

  if (profile.repoChecks) {
    // 3. no pre-existing schema file changes
    for (const line of git(["diff", "--name-status", mergeBase, "--", "db/src/schema/"], cwd).split("\n").filter(Boolean)) {
      const [status, file] = line.split("\t");
      if (status !== "A") problems.push(`${file}: pre-existing Drizzle schema file changed (${status}); Finance v2 tables go in db/src/schema/financeV2.ts`);
    }
    // 4. migrations alter nothing that exists
    for (const f of ["db/drizzle/0066_finance_v2.sql", "db/drizzle/0067_finance_v2_tier2.sql", "db/drizzle/0068_finance_v2_hardening.sql", "db/drizzle/0069_finance_v2_tier3.sql",
      "db/drizzle/0071_finance_v2_controls.sql", "db/drizzle/0073_finance_v2_autoinvoice.sql",
      "db/drizzle/0074_finance_v2_assets.sql"]) {
      const p = join(cwd, f);
      if (existsSync(p)) problems.push(...checkMigrationAlters(readFileSync(p, "utf8"), f));
    }
    // 5. fv2.purge confined to the 0066 migration. Specs are exempt: they run on a throwaway schema, and the property
    // test clears one account's ledger to rebuild it by backfill (fv2_purge_account would also drop the chart and meta).
    let hits = "";
    try {
      hits = git(["grep", "-l", "-F", "fv2.purge", "--", "src", "db", ":!db/drizzle/0066_finance_v2.sql", ":!*.spec.ts"], cwd);
    } catch {
      hits = ""; // git grep exits 1 when nothing matches
    }
    for (const f of hits.split("\n").filter(Boolean)) problems.push(`${f}: the string "fv2.purge" may appear only in db/drizzle/0066_finance_v2.sql`);
    const m0066 = join(cwd, "db/drizzle/0066_finance_v2.sql");
    if (existsSync(m0066)) problems.push(...checkPurgeInMigration(readFileSync(m0066, "utf8")));
  }

  const touched = diff.filter((f) => isProtected(f.file, profile.protected)).length;
  if (problems.length) {
    console.error(`finance-v2 additive-diff: ${problems.length} problem(s) against ${base} (${mergeBase.slice(0, 7)}):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`finance-v2 additive-diff: OK (${profileName}; ${touched} protected file(s) touched; ${allow.size} allowlisted hunk(s); base ${mergeBase.slice(0, 7)})`);
}

if (require.main === module) main();
