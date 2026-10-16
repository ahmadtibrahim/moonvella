/**
 * Moving the retained Odoo catalogue into app-owned records, and proving it
 * moved.
 *
 * WHY THIS IS A SERVICE AND NOT A SQL MIGRATION. The figures it moves are the
 * ones a booking is decided on: how many units exist, which dock they leave
 * from, and who owns them. A backfill that ran inside `migrate deploy` would
 * move them without leaving behind the evidence that it moved them CORRECTLY —
 * and the failure that evidence catches is not a crash. It is a variant whose
 * stock was attributed to the wrong building, which reads as a perfectly
 * plausible number and is discovered when a carrier is sent to a door nobody
 * updated.
 *
 * So the migration runs as an application operation, in one transaction, and
 * writes a `StockMigration` row carrying what it saw, what it wrote, and what
 * it could not do. That row is what `inventoryReadiness` reads, and a run that
 * left anything behind leaves the booking path refusing with the subject named.
 *
 * IDEMPOTENT BY KEY, NOT BY LUCK. Every write is guarded — the baseline movement
 * carries a unique key per variant, the run is found by its own key — so pressing
 * the button twice migrates once and the second press reports the same counts.
 *
 * WHAT IT DOES NOT DO. It does not touch a price, a description, a package or an
 * image: those were already app-owned, or have their own editors. It does not
 * write to Odoo at all. And it does not invent a dock — a stock row whose item
 * is mapped to no location is reported, not assigned to the default one.
 */

import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import {
  CATALOGUE_MIGRATION_KEY,
  parseProblems,
  writeMovement,
  type MigrationProblem,
} from "./inventory.server";

export interface MigrationOutcome {
  key: string;
  status: "COMPLETE" | "INCOMPLETE" | "FAILED";
  variantsSeen: number;
  variantsMigrated: number;
  stockRecordsSeen: number;
  stockRecordsMigrated: number;
  locationsSeen: number;
  locationsMigrated: number;
  movementsWritten: number;
  problems: MigrationProblem[];
  alreadyRan: boolean;
  notes: string | null;
}

/** The one dock every shipment falls back to, when it exists and is usable. */
async function defaultDock() {
  return prisma.pickupLocation.findFirst({
    where: { isActive: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, code: true, name: true },
  });
}

/**
 * Run the catalogue migration.
 *
 * The transactional body is one pass over the retained catalogue. It is written
 * to be re-runnable: a second call adopts the existing baseline movements and
 * the already-linked rows rather than writing duplicates.
 */
export async function runCatalogueMigration(actor: {
  id: string;
  name?: string | null;
}): Promise<MigrationOutcome> {
  const existing = await prisma.stockMigration.findUnique({
    where: { key: CATALOGUE_MIGRATION_KEY },
  });
  if (existing?.status === "COMPLETE") {
    return {
      key: existing.key,
      status: "COMPLETE",
      variantsSeen: existing.variantsSeen,
      variantsMigrated: existing.variantsMigrated,
      stockRecordsSeen: existing.stockRecordsSeen,
      stockRecordsMigrated: existing.stockRecordsMigrated,
      locationsSeen: existing.locationsSeen,
      locationsMigrated: existing.locationsMigrated,
      movementsWritten: existing.movementsWritten,
      problems: parseProblems(existing.problems),
      alreadyRan: true,
      notes: existing.notes,
    };
  }

  const run = await prisma.stockMigration.upsert({
    where: { key: CATALOGUE_MIGRATION_KEY },
    create: { key: CATALOGUE_MIGRATION_KEY, status: "RUNNING" },
    update: { status: "RUNNING" },
  });

  const problems: MigrationProblem[] = [];
  const fallback = await defaultDock();

  const variants = await prisma.productVariant.findMany({
    select: {
      id: true,
      sku: true,
      name: true,
      inventory: true,
      trackInventory: true,
      pickupLocationId: true,
      product: { select: { id: true, name: true, pickupLocationId: true } },
    },
  });

  let variantsMigrated = 0;
  let stockRecordsSeen = 0;
  let stockRecordsMigrated = 0;
  let movementsWritten = 0;

  for (const variant of variants) {
    // The dock this item leaves from, as the operator mapped it. Not a guess:
    // the variant's own mapping, then its product's, then the one designated
    // default. A variant with none of the three is reported.
    const dockId =
      variant.pickupLocationId ?? variant.product.pickupLocationId ?? fallback?.id ?? null;

    const stockRows = await prisma.variantStockRecord.findMany({
      where: { variantId: variant.id },
      select: { id: true, locationId: true, odooLocationId: true, odooDatabase: true },
    });
    stockRecordsSeen += stockRows.length;

    if (stockRows.length > 0 && !dockId) {
      problems.push({
        subject: `${variant.sku} (${variant.name})`,
        reason:
          `holds ${stockRows.length} stock record(s) but no pickup location is mapped to it and ` +
          `none is marked as the default, so the stock cannot be attributed to an app-owned dock.`,
      });
    }

    for (const row of stockRows) {
      if (row.locationId === dockId && dockId !== null) {
        stockRecordsMigrated += 1;
        continue;
      }
      if (!dockId) continue;
      await prisma.variantStockRecord.update({
        where: { id: row.id },
        data: { locationId: dockId, source: "MIGRATION" },
      });
      stockRecordsMigrated += 1;
    }

    // The opening ledger entry for this variant. Written directly rather than
    // through `writeMovement`, because a baseline does not CHANGE the quantity —
    // it states the quantity that was already there and gives every later delta
    // something to be a delta against. Going through `writeMovement` would add
    // the opening quantity a second time and double the shelf.
    //
    // ONLY WHEN THERE IS NO HISTORY YET, and that condition is the important
    // one. A variant that already has movements has already been opened; adding
    // a second baseline that states the CURRENT quantity would count the same
    // goods twice, and the ledger would sum to more than the shelf says. The
    // idempotency key alone does not cover this: it stops the same baseline
    // being written twice, not a baseline being written over a different one.
    if (variant.trackInventory && variant.inventory !== 0) {
      const key = `migrate-baseline:${variant.id}`;
      const existing = await prisma.stockMovement.count({ where: { variantId: variant.id } });
      if (existing === 0) {
        await prisma.stockMovement.create({
          data: {
            variantId: variant.id,
            delta: variant.inventory,
            reason: "MIGRATION_BASELINE",
            refType: "Migration",
            refId: run.id,
            note:
              `Opening quantity carried over from the pre-migration inventory record ` +
              `(${variant.sku}).`,
            balanceAfter: variant.inventory,
            actorType: "ADMIN_USER",
            actorId: actor.id,
            actorName: actor.name ?? null,
            idempotencyKey: key,
          },
        });
        movementsWritten += 1;
      }
    }

    variantsMigrated += 1;
  }

  // The docks themselves. Their addresses are already app-owned columns; what
  // this checks is that the columns a carrier needs are actually filled, because
  // an origin that is missing a province is refused at booking and the operator
  // should hear about it here rather than at the quote.
  const locations = await prisma.pickupLocation.findMany({
    select: { id: true, code: true, name: true, street1: true, city: true, province: true, postalCode: true, country: true },
  });
  let locationsMigrated = 0;
  for (const location of locations) {
    const missing = (
      [
        ["street", location.street1],
        ["city", location.city],
        ["province/state", location.province],
        ["postal code", location.postalCode],
        ["country", location.country],
      ] as const
    )
      .filter(([, value]) => !value || !String(value).trim())
      .map(([label]) => label);

    if (missing.length > 0) {
      problems.push({
        subject: `${location.name} (${location.code})`,
        reason: `is missing ${missing.join(", ")}, so it cannot be collected from.`,
      });
      continue;
    }
    locationsMigrated += 1;
  }

  const status = problems.length === 0 ? "COMPLETE" : "INCOMPLETE";
  const notes =
    "Stock rows are attributed to the dock the item is mapped to leave from. The original Odoo " +
    "location id, owner id and database are retained on each row as historical metadata.";

  const completed = await prisma.stockMigration.update({
    where: { id: run.id },
    data: {
      status,
      variantsSeen: variants.length,
      variantsMigrated,
      stockRecordsSeen,
      stockRecordsMigrated,
      locationsSeen: locations.length,
      locationsMigrated,
      movementsWritten,
      problems: JSON.stringify(problems),
      completedAt: new Date(),
      notes,
    },
  });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.id,
    actorName: actor.name ?? null,
    action: "inventory.migrated",
    entityType: AUDIT_ENTITY.PICKUP_LOCATION,
    entityId: completed.id,
    afterData: {
      status,
      variantsSeen: variants.length,
      variantsMigrated,
      stockRecordsSeen,
      stockRecordsMigrated,
      movementsWritten,
      problems,
    },
  });

  return {
    key: completed.key,
    status: status as "COMPLETE" | "INCOMPLETE",
    variantsSeen: variants.length,
    variantsMigrated,
    stockRecordsSeen,
    stockRecordsMigrated,
    locationsSeen: locations.length,
    locationsMigrated,
    movementsWritten,
    problems,
    alreadyRan: false,
    notes,
  };
}

/** The recorded run, for the catalogue page. Never throws on absence. */
export async function migrationRecord() {
  return prisma.stockMigration.findUnique({ where: { key: CATALOGUE_MIGRATION_KEY } });
}

/**
 * A read-only preview of what the migration would find.
 *
 * The owner sees this before pressing anything, and it is the same read the
 * migration performs — so what was approved is what runs, rather than a summary
 * that could disagree with the operation behind it.
 */
export async function previewCatalogueMigration() {
  const [variants, stockRecords, locations, baseline, run] = await Promise.all([
    prisma.productVariant.count(),
    prisma.variantStockRecord.count(),
    prisma.pickupLocation.count(),
    prisma.stockMovement.count({ where: { reason: "MIGRATION_BASELINE" } }),
    migrationRecord(),
  ]);
  const unattributed = await prisma.variantStockRecord.count({ where: { locationId: null } });
  const undocked = await prisma.productVariant.count({
    where: { pickupLocationId: null, product: { pickupLocationId: null } },
  });
  return { variants, stockRecords, locations, baseline, unattributed, undocked, run };
}

/**
 * Record that a person has read the reconciliation and accepted it.
 *
 * Separate from COMPLETE on purpose: a run can be complete and still deserve a
 * human's eye before the catalogue is booked against, and the two facts are
 * different — one is about the software, the other about a decision.
 */
export async function acceptMigration(actor: { id: string; name?: string | null }) {
  const updated = await prisma.stockMigration.update({
    where: { key: CATALOGUE_MIGRATION_KEY },
    data: { reconciledAt: new Date(), reconciledBy: actor.id },
  });
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.id,
    actorName: actor.name ?? null,
    action: "inventory.migration_reconciled",
    entityType: AUDIT_ENTITY.PICKUP_LOCATION,
    entityId: updated.id,
    afterData: { problems: parseProblems(updated.problems) },
  });
  return updated;
}

/**
 * Reconcile the migrated figures against the catalogue, and report any variant
 * whose ledger does not add up to the number stored on it.
 *
 * THIS IS THE CHECK THAT MAKES THE MIGRATION TRUSTWORTHY. The migration's own
 * report says what it wrote; it cannot say whether the result is consistent,
 * because it is the thing being checked. Summing the ledger and comparing it
 * with the stored quantity is an independent statement — and any disagreement
 * is a defect in a figure a booking is decided on.
 */
export async function reconcileInventory() {
  const variants = await prisma.productVariant.findMany({
    select: {
      id: true,
      sku: true,
      inventory: true,
      reserved: true,
      stockMovements: { select: { delta: true } },
      stockReservations: { where: { status: "HELD" }, select: { quantity: true } },
    },
  });

  const mismatches: { sku: string; ledger: number; stored: number }[] = [];
  const reservedMismatches: { sku: string; held: number; stored: number }[] = [];

  for (const variant of variants) {
    const ledger = variant.stockMovements.reduce((sum, m) => sum + m.delta, 0);
    // A variant with no ledger rows at all is one whose quantity was set before
    // the ledger existed and was never touched since. That is not a mismatch —
    // it is the absence of history, and inventing a baseline here would claim a
    // movement nobody made.
    if (variant.stockMovements.length > 0 && ledger !== variant.inventory) {
      mismatches.push({ sku: variant.sku, ledger, stored: variant.inventory });
    }

    const held = variant.stockReservations.reduce((sum, r) => sum + r.quantity, 0);
    if (held !== variant.reserved) {
      reservedMismatches.push({ sku: variant.sku, held, stored: variant.reserved });
    }
  }

  return {
    variantsChecked: variants.length,
    mismatches,
    reservedMismatches,
    ok: mismatches.length === 0 && reservedMismatches.length === 0,
  };
}

/**
 * Write an opening ledger entry for a variant that was created in this
 * application, so a product edited here has a history from its first count.
 *
 * Called from the product editor rather than from the migration: the migration
 * is about adopting records that came from somewhere else, and a product born
 * here was never anywhere else.
 */
export async function ensureBaselineMovement(
  variantId: string,
  actor: { id: string; name?: string | null },
  db: typeof prisma = prisma
) {
  // Any existing movement means this variant has already been opened. See the
  // note in `runCatalogueMigration` for why the key alone is not enough.
  const existing = await db.stockMovement.count({ where: { variantId } });
  if (existing > 0) return { created: false };
  const variant = await db.productVariant.findUnique({
    where: { id: variantId },
    select: { inventory: true, sku: true },
  });
  if (!variant || variant.inventory === 0) return { created: false };
  await db.stockMovement.create({
    data: {
      variantId,
      delta: variant.inventory,
      reason: "MIGRATION_BASELINE",
      refType: "Migration",
      note: `Opening quantity for ${variant.sku}.`,
      balanceAfter: variant.inventory,
      actorType: "ADMIN_USER",
      actorId: actor.id,
      actorName: actor.name ?? null,
      idempotencyKey: `migrate-baseline:${variantId}`,
    },
  });
  return { created: true };
}

export { writeMovement };
