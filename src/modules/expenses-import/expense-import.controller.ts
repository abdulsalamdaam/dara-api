import {
  BadRequestException, Controller, Get, HttpCode, Post, Query, StreamableFile, UploadedFile, UseGuards, UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { ExpenseImportService } from "./expense-import.service";
import { MAX_BYTES } from "./expense-sheet";

/**
 * Expenses from Excel (customer request, Nov 2026). Both endpoints serve
 * Accounting-on and -off accounts alike: the template's columns and the
 * row rules follow the account's mode. expenses.write, as the single create.
 */
@ApiTags("expenses")
@ApiBearerAuth("user-jwt")
@Controller("expenses/import")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ExpenseImportController {
  constructor(private readonly svc: ExpenseImportService) {}

  /** The .xlsx to fill: this account's landlords, properties and items as dropdowns. */
  @Get("template")
  @RequirePermissions(PERMISSIONS.EXPENSES_WRITE)
  async template(@CurrentUser() user: AuthUser) {
    return new StreamableFile(await this.svc.template(user), {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      disposition: `attachment; filename="dara-expenses-template.xlsx"`,
    });
  }

  /**
   * multipart `file`. `?dryRun=1` (the default): every row checked, nothing
   * written. `?dryRun=0`: all rows created in one go, or none — 400
   * IMPORT_INVALID with the dry run's shape when any row fails.
   */
  @Post()
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.EXPENSES_WRITE)
  @ApiConsumes("multipart/form-data")
  @ApiBody({ schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] } })
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BYTES, files: 1 } }))
  async import(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File | undefined, @Query("dryRun") dryRun?: string) {
    if (!file?.buffer?.length) throw new BadRequestException({ error: "FILE_REQUIRED", message: "الملف مطلوب" });
    return this.svc.run(user, file.buffer, !(dryRun === "0" || dryRun === "false"));
  }
}
