import { Body, Controller, Delete, Get, HttpCode, Inject, Module, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString } from "class-validator";
import { and, eq, isNull, inArray, desc, sql } from "drizzle-orm";
import {
  usersTable, ownersTable, propertiesTable, unitsTable, contractsTable, contractUnitsTable,
  paymentsTable, paymentCollectionsTable, tenantsTable, deedsTable, maintenanceRequestsTable,
  simpleInvoicesTable, companiesTable,
} from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { liveStatus } from "../../common/payment-status";
import { attachLookupLabels } from "../../common/lookups-resolve";
import { invoiceQrSvg } from "../../common/zatca-qr";
import { UploadsService } from "../uploads/uploads.service";

class FcmTokenDto {
  @IsString()
  token!: string;

  @IsOptional()
  @IsIn(["ios", "android", "web"])
  platform?: "ios" | "android" | "web";
}

/**
 * Landlord mobile API — READ ONLY. Mirrors the tenant-portal shape but for a
 * landlord (a USER account, user-JWT). Every endpoint returns a flat, mobile-
 * friendly aggregate scoped by scopeId(user) (so employees see their owner's
 * data). No writes — landlords only view their portfolio in the app.
 */
@ApiTags("landlord-mobile")
@ApiBearerAuth("user-jwt")
@Controller("landlord/me")
@UseGuards(JwtAuthGuard)
class LandlordMobileController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle, private readonly uploads: UploadsService) {}

  private num(s: string | null | undefined) { return parseFloat(s || "0") || 0; }

  /**
   * For an OWNER (landlord) mobile login the request is narrowed to that single
   * owner. Returns the set of property ids and contract ids that belong to the
   * owner (within the account scope). For normal user/employee logins
   * (`ownerScopeId == null`) returns `{ propIds: null, contractIds: null }`,
   * meaning "no extra restriction".
   *
   * NOTE: an empty array `[]` means "this owner owns nothing" → callers must
   * AND-in `inArray(col, [])` which yields no rows (Drizzle emits a constant
   * false predicate for an empty list), so the owner correctly sees nothing.
   */
  private async ownerScope(user: AuthUser): Promise<{ propIds: number[] | null; contractIds: number[] | null }> {
    if (user.ownerScopeId == null) return { propIds: null, contractIds: null };
    const uid = scopeId(user);
    const [owner] = await this.db.select({ name: ownersTable.name, idNumber: ownersTable.idNumber })
      .from(ownersTable).where(and(eq(ownersTable.id, user.ownerScopeId), isNull(ownersTable.deletedAt)));
    const props = await this.db.select({ id: propertiesTable.id }).from(propertiesTable)
      .where(and(eq(propertiesTable.userId, uid), eq(propertiesTable.ownerId, user.ownerScopeId), isNull(propertiesTable.deletedAt)));
    const propIds = props.map((p) => p.id);

    const contractIds = new Set<number>();
    // Active contracts: linked to the owner's properties via contract_units.
    if (propIds.length) {
      const cu = await this.db.selectDistinct({ contractId: contractsTable.id })
        .from(contractUnitsTable)
        .innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
        .innerJoin(contractsTable, eq(contractsTable.id, contractUnitsTable.contractId))
        .where(and(inArray(unitsTable.propertyId, propIds), eq(contractsTable.userId, uid), isNull(contractsTable.deletedAt)));
      cu.forEach((c) => contractIds.add(c.contractId));
    }
    // Terminated/cancelled contracts have their contract_units deleted (the units
    // are freed on termination), so they'd vanish from the scope above. Recover
    // them via the contract's stored landlord snapshot — by the unique id number
    // when the owner has one, otherwise by name.
    const idNum = owner?.idNumber?.trim();
    const snap = idNum
      ? eq(contractsTable.landlordIdNumber, idNum)
      : (owner?.name?.trim() ? eq(contractsTable.landlordName, owner.name) : null);
    if (snap) {
      const rows = await this.db.select({ id: contractsTable.id }).from(contractsTable)
        .where(and(eq(contractsTable.userId, uid), isNull(contractsTable.deletedAt), snap));
      rows.forEach((r) => contractIds.add(r.id));
    }
    return { propIds, contractIds: [...contractIds] };
  }
  /** Resolve a stored object key to a short-lived signed URL (or null). */
  private async sign(key: string | null | undefined): Promise<string | null> {
    if (!key) return null;
    try { return await this.uploads.presignGet(key, 3600); } catch { return null; }
  }

  /** Logged-in landlord profile + how many landlords/properties they hold. */
  @Get("profile")
  async profile(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    // Owner login → return the OWNER's own (effective) identity, not the account.
    if (user.ownerScopeId != null) {
      const [o] = await this.db.select().from(ownersTable)
        .where(and(eq(ownersTable.id, user.ownerScopeId), isNull(ownersTable.deletedAt)));
      const name = o?.name ?? null;
      const email = o ? (o.isRepresentative ? o.originalOwnerEmail : o.email) : null;
      const phone = o ? (o.isRepresentative ? o.originalOwnerPhone : o.phone) : null;
      return { id: o?.id ?? null, name, email, phone, createdAt: o?.createdAt ?? null, landlordsCount: 1, isEmployee: false };
    }
    const [u] = await this.db.select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, phone: usersTable.phone, createdAt: usersTable.createdAt })
      .from(usersTable).where(eq(usersTable.id, uid));
    const owners = await this.db.select({ id: ownersTable.id }).from(ownersTable)
      .where(and(eq(ownersTable.userId, uid), isNull(ownersTable.deletedAt)));
    return { ...u, landlordsCount: owners.length, isEmployee: user.ownerUserId != null };
  }

  /** Save the device's Expo push token. Only owner (landlord) logins receive
   *  notifications, so the token is stored on the owner row identified by
   *  ownerScopeId; non-owner (user/employee) logins no-op. */
  @Post("fcm-token")
  @HttpCode(200)
  async saveFcmToken(@CurrentUser() user: AuthUser, @Body() body: FcmTokenDto) {
    const token = body.token?.trim();
    if (!token) return { success: false };
    if (user.ownerScopeId != null) {
      await this.db.update(ownersTable)
        .set({ fcmToken: token, fcmPlatform: body.platform ?? null })
        .where(eq(ownersTable.id, user.ownerScopeId));
      return { success: true };
    }
    return { success: false };
  }

  /** Clear the device's push token on logout. */
  @Delete("fcm-token")
  @HttpCode(200)
  async clearFcmToken(@CurrentUser() user: AuthUser) {
    if (user.ownerScopeId != null) {
      await this.db.update(ownersTable)
        .set({ fcmToken: null, fcmPlatform: null })
        .where(eq(ownersTable.id, user.ownerScopeId));
    }
    return { success: true };
  }

  /** KPI summary for the landlord home screen. */
  @Get("summary")
  async summary(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    const scope = await this.ownerScope(user);
    const props = await this.db.select({ id: propertiesTable.id, totalUnits: propertiesTable.totalUnits }).from(propertiesTable)
      .where(and(eq(propertiesTable.userId, uid), isNull(propertiesTable.deletedAt),
        ...(scope.propIds ? [inArray(propertiesTable.id, scope.propIds)] : [])));
    const propIds = props.map((p) => p.id);
    // Occupancy denominator is the property's declared total units (sum), not
    // the count of created unit records.
    const totalUnits = props.reduce((s, p) => s + (Number(p.totalUnits) || 0), 0);

    let unitsCount = 0, rentedUnits = 0, availableUnits = 0, maintenanceUnits = 0;
    if (propIds.length) {
      const units = await this.db.select({ status: unitsTable.status }).from(unitsTable)
        .where(and(inArray(unitsTable.propertyId, propIds), isNull(unitsTable.deletedAt)));
      unitsCount = units.length;
      rentedUnits = units.filter((u) => u.status === "rented").length;
      availableUnits = units.filter((u) => u.status === "available").length;
      maintenanceUnits = units.filter((u) => u.status === "maintenance").length;
    }

    const contracts = await this.db.select({ id: contractsTable.id, tenantId: contractsTable.tenantId, status: contractsTable.status, monthlyRent: contractsTable.monthlyRent })
      .from(contractsTable).where(and(eq(contractsTable.userId, uid), isNull(contractsTable.deletedAt),
        ...(scope.contractIds ? [inArray(contractsTable.id, scope.contractIds)] : [])));
    const activeContractsCount = contracts.filter((c) => c.status === "active").length;
    const monthlyRecurring = contracts.filter((c) => c.status === "active").reduce((s, c) => s + this.num(c.monthlyRent), 0);

    const payments = await this.db.select({ status: paymentsTable.status, amount: paymentsTable.amount, paidDate: paymentsTable.paidDate, dueDate: paymentsTable.dueDate })
      .from(paymentsTable).where(and(eq(paymentsTable.userId, uid), isNull(paymentsTable.deletedAt),
        ...(scope.contractIds ? [inArray(paymentsTable.contractId, scope.contractIds)] : [])));
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const collectedTotal = payments.filter((p) => p.status === "paid").reduce((s, p) => s + this.num(p.amount), 0);
    const monthlyRevenue = payments.filter((p) => p.status === "paid" && p.paidDate?.startsWith(monthKey)).reduce((s, p) => s + this.num(p.amount), 0);
    const pendingDue = payments.filter((p) => { const st = liveStatus(p.status as string, p.dueDate); return st === "pending" || st === "overdue"; }).reduce((s, p) => s + this.num(p.amount), 0);
    const overduePaymentsCount = payments.filter((p) => liveStatus(p.status as string, p.dueDate) === "overdue").length;

    let tenantsCount: number;
    if (scope.contractIds != null) {
      // Owner scope: only tenants referenced by the owner's contracts.
      tenantsCount = new Set(contracts.map((c) => c.tenantId).filter((x): x is number => x != null)).size;
    } else {
      tenantsCount = (await this.db.select({ id: tenantsTable.id }).from(tenantsTable)
        .where(and(eq(tenantsTable.userId, uid), isNull(tenantsTable.deletedAt)))).length;
    }

    const occDenom = totalUnits > 0 ? totalUnits : unitsCount;
    return {
      propertiesCount: propIds.length, unitsCount, totalUnits, rentedUnits, availableUnits, maintenanceUnits,
      activeContractsCount, tenantsCount,
      monthlyRecurring, collectedTotal, monthlyRevenue, pendingDue, overduePaymentsCount,
      occupancyRate: occDenom > 0 ? Math.min(100, Math.round((rentedUnits / occDenom) * 100)) : 0,
    };
  }

  /** Recent-activity feed for the home screen (newest first): new contracts,
   *  collected payments and maintenance requests, merged + date-sorted. */
  @Get("recent-activity")
  async recentActivity(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    const scope = await this.ownerScope(user);
    type Item = { type: "contract" | "payment" | "maintenance"; title: string; subtitle: string; date: string | null };
    const items: Item[] = [];

    const contracts = await this.db.select({
      contractNumber: contractsTable.contractNumber, tenantName: contractsTable.tenantName, createdAt: contractsTable.createdAt,
    }).from(contractsTable).where(and(eq(contractsTable.userId, uid), isNull(contractsTable.deletedAt),
      ...(scope.contractIds ? [inArray(contractsTable.id, scope.contractIds)] : [])))
      .orderBy(desc(contractsTable.createdAt)).limit(6);
    for (const c of contracts) items.push({
      type: "contract", title: c.tenantName || c.contractNumber || "", subtitle: c.contractNumber || "",
      date: c.createdAt ? new Date(c.createdAt).toISOString() : null,
    });

    // Use updatedAt (a real timestamp, stamped when the payment is marked paid)
    // for the activity time — paidDate is a DATE-only column, so it would read as
    // midnight UTC and show a several-hour skew in the "X ago" label.
    const paid = await this.db.select({ amount: paymentsTable.amount, updatedAt: paymentsTable.updatedAt, contractNumber: contractsTable.contractNumber })
      .from(paymentsTable).leftJoin(contractsTable, eq(contractsTable.id, paymentsTable.contractId))
      .where(and(eq(paymentsTable.userId, uid), eq(paymentsTable.status, "paid"), isNull(paymentsTable.deletedAt),
        ...(scope.contractIds ? [inArray(paymentsTable.contractId, scope.contractIds)] : [])))
      .orderBy(desc(paymentsTable.updatedAt)).limit(6);
    for (const p of paid) items.push({
      type: "payment", title: String(this.num(p.amount)), subtitle: p.contractNumber || "",
      date: p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
    });

    const maint = await this.db.select({ description: maintenanceRequestsTable.description, unitLabel: maintenanceRequestsTable.unitLabel, createdAt: maintenanceRequestsTable.createdAt })
      .from(maintenanceRequestsTable).where(and(eq(maintenanceRequestsTable.userId, uid), isNull(maintenanceRequestsTable.deletedAt),
        ...(scope.contractIds ? [inArray(maintenanceRequestsTable.contractId, scope.contractIds)] : [])))
      .orderBy(desc(maintenanceRequestsTable.createdAt)).limit(6);
    for (const m of maint) items.push({
      type: "maintenance", title: m.description || "", subtitle: m.unitLabel || "",
      date: m.createdAt ? new Date(m.createdAt).toISOString() : null,
    });

    return items.sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 8);
  }

  /** Properties with occupancy. */
  @Get("properties")
  async properties(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    const scope = await this.ownerScope(user);
    const props = await this.db.select().from(propertiesTable)
      .where(and(eq(propertiesTable.userId, uid), isNull(propertiesTable.deletedAt),
        ...(scope.propIds ? [inArray(propertiesTable.id, scope.propIds)] : [])))
      .orderBy(desc(propertiesTable.createdAt));
    const propIds = props.map((p) => p.id);
    const units = propIds.length
      ? await this.db.select({ id: unitsTable.id, propertyId: unitsTable.propertyId, status: unitsTable.status })
          .from(unitsTable).where(and(inArray(unitsTable.propertyId, propIds), isNull(unitsTable.deletedAt)))
      : [];
    const rows = props.map((p) => {
      const us = units.filter((u) => u.propertyId === p.id);
      const rented = us.filter((u) => u.status === "rented").length;
      // Occupancy is rented ÷ the property's declared total units (fall back to
      // the created-unit count only when totalUnits isn't set).
      const totalUnits = Number((p as any).totalUnits) || 0;
      const denom = totalUnits > 0 ? totalUnits : us.length;
      const imgs = (p as any).images;
      const imgKey = (Array.isArray(imgs) && imgs.length ? imgs[0] : null) ?? (p as any).imageKey ?? null;
      return {
        id: p.id, name: p.name, status: (p as any).status ?? null,
        district: (p as any).district ?? null, street: (p as any).street ?? null, deedNumber: (p as any).deedNumber ?? null,
        typeLookupId: (p as any).typeLookupId ?? null, usageLookupId: (p as any).usageLookupId ?? null, cityLookupId: (p as any).cityLookupId ?? null,
        unitsCount: us.length, totalUnits, rentedUnits: rented,
        occupancyRate: denom > 0 ? Math.min(100, Math.round((rented / denom) * 100)) : 0,
        _imgKey: imgKey,
      };
    });
    await attachLookupLabels(this.db, rows as any[], [
      { idField: "typeLookupId", out: "type", mode: "labelAr" },   // badge text, e.g. "عمارة سكنية"
      { idField: "usageLookupId", out: "usage", mode: "key" },     // filter key: residential/commercial/mixed
      { idField: "cityLookupId", out: "city", mode: "labelAr" },
    ]);
    // Sign each property's cover image (first gallery photo) for the card.
    await Promise.all((rows as any[]).map(async (r) => {
      r.imageUrl = await this.sign(typeof r._imgKey === "string" ? r._imgKey : r._imgKey?.key);
      delete r._imgKey;
    }));
    return rows;
  }

  /** Units across the portfolio (with full specs + the current tenant). */
  @Get("units")
  async units(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    const scope = await this.ownerScope(user);
    const rows = await this.db
      .select({
        id: unitsTable.id, unitNumber: unitsTable.unitNumber, status: unitsTable.status,
        propertyId: unitsTable.propertyId, propertyName: propertiesTable.name,
        rentPrice: unitsTable.rentPrice, area: unitsTable.area, floor: unitsTable.floor,
        bedrooms: unitsTable.bedrooms, bathrooms: unitsTable.bathrooms, typeLookupId: unitsTable.typeLookupId,
      })
      .from(unitsTable)
      .innerJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
      .where(and(eq(propertiesTable.userId, uid), isNull(unitsTable.deletedAt), isNull(propertiesTable.deletedAt),
        ...(scope.propIds ? [inArray(unitsTable.propertyId, scope.propIds)] : [])))
      .orderBy(desc(unitsTable.createdAt));
    // Current tenant per unit (via the active contract).
    const unitIds = rows.map((r) => r.id);
    const cu = unitIds.length
      ? await this.db.select({ unitId: contractUnitsTable.unitId, tenantName: contractsTable.tenantName })
          .from(contractUnitsTable)
          .innerJoin(contractsTable, eq(contractsTable.id, contractUnitsTable.contractId))
          .where(and(inArray(contractUnitsTable.unitId, unitIds), eq(contractsTable.status, "active"), isNull(contractsTable.deletedAt)))
      : [];
    const tenantByUnit = new Map<number, string>();
    for (const r of cu) if (r.tenantName) tenantByUnit.set(r.unitId, r.tenantName);
    const out = rows.map((r) => ({
      ...r, rentPrice: r.rentPrice != null ? this.num(r.rentPrice) : null,
      tenantName: tenantByUnit.get(r.id) ?? null,
    }));
    await attachLookupLabels(this.db, out as any[], [{ idField: "typeLookupId", out: "type", mode: "labelAr" }]);
    return out;
  }

  /** Active + past contracts, each with its property + units + tenant. */
  @Get("contracts")
  async contracts(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    const scope = await this.ownerScope(user);
    const contracts = await this.db.select().from(contractsTable)
      .where(and(eq(contractsTable.userId, uid), isNull(contractsTable.deletedAt),
        ...(scope.contractIds ? [inArray(contractsTable.id, scope.contractIds)] : [])))
      .orderBy(desc(contractsTable.createdAt));
    const ids = contracts.map((c) => c.id);
    const cu = ids.length
      ? await this.db.select({ contractId: contractUnitsTable.contractId, unitNumber: unitsTable.unitNumber, propertyName: propertiesTable.name })
          .from(contractUnitsTable)
          .innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
          .innerJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
          .where(inArray(contractUnitsTable.contractId, ids))
      : [];
    const byContract = new Map<number, { property: string | null; units: string[] }>();
    for (const r of cu) {
      const e = byContract.get(r.contractId) ?? { property: r.propertyName, units: [] };
      if (r.unitNumber) e.units.push(r.unitNumber);
      e.property = e.property ?? r.propertyName;
      byContract.set(r.contractId, e);
    }
    return contracts.map((c) => ({
      id: c.id, contractNumber: c.contractNumber, status: c.status,
      tenantName: c.tenantName, tenantPhone: c.tenantPhone,
      monthlyRent: this.num(c.monthlyRent), paymentFrequency: c.paymentFrequency,
      startDate: c.startDate, endDate: c.endDate,
      depositAmount: c.depositAmount ? this.num(c.depositAmount) : 0,
      property: byContract.get(c.id)?.property ?? null,
      units: byContract.get(c.id)?.units ?? [],
      landlordName: c.landlordName ?? null,
    }));
  }

  /** Tenants in the portfolio — with contract count and the
   *  linked property/unit from their active (or latest) contract. */
  @Get("tenants")
  async tenants(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    const scope = await this.ownerScope(user);

    // Contracts (with first property/unit) grouped by the tenant's phone.
    const contracts = await this.db.select({ id: contractsTable.id, tenantId: contractsTable.tenantId, tenantPhone: contractsTable.tenantPhone, status: contractsTable.status })
      .from(contractsTable).where(and(eq(contractsTable.userId, uid), isNull(contractsTable.deletedAt),
        ...(scope.contractIds ? [inArray(contractsTable.id, scope.contractIds)] : [])));

    // Owner scope: only tenants referenced by the owner's contracts.
    const tenantIds = scope.contractIds != null
      ? [...new Set(contracts.map((c) => c.tenantId).filter((x): x is number => x != null))]
      : null;
    const tenants = await this.db.select({
      id: tenantsTable.id, name: tenantsTable.name, phone: tenantsTable.phone, email: tenantsTable.email,
      type: tenantsTable.type, status: tenantsTable.status,
    }).from(tenantsTable).where(and(eq(tenantsTable.userId, uid), isNull(tenantsTable.deletedAt),
      ...(tenantIds ? [inArray(tenantsTable.id, tenantIds)] : [])))
      .orderBy(desc(tenantsTable.createdAt));
    const cids = contracts.map((c) => c.id);
    const cu = cids.length
      ? await this.db.select({ contractId: contractUnitsTable.contractId, unitNumber: unitsTable.unitNumber, propertyName: propertiesTable.name })
          .from(contractUnitsTable)
          .innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
          .innerJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
          .where(inArray(contractUnitsTable.contractId, cids))
      : [];
    const firstUnitOf = new Map<number, { unitNumber: string | null; propertyName: string | null }>();
    for (const r of cu) if (!firstUnitOf.has(r.contractId)) firstUnitOf.set(r.contractId, { unitNumber: r.unitNumber, propertyName: r.propertyName });

    const byPhone = new Map<string, { count: number; active: typeof contracts }>();
    for (const c of contracts) {
      const key = (c.tenantPhone || "").replace(/\D/g, "").slice(-9);
      if (!key) continue;
      const e = byPhone.get(key) ?? { count: 0, active: [] };
      e.count += 1; e.active.push(c); byPhone.set(key, e);
    }
    return tenants.map((t) => {
      const key = (t.phone || "").replace(/\D/g, "").slice(-9);
      const grp = key ? byPhone.get(key) : undefined;
      const chosen = grp?.active.find((c) => c.status === "active") ?? grp?.active[0];
      const link = chosen ? firstUnitOf.get(chosen.id) : undefined;
      return {
        ...t, contractsCount: grp?.count ?? 0,
        contractStatus: chosen?.status ?? null,
        property: link?.propertyName ?? null, unitNumber: link?.unitNumber ?? null,
      };
    });
  }

  /** The landlords (owners) held by this account — with each one's property +
   *  unit counts and collected revenue. */
  @Get("owners")
  async owners(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    const owners = await this.db.select({ id: ownersTable.id, name: ownersTable.name, phone: ownersTable.phone, email: ownersTable.email, type: ownersTable.type, status: ownersTable.status, taxNumber: ownersTable.taxNumber, iban: ownersTable.iban, isDefault: ownersTable.isDefault })
      .from(ownersTable).where(and(eq(ownersTable.userId, uid), isNull(ownersTable.deletedAt),
        ...(user.ownerScopeId != null ? [eq(ownersTable.id, user.ownerScopeId)] : [])))
      .orderBy(desc(ownersTable.createdAt));

    // Properties (with unit counts) grouped by ownerId.
    const props = await this.db.select({ id: propertiesTable.id, ownerId: propertiesTable.ownerId })
      .from(propertiesTable).where(and(eq(propertiesTable.userId, uid), isNull(propertiesTable.deletedAt),
        ...(user.ownerScopeId != null ? [eq(propertiesTable.ownerId, user.ownerScopeId)] : [])));
    const propIds = props.map((p) => p.id);
    const units = propIds.length
      ? await this.db.select({ propertyId: unitsTable.propertyId }).from(unitsTable)
          .where(and(inArray(unitsTable.propertyId, propIds), isNull(unitsTable.deletedAt)))
      : [];
    const unitsByProp = new Map<number, number>();
    for (const u of units) unitsByProp.set(u.propertyId, (unitsByProp.get(u.propertyId) ?? 0) + 1);

    return owners.map((o) => {
      const myProps = props.filter((p) => p.ownerId === o.id);
      const unitsCount = myProps.reduce((s, p) => s + (unitsByProp.get(p.id) ?? 0), 0);
      return { ...o, propertiesCount: myProps.length, unitsCount };
    });
  }

  /** One landlord's FULL detail + their properties + contracts (read-only). */
  @Get("owners/:id")
  async owner(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const uid = scopeId(user);
    const oid = parseInt(id, 10);
    if (user.ownerScopeId != null && oid !== user.ownerScopeId) throw new NotFoundException("Landlord not found");
    const [o] = await this.db.select().from(ownersTable)
      .where(and(eq(ownersTable.id, oid), eq(ownersTable.userId, uid), isNull(ownersTable.deletedAt)));
    if (!o) throw new NotFoundException("Landlord not found");
    const properties = await this.db.select({ id: propertiesTable.id, name: propertiesTable.name, district: propertiesTable.district })
      .from(propertiesTable).where(and(eq(propertiesTable.ownerId, oid), eq(propertiesTable.userId, uid), isNull(propertiesTable.deletedAt)));
    const propIds = properties.map((p) => p.id);
    const units = propIds.length
      ? await this.db.select({ propertyId: unitsTable.propertyId }).from(unitsTable)
          .where(and(inArray(unitsTable.propertyId, propIds), isNull(unitsTable.deletedAt)))
      : [];
    const unitsByProp = new Map<number, number>();
    for (const u of units) unitsByProp.set(u.propertyId, (unitsByProp.get(u.propertyId) ?? 0) + 1);
    // Contracts whose landlord matches this owner (by name/id snapshot).
    const contracts = await this.db.select({
      id: contractsTable.id, contractNumber: contractsTable.contractNumber, status: contractsTable.status,
      tenantName: contractsTable.tenantName, monthlyRent: contractsTable.monthlyRent,
      startDate: contractsTable.startDate, endDate: contractsTable.endDate,
      landlordName: contractsTable.landlordName, landlordIdNumber: contractsTable.landlordIdNumber,
    }).from(contractsTable).where(and(eq(contractsTable.userId, uid), isNull(contractsTable.deletedAt)));
    const mine = contracts.filter((c) =>
      (o.idNumber && c.landlordIdNumber && c.landlordIdNumber === o.idNumber) ||
      (o.name && c.landlordName === o.name));
    return {
      ...o,
      representativeDocUrl: await this.sign((o as any).representativeDocUrl),
      properties: properties.map((p) => ({ ...p, unitsCount: unitsByProp.get(p.id) ?? 0 })),
      contracts: mine.map((c) => ({ id: c.id, contractNumber: c.contractNumber, status: c.status, tenantName: c.tenantName, monthlyRent: this.num(c.monthlyRent), startDate: c.startDate, endDate: c.endDate })),
    };
  }

  /** Payment schedule across the portfolio + a small summary. */
  @Get("payments")
  async payments(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    const scope = await this.ownerScope(user);
    const rows = await this.db
      .select({
        id: paymentsTable.id, amount: paymentsTable.amount, dueDate: paymentsTable.dueDate,
        paidDate: paymentsTable.paidDate, status: paymentsTable.status,
        receiptNumber: paymentsTable.receiptNumber, description: paymentsTable.description,
        contractId: paymentsTable.contractId,
        contractNumber: contractsTable.contractNumber, tenantName: contractsTable.tenantName,
      })
      .from(paymentsTable)
      .leftJoin(contractsTable, eq(contractsTable.id, paymentsTable.contractId))
      .where(and(eq(paymentsTable.userId, uid), isNull(paymentsTable.deletedAt),
        ...(scope.contractIds ? [inArray(paymentsTable.contractId, scope.contractIds)] : [])))
      .orderBy(desc(paymentsTable.dueDate));

    // Full collection log per payment — each collection with its evidence
    // (proof) attachment resolved to a signed URL, so the app shows the log.
    const ids = rows.map((r) => r.id);
    const coll = ids.length
      ? await this.db.select({
          paymentId: paymentCollectionsTable.paymentId, amount: paymentCollectionsTable.amount,
          collectedDate: paymentCollectionsTable.collectedDate, method: paymentCollectionsTable.method,
          receiptNumber: paymentCollectionsTable.receiptNumber, attachmentKey: paymentCollectionsTable.attachmentKey,
        }).from(paymentCollectionsTable).where(inArray(paymentCollectionsTable.paymentId, ids))
          .orderBy(desc(paymentCollectionsTable.collectedDate))
      : [];
    const receiptsByPayment = new Map<number, any[]>();
    const collMap = new Map<number, number>();
    for (const c of coll) {
      if (c.paymentId == null) continue;
      collMap.set(c.paymentId, (collMap.get(c.paymentId) ?? 0) + this.num(c.amount));
      const list = receiptsByPayment.get(c.paymentId) ?? [];
      list.push({ amount: this.num(c.amount), collectedDate: c.collectedDate, method: c.method, receiptNumber: c.receiptNumber, proofUrl: await this.sign(c.attachmentKey) });
      receiptsByPayment.set(c.paymentId, list);
    }

    // Derive the live status from what's actually been collected (+ due date),
    // so a settled installment never lingers as "overdue" because a collection
    // didn't stamp the row. Stored paid/cancelled/settled are kept as-is.
    const today = new Date().toISOString().slice(0, 10);
    const data = rows.map((r) => {
      const amount = this.num(r.amount);
      const collected = Math.round((collMap.get(r.id) ?? 0) * 100) / 100;
      let status = r.status as string;
      if (status !== "paid" && status !== "cancelled" && status !== "settled_external") {
        if (amount > 0 && collected >= amount - 0.01) status = "paid";
        else if (collected > 0.01) status = "partially_paid";
        else status = r.dueDate && r.dueDate < today ? "overdue" : "pending";
      }
      return {
        id: r.id, amount, dueDate: r.dueDate, paidDate: r.paidDate,
        status, receiptNumber: r.receiptNumber, description: r.description,
        contractNumber: r.contractNumber, tenantName: r.tenantName,
        collectedAmount: collected,
        receipts: receiptsByPayment.get(r.id) ?? [],
      };
    });
    const summary = {
      paid: data.filter((d) => d.status === "paid").reduce((s, d) => s + d.amount, 0),
      pending: data.filter((d) => d.status === "pending").reduce((s, d) => s + d.amount, 0),
      overdue: data.filter((d) => d.status === "overdue").reduce((s, d) => s + d.amount, 0),
      overdueCount: data.filter((d) => d.status === "overdue").length,
    };
    return { data, summary };
  }

  /** Issued tax invoices + receipt vouchers for the account (ZATCA-style). */
  @Get("invoices")
  async invoices(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    const scope = await this.ownerScope(user);
    const rows = await this.db.select().from(simpleInvoicesTable)
      .where(and(
        eq(simpleInvoicesTable.userId, uid),
        eq(simpleInvoicesTable.status, "confirmed"),
        isNull(simpleInvoicesTable.deletedAt),
        ...(scope.contractIds ? [inArray(simpleInvoicesTable.contractId, scope.contractIds)] : []),
      ))
      .orderBy(desc(simpleInvoicesTable.issueDate), desc(simpleInvoicesTable.id)).limit(300);
    if (!rows.length) return [];

    const account = await this.accountSeller(uid);
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const pick = (...v: (string | null | undefined)[]) => v.find((x) => x && String(x).trim()) ?? null;

    // Batch-load the supporting records so seller/buyer can be enriched with the
    // same fallback chain the web uses (no N+1).
    const contractIds = [...new Set(rows.map((r) => r.contractId).filter((x): x is number => x != null))];
    const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter((x): x is number => x != null))];
    const contractsById = new Map<number, any>();
    if (contractIds.length) {
      const cs = await this.db.select({
        id: contractsTable.id, tenantName: contractsTable.tenantName, tenantPhone: contractsTable.tenantPhone,
        tenantTaxNumber: contractsTable.tenantTaxNumber, tenantAddress: contractsTable.tenantAddress,
        landlordName: contractsTable.landlordName, landlordIdNumber: contractsTable.landlordIdNumber,
        landlordPhone: contractsTable.landlordPhone, landlordEmail: contractsTable.landlordEmail,
        landlordTaxNumber: contractsTable.landlordTaxNumber, landlordAddress: contractsTable.landlordAddress,
      }).from(contractsTable).where(and(eq(contractsTable.userId, uid), inArray(contractsTable.id, contractIds)));
      for (const c of cs) contractsById.set(c.id, c);
    }
    const tenantsById = new Map<number, any>();
    if (tenantIds.length) {
      const ts = await this.db.select({
        id: tenantsTable.id, name: tenantsTable.name, taxNumber: tenantsTable.taxNumber,
        phone: tenantsTable.phone, email: tenantsTable.email, address: tenantsTable.address,
      }).from(tenantsTable).where(and(eq(tenantsTable.userId, uid), inArray(tenantsTable.id, tenantIds)));
      for (const t of ts) tenantsById.set(t.id, t);
    }
    const owners = await this.db.select({
      name: ownersTable.name, idNumber: ownersTable.idNumber, taxNumber: ownersTable.taxNumber,
      phone: ownersTable.phone, email: ownersTable.email, address: ownersTable.address,
    }).from(ownersTable).where(and(eq(ownersTable.userId, uid), isNull(ownersTable.deletedAt)));

    return Promise.all(rows.map(async (r) => {
      const subtotal = this.num(r.subtotal), total = this.num(r.total), vat = round2(total - subtotal);
      const isVoucher = r.kind === "receipt" || r.kind === "deposit";
      const isCommission = r.kind === "commission";
      const contract = r.contractId != null ? contractsById.get(r.contractId) : null;
      const tenant = r.tenantId != null ? tenantsById.get(r.tenantId) : null;

      // Seller: commission → the account; rent/fee → the contract's landlord
      // enriched per-field from the matched owner record, falling back to the
      // account. Mirrors the web's seller binding.
      let seller = account.seller;
      if (!isCommission && contract) {
        const owner = owners.find((o) =>
          (contract.landlordIdNumber && o.idNumber && o.idNumber === contract.landlordIdNumber) ||
          (contract.landlordName && o.name === contract.landlordName));
        seller = {
          name: pick(contract.landlordName, owner?.name, account.seller.name),
          vatNumber: pick(contract.landlordTaxNumber, owner?.taxNumber, account.seller.vatNumber),
          phone: pick(contract.landlordPhone, owner?.phone, account.seller.phone),
          email: pick(contract.landlordEmail, owner?.email, account.seller.email),
          address: pick(contract.landlordAddress, owner?.address, account.seller.address),
        };
      }

      // Buyer: the invoice client snapshot, then the live tenant, then the
      // contract snapshot — so VAT / phone / address are never wrongly null.
      const buyerVat = pick((r.client as any)?.vatNumber, tenant?.taxNumber, contract?.tenantTaxNumber);
      const buyer = {
        name: pick(r.tenantName, tenant?.name, contract?.tenantName),
        vatNumber: buyerVat,
        phone: pick((r.client as any)?.phone, tenant?.phone, contract?.tenantPhone),
        email: pick((r.client as any)?.email, tenant?.email),
        address: pick((r.client as any)?.address, tenant?.address, contract?.tenantAddress),
      };

      const qrSvg = !isVoucher && vat > 0.01
        ? invoiceQrSvg({ sellerName: seller.name ?? "", vatNumber: seller.vatNumber ?? "", issueDate: r.issueDate, totalWithVat: total, vatTotal: vat })
        : null;
      return {
        id: r.id, number: r.number, type: r.type, kind: r.kind, isVoucher, buyerHasVat: !!buyerVat,
        buyerName: buyer.name,
        seller, buyer,
        subtotal, total, vat, status: r.status,
        issueDate: r.issueDate, dueDate: r.dueDate, paidDate: r.paidDate,
        receiptNumber: r.receiptNumber, paymentMethod: r.paymentMethod, billingReference: r.billingReference,
        notes: r.notes, items: r.items ?? [],
        qrSvg, attachmentUrl: await this.sign(r.attachmentKey),
      };
    }));
  }

  /** Seller identity for the account's documents: company → default landlord
   *  owner → the user's own profile (matches the web's fallback chain). */
  private async accountSeller(uid: number) {
    const [u] = await this.db.select({ companyId: usersTable.companyId, name: usersTable.name, email: usersTable.email, phone: usersTable.phone })
      .from(usersTable).where(eq(usersTable.id, uid));
    const [owner] = await this.db.select().from(ownersTable)
      .where(and(eq(ownersTable.userId, uid), eq(ownersTable.isDefault, true), isNull(ownersTable.deletedAt))).limit(1);
    let co: typeof companiesTable.$inferSelect | undefined;
    if (u?.companyId) [co] = await this.db.select().from(companiesTable).where(eq(companiesTable.id, u.companyId));
    const pick = (...v: (string | null | undefined)[]) => v.find((x) => x && String(x).trim()) ?? null;
    const companyAddress = co ? [(co as any).address, (co as any).district, (co as any).city].filter(Boolean).join("، ") || null : null;
    const seller = {
      name: pick(co?.name, owner?.name, u?.name),
      vatNumber: pick(co?.vatNumber, (owner as any)?.taxNumber),
      phone: pick((co as any)?.companyPhone, (owner as any)?.phone, u?.phone),
      email: pick((co as any)?.officialEmail, (owner as any)?.email, u?.email),
      address: pick(companyAddress, (owner as any)?.address),
    };
    return { seller, sellerName: seller.name, sellerVat: seller.vatNumber };
  }

  /** Return a short-lived signed URL to the PDF the web generated + stored on
   *  this invoice/voucher (pixel-identical to what the web prints). The web
   *  uploads it when the document is approved / the voucher is created; until
   *  then `url` is null and the app shows "not generated yet". */
  @Get("invoices/:id/pdf")
  async invoicePdf(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const uid = scopeId(user);
    const scope = await this.ownerScope(user);
    const [r] = await this.db.select({ id: simpleInvoicesTable.id, pdfKey: simpleInvoicesTable.pdfKey }).from(simpleInvoicesTable)
      .where(and(eq(simpleInvoicesTable.id, parseInt(id, 10)), eq(simpleInvoicesTable.userId, uid), isNull(simpleInvoicesTable.deletedAt),
        ...(scope.contractIds ? [inArray(simpleInvoicesTable.contractId, scope.contractIds)] : [])));
    if (!r) throw new NotFoundException("Invoice not found");
    const key = (r as any).pdfKey as string | null;
    return { url: key ? await this.sign(key) : null, pdfKey: key ?? null };
  }

  /** Reports: headline stats, a 6-month collected-vs-expected series, and
   *  per-property performance (collected revenue + occupancy). */
  @Get("reports")
  async reports(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    const scope = await this.ownerScope(user);
    const props = await this.db.select({ id: propertiesTable.id, name: propertiesTable.name, totalUnits: propertiesTable.totalUnits })
      .from(propertiesTable).where(and(eq(propertiesTable.userId, uid), isNull(propertiesTable.deletedAt),
        ...(scope.propIds ? [inArray(propertiesTable.id, scope.propIds)] : [])));
    const propIds = props.map((p) => p.id);
    const units = propIds.length
      ? await this.db.select({ propertyId: unitsTable.propertyId, status: unitsTable.status })
          .from(unitsTable).where(and(inArray(unitsTable.propertyId, propIds), isNull(unitsTable.deletedAt)))
      : [];
    const unitsCount = units.length;
    const rented = units.filter((u) => u.status === "rented").length;

    const contracts = await this.db.select({ status: contractsTable.status, monthlyRent: contractsTable.monthlyRent })
      .from(contractsTable).where(and(eq(contractsTable.userId, uid), isNull(contractsTable.deletedAt),
        ...(scope.contractIds ? [inArray(contractsTable.id, scope.contractIds)] : [])));
    const monthlyRecurring = contracts.filter((c) => c.status === "active").reduce((s, c) => s + this.num(c.monthlyRent), 0);

    const payments = await this.db.select({ amount: paymentsTable.amount, dueDate: paymentsTable.dueDate, paidDate: paymentsTable.paidDate, status: paymentsTable.status, contractId: paymentsTable.contractId })
      .from(paymentsTable).where(and(eq(paymentsTable.userId, uid), isNull(paymentsTable.deletedAt),
        ...(scope.contractIds ? [inArray(paymentsTable.contractId, scope.contractIds)] : [])));

    // contract → property
    const cIds = [...new Set(payments.map((p) => p.contractId).filter((x): x is number => !!x))];
    const cu = cIds.length
      ? await this.db.select({ contractId: contractUnitsTable.contractId, propertyId: propertiesTable.id })
          .from(contractUnitsTable).innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
          .innerJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
          .where(inArray(contractUnitsTable.contractId, cIds))
      : [];
    const propByContract = new Map<number, number>();
    for (const r of cu) if (!propByContract.has(r.contractId)) propByContract.set(r.contractId, r.propertyId);

    // 6-month series
    const months: string[] = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }
    const idx = new Map(months.map((m, i) => [m, i]));
    const monthlySeries = months.map((m) => ({ month: m, collected: 0, expected: 0 }));
    for (const p of payments) {
      const due = (p.dueDate || "").slice(0, 7); const paid = (p.paidDate || "").slice(0, 7);
      if (idx.has(due)) monthlySeries[idx.get(due)!].expected += this.num(p.amount);
      if (p.status === "paid" && idx.has(paid)) monthlySeries[idx.get(paid)!].collected += this.num(p.amount);
    }

    const collectedByProp = new Map<number, number>();
    for (const p of payments) {
      if (p.status !== "paid" || !p.contractId) continue;
      const pid = propByContract.get(p.contractId); if (pid == null) continue;
      collectedByProp.set(pid, (collectedByProp.get(pid) ?? 0) + this.num(p.amount));
    }
    const propertyPerformance = props.map((p) => {
      const us = units.filter((u) => u.propertyId === p.id);
      const denom = Number((p as any).totalUnits) || us.length;
      const occ = denom > 0 ? Math.min(100, Math.round((us.filter((u) => u.status === "rented").length / denom) * 100)) : 0;
      return { name: p.name, collected: Math.round(collectedByProp.get(p.id) ?? 0), occupancy: occ };
    }).sort((a, b) => b.collected - a.collected).slice(0, 8);

    const collectedTotal = payments.filter((p) => p.status === "paid").reduce((s, p) => s + this.num(p.amount), 0);
    const expectedTotal = payments.reduce((s, p) => s + this.num(p.amount), 0);
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const monthlyRevenue = payments.filter((p) => p.status === "paid" && p.paidDate?.startsWith(monthKey)).reduce((s, p) => s + this.num(p.amount), 0);

    return {
      occupancyRate: unitsCount ? Math.round((rented / unitsCount) * 100) : 0,
      monthlyRevenue, collectedTotal, expectedTotal,
      avgRent: rented ? Math.round(monthlyRecurring / rented) : 0,
      collectionRate: expectedTotal > 0 ? Math.round((collectedTotal / expectedTotal) * 100) : 0,
      monthlySeries, propertyPerformance,
    };
  }

  /** Maintenance requests across the portfolio (view-only). */
  @Get("maintenance")
  async maintenance(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    const scope = await this.ownerScope(user);
    const rows = await this.db.select({
      id: maintenanceRequestsTable.id, unitLabel: maintenanceRequestsTable.unitLabel,
      description: maintenanceRequestsTable.description, priority: maintenanceRequestsTable.priority,
      status: maintenanceRequestsTable.status, supplier: maintenanceRequestsTable.supplier,
      estimatedCost: maintenanceRequestsTable.estimatedCost, createdAt: maintenanceRequestsTable.createdAt,
      tenantName: tenantsTable.name, contractNumber: contractsTable.contractNumber,
    }).from(maintenanceRequestsTable)
      .leftJoin(tenantsTable, eq(tenantsTable.id, maintenanceRequestsTable.tenantId))
      .leftJoin(contractsTable, eq(contractsTable.id, maintenanceRequestsTable.contractId))
      .where(and(eq(maintenanceRequestsTable.userId, uid), isNull(maintenanceRequestsTable.deletedAt),
        ...(scope.contractIds ? [inArray(maintenanceRequestsTable.contractId, scope.contractIds)] : [])))
      .orderBy(desc(maintenanceRequestsTable.createdAt));
    return rows.map((r) => ({ ...r, estimatedCost: r.estimatedCost != null ? this.num(r.estimatedCost) : null }));
  }

  /** Collections (money actually received). */
  @Get("collections")
  async collections(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    const scope = await this.ownerScope(user);
    return this.db
      .select({
        id: paymentCollectionsTable.id, amount: paymentCollectionsTable.amount,
        collectedDate: paymentCollectionsTable.collectedDate, method: paymentCollectionsTable.method,
        receiptNumber: paymentCollectionsTable.receiptNumber,
        contractNumber: contractsTable.contractNumber, tenantName: contractsTable.tenantName,
      })
      .from(paymentCollectionsTable)
      .leftJoin(paymentsTable, eq(paymentsTable.id, paymentCollectionsTable.paymentId))
      .leftJoin(contractsTable, eq(contractsTable.id, paymentsTable.contractId))
      .where(and(eq(paymentCollectionsTable.userId, uid),
        ...(scope.contractIds ? [inArray(paymentsTable.contractId, scope.contractIds)] : [])))
      .orderBy(desc(paymentCollectionsTable.collectedDate))
      .limit(200);
  }

  /** One property's FULL detail + its units + active contracts. */
  @Get("properties/:id")
  async property(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const uid = scopeId(user);
    const pid = parseInt(id, 10);
    const [p] = await this.db.select().from(propertiesTable)
      .where(and(eq(propertiesTable.id, pid), eq(propertiesTable.userId, uid), isNull(propertiesTable.deletedAt),
        ...(user.ownerScopeId != null ? [eq(propertiesTable.ownerId, user.ownerScopeId)] : [])));
    if (!p) throw new NotFoundException("Property not found");
    const units = await this.db.select().from(unitsTable)
      .where(and(eq(unitsTable.propertyId, pid), isNull(unitsTable.deletedAt))).orderBy(unitsTable.unitNumber);
    const unitIds = units.map((u) => u.id);
    const contracts = unitIds.length
      ? await this.db.selectDistinct({
          id: contractsTable.id, contractNumber: contractsTable.contractNumber, status: contractsTable.status,
          tenantName: contractsTable.tenantName, monthlyRent: contractsTable.monthlyRent,
          startDate: contractsTable.startDate, endDate: contractsTable.endDate,
        })
        .from(contractUnitsTable).innerJoin(contractsTable, eq(contractsTable.id, contractUnitsTable.contractId))
        .where(and(inArray(contractUnitsTable.unitId, unitIds), isNull(contractsTable.deletedAt)))
      : [];
    // Title deed (صك) for the property, if linked.
    let deed: any = null;
    if (p.deedId) {
      const [d] = await this.db.select().from(deedsTable)
        .where(and(eq(deedsTable.id, p.deedId), isNull(deedsTable.deletedAt)));
      if (d) deed = { ...d, documentUrl: await this.sign(d.documentUrl) };
    }
    // Financial summary across the property's contracts.
    const cIds = contracts.map((c) => c.id);
    const pays = cIds.length
      ? await this.db.select({ amount: paymentsTable.amount, status: paymentsTable.status, dueDate: paymentsTable.dueDate })
          .from(paymentsTable).where(and(inArray(paymentsTable.contractId, cIds), isNull(paymentsTable.deletedAt)))
      : [];
    // Derived, not stored — nothing ever writes 'overdue', so reading the
    // stored column reported every property/unit as having none.
    const finance = {
      collected: pays.filter((x) => x.status === "paid").reduce((s, x) => s + this.num(x.amount), 0),
      outstanding: pays.filter((x) => { const st = liveStatus(x.status as string, x.dueDate); return st === "pending" || st === "overdue"; }).reduce((s, x) => s + this.num(x.amount), 0),
      overdue: pays.filter((x) => liveStatus(x.status as string, x.dueDate) === "overdue").reduce((s, x) => s + this.num(x.amount), 0),
    };
    const result: any = {
      ...p,
      imageUrl: await this.sign((p as any).imageKey),
      // Sign the full photo gallery so the app can show every property image.
      imageUrls: (await Promise.all((Array.isArray((p as any).images) ? (p as any).images : [])
        .map((k: any) => this.sign(typeof k === "string" ? k : k?.key)))).filter(Boolean),
      deed,
      occupancyRate: (() => {
        const rented = units.filter((u) => u.status === "rented").length;
        const denom = Number((p as any).totalUnits) || units.length;
        return denom > 0 ? Math.min(100, Math.round((rented / denom) * 100)) : 0;
      })(),
      rentedUnits: units.filter((u) => u.status === "rented").length,
      availableUnits: units.filter((u) => u.status === "available").length,
      units: units.map((u) => ({ ...u, rentPrice: u.rentPrice ? this.num(u.rentPrice) : null, area: u.area ? this.num(u.area) : null })),
      contracts: contracts.map((c) => ({ ...c, monthlyRent: this.num(c.monthlyRent) })),
      finance,
    };
    // Resolve lookup labels (type/usage/region/city) so the app shows words, not IDs.
    await attachLookupLabels(this.db, [result], [
      { idField: "typeLookupId", out: "type", mode: "labelAr" },
      { idField: "usageLookupId", out: "usage", mode: "labelAr" },
      { idField: "regionLookupId", out: "region", mode: "labelAr" },
      { idField: "cityLookupId", out: "city", mode: "labelAr" },
    ]);
    return result;
  }

  /** One unit's FULL detail + its current active contract/tenant. */
  @Get("units/:id")
  async unit(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const uid = scopeId(user);
    const unitId = parseInt(id, 10);
    const [row] = await this.db
      .select({ unit: unitsTable, propertyName: propertiesTable.name, propertyId: propertiesTable.id, propertyUsageLookupId: propertiesTable.usageLookupId })
      .from(unitsTable).innerJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
      .where(and(eq(unitsTable.id, unitId), eq(propertiesTable.userId, uid), isNull(unitsTable.deletedAt),
        ...(user.ownerScopeId != null ? [eq(propertiesTable.ownerId, user.ownerScopeId)] : [])));
    if (!row) throw new NotFoundException("Unit not found");
    const [cu] = await this.db
      .select({ id: contractsTable.id, contractNumber: contractsTable.contractNumber, status: contractsTable.status,
        tenantName: contractsTable.tenantName, tenantPhone: contractsTable.tenantPhone,
        monthlyRent: contractsTable.monthlyRent, startDate: contractsTable.startDate, endDate: contractsTable.endDate })
      .from(contractUnitsTable).innerJoin(contractsTable, eq(contractsTable.id, contractUnitsTable.contractId))
      .where(and(eq(contractUnitsTable.unitId, unitId), eq(contractsTable.status, "active"), isNull(contractsTable.deletedAt)))
      .limit(1);
    const u = row.unit;
    // All contracts that ever covered this unit (not just the active one).
    const allContracts = await this.db.selectDistinct({
      id: contractsTable.id, contractNumber: contractsTable.contractNumber, status: contractsTable.status,
      tenantName: contractsTable.tenantName, monthlyRent: contractsTable.monthlyRent,
      startDate: contractsTable.startDate, endDate: contractsTable.endDate,
    }).from(contractUnitsTable).innerJoin(contractsTable, eq(contractsTable.id, contractUnitsTable.contractId))
      .where(and(eq(contractUnitsTable.unitId, unitId), isNull(contractsTable.deletedAt)));
    // Financial summary for this unit (across its contracts).
    const cIds = allContracts.map((c) => c.id);
    const pays = cIds.length
      ? await this.db.select({ amount: paymentsTable.amount, status: paymentsTable.status, dueDate: paymentsTable.dueDate })
          .from(paymentsTable).where(and(inArray(paymentsTable.contractId, cIds), isNull(paymentsTable.deletedAt)))
      : [];
    // Derived, not stored — nothing ever writes 'overdue', so reading the
    // stored column reported every property/unit as having none.
    const finance = {
      collected: pays.filter((x) => x.status === "paid").reduce((s, x) => s + this.num(x.amount), 0),
      outstanding: pays.filter((x) => { const st = liveStatus(x.status as string, x.dueDate); return st === "pending" || st === "overdue"; }).reduce((s, x) => s + this.num(x.amount), 0),
      overdue: pays.filter((x) => liveStatus(x.status as string, x.dueDate) === "overdue").reduce((s, x) => s + this.num(x.amount), 0),
    };
    // Sign each attached document.
    const docs = Array.isArray((u as any).documents) ? (u as any).documents : [];
    const documents = await Promise.all(docs.map(async (d: any) => ({ ...d, url: await this.sign(d.key) })));
    const { fiber: _fiber, directionLookupId: _directionLookupId, ...uRest } = u as any;
    const result: any = {
      ...uRest,
      rentPrice: u.rentPrice ? this.num(u.rentPrice) : null, area: u.area ? this.num(u.area) : null,
      imageUrl: await this.sign((u as any).imageKey), floorPlanUrl: await this.sign((u as any).floorPlanKey),
      // Sign the full photo gallery so the app can show every unit image.
      imageUrls: (await Promise.all((Array.isArray((u as any).images) ? (u as any).images : [])
        .map((k: any) => this.sign(typeof k === "string" ? k : k?.key)))).filter(Boolean),
      documents,
      property: row.propertyName, propertyId: row.propertyId,
      // Usage is a property-level attribute — surface the parent property's usage.
      propertyUsageLookupId: row.propertyUsageLookupId,
      currentContract: cu ? { ...cu, monthlyRent: this.num(cu.monthlyRent) } : null,
      contracts: allContracts.map((c) => ({ ...c, monthlyRent: this.num(c.monthlyRent) })),
      finance,
    };
    // Rent: the unit's own listed rent, falling back to its active contract.
    if (result.rentPrice == null && cu) result.rentPrice = this.num(cu.monthlyRent);
    await attachLookupLabels(this.db, [result], [
      { idField: "typeLookupId", out: "type", mode: "labelAr" },
      { idField: "finishingLookupId", out: "finishing", mode: "labelAr" },
      { idField: "propertyUsageLookupId", out: "usage", mode: "labelAr" },
    ]);
    return result;
  }

  /** One tenant's full detail + their contracts (read-only). */
  @Get("tenants/:id")
  async tenant(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const uid = scopeId(user);
    const scope = await this.ownerScope(user);
    const tid = parseInt(id, 10);
    const [t] = await this.db.select().from(tenantsTable)
      .where(and(eq(tenantsTable.id, tid), eq(tenantsTable.userId, uid), isNull(tenantsTable.deletedAt)));
    if (!t) throw new NotFoundException("Tenant not found");
    // Match contracts by tenantId OR the tenant's phone (legacy contracts).
    const phoneCore = (t.phone || "").replace(/\D/g, "").slice(-9);
    const contractsRaw = await this.db.select({
      id: contractsTable.id, contractNumber: contractsTable.contractNumber, status: contractsTable.status,
      monthlyRent: contractsTable.monthlyRent, startDate: contractsTable.startDate, endDate: contractsTable.endDate,
      tenantPhone: contractsTable.tenantPhone, tenantId: contractsTable.tenantId,
    }).from(contractsTable)
      .where(and(eq(contractsTable.userId, uid), isNull(contractsTable.deletedAt),
        ...(scope.contractIds ? [inArray(contractsTable.id, scope.contractIds)] : [])))
      .orderBy(desc(contractsTable.createdAt));
    // Owner scope: the tenant must be referenced by one of the owner's contracts.
    if (scope.contractIds != null && !contractsRaw.some((c) => c.tenantId === tid)) {
      throw new NotFoundException("Tenant not found");
    }
    const contracts = contractsRaw.filter((c) => c.tenantId === tid || (phoneCore && (c.tenantPhone || "").replace(/\D/g, "").slice(-9) === phoneCore));
    const cids = contracts.map((c) => c.id);
    const cu = cids.length
      ? await this.db.select({ contractId: contractUnitsTable.contractId, unitNumber: unitsTable.unitNumber, propertyName: propertiesTable.name })
          .from(contractUnitsTable).innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
          .innerJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
          .where(inArray(contractUnitsTable.contractId, cids))
      : [];
    const linkOf = new Map<number, { unitNumber: string | null; propertyName: string | null }>();
    for (const r of cu) if (!linkOf.has(r.contractId)) linkOf.set(r.contractId, { unitNumber: r.unitNumber, propertyName: r.propertyName });
    // These tenant fields are intentionally not surfaced anywhere.
    const { nationality: _n, employer: _e, monthlyIncome: _m, ...tRest } = t as any;
    return {
      ...tRest,
      representativeDocUrl: await this.sign((t as any).representativeDocUrl),
      contracts: contracts.map((c) => ({
        id: c.id, contractNumber: c.contractNumber, status: c.status, monthlyRent: this.num(c.monthlyRent),
        startDate: c.startDate, endDate: c.endDate,
        unitNumber: linkOf.get(c.id)?.unitNumber ?? null, propertyName: linkOf.get(c.id)?.propertyName ?? null,
      })),
    };
  }

  /** One contract's full detail (read-only). */
  @Get("contracts/:id")
  async contract(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    const uid = scopeId(user);
    const cid = parseInt(id, 10);
    const scope = await this.ownerScope(user);
    const [c] = await this.db.select().from(contractsTable)
      .where(and(eq(contractsTable.id, cid), eq(contractsTable.userId, uid), isNull(contractsTable.deletedAt),
        ...(scope.contractIds ? [inArray(contractsTable.id, scope.contractIds)] : [])));
    if (!c) throw new NotFoundException("Contract not found");
    const cu: any[] = await this.db.select({
      unitId: unitsTable.id, unitNumber: unitsTable.unitNumber, unitStatus: unitsTable.status,
      unitFloor: unitsTable.floor, unitArea: unitsTable.area,
      unitBedrooms: unitsTable.bedrooms, unitBathrooms: unitsTable.bathrooms,
      unitLivingRooms: unitsTable.livingRooms, unitHalls: unitsTable.halls,
      unitParkingSpaces: unitsTable.parkingSpaces, unitRentPrice: unitsTable.rentPrice,
      unitAcUnits: unitsTable.acUnits, unitAcType: unitsTable.acType,
      unitElectricityMeter: unitsTable.electricityMeter, unitWaterMeter: unitsTable.waterMeter, unitGasMeter: unitsTable.gasMeter,
      propertyId: propertiesTable.id, propertyName: propertiesTable.name,
      propertyDistrict: propertiesTable.district, propertyStreet: propertiesTable.street,
      propertyBuildingNumber: propertiesTable.buildingNumber, propertyPostalCode: propertiesTable.postalCode,
      propertyBuildingType: propertiesTable.buildingType, propertyFloors: propertiesTable.floors,
      propertyTotalUnits: propertiesTable.totalUnits, propertyElevators: propertiesTable.elevators, propertyParkings: propertiesTable.parkings,
      propertyTypeLookupId: propertiesTable.typeLookupId, propertyUsageLookupId: propertiesTable.usageLookupId,
      propertyCityLookupId: propertiesTable.cityLookupId, propertyDeedId: propertiesTable.deedId,
      propertyImageKey: propertiesTable.imageKey, propertyImages: propertiesTable.images,
    })
      .from(contractUnitsTable)
      .innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
      .leftJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
      .where(eq(contractUnitsTable.contractId, cid));
    await attachLookupLabels(this.db, cu, [
      { idField: "propertyTypeLookupId", out: "propertyType", mode: "key" },
      { idField: "propertyUsageLookupId", out: "propertyUsage", mode: "labelAr" },
      { idField: "propertyCityLookupId", out: "propertyCity", mode: "labelAr" },
    ]);
    const firstUnit: any = cu[0] ?? null;
    let deed: any = null;
    if (firstUnit?.propertyDeedId) {
      const [d] = await this.db.select().from(deedsTable).where(eq(deedsTable.id, firstUnit.propertyDeedId));
      if (d) deed = { ...d, documentUrl: await this.sign(d.documentUrl) };
    }
    // Signed property photo gallery (first unit's property) — for the preview.
    const propImgKeys = (Array.isArray(firstUnit?.propertyImages) ? firstUnit.propertyImages : []) as any[];
    let propertyImageUrls = (await Promise.all(propImgKeys.map((k: any) => this.sign(typeof k === "string" ? k : k?.key)))).filter(Boolean) as string[];
    if (!propertyImageUrls.length && firstUnit?.propertyImageKey) {
      const single = await this.sign(firstUnit.propertyImageKey);
      if (single) propertyImageUrls = [single];
    }
    const pays = await this.db.select({ id: paymentsTable.id, amount: paymentsTable.amount, dueDate: paymentsTable.dueDate, paidDate: paymentsTable.paidDate, status: paymentsTable.status, receiptNumber: paymentsTable.receiptNumber, description: paymentsTable.description })
      .from(paymentsTable).where(and(eq(paymentsTable.contractId, cid), isNull(paymentsTable.deletedAt)))
      .orderBy(paymentsTable.dueDate);
    // Collected amount per installment.
    const payIds = pays.map((p) => p.id);
    const collected = new Map<number, number>();
    if (payIds.length) {
      const cols = await this.db.select({ paymentId: paymentCollectionsTable.paymentId, amount: paymentCollectionsTable.amount })
        .from(paymentCollectionsTable).where(inArray(paymentCollectionsTable.paymentId, payIds));
      for (const x of cols) if (x.paymentId != null) collected.set(x.paymentId, (collected.get(x.paymentId) ?? 0) + this.num(x.amount));
    }
    const a = c as any;
    return {
      id: c.id, contractNumber: c.contractNumber, status: c.status,
      ejarContractNumber: a.ejarContractNumber ?? null,
      // Linked tenant id — lets the app deep-link to the tenant screen.
      tenantId: a.tenantId ?? null,
      // Tenant (full)
      tenantType: a.tenantType ?? null,
      tenantName: c.tenantName, tenantPhone: c.tenantPhone, tenantEmail: c.tenantEmail,
      tenantIdNumber: a.tenantIdNumber ?? null,
      tenantTaxNumber: a.tenantTaxNumber ?? null, tenantAddress: a.tenantAddress ?? null,
      // Landlord (full)
      landlordName: c.landlordName, landlordPhone: c.landlordPhone, landlordEmail: a.landlordEmail ?? null,
      landlordIdNumber: a.landlordIdNumber ?? null, landlordTaxNumber: a.landlordTaxNumber ?? null, landlordAddress: a.landlordAddress ?? null,
      // Terms
      monthlyRent: this.num(c.monthlyRent), paymentFrequency: c.paymentFrequency,
      startDate: c.startDate, endDate: c.endDate, signingDate: a.signingDate ?? null, signingPlace: a.signingPlace ?? null,
      depositAmount: c.depositAmount ? this.num(c.depositAmount) : 0,
      depositStatus: a.depositStatus ?? null, depositDueDate: a.depositDueDate ?? null,
      agencyFee: a.agencyFee ? this.num(a.agencyFee) : 0,
      firstPaymentAmount: a.firstPaymentAmount ? this.num(a.firstPaymentAmount) : 0,
      // Advance (prepaid) rent paid up-front — "إيجار مدفوع مقدماً".
      prepaidRent: a.prepaidRent ? this.num(a.prepaidRent) : 0,
      prepaidMethod: a.prepaidMethod ?? null,
      vatEnabled: !!a.vatEnabled,
      escalationType: a.escalationType ?? null, escalationRate: a.escalationRate ? this.num(a.escalationRate) : 0,
      notes: a.notes ?? null,
      // Contract document (PDF/image) as a signed URL.
      attachmentUrl: await this.sign(a.attachmentKey),
      // Full property + units + deed so the detail screen mirrors the web.
      property: firstUnit ? {
        id: firstUnit.propertyId, name: firstUnit.propertyName, type: firstUnit.propertyType, usage: firstUnit.propertyUsage,
        buildingType: firstUnit.propertyBuildingType, floors: firstUnit.propertyFloors, totalUnits: firstUnit.propertyTotalUnits,
        elevators: firstUnit.propertyElevators, parkings: firstUnit.propertyParkings,
        city: firstUnit.propertyCity, district: firstUnit.propertyDistrict, street: firstUnit.propertyStreet,
        buildingNumber: firstUnit.propertyBuildingNumber, postalCode: firstUnit.propertyPostalCode,
      } : null,
      propertyName: firstUnit?.propertyName ?? null,
      propertyImageUrls,
      units: cu,
      deed,
      additionalFees: (c.additionalFees as any) ?? [],
      payments: pays.map((p) => {
        const amount = this.num(p.amount);
        const coll = Math.round((collected.get(p.id) ?? 0) * 100) / 100;
        // Derive the live status from collections + due date (so a future
        // installment reads as upcoming/pending, not overdue).
        let status = p.status as string;
        if (status !== "paid" && status !== "cancelled" && status !== "settled_external") {
          if (amount > 0 && coll >= amount - 0.01) status = "paid";
          else if (coll > 0.01) status = "partially_paid";
          else status = p.dueDate && p.dueDate < new Date().toISOString().slice(0, 10) ? "overdue" : "pending";
        }
        return {
          id: p.id, amount, dueDate: p.dueDate, paidDate: p.paidDate, status,
          receiptNumber: p.receiptNumber, description: p.description, collectedAmount: coll,
        };
      }),
    };
  }
}

@Module({ controllers: [LandlordMobileController] })
export class MobileLandlordModule {}
