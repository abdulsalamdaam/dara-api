/**
 * Run one account's subscription renewal now — for testing recurring billing
 * end to end on staging (Moyasar test keys). Calls the admin endpoint, so the
 * charge goes through exactly the code the hourly job runs.
 *
 *   API_URL=https://api-staging.dara-sa.net ADMIN_TOKEN=<super-admin JWT> \
 *     pnpm exec tsx scripts/renew-one.ts <userId>
 *
 * `--due` runs the whole due list instead (POST /admin/billing/run-due).
 * Never point this at production without the account holder's OK.
 */
const [arg] = process.argv.slice(2);
const api = (process.env.API_URL || "").replace(/\/$/, "");
const token = process.env.ADMIN_TOKEN || "";
if (!api || !token || !arg) {
  console.error("usage: API_URL=… ADMIN_TOKEN=… tsx scripts/renew-one.ts <userId|--due>");
  process.exit(2);
}
if (/app\.dara-sa\.com|api\.dara-sa\.net(?!.*staging)/.test(api) && process.env.I_MEAN_PRODUCTION !== "yes") {
  console.error("refusing to run against what looks like production (set I_MEAN_PRODUCTION=yes to override)");
  process.exit(2);
}
const path = arg === "--due" ? "/api/admin/billing/run-due" : `/api/admin/billing/renew/${Number(arg)}`;
(async () => {
  const res = await fetch(`${api}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  console.log(res.status, JSON.stringify(await res.json().catch(() => null), null, 2));
  process.exit(res.ok ? 0 : 1);
})();
