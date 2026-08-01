import { eq } from "drizzle-orm";
import type { Drizzle } from "../../database/database.module";
import { propertiesTable, unitsTable, contractsTable, paymentsTable } from "@dara/database";

export async function seedDemoData(db: Drizzle, demoUserId: number): Promise<void> {
  const [prop1] = await db.insert(propertiesTable).values({
    userId: demoUserId,
    name: "برج العليا السكني",
    district: "العليا",
    street: "شارع العليا الرئيسي",
    totalUnits: 6,
    status: "active",
    isDemo: true,
  }).returning();

  const [prop2] = await db.insert(propertiesTable).values({
    userId: demoUserId,
    name: "مجمع الرياض التجاري",
    district: "العليا",
    street: "طريق الملك فهد",
    totalUnits: 2,
    status: "active",
    isDemo: true,
  }).returning();

  const units1 = await db.insert(unitsTable).values([
    { propertyId: prop1!.id, unitNumber: "101", status: "rented", floor: 1, bedrooms: 3, bathrooms: 2, area: "120.00", rentPrice: "2500.00", isDemo: true },
    { propertyId: prop1!.id, unitNumber: "102", status: "rented", floor: 1, bedrooms: 2, bathrooms: 1, area: "90.00", rentPrice: "1800.00", isDemo: true },
    { propertyId: prop1!.id, unitNumber: "201", status: "available", floor: 2, bedrooms: 3, bathrooms: 2, area: "120.00", rentPrice: "2600.00", isDemo: true },
    { propertyId: prop1!.id, unitNumber: "202", status: "rented", floor: 2, bedrooms: 4, bathrooms: 3, area: "150.00", rentPrice: "3200.00", isDemo: true },
  ]).returning();

  const units2 = await db.insert(unitsTable).values([
    { propertyId: prop2!.id, unitNumber: "A01", status: "rented", floor: 1, area: "80.00", rentPrice: "3500.00", isDemo: true },
    { propertyId: prop2!.id, unitNumber: "B01", status: "available", floor: 1, area: "60.00", rentPrice: "2800.00", isDemo: true },
  ]).returning();

  const today = new Date();
  const startDate = new Date(today.getFullYear(), 0, 1).toISOString().split("T")[0]!;
  const endDate = new Date(today.getFullYear(), 11, 31).toISOString().split("T")[0]!;

  const rentedUnits = [units1[0]!, units1[1]!, units1[3]!, units2[0]!];
  const tenants = [
    { name: "أحمد محمد العتيبي", idNumber: "1234567890", phone: "0501234567" },
    { name: "خالد عبدالله السالم", idNumber: "1098765432", phone: "0557654321" },
    { name: "فيصل سعود الحربي", idNumber: "1122334455", phone: "0543219876" },
    { name: "شركة الأفق للاستشارات", idNumber: "7001234567", phone: "0112345678" },
  ];

  const contracts = await db.insert(contractsTable).values(rentedUnits.map((unit, i) => ({
    userId: demoUserId,
    unitId: unit.id,
    contractNumber: `EQ-2024-${100 + i}`,
    tenantName: tenants[i]!.name,
    tenantIdNumber: tenants[i]!.idNumber,
    tenantPhone: tenants[i]!.phone,
    startDate,
    endDate,
    monthlyRent: unit.rentPrice!,
    paymentFrequency: "monthly" as const,
    depositAmount: String(parseFloat(unit.rentPrice!) * 2),
    status: "active" as const,
    isDemo: true,
  }))).returning();

  const dueDate1 = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const dueDate2 = `${today.getFullYear()}-${String(today.getMonth() || 12).padStart(2, "0")}-01`;

  await db.insert(paymentsTable).values(contracts.flatMap((contract, i) => [
    { userId: demoUserId, contractId: contract.id, amount: contract.monthlyRent, dueDate: dueDate1, paidDate: null, status: "pending" as const, isDemo: true },
    { userId: demoUserId, contractId: contract.id, amount: contract.monthlyRent, dueDate: dueDate2, paidDate: dueDate2, status: "paid" as const, receiptNumber: `REC-${1000 + i}`, isDemo: true },
  ]));
}
