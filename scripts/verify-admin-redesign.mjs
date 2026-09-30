import { readFileSync } from "node:fs";

/* global process */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shell = read("app/routes/admin.tsx");
const styles = read("app/styles/admin.css");
const payments = read("app/routes/admin.payments.tsx");
const paymentService = read("app/services/payments.server.ts");
const schema = read("prisma/schema.prisma");
const migration = read("prisma/migrations/20260930190000_stripe_payout_ledger/migration.sql");

const checks = [];
function check(name, ok) {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

check("Billing is reachable from the admin navigation", shell.includes('href: "/admin/payments"') && shell.includes('label: "Billing"'));
check("shared admin shell is responsive", styles.includes(".mv-admin-shell") && styles.includes("@media (max-width: 640px)"));
check("seller payment ledger route exists", payments.includes("Seller payments") && payments.includes("Payment ledger"));
check("payment ledger requires an admin permission", payments.includes('requirePermission(request, "orders.view")'));
check("payment ledger can filter by seller and status", payments.includes('name="seller"') && payments.includes('name="status"'));
check("captured seller money is shown separately", payments.includes("Captured") && payments.includes("payment.capturedAt ?? payment.paidAt"));
check("bank-paid money is shown separately", payments.includes("Paid to bank") && payments.includes("Bank payouts"));
check("pending and failed payouts are visible", payments.includes("Payouts pending") && payments.includes("Payouts failed"));
check("payment rows do not claim one-to-one settlement", payments.includes("Stripe combines multiple charges into each bank payout"));
check("payout rows retain the Stripe reference", payments.includes("providerPayoutId") && payments.includes("Technical details"));
check("payout data is loaded independently of order charges", payments.includes("stripePayout.findMany") && payments.includes("stripePayout.groupBy"));
check("Stripe payout webhook events are recognized", paymentService.includes('event.type.startsWith("payout.")'));
check("successful charges persist a captured timestamp", paymentService.includes('const capturedAt = status === "SUCCEEDED"') && paymentService.includes("capturedAt,"));
check("Stripe payouts are idempotently persisted", paymentService.includes("stripePayout.upsert") && paymentService.includes("providerPayoutId: payoutId"));
check("payout failures are retained for operators", paymentService.includes("failureCode") && paymentService.includes("failureMessage"));
check("payout processing writes an audit record", paymentService.includes('action: `stripe.${event.type}`') && paymentService.includes("recordAudit"));
check("Prisma defines a standalone Stripe payout ledger", schema.includes("model StripePayout") && schema.includes("providerPayoutId String   @unique"));
check("additive payout migration creates table and indexes", migration.includes('CREATE TABLE "StripePayout"') && migration.includes('CREATE INDEX "StripePayout_status_idx"'));

const failures = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`);
process.exit(failures.length ? 1 : 0);
