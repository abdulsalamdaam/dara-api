import { Global, Module } from "@nestjs/common";
import { FinanceV2CoreModule } from "../finance-v2-core.module";
import { FinanceV2Hooks } from "./hooks.service";

/**
 * Makes `FinanceV2Hooks` injectable into the legacy controllers WITHOUT
 * editing their `@Module({ imports })` lines (DESIGN §1.4 point 3: legacy
 * files gain added lines only). It is global, and imports only the core
 * module, which imports nothing legacy, so there is no cycle and no forwardRef.
 * Legacy controllers take it by property injection:
 *
 *   @Inject(FinanceV2Hooks) private readonly fv2h!: FinanceV2Hooks; // finance-v2:
 */
@Global()
@Module({
  imports: [FinanceV2CoreModule],
  providers: [FinanceV2Hooks],
  exports: [FinanceV2Hooks],
})
export class FinanceV2HooksModule {}
