/**
 * Hand-built synthetic fixtures for the operational-report specs: two
 * accounts (A = 9101, B = 9102), dates relative to today in Riyadh. Shared by
 * ops-reports.db.spec.ts and the local boot/curl check. Never real data.
 */
import { addDays, riyadhToday } from "../ops-core";

export const A = 9101, B = 9102;
export const T = riyadhToday();
export const d = (n: number) => addDays(T, n);
const ts = (n: number) => `${d(n)}T12:00:00+03:00`;
const DEPOSIT = "تأمين (وديعة)";

export type Ids = Record<string, number>;

export async function seed(q: (s: string, p?: unknown[]) => Promise<any[]>): Promise<Ids> {
  const id = async (s: string, p: unknown[]) => Number((await q(s, p))[0].id);
  const ids: Ids = {};
  for (const u of [A, B]) await q(`insert into users (id, email, password_hash, name) values ($1, $2, 'x', 'Synthetic')`, [u, `ops-${u}@example.test`]);
  ids.typeApt = await id(`insert into lookups (category, key, label_ar, label_en) values ('unit_type', 'apartment', 'شقة', 'Apartment') returning id`, []);
  ids.useRes = await id(`insert into lookups (category, key, label_ar, label_en) values ('unit_usage', 'residential', 'سكني', 'Residential') returning id`, []);

  // ── account A ──
  ids.O1 = await id(`insert into owners (user_id, name, phone, iban, id_number) values ($1, 'Landlord One', '0551', 'SA0000000001', '1000') returning id`, [A]);
  ids.O2 = await id(`insert into owners (user_id, name) values ($1, 'Landlord Two') returning id`, [A]);
  ids.T1 = await id(`insert into tenants (user_id, name, phone, national_id) values ($1, 'Tenant Ali', '0501', '111') returning id`, [A]);
  ids.T2 = await id(`insert into tenants (user_id, name, national_id) values ($1, 'Tenant Badr', '222') returning id`, [A]);
  ids.T3 = await id(`insert into tenants (user_id, name, phone) values ($1, 'Tenant Cyan', '0503') returning id`, [A]);
  ids.P1 = await id(`insert into properties (user_id, name, owner_id, deed_number) values ($1, 'Tower A', $2, 'D1') returning id`, [A, ids.O1]);
  ids.P2 = await id(`insert into properties (user_id, name, owner_id) values ($1, 'Villa B', $2) returning id`, [A, ids.O2]);
  const unit = (p: number, n: string, type: number | null, use: number | null, area: number, status: string) =>
    id(`insert into units (property_id, unit_number, type_lookup_id, usage_lookup_id, area, status) values ($1, $2, $3, $4, $5, $6) returning id`, [p, n, type, use, area, status]);
  ids.U1 = await unit(ids.P1, "U1", ids.typeApt, ids.useRes, 100, "rented");
  ids.U2 = await unit(ids.P1, "U2", ids.typeApt, null, 80, "rented");
  ids.U3 = await unit(ids.P1, "U3", null, ids.useRes, 90, "available");
  ids.U4 = await unit(ids.P2, "U4", ids.typeApt, ids.useRes, 200, "available");
  // A soft-deleted unit must not count anywhere.
  await q(`insert into units (property_id, unit_number, deleted_at) values ($1, 'GONE', now())`, [ids.P1]);

  const contract = (o: { user?: number; no: string; tenant: number | null; tname: string; phone?: string | null; start: number; end: number; rent: number; status: string; ejar?: string | null; draft?: boolean; updated?: number }) =>
    id(`insert into contracts (user_id, contract_number, tenant_id, tenant_name, tenant_phone, start_date, end_date, monthly_rent, status, ejar_contract_number, is_draft, updated_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [o.user ?? A, o.no, o.tenant, o.tname, o.phone ?? null, d(o.start), d(o.end), o.rent, o.status, o.ejar ?? null, o.draft ?? false, o.updated != null ? ts(o.updated) : ts(0)]);
  const link = (c: number, u: number) => q(`insert into contract_units (contract_id, unit_id) values ($1, $2)`, [c, u]);
  ids.C1 = await contract({ no: "C-1", tenant: ids.T1, tname: "Tenant Ali", start: -200, end: 165, rent: 1000, status: "active", ejar: "E1" });
  ids.C2 = await contract({ no: "C-2", tenant: ids.T2, tname: "Tenant Badr", start: -150, end: 40, rent: 2000, status: "active" });
  ids.C3 = await contract({ no: "C-3", tenant: ids.T3, tname: "Tenant Cyan", start: -400, end: -35, rent: 500, status: "expired", ejar: "E3" });
  ids.C4 = await contract({ no: "C-4", tenant: ids.T1, tname: "Tenant Ali", start: -250, end: 115, rent: 800, status: "terminated", updated: -20 });
  ids.C5 = await contract({ no: "C-5", tenant: ids.T2, tname: "Tenant Badr", start: -10, end: 300, rent: 999, status: "active", draft: true });
  ids.C6 = await contract({ no: "C-6", tenant: ids.T3, tname: "Tenant Cyan", start: -60, end: 300, rent: 700, status: "cancelled" });
  await link(ids.C1, ids.U1);
  await link(ids.C2, ids.U2);
  await link(ids.C3, ids.U3);
  await link(ids.C5, ids.U3); // draft: must not occupy U3
  // C4 terminated: its unit link was deleted at termination, as the contracts module does.

  const pay = async (c: number, amount: number, due: number, status: string, o: { paid?: number; desc?: string; coll?: [number, number][]; user?: number } = {}) => {
    const pid = await id(`insert into payments (user_id, contract_id, amount, due_date, status, paid_date, description) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [o.user ?? A, c, amount, d(due), status, o.paid != null ? d(o.paid) : null, o.desc ?? null]);
    for (const [day, amt] of o.coll ?? []) {
      await q(`insert into payment_collections (payment_id, user_id, amount, collected_date) values ($1, $2, $3, $4)`, [pid, o.user ?? A, amt, d(day)]);
    }
    return pid;
  };
  ids.I1 = await pay(ids.C1, 1000, -100, "paid", { paid: -100, coll: [[-100, 1000]] });
  ids.I2 = await pay(ids.C1, 1000, -70, "paid", { paid: -60, coll: [[-60, 1000]] });
  ids.I3 = await pay(ids.C1, 1000, -40, "partially_paid", { coll: [[-35, 400]] });
  ids.I4 = await pay(ids.C1, 1000, -10, "pending");
  ids.I5 = await pay(ids.C1, 1000, 20, "pending");
  ids.I6 = await pay(ids.C1, 500, -5, "cancelled");
  await pay(ids.C1, 3000, -200, "pending", { desc: DEPOSIT }); // deposit: never an installment
  ids.I7 = await pay(ids.C2, 2000, -150, "paid", { paid: -148 }); // paid, no collection rows
  ids.I8 = await pay(ids.C2, 2000, -95, "pending");
  ids.I9 = await pay(ids.C3, 500, -300, "settled_external");
  ids.I10 = await pay(ids.C4, 800, -50, "paid", { paid: -50, coll: [[-50, 800]] });
  await pay(ids.C5, 999, -10, "pending"); // draft contract
  // A soft-deleted installment must not count.
  await q(`insert into payments (user_id, contract_id, amount, due_date, status, deleted_at) values ($1, $2, 777, $3, 'pending', now())`, [A, ids.C1, d(-15)]);

  const maint = (c: number | null, status: string, opened: number, updated: number, label: string) =>
    q(`insert into maintenance_requests (user_id, contract_id, unit_label, description, status, priority, created_at, updated_at) values ($1, $2, $3, 'Leak', $4, 'high', $5, $6)`,
      [A, c, label, status, ts(opened), ts(updated)]);
  await maint(ids.C1, "open", -10, -10, "U1");
  await maint(ids.C2, "completed", -30, -20, "U2");
  await maint(null, "in_progress", -5, -5, "Lobby");

  // ── account B ──
  ids.OB = await id(`insert into owners (user_id, name) values ($1, 'Landlord Bee') returning id`, [B]);
  ids.TB = await id(`insert into tenants (user_id, name, phone) values ($1, 'Tenant Bee', '0599') returning id`, [B]);
  ids.PB = await id(`insert into properties (user_id, name, owner_id) values ($1, 'Bee Tower', $2) returning id`, [B, ids.OB]);
  ids.UB = await unit(ids.PB, "B1", null, null, 50, "rented");
  ids.CB = await contract({ user: B, no: "B-1", tenant: ids.TB, tname: "Tenant Bee", start: -100, end: 100, rent: 5000, status: "active" });
  await link(ids.CB, ids.UB);
  await pay(ids.CB, 5000, -20, "pending", { user: B });
  await q(`insert into maintenance_requests (user_id, contract_id, unit_label, description, created_at) values ($1, $2, 'B1', 'Bee leak', $3)`, [B, ids.CB, ts(-3)]);
  return ids;
}

