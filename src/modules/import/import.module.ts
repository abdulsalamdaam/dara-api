import { Body, Controller, Inject, Module, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import {
  ownersTable, deedsTable, propertiesTable, unitsTable, tenantsTable,
  contractsTable, contractUnitsTable, paymentsTable,
} from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { resolveLookupId } from "../../common/lookups-resolve";
import { buildInstallments } from "../contracts/installments";

/**
 * Bulk import — one spreadsheet row carries an owner + deed + property +
 * unit + tenant + (optional) contract. Each entity is matched by a stable
 * key and reused when it already exists (so re-importing or repeating a
 * landlord/deed across rows never duplicates), otherwise created and linked
 * down the chain Deed → Property → Unit → Contract (Landlord ↔ Tenant).
 *
 * Rows are processed independently: a bad row is reported and skipped, the
 * rest still import.
 */

type Row = Record<string, string | number | null | undefined>;

type RowResult = {
  row: number;
  status: "ok" | "error" | "skipped";
  created: string[];
  linked: string[];
  messages: string[];
};

const str = (v: unknown): string => (v == null ? "" : String(v).trim());
const num = (v: unknown): number | null => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null;
};
const toIso = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

@ApiTags("import")
@ApiBearerAuth("user-jwt")
@Controller("import")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class ImportController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  @Post("bulk")
  @RequirePermissions(PERMISSIONS.CONTRACTS_WRITE)
  async bulk(@CurrentUser() user: AuthUser, @Body() body: { rows?: Row[] }) {
    const scope = scopeId(user);
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    const results: RowResult[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const res: RowResult = { row: i + 1, status: "ok", created: [], linked: [], messages: [] };
      try {
        await this.importRow(scope, row, res);
        if (res.created.length === 0 && res.linked.length === 0 && res.status === "ok") {
          res.status = "skipped";
          res.messages.push("Empty row — nothing to import");
        }
      } catch (e: any) {
        res.status = "error";
        res.messages.push(e?.message || "Unknown error");
      }
      results.push(res);
    }

    const summary = {
      total: rows.length,
      ok: results.filter((r) => r.status === "ok").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      errors: results.filter((r) => r.status === "error").length,
      created: results.reduce((s, r) => s + r.created.length, 0),
      linked: results.reduce((s, r) => s + r.linked.length, 0),
    };
    return { summary, results };
  }

  private async importRow(scope: number, row: Row, res: RowResult) {
    /* ── Owner (landlord) ── */
    let ownerId: number | null = null;
    let ownerName = "", ownerPhone: string | null = null, ownerEmail: string | null = null;
    const oName = str(row.owner_name);
    const oId = str(row.owner_id_number);
    if (oName || oId) {
      const where = oId
        ? and(eq(ownersTable.userId, scope), eq(ownersTable.idNumber, oId), isNull(ownersTable.deletedAt))
        : and(eq(ownersTable.userId, scope), eq(ownersTable.name, oName), isNull(ownersTable.deletedAt));
      const [found] = await this.db.select().from(ownersTable).where(where).limit(1);
      if (found) {
        ownerId = found.id; ownerName = found.name; ownerPhone = found.phone; ownerEmail = found.email;
        res.linked.push("owner");
      } else {
        const [created] = await this.db.insert(ownersTable).values({
          userId: scope, name: oName || oId,
          type: str(row.owner_type) === "company" ? "company" : "individual",
          idNumber: oId || null, phone: str(row.owner_phone) || null, email: str(row.owner_email) || null,
          status: "active",
        }).returning();
        ownerId = created!.id; ownerName = created!.name; ownerPhone = created!.phone; ownerEmail = created!.email;
        res.created.push("owner");
      }
    }

    /* ── Deed ── */
    let deedId: number | null = null;
    const deedNumber = str(row.deed_number);
    if (deedNumber) {
      const [found] = await this.db.select({ id: deedsTable.id }).from(deedsTable)
        .where(and(eq(deedsTable.userId, scope), eq(deedsTable.deedNumber, deedNumber), isNull(deedsTable.deletedAt))).limit(1);
      if (found) { deedId = found.id; res.linked.push("deed"); }
      else {
        const [created] = await this.db.insert(deedsTable).values({
          userId: scope, deedNumber,
          deedType: str(row.deed_type) || "electronic",
          ownerId, issueDate: toIso(row.deed_issue_date),
          issuingAuthority: str(row.deed_authority) || null,
        } as any).returning();
        deedId = created!.id; res.created.push("deed");
      }
    }

    /* ── Property ── */
    let propertyId: number | null = null;
    const propName = str(row.property_name);
    if (propName) {
      const [found] = await this.db.select({ id: propertiesTable.id }).from(propertiesTable)
        .where(and(eq(propertiesTable.userId, scope), eq(propertiesTable.name, propName), isNull(propertiesTable.deletedAt))).limit(1);
      if (found) {
        propertyId = found.id; res.linked.push("property");
        // Backfill the owner/deed link if the existing property had none.
        if (ownerId || deedId) {
          await this.db.update(propertiesTable)
            .set({ ...(ownerId ? { ownerId } : {}), ...(deedId ? { deedId } : {}) })
            .where(eq(propertiesTable.id, found.id));
        }
      } else {
        const typeLookupId = await resolveLookupId(this.db, "property_type", str(row.property_type));
        const [created] = await this.db.insert(propertiesTable).values({
          userId: scope, ownerId, name: propName,
          district: str(row.property_district) || null,
          deedId,
          typeLookupId,
          typeOther: typeLookupId == null && str(row.property_type) ? str(row.property_type) : null,
          usageLookupId: await resolveLookupId(this.db, "property_usage", str(row.property_usage)),
          cityLookupId: await resolveLookupId(this.db, "city", str(row.property_city)),
          status: "active", totalUnits: 0, isDemo: false,
        }).returning();
        propertyId = created!.id; res.created.push("property");
      }
    }

    /* ── Unit (needed for a contract) ── */
    let unitId: number | null = null;
    if (propertyId) {
      const unitNumber = str(row.unit_number) || "1";
      const [found] = await this.db.select({ id: unitsTable.id }).from(unitsTable)
        .where(and(eq(unitsTable.propertyId, propertyId), eq(unitsTable.unitNumber, unitNumber), isNull(unitsTable.deletedAt))).limit(1);
      if (found) { unitId = found.id; res.linked.push("unit"); }
      else {
        const unitTypeLookupId = await resolveLookupId(this.db, "unit_type", str(row.unit_type) || "apartment");
        const [created] = await this.db.insert(unitsTable).values({
          propertyId, unitNumber,
          typeLookupId: unitTypeLookupId,
          typeOther: unitTypeLookupId == null && str(row.unit_type) ? str(row.unit_type) : null,
          status: "available",
          rentPrice: num(row.unit_rent) != null ? String(num(row.unit_rent)) : null,
        } as any).returning();
        unitId = created!.id; res.created.push("unit");
        await this.db.update(propertiesTable)
          .set({ totalUnits: sql`${propertiesTable.totalUnits} + 1` })
          .where(eq(propertiesTable.id, propertyId));
      }
    }

    /* ── Tenant ── */
    let tenantId: number | null = null;
    let tenantName = "", tenantIdNumber: string | null = null, tenantPhone: string | null = null, tenantEmail: string | null = null;
    const tName = str(row.tenant_name);
    const tId = str(row.tenant_id_number);
    if (tName || tId) {
      const where = tId
        ? and(eq(tenantsTable.userId, scope), eq(tenantsTable.nationalId, tId), isNull(tenantsTable.deletedAt))
        : and(eq(tenantsTable.userId, scope), eq(tenantsTable.name, tName), isNull(tenantsTable.deletedAt));
      const [found] = await this.db.select().from(tenantsTable).where(where).limit(1);
      if (found) {
        tenantId = found.id; tenantName = found.name; tenantIdNumber = found.nationalId; tenantPhone = found.phone; tenantEmail = found.email;
        res.linked.push("tenant");
      } else {
        const [created] = await this.db.insert(tenantsTable).values({
          userId: scope, name: tName || tId,
          type: str(row.tenant_type) === "company" ? "company" : "individual",
          nationalId: tId || null, phone: str(row.tenant_phone) || null, email: str(row.tenant_email) || null,
          status: "active", isDemo: "false",
        }).returning();
        tenantId = created!.id; tenantName = created!.name; tenantIdNumber = created!.nationalId; tenantPhone = created!.phone; tenantEmail = created!.email;
        res.created.push("tenant");
      }
    }

    /* ── Contract (optional) ── */
    const startDate = toIso(row.contract_start_date);
    const annualRent = num(row.contract_annual_rent);
    if (unitId && tenantId && startDate && annualRent != null && annualRent > 0) {
      // Dedupe: don't create a second live contract on a unit that already has one.
      const existing = await this.db.select({ id: contractsTable.id })
        .from(contractUnitsTable)
        .innerJoin(contractsTable, eq(contractUnitsTable.contractId, contractsTable.id))
        .where(and(
          eq(contractUnitsTable.unitId, unitId),
          eq(contractsTable.userId, scope),
          isNull(contractsTable.deletedAt),
          inArray(contractsTable.status, ["active", "pending"]),
        )).limit(1);
      if (existing.length) {
        res.messages.push("Contract skipped — the unit already has a contract");
      } else {
        const months = num(row.contract_duration_months) ?? 12;
        const start = new Date(startDate);
        const endD = new Date(start); endD.setMonth(endD.getMonth() + months); endD.setDate(endD.getDate() - 1);
        const endDate = endD.toISOString().slice(0, 10);
        const monthly = annualRent / 12;
        const freqRaw = str(row.contract_payment_cycle).toLowerCase();
        const freq = ["monthly", "quarterly", "semi_annual", "annual"].includes(freqRaw) ? freqRaw : "annual";
        const contractNumber = `EQ-${Date.now()}-${scope}-${res.row}`;
        const [contract] = await this.db.insert(contractsTable).values({
          userId: scope, contractNumber,
          tenantId, tenantType: "individual", tenantName,
          tenantIdNumber, tenantPhone, tenantEmail,
          landlordName: ownerName || null, landlordPhone: ownerPhone, landlordEmail: ownerEmail,
          startDate, endDate, monthlyRent: String(monthly), paymentFrequency: freq as any,
          depositAmount: num(row.contract_deposit) != null ? String(num(row.contract_deposit)) : null,
          status: "active", isDraft: false, isDemo: false,
        }).returning();
        await this.db.insert(contractUnitsTable).values({ contractId: contract!.id, unitId });
        await this.db.update(unitsTable).set({ status: "rented" }).where(eq(unitsTable.id, unitId));
        const installments = buildInstallments(contract!.id, scope, startDate, endDate, String(monthly), freq, null, false, 0, "percent", null, 0);
        if (installments.length) await this.db.insert(paymentsTable).values(installments);
        res.created.push("contract");
      }
    }
  }
}

@Module({ controllers: [ImportController] })
export class ImportModule {}
