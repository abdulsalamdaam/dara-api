/**
 * The chart accounts the posting rules resolve by `system_key` (DESIGN §3,
 * §4.3). Every key here exists in COA_TEMPLATE (rules.spec.ts checks it).
 */
export const SYS = {
  cash: "cash",
  bank: "bank_default",
  trustBank: "trust_bank",
  cashInTransit: "cash_in_transit",
  /** AR, principal (1121) */
  ar: "tenant_receivable",
  /** AR, agent (1122) */
  arAgency: "tenant_receivable_agency",
  inputVat: "input_vat",
  vatRefundable: "vat_refundable",
  /** LP, landlord payable – collected rent (2121) */
  lp: "landlord_payable",
  /** LPU, landlord share of uncollected rent (2122) */
  lpu: "landlord_payable_uncollected",
  /** UR, unearned rent (2131) */
  ur: "unearned_rent",
  /** DEP, tenant deposits held (2141) */
  dep: "deposits_held",
  outputVat: "output_vat",
  vatSettlement: "vat_settlement",
  drawings: "owner_drawings",
  revResidential: "rent_revenue_residential",
  revCommercial: "rent_revenue_commercial",
  revService: "service_charge_revenue",
  revOther: "other_tenant_revenue",
  commission: "commission_revenue",
  agencyFee: "agency_fee_revenue",
  depositForfeit: "deposit_forfeit_revenue",
  expensePropertyOther: "expense_property_other",
  expenseGeneralOther: "expense_general_other",
  badDebt: "bad_debt_expense",
  vatNonRecoverable: "vat_non_recoverable",
} as const;

export type SystemKey = (typeof SYS)[keyof typeof SYS];
