import { Body, Controller, Get, Inject, Module, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, isNull } from "drizzle-orm";
import { usersTable, ownersTable, companiesTable, tenantsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { resolvePackage, packageMode, planPrice, isPayablePlan, type BillingCycle } from "../../common/packages";
import { packageUsage } from "../../common/quota";
import { deriveSubscription } from "../../common/subscription";

/** The caller's subscription package — its limits, mode and current usage. */
@ApiTags("package")
@ApiBearerAuth("user-jwt")
@Controller("me")
@UseGuards(JwtAuthGuard)
class PackageController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  @Get("package")
  async myPackage(@CurrentUser() user: AuthUser) {
    const ownerId = scopeId(user);
    const [owner] = await this.db
      .select({
        packagePlan: usersTable.packagePlan, userType: usersTable.userType, onboardedAt: usersTable.onboardedAt,
        subscriptionStartedAt: usersTable.subscriptionStartedAt, subscriptionEndsAt: usersTable.subscriptionEndsAt,
        subscriptionStatus: usersTable.subscriptionStatus, billingCycle: usersTable.billingCycle,
        setupCompletedAt: usersTable.setupCompletedAt, companyId: usersTable.companyId,
      })
      .from(usersTable)
      .where(eq(usersTable.id, ownerId));
    const plan = resolvePackage(owner?.packagePlan);
    const usage = await packageUsage(this.db, ownerId);

    // Settings completeness — drives the post-payment "complete your settings"
    // lock. Complete when EITHER the account company OR the default landlord
    // carries an identity + address (lenient on purpose, so a filled account is
    // never falsely locked out). Tenant-mode accounts are never gated here.
    const filled = (v: unknown) => v != null && String(v).trim() !== "";
    let companyComplete = false;
    if (owner?.companyId) {
      const [co] = await this.db.select().from(companiesTable).where(eq(companiesTable.id, owner.companyId));
      companyComplete = !!co && filled(co.name) && filled(co.city) && filled(co.address);
    }
    // Any non-deleted landlord with a complete national address satisfies the
    // lock — not only the one flagged `is_default` (older records may not carry
    // the flag, which would otherwise keep a fully-filled account locked).
    const acctOwners = await this.db.select().from(ownersTable)
      .where(and(eq(ownersTable.userId, ownerId), isNull(ownersTable.deletedAt)));
    const ownerComplete = acctOwners.some((o) => filled(o.name) && filled(o.buildingNumber)
      && filled(o.nationalAddressStreet) && filled(o.nationalAddressDistrict)
      && filled(o.nationalAddressCity) && filled(o.postalCode));
    const settingsComplete = plan.mode === "tenant" ? true : (companyComplete || ownerComplete);
    const endsAt = owner?.subscriptionEndsAt ?? null;
    const daysRemaining = endsAt ? Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86_400_000) : null;

    const cycle = (owner?.billingCycle === "yearly" ? "yearly" : "monthly") as BillingCycle;
    const sub = deriveSubscription({ storedStatus: owner?.subscriptionStatus, subscriptionEndsAt: endsAt });
    const amountDue = planPrice(owner?.packagePlan, cycle);
    return {
      plan,
      mode: plan.mode,
      usage,
      userType: owner?.userType ?? "individual",
      onboarded: owner?.onboardedAt != null,
      // First-run getting-started checklist completed (persisted, not local).
      setupCompleted: owner?.setupCompletedAt != null,
      // Required-settings completeness — the dashboard locks to Settings until true.
      settingsComplete,
      subscriptionStartedAt: owner?.subscriptionStartedAt ?? null,
      subscriptionEndsAt: endsAt,
      daysRemaining,
      expired: daysRemaining != null && daysRemaining < 0,
      // Subscription lifecycle (drives the pay/grace/locked alerts + gating).
      subscription: {
        status: sub.status,
        needsPayment: sub.needsPayment,
        locked: sub.locked,
        graceUntil: sub.graceUntil,
        daysUntilLock: sub.daysUntilLock,
        billingCycle: cycle,
        amountDue,
        payable: isPayablePlan(owner?.packagePlan),
      },
    };
  }

  /** Mark the first-run getting-started checklist as complete (idempotent). */
  @Post("setup-complete")
  async markSetupComplete(@CurrentUser() user: AuthUser) {
    const ownerId = scopeId(user);
    await this.db.update(usersTable)
      .set({ setupCompletedAt: new Date() } as any)
      .where(and(eq(usersTable.id, ownerId), isNull(usersTable.setupCompletedAt)));
    return { success: true };
  }

  /**
   * Complete the first-login setup wizard. Behaviour depends on the package
   * mode: a landlord account captures its type (individual/company), and we
   * create the default landlord record (individual) or company profile +
   * logo (company); a tenant account just stores its own details. Always
   * stamps `onboardedAt` so the wizard doesn't show again.
   */
  @Post("onboarding")
  async completeOnboarding(@CurrentUser() user: AuthUser, @Body() body: any) {
    const ownerId = scopeId(user);
    const [owner] = await this.db.select().from(usersTable).where(eq(usersTable.id, ownerId));
    const mode = packageMode(owner?.packagePlan);

    // Onboarding is a ONE-TIME account setup. Once the account is onboarded,
    // this endpoint is an idempotent no-op — it must NEVER re-run setup or
    // overwrite the account identity. Adding another landlord through an
    // onboarding-mode wizard previously clobbered a managing account's name +
    // phone with the new landlord's, and could rewrite its company/landlord.
    if (owner?.onboardedAt != null) return { success: true, onboarded: true };

    const userPatch: any = { onboardedAt: new Date() };
    if (body?.name) userPatch.name = String(body.name).trim();
    if (body?.phone) userPatch.phone = String(body.phone).trim();

    if (mode === "landlord") {
      const userType = body?.userType === "company" ? "company" : "individual";
      userPatch.userType = userType;

      if (userType === "company" && body?.company) {
        const c = body.company;
        const values: any = {
          name: (c.name || owner?.name || "").trim() || "—",
          vatNumber: c.vatNumber ?? null,
          commercialReg: c.commercialReg ?? null,
          officialEmail: c.officialEmail ?? null,
          companyPhone: c.companyPhone ?? userPatch.phone ?? null,
          city: c.city ?? null,
          address: c.address ?? null,
          logoKey: c.logoKey ?? null,
        };
        // The user references its company via users.companyId.
        if (owner?.companyId) {
          await this.db.update(companiesTable).set(values).where(eq(companiesTable.id, owner.companyId));
          userPatch.companyId = owner.companyId;
        } else {
          const [created] = await this.db.insert(companiesTable).values(values as any).returning({ id: companiesTable.id });
          userPatch.companyId = created!.id;
        }
      }

      // Create the default landlord (owner) record ONLY when the account holder
      // is also a landlord. A managing office/broker (selfLandlord = false)
      // gets an account with no landlord of its own.
      if (body?.selfLandlord) {
        const l = body?.landlord ?? {};
        const [existing] = await this.db.select({ id: ownersTable.id }).from(ownersTable)
          .where(and(eq(ownersTable.userId, ownerId), isNull(ownersTable.deletedAt)));
        if (!existing) {
          await this.db.insert(ownersTable).values({
            userId: ownerId,
            name: (l.name || body?.company?.name || owner?.name || "").trim() || "—",
            idNumber: l.idNumber ?? null,
            phone: l.phone ?? userPatch.phone ?? null,
            email: l.email ?? null,
            iban: l.iban ?? null,
            taxNumber: l.taxNumber ?? null,
          } as any);
        }
      }
    } else {
      // Tenant package — onboarding IS adding the account holder as a tenant.
      const tn = body?.tenant ?? {};
      const [existing] = await this.db.select({ id: tenantsTable.id }).from(tenantsTable)
        .where(and(eq(tenantsTable.userId, ownerId), isNull(tenantsTable.deletedAt)));
      const values: any = {
        name: (tn.name || body?.name || owner?.name || "").trim() || "—",
        type: tn.type === "company" ? "company" : "individual",
        nationalId: tn.nationalId ?? null,
        phone: tn.phone ?? userPatch.phone ?? owner?.phone ?? null,
        email: tn.email ?? null,
        taxNumber: tn.taxNumber ?? null,
        address: tn.address ?? null,
        postalCode: tn.postalCode ?? null,
        status: "active",
      };
      if (existing) {
        await this.db.update(tenantsTable).set(values).where(eq(tenantsTable.id, existing.id));
      } else {
        await this.db.insert(tenantsTable).values({ userId: ownerId, ...values } as any);
      }
    }

    await this.db.update(usersTable).set(userPatch).where(eq(usersTable.id, ownerId));
    return { success: true, onboarded: true };
  }
}

@Module({ controllers: [PackageController] })
export class PackageModule {}
