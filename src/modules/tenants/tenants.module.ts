import { Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, isNull, or, ilike, count, asc, desc } from "drizzle-orm";
import { tenantsTable, contractsTable, simpleInvoicesTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { assertNationalAddress } from "../../common/national-address";
import { assertCompanyCommercialReg } from "../../common/commercial-reg";
import { scopeId } from "../../common/scope";
import { resolveLookupId, attachLookupLabels } from "../../common/lookups-resolve";
import { listQuerySchema } from "../../common/pagination";
import { EmailService } from "../email/email.service";
import {
  LIMITS, applyBoolNonNull, applyEmail, applyFourDigitCode, applyIban, applyMoney,
  applyOneOfNonNull, applyPhone, applyPostalCode, applyRequiredText, applyText,
  applyVatNumber, applyWith, partyIdentityNumber,
} from "../../common/validation";

const FIELDS = [
  "name", "shortName", "type", "status", "nationalId", "phone", "email", "taxNumber",
  "address", "postalCode", "additionalNumber", "buildingNumber", "notes",
  // Phase 4 additions: financial info, structured national address,
  // representative (وكيل) fields.
  "iban",
  "nationalAddressCity", "nationalAddressDistrict", "nationalAddressStreet",
  "isRepresentative", "representativeDocUrl",
  "originalTenantName", "originalTenantIdNumber", "originalTenantPhone", "originalTenantEmail",
  "isDraft",
  // Financial profile — collected by the tenant wizard's Financial step. These
  // columns existed but were never on the allowlist, so every value the form
  // sent was silently dropped on update.
  "employer", "monthlyIncome",
] as const;

/**
 * Nationality (الجنسية) is written to BOTH the lookup FK (authoritative, so it
 * can be filtered/reported on) and the legacy free-text column (which older
 * readers — the mobile app, Ejar-imported rows — still read). Handled outside
 * FIELDS because the client sends one human value and the server derives both.
 */
const NATIONALITY_SPEC = [{ idField: "nationalityLookupId", out: "nationality", mode: "labelAr" as const }];

/**
 * Attach the display nationality: the lookup label when the FK is set, else
 * whatever text the row already carried (legacy + Ejar-imported rows).
 */
async function attachTenantNationality(db: Drizzle, rows: any[]): Promise<void> {
  const legacy = rows.map((r) => r?.nationality ?? null);
  await attachLookupLabels(db, rows, NATIONALITY_SPEC);
  rows.forEach((r, i) => { if (r && r.nationality == null) r.nationality = legacy[i]; });
}

const TENANT_TYPES = ["individual", "company"] as const;
const TENANT_STATUSES = ["active", "inactive"] as const;

/**
 * Shape, length and range checks for every tenant field a request may set.
 *
 * Run on create AND on PATCH — the update path copied its allowlist straight
 * into `set()`, so it accepted things the create path would have rejected
 * (a malformed phone, an out-of-range `monthlyIncome`, a 5,000-character name).
 *
 * `nationalId` holds a CR for a company and a national ID / Iqama for an
 * individual, which is why the party `type` is passed in;
 * `assertCompanyCommercialReg` already covers the company half on the required
 * side, this adds the individual half and applies to both paths.
 *
 * Drafts are exempt from the exact identity formats (a draft is explicitly
 * incomplete), never from the length caps or numeric bounds.
 */
function sanitizeTenantFields(v: Record<string, unknown>, type: unknown, isDraft: boolean): void {
  applyRequiredText(v, "name", "اسم المستأجر", LIMITS.name);
  applyText(v, "shortName", "الاسم المختصر", LIMITS.shortName);
  applyOneOfNonNull(v, "type", TENANT_TYPES, "نوع المستأجر");
  applyOneOfNonNull(v, "status", TENANT_STATUSES, "حالة المستأجر");
  applyText(v, "address", "العنوان", LIMITS.address);
  applyText(v, "notes", "الملاحظات", LIMITS.notes);
  applyText(v, "employer", "جهة العمل", LIMITS.name);
  applyMoney(v, "monthlyIncome", "الدخل الشهري");
  applyBoolNonNull(v, "isRepresentative", "وكيل");
  applyText(v, "representativeDocUrl", "وثيقة الوكالة", LIMITS.address);
  applyText(v, "originalTenantName", "اسم المستأجر الأصلي", LIMITS.name);
  applyText(v, "nationalAddressCity", "المدينة");
  applyText(v, "nationalAddressDistrict", "الحي");
  applyText(v, "nationalAddressStreet", "الشارع");
  applyBoolNonNull(v, "isDraft", "مسودة");
  if (!isDraft) {
    applyWith(v, "nationalId", (raw) => partyIdentityNumber(raw, type));
    applyPhone(v, "phone");
    applyEmail(v, "email");
    applyIban(v, "iban");
    applyVatNumber(v, "taxNumber");
    applyPostalCode(v, "postalCode");
    applyFourDigitCode(v, "additionalNumber", "الرقم الإضافي");
    applyFourDigitCode(v, "buildingNumber", "رقم المبنى");
    applyWith(v, "originalTenantIdNumber", (raw) => partyIdentityNumber(raw, null, "رقم هوية المستأجر الأصلي"));
    applyPhone(v, "originalTenantPhone", "جوال المستأجر الأصلي");
    applyEmail(v, "originalTenantEmail", "بريد المستأجر الأصلي");
  } else {
    applyText(v, "nationalId", "رقم الهوية / السجل التجاري", LIMITS.identifier);
    applyText(v, "phone", "رقم الجوال", LIMITS.identifier);
    applyText(v, "email", "البريد الإلكتروني", LIMITS.line);
    applyText(v, "iban", "رقم الآيبان", LIMITS.identifier);
    applyText(v, "taxNumber", "الرقم الضريبي", LIMITS.identifier);
    applyText(v, "postalCode", "الرمز البريدي", LIMITS.identifier);
    applyText(v, "additionalNumber", "الرقم الإضافي", LIMITS.identifier);
    applyText(v, "buildingNumber", "رقم المبنى", LIMITS.identifier);
    applyText(v, "originalTenantIdNumber", "رقم هوية المستأجر الأصلي", LIMITS.identifier);
    applyText(v, "originalTenantPhone", "جوال المستأجر الأصلي", LIMITS.identifier);
    applyText(v, "originalTenantEmail", "بريد المستأجر الأصلي", LIMITS.line);
  }
}

/** Resolve a human nationality value to { text, lookupId } for persistence. */
async function nationalityValues(db: Drizzle, raw: unknown): Promise<{ nationality: string | null; nationalityLookupId: number | null }> {
  const text = raw == null || String(raw).trim() === "" ? null : String(raw).trim();
  return { nationality: text, nationalityLookupId: await resolveLookupId(db, "nationality", text) };
}

@ApiTags("tenants")
@ApiBearerAuth("user-jwt")
@Controller("tenants")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class TenantsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly email: EmailService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TENANTS_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const usePaginated = rawQuery && (rawQuery.page != null || rawQuery.pageSize != null || rawQuery.search != null);
    const q = listQuerySchema.parse(rawQuery ?? {});
    const owner = scopeId(user);
    const type: string | undefined = rawQuery?.type;

    const baseCond = [eq(tenantsTable.userId, owner), isNull(tenantsTable.deletedAt)];
    if (type === "individual" || type === "company") baseCond.push(eq(tenantsTable.type, type));
    const searchCond = q.search ? [or(
      ilike(tenantsTable.name, `%${q.search}%`),
      ilike(tenantsTable.nationalId, `%${q.search}%`),
      ilike(tenantsTable.phone, `%${q.search}%`),
      ilike(tenantsTable.email, `%${q.search}%`),
    )] : [];
    const where = and(...baseCond, ...searchCond);

    const sortFn = q.order === "asc" ? asc : desc;
    let rowsQ = this.db.select().from(tenantsTable).where(where).orderBy(sortFn(tenantsTable.createdAt)).$dynamic();
    if (usePaginated) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow] = await Promise.all([
      rowsQ,
      usePaginated
        ? this.db.select({ total: count() }).from(tenantsTable).where(where)
        : Promise.resolve([{ total: 0 }]),
    ]);
    await attachTenantNationality(this.db, rows as any[]);
    if (!usePaginated) return rows;
    return { data: rows, page: q.page, pageSize: q.pageSize, total: Number(totalRow[0]?.total ?? 0) };
  }

  @Post()
  @RequirePermissions(PERMISSIONS.TENANTS_WRITE)
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    if (!body.name) throw new BadRequestException("الاسم مطلوب");
    assertNationalAddress(body);
    assertCompanyCommercialReg(body);
    // "This tenant is my own account" — claimable once, on create only, while
    // the account has no such record. See owners.create for the reasoning.
    const [heldBy] = await this.db.select({ id: tenantsTable.id }).from(tenantsTable)
      .where(and(eq(tenantsTable.userId, scopeId(user)), eq(tenantsTable.isAccountHolder, true), isNull(tenantsTable.deletedAt)))
      .limit(1);
    const claimsAccountHolder = !heldBy && Boolean(body.isAccountHolder ?? false);
    const values: Record<string, unknown> = {
      userId: scopeId(user),
      name: body.name,
      shortName: body.shortName ?? null,
      type: body.type || "individual",
      nationalId: body.nationalId ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      taxNumber: body.taxNumber ?? null,
      address: body.address ?? null,
      postalCode: body.postalCode ?? null,
      additionalNumber: body.additionalNumber ?? null,
      buildingNumber: body.buildingNumber ?? null,
      notes: body.notes ?? null,
      // Phase 4 additions:
      iban: body.iban ?? null,
      nationalAddressCity: body.nationalAddressCity ?? null,
      nationalAddressDistrict: body.nationalAddressDistrict ?? null,
      nationalAddressStreet: body.nationalAddressStreet ?? null,
      isRepresentative: Boolean(body.isRepresentative ?? false),
      representativeDocUrl: body.representativeDocUrl ?? null,
      originalTenantName: body.originalTenantName ?? null,
      originalTenantIdNumber: body.originalTenantIdNumber ?? null,
      originalTenantPhone: body.originalTenantPhone ?? null,
      originalTenantEmail: body.originalTenantEmail ?? null,
      employer: body.employer ?? null,
      monthlyIncome: body.monthlyIncome ?? null,
      ...(await nationalityValues(this.db, body.nationality)),
      isDraft: Boolean(body.isDraft ?? false),
      isAccountHolder: claimsAccountHolder,
      isDemo: "false",
    };
    sanitizeTenantFields(values, values.type, Boolean(values.isDraft));
    const [tenant] = await this.db.insert(tenantsTable).values(values as any).returning();
    // Optional welcome email (opt-in via the add-tenant checkbox). Best-effort
    // and fire-and-forget so it never blocks or fails tenant creation.
    if (body.sendWelcomeEmail && tenant?.email) {
      void this.email.sendTenantWelcome(tenant.email, tenant.name);
    }
    await attachTenantNationality(this.db, [tenant] as any[]);
    return tenant;
  }

  /** Email the tenant a nudge to download the mobile app. */
  @Post(":id/app-reminder")
  @RequirePermissions(PERMISSIONS.TENANTS_WRITE)
  async appReminder(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const tid = parseInt(id, 10);
    const [tenant] = await this.db.select().from(tenantsTable)
      .where(and(eq(tenantsTable.id, tid), eq(tenantsTable.userId, scopeId(user)), isNull(tenantsTable.deletedAt)));
    if (!tenant) throw new NotFoundException("غير موجود");
    if (!tenant.email) throw new BadRequestException("لا يوجد بريد إلكتروني لهذا المستأجر · This tenant has no email on file");
    const sent = await this.email.sendAppDownloadReminder(tenant.email, tenant.name);
    return { sent };
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.TENANTS_WRITE)
  async update(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() body: any) {
    const tid = parseInt(id, 10);
    // Read the prior row so we can detect the draft → finalized transition
    // and only send the welcome email once, when the tenant is actually
    // being promoted from draft to finalized.
    const [prior] = await this.db.select().from(tenantsTable)
      .where(and(eq(tenantsTable.id, tid), eq(tenantsTable.userId, scopeId(user)), isNull(tenantsTable.deletedAt)));
    if (!prior) throw new NotFoundException("غير موجود");

    // Only checked when the request actually touches the identity fields.
    // Enforcing it on every PATCH would block an unrelated edit — a phone
    // change, say — on a legacy company row that predates the requirement,
    // and Ejar-imported rows are inserted outside this controller entirely.
    if (body.type !== undefined || body.nationalId !== undefined) {
      assertCompanyCommercialReg({
        type: body.type ?? prior.type,
        nationalId: body.nationalId !== undefined ? body.nationalId : prior.nationalId,
        isDraft: body.isDraft !== undefined ? Boolean(body.isDraft) : Boolean(prior.isDraft),
      });
    }

    const updateData: Record<string, unknown> = {};
    for (const f of FIELDS) if (body[f] !== undefined) updateData[f] = body[f];
    // The edit path enforces exactly what create does — it used to write every
    // value through untouched.
    sanitizeTenantFields(
      updateData,
      body.type ?? prior.type ?? null,
      body.isDraft !== undefined ? Boolean(body.isDraft) : Boolean(prior.isDraft),
    );
    // Nationality is derived, not copied: one incoming value, two columns. An
    // explicit "" clears both, hence the `undefined` check.
    if (body.nationality !== undefined) {
      Object.assign(updateData, await nationalityValues(this.db, body.nationality));
    }
    // Keys outside FIELDS are dropped — `isAccountHolder` among them, since it
    // is server-owned. A body of nothing but such keys would reach `set({})`,
    // which crashes the driver; refuse it as a bad request instead.
    if (Object.keys(updateData).length === 0) throw new BadRequestException("لا توجد حقول للتحديث · No updatable fields in request");
    const [tenant] = await this.db.update(tenantsTable).set(updateData)
      .where(and(eq(tenantsTable.id, tid), eq(tenantsTable.userId, scopeId(user)), isNull(tenantsTable.deletedAt))).returning();
    if (!tenant) throw new NotFoundException("غير موجود");

    // Propagate a renamed tenant to the snapshots stored on contracts and
    // invoices so the new name shows everywhere (installments/collections join
    // the contract, so they update too).
    if (body.name !== undefined && tenant.name !== prior.name) {
      await this.db.update(contractsTable).set({ tenantName: tenant.name })
        .where(and(eq(contractsTable.tenantId, tid), eq(contractsTable.userId, scopeId(user))));
      await this.db.update(simpleInvoicesTable).set({ tenantName: tenant.name })
        .where(and(eq(simpleInvoicesTable.tenantId, tid), eq(simpleInvoicesTable.userId, scopeId(user))));
    }

    // Fire-and-forget welcome email on the draft → finalized transition.
    if (body.sendWelcomeEmail && prior.isDraft && !tenant.isDraft && tenant.email) {
      void this.email.sendTenantWelcome(tenant.email, tenant.name);
    }
    await attachTenantNationality(this.db, [tenant] as any[]);
    return tenant;
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.TENANTS_DELETE)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const tid = parseInt(id, 10);
    // A tenant-package account's own tenant row is its identity — the settings
    // profile binds to it. Same protection as the account holder's landlord.
    const [target] = await this.db.select({ isAccountHolder: tenantsTable.isAccountHolder })
      .from(tenantsTable)
      .where(and(eq(tenantsTable.id, tid), eq(tenantsTable.userId, scopeId(user)), isNull(tenantsTable.deletedAt)));
    if (target?.isAccountHolder) {
      throw new BadRequestException("لا يمكن حذف سجل المستأجر الذي يمثّل حسابك · The tenant record representing your own account cannot be deleted.");
    }
    await this.db.update(tenantsTable).set({ deletedAt: new Date() } as any)
      .where(and(eq(tenantsTable.id, tid), eq(tenantsTable.userId, scopeId(user)), isNull(tenantsTable.deletedAt)));
    return { success: true };
  }
}

@Module({ controllers: [TenantsController] })
export class TenantsModule {}
