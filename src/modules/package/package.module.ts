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
        subscriptionIsTrial: usersTable.subscriptionIsTrial,
      })
      .from(usersTable)
      .where(eq(usersTable.id, ownerId));
    const plan = resolvePackage(owner?.packagePlan);
    const usage = await packageUsage(this.db, ownerId);

    // Settings completeness — drives the post-payment "complete your settings"
    // lock. Complete when EITHER the account company OR the account's own party
    // record carries an identity + national address (lenient on purpose, so a
    // filled account is never falsely locked out).
    const filled = (v: unknown) => v != null && String(v).trim() !== "";
    /** The national-address block every party must carry for a tax invoice. */
    const partyComplete = (p: {
      name: string | null; buildingNumber: string | null; nationalAddressStreet: string | null;
      nationalAddressDistrict: string | null; nationalAddressCity: string | null; postalCode: string | null;
    }) => filled(p.name) && filled(p.buildingNumber) && filled(p.nationalAddressStreet)
      && filled(p.nationalAddressDistrict) && filled(p.nationalAddressCity) && filled(p.postalCode);

    let companyComplete = false;
    if (owner?.companyId) {
      const [co] = await this.db.select().from(companiesTable).where(eq(companiesTable.id, owner.companyId));
      companyComplete = !!co && filled(co.name) && filled(co.city) && filled(co.address);
    }
    let settingsComplete: boolean;
    if (plan.mode === "tenant") {
      // Tenant-package accounts used to be exempt, so a paid account landed on
      // Settings with nothing holding it there and could skip its own details
      // entirely. Same gate as everyone else now — but read from the account's
      // OWN tenant row, never from a party an Ejar import brought in (an
      // imported tenant with a filled address would otherwise open the lock).
      const acctTenants = await this.db.select().from(tenantsTable)
        .where(and(eq(tenantsTable.userId, ownerId), isNull(tenantsTable.deletedAt)));
      const self = acctTenants.find((t) => t.isAccountHolder)
        ?? acctTenants.filter((t) => !t.ejarSource)[0];
      settingsComplete = companyComplete || (!!self && partyComplete(self));
    } else {
      // Any non-deleted landlord satisfies the lock — not only the account
      // holder (older records may not carry the flag, which would otherwise
      // keep a fully-filled account locked).
      const acctOwners = await this.db.select().from(ownersTable)
        .where(and(eq(ownersTable.userId, ownerId), isNull(ownersTable.deletedAt)));
      settingsComplete = companyComplete || acctOwners.some(partyComplete);
    }
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
        // A free window granted by an admin — the app labels it as a trial
        // instead of implying the account has paid.
        isTrial: !!owner?.subscriptionIsTrial,
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

      // Registration already created the company row with its name + CR; the
      // wizard doesn't ask for either again. Read them so the landlord record
      // below can be seeded from the same identity.
      const [priorCompany] = owner?.companyId
        ? await this.db.select({ name: companiesTable.name, commercialReg: companiesTable.commercialReg })
            .from(companiesTable).where(eq(companiesTable.id, owner.companyId))
        : [];

      if (userType === "company" && body?.company) {
        const c = body.company;
        // Only write what the wizard actually collected. Spreading a fixed
        // shape with `?? null` blanked the company name and the commercial
        // registration captured at registration — the wizard never asks for
        // the CR, so every company that finished onboarding lost it and the
        // settings form then showed an empty (but required) field.
        const values: any = {};
        const put = (k: string, v: unknown) => {
          if (v == null || String(v).trim() === "") return;
          values[k] = String(v).trim();
        };
        put("name", c.name);
        put("vatNumber", c.vatNumber);
        put("commercialReg", c.commercialReg);
        put("officialEmail", c.officialEmail);
        put("companyPhone", c.companyPhone ?? userPatch.phone);
        put("city", c.city);
        put("address", c.address);
        put("logoKey", c.logoKey);
        // The user references its company via users.companyId.
        if (owner?.companyId) {
          if (Object.keys(values).length) {
            await this.db.update(companiesTable).set(values).where(eq(companiesTable.id, owner.companyId));
          }
          userPatch.companyId = owner.companyId;
        } else {
          const [created] = await this.db
            .insert(companiesTable)
            .values({ ...values, name: values.name || owner?.name || "—" } as any)
            .returning({ id: companiesTable.id });
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
            // A company account's own landlord IS the company, so it carries
            // the company name — not the general manager's personal name.
            name: (userType === "company"
              ? (body?.company?.name || priorCompany?.name || l.name)
              : (l.name || owner?.name) || "").trim() || "—",
            type: userType,
            // For a company the "ID number" column holds the CR (see
            // common/commercial-reg.ts) — take the one already on file.
            idNumber: (userType === "company"
              ? (l.idNumber || body?.company?.commercialReg || priorCompany?.commercialReg)
              : l.idNumber) ?? null,
            phone: l.phone ?? userPatch.phone ?? null,
            email: l.email ?? null,
            iban: l.iban ?? null,
            taxNumber: l.taxNumber ?? null,
            // Identity: this row IS the account holder. Server-owned and not in
            // the controller's field allowlist, so no request can move it onto
            // an Ejar-imported landlord later.
            isAccountHolder: true,
            // Convenience, and separately reassignable: new properties auto-link
            // here until the user picks a different default.
            isDefault: true,
          } as any);
        }
      }
    } else {
      // Tenant package — onboarding IS adding the account holder as a tenant.
      const tn = body?.tenant ?? {};
      // A company tenant account is the COMPANY; registration already stored
      // its name and CR, and the wizard doesn't ask for either again.
      const isCompanyAccount = owner?.userType === "company";
      const [priorCompany] = owner?.companyId
        ? await this.db.select({ name: companiesTable.name, commercialReg: companiesTable.commercialReg })
            .from(companiesTable).where(eq(companiesTable.id, owner.companyId))
        : [];
      // Only ever update the account holder's OWN tenant row. Matching any
      // tenant would let an Ejar-imported party be overwritten with the
      // account's identity when the import ran before setup finished.
      const [existing] = await this.db.select({ id: tenantsTable.id }).from(tenantsTable)
        .where(and(
          eq(tenantsTable.userId, ownerId),
          eq(tenantsTable.isAccountHolder, true),
          isNull(tenantsTable.deletedAt),
        ));
      const values: any = {
        name: (isCompanyAccount
          ? (priorCompany?.name || tn.name || body?.name)
          : (tn.name || body?.name || owner?.name) || "").trim() || "—",
        type: isCompanyAccount ? "company" : (tn.type === "company" ? "company" : "individual"),
        // For a company the national-ID column holds the CR.
        nationalId: (isCompanyAccount ? (tn.nationalId || priorCompany?.commercialReg) : tn.nationalId) ?? null,
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
        await this.db.insert(tenantsTable).values({ userId: ownerId, ...values, isAccountHolder: true } as any);
      }
    }

    await this.db.update(usersTable).set(userPatch).where(eq(usersTable.id, ownerId));
    return { success: true, onboarded: true };
  }
}

@Module({ controllers: [PackageController] })
export class PackageModule {}
