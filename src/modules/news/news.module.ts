import { Module } from "@nestjs/common";
import { NewsController } from "./news.controller";
import { NewsAdminController } from "./news-admin.controller";
import { NewsRunnerService } from "./news.runner.service";
import { NewsSchedulerService } from "./news.scheduler.service";
import { NewsCleanerService } from "./news.cleaner.service";

/**
 * Real-estate news: X accounts → Claude filter → a landlord feed.
 * See CONTRACT/BUSINESS specs; env vars are listed in `news.config.ts`.
 */
@Module({
  controllers: [NewsController, NewsAdminController],
  providers: [NewsRunnerService, NewsSchedulerService, NewsCleanerService],
})
export class NewsModule {}
