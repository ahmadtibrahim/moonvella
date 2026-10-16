/**
 * App-owned inventory: the ledger, the holds, and the migration gate.
 *
 * WHAT THIS SUITE IS FOR. The stock figures in this application decide whether an
 * order can be taken, and they used to come from an ERP. Three things therefore
 * have to be true now, and none of them is observable from a page:
 *
 *   1. The ledger explains the number. Every change to on-hand writes a movement
 *      in the same transaction, so the figure is the sum of its recorded history.
 *   2. A hold is taken once, across a double-click, a retried worker and a
 *      replayed webhook — and releasing it gives the stock back without ever
 *      looking like a receipt.
 *   3. Booking refuses when the catalogue has not been migrated, and refuses with
 *      the subject named rather than with a number that looks plausible.
 *
 * The lifecycle checks drive the real service functions against the clone. The
 * pure decision functions are checked directly, because the boundary cases that
 * matter — an existing hold, an insufficient shelf — are hard to arrange through
 * real shipments and trivial to state as inputs.
 *
 * Nothing here calls a provider: no eShipper, no Shopify, no Stripe, no Odoo.
 */

import { PrismaClient } from "@prisma/client";
import {
  adjustStock,
  holdForShipment,
  releaseHoldsForShipment,
  fulfilHoldsForShipment,
  inventoryReadiness,
  planHold,
  parseProblems,
  stockAtLocation,
  writeMovement,
} from "../app/services/inventory.server";
import { runCatalogueMigration, reconcileInventory } from "../app/services/inventoryMigration.server";
import { forbidProviderCalls } from "./provider-guard";

const prisma = new PrismaClient();
const SHOP = "inventory-test.myshopify.com";
const SKU_PREFIX = "MV-INV-TEST-";

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Remove everything this suite created.
 *
 * The shared migration row is deliberately NOT touched here; the note at the end
 * of `main` explains why, and why restoring it was the wrong idea.
 */
async function cleanup() {
  const seller = await prisma.seller.findUnique({ where: { shopDomain: SHOP } });
  if (seller) {
    const orders = await prisma.order.findMany({ where: { sellerId: seller.id }, select: { id: true } });
    const orderIds = orders.map((o) => o.id);
    const shipments = await prisma.shipment.findMany({
      where: { orderId: { in: orderIds } },
      select: { id: true },
    });
    const shipmentIds = shipments.map((s) => s.id);
    await prisma.stockReservation.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
    await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: orderIds } } } });
    await prisma.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { sellerId: seller.id } });
    await prisma.seller.delete({ where: { id: seller.id } });
  }

  const products = await prisma.product.findMany({
    where: { variants: { some: { sku: { startsWith: SKU_PREFIX } } } },
    select: { id: true },
  });
  const productIds = products.map((p) => p.id);
  const variants = await prisma.productVariant.findMany({
    where: { sku: { startsWith: SKU_PREFIX } },
    select: { id: true },
  });
  const variantIds = variants.map((v) => v.id);
  await prisma.stockReservation.deleteMany({ where: { variantId: { in: variantIds } } });
  await prisma.stockMovement.deleteMany({ where: { variantId: { in: variantIds } } });
  await prisma.variantStockRecord.deleteMany({ where: { variantId: { in: variantIds } } });
  await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
}

async function makeVariant(skuSuffix: string, inventory: number) {
  const product = await prisma.product.create({
    data: {
      name: `Inventory Test ${skuSuffix}`,
      category: "Test",
      productCode: `MV-INV-${skuSuffix}`,
      currency: "CAD",
      status: "DRAFT",
    },
  });
  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      sku: `${SKU_PREFIX}${skuSuffix}`,
      name: `Inventory Test ${skuSuffix}`,
      wholesalePrice: 1000,
      suggestedRetailPrice: 2000,
      inventory,
      currency: "CAD",
    },
  });
  return { product, variant };
}

async function main() {
  forbidProviderCalls("verify-inventory");
  await cleanup();

  const dock = await prisma.pickupLocation.findFirst({ orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });

  /* ------------------------------------------------------------------ */
  /* 1. The decision function, on its own                                */
  /* ------------------------------------------------------------------ */

  check(
    "a hold for zero or fewer units is refused",
    planHold({ requested: 0, alreadyHeld: 0, available: 10, sku: "S" }).action === "REFUSE"
  );
  check(
    "an existing hold is REUSED rather than refused when the shelf has since emptied",
    (() => {
      const plan = planHold({ requested: 5, alreadyHeld: 5, available: 0, sku: "S" });
      return plan.action === "REUSE" && plan.quantity === 5;
    })(),
    "the booking that created the hold is the one being replayed"
  );
  check(
    "an insufficient shelf refuses, and says by how much",
    (() => {
      const plan = planHold({ requested: 5, alreadyHeld: 0, available: 2, sku: "MV-X" });
      return plan.action === "REFUSE" && plan.reason.includes("MV-X") && plan.reason.includes("2");
    })()
  );
  check(
    "a shelf with exactly enough creates the hold",
    planHold({ requested: 4, alreadyHeld: 0, available: 4, sku: "S" }).action === "CREATE"
  );

  check(
    "malformed migration problems parse to an empty list rather than throwing",
    parseProblems("not json").length === 0 && parseProblems("{}").length === 0
  );
  check(
    "recorded migration problems survive a round trip",
    parseProblems(JSON.stringify([{ subject: "A", reason: "B" }]))[0].reason === "B"
  );

  /* ------------------------------------------------------------------ */
  /* 2. The ledger explains the number                                   */
  /* ------------------------------------------------------------------ */

  const { variant: ledgerVariant } = await makeVariant("LEDGER", 10);

  /*
   * The baseline is written DIRECTLY, not through `writeMovement`, because that
   * is what the migration does and the difference is the whole point: a baseline
   * states the quantity that is already there. Routing it through
   * `writeMovement` would ADD the opening quantity and double the shelf — which
   * this suite found, on itself, the first time it ran.
   */
  await prisma.stockMovement.create({
    data: {
      variantId: ledgerVariant.id,
      delta: 10,
      reason: "MIGRATION_BASELINE",
      balanceAfter: 10,
      note: "Opening quantity for the ledger test.",
      idempotencyKey: `test-baseline:${ledgerVariant.id}`,
    },
  });
  const afterBaseline = await prisma.productVariant.findUniqueOrThrow({ where: { id: ledgerVariant.id } });
  check(
    "a baseline movement states the opening quantity without changing it",
    afterBaseline.inventory === 10,
    `inventory=${afterBaseline.inventory}`
  );

  const receipt = await writeMovement(prisma, {
    variantId: ledgerVariant.id,
    delta: 5,
    reason: "RECEIPT",
    idempotencyKey: `test-receipt:${ledgerVariant.id}`,
  });
  check("a receipt raises on-hand by its delta", "balanceAfter" in receipt && receipt.balanceAfter === 15);

  const replayed = await writeMovement(prisma, {
    variantId: ledgerVariant.id,
    delta: 5,
    reason: "RECEIPT",
    idempotencyKey: `test-receipt:${ledgerVariant.id}`,
  });
  check(
    "a replayed movement with the same key writes NOTHING and does not move the figure again",
    "duplicate" in replayed &&
      (await prisma.productVariant.findUniqueOrThrow({ where: { id: ledgerVariant.id } })).inventory === 15
  );

  let refusedNegative = false;
  try {
    await writeMovement(prisma, { variantId: ledgerVariant.id, delta: -100, reason: "ADJUSTMENT" });
  } catch {
    refusedNegative = true;
  }
  check("a movement that would take a variant below zero is refused", refusedNegative);

  let refusedZero = false;
  try {
    await writeMovement(prisma, { variantId: ledgerVariant.id, delta: 0, reason: "ADJUSTMENT" });
  } catch {
    refusedZero = true;
  }
  check("a movement with a zero delta is refused — it is not a movement", refusedZero);

  const movements = await prisma.stockMovement.findMany({ where: { variantId: ledgerVariant.id } });
  const ledgerSum = movements.reduce((sum, m) => sum + m.delta, 0);
  check(
    "the ledger sums to the stored quantity",
    ledgerSum === 15,
    `sum=${ledgerSum} stored=15`
  );

  await adjustStock({
    variantId: ledgerVariant.id,
    delta: -3,
    note: "One carton crushed in the aisle.",
    actor: { id: "verify-inventory", name: "Inventory suite" },
  });
  const auditRow = await prisma.auditLog.findFirst({
    where: { entityType: "ProductVariant", entityId: ledgerVariant.id, action: "stock.adjusted" },
  });
  check("an operator adjustment is audited against the variant", Boolean(auditRow));

  /* ------------------------------------------------------------------ */
  /* 3. Holds: taken once, released once, consumed at dispatch           */
  /* ------------------------------------------------------------------ */

  const { variant: holdVariant } = await makeVariant("HOLD", 8);
  await prisma.stockMovement.create({
    data: {
      variantId: holdVariant.id,
      delta: 8,
      reason: "MIGRATION_BASELINE",
      balanceAfter: 8,
      idempotencyKey: `test-baseline:${holdVariant.id}`,
    },
  });

  const position = await stockAtLocation(holdVariant.id, dock?.id ?? null);
  check(
    "a variant with no per-dock breakdown falls back to its own total",
    position.source === "VARIANT_TOTAL" && position.available === 8,
    `source=${position.source} available=${position.available}`
  );

  const hold = await prisma.$transaction((tx) =>
    holdForShipment(tx, {
      shipmentId: "test-shipment-1",
      orderId: "test-order-1",
      lines: [{ variantId: holdVariant.id, sku: holdVariant.sku, quantity: 3 }],
      locationId: dock?.id ?? null,
    })
  );
  check("a hold is created for the requested quantity", hold.held[0]?.quantity === 3);

  const afterHold = await prisma.productVariant.findUniqueOrThrow({ where: { id: holdVariant.id } });
  check(
    "a hold raises `reserved` and leaves on-hand alone",
    afterHold.inventory === 8 && afterHold.reserved === 3,
    `inventory=${afterHold.inventory} reserved=${afterHold.reserved}`
  );

  const replay = await prisma.$transaction((tx) =>
    holdForShipment(tx, {
      shipmentId: "test-shipment-1",
      orderId: "test-order-1",
      lines: [{ variantId: holdVariant.id, sku: holdVariant.sku, quantity: 3 }],
      locationId: dock?.id ?? null,
    })
  );
  const afterReplay = await prisma.productVariant.findUniqueOrThrow({ where: { id: holdVariant.id } });
  check(
    "replaying the same hold REUSES it — reserved does not double",
    replay.held[0]?.quantity === 3 && afterReplay.reserved === 3,
    `reserved=${afterReplay.reserved}`
  );

  let oversellRefused = false;
  try {
    await prisma.$transaction((tx) =>
      holdForShipment(tx, {
        shipmentId: "test-shipment-2",
        orderId: "test-order-2",
        lines: [{ variantId: holdVariant.id, sku: holdVariant.sku, quantity: 6 }],
        locationId: dock?.id ?? null,
      })
    );
  } catch (error) {
    oversellRefused = error instanceof Error && error.message.includes("available");
  }
  check("a second shipment cannot hold more than what is left", oversellRefused);

  const shipped = await prisma.$transaction((tx) =>
    fulfilHoldsForShipment(tx, "test-shipment-1", { id: "verify-inventory", name: "Inventory suite" })
  );
  const afterShip = await prisma.productVariant.findUniqueOrThrow({ where: { id: holdVariant.id } });
  check(
    "dispatch consumes the hold: on-hand falls, the promise comes down",
    shipped.shipped[0]?.quantity === 3 && afterShip.inventory === 5 && afterShip.reserved === 0,
    `inventory=${afterShip.inventory} reserved=${afterShip.reserved}`
  );

  const secondShip = await prisma.$transaction((tx) =>
    fulfilHoldsForShipment(tx, "test-shipment-1", { id: "verify-inventory", name: "Inventory suite" })
  );
  const afterSecondShip = await prisma.productVariant.findUniqueOrThrow({ where: { id: holdVariant.id } });
  check(
    "a replayed dispatch deducts NOTHING a second time",
    secondShip.shipped.length === 0 && afterSecondShip.inventory === 5,
    `inventory=${afterSecondShip.inventory}`
  );

  // Release, on a fresh hold: the stock must come back without a receipt.
  await prisma.$transaction((tx) =>
    holdForShipment(tx, {
      shipmentId: "test-shipment-3",
      orderId: "test-order-3",
      lines: [{ variantId: holdVariant.id, sku: holdVariant.sku, quantity: 2 }],
      locationId: dock?.id ?? null,
    })
  );
  const movementsBeforeRelease = await prisma.stockMovement.count({ where: { variantId: holdVariant.id } });
  const released = await prisma.$transaction((tx) =>
    releaseHoldsForShipment(tx, "test-shipment-3", "Cancelled with the carrier.")
  );
  const afterRelease = await prisma.productVariant.findUniqueOrThrow({ where: { id: holdVariant.id } });
  const movementsAfterRelease = await prisma.stockMovement.count({ where: { variantId: holdVariant.id } });
  check(
    "a confirmed cancellation gives the hold back and writes NO movement",
    released.released[0]?.quantity === 2 &&
      afterRelease.reserved === 0 &&
      afterRelease.inventory === 5 &&
      movementsAfterRelease === movementsBeforeRelease,
    `reserved=${afterRelease.reserved} inventory=${afterRelease.inventory}`
  );

  const releaseAgain = await prisma.$transaction((tx) =>
    releaseHoldsForShipment(tx, "test-shipment-3", "Cancelled again.")
  );
  check("releasing twice releases nothing the second time", releaseAgain.released.length === 0);

  /* ------------------------------------------------------------------ */
  /* 4. Other docks, and the "we cannot say" case                        */
  /* ------------------------------------------------------------------ */

  const { variant: splitVariant } = await makeVariant("SPLIT", 0);
  const otherDock = await prisma.pickupLocation.create({
    data: { code: `MV-INV-DOCK-${Date.now()}`, name: "Inventory suite dock", isActive: true },
  });
  await prisma.variantStockRecord.create({
    data: {
      variantId: splitVariant.id,
      locationId: otherDock.id,
      locationName: otherDock.name,
      quantity: 7,
      reservedQuantity: 0,
      source: "APP",
    },
  });

  const atOther = await stockAtLocation(splitVariant.id, otherDock.id);
  check(
    "a variant broken down by dock reads its rows at the mapped dock",
    atOther.source === "LOCATION_RECORDS" && atOther.available === 7,
    `source=${atOther.source} available=${atOther.available}`
  );

  const atWrongDock = await stockAtLocation(splitVariant.id, dock?.id ?? "not-a-dock");
  check(
    "a dock with no rows for a broken-down variant reports 0 with a REASON, not silently",
    atWrongDock.available === 0 &&
      atWrongDock.source === "OTHER_LOCATIONS" &&
      (atWrongDock.reason ?? "").includes("other location")
  );

  const untracked = await prisma.productVariant.create({
    data: {
      productId: (await prisma.product.findFirstOrThrow({ where: { productCode: "MV-INV-SPLIT" } })).id,
      sku: `${SKU_PREFIX}UNTRACKED`,
      name: "Not stock tracked",
      wholesalePrice: 100,
      suggestedRetailPrice: 200,
      inventory: 0,
      trackInventory: false,
      currency: "CAD",
    },
  });
  const untrackedPosition = await stockAtLocation(untracked.id, dock?.id ?? null);
  check(
    "a variant that is not stock-tracked is never refused for want of stock",
    untrackedPosition.reason === null && untrackedPosition.available > 0
  );

  await prisma.variantStockRecord.deleteMany({ where: { locationId: otherDock.id } });
  await prisma.pickupLocation.delete({ where: { id: otherDock.id } });

  /* ------------------------------------------------------------------ */
  /* 5. The migration, and the booking gate that reads it                */
  /* ------------------------------------------------------------------ */

  await prisma.stockMigration.deleteMany({ where: { key: "verify-inventory-none" } });
  const missing = await inventoryReadiness(prisma, "verify-inventory-none");
  check(
    "a catalogue with variants and NO migration row is refused, with the reason named",
    !missing.ok && missing.status === "NOT_RUN" && (missing.blocker ?? "").includes("migrated")
  );

  await prisma.stockMigration.create({
    data: {
      key: "verify-inventory-failed",
      status: "INCOMPLETE",
      problems: JSON.stringify([{ subject: "MV-X (Widget)", reason: "has no pickup location." }]),
    },
  });
  const incomplete = await inventoryReadiness(prisma, "verify-inventory-failed");
  check(
    "an INCOMPLETE migration refuses and names the subject it could not migrate",
    !incomplete.ok && (incomplete.blocker ?? "").includes("MV-X")
  );
  await prisma.stockMigration.delete({ where: { key: "verify-inventory-failed" } });

  await prisma.stockMigration.create({ data: { key: "verify-inventory-ok", status: "COMPLETE" } });
  const complete = await inventoryReadiness(prisma, "verify-inventory-ok");
  check("a COMPLETE migration passes the booking gate", complete.ok);
  await prisma.stockMigration.delete({ where: { key: "verify-inventory-ok" } });

  /*
   * The clone's own migration history is snapshotted before the migration runs
   * and restored afterwards.
   *
   * Deleting the `StockMigration` ROW is not enough to undo a run: the opening
   * ledger entries it wrote belong to the clone's retained catalogue and would
   * survive, so the next suite to run would see baselines it did not create and
   * a reconciliation that counts them. That is exactly what made this suite fail
   * on its second run and pass on its third while nothing about the code had
   * changed.
   */
  const baselinesBefore = new Set(
    (
      await prisma.stockMovement.findMany({
        where: { reason: "MIGRATION_BASELINE" },
        select: { id: true },
      })
    ).map((row) => row.id)
  );

  const outcome = await runCatalogueMigration({ id: "verify-inventory", name: "Inventory suite" });
  check(
    "the migration runs and records what it saw",
    outcome.variantsSeen >= 3 && outcome.variantsMigrated === outcome.variantsSeen,
    `seen=${outcome.variantsSeen} migrated=${outcome.variantsMigrated}`
  );

  /*
   * THE PROPERTY THAT MATTERS: a variant that already has ledger history gets NO
   * second baseline.
   *
   * Asserted on a variant this suite owns, rather than on the migration's
   * `movementsWritten` count. That count depends on how much history the clone
   * happens to carry, so it is not a fact about the code — it is a fact about the
   * fixture, and a check written against it passes or fails for the wrong reason.
   * The first version of this suite made exactly that mistake.
   *
   * A second baseline is not harmless. It states the CURRENT quantity as an
   * opening quantity, so the same goods are counted twice and the ledger sums to
   * more than the shelf says — a figure that looks entirely plausible.
   */
  const preLedger = await makeVariant("PRELEDGER", 6);
  await prisma.stockMovement.create({
    data: {
      variantId: preLedger.variant.id,
      delta: 6,
      reason: "MIGRATION_BASELINE",
      balanceAfter: 6,
      idempotencyKey: `test-baseline:${preLedger.variant.id}`,
    },
  });
  await runCatalogueMigration({ id: "verify-inventory", name: "Inventory suite" });
  const preLedgerMovements = await prisma.stockMovement.findMany({
    where: { variantId: preLedger.variant.id, reason: "MIGRATION_BASELINE" },
  });
  check(
    "a variant that already has ledger history does NOT get a second baseline",
    preLedgerMovements.length === 1,
    `baselines=${preLedgerMovements.length}`
  );

  check(
    "the migration attributes adopted stock rows to an app-owned dock",
    await (async () => {
      const rows = await prisma.variantStockRecord.findMany({ where: { source: "MIGRATION" } });
      return rows.length === 0 || rows.every((row) => row.locationId !== null);
    })()
  );

  const rerun = await runCatalogueMigration({ id: "verify-inventory", name: "Inventory suite" });
  check(
    "re-running the migration is a no-op that reports the same counts",
    rerun.alreadyRan === true && rerun.movementsWritten === outcome.movementsWritten,
    `alreadyRan=${rerun.alreadyRan}`
  );

  const reconciliation = await reconcileInventory();
  check(
    "the ledger reconciles against every stored quantity",
    reconciliation.ok,
    reconciliation.ok
      ? `${reconciliation.variantsChecked} checked`
      : `mismatches: ${reconciliation.mismatches
          .map((m) => `${m.sku} ledger=${m.ledger} stored=${m.stored}`)
          .join("; ")} | reserved: ${reconciliation.reservedMismatches
          .map((m) => `${m.sku} held=${m.held} stored=${m.stored}`)
          .join("; ")}`
  );

  await cleanup();
  // Every baseline this run added, removed — leaving the clone's own history
  // exactly as it was found.
  const leftover = await prisma.stockMovement.findMany({
    where: { reason: "MIGRATION_BASELINE" },
    select: { id: true, variantId: true },
  });
  const added = leftover.filter((row) => !baselinesBefore.has(row.id));
  if (added.length > 0) {
    await prisma.stockMovement.deleteMany({ where: { id: { in: added.map((row) => row.id) } } });
  }

  /*
   * THE MIGRATION ROW ITSELF IS LEFT IN PLACE, at COMPLETE.
   *
   * It used to be restored to whatever it was before, and that was wrong: a
   * clone that mirrors a deployed application SHOULD have a completed migration,
   * because the application refuses to book without one. Restoring "absent" put
   * the clone into a state production will never be in, and every suite that
   * books a shipment then failed on a gate that was working correctly.
   *
   * The negative cases this suite cares about are asserted against its OWN keys
   * — `verify-inventory-none` and `verify-inventory-failed` — which is why they
   * are separate rows rather than a temporary edit of the shared one.
   */

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error("verify-inventory FAILED:", error instanceof Error ? error.message : error);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
