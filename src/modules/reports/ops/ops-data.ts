/**
 * Operational reports — the one place that reads Postgres.
 *
 * Scoping is exactly the list endpoints': every table is filtered on
 * `user_id = scopeId(user)` (a team member reads the account holder's rows)
 * and `deleted_at is null`; units are scoped through their property, as
 * `GET /units` does. The `ownerId` / `propertyId` filters are applied to the
 * already-scoped property set, so a foreign id matches nothing and every
 * downstream set (units, contracts, installments, maintenance) comes back
 * empty — never another account's rows.
 *
 * Per-installment money is aggregated in SQL (collections summed per
 * installment per day); the report arithmetic itself runs in the pure
 * builders so it can be unit-tested without a database.
 */
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  contractsTable, contractUnitsTable, unitsTable, propertiesTable, ownersTable, tenantsTable,
  paymentsTable, paymentCollectionsTable, maintenanceRequestsTable, lookupsTable,
} from "@dara/database";
import type { Drizzle } from "../../../database/database.module";
import { DEPOSIT_DESC } from "../../contract-deposit/deposit-rules";
import { riyadhDate, round2, type Installment } from "./ops-core";

export type DsProperty = {
  id: number; name: string; ownerId: number | null; hasDeed: boolean;
  usageAr: string | null; usageEn: string | null;
};
export type DsUnit = {
  id: number; propertyId: number; unitNumber: string; status: string; area: number | null;
  typeAr: string | null; typeEn: string | null; usageAr: string | null; usageEn: string | null;
};
export type DsOwner = { id: number; name: string; phone: string | null; iban: string | null; idNumber: string | null };
export type DsTenant = { id: number; name: string; phone: string | null; nationalId: string | null };
export type DsContract = {
  id: number; contractNumber: string; ejarNumber: string | null;
  tenantId: number | null; tenantName: string; tenantPhone: string | null; landlordName: string | null;
  startDate: string; endDate: string; annualRent: number; paymentFrequency: string;
  status: string; endedOn: string | null;
  /** Units it covers, within the account's (unfiltered) unit scope, ascending link order. */
  unitIds: number[];
  /** The property of its first linked unit — what per-property figures attribute it to. */
  propertyId: number | null;
};
export type DsMaintenance = {
  id: number; contractId: number | null; unitLabel: string; description: string;
  priority: string; status: string; openedOn: string; updatedOn: string;
};
export type OpsDataset = {
  today: string;
  /** True when ownerId/propertyId narrowed the scope (unlinked contracts then drop out). */
  filtered: boolean;
  properties: DsProperty[];
  units: DsUnit[];
  owners: DsOwner[];
  tenants: DsTenant[];
  contracts: DsContract[];
  installments: Installment[];
  maintenance: DsMaintenance[];
};

export type LoadOpts = {
  ownerId: number | null; propertyId: number | null; today: string;
  need: { installments?: boolean; maintenance?: boolean };
};

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const dstr = (v: unknown): string => String(v).slice(0, 10);

export async function loadDataset(db: Drizzle, uid: number, o: LoadOpts): Promise<OpsDataset> {
  const filtered = o.ownerId != null || o.propertyId != null;

  const [propsRaw, unitsRaw, ownersRaw, tenantsRaw, contractsRaw] = await Promise.all([
    db.select({
      id: propertiesTable.id, name: propertiesTable.name, ownerId: propertiesTable.ownerId,
      deedId: propertiesTable.deedId, deedNumber: propertiesTable.deedNumber, usageLookupId: propertiesTable.usageLookupId,
    }).from(propertiesTable)
      .where(and(eq(propertiesTable.userId, uid), isNull(propertiesTable.deletedAt)))
      .orderBy(asc(propertiesTable.id)),
    db.select({
      id: unitsTable.id, propertyId: unitsTable.propertyId, unitNumber: unitsTable.unitNumber, status: unitsTable.status,
      area: unitsTable.area, typeLookupId: unitsTable.typeLookupId, typeOther: unitsTable.typeOther, usageLookupId: unitsTable.usageLookupId,
    }).from(unitsTable)
      .innerJoin(propertiesTable, and(eq(unitsTable.propertyId, propertiesTable.id), eq(propertiesTable.userId, uid), isNull(propertiesTable.deletedAt)))
      .where(isNull(unitsTable.deletedAt))
      .orderBy(asc(unitsTable.propertyId), asc(unitsTable.id)),
    db.select({ id: ownersTable.id, name: ownersTable.name, phone: ownersTable.phone, iban: ownersTable.iban, idNumber: ownersTable.idNumber })
      .from(ownersTable).where(and(eq(ownersTable.userId, uid), isNull(ownersTable.deletedAt))).orderBy(asc(ownersTable.id)),
    db.select({ id: tenantsTable.id, name: tenantsTable.name, phone: tenantsTable.phone, nationalId: tenantsTable.nationalId })
      .from(tenantsTable).where(and(eq(tenantsTable.userId, uid), isNull(tenantsTable.deletedAt))).orderBy(asc(tenantsTable.id)),
    db.select({
      id: contractsTable.id, contractNumber: contractsTable.contractNumber, ejarNumber: contractsTable.ejarContractNumber,
      tenantId: contractsTable.tenantId, tenantName: contractsTable.tenantName, tenantPhone: contractsTable.tenantPhone,
      landlordName: contractsTable.landlordName,
      startDate: contractsTable.startDate, endDate: contractsTable.endDate, monthlyRent: contractsTable.monthlyRent,
      paymentFrequency: contractsTable.paymentFrequency, status: contractsTable.status, updatedAt: contractsTable.updatedAt,
    }).from(contractsTable)
      // Drafts are not leases yet — every report leaves them out (said in the notes).
      .where(and(eq(contractsTable.userId, uid), isNull(contractsTable.deletedAt), eq(contractsTable.isDraft, false)))
      .orderBy(asc(contractsTable.id)),
  ]);

  // Lookup labels for unit type / usage and property usage — one batched read.
  const lookupIds = new Set<number>();
  for (const u of unitsRaw) { if (u.typeLookupId) lookupIds.add(u.typeLookupId); if (u.usageLookupId) lookupIds.add(u.usageLookupId); }
  for (const p of propsRaw) if (p.usageLookupId) lookupIds.add(p.usageLookupId);
  const lookups = lookupIds.size
    ? await db.select({ id: lookupsTable.id, ar: lookupsTable.labelAr, en: lookupsTable.labelEn })
      .from(lookupsTable).where(inArray(lookupsTable.id, [...lookupIds]))
    : [];
  const lk = new Map(lookups.map((l) => [l.id, l]));

  const allProps: DsProperty[] = propsRaw.map((p) => {
    const usage = p.usageLookupId ? lk.get(p.usageLookupId) : undefined;
    return {
      id: p.id, name: p.name, ownerId: p.ownerId ?? null,
      hasDeed: p.deedId != null || !!(p.deedNumber && p.deedNumber.trim()),
      usageAr: usage?.ar ?? null, usageEn: usage?.en ?? null,
    };
  });
  const propById = new Map(allProps.map((p) => [p.id, p]));
  const allUnits: DsUnit[] = unitsRaw.map((u) => {
    const t = u.typeLookupId ? lk.get(u.typeLookupId) : undefined;
    const typeOther = u.typeOther && u.typeOther.trim() ? u.typeOther.trim() : null;
    const ownUsage = u.usageLookupId ? lk.get(u.usageLookupId) : undefined;
    const prop = propById.get(u.propertyId);
    return {
      id: u.id, propertyId: u.propertyId, unitNumber: u.unitNumber, status: u.status,
      area: u.area == null ? null : num(u.area),
      typeAr: t?.ar ?? typeOther, typeEn: t?.en ?? typeOther,
      // A unit with no usage of its own inherits its property's (DARA-NOTES §4).
      usageAr: ownUsage?.ar ?? prop?.usageAr ?? null, usageEn: ownUsage?.en ?? prop?.usageEn ?? null,
    };
  });
  const unitById = new Map(allUnits.map((u) => [u.id, u]));

  // contract ↔ unit links, only to units inside the account's own scope.
  const contractIds = contractsRaw.map((c) => c.id);
  const links = contractIds.length
    ? await db.select({ contractId: contractUnitsTable.contractId, unitId: contractUnitsTable.unitId })
      .from(contractUnitsTable).where(inArray(contractUnitsTable.contractId, contractIds))
      .orderBy(asc(contractUnitsTable.id))
    : [];
  const unitsOf = new Map<number, number[]>();
  for (const l of links) {
    if (!unitById.has(l.unitId)) continue;
    const arr = unitsOf.get(l.contractId) ?? [];
    arr.push(l.unitId);
    unitsOf.set(l.contractId, arr);
  }

  const allContracts: DsContract[] = contractsRaw.map((c) => {
    const unitIds = unitsOf.get(c.id) ?? [];
    return {
      id: c.id, contractNumber: c.contractNumber, ejarNumber: c.ejarNumber && c.ejarNumber.trim() ? c.ejarNumber.trim() : null,
      tenantId: c.tenantId ?? null, tenantName: c.tenantName, tenantPhone: c.tenantPhone ?? null, landlordName: c.landlordName ?? null,
      startDate: dstr(c.startDate), endDate: dstr(c.endDate),
      annualRent: round2(num(c.monthlyRent) * 12),
      paymentFrequency: c.paymentFrequency, status: c.status,
      endedOn: c.status === "terminated" ? riyadhDate(c.updatedAt as Date) : null,
      unitIds, propertyId: unitIds.length ? unitById.get(unitIds[0])!.propertyId : null,
    };
  });

  // ── the filter, intersected with the scope ──
  const properties = allProps.filter((p) =>
    (o.ownerId == null || p.ownerId === o.ownerId) && (o.propertyId == null || p.id === o.propertyId));
  const propSet = new Set(properties.map((p) => p.id));
  const units = filtered ? allUnits.filter((u) => propSet.has(u.propertyId)) : allUnits;
  const unitSet = new Set(units.map((u) => u.id));
  const contracts = filtered ? allContracts.filter((c) => c.unitIds.some((u) => unitSet.has(u))) : allContracts;
  const contractSet = new Set(contracts.map((c) => c.id));
  const owners = ownersRaw.filter((ow) => {
    if (o.ownerId != null && ow.id !== o.ownerId) return false;
    if (o.propertyId != null && !properties.some((p) => p.ownerId === ow.id)) return false;
    return true;
  });

  let installments: Installment[] = [];
  if (o.need.installments && contractSet.size) {
    const ids = [...contractSet];
    const pays = await db.select({
      id: paymentsTable.id, contractId: paymentsTable.contractId, amount: paymentsTable.amount,
      dueDate: paymentsTable.dueDate, paidDate: paymentsTable.paidDate, status: paymentsTable.status,
    }).from(paymentsTable).where(and(
      eq(paymentsTable.userId, uid), isNull(paymentsTable.deletedAt), inArray(paymentsTable.contractId, ids),
      // Deposits are held trust money, not rent — the Installments tab leaves them out too.
      or(isNull(paymentsTable.description), ne(paymentsTable.description, DEPOSIT_DESC)),
    )).orderBy(asc(paymentsTable.dueDate), asc(paymentsTable.id));
    const payIds = pays.map((p) => p.id);
    const colls = payIds.length
      ? await db.select({
        paymentId: paymentCollectionsTable.paymentId,
        date: paymentCollectionsTable.collectedDate,
        amount: sql<string>`sum(${paymentCollectionsTable.amount})`,
      }).from(paymentCollectionsTable)
        .where(and(eq(paymentCollectionsTable.userId, uid), inArray(paymentCollectionsTable.paymentId, payIds)))
        .groupBy(paymentCollectionsTable.paymentId, paymentCollectionsTable.collectedDate)
      : [];
    const byPay = new Map<number, { date: string; amount: number }[]>();
    for (const c of colls) {
      if (c.paymentId == null) continue;
      const arr = byPay.get(c.paymentId) ?? [];
      arr.push({ date: dstr(c.date), amount: round2(num(c.amount)) });
      byPay.set(c.paymentId, arr);
    }
    installments = pays.map((p) => ({
      id: p.id, contractId: p.contractId, amount: round2(num(p.amount)),
      dueDate: dstr(p.dueDate), paidDate: p.paidDate ? dstr(p.paidDate) : null, status: p.status,
      collections: byPay.get(p.id) ?? [],
    }));
  }

  let maintenance: DsMaintenance[] = [];
  if (o.need.maintenance) {
    const rows = await db.select({
      id: maintenanceRequestsTable.id, contractId: maintenanceRequestsTable.contractId, unitLabel: maintenanceRequestsTable.unitLabel,
      description: maintenanceRequestsTable.description, priority: maintenanceRequestsTable.priority, status: maintenanceRequestsTable.status,
      createdAt: maintenanceRequestsTable.createdAt, updatedAt: maintenanceRequestsTable.updatedAt,
    }).from(maintenanceRequestsTable)
      .where(and(eq(maintenanceRequestsTable.userId, uid), isNull(maintenanceRequestsTable.deletedAt)))
      .orderBy(asc(maintenanceRequestsTable.createdAt), asc(maintenanceRequestsTable.id));
    maintenance = rows
      .filter((m) => !filtered || (m.contractId != null && contractSet.has(m.contractId)))
      .map((m) => ({
        id: m.id, contractId: m.contractId ?? null, unitLabel: m.unitLabel, description: m.description,
        priority: m.priority, status: m.status,
        openedOn: riyadhDate(m.createdAt as Date)!, updatedOn: riyadhDate(m.updatedAt as Date)!,
      }));
  }

  return {
    today: o.today, filtered,
    properties, units, owners,
    tenants: tenantsRaw,
    contracts: filtered ? contracts : allContracts,
    installments, maintenance,
  };
}
