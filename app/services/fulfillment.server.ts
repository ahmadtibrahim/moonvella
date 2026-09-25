import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { syncShipmentTracking, invalidateQuotes, QUOTE_INVALIDATION } from "./shipping.server";
import { isFulfillmentMilestone } from "./shippingLogic";
import { enqueueJob, jobKey, JOB_KIND } from "./jobs.server";
import { parcelProblems, ParcelValidationError } from "./packaging.server";

export interface ShipmentInput {
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string | null;
  allItems?: boolean;
  notifyCustomer?: boolean;
}

export type ShipmentAdvanceEvent =
  | "packed"
  | "handed_to_carrier"
  | "shipped"
  | "in_transit"
  | "delivered"
  | "exception";

export interface PackingAllocation {
  orderItemId: string;
  quantity: number;
}

interface Actor {
  actorType?: "ADMIN_USER" | "SYSTEM";
  actorId: string;
  actorName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Create a shipment with manual tracking. Fulfillment is held until the
 * wholesale payment has succeeded. Label created / packed / handed to carrier /
 * in transit / delivered are treated as distinct events.
 */
export async function addManualShipment(orderId: string, input: ShipmentInput, actor: Actor) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { seller: true, items: true },
  });
  if (!order) throw new Error("Order not found.");
  if (!input.carrier) throw new Error("Carrier is required.");
  if (!input.trackingNumber) throw new Error("Tracking number is required.");
  if (order.wholesalePaymentStatus !== "SUCCEEDED") {
    throw new Error(
      `Fulfillment is held: wholesale payment status is ${order.wholesalePaymentStatus}, not SUCCEEDED.`
    );
  }

  const now = new Date();
  const shipment = await prisma.shipment.create({
    data: {
      orderId,
      carrier: input.carrier,
      trackingNumber: input.trackingNumber,
      trackingUrl: input.trackingUrl || defaultTrackingUrl(input.carrier, input.trackingNumber),
      status: "SHIPPED",
      labelCreatedAt: now,
      packedAt: now,
      handedToCarrierAt: now,
      shippedAt: now,
      items: { create: order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })) },
    },
  });

  await prisma.order.update({ where: { id: orderId }, data: { fulfillmentStatus: "SHIPPED" } });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipment.created",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipment.id,
    afterData: { carrier: input.carrier, trackingNumber: input.trackingNumber, orderId },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  /*
   * A manually recorded shipment is already past the dispatch milestone: it is
   * created with a carrier and a tracking number and marked SHIPPED, which is
   * somebody recording a parcel that has physically gone. So this one does push,
   * unlike a booking.
   */
  const shopify = await syncShipmentTracking(shipment.id, actor, {
    notifyCustomer: input.notifyCustomer ?? false,
  });
  if (!shopify.pushed && shopify.reason !== "no_fulfillment_order_id") {
    await enqueueJob({
      kind: JOB_KIND.SHOPIFY_FULFILLMENT_SYNC,
      idempotencyKey: jobKey(JOB_KIND.SHOPIFY_FULFILLMENT_SYNC, order.sellerId, shipment.id),
      sellerId: order.sellerId,
      sellerAccessVersion: order.seller.accessVersion,
      payload: { shipmentId: shipment.id },
    });
  }

  return { shipment, shopify };
}

/**
 * Advance a shipment through the physical lifecycle. The schema only stores a
 * coarse ShipmentStatus, so intermediate states are represented by their
 * timestamps (packed -> handed to carrier -> shipped -> in transit).
 */
export async function advanceShipment(
  shipmentId: string,
  event: ShipmentAdvanceEvent,
  actor: Actor,
  opts?: { notifyCustomer?: boolean }
) {
  const now = new Date();
  const data =
    event === "packed"
      ? { packedAt: now }
      : event === "handed_to_carrier"
        ? { status: "SHIPPED" as const, handedToCarrierAt: now }
        : event === "shipped"
          ? { status: "SHIPPED" as const, shippedAt: now }
          : event === "in_transit"
            ? { status: "SHIPPED" as const, inTransitAt: now }
            : event === "delivered"
              ? { status: "DELIVERED" as const, deliveredAt: now }
              : { status: "EXCEPTION" as const, exceptionAt: now };

  const shipment = await prisma.shipment.update({ where: { id: shipmentId }, data });

  if (event === "delivered") {
    await prisma.order.update({ where: { id: shipment.orderId }, data: { fulfillmentStatus: "DELIVERED" } });
  } else if (event === "handed_to_carrier" || event === "shipped") {
    await prisma.order.update({ where: { id: shipment.orderId }, data: { fulfillmentStatus: "SHIPPED" } });
  }

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: `shipment.${event}`,
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: { event },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  /*
   * THE DISPATCH MILESTONE. This is where Shopify is told, and nowhere earlier:
   * a booked label is not a collected parcel, and §8 forbids presenting one as
   * the other. `isFulfillmentMilestone` is the single definition of that moment
   * so the two event names cannot drift apart in one place and not the other.
   */
  if (isFulfillmentMilestone(event)) {
    const sync = await syncShipmentTracking(shipmentId, actor, {
      notifyCustomer: opts?.notifyCustomer ?? false,
    });
    // Queued only when there is something to retry, and keyed per shipment so a
    // second dispatch of the same parcel collapses into the same job. A
    // successful push queues nothing — Shopify has been told, and a second
    // fulfillmentCreate is an error rather than a no-op.
    if (!sync.pushed && sync.reason !== "no_fulfillment_order_id") {
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: shipment.orderId },
        select: { sellerId: true, seller: { select: { accessVersion: true } } },
      });
      await enqueueJob({
        kind: JOB_KIND.SHOPIFY_FULFILLMENT_SYNC,
        idempotencyKey: jobKey(JOB_KIND.SHOPIFY_FULFILLMENT_SYNC, order.sellerId, shipmentId),
        sellerId: order.sellerId,
        sellerAccessVersion: order.seller.accessVersion,
        payload: { shipmentId },
      });
    }
  }

  return shipment;
}

/**
 * Create an unbooked packing shipment that allocates ordered quantities to a
 * parcel. Supports partial shipments: quantities already allocated to another
 * non-cancelled shipment are excluded.
 */
export async function createPackingShipment(
  orderId: string,
  allocations: PackingAllocation[],
  actor: Actor,
  opts?: { carrier?: string | null; serviceName?: string | null; packageIds?: string[] }
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, shipments: { include: { items: true } }, packages: true },
  });
  if (!order) throw new Error("Order not found.");

  const packed: Record<string, number> = {};
  for (const s of order.shipments) {
    if (s.status === "CANCELLED") continue;
    for (const si of s.items) packed[si.orderItemId] = (packed[si.orderItemId] || 0) + si.quantity;
  }

  const clean: PackingAllocation[] = [];
  for (const a of allocations) {
    const item = order.items.find((i) => i.id === a.orderItemId);
    if (!item) continue;
    const remaining = item.quantity - (packed[a.orderItemId] || 0);
    const qty = Math.min(Math.max(0, Math.floor(Number(a.quantity) || 0)), remaining);
    if (qty > 0) clean.push({ orderItemId: a.orderItemId, quantity: qty });
  }
  if (clean.length === 0) {
    throw new Error("Enter a quantity to pack. All selected quantities are already packed.");
  }

  /*
   * WHICH CARTONS ARE IN THIS BOX, decided at the moment the box is made.
   *
   * A packing shipment has always held a set of line items and no description
   * of the parcel, so booking it fell back to the ORDER's parcel list — every
   * carton on the order, including the ones this box does not contain, priced
   * and labelled as though it did. That was invisible on an order packed in one
   * go and wrong on every order packed in two.
   *
   * The caller may name the cartons (`packageIds`), which the packing page does
   * when an operator picks them. When it does not — every existing caller, and
   * the ordinary one-box order — the order's cartons that belong to no box yet
   * are claimed by this one. Unassigned means unassigned: a carton already
   * linked to another shipment is left where it is, so a second box never
   * silently re-declares the first box's contents.
   *
   * THIS IS A LABEL, NOT A CARRIER DECISION. Linking a carton to a shipment does
   * not merge, split or move anything; it records which parcels this booking
   * will be allowed to describe.
   */
  const named = opts?.packageIds ? new Set(opts.packageIds) : null;
  const claimed = order.packages
    .filter((p) => (named ? named.has(p.id) : p.shipmentId === null))
    .map((p) => p.id);
  if (named) {
    const unknown = [...named].filter((id) => !order.packages.some((p) => p.id === id));
    if (unknown.length > 0) {
      throw new Error(
        `${unknown.length} selected carton(s) do not belong to this order. Reload the page and select again.`,
      );
    }
  }

  const shipment = await prisma.shipment.create({
    data: {
      orderId,
      status: "PENDING",
      carrier: opts?.carrier ?? null,
      serviceName: opts?.serviceName ?? null,
      items: { create: clean.map((c) => ({ orderItemId: c.orderItemId, quantity: c.quantity })) },
    },
    include: { items: true },
  });

  if (claimed.length > 0) {
    await prisma.orderPackage.updateMany({
      where: { id: { in: claimed }, orderId },
      data: { shipmentId: shipment.id },
    });
  }

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipment.packing_created",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipment.id,
    afterData: { orderId, allocations: clean, packageIds: claimed },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return shipment;
}

/** Stamp packedAt on a packing shipment without shipping it. */
export async function markShipmentPacked(shipmentId: string, actor: Actor) {
  const before = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!before) throw new Error("Shipment not found.");
  const shipment = await prisma.shipment.update({
    where: { id: shipmentId },
    data: { packedAt: before.packedAt ?? new Date() },
  });
  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipment.packed",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    beforeData: { packedAt: before.packedAt },
    afterData: { packedAt: shipment.packedAt, orderId: shipment.orderId },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return shipment;
}

/** Mark every populated pending shipment as packed and the order ready to ship. */
export async function markOrderReadyToShip(orderId: string, actor: Actor) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error("Order not found.");
  const pending = await prisma.shipment.findMany({
    where: { orderId, status: "PENDING" },
    include: { items: true },
  });
  const populated = pending.filter((s) => s.items.length > 0);
  if (populated.length === 0) throw new Error("Create a packing shipment with items before marking ready to ship.");

  const now = new Date();
  await prisma.$transaction([
    ...populated.map((s) =>
      prisma.shipment.update({ where: { id: s.id }, data: { packedAt: s.packedAt ?? now } })
    ),
    prisma.order.update({ where: { id: orderId }, data: { fulfillmentStatus: "PROCESSING" } }),
  ]);

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipment.ready_to_ship",
    entityType: AUDIT_ENTITY.ORDER,
    entityId: orderId,
    beforeData: { fulfillmentStatus: order.fulfillmentStatus },
    afterData: { fulfillmentStatus: "PROCESSING", packedShipments: populated.map((s) => s.id) },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { packed: populated.length };
}

export interface OrderPackageInput {
  count: number;
  length: number;
  width: number;
  height: number;
  weight: number;
}

/**
 * Record a parcel dimension/weight row used for quoting and packing review.
 *
 * The measurements are REFUSED, not coerced, and the refusal is here rather than
 * on each form. Every page that adds a parcel comes through this function, so a
 * form cannot forget the rule — and a zero or negative dimension that reached
 * the table would not fail loudly, it would be priced: the carriers accept what
 * they are given and answer with a number, so a parcel of length 0 quietly
 * becomes a quote for a parcel that does not exist, and eventually a label.
 */
export async function addOrderPackage(orderId: string, input: OrderPackageInput, actor: Actor) {
  const problems = parcelProblems(input);
  if (problems.length > 0) throw new ParcelValidationError(problems);

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new Error("Order not found.");
  const pkg = await prisma.orderPackage.create({
    data: {
      orderId,
      count: Math.max(1, Math.floor(input.count || 1)),
      length: input.length,
      width: input.width,
      height: input.height,
      weight: input.weight,
      units: "cm_kg",
    },
  });
  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "order.package_added",
    entityType: AUDIT_ENTITY.ORDER,
    entityId: orderId,
    afterData: { packageId: pkg.id, count: pkg.count, length: pkg.length, width: pkg.width, height: pkg.height, weight: pkg.weight },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  // The rule lives at the write, not at each caller: a quote prices the parcels
  // that existed when it was asked for, and this is now one of them. Every
  // page that adds a parcel comes through here, so none of them can forget.
  await invalidateQuotes(orderId, QUOTE_INVALIDATION.packagesChanged, actor);
  return pkg;
}

export async function removeOrderPackage(orderId: string, packageId: string, actor: Actor) {
  const before = await prisma.orderPackage.findUnique({ where: { id: packageId } });
  if (!before || before.orderId !== orderId) throw new Error("Package not found for this order.");
  await prisma.orderPackage.delete({ where: { id: packageId } });
  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "order.package_removed",
    entityType: AUDIT_ENTITY.ORDER,
    entityId: orderId,
    beforeData: { packageId, count: before.count, length: before.length, width: before.width, height: before.height, weight: before.weight },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  await invalidateQuotes(orderId, QUOTE_INVALIDATION.packagesChanged, actor);
  return { deleted: true };
}

/** Delete an unbooked, unshipped packing shipment (safe re-pack). */
export async function deletePackingShipment(shipmentId: string, actor: Actor) {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");
  if (shipment.providerShipmentId || shipment.shopifyFulfillmentId || shipment.status !== "PENDING") {
    throw new Error("Only an unbooked, unshipped packing shipment can be deleted.");
  }
  await prisma.shipment.delete({ where: { id: shipmentId } });
  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipment.packing_deleted",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: { orderId: shipment.orderId },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return { deleted: true };
}

function defaultTrackingUrl(carrier: string, trackingNumber: string): string | null {
  const c = carrier.toLowerCase();
  if (c.includes("canada")) return `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${trackingNumber}`;
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${trackingNumber}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
  return null;
}
