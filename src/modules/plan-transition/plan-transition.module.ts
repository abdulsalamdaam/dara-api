import { Module } from "@nestjs/common";
import { FinanceV2CoreModule } from "../finance-v2/finance-v2-core.module";
import { FinanceV2Module } from "../finance-v2/finance-v2.module";
import { PlanTransitionService } from "./plan-transition.service";
import { AdminPlanChangesController, PlanChangeController } from "./plan-transition.controller";

/**
 * Plan transitions (عقاري ⇄ المكاتب ⇄ الشركات): the orchestrator behind `signalPlanChanged`, the downgrade
 * preview/guard, the Owner-mode third-party queue item, and their customer + admin endpoints.
 */
@Module({
  imports: [FinanceV2CoreModule, FinanceV2Module],
  controllers: [PlanChangeController, AdminPlanChangesController],
  providers: [PlanTransitionService],
  exports: [PlanTransitionService],
})
export class PlanTransitionModule {}
