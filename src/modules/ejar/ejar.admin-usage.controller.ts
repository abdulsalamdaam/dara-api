import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { sql, type SQL } from "drizzle-orm";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { JwtAuthGuard, type AuthUser } from "../../common/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../../common/guards/roles.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { likeContains, listQuerySchema, parseDateBound } from "../../common/pagination";
import { computeBudget, lookupConfig, windowBounds } from "./ejar.budget";
import { ejarLookupUsage, SUCCESS_SQL, WRONG_NUMBER_SQL } from "./ejar.usage";
import { poolUsed, readPoolSetting, writePoolSetting } from "./ejar.pool";

/**
 * Admin › Ejar usage — the 360 view of every Ejar call: the purchased pool
 * (e.g. 500 calls) and what is left of it, who spent it (account → user),
 * every error, per endpoint and per day, and the call log itself.
 *
 * Only successful calls are deducted (SUCCESS_SQL); errors are shown but
 * free. Platform staff only — the log carries Ejar response bodies (tenants'
 * IDs, phones), which is why the customer-facing log stays account-scoped.
 */

export const OUTCOMES = ["success", "wrong_number", "client_error", "server_error", "network", "blocked"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** One label per log row; `l` is ejar_api_logs. Order matters: blocked, then wrong number, then by status. */
const OUTCOME_SQL = sql`(case
  when l.env = 'blocked' then 'blocked'
  when ${WRONG_NUMBER_SQL} then 'wrong_number'
  when l.status between 200 and 299 then 'success'
  when l.status is null then 'network'
  when l.status >= 500 then 'server_error'
  else 'client_error' end)`;

/** Taken off the pool and the allowances. */
const DEDUCTED_SQL = sql`(l.env like 'balady%' and ${SUCCESS_SQL})`;

/** The contract the call was about: its number, else the Ejar UUID. */
const CONTRACT_SQL = sql`coalesce(l.params ->> 'contractNumber', l.params ->> 'contract_ids', l.params ->> 'uuid')`;

const rowsOf = <T>(res: unknown): T[] => (Array.isArray(res) ? res : (res as { rows?: T[] })?.rows ?? []) as T[];
const posInt = (raw: unknown): number | undefined => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : undefined;
};

interface UsageFilter {
  from: string;
  to: string | undefined;
  accountId?: number;
  userId?: number;
  endpoint?: string;
  outcome?: Outcome;
  search?: string;
}

/** Riyadh calendar days. Without `from` the window is the last 30 days. */
function parseFilter(q: Record<string, unknown>): UsageFilter {
  const from = parseDateBound(q.from) ?? new Date(Date.now() + 3 * 3_600_000 - 29 * 86_400_000).toISOString().slice(0, 10);
  const outcome = typeof q.outcome === "string" && (OUTCOMES as readonly string[]).includes(q.outcome) ? (q.outcome as Outcome) : undefined;
  const endpoint = typeof q.endpoint === "string" && /^[A-Za-z]{1,64}$/.test(q.endpoint) ? q.endpoint : undefined;
  const search = typeof q.search === "string" && q.search.trim() ? q.search.trim().slice(0, 100) : undefined;
  return { from, to: parseDateBound(q.to), accountId: posInt(q.accountId), userId: posInt(q.userId), endpoint, outcome, search };
}

/** The WHERE for a filter; joins `u` (caller) and `a` (its account) must be in scope. */
function whereOf(f: UsageFilter, opts: { outcome?: boolean } = {}): SQL {
  const conds: SQL[] = [sql`l.created_at >= (${f.from}::date)::timestamp at time zone 'Asia/Riyadh'`];
  if (f.to) conds.push(sql`l.created_at < ((${f.to}::date + 1)::timestamp at time zone 'Asia/Riyadh')`);
  if (f.accountId) conds.push(sql`coalesce(u.owner_user_id, u.id) = ${f.accountId}`);
  if (f.userId) conds.push(sql`l.user_id = ${f.userId}`);
  if (f.endpoint) conds.push(sql`l.endpoint = ${f.endpoint}`);
  if (opts.outcome !== false && f.outcome) conds.push(sql`${OUTCOME_SQL} = ${f.outcome}`);
  if (f.search) {
    const like = likeContains(f.search);
    conds.push(sql`(a.name ilike ${like} or a.email ilike ${like} or u.name ilike ${like} or u.email ilike ${like}
      or ${CONTRACT_SQL} ilike ${like} or l.transaction_id ilike ${like})`);
  }
  return sql.join(conds, sql` and `);
}

const FROM = sql`from ejar_api_logs l
  left join users u on u.id = l.user_id
  left join users a on a.id = coalesce(u.owner_user_id, u.id)`;

/** The counters every grouping reports. */
const COUNTS = sql`
  count(*)::int as calls,
  (count(*) filter (where ${DEDUCTED_SQL}))::int as deducted,
  (count(*) filter (where ${OUTCOME_SQL} = 'success'))::int as success,
  (count(*) filter (where ${OUTCOME_SQL} = 'wrong_number'))::int as "wrongNumber",
  (count(*) filter (where ${OUTCOME_SQL} = 'client_error'))::int as "clientError",
  (count(*) filter (where ${OUTCOME_SQL} = 'server_error'))::int as "serverError",
  (count(*) filter (where ${OUTCOME_SQL} = 'network'))::int as network,
  (count(*) filter (where ${OUTCOME_SQL} = 'blocked'))::int as blocked`;

@ApiTags("admin")
@ApiBearerAuth("user-jwt")
@Controller("admin/ejar-usage")
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class AdminEjarUsageController {
  constructor(@Inject(DRIZZLE) private readonly db: Drizzle) {}

  /** Pool, gateway budget, totals, per endpoint / day / account (with its users), top errors. */
  @Get()
  async summary(@Query() q: Record<string, unknown>) {
    const f = parseFilter(q);
    const where = whereOf(f);

    const [setting, cfg] = [await readPoolSetting(this.db), lookupConfig(process.env)];
    const { start } = windowBounds(cfg.window);
    const [poolSpent, poolErrors, gatewayUsage] = await Promise.all([
      poolUsed(this.db, setting.since),
      this.db.execute(sql`select count(*)::int as n from ejar_api_logs l
        where l.env like 'balady%' and not ${SUCCESS_SQL} and l.created_at >= ${setting.since}::timestamptz`),
      ejarLookupUsage(this.db, start, 0),
    ]);
    const gateway = computeBudget(cfg, gatewayUsage);

    const [totals, byEndpoint, daily, byAccount, byUser, topErrors] = await Promise.all([
      this.db.execute(sql`select ${COUNTS},
          coalesce(round(avg(l.duration_ms)), 0)::int as "avgMs",
          (count(distinct coalesce(u.owner_user_id, u.id)))::int as accounts,
          (count(distinct l.user_id))::int as users,
          (count(distinct ${CONTRACT_SQL}) filter (where l.endpoint = 'rentalContractInvoices' and ${DEDUCTED_SQL}))::int as contracts
        ${FROM} where ${where}`),
      this.db.execute(sql`select l.endpoint, ${COUNTS} ${FROM} where ${where} group by l.endpoint order by calls desc`),
      this.db.execute(sql`select to_char((l.created_at at time zone 'Asia/Riyadh')::date, 'YYYY-MM-DD') as day, ${COUNTS}
        ${FROM} where ${where} group by 1 order by 1`),
      this.db.execute(sql`select coalesce(u.owner_user_id, u.id) as "accountId", a.name, a.email,
          a.package_plan as plan, a.user_type as "userType", ${COUNTS}, max(l.created_at) as "lastAt"
        ${FROM} where ${where} group by 1, 2, 3, 4, 5 order by deducted desc, calls desc limit 500`),
      this.db.execute(sql`select l.user_id as "userId", coalesce(u.owner_user_id, u.id) as "accountId", u.name, u.email,
          (u.owner_user_id is not null) as employee, ${COUNTS}, max(l.created_at) as "lastAt"
        ${FROM} where ${where} group by 1, 2, 3, 4, 5 order by deducted desc, calls desc limit 2000`),
      this.db.execute(sql`select ${OUTCOME_SQL} as outcome, l.status, l.endpoint,
          left(coalesce(nullif(l.error, ''), '—'), 200) as error, count(*)::int as count, max(l.created_at) as "lastAt"
        ${FROM} where ${where} and ${OUTCOME_SQL} <> 'success'
        group by 1, 2, 3, 4 order by count desc limit 20`),
    ]);

    type Row = Record<string, unknown> & { accountId: number | null; userId?: number | null };
    const users = rowsOf<Row>(byUser);
    const accounts = rowsOf<Row>(byAccount).map((acc) => ({
      ...acc, users: users.filter((x) => x.accountId === acc.accountId),
    }));

    return {
      range: { from: f.from, to: f.to ?? null },
      pool: {
        ...setting,
        used: poolSpent,
        remaining: setting.total == null ? null : Math.max(0, setting.total - poolSpent),
        errors: Number(rowsOf<{ n: number }>(poolErrors)[0]?.n ?? 0),
      },
      gateway: {
        access: (process.env.EJAR_ACCESS ?? "all").trim() || "all",
        limit: cfg.limit, window: cfg.window, resetsAt: gateway.resetsAt,
        used: gateway.used, remaining: gateway.remaining,
        perAccount: cfg.perAccount, wrongNumbersPerDay: cfg.wrongNumbersPerDay, secondCall: cfg.secondCall,
      },
      totals: rowsOf(totals)[0] ?? null,
      byEndpoint: rowsOf(byEndpoint),
      daily: rowsOf(daily),
      byAccount: accounts,
      topErrors: rowsOf(topErrors),
    };
  }

  /** The call log, newest first, `{ data, page, pageSize, total }`. Bodies are left out. */
  @Get("calls")
  async calls(@Query() q: Record<string, unknown>) {
    const f = parseFilter(q);
    const { page, pageSize } = listQuerySchema.parse({ page: q.page, pageSize: q.pageSize });
    const where = whereOf(f);
    const [rows, count] = await Promise.all([
      this.db.execute(sql`select l.id, l.created_at as "createdAt", l.user_id as "userId", u.name as "userName", u.email as "userEmail",
          coalesce(u.owner_user_id, u.id) as "accountId", a.name as "accountName",
          l.env, l.endpoint, l.method, l.status, l.ejar_status as "ejarStatus", l.transaction_id as "transactionId",
          l.duration_ms as "durationMs", l.attempts, left(l.error, 500) as error,
          ${OUTCOME_SQL} as outcome, ${DEDUCTED_SQL} as deducted, ${CONTRACT_SQL} as contract
        ${FROM} where ${where}
        order by l.id desc limit ${pageSize} offset ${(page - 1) * pageSize}`),
      this.db.execute(sql`select count(*)::int as n ${FROM} where ${where}`),
    ]);
    return { data: rowsOf(rows), page, pageSize, total: Number(rowsOf<{ n: number }>(count)[0]?.n ?? 0) };
  }

  /** One call with its params and response body (request headers stay out). */
  @Get("calls/:id")
  async call(@Param("id") raw: string) {
    const id = posInt(raw);
    if (!id) throw new NotFoundException("Call not found");
    const [row] = rowsOf<Record<string, unknown>>(await this.db.execute(sql`
      select l.id, l.created_at as "createdAt", l.user_id as "userId", u.name as "userName", u.email as "userEmail",
             coalesce(u.owner_user_id, u.id) as "accountId", a.name as "accountName",
             l.env, l.endpoint, l.method, l.url, l.params, l.status, l.ejar_status as "ejarStatus",
             l.transaction_id as "transactionId", l.duration_ms as "durationMs", l.attempts, l.error,
             l.response_body as "responseBody", l.body_truncated as "bodyTruncated",
             ${OUTCOME_SQL} as outcome, ${DEDUCTED_SQL} as deducted, ${CONTRACT_SQL} as contract
        ${FROM} where l.id = ${id}`));
    if (!row) throw new NotFoundException("Call not found");
    return row;
  }

  /** `{ total: number|null, since: "YYYY-MM-DD", note? }` — null total removes the pool. */
  @Put("pool")
  async setPool(@CurrentUser() user: AuthUser, @Body() body: any) {
    const raw = body?.total;
    const total = raw === null || raw === "" ? null : Number(raw);
    if (total !== null && (!Number.isInteger(total) || total < 0 || total > 10_000_000)) {
      throw new BadRequestException("total must be a whole number of calls, or null");
    }
    const day = parseDateBound(body?.since);
    if (!day) throw new BadRequestException("since must be a date (YYYY-MM-DD)");
    // Midnight Riyadh of that day.
    const since = new Date(`${day}T00:00:00+03:00`).toISOString();
    const note = typeof body?.note === "string" ? body.note : null;
    await writePoolSetting(this.db, { total, since, note, updatedBy: user.id, updatedAt: new Date().toISOString() });
    return this.summary({});
  }
}
