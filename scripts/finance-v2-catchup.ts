/**
 * Finance v2 catch-up CLI: posts what an ALREADY-STARTED ledger is missing —
 * documents, collections and installment events issued before the account's
 * accounting was switched on (or while its plan kept accounting off).
 * Same code as `POST /api/admin/finance-v2/:id/catch-up` and the automatic
 * catch-up on an upgrade (FinanceV2AutoProvisionService.catchUp).
 *
 *   DATABASE_URL=postgres://… API_PORT=4100 pnpm exec tsx scripts/finance-v2-catchup.ts \
 *     --account <scopeUserId> [--yes] [--json]
 *
 * Without --yes it is a DRY RUN: it lists what would be posted inside a
 * rolled-back transaction and writes nothing (not even a backfill-runs row).
 * With --yes it runs a real `catchup` backfill (late entries for closed
 * periods). Idempotent: a second run finds nothing.
 *
 * Safety: the guards of finance-v2-backfill.ts (never loads `.env`;
 * DATABASE_URL must be set explicitly; refuses API_PORT=4000; prints the host).
 */
import pg from "pg";
import { BackfillService } from "../src/modules/finance-v2/backfill/backfill.service";
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
import { FinanceV2AutoProvisionService } from "../src/modules/finance-v2/auto-provision.service";
import { guardEnv, parseArgs } from "./finance-v2-backfill";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const account = Number(args.account);
  if (!Number.isInteger(account) || account <= 0) throw new Error("--account <scopeUserId> is required");
  const dryRun = args.yes !== true;
  const { url, host } = guardEnv(process.env);
  process.stderr.write(`finance-v2 catch-up: ${dryRun ? "DRY RUN (pass --yes to post)" : "REAL RUN"} account=${account} database=${host}\n`);

  process.env.FINANCE_V2_WORKER_DISABLED = "1";
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const lockPool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const periods = new PeriodsService(pool);
    const engine = new PostingEngine(pool, new JournalRepository(periods), periods);
    const emitter = new LedgerEmitter(pool);
    const worker = new PostingWorker(pool, engine, emitter);
    worker.lockPool = lockPool;
    const flag = new FinanceFlagService(pool);
    const setup = new FinanceSetupService(new ChartService(pool), periods);
    const backfill = new BackfillService(pool, engine, worker, new LedgerStartService(flag, worker), new RecognizerService(pool, emitter), setup);
    const auto = new FinanceV2AutoProvisionService(pool, flag, setup, backfill);
    const r = await auto.catchUp(account, "cli", { dryRun });
    if (args.json === true) {
      process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    } else {
      process.stdout.write(`${r.outcome}: ${r.missing} missing event(s)${r.runId ? `, run ${r.runId}, ${r.entries} entries` : ""}${r.detail ? ` (${r.detail})` : ""}\n`);
      for (const p of r.planned) process.stdout.write(`  ${p.date}  ${p.rule.padEnd(8)} ${p.sourceType}#${p.sourceId} ${p.event}\n`);
      if (r.missing > r.planned.length) process.stdout.write(`  … and ${r.missing - r.planned.length} more\n`);
    }
  } finally {
    await lockPool.end();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`finance-v2 catch-up failed: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
