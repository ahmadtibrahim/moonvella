import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { syncShipmentTracking } from "./shipping.server";

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

  // Tracking is pushed through the shared Shopify fulfillmentCreate path.
  const shopify = await syncShipmentTracking(shipment.id, actor, {
    notifyCustomer: input.notifyCustomer ?? false,
  });

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

  if (event === "handed_to_carrier" || event === "shipped") {
    await syncShipmentTracking(shipmentId, actor, { notifyCustomer: opts?.notifyCustomer ?? false });
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
  opts?: { carrier?: string | null; serviceName?: string | null }
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, shipments: { include: { items: true } } },
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

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipment.packing_created",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipment.id,
    afterData: { orderId, allocations: clean },
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

/** Record a parcel dimension/weight row used for quoting and packing review. */
export async function addOrderPackage(orderId: string, input: OrderPackageInput, actor: Actor) {
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
