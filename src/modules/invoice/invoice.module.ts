import { Module } from "@nestjs/common";
import { ZatcaOnboardingController } from "./zatca-onboarding.controller";
import { InvoicesController } from "./invoices.controller";
import { ShellService } from "./services/shell.service";
import { CsrService } from "./services/csr.service";
import { QrService } from "./services/qr.service";
import { ZatcaApiService } from "./services/zatca-api.service";
import { InvoiceBuilderService } from "./services/invoice-builder.service";
import { InvoiceSignerService } from "./services/invoice-signer.service";
import { InvoiceService } from "./services/invoice.service";
import { PdfA3Service } from "./services/pdfa3.service";
import { ZatcaOnboardingService } from "./services/zatca-onboarding.service";
import { PdfService } from "./services/pdf.service";

/**
 * Invoice + ZATCA e-invoicing module.
 *
 * Endpoints (mounted under /api):
 *   ── Onboarding ────────────────────────────────────────
 *   GET  /zatca/credentials                       seller profile + CSID state
 *   POST /zatca/profile                           upsert seller profile
 *   POST /zatca/onboarding/:env/compliance        CSR + compliance CSID
 *   POST /zatca/onboarding/production             promote → production CSID
 *   POST /zatca/switch                            1-click env switch
 *   POST /zatca/reset-chain                       reset PIH chain (dev only)
 *
 *   ── Invoices ──────────────────────────────────────────
 *   GET    /invoices                              list (paginated)
 *   POST   /invoices                              build → sign → submit
 *   GET    /invoices/:id                          full row + lines
 *   GET    /invoices/:id/xml                      signed UBL
 *   GET    /invoices/:id/html?lang=ar|en          print template
 *   GET    /invoices/:id/pdf?lang=ar|en           rendered PDF (Chrome)
 *   POST   /invoices/:id/resubmit                 retry submission
 *   DELETE /invoices/:id                          soft-delete
 *
 * All endpoints require auth (JwtAuthGuard) + the relevant invoices/zatca
 * permission keys. Multi-seller scoping is automatic via `scopeId(user)`.
 */
@Module({
  controllers: [ZatcaOnboardingController, InvoicesController],
  providers: [PdfA3Service, 
    ShellService,
    CsrService,
    QrService,
    ZatcaApiService,
    InvoiceBuilderService,
    InvoiceSignerService,
    InvoiceService,
    ZatcaOnboardingService,
    PdfService,
  ],
  exports: [InvoiceService, ZatcaOnboardingService, PdfA3Service],
})
export class InvoiceModule {}
