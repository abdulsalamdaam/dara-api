import type { Provider } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { BillingModule } from "../billing/billing.module";
import { COMMISSION_ISSUER, type CommissionIssuer } from "./commission-run.service";

/**
 * The commission run issues its documents through the billing approve
 * handler (`POST /simple-invoices/:id/approve`), so a commission invoice or
 * credit note takes exactly the path a user's approval takes: the E15/E36
 * posting hook and the ZATCA submission (one signer, one chain, one set of
 * gates). The controller class is not exported, so it is taken from its
 * module's metadata (as legacy-accounting.ts does) and resolved from the
 * container lazily — it is the live, fully injected instance.
 */
export function billingIssuer(moduleRef: ModuleRef): CommissionIssuer {
  let ctl: any = null;
  return {
    async approve(scope: number, documentId: number) {
      if (!ctl) {
        const Ctl = (Reflect as any).getMetadata("controllers", BillingModule)?.[0];
        if (!Ctl) throw new Error("fv2: billing controller not found");
        ctl = moduleRef.get(Ctl, { strict: false });
      }
      // The account itself issues the document (scopeId(user) = scope); approve takes no other identity.
      const user = { id: scope, ownerUserId: null, ownerScopeId: null, role: "user", permissions: [], email: "" };
      return ctl.approve(user, String(documentId), {});
    },
  };
}

export const commissionIssuerProvider: Provider = {
  provide: COMMISSION_ISSUER,
  useFactory: (moduleRef: ModuleRef) => billingIssuer(moduleRef),
  inject: [ModuleRef],
};
