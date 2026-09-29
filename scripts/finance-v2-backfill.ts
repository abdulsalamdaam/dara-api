/**
 * Finance v2 backfill CLI (DESIGN §6).
 *
 *   DATABASE_URL=postgres://… API_PORT=4100 pnpm exec tsx scripts/finance-v2-backfill.ts \
 *     --account <scopeUserId> [--mode full|cutover|catchup] [--cutover YYYY-MM-DD] [--dry-run] [--allow-late] [--yes] [--json]
 *
 * Safety (DARA-NOTES §1: `.env` points at production):
 *  - never loads `.env`; DATABASE_URL must be set explicitly in the environment;
 *  - refuses API_PORT=4000 (the real API's port);
 *  - prints the host it will use; a real (non-dry) run needs --yes.
 * The run itself is BackfillService.run(), the same as the admin route. The
 * nightly repair sweep and live posting are not started by this script.
 */
import pg from "pg";
import { BackfillService, type BackfillMode } from "../src/modules/finance-v2/backfill/backfill.service";
import { PeriodsService } from "../src/modules/finance-v2/periods.service";
import { JournalRepository } from "../src/modules/finance-v2/journal.repository";
import { PostingEngine } from "../src/modules/finance-v2/posting.engine";
import { PostingWorker } from "../src/modules/finance-v2/posting-worker.service";
import { LedgerEmitter } from "../src/modules/finance-v2/ledger-emitter.service";
import { LedgerStartService } from "../src/modules/finance-v2/ledger-start.service";
import { RecognizerService } from "../src/modules/finance-v2/recognizer.service";
import { FinanceSetupService } from "../src/modules/finance-v2/setup.service";
import { ChartService } from "../src/modules/finance-v2/chart.service";
import { FinanceFlagService } from "../src/modules/finance-v2/flag.service";

export function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (["dry-run", "allow-late", "yes", "json"].includes(k)) out[k] = true;
    else {
      const v = argv[++i];
      if (v == null || v.startsWith("--")) throw new Error(`--${k} needs a value`);
      out[k] = v;
    }
  }
  return out;
}

export function guardEnv(env: NodeJS.ProcessEnv): { url: string; host: string } {
  const url = env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL must be set explicitly (this script never reads .env)");
  if (env.API_PORT === "4000") throw new Error("API_PORT is 4000 (the real API); refusing");
  let host = "?";
  try {
    const u = new URL(url);
    host = `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    throw new Error("DATABASE_URL is not a URL");
  }
  return { url, host };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const account = Number(args.account);
  if (!Number.isInteger(account) || account <= 0) throw new Error("--account <scopeUserId> is required");
  const mode = String(args.mode ?? "full") as BackfillMode;
  const dryRun = args["dry-run"] === true;
  const { url, host } = guardEnv(process.env);
  process.stderr.write(`finance-v2 backfill: ${dryRun ? "DRY RUN" : "REAL RUN"} mode=${mode} account=${account} database=${host}\n`);
  if (!dryRun && args.yes !== true) throw new Error("a real run needs --yes");

  process.env.FINANCE_V2_WORKER_DISABLED = "1";
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  try {
    const periods = new PeriodsService(pool);
    const engine = new PostingEngine(pool, new JournalRepository(periods), periods);
    const emitter = new LedgerEmitter(pool);
    const worker = new PostingWorker(pool, engine, emitter);
    worker.lockPool = new pg.Pool({ connectionString: url, max: 1 });
    const flag = new FinanceFlagService(pool);
    const recognizer = new RecognizerService(pool, emitter);
    const backfill = new BackfillService(pool, engine, worker, new LedgerStartService(flag, worker), recognizer,
      new FinanceSetupService(new ChartService(pool), periods));
    const req = BackfillService.parseRequest(account, 0, {
      mode, cutover: args.cutover ?? null, dryRun, allowLate: args["allow-late"] === true,
    });
    const s = await backfill.run(req);
    if (args.json === true) {
      process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    } else {
      process.stdout.write(
        `run ${s.runId}: events ${s.events.total} (new ${s.events.new}, already posted ${s.events.alreadyPosted}, queued ${s.events.alreadyQueued})\n` +
        `entries ${s.entries.count}, skipped ${JSON.stringify(s.entries.skipped)}, failed ${s.failed.length}, pending ${s.pending}\n` +
        `trial balance: debit ${s.totals.debit} credit ${s.totals.credit}\n` +
        `warnings: ${s.warnings.map((w) => `${w.code}=${w.count}`).join(", ") || "none"}\n`,
      );
    }
    await (worker.lockPool as pg.Pool).end();
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`finance-v2 backfill failed: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
