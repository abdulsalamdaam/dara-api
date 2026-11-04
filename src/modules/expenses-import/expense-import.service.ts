import { BadRequestException, HttpException, Inject, Injectable, Optional } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { expensesTable, ownersTable, propertiesTable } from "@dara/database";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { FinanceV2Hooks } from "../finance-v2/hooks/hooks.service";
import { ExpenseRowError, ExpensesV2Service } from "../finance-v2/tier1/expenses-v2.service";
import { mapRow, readSheet, SheetError, type Field, type ImportMode, type MappedRow, type PropertyRef, type Ref, type RowError, type RowPreview } from "./expense-sheet";
import { buildTemplate } from "./expense-template";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const SOURCE = "/expenses/import";

export interface ImportRow { row: number; ok: boolean; errors: RowError[]; preview: RowPreview }
export interface ImportResult { mode: ImportMode; rows: ImportRow[]; valid: number; invalid: number; skipped: number }

/** A v2 service refusal → the field it is about, for the preview table. */
const FIELD_OF: Record<string, Field> = {
  BAD_DATE: "expenseDate", PERIOD_LOCKED: "expenseDate", BAD_AMOUNT: "amount",
  OWNER_PROPERTY_MISMATCH: "propertyId", PROPERTY_NOT_FOUND: "propertyId", OWNER_NOT_FOUND: "ownerId",
  CHARGE_TO_NOT_ALLOWED: "chargeTo", BAD_SUPPLIER_VAT: "supplierVatNumber", SUPPLIER_VAT_REQUIRED: "supplierVatNumber",
  TRUST_FOR_OFFICE_EXPENSE: "chargeTo", LANDLORD_TRUST_INSUFFICIENT: "amount", TRUST_INSUFFICIENT: "amount",
};
const AR_FALLBACK: Record<string, string> = {
  BAD_DATE: "التاريخ غير صالح", PROPERTY_NOT_FOUND: "العقار غير موجود في هذا الحساب", OWNER_NOT_FOUND: "المؤجر غير موجود في هذا الحساب",
  BAD_INPUT: "قيمة غير صالحة", LANDLORD_TRUST_INSUFFICIENT: "رصيد المؤجر في حساب الأمانات لا يغطي هذا المصروف",
  TRUST_INSUFFICIENT: "رصيد حساب الأمانات لا يغطي هذا المصروف",
};

/** An HttpException (or anything) → one Arabic row error. The services' messages are "عربي · English"; the Arabic half is kept. */
export function rowErrorOf(err: unknown): RowError {
  if (err instanceof HttpException) {
    const r = err.getResponse() as any;
    const code: string = typeof r === "object" && r ? String(r.error ?? r.code ?? "") : "";
    const raw = typeof r === "string" ? r : Array.isArray(r?.message) ? r.message.join("، ") : String(r?.message ?? err.message);
    const ar = raw.split(" · ")[0].trim();
    const message = /[؀-ۿ]/.test(ar) ? ar : AR_FALLBACK[code] ?? `تعذّر قبول الصف (${raw})`;
    return { field: FIELD_OF[code] ?? "row", message };
  }
  throw err;
}

/**
 * Expenses from an Excel sheet. The template is built per account; an upload
 * is checked row by row with the SAME rules as the single create (v2: the
 * ExpensesV2Service's own `normalise`; legacy: POST /reports/expenses), and
 * committed only when every row passes — all rows, or none.
 */
@Injectable()
export class ExpenseImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly expensesV2: ExpensesV2Service,
    @Optional() private readonly fv2h?: FinanceV2Hooks,
  ) {}

  async mode(scope: number): Promise<ImportMode> {
    return (await this.fv2h?.resolve(scope)) === true ? "v2" : "legacy";
  }

  /** The account's landlords, properties and used items — what the template lists and the parser resolves against. */
  async lists(scope: number): Promise<{ owners: Ref[]; properties: PropertyRef[]; categories: string[]; expenseAccounts: Ref[] }> {
    const [owners, properties, cats, accts] = await Promise.all([
      this.db.select({ id: ownersTable.id, name: ownersTable.name }).from(ownersTable)
        .where(and(eq(ownersTable.userId, scope), isNull(ownersTable.deletedAt))).orderBy(asc(ownersTable.name), asc(ownersTable.id)),
      this.db.select({ id: propertiesTable.id, name: propertiesTable.name, ownerId: propertiesTable.ownerId }).from(propertiesTable)
        .where(and(eq(propertiesTable.userId, scope), isNull(propertiesTable.deletedAt))).orderBy(asc(propertiesTable.name), asc(propertiesTable.id)),
      // GET /reports/expenses/categories
      this.db.selectDistinct({ category: expensesTable.category }).from(expensesTable)
        .where(and(eq(expensesTable.userId, scope), isNull(expensesTable.deletedAt))).orderBy(asc(expensesTable.category)),
      // The chart's active expense leaves (finance v2; none on an account without it), the ones the account added included.
      this.db.execute(sql`select id, code, name_ar from accounts where user_id = ${scope} and type = 'expense' and not is_group and is_active order by code`)
        .catch(() => ({ rows: [] })),
    ]);
    const acctRows: any[] = Array.isArray(accts) ? accts : ((accts as any)?.rows ?? []);
    return {
      owners: owners.map((o) => ({ id: Number(o.id), name: String(o.name ?? "") })),
      properties: properties.map((p) => ({ id: Number(p.id), name: String(p.name ?? ""), ownerId: p.ownerId == null ? null : Number(p.ownerId) })),
      categories: cats.map((c) => c.category).filter((c): c is string => !!c && !!c.trim()),
      expenseAccounts: acctRows.map((a) => ({ id: Number(a.id), name: `${a.code} ${a.name_ar}` })),
    };
  }

  async template(user: AuthUser): Promise<Buffer> {
    const scope = scopeId(user);
    return buildTemplate({ mode: await this.mode(scope), ...(await this.lists(scope)) });
  }

  /** Parse and check every row; no writes. */
  async check(user: AuthUser, file: Buffer): Promise<ImportResult & { mapped: MappedRow[] }> {
    const scope = scopeId(user);
    let sheet: Awaited<ReturnType<typeof readSheet>>;
    try {
      sheet = await readSheet(file);
    } catch (err) {
      if (err instanceof SheetError) throw new BadRequestException({ error: err.code, message: err.message });
      throw err;
    }
    const mode = await this.mode(scope);
    const lists = await this.lists(scope);
    const mapped = sheet.rows.map((r) => mapRow(r, { mode, owners: lists.owners, properties: lists.properties, expenseAccounts: lists.expenseAccounts }));
    if (mode === "v2") {
      // The service's own checks (landlord mode, charge-to, VAT, period lock) — only for rows the sheet checks passed.
      for (const m of mapped) {
        if (m.errors.length) continue;
        try {
          Object.assign(m.preview, await this.expensesV2.validate(scope, m.body));
        } catch (err) {
          m.errors.push(rowErrorOf(err));
        }
      }
    }
    const rows = mapped.map((m) => ({ row: m.row, ok: m.errors.length === 0, errors: m.errors, preview: m.preview }));
    const invalid = rows.filter((r) => !r.ok).length;
    return { mode, rows, valid: rows.length - invalid, invalid, skipped: sheet.skipped, mapped };
  }

  /** `dryRun`: the check alone. Otherwise every row is created, or — if any row is invalid — none (400, the check's shape). */
  async run(user: AuthUser, file: Buffer, dryRun: boolean): Promise<ImportResult | { mode: ImportMode; created: number; ids: number[] }> {
    const { mapped, ...result } = await this.check(user, file);
    if (dryRun) return result;
    if (result.invalid > 0) {
      throw new BadRequestException({ error: "IMPORT_INVALID", message: `لم يُستورد شيء: ${result.invalid} صف فيه أخطاء`, ...result });
    }
    const scope = scopeId(user);
    const bodies = mapped.map((m) => m.body);
    if (result.mode === "v2") {
      try {
        const ids = await this.expensesV2.createMany(scope, user, bodies, SOURCE);
        return { mode: result.mode, created: ids.length, ids };
      } catch (err) {
        if (!(err instanceof ExpenseRowError)) throw err;
        const at = mapped[err.index];
        const rows = result.rows.map((r) => r.row === at.row ? { ...r, ok: false, errors: [rowErrorOf(err.reason)] } : r);
        throw new BadRequestException({
          error: "IMPORT_INVALID", message: `لم يُستورد شيء: تعذّر حفظ الصف ${at.row}`, ...result, rows, valid: result.valid - 1, invalid: 1,
        });
      }
    }
    // Legacy: POST /reports/expenses for each row (ids already resolved in this account), all in one transaction.
    const ids = await this.db.transaction(async (tx) => {
      const out: number[] = [];
      for (const b of bodies) {
        const [row] = await tx.insert(expensesTable).values({
          userId: scope,
          propertyId: Number(b.propertyId),
          ownerId: Number(b.ownerId),
          category: String(b.category).trim(),
          amount: round2(Number(b.amount)).toFixed(2),
          expenseDate: b.expenseDate ?? null,
          notes: b.notes ?? null,
        } as any).returning({ id: expensesTable.id });
        out.push(Number(row.id));
      }
      return out;
    });
    for (const id of ids) await this.fv2h?.expenseCreated({ fv2: false, userId: scope }, id); // finance-v2: as POST /reports/expenses (a no-op with the flag off)
    return { mode: result.mode, created: ids.length, ids };
  }
}
