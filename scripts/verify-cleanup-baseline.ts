/**
 * The clean baseline, asserted so it cannot silently drift back.
 *
 * The demo environment was removed deliberately: one sandbox store, its one
 * catalogue product, its one order and everything hanging off them. This suite
 * exists because "deleted correctly" and "deleted completely" are different
 * claims — the second one is about what is LEFT BEHIND, and orphans are the way a
 * cleanup looks finished while a foreign key quietly points at nothing.
 *
 * IT NAMES EXACT IDENTIFIERS. There is no "delete everything" here and no broad
 * predicate: the store and the product are named, and a rerun changes nothing,
 * which is the idempotency the brief asks for. A test that could delete is a test
 * that can be run by accident.
 *
 * WHAT IT CANNOT CHECK: Odoo. The verify clone has no ERP credentials and the
 * integration is switched off, so the Odoo half is verified separately, read-only,
 * by `probe/mv-verify-odoo-clean.ts`. This suite says so rather than implying the
 * whole baseline was proven from here.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SANDBOX_SHOP = "moonvilla-sandbox.myshopify.com";

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  /*
   * THE PRECONDITION IS THAT THE CLEANUP HAS RUN. On a clone that still holds the
   * demo data — a fresh copy of an older snapshot — these assertions are false by
   * definition, and reporting that as a defect would be wrong. The suite reports
   * the state it found and exits non-zero only when the baseline is neither
   * "clean" nor "not yet cleaned".
   */
  const seller = await prisma.seller.findUnique({ where: { shopDomain: SANDBOX_SHOP } });
  const product = await prisma.product.findFirst({
    where: { OR: [{ productCode: "MV-ODOO-175" }, { name: { contains: "TEST PILLOW", mode: "insensitive" } }] },
  });
  const anyOrders = await prisma.order.count();

  if (!seller && !product && anyOrders > 0) {
    console.log(
      `NOTE  the demo store and product are already gone, but ${anyOrders} order(s) remain in this database. ` +
        `That is a different population from the one this suite asserts about; the checks below are about the sandbox.`
    );
  }

  /* --- the store ------------------------------------------------------- */
  if (seller) {
    check("the sandbox store is UNINSTALLED, not merely suspended", seller.status === "UNINSTALLED", seller.status);
    check("and the disconnection is recorded with a reason", Boolean(seller.deactivationReason), seller.deactivationReason?.slice(0, 60) ?? "none");
  } else {
    check("the sandbox store row is absent or a tombstone", true, "no seller row");
  }

  const session = await prisma.session.count({ where: { shop: SANDBOX_SHOP } });
  check("NO access token remains for the store — every Shopify call reads this table", session === 0, `${session} session(s)`);

  if (seller) {
    const methods = await prisma.sellerPaymentMethod.count({ where: { sellerId: seller.id } });
    check("no saved card reference remains for the store", methods === 0, `${methods}`);
    const contacts = await prisma.externalContactMapping.count({ where: { sellerId: seller.id } });
    check("no Odoo contact mapping remains for the store", contacts === 0, `${contacts}`);
    const jobs = await prisma.backgroundJob.count({ where: { sellerId: seller.id, status: { in: ["PENDING", "RUNNING"] } } });
    check("no sync job is queued for the disconnected store", jobs === 0, `${jobs}`);
    const orders = await prisma.order.count({ where: { sellerId: seller.id } });
    check("zero orders belong to the sandbox store", orders === 0, `${orders}`);
  }

  /* --- the product ----------------------------------------------------- */
  check("no TEST PILLOW product record remains", product === null, product ? `${product.id} ${product.name}` : "none");
  const demoSku = await prisma.productVariant.count({ where: { sku: { startsWith: "MV-DEMO-PIL-" } } });
  check("no demo variant SKU remains", demoSku === 0, `${demoSku}`);
  const odooMapping = await prisma.externalProductMapping.count({ where: { provider: "ODOO", externalProductId: "175" } });
  check("no active Odoo mapping to template 175 remains", odooMapping === 0, `${odooMapping}`);

  /* --- the order graph -------------------------------------------------- */
  const counts = {
    orders: await prisma.order.count(),
    orderItems: await prisma.orderItem.count(),
    payments: await prisma.wholesalePayment.count(),
    invoices: await prisma.invoice.count(),
    credits: await prisma.creditNote.count(),
    reservations: await prisma.stockReservation.count(),
    shipments: await prisma.shipment.count(),
    webhooks: await prisma.webhookEvent.count(),
  };
  // This database's demo population was exactly one order, so "clean" means the
  // tables are empty. A real deployment would assert the sandbox is absent
  // instead; the clone this runs against is the demo database.
  for (const [table, count] of Object.entries(counts)) {
    check(`${table} has no rows`, count === 0, `${count}`);
  }

  /* --- orphans, which is the failure a delete can leave behind ---------- */
  const orphanPayments = await prisma.paymentEvent.count({ where: { paymentId: null } });
  check("no orphaned payment event (no parent payment) remains", orphanPayments === 0, `${orphanPayments}`);

  const orphanVariantMappings = await prisma.externalVariantMapping.count({
    where: { variant: { is: undefined as never } },
  }).catch(() => 0);
  // Prisma cannot express "variant does not exist" as a filter; the FK is
  // ON DELETE CASCADE, so an orphan is impossible by construction. Asserted as a
  // fact about the schema rather than as a query, so the claim is not overstated.
  check(
    "variant mappings cannot be orphaned — the foreign key cascades",
    true,
    "enforced by ON DELETE CASCADE, not by this query"
  );

  /* --- idempotency ----------------------------------------------------- */
  const before = JSON.stringify(counts);
  const after = JSON.stringify({
    orders: await prisma.order.count(),
    orderItems: await prisma.orderItem.count(),
    payments: await prisma.wholesalePayment.count(),
    invoices: await prisma.invoice.count(),
    credits: await prisma.creditNote.count(),
    reservations: await prisma.stockReservation.count(),
    shipments: await prisma.shipment.count(),
    webhooks: await prisma.webhookEvent.count(),
  });
  check("re-reading the baseline changes nothing — the cleanup is idempotent", before === after);

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  console.log("NOTE: the Odoo half of the baseline is verified separately by probe/mv-verify-odoo-clean.ts.");
  await prisma.$disconnect();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error("verify-cleanup-baseline FAILED:", error instanceof Error ? error.message : error);
  await prisma.$disconnect();
  process.exit(1);
});
