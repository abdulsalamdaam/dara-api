import {
  BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { ZatcaOnboardingService, type SellerProfileInput } from "./services/zatca-onboarding.service";
import { InvoiceService } from "./services/invoice.service";
import type { ZatcaEnv } from "./services/zatca-api.service";

@ApiTags("zatca")
@ApiBearerAuth("user-jwt")
@Controller("zatca")
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ZatcaOnboardingController {
  constructor(
    private readonly onboarding: ZatcaOnboardingService,
    private readonly invoices: InvoiceService,
  ) {}

  /**
   * POST /zatca/compliance-check  { ownerId }
   * Verify a landlord's integration: build + sign a sample invoice and submit
   * it to ZATCA's compliance endpoint. Returns ZATCA's verdict (pass / errors).
   * Nothing is persisted.
   */
  @Post("compliance-check")
  @RequirePermissions(PERMISSIONS.ZATCA_ONBOARD)
  async complianceCheck(@CurrentUser() user: AuthUser, @Body() body: { ownerId?: number }) {
    return this.invoices.complianceCheck(scopeId(user), this.oid(body?.ownerId));
  }

  /**
   * POST /zatca/compliance-suite  { ownerId }
   * Run the FULL compliance test suite (every document type the CSR declared).
   * Passing all of them is ZATCA's prerequisite for issuing a production CSID.
   */
  @Post("debug-sign")
  @RequirePermissions(PERMISSIONS.ZATCA_ONBOARD)
  async debugSign(@CurrentUser() user: AuthUser, @Body() body: { ownerId?: number }) {
    // TEMP diagnostic: run just the simplified invoice compliance doc and return
    // the signed XML so the SignedProperties can be inspected. Remove after use.
    const r: any = await (this.invoices as any).runOneComplianceDocForDebug(scopeId(user), this.oid(body?.ownerId));
    return r;
  }

  @Post("compliance-suite")
  @RequirePermissions(PERMISSIONS.ZATCA_ONBOARD)
  async complianceSuite(@CurrentUser() user: AuthUser, @Body() body: { ownerId?: number }) {
    return this.invoices.complianceSuite(scopeId(user), this.oid(body?.ownerId));
  }

  /** Parse an optional landlord id (the per-landlord seller). */
  private oid(v: unknown): number | null {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * GET /zatca/landlords
   * Every landlord with their ZATCA integration status — drives the settings
   * tab listing all landlords and whether each is integrated.
   */
  @Get("landlords")
  @RequirePermissions(PERMISSIONS.INVOICES_VIEW)
  async listLandlords(@CurrentUser() user: AuthUser) {
    return this.onboarding.listLandlordStatus(scopeId(user));
  }

  /**
   * GET /zatca/credentials?ownerId=
   * Read seller profile + onboarding state for a landlord (or the account-level
   * seller when ownerId is omitted). Secrets are NOT returned — only presence
   * flags so the dashboard can show a checklist.
   */
  @Get("credentials")
  @RequirePermissions(PERMISSIONS.INVOICES_VIEW)
  async getCreds(@CurrentUser() user: AuthUser, @Query("ownerId") ownerId?: string) {
    const c = await this.onboarding.getCredentials(scopeId(user), this.oid(ownerId));
    if (!c) return { configured: false };
    return {
      configured: true,
      activeEnvironment: c.activeEnvironment,
      seller: {
        name: c.sellerName,
        nameAr: c.sellerNameAr,
        vatNumber: c.sellerVatNumber,
        crn: c.sellerCrn,
        idScheme: c.sellerIdScheme,
        street: c.sellerStreet,
        buildingNo: c.sellerBuildingNo,
        district: c.sellerDistrict,
        city: c.sellerCity,
        postalZone: c.sellerPostalZone,
        additionalNo: c.sellerAdditionalNo,
      },
      csrFields: {
        serialNumber: c.serialNumber,
        organizationIdentifier: c.organizationIdentifier,
        organizationUnitName: c.organizationUnitName,
        invoiceType: c.invoiceType,
        locationAddress: c.locationAddress,
        industryCategory: c.industryCategory,
        countryName: c.countryName,
        commonName: c.commonName,
      },
      sandbox: {
        onboarded: !!c.sandboxCertPem,
        onboardedAt: c.sandboxOnboardedAt,
        icv: c.sandboxIcv,
        complianceRequestId: c.sandboxComplianceRequestId,
      },
      production: {
        onboarded: !!c.prodCertPem,
        onboardedAt: c.prodOnboardedAt,
        icv: c.prodIcv,
        complianceRequestId: c.prodComplianceRequestId,
      },
    };
  }

  /**
   * POST /zatca/profile
   * Create or update the seller profile. Required before onboarding.
   */
  @Post("profile")
  @RequirePermissions(PERMISSIONS.ZATCA_ONBOARD)
  async upsertProfile(@CurrentUser() user: AuthUser, @Body() body: SellerProfileInput & { ownerId?: number }) {
    // ZATCA requires a COMPLETE seller national address — not just the street.
    // Reject a partial address up front (additional number stays optional).
    const required: Array<[keyof SellerProfileInput, string]> = [
      ["sellerName", "name"], ["sellerVatNumber", "VAT number"], ["sellerStreet", "street"],
      ["sellerBuildingNo", "building number"], ["sellerDistrict", "district"],
      ["sellerCity", "city"], ["sellerPostalZone", "postal code"],
    ];
    const missing = required.filter(([k]) => !body?.[k] || !String(body[k]).trim()).map(([, label]) => label);
    if (missing.length) {
      throw new BadRequestException(`Required ZATCA seller fields missing: ${missing.join(", ")}.`);
    }
    return this.onboarding.upsertProfile(scopeId(user), body, this.oid(body.ownerId));
  }

  /**
   * POST /zatca/onboarding/:env/compliance  { otp }
   * Generate CSR + exchange for compliance CSID. `env` ∈ sandbox/simulation/production.
   * Sandbox OTP is the fixed string "123456".
   */
  @Post("onboarding/:env/compliance")
  @RequirePermissions(PERMISSIONS.ZATCA_ONBOARD)
  async issueComplianceCsid(
    @CurrentUser() user: AuthUser,
    @Param("env") envParam: string,
    @Body() body: { otp?: string; env?: ZatcaEnv; ownerId?: number },
  ) {
    // The environment is in the PATH — this used to read `body.env` and
    // default to "sandbox", ignoring the path entirely. The portal only ever
    // put it in the URL, so picking Simulation (or Production) still onboarded
    // sandbox, and the screen kept reporting "sandbox" with no clue why.
    // Body still wins if a caller sends it, for backwards compatibility.
    const raw = body.env ?? envParam;
    if (raw !== "sandbox" && raw !== "simulation" && raw !== "production") {
      throw new BadRequestException(`Unknown ZATCA environment "${raw}" — expected sandbox | simulation | production`);
    }
    const env: ZatcaEnv = raw;
    return this.onboarding.issueComplianceCsid(scopeId(user), env, body.otp, this.oid(body.ownerId));
  }

  /**
   * POST /zatca/onboarding/production
   * Promote the existing compliance CSID to production CSID. Only after the
   * test cycle has been completed for the same compliance CSID (≥1 of each
   * doc type signed and accepted).
   */
  @Post("onboarding/production")
  @RequirePermissions(PERMISSIONS.ZATCA_ONBOARD)
  async issueProductionCsid(@CurrentUser() user: AuthUser, @Body() body: { source?: "sandbox" | "production"; ownerId?: number }) {
    const uid = scopeId(user);
    const ownerId = this.oid(body.ownerId);
    const source = body.source ?? "production";
    // ZATCA issues a production CSID ONLY after the compliance CSID has passed
    // the full test cycle — 6 documents (standard/simplified × invoice/credit/
    // debit). Skipping it is why /production/csids was returning
    // "Missing-ComplianceSteps": onboarding jumped straight from the compliance
    // CSID to the production CSID. Run the suite here, in order, and refuse to
    // promote unless every document passes.
    const suite = await this.invoices.complianceSuite(uid, ownerId, { skipLiveGuard: true });
    if (!suite.ok) {
      const failed = suite.results.filter((r) => !r.ok).map((r) => r.doc).join("، ");
      throw new BadRequestException({
        error: "compliance_incomplete",
        message: `لم يكتمل فحص التوافق (${suite.passed}/${suite.total}) — يجب اجتياز جميع المستندات قبل إصدار شهادة الإنتاج. المتعثّرة: ${failed}`,
        suite,
      });
    }
    return this.onboarding.issueProductionCsid(uid, source, ownerId);
  }

  /**
   * POST /zatca/switch  { env }
   * 1-click switch active environment. Refuses to flip to production unless
   * production credentials exist AND the test cycle has been completed.
   */
  @Post("switch")
  @RequirePermissions(PERMISSIONS.ZATCA_PROMOTE_PRODUCTION)
  async switchEnv(@CurrentUser() user: AuthUser, @Body() body: { env: ZatcaEnv; ownerId?: number }) {
    if (!body?.env) throw new BadRequestException("env is required");
    return this.onboarding.switchEnvironment(scopeId(user), body.env, this.oid(body.ownerId));
  }

  /**
   * POST /zatca/reset-chain  { env }
   * Reset the PIH chain (and soft-delete all invoices in the env) so a new
   * onboarding cycle can be started cleanly. Use sparingly — destroys ICV
   * continuity for the env.
   */
  @Post("reset-chain")
  @RequirePermissions(PERMISSIONS.ZATCA_PROMOTE_PRODUCTION)
  async resetChain(@CurrentUser() user: AuthUser, @Body() body: { env: ZatcaEnv; ownerId?: number }) {
    if (!body?.env) throw new BadRequestException("env is required");
    await this.onboarding.resetChain(scopeId(user), body.env, this.oid(body.ownerId));
    return { ok: true };
  }
}
