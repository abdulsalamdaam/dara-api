import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { FV2_POOL, type Fv2Pool } from "../db";
import { PostingEngine } from "../posting.engine";
import { RULES } from "../rules";
import { fromHalalas, toHalalas } from "../money";
import { sqlOf } from "../hooks/sql";
import { loadSettings, payoutEvent } from "../hooks/facts-loader";
import { parseBusinessDate } from "../hooks/classify";

export interface PayoutVoucherLine {
  side: "debit" | "credit";
  accountId: number;
  code: string;
  nameAr: string;
  nameEn: string;
  amount: string;
}

export interface PayoutVoucher {
  payoutId: number;
  /** PV-######; null for a payout recorded before vouchers existed (or with the flag off). */
  number: string | null;
  date: string | null;
  amount: string;
  method: string | null;
  reference: string | null;
  notes: string | null;
  /** True once the payout was deleted (its E19 entry is then reversed). */
  deleted: boolean;
  treatment: "agent" | "principal";
  landlord: { id: number; name: string; idNumber: string | null; taxNumber: string | null; iban: string | null; isAccountHolder: boolean };
  paidFrom: { bankAccountId: number | null; nameAr: string | null; nameEn: string | null; glCode: string | null; isTrust: boolean } | null;
  /**
   * The E19 entry: the posted one when the worker has posted it (`posted: true`, `entryNo`), otherwise what it
   * WILL post, resolved through the same rule and account resolution the engine uses (`posted: false`).
   */
  entry: { posted: boolean; entryNo: string | null; entryDate: string | null; lines: PayoutVoucherLine[] } | null;
  createdAt: string;
}

/**
 * The landlord payout's payment voucher (سند صرف), accountant 15 Oct 2026. Read-only:
 * GET /finance/v2/landlord-payouts/:id/voucher. Scoped: another account's id is 404.
 * Not a tax invoice — nothing here touches ZATCA.
 */
@Injectable()
export class LandlordPayoutsService {
  constructor(
    @Inject(FV2_POOL) private readonly pool: Fv2Pool,
    private readonly engine: PostingEngine,
  ) {}

  async voucher(scope: number, payoutId: number): Promise<PayoutVoucher> {
    const [p] = (await this.pool.query(
      `select lp.id, lp.owner_id, lp.amount::text as amount, lp.transfer_date, lp.method, lp.reference, lp.notes,
              lp.deleted_at is not null as deleted, lp.created_at,
              to_char(m.paid_on,'YYYY-MM-DD') as paid_on, m.bank_account_id, v.number,
              o.name, o.id_number, o.tax_number, o.iban, o.is_account_holder
         from landlord_payouts lp
         left join finance_payout_meta m on m.payout_id = lp.id and m.user_id = lp.user_id
         left join finance_payout_vouchers v on v.payout_id = lp.id and v.user_id = lp.user_id
         left join owners o on o.id = lp.owner_id and o.user_id = lp.user_id
        where lp.id = $1 and lp.user_id = $2`, [payoutId, scope])).rows;
    if (!p) throw new NotFoundException({ error: "PAYOUT_NOT_FOUND", message: "Payout not found" });

    const entry = await this.entry(scope, payoutId, p.deleted === true);
    const creditLine = entry?.lines.find((l) => l.side === "credit") ?? null;
    let bankId: number | null = p.bank_account_id ?? null;
    if (creditLine && bankId == null) {
      const [b] = (await this.pool.query(`select bank_account_id from accounts where user_id = $1 and id = $2`, [scope, creditLine.accountId])).rows;
      bankId = b?.bank_account_id ?? null;
    }
    const [bank] = bankId != null
      ? (await this.pool.query(
        `select b.id, b.name_ar, b.name_en, b.is_trust, a.code from bank_accounts b join accounts a on a.id = b.gl_account_id and a.user_id = b.user_id
          where b.user_id = $1 and b.id = $2`, [scope, bankId])).rows
      : [];
    const paidFrom = bank
      ? { bankAccountId: Number(bank.id), nameAr: bank.name_ar, nameEn: bank.name_en ?? null, glCode: bank.code, isTrust: bank.is_trust === true }
      : creditLine ? { bankAccountId: null, nameAr: creditLine.nameAr, nameEn: creditLine.nameEn, glCode: creditLine.code, isTrust: false } : null;
    const s = await loadSettings(sqlOf(this.pool as any), scope);
    const holder = p.is_account_holder === true;
    return {
      payoutId: Number(p.id),
      number: p.number ?? null,
      date: p.paid_on ?? parseBusinessDate(p.transfer_date) ?? null,
      amount: fromHalalas(toHalalas(p.amount)),
      method: p.method ?? null,
      reference: p.reference ?? null,
      notes: p.notes ?? null,
      deleted: p.deleted === true,
      treatment: s?.mode === "manager" && !holder ? "agent" : "principal",
      landlord: {
        id: Number(p.owner_id), name: p.name ?? "—", idNumber: p.id_number ?? null, taxNumber: p.tax_number ?? null,
        iban: p.iban ?? null, isAccountHolder: holder,
      },
      paidFrom,
      entry,
      createdAt: new Date(p.created_at).toISOString(),
    };
  }

  /** The posted E19 entry, or its preview through the engine's own rule and resolution. */
  private async entry(scope: number, payoutId: number, deleted: boolean): Promise<PayoutVoucher["entry"]> {
    const [e] = (await this.pool.query(
      `select id, entry_no, to_char(entry_date,'YYYY-MM-DD') as d from journal_entries
        where user_id = $1 and source_type = 'landlord_payout' and source_id = $2 and event = 'created'`, [scope, payoutId])).rows;
    if (e) {
      const lines = (await this.pool.query(
        `select l.account_id, a.code, a.name_ar, a.name_en, l.debit::text as debit, l.credit::text as credit
           from journal_lines l join accounts a on a.id = l.account_id and a.user_id = l.user_id
          where l.user_id = $1 and l.entry_id = $2 order by l.id`, [scope, e.id])).rows;
      return {
        posted: true, entryNo: e.entry_no, entryDate: e.d,
        lines: lines.map((l: any) => {
          const d = toHalalas(l.debit);
          return { side: d > 0 ? "debit" : "credit", accountId: Number(l.account_id), code: l.code, nameAr: l.name_ar, nameEn: l.name_en, amount: fromHalalas(d > 0 ? d : toHalalas(l.credit)) };
        }),
      };
    }
    if (deleted) return null;
    const s = await loadSettings(sqlOf(this.pool as any), scope);
    if (!s) return null;
    const ev = await payoutEvent(sqlOf(this.pool as any), scope, s, payoutId);
    if (!ev || !("rule" in ev.payload) || ev.payload.rule !== "E19") return null;
    const out = RULES.E19(ev.payload.facts as any, {} as any);
    if (out.skip || !out.lines.length) return null;
    const c = await this.pool.connect();
    try {
      const { lines } = await this.engine.resolveLines(c, scope, out.lines);
      const ids = [...new Set(lines.map((l) => l.accountId))];
      const names = new Map((await c.query(`select id, code, name_ar, name_en from accounts where user_id = $1 and id = any($2::int[])`, [scope, ids])).rows
        .map((a: any) => [Number(a.id), a]));
      return {
        posted: false, entryNo: null, entryDate: null,
        lines: lines.map((l) => {
          const a = names.get(l.accountId);
          const d = Number(l.debit ?? 0); // integer halalas, like the engine's lines
          return { side: d > 0 ? "debit" : "credit", accountId: l.accountId, code: a?.code ?? "", nameAr: a?.name_ar ?? "", nameEn: a?.name_en ?? "", amount: fromHalalas(d > 0 ? d : Number(l.credit ?? 0)) };
        }),
      };
    } finally {
      c.release();
    }
  }
}
