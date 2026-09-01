import { Body, Controller, Delete, Get, Inject, Module, NotFoundException, Param, Patch, Post, Query, BadRequestException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, isNull, or, ilike, count, asc, desc, inArray } from "drizzle-orm";
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
import { listQuerySchema, parseEnumList, wantsPagination } from "../../common/pagination";
import { EmailService } from "../email/email.service";
import {
  LIMITS, applyBoolNonNull, applyEmail, applyFourDigitCode, applyIban, applyMoney,
  applyOneOfNonNull, applyPhone, applyPostalCode, applyRequiredText, applyText,
  applyVatNumber, applyWith, partyIdentityNumber, requiredForeignKeyId, applyDraftPhone,
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
    // Normalised but never refused — a half-typed number is the point of a
    // draft, while a recognisable one must still be stored canonically so it
    // joins to the other phone columns by exact string equality.
    applyDraftPhone(v, "phone", "رقم الجوال");
    applyText(v, "email", "البريد الإلكتروني", LIMITS.line);
    applyText(v, "iban", "رقم الآيبان", LIMITS.identifier);
    applyText(v, "taxNumber", "الرقم الضريبي", LIMITS.identifier);
    applyText(v, "postalCode", "الرمز البريدي", LIMITS.identifier);
    applyText(v, "additionalNumber", "الرقم الإضافي", LIMITS.identifier);
    applyText(v, "buildingNumber", "رقم المبنى", LIMITS.identifier);
    applyText(v, "originalTenantIdNumber", "رقم هوية المستأجر الأصلي", LIMITS.identifier);
    applyDraftPhone(v, "originalTenantPhone", "جوال المستأجر الأصلي");
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

  /**
   * Tenants, paginated and filtered by the database.
   *
   * Query parameters, all applied in SQL: `search` (name / national ID / phone
   * / email / tax number), `type` (individual|company), `status`, `isDraft`.
   *
   * `type` deliberately stays OUT of the pagination trigger: a caller that
   * sends only `?type=company` has always received a bare array and still does.
   * The tab's three headline cards - total, individuals, companies - come back
   * as `stats.byType`, counted by the database; they were being derived from
   * the fetched array, which stops being the whole truth the moment this list
   * is paged.
   */
  @Get()
  @RequirePermissions(PERMISSIONS.TENANTS_VIEW)
  async list(@CurrentUser() user: AuthUser, @Query() rawQuery: any) {
    const usePaginated = wantsPagination(rawQuery, ["search"]);
    const q = listQuerySchema.parse(rawQuery ?? {});
    const owner = scopeId(user);

    const conds: any[] = [eq(tenantsTable.userId, owner), isNull(tenantsTable.deletedAt)];
    const types = parseEnumList(rawQuery?.type, ["individual", "company"] as const);
    const statuses = parseEnumList(rawQuery?.status, ["active", "inactive"] as const);
    if (statuses) conds.push(inArray(tenantsTable.status, statuses));
    if (rawQuery?.isDraft === "1" || rawQuery?.isDraft === "true") conds.push(eq(tenantsTable.isDraft, true));
    else if (rawQuery?.isDraft === "0" || rawQuery?.isDraft === "false") conds.push(eq(tenantsTable.isDraft, false));
    if (q.search) {
      conds.push(or(
        ilike(tenantsTable.name, `%${q.search}%`),
        ilike(tenantsTable.shortName, `%${q.search}%`),
        ilike(tenantsTable.nationalId, `%${q.search}%`),
        ilike(tenantsTable.phone, `%${q.search}%`),
        ilike(tenantsTable.email, `%${q.search}%`),
        ilike(tenantsTable.taxNumber, `%${q.search}%`),
      ));
    }
    // Every filter EXCEPT type - the three cards (total / individuals /
    // companies) must keep their counts while one type is selected.
    const statsWhere = and(...conds);
    if (types) conds.push(inArray(tenantsTable.type, types));
    const where = and(...conds);

    const sortFn = q.order === "asc" ? asc : desc;
    // `id` tiebreak: `created_at` is not unique, and paging a list ordered on a
    // non-unique key alone can show one tenant twice and skip another.
    let rowsQ = this.db.select().from(tenantsTable).where(where)
      .orderBy(sortFn(tenantsTable.createdAt), sortFn(tenantsTable.id)).$dynamic();
    if (usePaginated) rowsQ = rowsQ.limit(q.pageSize).offset((q.page - 1) * q.pageSize);

    const [rows, totalRow, typeRows] = await Promise.all([
      rowsQ,
      usePaginated
        ? this.db.select({ total: count() }).from(tenantsTable).where(where)
        : Promise.resolve([{ total: 0 }]),
      usePaginated
        ? this.db.select({ type: tenantsTable.type, cnt: count() })
            .from(tenantsTable).where(statsWhere).groupBy(tenantsTable.type)
        : Promise.resolve([]),
    ]);
    await attachTenantNationality(this.db, rows as any[]);
    if (!usePaginated) return rows;
    const byType: Record<string, number> = {};
    for (const r of typeRows as Array<{ type: string; cnt: number }>) byType[r.type] = Number(r.cnt);
    return {
      data: rows,
      page: q.page,
      pageSize: q.pageSize,
      total: Number(totalRow[0]?.total ?? 0),
      stats: { byType },
    };
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
    const tid = requiredForeignKeyId(id, "رقم المستأجر");
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
    const tid = requiredForeignKeyId(id, "رقم المستأجر");
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
    const willBeDraft = body.isDraft !== undefined ? Boolean(body.isDraft) : Boolean(prior.isDraft);
    // The edit path enforces exactly what create does — it used to write every
    // value through untouched.
    sanitizeTenantFields(updateData, body.type ?? prior.type ?? null, willBeDraft);

    /* Finalising a draft re-validates the WHOLE tenant.
     *
     * The draft exemption from the exact identity formats ended when `isDraft`
     * was cleared, but nothing re-applied them to what the draft was already
     * carrying — so a phone that is not a phone, or a 2-digit national ID,
     * became live data just by not being re-sent. That is not cosmetic here:
     * the tenant portal matches a tenant to their contracts by phone STRING,
     * so a malformed number is a tenant who can see nothing. Validated against
     * the merged row, and the normalised values are written back so the stored
     * column is the one the match will hit.
     */
    if (prior.isDraft && !willBeDraft) {
      const merged: Record<string, unknown> = {};
      for (const f of FIELDS) merged[f] = f in updateData ? updateData[f] : (prior as Record<string, any>)[f];
      const mergedType = body.type ?? prior.type ?? null;
      sanitizeTenantFields(merged, mergedType, false);
      assertCompanyCommercialReg({ type: mergedType, nationalId: merged.nationalId as string | null, isDraft: false });
      assertNationalAddress({ ...merged, isDraft: false });
      for (const f of FIELDS) {
        if (f in updateData) continue;
        if (!(f in merged)) continue;
        if (merged[f] !== (prior as Record<string, any>)[f]) updateData[f] = merged[f];
      }
    }
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
    const tid = requiredForeignKeyId(id, "رقم المستأجر");
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
