/// <reference types="multer" />
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Post, Query, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiBody } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { scopeId } from "../../common/scope";
import { UploadsService } from "./uploads.service";
import { UploadKeyAccessService } from "./key-access.service";

class PresignPutDto {
  @IsString()
  @MaxLength(120)
  filename!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  contentType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  folder?: string;
}

/**
 * Generic upload endpoints. Authenticated routes; the service is also
 * injected into other modules that need to persist files (e.g. maintenance
 * attachments). New file-handling code should NOT touch the S3 SDK directly
 * — go through UploadsService instead.
 *
 * Both key-taking routes here — `sign` and the DELETE — accept an object key
 * straight from the client, so both must ASK whether the key is the caller's.
 * Until this check existed, `JwtAuthGuard` was the only gate: any logged-in
 * account could read, or destroy, any object in the bucket whose key it had
 * ever seen. See `key-scope.ts` for the scoping scheme and
 * `key-access.service.ts` for how pre-existing keys are attributed.
 */
@ApiTags("uploads")
@ApiBearerAuth("user-jwt")
@Controller("uploads")
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly keys: UploadKeyAccessService,
  ) {}

  @Post()
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: { type: "string", format: "binary" },
        folder: { type: "string", description: "Optional folder prefix inside the bucket" },
      },
      required: ["file"],
    },
  })
  @UseInterceptors(FileInterceptor("file"))
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
    @Body("folder") folder?: string,
  ) {
    if (!file) throw new BadRequestException("الملف مطلوب");
    // The scope is taken from the token, never from the body — a client that
    // could choose its own prefix could file its uploads in another account.
    const result = await this.uploads.upload(file, { folder, scopeId: scopeId(user) });
    // No access check: we just minted this key under the caller's own prefix.
    const url = await this.uploads.presignGet(result.key);
    return { ...result, url };
  }

  /** Issue a fresh signed GET URL for an existing key. */
  @Get("sign")
  async sign(@CurrentUser() user: AuthUser, @Query("key") key: string, @Query("ttl") ttl?: string) {
    if (!key) throw new BadRequestException("key is required");
    await this.keys.assertAccess(user, key, "sign");
    const ttlSeconds = ttl ? Math.max(30, Math.min(3600, Number(ttl))) : undefined;
    const url = await this.uploads.presignGet(key, ttlSeconds);
    return { key, url, expiresIn: ttlSeconds ?? 900 };
  }

  /** Issue a signed PUT URL so the browser can upload directly to MinIO. */
  @Post("presign")
  @HttpCode(200)
  async presign(@CurrentUser() user: AuthUser, @Body() body: PresignPutDto) {
    const key = this.uploads.buildKey(body.filename, { folder: body.folder, scopeId: scopeId(user) });
    return this.uploads.presignPut({ key, contentType: body.contentType });
  }

  @Delete()
  async remove(@CurrentUser() user: AuthUser, @Query("key") key: string) {
    if (!key) throw new BadRequestException("key is required");
    // Same check as `sign`, and it matters more here: this one is not
    // reversible. An unattributable legacy key is refused rather than deleted.
    await this.keys.assertAccess(user, key, "delete");
    await this.uploads.delete(key);
    return { ok: true };
  }
}
