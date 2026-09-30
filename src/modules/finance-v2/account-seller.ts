/**
 * The ACCOUNT as a seller (DESIGN §4.3 `seller_key 'account'`): the managing
 * company's own supplies — commission, agency fees, and a free invoice with no
 * contract, which ZATCA files under the standalone seller
 * (`resolveStandaloneSellerId`: the account-level credentials, else the
 * account-holder landlord). No Nest, no module imports, so the facts loaders
 * and the commission code can both use it without a cycle.
 */
import type { Sql } from "./hooks/sql";

/** Is the ACCOUNT (the managing company) VAT-registered? Its company, else its account-holder / default landlord row. */
export async function accountVatRegistered(q: Sql, scope: number): Promise<boolean> {
  const [r] = await q.rows(
    `select exists (select 1 from users u join companies c on c.id = u.company_id
                     where u.id = $1 and nullif(trim(coalesce(c.vat_number,'')),'') is not null)
         or exists (select 1 from owners o where o.user_id = $1 and o.deleted_at is null and (o.is_account_holder or o.is_default)
                      and nullif(trim(coalesce(o.tax_number,'')),'') is not null) as reg`,
    [scope],
  );
  return r?.reg === true;
}

/**
 * Is the account's own seller linked to ZATCA (a live credentials row for no
 * landlord or for the account-holder landlord)? A deleted row is no link.
 */
export async function accountZatcaIntegrated(q: Sql, scope: number): Promise<boolean> {
  const [r] = await q.rows(
    `select exists (select 1 from zatca_credentials z where z.user_id = $1 and z.deleted_at is null
                     and (z.owner_id is null or z.owner_id in (select id from owners where user_id = $1 and is_account_holder))) as linked`,
    [scope],
  );
  return r?.linked === true;
}

/**
 * May the account's own fee document (commission, agency fee) carry VAT?
 * Neither is reported to ZATCA during the beta (DESIGN §9 E8, Q6b), and:
 *  - an account NOT linked to ZATCA issues no tax invoice at all (DARA-NOTES
 *    §2b-iii, "no tax invoice is issued by an unlinked seller"), so its fee
 *    documents print as "not a tax invoice" with no VAT (§9 E8);
 *  - a linked, VAT-registered account's fee is S-rated as the law has it, and
 *    approving it is refused (409 FINANCE_V2_TAX_DOC_NOT_REPORTABLE) until
 *    those documents are reported (Q6b).
 * So VAT is put on a NEW fee document only for a registered and linked account.
 */
export async function ownFeeCarriesVat(q: Sql, scope: number): Promise<boolean> {
  return (await accountVatRegistered(q, scope)) && (await accountZatcaIntegrated(q, scope));
}
