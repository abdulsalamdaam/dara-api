import {
  Body, Controller, Delete, Get, Inject, Module, Param, Post, BadRequestException, UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, isNull } from "drizzle-orm";
import {
  contractsTable, contractUnitsTable, unitsTable, propertiesTable, ownersTable, tenantsTable,
  paymentsTable, paymentCollectionsTable, simpleInvoicesTable, maintenanceRequestsTable,
  expensesTable, landlordPayoutsTable,
} from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../common/permissions.decorator";
import { PERMISSIONS } from "../../common/permissions";
import { scopeId } from "../../common/scope";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const DEPOSIT_DESC = "تأمين (وديعة)";

@ApiTags("reports")
@ApiBearerAuth("user-jwt")
@Controller("reports")
@UseGuards(JwtAuthGuard, PermissionsGuard)
class ReportsController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /**
   * The accountant reports, computed in one pass from the account's data:
   * landlord statement / dues / transfers, tenant statement / overdue, and the
   * managing company's commission revenue. "Owner" is surfaced as "landlord".
   */
  @Get("accounting")
  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  async accounting(@CurrentUser() user: AuthUser) {
    const uid = scopeId(user);
    const live = isNull as any; // brevity

    const [contracts, cUnits, units, properties, owners, tenants, payments, collections, invoices, maint, expenses, payouts] =
      await Promise.all([
        this.db.select().from(contractsTable).where(and(eq(contractsTable.userId, uid), isNull(contractsTable.deletedAt))),
        this.db.select().from(contractUnitsTable),
        this.db.select().from(unitsTable),
        this.db.select().from(propertiesTable).where(and(eq(propertiesTable.userId, uid), isNull(propertiesTable.deletedAt))),
        this.db.select().from(ownersTable).where(and(eq(ownersTable.userId, uid), isNull(ownersTable.deletedAt))),
        this.db.select().from(tenantsTable).where(and(eq(tenantsTable.userId, uid), isNull(tenantsTable.deletedAt))),
        this.db.select().from(paymentsTable).where(and(eq(paymentsTable.userId, uid), isNull(paymentsTable.deletedAt))),
        this.db.select().from(paymentCollectionsTable).where(eq(paymentCollectionsTable.userId, uid)),
        this.db.select().from(simpleInvoicesTable).where(and(eq(simpleInvoicesTable.userId, uid), isNull(simpleInvoicesTable.deletedAt))),
        this.db.select().from(maintenanceRequestsTable).where(and(eq(maintenanceRequestsTable.userId, uid), isNull(maintenanceRequestsTable.deletedAt))),
        this.db.select().from(expensesTable).where(and(eq(expensesTable.userId, uid), isNull(expensesTable.deletedAt))),
        this.db.select().from(landlordPayoutsTable).where(and(eq(landlordPayoutsTable.userId, uid), isNull(landlordPayoutsTable.deletedAt))),
      ]);
    void live;

    // ── lookup maps ──
    const propById = new Map(properties.map((p) => [p.id, p]));
    const ownerById = new Map(owners.map((o) => [o.id, o]));
    // Owner lookup by national-id / name — used to resolve a contract's landlord
    // to a real owner record even when its property has no owner link, so the
    // landlord statement doesn't split the same person into two rows.
    const ownerByIdNum = new Map<string, any>();
    const ownerByName = new Map<string, any>();
    for (const o of owners) {
      if (o.idNumber) ownerByIdNum.set(String(o.idNumber).trim(), o);
      if (o.name) ownerByName.set(String(o.name).trim().toLowerCase(), o);
    }
    const unitProp = new Map(units.map((u) => [u.id, u.propertyId]));
    // contract → propertyId (first unit's property)
    const contractProp = new Map<number, number>();
    for (const cu of cUnits) {
      if (contractProp.has(cu.contractId)) continue;
      const pid = unitProp.get(cu.unitId);
      if (pid != null) contractProp.set(cu.contractId, pid);
    }
    const paymentById = new Map(payments.map((p) => [p.id, p]));
    const invoiceById = new Map(invoices.map((i) => [i.id, i]));

    // Per-contract aggregates.
    // `collectedByContract` is RENT/fees only — it drives both the tenant's
    // "collected" (against rent invoices) and the landlord's rent collected, so
    // the deposit must NOT be mixed in here (it isn't rent and would corrupt the
    // tenant balance). The security deposit is the tenant's held balance; only
    // when it's "taken as a collection for the landlord" on termination (a real
    // collection recorded against the deposit voucher) does it move to the
    // landlord — tracked separately so it lands on the landlord side only.
    const collectedByContract = new Map<number, number>(); // rent + fees, net of refunds
    const convertedDepositByContract = new Map<number, number>(); // deposits taken as landlord revenue
    const convertedDepositVoucherIds = new Set<number>();
    for (const col of collections) {
      const pay = paymentById.get(col.paymentId);
      if (pay) {
        if (pay.description === DEPOSIT_DESC) continue; // held deposit, not income
        collectedByContract.set(pay.contractId, round2((collectedByContract.get(pay.contractId) ?? 0) + Number(col.amount)));
        continue;
      }
      // Payment-less collection linked to a deposit voucher = a deposit taken as
      // revenue on termination → it moves to the landlord (not the tenant).
      const inv = col.invoiceId != null ? invoiceById.get(col.invoiceId) : null;
      if (inv && inv.kind === "deposit" && inv.contractId != null) {
        convertedDepositVoucherIds.add(inv.id);
        convertedDepositByContract.set(inv.contractId, round2((convertedDepositByContract.get(inv.contractId) ?? 0) + Number(col.amount)));
        continue;
      }
      // Any other payment-less collection is money that really came in — an
      // invoice with no installment behind it, or the remainder a schedule
      // couldn't absorb. Without the invoice's own contract to fall back on it
      // was dropped here while the Payments screen counted it, so the same
      // tenant read as collected on one screen and owing on the other.
      // Commission is left out: it is billed to the landlord, and the tenant
      // statement doesn't invoice it either.
      if (inv && inv.kind !== "commission" && inv.contractId != null) {
        collectedByContract.set(inv.contractId, round2((collectedByContract.get(inv.contractId) ?? 0) + Number(col.amount)));
      }
    }
    // Only APPROVED (confirmed) commission invoices count — drafts never enter
    // the books.
    const commissionByContract = new Map<number, number>();
    for (const inv of invoices) {
      if (inv.kind !== "commission" || inv.status !== "confirmed" || inv.contractId == null) continue;
      commissionByContract.set(inv.contractId, round2((commissionByContract.get(inv.contractId) ?? 0) + Number(inv.total)));
    }
    const maintByContract = new Map<number, number>();
    for (const m of maint) {
      if (m.contractId == null || m.estimatedCost == null) continue;
      maintByContract.set(m.contractId, round2((maintByContract.get(m.contractId) ?? 0) + Number(m.estimatedCost)));
    }

    // Resolve each contract's landlord (owner) + property.
    const landlordOf = (c: any): { key: string; name: string; ownerId: number | null } => {
      const pid = contractProp.get(c.id);
      const prop = pid != null ? propById.get(pid) : null;
      let owner = prop?.ownerId != null ? ownerById.get(prop.ownerId) : null;
      // No owner via the property → match the contract's landlord snapshot
      // (id number, then name) to an owner record, so this contract groups under
      // the same owner key as that owner's expenses (no duplicate landlord row).
      if (!owner) {
        owner = (c.landlordIdNumber && ownerByIdNum.get(String(c.landlordIdNumber).trim()))
          || (c.landlordName && ownerByName.get(String(c.landlordName).trim().toLowerCase()))
          || null;
      }
      const ownerId = owner?.id ?? null;
      const name = owner?.name || c.landlordName || "—";
      return { key: ownerId != null ? `o:${ownerId}` : `n:${name}`, name, ownerId };
    };

    // ── Landlord statement / dues ──
    type LStat = { key: string; ownerId: number | null; landlord: string; rentCollected: number; commission: number; maintenance: number; expenses: number; net: number };
    const lmap = new Map<string, LStat>();
    const ensureL = (key: string, name: string, ownerId: number | null) => {
      let r = lmap.get(key);
      if (!r) { r = { key, ownerId, landlord: name, rentCollected: 0, commission: 0, maintenance: 0, expenses: 0, net: 0 }; lmap.set(key, r); }
      return r;
    };
    for (const c of contracts) {
      const { key, name, ownerId } = landlordOf(c);
      const r = ensureL(key, name, ownerId);
      // Rent/fees + any deposit taken as revenue for this contract.
      r.rentCollected = round2(r.rentCollected + (collectedByContract.get(c.id) ?? 0) + (convertedDepositByContract.get(c.id) ?? 0));
      r.commission = round2(r.commission + (commissionByContract.get(c.id) ?? 0));
      r.maintenance = round2(r.maintenance + (maintByContract.get(c.id) ?? 0));
    }
    // Expenses linked by ownerId or propertyId → owner.
    for (const e of expenses) {
      let ownerId: number | null = e.ownerId ?? null;
      if (ownerId == null && e.propertyId != null) ownerId = propById.get(e.propertyId)?.ownerId ?? null;
      if (ownerId == null) continue;
      const owner = ownerById.get(ownerId);
      const r = ensureL(`o:${ownerId}`, owner?.name || "—", ownerId);
      r.expenses = round2(r.expenses + Number(e.amount));
    }
    for (const r of lmap.values()) r.net = round2(r.rentCollected - r.commission - r.maintenance - r.expenses);

    const payoutByOwner = new Map<number, number>();
    for (const p of payouts) payoutByOwner.set(p.ownerId, round2((payoutByOwner.get(p.ownerId) ?? 0) + Number(p.amount)));

    const landlordStatement = [...lmap.values()].sort((a, b) => b.net - a.net);
    const landlordDues = landlordStatement.map((r) => {
      const transferred = r.ownerId != null ? (payoutByOwner.get(r.ownerId) ?? 0) : 0;
      return { landlord: r.landlord, ownerId: r.ownerId, net: r.net, transferred, remaining: round2(r.net - transferred) };
    });
    const landlordTransfers = landlordDues.map((r) => ({
      landlord: r.landlord, ownerId: r.ownerId, net: r.net, transferred: r.transferred,
      status: r.net <= 0.01 ? "none" : r.transferred >= r.net - 0.01 ? "transferred" : r.transferred > 0.01 ? "partial" : "pending",
    }));

    // ── Tenant statement / overdue ──
    const tenantById = new Map(tenants.map((t) => [t.id, t]));
    const contractTenant = new Map<number, { id: number | null; name: string }>();
    for (const c of contracts) contractTenant.set(c.id, { id: c.tenantId ?? null, name: c.tenantName || (c.tenantId != null ? tenantById.get(c.tenantId)?.name : null) || "—" });

    type TStat = { key: string; tenantId: number | null; tenant: string; invoiced: number; collected: number; deposit: number; balance: number };
    const tmap = new Map<string, TStat>();
    const ensureT = (id: number | null, name: string) => {
      const key = id != null ? `t:${id}` : `n:${name}`;
      let r = tmap.get(key);
      if (!r) { r = { key, tenantId: id, tenant: name, invoiced: 0, collected: 0, deposit: 0, balance: 0 }; tmap.set(key, r); }
      return r;
    };
    // Invoiced = APPROVED tenant documents, NET of credit/debit notes
    // (Approach 2): the original invoice is immutable, so the note's full value
    // (net + VAT) is subtracted (credit) / added (debit) here. e.g. a 1,150
    // invoice with a 230 credit note → 920 invoiced. Drafts never count.
    for (const inv of invoices) {
      if (inv.kind === "commission" || inv.kind === "deposit" || inv.kind === "receipt" || inv.status !== "confirmed") continue;
      if (inv.type !== "invoice" && inv.type !== "credit" && inv.type !== "debit") continue;
      const name = inv.tenantName || (inv.tenantId != null ? tenantById.get(inv.tenantId)?.name : null) || "—";
      const r = ensureT(inv.tenantId ?? null, name);
      const sign = inv.type === "credit" ? -1 : 1; // debit & invoice add, credit subtracts
      r.invoiced = round2(r.invoiced + sign * Number(inv.total));
    }
    // Collected per tenant (via their contracts), excluding deposit.
    for (const c of contracts) {
      const t = contractTenant.get(c.id)!;
      const r = ensureT(t.id, t.name);
      r.collected = round2(r.collected + (collectedByContract.get(c.id) ?? 0));
    }
    // Security deposit the tenant has paid (held trust money) — surfaced as a
    // separate figure so it reflects in the statement without distorting the
    // rent invoiced/collected/balance accounting.
    for (const inv of invoices) {
      if (inv.kind !== "deposit" || inv.status !== "confirmed") continue;
      // A deposit converted to revenue on termination is now counted in
      // `collected` — don't also show it as a held deposit.
      if (convertedDepositVoucherIds.has(inv.id)) continue;
      const name = inv.tenantName || (inv.tenantId != null ? tenantById.get(inv.tenantId)?.name : null) || "—";
      const r = ensureT(inv.tenantId ?? null, name);
      r.deposit = round2(r.deposit + Number(inv.total));
    }
    for (const r of tmap.values()) r.balance = round2(r.invoiced - r.collected);
    const tenantStatement = [...tmap.values()].sort((a, b) => b.balance - a.balance);

    // Overdue: unpaid/partial installments past due (exclude deposit, cancelled, paid).
    const todayMs = Date.now();
    const overdueMap = new Map<string, { tenantId: number | null; tenant: string; amount: number; days: number }>();
    for (const p of payments) {
      if (p.description === DEPOSIT_DESC) continue;
      // settled_external = collected outside the portal (historical) — never overdue.
      if (p.status === "paid" || p.status === "cancelled" || p.status === "settled_external") continue;
      const due = new Date(p.dueDate).getTime();
      if (!(due < todayMs)) continue; // only past due
      const collected = collections.filter((c) => c.paymentId === p.id).reduce((s, c) => s + Number(c.amount), 0);
      const remaining = round2(Number(p.amount) - collected);
      if (remaining <= 0.01) continue;
      const t = contractTenant.get(p.contractId) ?? { id: null, name: "—" };
      const key = t.id != null ? `t:${t.id}` : `n:${t.name}`;
      const days = Math.floor((todayMs - due) / 86400000);
      const cur = overdueMap.get(key) ?? { tenantId: t.id, tenant: t.name, amount: 0, days: 0 };
      cur.amount = round2(cur.amount + remaining);
      cur.days = Math.max(cur.days, days);
      overdueMap.set(key, cur);
    }
    const tenantOverdue = [...overdueMap.values()].sort((a, b) => b.amount - a.amount);

    // ── Revenue (company commission) per property ──
    const revByProp = new Map<number, { propertyId: number; property: string; landlord: string; rentCollected: number; commissionPct: number; commissionRevenue: number; otherFees: number }>();
    for (const c of contracts) {
      const pid = contractProp.get(c.id);
      if (pid == null) continue;
      const prop = propById.get(pid);
      if (!prop) continue;
      const { name: landlord } = landlordOf(c);
      const r = revByProp.get(pid) ?? {
        propertyId: pid, property: prop.name, landlord,
        rentCollected: 0, commissionPct: Number(prop.managementFeePercent ?? 0), commissionRevenue: 0, otherFees: 0,
      };
      r.rentCollected = round2(r.rentCollected + (collectedByContract.get(c.id) ?? 0));
      r.commissionRevenue = round2(r.commissionRevenue + (commissionByContract.get(c.id) ?? 0));
      revByProp.set(pid, r);
    }
    const revenue = [...revByProp.values()].sort((a, b) => b.commissionRevenue - a.commissionRevenue);
    const revenueTotal = round2(revenue.reduce((s, r) => s + r.commissionRevenue, 0));

    return { landlordStatement, landlordDues, landlordTransfers, tenantStatement, tenantOverdue, revenue, revenueTotal };
  }

  /* ── Expenses CRUD ── */
  @Get("expenses")
  @RequirePermissions(PERMISSIONS.EXPENSES_VIEW)
  async listExpenses(@CurrentUser() user: AuthUser) {
    return this.db.select().from(expensesTable)
      .where(and(eq(expensesTable.userId, scopeId(user)), isNull(expensesTable.deletedAt)));
  }

  @Post("expenses")
  @RequirePermissions(PERMISSIONS.EXPENSES_WRITE)
  async createExpense(@CurrentUser() user: AuthUser, @Body() body: any) {
    const amount = round2(Number(body?.amount));
    if (body?.ownerId == null) throw new BadRequestException("المؤجر مطلوب");
    if (body?.propertyId == null) throw new BadRequestException("العقار مطلوب");
    if (!body?.category || !String(body.category).trim()) throw new BadRequestException("البند مطلوب");
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException("المبلغ غير صالح");
    const [row] = await this.db.insert(expensesTable).values({
      userId: scopeId(user),
      propertyId: Number(body.propertyId),
      ownerId: Number(body.ownerId),
      category: String(body.category).trim(),
      amount: amount.toFixed(2),
      expenseDate: body?.expenseDate ?? null,
      notes: body?.notes ?? null,
    } as any).returning();
    return row;
  }

  @Delete("expenses/:id")
  @RequirePermissions(PERMISSIONS.EXPENSES_WRITE)
  async deleteExpense(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.db.update(expensesTable).set({ deletedAt: new Date() } as any)
      .where(and(eq(expensesTable.id, parseInt(id, 10)), eq(expensesTable.userId, scopeId(user))));
    return { ok: true };
  }

  /* ── Landlord payouts (transfers) CRUD ── */
  @Get("landlord-payouts")
  @RequirePermissions(PERMISSIONS.REPORTS_VIEW)
  async listPayouts(@CurrentUser() user: AuthUser) {
    return this.db.select().from(landlordPayoutsTable)
      .where(and(eq(landlordPayoutsTable.userId, scopeId(user)), isNull(landlordPayoutsTable.deletedAt)));
  }

  @Post("landlord-payouts")
  @RequirePermissions(PERMISSIONS.EXPENSES_WRITE)
  async createPayout(@CurrentUser() user: AuthUser, @Body() body: any) {
    const amount = round2(Number(body?.amount));
    const ownerId = Number(body?.ownerId);
    if (!Number.isFinite(ownerId)) throw new BadRequestException("المؤجر مطلوب");
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException("المبلغ غير صالح");
    const [row] = await this.db.insert(landlordPayoutsTable).values({
      userId: scopeId(user), ownerId, amount: amount.toFixed(2),
      transferDate: body?.transferDate ?? null, method: body?.method ?? null,
      reference: body?.reference ?? null, notes: body?.notes ?? null,
    } as any).returning();
    return row;
  }

  @Delete("landlord-payouts/:id")
  @RequirePermissions(PERMISSIONS.EXPENSES_WRITE)
  async deletePayout(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.db.update(landlordPayoutsTable).set({ deletedAt: new Date() } as any)
      .where(and(eq(landlordPayoutsTable.id, parseInt(id, 10)), eq(landlordPayoutsTable.userId, scopeId(user))));
    return { ok: true };
  }
}

@Module({ controllers: [ReportsController] })
export class ReportsModule {}
