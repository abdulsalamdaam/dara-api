import { Controller, Get, Inject, Module, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { propertiesTable, unitsTable, contractsTable, paymentsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { liveStatus, riyadhToday } from "../../common/payment-status";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

@ApiTags("dashboard")
@ApiBearerAuth("user-jwt")
@Controller("dashboard")
@UseGuards(JwtAuthGuard)
class DashboardController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  @Get("summary")
  async summary(@CurrentUser() user: AuthUser) {
    // scopeId so employees see their owner's data — same scope the rest
    // of the app uses; user.id alone would show empty stats for employees.
    const userId = scopeId(user);
    const num = (s: string | null) => parseFloat(s || "0") || 0;

    // Soft-deleted rows must be excluded from every count/total.
    const userProps = await this.db
      .select({ id: propertiesTable.id })
      .from(propertiesTable)
      .where(and(eq(propertiesTable.userId, userId), isNull(propertiesTable.deletedAt)));
    const propIds = userProps.map(p => p.id);
    const propertiesCount = propIds.length;

    let unitCount = 0;
    let activeContractsCount = 0;
    let monthlyRevenue = 0;     // money actually COLLECTED this month
    let collectedTotal = 0;     // money collected lifetime
    let monthlyRecurring = 0;   // active rent commitment / month
    let pendingDue = 0;         // unpaid (pending + overdue) outstanding amount
    let overduePaymentsCount = 0;
    let rentedUnitsCount = 0;
    let availableUnitsCount = 0;
    let maintenanceUnitsCount = 0;

    if (propIds.length > 0) {
      const units = await this.db
        .select()
        .from(unitsTable)
        .where(and(inArray(unitsTable.propertyId, propIds), isNull(unitsTable.deletedAt)));
      unitCount = units.length;
      rentedUnitsCount = units.filter(u => u.status === "rented").length;
      availableUnitsCount = units.filter(u => u.status === "available").length;
      maintenanceUnitsCount = units.filter(u => u.status === "maintenance").length;
    }

    const contracts = await this.db
      .select()
      .from(contractsTable)
      .where(and(eq(contractsTable.userId, userId), isNull(contractsTable.deletedAt)));
    activeContractsCount = contracts.filter(c => c.status === "active").length;
    monthlyRecurring = contracts
      .filter(c => c.status === "active")
      .reduce((s, c) => s + num(c.monthlyRent), 0);

    const payments = await this.db
      .select()
      .from(paymentsTable)
      .where(and(eq(paymentsTable.userId, userId), isNull(paymentsTable.deletedAt)));
    // Derived, not stored: nothing ever writes 'overdue', so filtering the
    // stored column made this counter permanently zero.
    const paymentStatus = (p: typeof payments[number]) => liveStatus(p.status as string, p.dueDate as unknown as string);
    overduePaymentsCount = payments.filter(p => paymentStatus(p) === "overdue").length;

    const now = new Date();
    const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    collectedTotal = payments
      .filter(p => p.status === "paid")
      .reduce((s, p) => s + num(p.amount), 0);

    monthlyRevenue = payments
      .filter(p => p.status === "paid" && p.paidDate && p.paidDate.startsWith(currentKey))
      .reduce((s, p) => s + num(p.amount), 0);

    pendingDue = payments
      .filter(p => { const s = paymentStatus(p); return s === "pending" || s === "overdue"; })
      .reduce((s, p) => s + num(p.amount), 0);

    // The money behind `overduePaymentsCount`. The portal printed "0 SAR
    // overdue" beside a non-zero count because this figure did not exist.
    const overdueAmount = round2(payments
      .filter(p => paymentStatus(p) === "overdue")
      .reduce((s, p) => s + num(p.amount), 0));

    // Collected per calendar month of the current (Riyadh) year — the revenue
    // chart. The portal used to download every installment the account had
    // to add these twelve numbers up in the browser. Same rule it used:
    // revenue is recognised when collected (paidDate), falling back to the
    // due date for a paid row with no paid date on it.
    const revenueYear = Number(riyadhToday().slice(0, 4));
    const monthlyPaid: number[] = Array(12).fill(0);
    for (const p of payments) {
      if (p.status !== "paid") continue;
      const d = String(p.paidDate || p.dueDate || "");
      if (Number(d.slice(0, 4)) !== revenueYear) continue;
      const m = Number(d.slice(5, 7)) - 1;
      if (m >= 0 && m < 12) monthlyPaid[m] += num(p.amount);
    }

    const occupancyRate = unitCount > 0 ? Math.round((rentedUnitsCount / unitCount) * 100) : 0;

    return {
      propertiesCount,
      unitsCount: unitCount,
      activeContractsCount,
      // monthlyRevenue is now actual collected this month (was: contract rent commitment).
      monthlyRevenue,
      monthlyRecurring,
      collectedTotal,
      pendingDue,
      overduePaymentsCount,
      occupancyRate,
      rentedUnitsCount,
      availableUnitsCount,
      maintenanceUnitsCount,
      overdueAmount,
      revenueByMonth: { year: revenueYear, months: monthlyPaid.map(round2) },
    };
  }
}

@Module({ controllers: [DashboardController] })
export class DashboardModule {}
