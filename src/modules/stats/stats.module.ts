import { Controller, Get, Inject, Module } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { count } from "drizzle-orm";
import { usersTable, propertiesTable, unitsTable, contractsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";

@ApiTags("stats")
@Controller("stats")
class StatsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  @Get("public")
  async publicStats() {
    const [propCount] = await this.db.select({ count: count() }).from(propertiesTable);
    const [unitCount] = await this.db.select({ count: count() }).from(unitsTable);
    const [contractCount] = await this.db.select({ count: count() }).from(contractsTable);
    const [userCount] = await this.db.select({ count: count() }).from(usersTable);
    return {
      propertiesCount: propCount?.count ?? 0,
      unitsCount: unitCount?.count ?? 0,
      contractsCount: contractCount?.count ?? 0,
      usersCount: userCount?.count ?? 0,
    };
  }
}

@Module({ controllers: [StatsController] })
export class StatsModule {}
