import { Global, Module } from "@nestjs/common";
import { UploadsService } from "./uploads.service";
import { UploadsController } from "./uploads.controller";
import { UploadKeyAccessService } from "./key-access.service";

/**
 * `UploadKeyAccessService` is provided but NOT exported: the ownership check
 * belongs to the two routes that take a key from a client. Every other module
 * reaches a key through a row it has already scoped, and re-checking there
 * would only re-derive a fact the surrounding query proved.
 */
@Global()
@Module({
  controllers: [UploadsController],
  providers: [UploadsService, UploadKeyAccessService],
  exports: [UploadsService],
})
export class UploadsModule {}
