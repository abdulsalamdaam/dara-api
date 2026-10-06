import { BadRequestException, ForbiddenException, Inject, Injectable, Optional } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { BillingModule } from "../billing/billing.module";
import { FV2_POOL, withTx, type Fv2Pool } from "./db";
import { sqlOf } from "./hooks/sql";
import { auditRow } from "./audit";
import { LOCK_KEYS } from "./lock-keys";
import { createRentReceipt } from "./overrides/documents-v2";
import { collectContext, documentRoutes, notFound, parseIds } from "./overrides/installment-docs";
import type { BillingPort } from "./auto-invoice/auto-invoice.service";

/**
 * Accountant test #3 (5 Oct 2026): "Create invoice" on the installments
 * screen for a landlord with no VAT number issues the v2 non-tax rent
 * receipt directly — the same two steps the reports path takes (create the
 * RR- draft, then the existing approve route, which under v2 forks it to
 * `approveV2Kind`: E08 posting, which reverses a due-date accrual instead of
 * duplicating it, and the automatic commission invoice). Never ZATCA (EX-4).
 *
 * Landlords WITH a VAT number keep the legacy tax-invoice flow: the create
 * refuses them (400 FINANCE_V2_SELLER_VAT_REGISTERED) and the web never sends
 * them here (`routes`).
 */
@Injectable()
export class InstallmentDocsService {
  /** Set directly by the DB specs; resolved lazily from the Nest container otherwise. */
  billing: BillingPort | null = null;

  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool, @Optional() private readonly moduleRef?: ModuleRef) {}

  private port(): BillingPort {
    if (this.billing) return this.billing;
    const Ctl = (Reflect as any).getMetadata("controllers", BillingModule)?.[0];
    if (!Ctl || !this.moduleRef) throw new Error("fv2 installment documents: the billing controller is not available");
    this.billing = this.moduleRef.get(Ctl, { strict: false }) as BillingPort;
    return this.billing;
  }

  /** GET …/installments/document-routes?contractIds=1,2 */
  async routes(scope: number, rawIds: unknown) {
    return { rows: await documentRoutes(sqlOf(this.pool as any), scope, parseIds(rawIds)) };
  }

  /** GET …/installments/:paymentId/collect-context */
  async collectContext(scope: number, paymentId: number) {
    const out = await collectContext(sqlOf(this.pool as any), scope, paymentId);
    if (!out) notFound("Installment");
    return out;
  }

  /**
   * POST …/installments/rent-receipt {paymentIds, issueDate?}: create the
   * RR- draft and approve it. Returns `{ document, commission }` (the approve
   * shape). A refused approval keeps the draft (it shows on the installment
   * and in Reports → rent receipts, where it can be approved later) and the
   * refusal is rethrown as is.
   */
  async issueRentReceipt(scope: number, user: any, body: any) {
    const perms: string[] = Array.isArray(user?.permissions) ? user.permissions : [];
    if (!perms.includes("invoices.write")) throw new ForbiddenException("Missing permission: invoices.write");
    const ids = parseIds(body?.paymentIds);
    if (!ids.length) throw new BadRequestException({ error: "FINANCE_V2_BAD_INPUT", message: "حدد الأقساط · paymentIds is required" });
    const draft = await withTx(this.pool, async (c) => {
      // One issue at a time per account: the "already on a document" check and the insert cannot interleave (double click, two tabs).
      await c.query(`select pg_advisory_xact_lock($1, $2)`, [scope, LOCK_KEYS.INSTALLMENT_RR]);
      const d = await createRentReceipt(sqlOf(c as any), scope, { paymentIds: ids, issueDate: body?.issueDate });
      await auditRow(c, scope, Number(user?.id ?? scope), "finance_v2_rent_receipt", d.id, "/finance/v2/installments/rent-receipt");
      return d;
    });
    const approved = await this.port().approve(user, String(draft.id), {});
    const { commission, zatca: _z, ...document } = approved ?? {};
    void _z;
    return { document: { ...document, number: document?.number ?? draft.number, kind: "rent_receipt" }, commission: commission ?? null };
  }
}
