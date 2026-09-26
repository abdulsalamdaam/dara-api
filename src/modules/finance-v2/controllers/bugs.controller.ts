import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { PermissionsGuard, RequirePermissions } from "../../../common/permissions.decorator";
import { PERMISSIONS } from "../../../common/permissions";
import { scopeId } from "../../../common/scope";
import { FinanceV2Guard, RequireCapability, type Fv2Request } from "../finance-v2.guard";
import { FV2_POOL, withTx, type Fv2Pool } from "../db";
import { sqlOf } from "../hooks/sql";
import { LedgerEmitter } from "../ledger-emitter.service";
import { effectiveFeeForProperty, effectiveManagementFee } from "../commission";
import { contractSummaryV2 } from "../overrides/reads";
import { openInstallments, writeOffInstallments } from "../overrides/terminate";
import { createRentReceipt, ensureAgencyFeeDraft, unbilledAgencyFees } from "../overrides/documents-v2";
import { fromHalalas, toHalalas } from "../money";

const idOf = (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new NotFoundException();
  return n;
};

/**
 * The v2 endpoints behind the §9 bug decisions (DESIGN §10.2): E5 contract
 * summary, E1 effective management fee, E7 open installments / write-offs /
 * deposit refunds, E8 agency fees, E9 rent receipts. 404 while the flag is
 * off; every id is loaded with the account scope (a miss is 404).
 */
@Controller("finance/v2")
@UseGuards(JwtAuthGuard, FinanceV2Guard, PermissionsGuard)
export class FinanceV2BugsController {
  constructor(@Inject(FV2_POOL) private readonly pool: Fv2Pool, private readonly emitter: LedgerEmitter) {}

  private q() {
    return sqlOf(this.pool as any);
  }

  /** E5: billed / collected / outstanding / credit / overdue / depositHeld, and the E1 effective fee. */
  @Get("contracts/:id/summary")
  @RequireCapability("view")
  async summary(@Req() req: Fv2Request, @Param("id") id: string) {
    const out = await contractSummaryV2(this.q(), scopeId(req.user!), idOf(id));
    if (!out) throw new NotFoundException("Contract not found");
    return out;
  }

  /** E1: the effective management fee of a contract (property rate, else landlord rate). */
  @Get("contracts/:id/commission-rate")
  @RequireCapability("view")
  async contractRate(@Req() req: Fv2Request, @Param("id") id: string) {
    const scope = scopeId(req.user!);
    const [c] = await this.q().rows(`select 1 from contracts where id = $1 and user_id = $2 and deleted_at is null`, [idOf(id), scope]);
    if (!c) throw new NotFoundException("Contract not found");
    return effectiveManagementFee(this.q(), scope, idOf(id));
  }

  /** E1: the effective management fee of a property. */
  @Get("properties/:id/commission-rate")
  @RequireCapability("view")
  async propertyRate(@Req() req: Fv2Request, @Param("id") id: string) {
    const out = await effectiveFeeForProperty(this.q(), scopeId(req.user!), idOf(id));
    if (!out) throw new NotFoundException("Property not found");
    return out;
  }

  /** E7: the End-contract dialog's list — every open installment with its allowed and suggested disposition. ?endDate */
  @Get("contracts/:id/open-installments")
  @RequireCapability("view")
  async open(@Req() req: Fv2Request, @Param("id") id: string, @Query("endDate") endDate?: string) {
    const scope = scopeId(req.user!);
    const [c] = await this.q().rows(`select 1 from contracts where id = $1 and user_id = $2 and deleted_at is null`, [idOf(id), scope]);
    if (!c) throw new NotFoundException("Contract not found");
    return { contractId: idOf(id), rows: await openInstallments(this.q(), scope, idOf(id), endDate) };
  }

  /** E7/E10: the deposit refunds (payment vouchers) recorded at termination, for the PV print. */
  @Get("contracts/:id/deposit-refunds")
  @RequireCapability("view")
  async depositRefunds(@Req() req: Fv2Request, @Param("id") id: string) {
    const scope = scopeId(req.user!);
    const [c] = await this.q().rows(`select 1 from contracts where id = $1 and user_id = $2`, [idOf(id), scope]);
    if (!c) throw new NotFoundException("Contract not found");
    const rows = await this.q().rows(
      `select id, number, amount::text as amount, to_char(refunded_on,'YYYY-MM-DD') as refunded_on, method, bank_account_id, voucher_ids, tenant_id, owner_id
         from finance_deposit_refunds where user_id = $1 and contract_id = $2 order by id`,
      [scope, idOf(id)],
    );
    return {
      rows: rows.map((r: any) => ({
        id: r.id, number: r.number, amount: fromHalalas(toHalalas(r.amount)), refundedOn: r.refunded_on, method: r.method,
        bankAccountId: r.bank_account_id, voucherIds: (r.voucher_ids ?? []).map(Number), tenantId: r.tenant_id, ownerId: r.owner_id,
      })),
    };
  }

  /** E7/E24: write off the remaining of charged or past-due installments. Body {paymentIds[], reason}. */
  @Post("write-offs")
  @RequireCapability("approve")
  async writeOffs(@Req() req: Fv2Request, @Body() body: any) {
    const scope = scopeId(req.user!);
    const out = await withTx(this.pool, async (c) => {
      const res = await writeOffInstallments(sqlOf(c as any), scope, body, { id: req.user!.id });
      for (const e of res.events) await this.emitter.emit({ fv2: true, userId: scope, tx: c as any }, e);
      return res;
    });
    this.emitter.kick(scope);
    return { writeOffs: out.writeOffs };
  }

  /** E9: a DRAFT non-tax rent receipt for installments of a landlord with no VAT number. Body {paymentIds[], issueDate?, notes?}. */
  @Post("rent-receipts")
  @RequirePermissions(PERMISSIONS.INVOICES_WRITE)
  async rentReceipt(@Req() req: Fv2Request, @Body() body: any) {
    const scope = scopeId(req.user!);
    return withTx(this.pool, (c) => createRentReceipt(sqlOf(c as any), scope, body));
  }

  /** E8: the DRAFT brokerage-fee document for a contract with an agency fee (idempotent). */
  @Post("contracts/:id/agency-fee-invoice")
  @RequirePermissions(PERMISSIONS.INVOICES_WRITE)
  async agencyFee(@Req() req: Fv2Request, @Param("id") id: string) {
    const scope = scopeId(req.user!);
    const doc = await withTx(this.pool, (c) => ensureAgencyFeeDraft(sqlOf(c as any), scope, idOf(id)));
    if (!doc) throw new NotFoundException({ error: "FINANCE_V2_NO_AGENCY_FEE", message: "لا توجد أتعاب وساطة على العقد · The contract has no agency fee" });
    return doc;
  }

  /** E8: contracts with an agency fee and no live AGF document. */
  @Get("agency-fees/unbilled")
  @RequireCapability("view")
  unbilled(@Req() req: Fv2Request) {
    return unbilledAgencyFees(this.q(), scopeId(req.user!));
  }
}
