/**
 * The tenant columns `resolveTenantContact` (common/party-contact.ts) needs,
 * for a narrow select. Kept apart from the resolver so its spec stays free of
 * the schema package.
 */
import { tenantsTable } from "@dara/database";

export const TENANT_CONTACT_COLUMNS = {
  name: tenantsTable.name,
  phone: tenantsTable.phone,
  email: tenantsTable.email,
  isRepresentative: tenantsTable.isRepresentative,
  originalTenantName: tenantsTable.originalTenantName,
  originalTenantPhone: tenantsTable.originalTenantPhone,
  originalTenantEmail: tenantsTable.originalTenantEmail,
};

