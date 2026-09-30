import { Module } from "@nestjs/common";
import { FinanceV2CoreModule } from "./finance-v2-core.module";
import { ChartService } from "./chart.service";
import { FinanceSetupService } from "./setup.service";
import { FinanceV2AdminService } from "./admin.service";
import { FinanceV2Guard } from "./finance-v2.guard";
import { FinanceV2StatusController } from "./controllers/status.controller";
import { FinanceV2SettingsController } from "./controllers/settings.controller";
import { FinanceSettingsService } from "./settings.service";
import { FinanceV2AccountsController } from "./controllers/accounts.controller";
import { FinanceV2AdminController } from "./controllers/admin.controller";
import { FinanceV2PostingErrorsController } from "./controllers/posting-errors.controller";
import { PostingEngine } from "./posting.engine";
import { PostingWorker } from "./posting-worker.service";
import { PostingErrorsService } from "./posting-errors.service";
import { LedgerStartService } from "./ledger-start.service";
import { RecognizerService } from "./recognizer.service";
import { FinanceV2HooksModule } from "./hooks/hooks.module";
import { BackfillService } from "./backfill/backfill.service";
import { ManualJournalsService } from "./manual-journals.service";
import { JournalQueryService } from "./journal-query.service";
import { PeriodCloseService } from "./period-close.service";
import { VatReturnsService } from "./vat-returns.service";
import { FinanceV2JournalController } from "./controllers/journal.controller";
import { FinanceV2ManualJournalsController, FinanceV2OpeningBalancesController } from "./controllers/manual-journals.controller";
import { FinanceV2PeriodsController } from "./controllers/periods.controller";
import { FinanceV2VatReturnsController } from "./controllers/vat-returns.controller";
import { FinanceV2CoreReportsController } from "./controllers/reports-core.controller";
import { CoreReportsService } from "./reports/core-reports.service";
import { FinanceV2SubReportsController } from "./controllers/reports-sub.controller";
import { VatReportService } from "./reports/vat-report.service";
import { ArAgingService } from "./reports/aging.service";
import { StatementsService } from "./reports/statements.service";
import { ReconciliationService } from "./reports/reconciliation.service";
import { FinanceV2AcctReportsController } from "./controllers/reports-acct.controller";
import { AcctReportsService } from "./reports/acct-reports.service";
import { legacyAccountingProvider } from "./reports/legacy-accounting";
import { FinanceV2BugsController } from "./controllers/bugs.controller";
import { FinanceV2Tier1Controller } from "./controllers/tier1.controller";
import { FinanceV2Tier2Controller } from "./controllers/tier2.controller";
import { BankAccountsService } from "./tier1/bank-accounts.service";
import { ExpensesV2Service } from "./tier1/expenses-v2.service";
import { TenantCreditsService } from "./tier1/tenant-credits.service";
import { BankRecService } from "./tier2/bank-rec.service";
import { RemindersService } from "./tier2/reminders.service";
import { DryRunReminderSender, REMINDER_SENDER } from "./tier2/reminder-sender";
import { FinanceV2Tier3Controller } from "./controllers/tier3.controller";
import { ApService } from "./tier3/ap.service";
import { JournalExportService } from "./tier3/journal-export.service";
import { ControlChecksService } from "./controls.service";
import { FinanceV2ControlsController } from "./controllers/controls.controller";
import { AutoInvoiceService } from "./auto-invoice/auto-invoice.service";
import { FinanceV2AutoInvoiceController } from "./controllers/auto-invoice.controller";

/**
 * Finance v2 (beta): controllers and services behind the per-account
 * `finance_v2` flag. DESIGN docs/finance-v2/DESIGN.md. Everything under
 * /api/finance/v2 except /status answers 404 while the flag is off.
 */
@Module({
  imports: [FinanceV2CoreModule, FinanceV2HooksModule],
  controllers: [
    FinanceV2StatusController, FinanceV2SettingsController, FinanceV2AccountsController, FinanceV2AdminController, FinanceV2PostingErrorsController,
    FinanceV2JournalController, FinanceV2ManualJournalsController, FinanceV2OpeningBalancesController, FinanceV2PeriodsController,
    FinanceV2VatReturnsController, FinanceV2CoreReportsController, FinanceV2SubReportsController,
    FinanceV2BugsController, FinanceV2Tier1Controller, FinanceV2Tier2Controller, FinanceV2Tier3Controller,
    FinanceV2ControlsController,
    FinanceV2AcctReportsController,
    FinanceV2AutoInvoiceController,
  ],
  providers: [
    ChartService, FinanceSetupService, FinanceV2AdminService, FinanceV2Guard,
    PostingEngine, PostingWorker, PostingErrorsService, LedgerStartService, RecognizerService,
    BackfillService, ManualJournalsService, JournalQueryService, PeriodCloseService, VatReturnsService,
    CoreReportsService, VatReportService, ArAgingService, StatementsService, ReconciliationService, legacyAccountingProvider,
    BankAccountsService, ExpensesV2Service, TenantCreditsService, BankRecService, RemindersService,
    ApService, JournalExportService, FinanceSettingsService,
    ControlChecksService,
    AcctReportsService,
    AutoInvoiceService,
    // Tier 2 reminders: the ONLY sender binding is the dry run (DESIGN §8.3 b); nothing is ever sent.
    { provide: REMINDER_SENDER, useClass: DryRunReminderSender },
  ],
  exports: [PostingEngine, PostingWorker, LedgerStartService, RecognizerService, BackfillService],
})
export class FinanceV2Module {}
