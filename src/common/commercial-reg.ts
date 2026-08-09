import { BadRequestException } from "@nestjs/common";

/**
 * A company is identified by its commercial registration (السجل التجاري).
 *
 * For an individual the national ID plays that role and is validated
 * separately; for a company the CR is what a tax invoice must carry and what
 * a record reconciles against in Ejar, so a company row without one is not
 * usable for the things the product exists to do.
 *
 * Stored in the same `nationalId` column for both party types — that is how
 * the schema and the Ejar party mapping already work, so this validates the
 * column against the rule that applies to the row's `type`.
 *
 * Mirrors validateCommercialReg in dara-web/src/lib/validation.ts.
 */

const CR_PATTERN = /^\d{10}$/;

export interface CompanyIdentity {
  type?: string | null;
  /** The CR for a company, the national ID for an individual. */
  nationalId?: string | null;
  isDraft?: boolean | null;
}

/**
 * Throws unless a company row carries a valid CR.
 *
 * Drafts are exempt — a draft is explicitly incomplete, the same exemption
 * assertNationalAddress makes. Individuals are untouched.
 */
export function assertCompanyCommercialReg(row: CompanyIdentity): void {
  if (row?.isDraft) return;
  if ((row?.type || "individual") !== "company") return;

  const cr = String(row?.nationalId ?? "").trim();
  if (!cr) {
    throw new BadRequestException(
      "السجل التجاري مطلوب للمنشآت · Commercial registration is required for companies",
    );
  }
  if (!CR_PATTERN.test(cr)) {
    throw new BadRequestException(
      "السجل التجاري يجب أن يكون 10 أرقام · Commercial registration must be 10 digits",
    );
  }
}
