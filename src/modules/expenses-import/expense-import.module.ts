import { Module } from "@nestjs/common";
import { FinanceV2Module } from "../finance-v2/finance-v2.module";
import { ExpenseImportController } from "./expense-import.controller";
import { ExpenseImportService } from "./expense-import.service";

/** GET /expenses/import/template, POST /expenses/import. FinanceV2Module for ExpensesV2Service; the hooks are global. */
@Module({
  imports: [FinanceV2Module],
  controllers: [ExpenseImportController],
  providers: [ExpenseImportService],
})
export class ExpenseImportModule {}
