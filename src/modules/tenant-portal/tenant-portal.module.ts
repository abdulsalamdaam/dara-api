import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Module, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, MinLength } from "class-validator";
import { Throttle } from "@nestjs/throttler";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { contractsTable, contractUnitsTable, paymentsTable, paymentCollectionsTable, simpleInvoicesTable, deedsTable, unitsTable, propertiesTable, maintenanceRequestsTable, tenantsTable, companiesTable, usersTable } from "@dara/database";
import { attachLookupLabels } from "../../common/lookups-resolve";
import { invoiceQrSvg } from "../../common/zatca-qr";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { TenantAuthGuard, type TenantPayload } from "../../common/guards/tenant-auth.guard";
import { CurrentTenant } from "../../common/decorators/current-tenant.decorator";
import { UploadsService } from "../uploads/uploads.service";

class FcmTokenDto {
  @IsString()
  token!: string;

  @IsOptional()
  @IsIn(["ios", "android", "web"])
  platform?: "ios" | "android" | "web";
}

class CreateMaintenanceDto {
  @IsInt()
  contractId!: number;

  @IsString()
  @MinLength(3)
  description!: string;

  @IsOptional()
  @IsIn(["low", "medium", "high"])
  priority?: "low" | "medium" | "high";
}

class DeleteAccountDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

@ApiTags("tenant-portal")
@ApiBearerAuth("tenant-jwt")
@Controller("tenant/me")
@UseGuards(TenantAuthGuard)
export class TenantPortalController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle, private readonly uploads: UploadsService) {}

  private num(s: string | null | undefined) { return parseFloat(s || "0") || 0; }
  private async sign(key: string | null | undefined): Promise<string | null> {
    if (!key) return null;
    try { return await this.uploads.presignGet(key, 3600); } catch { return null; }
  }

  /* ── Profile ── */
  @Get()
  async profile(@CurrentTenant() tenant: TenantPayload) {
    const [t] = await this.db.select().from(tenantsTable).where(eq(tenantsTable.id, tenant.id));
    if (!t) throw new NotFoundException("Tenant not found");
    return {
      id: t.id,
      name: t.name,
      type: t.type,
      phone: t.phone,
      email: t.email,
      address: t.address,
      lastLoginAt: t.lastLoginAt,
      createdAt: t.createdAt,
    };
  }

  /* ── Contracts (matched by phone) ── */
  @Get("contracts")
  async contracts(@CurrentTenant() tenant: TenantPayload) {
    const [t] = await this.db.select().from(tenantsTable).where(eq(tenantsTable.id, tenant.id));
    if (!t || !t.phone) return [];
    const rows = await this.db
      .select({
        id: contractsTable.id,
        contractNumber: contractsTable.contractNumber,
        startDate: contractsTable.startDate,
        endDate: contractsTable.endDate,
        monthlyRent: contractsTable.monthlyRent,
        paymentFrequency: contractsTable.paymentFrequency,
        depositAmount: contractsTable.depositAmount,
        status: contractsTable.status,
        notes: contractsTable.notes,
        vatEnabled: contractsTable.vatEnabled,
        escalationType: contractsTable.escalationType,
        escalationRate: contractsTable.escalationRate,
        depositStatus: contractsTable.depositStatus,
        depositDueDate: contractsTable.depositDueDate,
        // Tenant identity (snapshot) — so the tenant sees their own record too.
        tenantType: contractsTable.tenantType,
        tenantName: contractsTable.tenantName,
        tenantIdNumber: contractsTable.tenantIdNumber,
        tenantPhone: contractsTable.tenantPhone,
        tenantEmail: contractsTable.tenantEmail,
        tenantTaxNumber: contractsTable.tenantTaxNumber,
        // Landlord identity (full).
        landlordName: contractsTable.landlordName,
        landlordIdNumber: contractsTable.landlordIdNumber,
        landlordPhone: contractsTable.landlordPhone,
        landlordEmail: contractsTable.landlordEmail,
        landlordTaxNumber: contractsTable.landlordTaxNumber,
        landlordAddress: contractsTable.landlordAddress,
        signingDate: contractsTable.signingDate,
        signingPlace: contractsTable.signingPlace,
        agencyFee: contractsTable.agencyFee,
        firstPaymentAmount: contractsTable.firstPaymentAmount,
        prepaidRent: contractsTable.prepaidRent,
        additionalFees: contractsTable.additionalFees,
      })
      .from(contractsTable)
      .where(eq(contractsTable.tenantPhone, t.phone))
      .orderBy(desc(contractsTable.createdAt));

    // A contract can span many units — fetch them via contract_units and
    // attach a `units` array, plus a primary unit/property surface so
    // older single-unit clients keep rendering.
    const unitsByContract = new Map<number, any[]>();
    if (rows.length > 0) {
      const unitRows = await this.db
        .select({
          contractId: contractUnitsTable.contractId,
          unitId: unitsTable.id,
          unitNumber: unitsTable.unitNumber,
          unitStatus: unitsTable.status,
          unitFloor: unitsTable.floor,
          unitArea: unitsTable.area,
          unitBedrooms: unitsTable.bedrooms,
          unitBathrooms: unitsTable.bathrooms,
          unitLivingRooms: unitsTable.livingRooms,
          unitHalls: unitsTable.halls,
          unitParkingSpaces: unitsTable.parkingSpaces,
          unitRentPrice: unitsTable.rentPrice,
          unitAcUnits: unitsTable.acUnits,
          unitAcType: unitsTable.acType,
          unitElectricityMeter: unitsTable.electricityMeter,
          unitWaterMeter: unitsTable.waterMeter,
          unitGasMeter: unitsTable.gasMeter,
          propertyId: propertiesTable.id,
          propertyName: propertiesTable.name,
          propertyCityLookupId: propertiesTable.cityLookupId,
          propertyDistrict: propertiesTable.district,
          propertyStreet: propertiesTable.street,
          propertyBuildingNumber: propertiesTable.buildingNumber,
          propertyPostalCode: propertiesTable.postalCode,
          propertyTypeLookupId: propertiesTable.typeLookupId,
          propertyBuildingType: propertiesTable.buildingType,
          propertyUsageLookupId: propertiesTable.usageLookupId,
          propertyFloors: propertiesTable.floors,
          propertyTotalUnits: propertiesTable.totalUnits,
          propertyElevators: propertiesTable.elevators,
          propertyParkings: propertiesTable.parkings,
          propertyDeedId: propertiesTable.deedId,
          propertyImages: propertiesTable.images,
        })
        .from(contractUnitsTable)
        .innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
        .leftJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
        .where(inArray(contractUnitsTable.contractId, rows.map((r) => r.id)))
        .orderBy(contractUnitsTable.id);
      await attachLookupLabels(this.db, unitRows as any[], [
        { idField: "propertyTypeLookupId", out: "propertyType", mode: "key" },
        { idField: "propertyCityLookupId", out: "propertyCity", mode: "labelAr" },
        { idField: "propertyUsageLookupId", out: "propertyUsage", mode: "labelAr" },
      ]);
      for (const u of unitRows) {
        const list = unitsByContract.get(u.contractId) ?? [];
        list.push(u);
        unitsByContract.set(u.contractId, list);
      }
    }
    // Resolve the title deed (صك) for each contract's property, with a signed
    // document URL — so the tenant can view the deed too.
    const deedIds = [...new Set([...unitsByContract.values()].flat().map((u: any) => u.propertyDeedId).filter(Boolean))] as number[];
    const deedMap = new Map<number, any>();
    if (deedIds.length) {
      const deeds = await this.db.select().from(deedsTable).where(inArray(deedsTable.id, deedIds));
      for (const d of deeds) deedMap.set(d.id, { ...d, documentUrl: await this.sign(d.documentUrl) });
    }
    // Sign the property photo gallery (first unit's property) per contract, so
    // the tenant can preview the property's photos.
    const propertyImagesByContract = new Map<number, string[]>();
    for (const [cid, units] of unitsByContract) {
      const keys = (Array.isArray(units[0]?.propertyImages) ? units[0].propertyImages : []) as any[];
      if (!keys.length) continue;
      const urls = (await Promise.all(keys.map((k: any) => this.sign(typeof k === "string" ? k : k?.key)))).filter(Boolean) as string[];
      if (urls.length) propertyImagesByContract.set(cid, urls);
    }
    return rows.map((row) => {
      const units = unitsByContract.get(row.id) ?? [];
      const first: any = units[0] ?? null;
      return {
        ...row,
        units,
        unitId: first?.unitId ?? null,
        unitNumber: first?.unitNumber ?? null,
        propertyId: first?.propertyId ?? null,
        propertyName: first?.propertyName ?? null,
        propertyCity: first?.propertyCity ?? null,
        propertyDistrict: first?.propertyDistrict ?? null,
        propertyStreet: first?.propertyStreet ?? null,
        propertyBuildingNumber: first?.propertyBuildingNumber ?? null,
        propertyPostalCode: first?.propertyPostalCode ?? null,
        propertyType: first?.propertyType ?? null,
        propertyBuildingType: first?.propertyBuildingType ?? null,
        propertyUsage: first?.propertyUsage ?? null,
        propertyFloors: first?.propertyFloors ?? null,
        propertyTotalUnits: first?.propertyTotalUnits ?? null,
        propertyElevators: first?.propertyElevators ?? null,
        propertyParkings: first?.propertyParkings ?? null,
        propertyImageUrls: propertyImagesByContract.get(row.id) ?? [],
        deed: first?.propertyDeedId ? (deedMap.get(first.propertyDeedId) ?? null) : null,
      };
    });
  }

  /* ── Payments schedule across all tenant's contracts ── */
  @Get("payments")
  async payments(@CurrentTenant() tenant: TenantPayload) {
    const [t] = await this.db.select().from(tenantsTable).where(eq(tenantsTable.id, tenant.id));
    if (!t || !t.phone) return [];
    const rows = await this.db
      .select({
        id: paymentsTable.id,
        contractId: paymentsTable.contractId,
        contractNumber: contractsTable.contractNumber,
        amount: paymentsTable.amount,
        dueDate: paymentsTable.dueDate,
        paidDate: paymentsTable.paidDate,
        status: paymentsTable.status,
        receiptNumber: paymentsTable.receiptNumber,
        description: paymentsTable.description,
      })
      .from(paymentsTable)
      .innerJoin(contractsTable, eq(paymentsTable.contractId, contractsTable.id))
      .where(eq(contractsTable.tenantPhone, t.phone))
      .orderBy(paymentsTable.dueDate);

    // Attach the receipt(s) recorded against each installment — receipt number,
    // amount, method, date and a signed URL to the uploaded proof, if any.
    const ids = rows.map((r) => r.id);
    const colls = ids.length
      ? await this.db.select({
          paymentId: paymentCollectionsTable.paymentId, amount: paymentCollectionsTable.amount,
          collectedDate: paymentCollectionsTable.collectedDate, method: paymentCollectionsTable.method,
          receiptNumber: paymentCollectionsTable.receiptNumber, attachmentKey: paymentCollectionsTable.attachmentKey,
        }).from(paymentCollectionsTable).where(inArray(paymentCollectionsTable.paymentId, ids))
      : [];
    const byPayment = new Map<number, any[]>();
    for (const c of colls) {
      if (c.paymentId == null) continue;
      const list = byPayment.get(c.paymentId) ?? [];
      list.push({
        amount: this.num(c.amount), collectedDate: c.collectedDate, method: c.method,
        receiptNumber: c.receiptNumber, proofUrl: await this.sign(c.attachmentKey),
      });
      byPayment.set(c.paymentId, list);
    }
    // Derive the live status from what's actually been collected (+ due date),
    // so a settled installment never lingers as "overdue".
    const today = new Date().toISOString().slice(0, 10);
    return rows.map((r) => {
      const receipts = byPayment.get(r.id) ?? [];
      const amount = this.num(r.amount);
      const collected = Math.round(receipts.reduce((s, x) => s + x.amount, 0) * 100) / 100;
      let status = r.status as string;
      if (status !== "paid" && status !== "cancelled" && status !== "settled_external") {
        if (amount > 0 && collected >= amount - 0.01) status = "paid";
        else if (collected > 0.01) status = "partially_paid";
        else status = r.dueDate && r.dueDate < today ? "overdue" : "pending";
      }
      // `amount` kept as the original string for client compatibility; the
      // collected total + receipts are added alongside.
      return { ...r, status, collectedAmount: collected, receipts };
    });
  }

  /* ── Tenant's invoices & receipt vouchers (approved only) ── */
  @Get("invoices")
  async invoices(@CurrentTenant() tenant: TenantPayload) {
    const [t] = await this.db.select().from(tenantsTable).where(eq(tenantsTable.id, tenant.id));
    if (!t || !t.phone) return [];
    const myContracts = await this.db.select({ id: contractsTable.id }).from(contractsTable)
      .where(eq(contractsTable.tenantPhone, t.phone));
    const cids = myContracts.map((c) => c.id);
    const scope = cids.length
      ? or(eq(simpleInvoicesTable.tenantId, t.id), inArray(simpleInvoicesTable.contractId, cids))
      : eq(simpleInvoicesTable.tenantId, t.id);
    const rows = await this.db.select().from(simpleInvoicesTable)
      .where(and(
        eq(simpleInvoicesTable.type, "invoice"),
        eq(simpleInvoicesTable.status, "confirmed"),   // confirmed == approved
        sql`(${simpleInvoicesTable.kind} is null or ${simpleInvoicesTable.kind} in ('receipt','deposit'))`,
        isNull(simpleInvoicesTable.deletedAt),
        scope as any,
      ))
      .orderBy(desc(simpleInvoicesTable.issueDate), desc(simpleInvoicesTable.id))
      .limit(200);
    if (!rows.length) return [];

    // Seller = the contract's LANDLORD (المؤجر) per-field, with the managing
    // account's company filling any gaps — exactly like the web tax-invoice view.
    const contractIds = [...new Set(rows.map((r) => r.contractId).filter((x): x is number => !!x))];
    const landlordById = new Map<number, typeof contractsTable.$inferSelect>();
    if (contractIds.length) {
      const cs = await this.db.select().from(contractsTable).where(inArray(contractsTable.id, contractIds));
      for (const c of cs) landlordById.set(c.id, c);
    }
    // Account company (logo + fallback seller details), keyed by invoice.userId.
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const companyByUser = new Map<number, typeof companiesTable.$inferSelect>();
    if (userIds.length) {
      const us = await this.db.select({ id: usersTable.id, companyId: usersTable.companyId }).from(usersTable).where(inArray(usersTable.id, userIds));
      const companyIds = [...new Set(us.map((u) => u.companyId).filter((x): x is number => !!x))];
      const cos = companyIds.length ? await this.db.select().from(companiesTable).where(inArray(companiesTable.id, companyIds)) : [];
      const coById = new Map(cos.map((c) => [c.id, c]));
      for (const u of us) if (u.companyId && coById.has(u.companyId)) companyByUser.set(u.id, coById.get(u.companyId)!);
    }
    // Sign each distinct company logo once.
    const logoUrlByKey = new Map<string, string | null>();
    for (const co of new Set([...companyByUser.values()].map((c) => c.logoKey).filter((k): k is string => !!k))) {
      logoUrlByKey.set(co, await this.sign(co));
    }
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const pick = (...v: (string | null | undefined)[]) => v.find((x) => x && String(x).trim()) ?? null;

    return Promise.all(rows.map(async (r) => {
      const c = r.contractId ? landlordById.get(r.contractId) : undefined;
      const co = companyByUser.get(r.userId);
      const companyAddress = co ? [co.address, co.district, co.city, co.region].filter(Boolean).join("، ") : null;
      const seller = {
        name: pick(c?.landlordName, co?.name),
        phone: pick(c?.landlordPhone, co?.companyPhone),
        email: pick(c?.landlordEmail, co?.officialEmail),
        address: pick(c?.landlordAddress, companyAddress),
        vatNumber: pick(c?.landlordTaxNumber, co?.vatNumber),
      };
      const buyer = {
        name: pick(r.tenantName, t.name),
        phone: pick(r.client?.phone, t.phone),
        email: pick(r.client?.email, t.email),
        address: pick(r.client?.address, t.address),
        vatNumber: pick(r.client?.vatNumber, (t as any).taxNumber),
      };
      const subtotal = this.num(r.subtotal);
      const total = this.num(r.total);
      const vat = round2(total - subtotal);
      const isVoucher = r.kind === "receipt" || r.kind === "deposit";
      // ZATCA Phase-1 QR — only on tax invoices (vouchers/سند قبض carry none).
      const qrSvg = !isVoucher && vat > 0.01
        ? invoiceQrSvg({ sellerName: seller.name, vatNumber: seller.vatNumber, issueDate: r.issueDate, totalWithVat: total, vatTotal: vat })
        : null;
      return {
        id: r.id, number: r.number, type: r.type, kind: r.kind, isVoucher,
        buyerHasVat: !!buyer.vatNumber,
        subtotal, total, vat,
        items: r.items ?? [], issueDate: r.issueDate, paidDate: r.paidDate, dueDate: r.dueDate,
        receiptNumber: r.receiptNumber, paymentMethod: r.paymentMethod,
        billingReference: r.billingReference, notes: r.notes,
        seller, buyer, qrSvg,
        attachmentUrl: await this.sign(r.attachmentKey),
        // lets the client pick image preview vs. file link
        attachmentIsImage: !!r.attachmentKey && /\.(jpe?g|png|gif|webp|bmp)$/i.test(r.attachmentKey),
      };
    }));
  }

  /* ── Maintenance: list own tickets ── */
  @Get("maintenance")
  async listMaintenance(@CurrentTenant() tenant: TenantPayload) {
    return this.db
      .select()
      .from(maintenanceRequestsTable)
      .where(eq(maintenanceRequestsTable.tenantId, tenant.id))
      .orderBy(desc(maintenanceRequestsTable.createdAt));
  }

  /* ── Maintenance: raise a ticket ── */
  @Post("maintenance")
  @Throttle({ default: { limit: 10, ttl: 3600_000 } })
  async createMaintenance(@CurrentTenant() tenant: TenantPayload, @Body() body: CreateMaintenanceDto) {
    if (!body.contractId || !body.description?.trim()) {
      throw new BadRequestException("رقم العقد ووصف المشكلة مطلوبان");
    }

    const [t] = await this.db.select().from(tenantsTable).where(eq(tenantsTable.id, tenant.id));
    if (!t || !t.phone) throw new BadRequestException("رقم الجوال غير مسجّل");

    const [contract] = await this.db
      .select({ id: contractsTable.id, userId: contractsTable.userId })
      .from(contractsTable)
      .where(and(eq(contractsTable.id, body.contractId), eq(contractsTable.tenantPhone, t.phone)));

    if (!contract) throw new NotFoundException("العقد غير موجود");

    // The contract may span several units — label the ticket with the
    // property name plus every unit number it covers.
    const unitRows = await this.db
      .select({ unitNumber: unitsTable.unitNumber, propertyName: propertiesTable.name })
      .from(contractUnitsTable)
      .innerJoin(unitsTable, eq(unitsTable.id, contractUnitsTable.unitId))
      .leftJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
      .where(eq(contractUnitsTable.contractId, contract.id))
      .orderBy(contractUnitsTable.id);
    const unitNumbers = unitRows.map((u) => u.unitNumber).filter(Boolean).join("، ");
    const propertyName = unitRows[0]?.propertyName ?? null;
    const unitLabel = propertyName && unitNumbers
      ? `${propertyName} — ${unitNumbers}`
      : (unitNumbers || `Unit (contract ${contract.id})`);

    const [row] = await this.db.insert(maintenanceRequestsTable).values({
      userId: contract.userId,
      tenantId: tenant.id,
      contractId: contract.id,
      unitLabel,
      description: body.description.trim(),
      priority: body.priority || "medium",
      status: "open",
    }).returning();

    return row;
  }

  /* ── Save FCM token (push notifications) ── */
  @Post("fcm-token")
  @HttpCode(200)
  async saveFcmToken(@CurrentTenant() tenant: TenantPayload, @Body() body: FcmTokenDto) {
    if (!body.token?.trim()) throw new BadRequestException("token required");
    await this.db.update(tenantsTable)
      .set({ fcmToken: body.token.trim(), fcmPlatform: body.platform ?? null })
      .where(eq(tenantsTable.id, tenant.id));
    return { success: true };
  }

  @Delete("fcm-token")
  @HttpCode(200)
  async clearFcmToken(@CurrentTenant() tenant: TenantPayload) {
    await this.db.update(tenantsTable)
      .set({ fcmToken: null, fcmPlatform: null })
      .where(eq(tenantsTable.id, tenant.id));
    return { success: true };
  }

  /* ── Soft delete account ── */
  @Delete()
  @HttpCode(200)
  async deleteAccount(@CurrentTenant() tenant: TenantPayload, @Body() body: DeleteAccountDto) {
    const noteSuffix = body.reason ? `\nسبب الحذف: ${body.reason}` : "";
    await this.db.update(tenantsTable)
      .set({
        deletedAt: new Date(),
        status: "inactive",
        fcmToken: null,
        fcmPlatform: null,
        tokenVersion: sql`${tenantsTable.tokenVersion} + 1`,
        notes: sql`COALESCE(${tenantsTable.notes}, '') || ${"\n[deleted at " + new Date().toISOString() + "]" + noteSuffix}`,
      })
      .where(eq(tenantsTable.id, tenant.id));
    return { success: true, message: "تم حذف الحساب. تواصل مع الدعم لاسترداده خلال 30 يوم." };
  }
}

@Module({ controllers: [TenantPortalController] })
export class TenantPortalModule {}
