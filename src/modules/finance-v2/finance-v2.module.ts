import { Module } from "@nestjs/common";
import { FinanceV2CoreModule } from "./finance-v2-core.module";
import { ChartService } from "./chart.service";
import { FinanceSetupService } from "./setup.service";
import { FinanceV2AdminService } from "./admin.service";
import { FinanceV2Guard } from "./finance-v2.guard";
import { FinanceV2StatusController } from "./controllers/status.controller";
import { FinanceV2AccountsController } from "./controllers/accounts.controller";
import { FinanceV2AdminController } from "./controllers/admin.controller";

/**
 * Finance v2 (beta): controllers and services behind the per-account
 * `finance_v2` flag. DESIGN docs/finance-v2/DESIGN.md. Everything under
 * /api/finance/v2 except /status answers 404 while the flag is off.
 */
@Module({
  imports: [FinanceV2CoreModule],
  controllers: [FinanceV2StatusController, FinanceV2AccountsController, FinanceV2AdminController],
  providers: [ChartService, FinanceSetupService, FinanceV2AdminService, FinanceV2Guard],
})
export class FinanceV2Module {}
