import { Controller, Get, Inject, Module, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { propertiesTable, unitsTable, contractsTable, paymentsTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { liveStatusSql, riyadhToday } from "../../common/payment-status";
import { FinanceV2Hooks } from "../finance-v2/hooks/hooks.service"; // finance-v2: E2/E4 fork (DESIGN §9)
import { isLegacyCall } from "../finance-v2/legacy-call"; // finance-v2:

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Legacy deposit installments — held money, not rent; the payments list hides them. */
const DEPOSIT_DESC = "تأمين (وديعة)";

/** The payment figures as finance-v2 receives them — it overwrites every one. */
const emptyPaymentFigures = () => ({
  monthlyRevenue: 0, collectedTotal: 0, pendingDue: 0, overduePaymentsCount: 0, overdueAmount: 0,
  revenueByMonth: { year: Number(riyadhToday().slice(0, 4)), months: Array(12).fill(0) as number[] },
});

@ApiTags("dashboard")
@ApiBearerAuth("user-jwt")
@Controller("dashboard")
@UseGuards(JwtAuthGuard)
class DashboardController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}
  @Inject(FinanceV2Hooks) private readonly fv2h?: FinanceV2Hooks; // finance-v2: property-injected, so the constructor is untouched

  /**
   * The landlord dashboard's headline numbers.
   *
   * Every figure is a SQL aggregate (`count(*) filter (...)` / `sum(...)`).
   * This used to load the account's whole properties, units, contracts and
   * payments tables into memory just to count and add them up. The rules are
   * unchanged, with one deliberate exception: deposit rows (`DEPOSIT_DESC`)
   * no longer count towards `overduePaymentsCount`, `overdueAmount` or
   * `pendingDue` - the payments list already hides them (a deposit is held,
   * not owed as rent), so the dashboard counted installments nobody could
   * find on the Installments tab.
   *
   * With finance-v2 on, `dashboardV2` replaces every payment-derived figure,
   * so the legacy payment aggregate is not run at all on that path.
   */
  @Get("summary")
  async summary(@CurrentUser() user: AuthUser) {
    // scopeId so employees see their owner's data — same scope the rest
    // of the app uses; user.id alone would show empty stats for employees.
    const userId = scopeId(user);
    if (!isLegacyCall(user) && (await this.fv2h?.resolve(userId)) === true) {
      // finance-v2: E2/E4 values over the legacy result — the payment figures
      // below are all overridden, so they are left at zero rather than computed.
      return this.fv2h!.dashboardSummary(userId, { ...(await this.portfolio(userId)), ...emptyPaymentFigures() });
    }
    const [portfolio, money] = await Promise.all([this.portfolio(userId), this.paymentFigures(userId)]);
    return { ...portfolio, ...money };
  }

  /** Properties, units and contracts — the figures finance-v2 leaves alone. */
  private async portfolio(userId: number) {
    // Soft-deleted rows must be excluded from every count/total — a unit
    // counts only under a live property, as before.
    const [[props], [units], [contracts]] = await Promise.all([
      this.db.select({ n: count() }).from(propertiesTable)
        .where(and(eq(propertiesTable.userId, userId), isNull(propertiesTable.deletedAt))),
      this.db.select({
        n: count(),
        rented: sql<number>`count(*) filter (where ${unitsTable.status} = 'rented')::int`,
        available: sql<number>`count(*) filter (where ${unitsTable.status} = 'available')::int`,
        maintenance: sql<number>`count(*) filter (where ${unitsTable.status} = 'maintenance')::int`,
      }).from(unitsTable)
        .innerJoin(propertiesTable, eq(propertiesTable.id, unitsTable.propertyId))
        .where(and(eq(propertiesTable.userId, userId), isNull(propertiesTable.deletedAt), isNull(unitsTable.deletedAt))),
      this.db.select({
        active: sql<number>`count(*) filter (where ${contractsTable.status} = 'active')::int`,
        recurring: sql<string>`coalesce(sum(${contractsTable.monthlyRent}) filter (where ${contractsTable.status} = 'active'), 0)::text`,
      }).from(contractsTable)
        .where(and(eq(contractsTable.userId, userId), isNull(contractsTable.deletedAt))),
    ]);
    const unitCount = Number(units?.n ?? 0);
    const rentedUnitsCount = Number(units?.rented ?? 0);
    return {
      propertiesCount: Number(props?.n ?? 0),
      unitsCount: unitCount,
      activeContractsCount: Number(contracts?.active ?? 0),
      monthlyRecurring: Number(contracts?.recurring ?? 0), // active rent commitment / month
      occupancyRate: unitCount > 0 ? Math.round((rentedUnitsCount / unitCount) * 100) : 0,
      rentedUnitsCount,
      availableUnitsCount: Number(units?.available ?? 0),
      maintenanceUnitsCount: Number(units?.maintenance ?? 0),
    };
  }

  /** Installment money — collected, outstanding, overdue, and the revenue chart. */
  private async paymentFigures(userId: number) {
    const p = paymentsTable;
    const scope = and(eq(p.userId, userId), isNull(p.deletedAt));
    // Derived, not stored: nothing ever writes 'overdue', so filtering the
    // stored column made this counter permanently zero.
    const live = liveStatusSql;
    const notDeposit = sql`coalesce(${p.description}, '') <> ${DEPOSIT_DESC}`;

    // "This month" for `monthlyRevenue` is the server's calendar month, as it
    // has always been; the chart's year is the Riyadh year.
    const now = new Date();
    const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const revenueYear = Number(riyadhToday().slice(0, 4));

    // Collected per calendar month of the current (Riyadh) year — the revenue
    // chart. Revenue is recognised when collected (paidDate), falling back to
    // the due date for a paid row with no paid date on it.
    const revenueDate = sql`coalesce(${p.paidDate}, ${p.dueDate})`;
    const [[agg], monthRows] = await Promise.all([
      this.db.select({
        collectedTotal: sql<string>`coalesce(sum(${p.amount}) filter (where ${p.status} = 'paid'), 0)::text`,
        monthlyRevenue: sql<string>`coalesce(sum(${p.amount}) filter (where ${p.status} = 'paid' and to_char(${p.paidDate}, 'YYYY-MM') = ${currentKey}), 0)::text`,
        pendingDue: sql<string>`coalesce(sum(${p.amount}) filter (where ${live} in ('pending', 'overdue') and ${notDeposit}), 0)::text`,
        overdueCount: sql<number>`count(*) filter (where ${live} = 'overdue' and ${notDeposit})::int`,
        overdueAmount: sql<string>`coalesce(sum(${p.amount}) filter (where ${live} = 'overdue' and ${notDeposit}), 0)::text`,
      }).from(p).where(scope),
      // GROUP BY the ordinal: the month expression is not repeated, so no
      // SELECT/GROUP BY parameter mismatch is possible.
      this.db.select({
        m: sql<number>`extract(month from ${revenueDate})::int`,
        amount: sql<string>`sum(${p.amount})::text`,
      }).from(p)
        .where(and(scope, eq(p.status, "paid"), sql`extract(year from ${revenueDate}) = ${revenueYear}`))
        .groupBy(sql`1`),
    ]);
    const monthlyPaid: number[] = Array(12).fill(0);
    for (const r of monthRows) {
      const m = Number(r.m) - 1;
      if (m >= 0 && m < 12) monthlyPaid[m] = Number(r.amount ?? 0);
    }
    return {
      // monthlyRevenue is actual collected this month (was: contract rent commitment).
      monthlyRevenue: Number(agg?.monthlyRevenue ?? 0),
      collectedTotal: Number(agg?.collectedTotal ?? 0), // money collected lifetime
      pendingDue: Number(agg?.pendingDue ?? 0), // unpaid (pending + overdue) outstanding amount
      overduePaymentsCount: Number(agg?.overdueCount ?? 0),
      // The money behind `overduePaymentsCount`. The portal printed "0 SAR
      // overdue" beside a non-zero count because this figure did not exist.
      overdueAmount: round2(Number(agg?.overdueAmount ?? 0)),
      revenueByMonth: { year: revenueYear, months: monthlyPaid.map(round2) },
    };
  }
}

@Module({ controllers: [DashboardController] })
export class DashboardModule {}
