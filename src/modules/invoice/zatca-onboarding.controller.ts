import {
  BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";
import { ZatcaOnboardingService, type SellerProfileInput } from "./services/zatca-onboarding.service";
import { isOnboarded } from "../../common/invoice-readiness";
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
        // A certificate alone is not onboarding: the slot may be holding the
        // COMPLIANCE one. Same definition the gate uses, so this endpoint
        // cannot disagree with what actually decides whether invoices go out.
        onboarded: isOnboarded(c) && c.activeEnvironment !== "sandbox",
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
  async issueProductionCsid(
    @CurrentUser() user: AuthUser,
    // `source` widened to ZatcaEnv so a SIMULATION seller can be promoted at
    // all; `dryRun` reports the suite without spending the compliance CSID.
    @Body() body: { source?: ZatcaEnv; ownerId?: number; dryRun?: boolean },
  ) {
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
    // `dryRun` reports the six verdicts and stops there. The suite persists
    // nothing and simplified documents can be re-submitted, so this is the way
    // to see where a seller stands without spending their compliance CSID on a
    // promotion — and without touching a single real invoice.
    if (body.dryRun) return { dryRun: true, promoted: false, suite };
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

  /**
   * DELETE /zatca/landlords/:ownerId/link
   * Disconnect a landlord from ZATCA: wipe every certificate, key and secret we
   * hold for them and put the seller back to "profile saved, not integrated".
   * Nothing already filed with ZATCA is touched, and the ICV/PIH counters are
   * kept so a later re-link continues the chain instead of colliding with it —
   * see `ZatcaOnboardingService.unlink`.
   *
   * DELETE rather than a POST verb so the global audit interceptor records it
   * with the landlord's id; severing a live seller is exactly the kind of thing
   * an account owner should be able to find in the trail afterwards.
   *
   * Gated on ZATCA_PROMOTE_PRODUCTION, not ZATCA_ONBOARD: an accountant can
   * link a landlord, but taking a production seller offline belongs with the
   * same authority that puts one live (and that runs `reset-chain`).
   */
  @Delete("landlords/:ownerId/link")
  @RequirePermissions(PERMISSIONS.ZATCA_PROMOTE_PRODUCTION)
  async unlinkLandlord(@CurrentUser() user: AuthUser, @Param("ownerId") ownerId: string) {
    const oid = this.oid(ownerId);
    if (oid == null) throw new BadRequestException("رقم المؤجر غير صالح");
    const row = await this.onboarding.unlink(scopeId(user), oid);
    return { ok: true, ownerId: oid, configured: true, onboarded: false, activeEnvironment: row.activeEnvironment };
  }

  /**
   * DELETE /zatca/link
   * The same thing for the legacy account-level seller (the row with no
   * landlord). Kept separate from the route above so an absent/garbage
   * `ownerId` can never silently fall through to wiping it.
   */
  @Delete("link")
  @RequirePermissions(PERMISSIONS.ZATCA_PROMOTE_PRODUCTION)
  async unlinkAccount(@CurrentUser() user: AuthUser) {
    const row = await this.onboarding.unlink(scopeId(user), null);
    return { ok: true, ownerId: null, configured: true, onboarded: false, activeEnvironment: row.activeEnvironment };
  }
}
