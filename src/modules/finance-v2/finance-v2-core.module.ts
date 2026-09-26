import { Module } from "@nestjs/common";
import { getPool } from "@dara/database";
import { FV2_POOL } from "./db";
import { FinanceFlagService } from "./flag.service";
import { PeriodsService } from "./periods.service";
import { JournalRepository } from "./journal.repository";
import { LedgerEmitter } from "./ledger-emitter.service";

/**
 * The part of Finance v2 the LEGACY modules may import (DESIGN §5): the flag,
 * and (later) the emitter and journal repository. It imports nothing from the
 * legacy modules, so there is no cycle and no forwardRef.
 */
@Module({
  providers: [
    { provide: FV2_POOL, useFactory: () => getPool() },
    FinanceFlagService,
    PeriodsService,
    JournalRepository,
    LedgerEmitter,
  ],
  exports: [FV2_POOL, FinanceFlagService, PeriodsService, JournalRepository, LedgerEmitter],
})
export class FinanceV2CoreModule {}
