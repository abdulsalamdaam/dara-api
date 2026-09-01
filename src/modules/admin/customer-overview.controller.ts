import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  companiesTable, contractsTable, lookupsTable, ownersTable, propertiesTable,
  rolesTable, tenantsTable, usersTable,
} from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../common/guards/roles.guard";
import { ParseInt4Pipe } from "../../common/int4.pipe";

/**
 * How many rows each preview list may return. The four lists on this screen
 * are previews — the true size of each set is in `totals`, so the UI can say
 * "showing 10 of 47" without this endpoint ever returning 47 rows. `?limit=`
 * can raise it as far as MAX and no further: a cap the client chooses is not a
 * cap.
 */
/**
 * 25 — the page size used everywhere else in the portal, and deliberately the
 * SAME number for the overview's previews and for one page of the list
 * endpoint. That identity is what lets the UI treat the overview's list as
 * page 1 and fetch only page 2 onward: if the preview held 10 and a page held
 * 25, "page 2" would start at row 26 and rows 11–25 would be unreachable.
 */
const PREVIEW_DEFAULT = 25;
const PREVIEW_MAX = 25;

function previewLimit(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return PREVIEW_DEFAULT;
  return Math.min(n, PREVIEW_MAX);
}

/**
 * The lists that can be paged. A whitelist rather than a lookup on whatever
 * string arrives: `entity` is used to pick a method on this controller, and an
 * unchecked string there would let a caller reach any property of it.
 */
const LIST_ENTITIES = ["landlords", "tenants", "properties", "contracts", "employees"] as const;
type ListEntity = (typeof LIST_ENTITIES)[number];

/** 1-based; anything unparseable, zero or negative is page 1. */
function pageNumber(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  // A page far past the end is not an error — it returns no rows and the true
  // total, so the UI can correct itself. But the offset must stay inside int4.
  return Math.min(n, 1_000_000);
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: string | number | null | undefined) => Number(v ?? 0) || 0;

/**
 * "Today" in Asia/Riyadh, as SQL — the same business timezone
 * `common/payment-status.ts` uses. The server's UTC date would flip an
 * installment to overdue three hours early for a Saudi landlord.
 */
const RIYADH_TODAY = sql`(now() at time zone 'Asia/Riyadh')::date`;

/**
 * Installment statuses that owe nothing.
 *
 * `cancelled` was never expected; `paid` is settled; `settled_external` is a
 * pre-onboarding opening balance that was never portal money. Everything else
 * (`pending`, `overdue`, `partially_paid`) can still owe the part of itself
 * that no collection covers.
 */
const NOT_OWING = sql`('cancelled','paid','settled_external')`;

/**
 * GET /api/admin/customers/:userId/overview — everything about one customer
 * account on one screen.
 *
 * A separate controller from `AdminController` only because that file is
 * already a thousand lines; the guards are identical, so this sits behind
 * `super_admin` exactly like every other `/admin/*` route.
 *
 * ## Two rules this endpoint is built around
 *
 * **1. Every figure is computed by the database.** Nothing here fetches a
 * table and reduces it in JavaScript. That pattern is how the admin stats,
 * the companies list and the login history all ended up reporting numbers
 * that described a capped slice rather than the account (see the comments on
 * those handlers), and it is worse on this screen than anywhere else: an
 * admin looks here precisely when a customer is disputing a figure.
 *
 * **2. The money agrees with the customer's own screens.** `payments.status`
 * is not a record of money — a cancelled installment can still hold a real
 * receipt, a `partially_paid` one holds less than its own amount, and
 * `settled_external` holds nothing at all. `payment_collections` is the only
 * truth about what came in. The definitions below are lifted from
 * `payments.module.ts` (the Payments card) and `mobile-landlord.module.ts`
 * (`buckets`), so this screen and the customer's dashboard cannot disagree.
 * `dashboard.module.ts` still derives its totals from `payments.status` and
 * is NOT the model followed here.
 *
 * ## One trap worth naming
 *
 * The correlated sub-selects below refer to their outer row by a written-out
 * `owners.id` / `contracts.id` rather than by interpolating the Drizzle
 * column. Drizzle renders a column of the query's own FROM table unqualified
 * in the select list — a bare `"id"` — and inside a sub-select that joins
 * `properties p` or `units u` that bare name silently resolves to the INNER
 * table. `properties.owner_id = "id"` would then have meant `p.owner_id =
 * p.id`: no error, a number for every row, and every one of them wrong.
 *
 * ## Query count
 *
 * Nine, and nine regardless of how much the customer owns: one to resolve the
 * account (which also answers the 404), then eight issued in parallel — three
 * single-row aggregate queries (totals, money, ZATCA) and one query per
 * preview list. Per-row counts inside the lists are correlated sub-selects
 * bounded by the same LIMIT as the list, never a query per row.
 */
@ApiTags("admin")
@ApiBearerAuth("user-jwt")
@Controller("admin/customers")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class AdminCustomerOverviewController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  @Get(":userId/overview")
  async overview(
    @Param("userId", ParseInt4Pipe) userId: number,
    @Query("limit") rawLimit?: string,
  ) {
    const limit = previewLimit(rawLimit);

    /* ── 1. Resolve the account, or 404 ──────────────────────────────────
     *
     * Data is scoped per ACCOUNT, not per user: `scopeId(user) =
     * ownerUserId ?? id`. So an id that belongs to an employee resolves to
     * the account they work under — the same resolution every other endpoint
     * makes — rather than returning an account-shaped object full of zeros.
     * `account.id` is always the account root, which is also the id this
     * endpoint should be called with. Both the requested row and the account
     * root must be alive; a soft-deleted account is a 404, not an empty one.
     */
    const account = await this.resolveAccount(userId);
    const acct = account.id;

    /* Every query below is scoped to `acct` in its own WHERE clause — there
     * is no query here that could return a row belonging to another
     * customer, including the ones that reach the account through a join
     * (units via properties, contract units via properties). */
    const [totalsRow, moneyRow, zatcaRow, landlords, tenants, properties, contracts, employees] =
      await Promise.all([
        this.totals(acct),
        this.money(acct),
        this.zatca(acct),
        this.landlords(acct, limit),
        this.tenants(acct, limit),
        this.properties(acct, limit),
        this.contracts(acct, limit),
        this.employees(acct, limit),
      ]);

    return {
      account,
      totals: totalsRow,
      money: moneyRow,
      zatca: zatcaRow,
      landlords,
      tenants,
      properties,
      contracts,
      employees,
    };
  }

  /**
   * One page of a single list.
   *
   * The overview's five lists are previews, and on an account with 26
   * landlords and 77 contracts a preview is a dead end — the UI could say
   * "showing 10 of 47" and offer no way to reach the other 37. This is how
   * it reaches them.
   *
   * Each list keeps the exact ORDER BY the overview uses, and every one of
   * those orderings ends in a unique id, so a row can neither be skipped nor
   * repeated as the admin pages through. `total` comes from the same counts
   * the overview reports, so "of N" cannot disagree between the two.
   */
  @Get(":userId/list/:entity")
  async list(
    @Param("userId", ParseInt4Pipe) userId: number,
    @Param("entity") entity: string,
    @Query("page") rawPage?: string,
    @Query("pageSize") rawPageSize?: string,
  ) {
    if (!(LIST_ENTITIES as readonly string[]).includes(entity)) {
      throw new BadRequestException(
        `قائمة غير معروفة · Unknown list "${entity}" — expected one of ${LIST_ENTITIES.join(", ")}`,
      );
    }
    const kind = entity as ListEntity;
    const pageSize = previewLimit(rawPageSize);
    const page = pageNumber(rawPage);

    const account = await this.resolveAccount(userId);
    const acct = account.id;

    const [totalsRow, data] = await Promise.all([
      this.totals(acct),
      this[kind](acct, pageSize, (page - 1) * pageSize),
    ]);

    const total = Number((totalsRow as Record<string, number>)[kind] ?? 0);
    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /**
   * Resolve a user id to the ACCOUNT it belongs to, or 404.
   *
   * Data is scoped per account, not per user: `scopeId(user) = ownerUserId ??
   * id`. So an id belonging to an employee resolves to the account they work
   * under — the same resolution every other endpoint makes — rather than
   * returning an account-shaped object full of zeros. Both the requested row
   * and the account root must be alive; a soft-deleted account is a 404, not
   * an empty one.
   */
  private async resolveAccount(userId: number) {
    const acctUser = alias(usersTable, "acct");
    const [account] = await this.db
      .select({
        id: acctUser.id,
        name: acctUser.name,
        email: acctUser.email,
        phone: acctUser.phone,
        userType: acctUser.userType,
        packagePlan: acctUser.packagePlan,
        subscriptionStatus: acctUser.subscriptionStatus,
        subscriptionEndsAt: acctUser.subscriptionEndsAt,
        isTrial: acctUser.subscriptionIsTrial,
        isActive: acctUser.isActive,
        accountStatus: acctUser.accountStatus,
        createdAt: acctUser.createdAt,
        lastLoginAt: acctUser.lastLoginAt,
        loginCount: acctUser.loginCount,
        companyName: companiesTable.name,
      })
      .from(usersTable)
      .innerJoin(acctUser, eq(acctUser.id, sql`coalesce(${usersTable.ownerUserId}, ${usersTable.id})`))
      .leftJoin(companiesTable, eq(companiesTable.id, acctUser.companyId))
      .where(and(
        eq(usersTable.id, userId),
        isNull(usersTable.deletedAt),
        isNull(acctUser.deletedAt),
      ))
      .limit(1);

    if (!account) throw new NotFoundException("الحساب غير موجود · Customer not found");
    return account;
  }

  /**
   * The eight set sizes, as eight correlated counts in ONE round trip.
   *
   * These are what let the UI render "showing 10 of 47" beside each preview
   * list, so they must count the whole set and not the preview.
   *
   * `invoices` counts the customer's billing documents (`simple_invoices`) —
   * what they issue day to day. E-invoices actually filed with ZATCA are a
   * different and much smaller number, reported as `zatca.invoicesSubmitted`.
   */
  private async totals(acct: number) {
    const [row] = await this.db
      .select({
        landlords: sql<number>`(select count(*)::int from owners o
          where o.user_id = ${acct} and o.deleted_at is null)`,
        tenants: sql<number>`(select count(*)::int from tenants t
          where t.user_id = ${acct} and t.deleted_at is null)`,
        properties: sql<number>`(select count(*)::int from properties p
          where p.user_id = ${acct} and p.deleted_at is null)`,
        // Units belong to the account through their property; a unit whose
        // property was soft-deleted is gone from the account too.
        units: sql<number>`(select count(*)::int from units u
          join properties p on p.id = u.property_id
          where p.user_id = ${acct} and u.deleted_at is null and p.deleted_at is null)`,
        contracts: sql<number>`(select count(*)::int from contracts c
          where c.user_id = ${acct} and c.deleted_at is null)`,
        activeContracts: sql<number>`(select count(*)::int from contracts c
          where c.user_id = ${acct} and c.deleted_at is null and c.status = 'active')`,
        invoices: sql<number>`(select count(*)::int from simple_invoices si
          where si.user_id = ${acct} and si.deleted_at is null)`,
        // Employees are sub-users: rows whose owner_user_id points at this
        // account. The account holder itself is never one of them.
        employees: sql<number>`(select count(*)::int from users e
          where e.owner_user_id = ${acct} and e.deleted_at is null)`,
      })
      .from(usersTable)
      .where(eq(usersTable.id, acct))
      .limit(1);
    return {
      landlords: Number(row?.landlords ?? 0),
      tenants: Number(row?.tenants ?? 0),
      properties: Number(row?.properties ?? 0),
      units: Number(row?.units ?? 0),
      contracts: Number(row?.contracts ?? 0),
      activeContracts: Number(row?.activeContracts ?? 0),
      invoices: Number(row?.invoices ?? 0),
      employees: Number(row?.employees ?? 0),
    };
  }

  /**
   * The four money figures, in ONE round trip.
   *
   *  - **collected** — every riyal recorded as received: the whole
   *    `payment_collections` log for the account, plus collected invoices
   *    that never produced a collection row. Collections against an
   *    installment that has since been soft-deleted drop out; collections
   *    with no installment behind them at all (a commission invoice, an
   *    advance receipted on its own) are real money and stay. Same
   *    definition as `stats.collected` on `GET /payments`.
   *  - **outstanding** — what is still owed: for every installment that is
   *    not cancelled/paid/settled-external, `amount − collected`, counted
   *    only when more than a halala remains. A partially collected
   *    installment therefore contributes its collected part to `collected`
   *    and its remainder here, which is exactly what `buckets()` in
   *    `mobile-landlord.module.ts` does. Reading `payments.status` instead
   *    loses both halves of such a row.
   *  - **overdue** — the part of `outstanding` already past its due date in
   *    Asia/Riyadh. A subset of `outstanding`, never added to it.
   *  - **monthlyRecurring** — the monthly rent of the account's ACTIVE
   *    contracts. A commitment, not cash; the one figure here that does not
   *    come from the collection log.
   */
  private async money(acct: number) {
    const [row] = await this.db
      .select({
        // Every collection logged against the account. The left join exists
        // only to test the parent installment's tombstone.
        collectedLogged: sql<string>`(select coalesce(sum(pc.amount), 0)
          from payment_collections pc
          left join payments p on p.id = pc.payment_id
          where pc.user_id = ${acct}
            and (pc.payment_id is null or p.deleted_at is null))`,
        // Money collected on an invoice with no installment behind it that
        // never produced a collection row either. It shows on the customer's
        // Payments card, so leaving it out here would understate them by
        // exactly its sum. Vouchers are excluded: they are evidence of money
        // already counted, not a second collection of it.
        collectedFree: sql<string>`(select coalesce(sum(si.total), 0)
          from simple_invoices si
          where si.user_id = ${acct}
            and si.status = 'confirmed'
            and si.type = 'invoice'
            and si.payment_id is null
            and si.deleted_at is null
            and si.paid_date is not null
            and (si.kind is null or (si.kind <> 'deposit' and si.kind <> 'receipt'))
            and not exists (select 1 from payment_collections pc
                            where pc.invoice_id = si.id))`,
        outstanding: sql<string>`(select coalesce(sum(t.remaining), 0) from (
            select p.amount - coalesce((select sum(pc.amount) from payment_collections pc
                                        where pc.payment_id = p.id), 0) as remaining
            from payments p
            where p.user_id = ${acct}
              and p.deleted_at is null
              and p.status not in ${NOT_OWING}
          ) t where t.remaining > 0.01)`,
        overdue: sql<string>`(select coalesce(sum(t.remaining), 0) from (
            select p.amount - coalesce((select sum(pc.amount) from payment_collections pc
                                        where pc.payment_id = p.id), 0) as remaining
            from payments p
            where p.user_id = ${acct}
              and p.deleted_at is null
              and p.status not in ${NOT_OWING}
              and p.due_date < ${RIYADH_TODAY}
          ) t where t.remaining > 0.01)`,
        monthlyRecurring: sql<string>`(select coalesce(sum(c.monthly_rent), 0)
          from contracts c
          where c.user_id = ${acct} and c.deleted_at is null and c.status = 'active')`,
      })
      .from(usersTable)
      .where(eq(usersTable.id, acct))
      .limit(1);

    return {
      collected: round2(num(row?.collectedLogged) + num(row?.collectedFree)),
      outstanding: round2(num(row?.outstanding)),
      overdue: round2(num(row?.overdue)),
      monthlyRecurring: round2(num(row?.monthlyRecurring)),
    };
  }

  /**
   * ZATCA footprint, or `null` when the customer has none at all.
   *
   * `null` means the account has no landlords, no credentials and nothing ever
   * filed — a real answer, and different from an account that has landlords but
   * has submitted nothing.
   *
   *  - `landlordsTotal` — EVERY landlord, not only the VAT-registered ones.
   *    Since a tax invoice may only be issued by a linked seller, an unlinked
   *    landlord is blocked whatever their registration says — so counting only
   *    the registered ones made this read "5 of 5, green" for an account with
   *    47 more landlords that could not approve anything. The denominator has
   *    to be the population the rule applies to, and that is all of them.
   *  - `landlordsOnboarded` — landlords whose CURRENT environment actually
   *    holds complete CSID material. This is `isOnboarded()` from
   *    `common/invoice-readiness.ts` expressed in SQL, and it is deliberately
   *    stricter than "has a credentials row": a row whose `active_environment`
   *    points at an empty slot blocks every invoice that landlord issues, and
   *    that exact state has happened in production.
   *  - `environments` — which environments those credentials sit in. Worth
   *    surfacing on its own: a landlord live in the product but still on
   *    `sandbox` is filing invoices to the developer portal, which means to
   *    ZATCA they do not exist.
   *  - `invoicesSubmitted` / `lastSubmissionAt` — e-invoices actually sent
   *    (`submitted_at` set), whatever ZATCA then answered.
   */
  private async zatca(acct: number) {
    // Must stay in step with `isOnboarded()` in common/invoice-readiness.ts —
    // including the link-health flag, which is the whole point of it: a seller
    // whose link ZATCA has revoked still holds every certificate column, so
    // without this clause the admin 360 view reports "integrated" for precisely
    // the account that cannot issue a single invoice.
    const onboardedSql = sql`z.link_invalid_at is null and case when z.active_environment = 'sandbox'
        then (z.sandbox_cert_pem is not null and z.sandbox_private_key_enc is not null
              and z.sandbox_binary_security_token is not null and z.sandbox_secret_enc is not null)
        else (z.prod_cert_pem is not null and z.prod_private_key_enc is not null
              and z.prod_binary_security_token is not null and z.prod_secret_enc is not null)
      end`;

    const [row] = await this.db
      .select({
        credentials: sql<number>`(select count(*)::int from zatca_credentials z
          where z.user_id = ${acct} and z.deleted_at is null)`,
        landlordsTotal: sql<number>`(select count(*)::int from owners o
          where o.user_id = ${acct} and o.deleted_at is null)`,
        // Landlord rows only: the account-level seller (owner_id null) is not a
        // landlord, and counting it here let the numerator exceed the
        // denominator.
        landlordsOnboarded: sql<number>`(select count(*)::int from zatca_credentials z
          where z.user_id = ${acct} and z.owner_id is not null
            and z.deleted_at is null and ${onboardedSql})`,
        environments: sql<string[] | null>`(select array_agg(distinct z.active_environment::text)
          from zatca_credentials z
          where z.user_id = ${acct} and z.deleted_at is null)`,
        invoicesSubmitted: sql<number>`(select count(*)::int from invoices i
          where i.user_id = ${acct} and i.deleted_at is null and i.submitted_at is not null)`,
        // Formatted in SQL rather than returned raw. Drizzle's node-postgres
        // driver turns off pg's own timestamp parsing and converts via the
        // column mapper instead — a raw `sql` fragment has no mapper, so this
        // came back as Postgres' own text form (`2026-06-28 05:25:59.913+00`),
        // which is not what `JSON.stringify` gives every other timestamp on
        // this response and not what `new Date()` reliably parses. Emitting
        // ISO-8601 here makes the field indistinguishable from the Date-backed
        // ones on the wire.
        lastSubmissionAt: sql<string | null>`(select to_char(max(i.submitted_at) at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          from invoices i
          where i.user_id = ${acct} and i.deleted_at is null)`,
      })
      .from(usersTable)
      .where(eq(usersTable.id, acct))
      .limit(1);

    const credentials = Number(row?.credentials ?? 0);
    const landlordsTotal = Number(row?.landlordsTotal ?? 0);
    const invoicesSubmitted = Number(row?.invoicesSubmitted ?? 0);
    if (credentials === 0 && landlordsTotal === 0 && invoicesSubmitted === 0) return null;

    return {
      landlordsTotal,
      landlordsOnboarded: Number(row?.landlordsOnboarded ?? 0),
      environments: [...(row?.environments ?? [])].sort(),
      invoicesSubmitted,
      lastSubmissionAt: row?.lastSubmissionAt ?? null,
    };
  }

  /** Landlords, biggest portfolio first. */
  private landlords(acct: number, limit: number, offset = 0) {
    return this.db
      .select({
        id: ownersTable.id,
        name: ownersTable.name,
        type: ownersTable.type,
        phone: ownersTable.phone,
        vatNumber: ownersTable.taxNumber,
        propertiesCount: sql<number>`(select count(*)::int from properties p
          where p.owner_id = owners.id and p.user_id = ${acct}
            and p.deleted_at is null)`.as("properties_count"),
        // A landlord's contracts are reached contract → unit → property →
        // owner, so the same contract spanning several of their units counts
        // once. The property is re-scoped to the account inside the join:
        // the link table alone would not stop a stray row from another
        // account being counted here.
        contractsCount: sql<number>`(select count(distinct cu.contract_id)::int
          from contract_units cu
          join units u on u.id = cu.unit_id and u.deleted_at is null
          join properties p on p.id = u.property_id and p.deleted_at is null
          join contracts c on c.id = cu.contract_id and c.deleted_at is null
                           and c.user_id = ${acct}
          where p.owner_id = owners.id and p.user_id = ${acct})`.as("contracts_count"),
      })
      .from(ownersTable)
      .where(and(eq(ownersTable.userId, acct), isNull(ownersTable.deletedAt)))
      .orderBy(sql`properties_count desc, contracts_count desc, owners.id desc`)
      .limit(limit)
      .offset(offset);
  }

  /** Tenants, most contracts first. */
  private tenants(acct: number, limit: number, offset = 0) {
    return this.db
      .select({
        id: tenantsTable.id,
        name: tenantsTable.name,
        phone: tenantsTable.phone,
        status: tenantsTable.status,
        contractsCount: sql<number>`(select count(*)::int from contracts c
          where c.tenant_id = tenants.id and c.user_id = ${acct}
            and c.deleted_at is null)`.as("contracts_count"),
      })
      .from(tenantsTable)
      .where(and(eq(tenantsTable.userId, acct), isNull(tenantsTable.deletedAt)))
      .orderBy(sql`contracts_count desc, ${tenantsTable.createdAt} desc, tenants.id desc`)
      .limit(limit)
      .offset(offset);
  }

  /** Properties, largest first. `city` is a lookup, not a column. */
  private properties(acct: number, limit: number, offset = 0) {
    return this.db
      .select({
        id: propertiesTable.id,
        name: propertiesTable.name,
        city: lookupsTable.labelAr,
        unitsCount: sql<number>`(select count(*)::int from units u
          where u.property_id = properties.id and u.deleted_at is null)`.as("units_count"),
        occupiedUnits: sql<number>`(select count(*)::int from units u
          where u.property_id = properties.id and u.deleted_at is null
            and u.status = 'rented')`.as("occupied_units"),
      })
      .from(propertiesTable)
      .leftJoin(lookupsTable, eq(lookupsTable.id, propertiesTable.cityLookupId))
      .where(and(eq(propertiesTable.userId, acct), isNull(propertiesTable.deletedAt)))
      .orderBy(sql`units_count desc, ${propertiesTable.createdAt} desc, properties.id desc`)
      .limit(limit)
      .offset(offset);
  }

  /** Contracts, live ones first, then the most recently started. */
  private contracts(acct: number, limit: number, offset = 0) {
    return this.db
      .select({
        id: contractsTable.id,
        contractNumber: contractsTable.contractNumber,
        tenantName: contractsTable.tenantName,
        // A contract can span several units of one property, so the property
        // is the first linked unit's and the label lists them all. Both
        // sub-selects re-assert `p.user_id`, so a link into another account's
        // property can never name it here.
        propertyName: sql<string | null>`(select p.name
          from contract_units cu
          join units u on u.id = cu.unit_id and u.deleted_at is null
          join properties p on p.id = u.property_id and p.deleted_at is null
                            and p.user_id = ${acct}
          where cu.contract_id = contracts.id
          order by cu.id limit 1)`,
        unitLabel: sql<string | null>`(select string_agg(u.unit_number, '، ' order by u.unit_number)
          from contract_units cu
          join units u on u.id = cu.unit_id and u.deleted_at is null
          join properties p on p.id = u.property_id and p.deleted_at is null
                            and p.user_id = ${acct}
          where cu.contract_id = contracts.id)`,
        startDate: contractsTable.startDate,
        endDate: contractsTable.endDate,
        status: contractsTable.status,
        monthlyRent: contractsTable.monthlyRent,
      })
      .from(contractsTable)
      .where(and(eq(contractsTable.userId, acct), isNull(contractsTable.deletedAt)))
      .orderBy(
        sql`(${contractsTable.status} = 'active') desc`,
        desc(contractsTable.startDate),
        desc(contractsTable.id),
      )
      .limit(limit)
      .offset(offset);
  }

  /**
   * Employees — the account's sub-users, most recently seen first.
   *
   * Sub-users are found by `owner_user_id`, never by role key: the role lives
   * on `roles` (joined through `users.role_id`) and says what someone may do,
   * not whose account they belong to.
   */
  private employees(acct: number, limit: number, offset = 0) {
    return this.db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        roleKey: rolesTable.key,
        isActive: usersTable.isActive,
        lastLoginAt: usersTable.lastLoginAt,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(rolesTable.id, usersTable.roleId))
      .where(and(eq(usersTable.ownerUserId, acct), isNull(usersTable.deletedAt)))
      .orderBy(
        sql`${usersTable.lastLoginAt} desc nulls last`,
        desc(usersTable.createdAt),
        desc(usersTable.id),
      )
      .limit(limit)
      .offset(offset);
  }
}
