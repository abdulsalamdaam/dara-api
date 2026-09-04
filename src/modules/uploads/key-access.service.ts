import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE, type Drizzle } from "../../database/database.module";
import { AppLogService } from "../../common/logging/app-log.service";
import type { AuthUser } from "../../common/guards/jwt-auth.guard";
import { scopeId } from "../../common/scope";
import { classifyKey } from "./key-scope";

/** What the caller wants to do with the key — for the refusal log only. */
export type KeyAction = "sign" | "delete";

/**
 * Ownership check for a MinIO object key named by a REQUEST.
 *
 * Two shapes reach it:
 *
 *  1. A key minted after the scoping change, `acct/<scopeId>/…`. The prefix is
 *     the answer — no database work.
 *  2. A LEGACY key, `folder/<timestamp>-<uuid>.ext`, minted before any of this
 *     existed. Millions of these are already persisted on rows across the
 *     product and every one of them still has to open, so they cannot simply
 *     be refused. Nor can they simply be allowed: "any authenticated user may
 *     read any legacy key" is the hole this whole change exists to close.
 *     Instead the key is ATTRIBUTED — we ask whether any row the caller's
 *     account owns actually references it.
 *
 * A legacy key that no row references belongs to nobody we can name, so it is
 * refused and the refusal is recorded in `app_logs`. That is the deliberate
 * tightening: it may break something we have not thought of (an orphaned key
 * still rendered by an old client, a column added since this list was written),
 * and the log is how we find out — with the key, the caller and the route —
 * rather than leaving the door open in case.
 *
 * NOT used by the internal callers of `UploadsService.presignGet`
 * (`payment-confirmations` `:id/proof`, `tenant-portal`, `mobile-landlord`).
 * Those never take a key from the client: they SELECT a row already narrowed
 * to the caller — `userId = scopeId(user)`, the tenant's own contracts, the
 * owner's own properties — and sign the key stored on it. The ownership is
 * proven by the query that produced the key, and putting this check in front
 * of them would only re-derive the same fact (or, for the tenant portal, fail:
 * a tenant has no account scope at all and legitimately reads a landlord's
 * deed).
 */
@Injectable()
export class UploadKeyAccessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Drizzle,
    private readonly appLog: AppLogService,
  ) {}

  /**
   * Throws `ForbiddenException` unless `key` resolves to the caller's account.
   * Never reveals which of the three reasons applied — an attacker probing
   * keys must not learn "this one exists but is not yours".
   */
  async assertAccess(user: AuthUser, key: string, action: KeyAction): Promise<void> {
    const scope = scopeId(user);
    const verdict = classifyKey(key, scope);

    if (verdict.kind === "own") return;

    if (verdict.kind === "invalid") {
      this.refuse(user, key, action, `malformed key: ${verdict.reason}`);
    }

    if (verdict.kind === "foreign") {
      this.refuse(user, key, action, `key belongs to scope ${verdict.scopeId}`);
    }

    // Legacy: the only path that costs a query.
    if (await this.legacyKeyBelongsToScope(key, scope, user.companyId ?? null)) return;
    this.refuse(user, key, action, "unattributable legacy key");
  }

  /** Log, then throw. Split out so every refusal is recorded the same way. */
  private refuse(user: AuthUser, key: string, action: KeyAction, reason: string): never {
    this.appLog.record({
      level: "warn",
      event: "upload_key_denied",
      status: 403,
      userId: user.id,
      ownerUserId: user.ownerUserId ?? null,
      message: `refused ${action} of an object key outside the caller's scope`,
      context: "UploadKeyAccessService",
      // The key is the whole point of the row: without it we cannot tell an
      // attack from a legitimate document we failed to attribute. It is an
      // opaque `folder/<uuid>.ext` and carries no personal data itself.
      meta: { key, action, reason, scopeId: scopeId(user) },
    });
    throw new ForbiddenException("لا تملك صلاحية الوصول إلى هذا الملف");
  }

  /**
   * Is this unprefixed key referenced by a row this account owns?
   *
   * Every column below stores a MinIO object key written by
   * `UploadsService`. They were found by reading the schema rather than the
   * code, because the code that WROTE some of them is long gone:
   *
   *   contracts.attachment_key             scoped by contracts.user_id
   *   payments.attachment_key              scoped by payments.user_id
   *   payment_collections.attachment_key   scoped by payment_collections.user_id
   *   payment_confirmations.proof_key      scoped by payment_confirmations.user_id
   *   simple_invoices.attachment_key       scoped by simple_invoices.user_id
   *   simple_invoices.pdf_key              (the stored invoice PDF)
   *   properties.image_key                 scoped by properties.user_id
   *   properties.images     (jsonb array)  the property photo gallery
   *   deeds.document_url                   scoped by deeds.user_id — holds a
   *                                        key far more often than a URL
   *   owners.representative_doc_url        scoped by owners.user_id
   *   tenants.representative_doc_url       scoped by tenants.user_id
   *   units.image_key / floor_plan_key     scoped through properties.user_id
   *   units.images          (jsonb array)  the unit photo gallery
   *   units.documents       (jsonb array of { key, originalName, … })
   *   companies.logo_key                   scoped by users.company_id
   *
   * Deliberately NOT filtered on `deleted_at`: a soft-deleted contract's
   * attachment is still that account's file, and refusing it would break the
   * one case — reopening an archived record — where the key is most likely to
   * be handed to us by an old page.
   *
   * One statement, not fifteen. Postgres short-circuits `OR`, so the common
   * case (a property image, a contract scan) costs one or two index probes and
   * the expensive jsonb scans are only reached when everything cheaper missed.
   */
  private async legacyKeyBelongsToScope(key: string, scope: number, companyId: number | null): Promise<boolean> {
    // A query failure is deliberately NOT caught. Fail-open would reopen the
    // hole; a swallowed failure that always denies would look like normal
    // behaviour. Letting it out means a 500 and a stack in `app_logs`, which is
    // the only outcome anybody notices.
    const res: any = await this.db.execute(legacyKeyOwnershipSql(key, scope, companyId));
    const row = (res?.rows ?? res)?.[0];
    return row?.owned === true;
  }
}

/**
 * The attribution query itself, separated from the service so it can be
 * rendered and asserted on without a database — see `key-access.spec.ts`,
 * which pins the column list above against this SQL.
 */
export function legacyKeyOwnershipSql(key: string, scope: number, companyId: number | null) {
  // Built rather than parameterised: `$1 is not null` on a bound NULL leaves
  // Postgres unable to infer the parameter's type and raises 42P08.
  const companyArm = companyId == null
    ? sql`false`
    : sql`exists (select 1 from companies where id = ${companyId} and logo_key = ${key})`;

  return sql`
      select (
           exists (select 1 from contracts             where user_id = ${scope} and attachment_key = ${key})
        or exists (select 1 from payments              where user_id = ${scope} and attachment_key = ${key})
        or exists (select 1 from payment_collections   where user_id = ${scope} and attachment_key = ${key})
        or exists (select 1 from payment_confirmations where user_id = ${scope} and proof_key      = ${key})
        or exists (select 1 from simple_invoices       where user_id = ${scope} and (attachment_key = ${key} or pdf_key = ${key}))
        or exists (select 1 from deeds                 where user_id = ${scope} and document_url   = ${key})
        or exists (select 1 from owners                where user_id = ${scope} and representative_doc_url = ${key})
        or exists (select 1 from tenants               where user_id = ${scope} and representative_doc_url = ${key})
        or exists (
             select 1 from properties p
              where p.user_id = ${scope}
                and (p.image_key = ${key} or ${jsonbHasKey(sql`p.images`, key)})
           )
        or exists (
             select 1 from units u join properties p on p.id = u.property_id
              where p.user_id = ${scope}
                and (u.image_key = ${key} or u.floor_plan_key = ${key}
                     or ${jsonbHasKey(sql`u.images`, key)} or ${jsonbHasKey(sql`u.documents`, key)})
           )
        or ${companyArm}
      ) as owned
    `;
}

/**
 * Membership test for the two jsonb shapes these gallery columns hold. Both
 * exist in the data: `properties.images` is documented as an array of plain
 * key strings, while `units.documents` is an array of
 * `{ key, originalName, contentType, size }` — and `mobile-landlord` reads
 * `units.images` as either, so neither shape can be assumed away.
 *
 * `jsonb_typeof(...) = 'array'` guards the element expansion: a column holding
 * a bare object or a string would make `jsonb_array_elements` raise, turning an
 * authorization check into a 500.
 */
function jsonbHasKey(column: ReturnType<typeof sql>, key: string) {
  return sql`(
    ${column} is not null and jsonb_typeof(${column}) = 'array' and (
         ${column} @> to_jsonb(${key}::text)
      or exists (
           select 1 from jsonb_array_elements(${column}) el
            where jsonb_typeof(el) = 'object' and el->>'key' = ${key}
         )
    )
  )`;
}
