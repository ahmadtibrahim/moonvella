/**
 * MoonVella's own inventory: what is on the shelf, what is spoken for, and what
 * changed it.
 *
 * WHY THIS MODULE EXISTS. Until 2026-10-16 the answer to "how many are left"
 * came from Odoo. `stock.quant` was read over JSON-RPC at booking time, the
 * catalogue's figures were refreshed by a six-hourly ERP sync, and a pickup
 * location was unusable unless it carried four Odoo ids. The owner's instruction
 * is that MoonVella's catalogue and accounting are its own, so the stock has to
 * be too — and a stock figure read from a system this application no longer
 * owns is a figure that can silently be about a different company.
 *
 * THREE FACTS, THREE PLACES, AND THEY ARE NOT INTERCHANGEABLE.
 *
 *   on-hand    `ProductVariant.inventory`. How many exist. Moved only by
 *              StockMovement rows, every one of which is written in the same
 *              transaction as the figure it explains.
 *   reserved   `ProductVariant.reserved`, a rollup maintained from
 *              StockReservation rows. How many are already promised.
 *   available  on-hand minus reserved, computed. What a new booking may take.
 *
 * A RESERVATION IS NOT A MOVEMENT, and the two are deliberately not the same
 * table. Holding stock for a shipment that has not left changes nothing about
 * how much exists; only the promise. A released hold gives stock back without a
 * receipt ever having happened. If both were movements, a cancelled booking
 * would leave the ledger looking like goods arrived, and the one question the
 * ledger exists to answer — "what physically changed, and when" — would stop
 * being answerable.
 *
 * EXACTLY ONCE, ACROSS EVERY WRITER. Booking is reachable from a double-clicked
 * button, a retried worker and a replayed webhook, and all three must take the
 * same hold rather than three. Both the hold and the movement carry an
 * `idempotencyKey` that is UNIQUE in the database, so the guard is the
 * constraint and not a check-then-write in application code — a check that two
 * concurrent requests can both pass.
 *
 * NOTHING HERE EVER GUESSES A QUANTITY. `availableAt` returns a reason instead
 * of a number when the stock genuinely cannot be stated, because zero and "we
 * cannot say" read identically in a number field and mean opposite things: one
 * correctly refuses a sale, the other refuses a sale that was possible.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

/** The key under which the one catalogue migration is recorded. */
export const CATALOGUE_MIGRATION_KEY = "odoo-catalogue-2026-10-16";

/**
 * The stock position of one variant at one dock, as this application knows it.
 *
 * `source` says WHICH question was answered, because they are not the same
 * question and a reader deserves to know which one they are looking at:
 *
 *   LOCATION_RECORDS  the variant has rows for this dock, and the figures are
 *                     those rows. This is the multi-dock case.
 *   VARIANT_TOTAL     the variant has no per-location rows, so its own
 *                     `inventory` is the whole answer. This is every product
 *                     created in this app rather than imported.
 *   OTHER_LOCATIONS   the variant is broken down, but not at this dock, so
 *                     there is nothing here. Available is 0 and the reason names
 *                     the situation — this is NOT the same as "no stock
 *                     anywhere", and the message has to say so.
 */
export type StockSource = "LOCATION_RECORDS" | "VARIANT_TOTAL" | "OTHER_LOCATIONS";

export interface StockPosition {
  onHand: number;
  reserved: number;
  available: number;
  source: StockSource;
  /** Set when the figures could not be stated. Absence is never shown as zero. */
  reason: string | null;
}

/**
 * The verdict on whether stock is usable at all, for the booking gate.
 *
 * `blocker` is set only for a catalogue that has not been migrated, which is the
 * one condition under which a stock figure can be wrong for a reason no operator
 * can see from the numbers.
 */
export interface InventoryReadiness {
  ok: boolean;
  blocker: string | null;
  migrationKey: string;
  status: string;
}

/* -------------------------------------------------------------------------- */
/* The ledger                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Write one movement and move the variant's on-hand by the same amount, in the
 * caller's transaction.
 *
 * THE ORDER MATTERS. The row is inserted FIRST: a movement carrying an
 * `idempotencyKey` that is already present raises a unique violation, and
 * raising it before the quantity has moved is what makes the operation
 * all-or-nothing. Updating first and inserting after would leave the figure
 * changed by a replay whose ledger row was then rejected.
 *
 * A zero delta is refused rather than stored. A movement that changed nothing
 * is not a movement, and a ledger with rows that move nothing cannot be read as
 * a history of what changed.
 *
 * On-hand is allowed to go negative ONLY when the caller says so. Booking is
 * refused earlier by `availableAt`, so a negative here is a receipt that was
 * recorded against a count nobody took, and an operator needs to see it rather
 * than have it clamped to zero.
 */
export async function writeMovement(
  db: Db,
  input: {
    variantId: string;
    delta: number;
    reason: Prisma.StockMovementCreateInput["reason"];
    refType?: string | null;
    refId?: string | null;
    note?: string | null;
    idempotencyKey?: string | null;
    actorType?: "ADMIN_USER" | "SYSTEM" | "MERCHANT" | "WEBHOOK";
    actorId?: string | null;
    actorName?: string | null;
    allowNegative?: boolean;
  }
): Promise<{ movementId: string; balanceAfter: number } | { duplicate: true }> {
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new Error(
      `A stock movement must carry a non-zero integer delta; received ${input.delta}.`
    );
  }

  const variant = await db.productVariant.findUnique({
    where: { id: input.variantId },
    select: { id: true, inventory: true, sku: true },
  });
  if (!variant) throw new Error(`Cannot move stock: variant ${input.variantId} does not exist.`);

  const balanceAfter = variant.inventory + input.delta;
  if (balanceAfter < 0 && !input.allowNegative) {
    throw new Error(
      `Refusing to take ${variant.sku} below zero: ${variant.inventory} on hand and a change of ` +
        `${input.delta} would leave ${balanceAfter}.`
    );
  }

  let movementId: string;
  try {
    const created = await db.stockMovement.create({
      data: {
        variantId: input.variantId,
        delta: input.delta,
        reason: input.reason,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        note: input.note ?? null,
        balanceAfter,
        actorType: input.actorType ?? "SYSTEM",
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      },
      select: { id: true },
    });
    movementId = created.id;
  } catch (error) {
    if (isUniqueViolation(error)) return { duplicate: true };
    throw error;
  }

  await db.productVariant.update({
    where: { id: input.variantId },
    data: { inventory: balanceAfter },
  });

  return { movementId, balanceAfter };
}

/** Prisma's code for a unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/* -------------------------------------------------------------------------- */
/* Reading a position                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What is on hand and available for one variant at one dock.
 *
 * THE DOCK IS THE MAPPED ONE, NOT A CONFIGURED ONE. A catalogue figure answers
 * "how much do we have anywhere we ship from"; a shipment is a different
 * question, because an item mapped to a second dock must be filled from that
 * dock. So the mapping decides which rows count.
 */
export async function stockAtLocation(
  variantId: string,
  locationId: string | null,
  db: Db = prisma
): Promise<StockPosition> {
  const variant = await db.productVariant.findUnique({
    where: { id: variantId },
    select: { id: true, sku: true, inventory: true, reserved: true, trackInventory: true },
  });
  if (!variant) {
    return {
      onHand: 0,
      reserved: 0,
      available: 0,
      source: "VARIANT_TOTAL",
      reason: `Variant ${variantId} does not exist.`,
    };
  }

  // A variant that is not stock-tracked has no stock question to answer. Its
  // `inventory` is advisory, and reporting it as available would let a booking
  // gate refuse a sale over a number that was never meant to be enforced.
  if (!variant.trackInventory) {
    return {
      onHand: 0,
      reserved: 0,
      available: Number.MAX_SAFE_INTEGER,
      source: "VARIANT_TOTAL",
      reason: null,
    };
  }

  const rows = await db.variantStockRecord.findMany({
    where: { variantId },
    select: { locationId: true, quantity: true, reservedQuantity: true },
  });

  // No breakdown anywhere: the variant's own figure is the whole answer. This
  // is the ordinary case for a product created in this application.
  if (rows.length === 0) {
    const available = variant.inventory - variant.reserved;
    return {
      onHand: variant.inventory,
      reserved: variant.reserved,
      available,
      source: "VARIANT_TOTAL",
      reason: null,
    };
  }

  const here = rows.filter((row) => row.locationId === locationId);
  if (here.length === 0) {
    return {
      onHand: 0,
      reserved: 0,
      available: 0,
      source: "OTHER_LOCATIONS",
      reason:
        `${variant.sku} is recorded at ${rows.length} other location(s), but none of them is this ` +
        `dock, so there is no stock here to ship. Move stock to this location or map the item to ` +
        `the dock it is held at.`,
    };
  }

  const onHand = here.reduce((sum, row) => sum + row.quantity, 0);
  const reservedHere = here.reduce((sum, row) => sum + row.reservedQuantity, 0);
  // The variant-level hold rollup is what reservations maintain, and where a
  // variant is broken down by dock those holds are not attributed to one. The
  // rollup is therefore the figure that can be released correctly, and the
  // per-row `reservedQuantity` is reported but not subtracted twice.
  const reserved = Math.max(reservedHere, variant.reserved);
  return {
    onHand,
    reserved,
    available: onHand - reserved,
    source: "LOCATION_RECORDS",
    reason: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Reservation lifecycle                                                      */
/* -------------------------------------------------------------------------- */

/** The key that makes a hold for one shipment and one variant happen once. */
export function holdKey(shipmentId: string, variantId: string): string {
  return `hold:${shipmentId}:${variantId}`;
}

/**
 * What a hold attempt would do, as a decision that can be read without a
 * database. Kept pure so a suite can drive the boundary cases — an existing
 * hold, an insufficient shelf — without arranging real shipments.
 */
export type HoldPlan =
  | { action: "CREATE"; quantity: number }
  | { action: "REUSE"; quantity: number }
  | { action: "REFUSE"; reason: string };

export function planHold(input: {
  requested: number;
  alreadyHeld: number;
  available: number;
  sku: string;
}): HoldPlan {
  if (input.requested <= 0) {
    return { action: "REFUSE", reason: "A hold must be for at least one unit." };
  }
  // An existing hold is reused whatever the shelf now says. The booking that
  // created it is the one being replayed, and refusing it here would fail a
  // request that had already succeeded.
  if (input.alreadyHeld > 0) return { action: "REUSE", quantity: input.alreadyHeld };

  if (input.available < input.requested) {
    return {
      action: "REFUSE",
      reason:
        `Not enough stock to hold: ${input.sku} has ${input.available} available and this shipment ` +
        `needs ${input.requested}.`,
    };
  }
  return { action: "CREATE", quantity: input.requested };
}

/**
 * Hold stock for a shipment, once.
 *
 * The hold does not move on-hand; it raises `reserved`, which is what makes the
 * units unavailable to the next booking while leaving the shelf count alone.
 */
export async function holdForShipment(
  tx: Tx,
  input: {
    shipmentId: string;
    orderId: string;
    lines: { variantId: string; sku: string; quantity: number }[];
    locationId: string | null;
    actorId?: string | null;
    actorName?: string | null;
  }
): Promise<{ held: { variantId: string; quantity: number }[] }> {
  const held: { variantId: string; quantity: number }[] = [];

  for (const line of input.lines) {
    if (line.quantity <= 0) continue;

    const key = holdKey(input.shipmentId, line.variantId);
    const existing = await tx.stockReservation.findUnique({ where: { idempotencyKey: key } });
    const position = await stockAtLocation(line.variantId, input.locationId, tx);

    const plan = planHold({
      requested: line.quantity,
      alreadyHeld: existing?.status === "HELD" ? existing.quantity : 0,
      available: position.available,
      sku: line.sku,
    });

    if (plan.action === "REFUSE") throw new Error(plan.reason);
    if (plan.action === "REUSE") {
      held.push({ variantId: line.variantId, quantity: plan.quantity });
      continue;
    }

    await tx.stockReservation.create({
      data: {
        variantId: line.variantId,
        quantity: plan.quantity,
        status: "HELD",
        shipmentId: input.shipmentId,
        orderId: input.orderId,
        idempotencyKey: key,
      },
    });
    await tx.productVariant.update({
      where: { id: line.variantId },
      data: { reserved: { increment: plan.quantity } },
    });
    held.push({ variantId: line.variantId, quantity: plan.quantity });
  }

  return { held };
}

/**
 * Give back every hold a shipment took.
 *
 * RELEASING TWICE IS SAFE AND RELEASES NOTHING THE SECOND TIME, because only
 * HELD rows are touched and they are moved to RELEASED in the same update that
 * reads them.
 */
export async function releaseHoldsForShipment(
  tx: Tx,
  shipmentId: string,
  note: string
): Promise<{ released: { variantId: string; quantity: number }[] }> {
  const rows = await tx.stockReservation.findMany({
    where: { shipmentId, status: "HELD" },
  });
  const released: { variantId: string; quantity: number }[] = [];

  for (const row of rows) {
    // The update is conditional on the row still being HELD, so two concurrent
    // releases cannot both decrement the rollup.
    const moved = await tx.stockReservation.updateMany({
      where: { id: row.id, status: "HELD" },
      data: { status: "RELEASED", settledAt: new Date(), note },
    });
    if (moved.count === 0) continue;

    await tx.productVariant.update({
      where: { id: row.variantId },
      data: { reserved: { decrement: row.quantity } },
    });
    released.push({ variantId: row.variantId, quantity: row.quantity });
  }

  return { released };
}

/**
 * Turn every hold a shipment took into a shipment.
 *
 * The hold is CONSUMED rather than released: the units leave on-hand, and the
 * rollup comes down because the promise has been kept. Doing this as a release
 * plus a separate movement would leave a window in which the goods were both
 * promised and available.
 *
 * The movement carries an idempotency key derived from the shipment, so a
 * webhook that arrives twice ships the goods once.
 */
export async function fulfilHoldsForShipment(
  tx: Tx,
  shipmentId: string,
  actor: { id?: string | null; name?: string | null }
): Promise<{ shipped: { variantId: string; quantity: number }[] }> {
  const rows = await tx.stockReservation.findMany({
    where: { shipmentId, status: "HELD" },
  });
  const shipped: { variantId: string; quantity: number }[] = [];

  for (const row of rows) {
    const moved = await tx.stockReservation.updateMany({
      where: { id: row.id, status: "HELD" },
      data: { status: "FULFILLED", settledAt: new Date() },
    });
    if (moved.count === 0) continue;

    const variant = await tx.productVariant.findUnique({
      where: { id: row.variantId },
      select: { sku: true, trackInventory: true },
    });
    if (!variant?.trackInventory) {
      // Not stock-tracked: the promise is settled but nothing is deducted. The
      // rollup still has to come down, or the hold would outlive the shipment.
      await tx.productVariant.update({
        where: { id: row.variantId },
        data: { reserved: { decrement: row.quantity } },
      });
      continue;
    }

    // `allowNegative` is deliberate at fulfilment and nowhere else. The goods
    // are physically gone; refusing the ledger entry would leave a shipment
    // that exists and a count that says it never left.
    await writeMovement(tx, {
      variantId: row.variantId,
      delta: -row.quantity,
      reason: "FULFILMENT",
      refType: "Shipment",
      refId: shipmentId,
      note: `Shipped on ${variant.sku}.`,
      idempotencyKey: `fulfil:${shipmentId}:${row.variantId}`,
      actorType: actor.id ? "ADMIN_USER" : "SYSTEM",
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      allowNegative: true,
    });

    await tx.productVariant.update({
      where: { id: row.variantId },
      data: { reserved: { decrement: row.quantity } },
    });
    shipped.push({ variantId: row.variantId, quantity: row.quantity });
  }

  return { shipped };
}

/**
 * Give back every hold an ORDER took.
 *
 * A cancellation is about an order, and an order can have more than one
 * shipment — a split, or a packing shipment created and abandoned. Releasing by
 * shipment would leave the second parcel's units held by a cancelled order, and
 * the symptom of that is stock that exists and cannot be sold.
 *
 * Exactly once, by the same rule as the per-shipment release: only rows that are
 * still HELD are moved, and the rollup comes down in the same conditional
 * update, so a second call releases nothing.
 */
export async function releaseHoldsForOrder(
  tx: Tx,
  orderId: string,
  note: string
): Promise<{ released: { variantId: string; quantity: number }[] }> {
  const rows = await tx.stockReservation.findMany({ where: { orderId, status: "HELD" } });
  const released: { variantId: string; quantity: number }[] = [];

  for (const row of rows) {
    const moved = await tx.stockReservation.updateMany({
      where: { id: row.id, status: "HELD" },
      data: { status: "RELEASED", settledAt: new Date(), note },
    });
    if (moved.count === 0) continue;
    await tx.productVariant.update({
      where: { id: row.variantId },
      data: { reserved: { decrement: row.quantity } },
    });
    released.push({ variantId: row.variantId, quantity: row.quantity });
  }

  return { released };
}

/* -------------------------------------------------------------------------- */
/* Operator adjustment                                                        */
/* -------------------------------------------------------------------------- */

/**
 * An operator correcting a count, with the reason recorded on the ledger.
 *
 * An ADJUSTMENT is repeatable on purpose — counting the same shelf twice is a
 * legitimate thing to do — so it carries no idempotency key. The audit row is
 * what makes two identical corrections distinguishable to a reader.
 */
export async function adjustStock(
  input: {
    variantId: string;
    delta: number;
    note: string;
    actor: { id: string; name?: string | null };
  },
  db: Db = prisma
) {
  const result = await writeMovement(db, {
    variantId: input.variantId,
    delta: input.delta,
    reason: "ADJUSTMENT",
    refType: "Manual",
    note: input.note,
    actorType: "ADMIN_USER",
    actorId: input.actor.id,
    actorName: input.actor.name ?? null,
  });
  if ("duplicate" in result) return result;

  await recordAudit(
    {
      actorType: "ADMIN_USER",
      actorId: input.actor.id,
      actorName: input.actor.name ?? null,
      action: "stock.adjusted",
      entityType: AUDIT_ENTITY.PRODUCT_VARIANT,
      entityId: input.variantId,
      beforeData: { delta: 0 },
      afterData: { delta: input.delta, balanceAfter: result.balanceAfter, note: input.note },
    },
    db as never
  );
  return result;
}

/* -------------------------------------------------------------------------- */
/* The migration gate                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Whether the catalogue is safe to book against.
 *
 * THE BLOCKER IS THE MIGRATION, AND ONLY THE MIGRATION. A catalogue that was
 * never migrated is one whose stock figures came from a system MoonVella no
 * longer reads; booking against it takes orders for goods whose dock nobody has
 * recorded here. A catalogue with no migration row at all is in exactly that
 * state, so absence is a blocker rather than a pass.
 *
 * A COMPLETE run with no problems is the only pass. INCOMPLETE and FAILED both
 * refuse, and both name what was left behind.
 *
 * This deliberately does NOT block on an empty catalogue. A store with no
 * products has nothing to migrate and is not misconfigured.
 */
export async function inventoryReadiness(
  db: Db = prisma,
  key: string = CATALOGUE_MIGRATION_KEY
): Promise<InventoryReadiness> {
  const [migration, variantCount] = await Promise.all([
    db.stockMigration.findUnique({ where: { key } }),
    db.productVariant.count(),
  ]);

  if (variantCount === 0) {
    return { ok: true, blocker: null, migrationKey: key, status: "EMPTY_CATALOGUE" };
  }

  if (!migration) {
    return {
      ok: false,
      blocker:
        "This catalogue has not been migrated to app-owned inventory yet, so its stock figures " +
        "cannot be trusted for booking. Run the catalogue migration from the Catalogue page.",
      migrationKey: key,
      status: "NOT_RUN",
    };
  }

  if (migration.status === "COMPLETE") {
    return { ok: true, blocker: null, migrationKey: key, status: migration.status };
  }

  const problems = parseProblems(migration.problems);
  const detail = problems.length > 0 ? ` ${problems.map((p) => `${p.subject}: ${p.reason}`).join(" ")}` : "";
  return {
    ok: false,
    blocker:
      `The inventory migration is ${migration.status.toLowerCase()}, so booking is refused rather ` +
      `than risk taking an order against a figure nobody has verified.${detail}`,
    migrationKey: key,
    status: migration.status,
  };
}

export interface MigrationProblem {
  subject: string;
  reason: string;
}

export function parseProblems(raw: string): MigrationProblem[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        subject: String((entry as MigrationProblem).subject ?? "unknown"),
        reason: String((entry as MigrationProblem).reason ?? ""),
      }));
  } catch {
    return [];
  }
}
