import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { setIntegrationState } from "./integrationHealth.server";
import {
  getRates,
  bookShipment,
  cancelShipment,
  eshipperMode,
  trackByOrderId,
  trackByTrackingNumber,
  bulkTrack,
  getLabel,
  getOrderDetails,
  getCustomsInvoice,
  getReturnQuote,
  bookReturn,
  getReturn,
  schedulePickup,
  cancelPickup,
  type RateRequest,
  type TrackingResult,
  type ReturnBookingResult,
  type ReturnDetails,
  type PickupResult,
} from "./eshipper.server";
import { buildQuotePackagesForOrder } from "./packaging.server";

interface Actor {
  actorId: string;
  actorName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function parseAddress(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function shipFrom() {
  return {
    name: process.env.MOONVELLA_SHIP_FROM_NAME || "MoonVella",
    address: process.env.MOONVELLA_SHIP_FROM_ADDRESS || "1 Warehouse Way",
    city: process.env.MOONVELLA_SHIP_FROM_CITY || "Toronto",
    province: process.env.MOONVELLA_SHIP_FROM_PROVINCE || "ON",
    postalCode: process.env.MOONVELLA_SHIP_FROM_POSTAL || "M5H 2N2",
    country: process.env.MOONVELLA_SHIP_FROM_COUNTRY || "CA",
  };
}

function buildRateRequest(
  order: { shippingAddress: string | null; items: { quantity: number }[]; moonvellaTotal: number; currency: string },
  packages: { count: number; length: number; width: number; height: number; weight: number; units: string }[]
): RateRequest {
  const to = parseAddress(order.shippingAddress);
  return {
    shipFrom: shipFrom(),
    shipTo: {
      name: to.name,
      address: to.address1 || to.address || "",
      city: to.city,
      province: to.province || to.provinceCode,
      postalCode: to.zip || to.postalCode || "",
      country: to.country || to.countryCode || "CA",
      residential: to.residential === undefined ? true : to.residential !== "false",
    },
    packages,
    declaredValue: order.moonvellaTotal,
    insurance: false,
  };
}

/**
 * Allocate the order's confirmed seller shipping charge to one shipment.
 *
 * The seller is charged once, on the order, at the zone/rate that applied when
 * the order was confirmed. A split order therefore must not repeat that whole
 * charge on each parcel — this divides it by the shipment's share of ordered
 * quantity, so the allocations across all shipments sum back to the order
 * total. It is an ALLOCATION of a figure that already exists, never a re-price
 * and never a per-item rate we invented: when the order carries no confirmed
 * shipping charge, the allocation is null rather than a guess.
 */
import {
  allocateSellerShippingCharge,
  trackingLabel,
  pickCheapestQuote,
  pickFastestQuote,
  normalizeTrackingState,
  coarseStatusFor,
} from "./shippingLogic";

// Re-exported so routes and suites that already import them from here keep
// working. The import above is what puts them in this module's own scope; a bare
// `export ... from` would not, and this file calls them below.
export {
  allocateSellerShippingCharge,
  trackingLabel,
  pickCheapestQuote,
  pickFastestQuote,
  normalizeTrackingState,
  coarseStatusFor,
};

const TRACKING_STATE: Record<string, string> = {
  label_created: "LABEL_CREATED",
  picked_up: "PICKED_UP",
  in_transit: "IN_TRANSIT",
  out_for_delivery: "OUT_FOR_DELIVERY",
  delivered: "DELIVERED",
  exception: "EXCEPTION",
  undelivered: "UNDELIVERED",
  returned: "RETURNED",
  cancelled: "CANCELLED",
};

/** Display label for a normalized tracking state. Never claims more than the provider said. */

/**
 * The cheapest quote by total, or null when there are none. A null total is
 * never treated as zero: a quote with an unknown amount cannot win on price.
 */

/**
 * The fastest quote, considering ONLY quotes that carry a transit estimate. A
 * missing estimate is not a zero-day delivery, so it is excluded rather than
 * sorted first; when nothing estimates, the result is null and the interface
 * says "estimate unavailable".
 */


/**
 * Map a provider tracking payload to one normalized state (see shippingLogic).
 */

const STATE_ORDER: Record<string, number> = {
  UNKNOWN: 0,
  LABEL_CREATED: 1,
  PICKED_UP: 2,
  IN_TRANSIT: 3,
  OUT_FOR_DELIVERY: 4,
  EXCEPTION: 5,
  UNDELIVERED: 5,
  DELIVERED: 6,
  RETURNED: 7,
  CANCELLED: 8,
};

/**
 * Provide the coarse ShipmentStatus that the rest of the app already reads
 * (see shippingLogic.coarseStatusFor).
 */

async function persistTrackingEvents(shipmentId: string, tracking: TrackingResult) {
  for (const [i, ev] of tracking.trackingDetails.entries()) {
    const eventAt = ev.dateTime ? new Date(ev.dateTime) : new Date();
    const when = Number.isNaN(eventAt.getTime()) ? new Date() : eventAt;
    const eventKey = `${when.toISOString()}|${ev.carrierEventCode ?? ""}|${ev.statusText ?? ""}|${ev.description ?? ""}|${i}`;
    await prisma.shipmentTrackingEvent.upsert({
      where: { shipmentId_eventKey: { shipmentId, eventKey } },
      create: {
        shipmentId,
        eventKey,
        eventAt: when,
        location: ev.location || null,
        description: ev.description || null,
        carrierEventCode: ev.carrierEventCode ?? null,
        statusText: ev.statusText || null,
        proofOfDelivery: ev.proofOfDelivery ? JSON.stringify(ev.proofOfDelivery) : null,
      },
      update: {},
    });
  }
}

export async function getQuotesForOrder(orderId: string, actor: Actor) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, packages: true },
  });
  if (!order) throw new Error("Order not found.");

  const to = parseAddress(order.shippingAddress);
  if (!to.zip && !to.postalCode) {
    throw new Error("Ship-to postal code is missing on this order. Correct the address before quoting.");
  }

  const built = await buildQuotePackagesForOrder({
    items: order.items.map((i) => ({ sku: i.sku, quantity: i.quantity, variantId: i.variantId })),
    packages: order.packages,
  });
  if (built.missing.length > 0) {
    throw new Error(
      `Packaging incomplete: ${built.missing.join(", ")}. Complete the packaging data before requesting quotes.`
    );
  }
  if (built.packages.length === 0) {
    throw new Error("No package data available for this order.");
  }

  const request = buildRateRequest(order, built.packages);
  const rates = await getRates(request);

  await prisma.shippingQuote.deleteMany({ where: { orderId, selected: false, provider: "eshipper" } });
  await prisma.$transaction(
    rates.map((r) =>
      prisma.shippingQuote.create({
        data: {
          orderId,
          provider: "eshipper",
          providerQuoteId: r.providerQuoteId ?? null,
          carrier: r.carrier,
          serviceCode: r.serviceCode,
          serviceName: r.serviceName,
          totalAmount: r.totalAmount,
          currency: r.currency,
          transitDays: r.transitDays,
          estimatedDelivery: r.estimatedDelivery,
          expiresAt: r.expiresAt,
          raw: r.raw ? JSON.stringify(r.raw) : null,
        },
      })
    )
  );

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.quotes_requested",
    entityType: AUDIT_ENTITY.ORDER,
    entityId: orderId,
    afterData: { count: rates.length, mode: await eshipperMode() },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return prisma.shippingQuote.findMany({ where: { orderId }, orderBy: { totalAmount: "asc" } });
}

export async function selectQuote(orderId: string, quoteId: string, actor: Actor) {
  const quote = await prisma.shippingQuote.findUnique({ where: { id: quoteId } });
  if (!quote || quote.orderId !== orderId) throw new Error("Quote not found for this order.");
  if (quote.expiresAt && quote.expiresAt < new Date()) {
    throw new Error("This quote has expired. Request new quotes.");
  }
  await prisma.$transaction([
    prisma.shippingQuote.updateMany({ where: { orderId }, data: { selected: false } }),
    prisma.shippingQuote.update({ where: { id: quoteId }, data: { selected: true } }),
  ]);
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.quote_selected",
    entityType: AUDIT_ENTITY.ORDER,
    entityId: orderId,
    afterData: { quoteId, carrier: quote.carrier, service: quote.serviceName, total: quote.totalAmount },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return quote;
}

const BOOKING_ERROR = "Booking failed after payment";

/**
 * Book a shipment for an order. Blocked until wholesale payment has SUCCEEDED.
 * Idempotent: a booking key prevents a second purchase on double-click/timeouts,
 * and an existing shipment with a provider id is returned instead of re-booking.
 *
 * The seller's charge is NOT touched here. Only the carrier side is recorded, so
 * a more expensive carrier or a later adjustment can never raise what the seller
 * was quoted.
 */
export async function bookShipmentForOrder(
  orderId: string,
  opts: { quoteId?: string; quantities?: Record<string, number> },
  actor: Actor
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, packages: true, shipments: { include: { items: true } } },
  });
  if (!order) throw new Error("Order not found.");
  if (order.wholesalePaymentStatus !== "SUCCEEDED") {
    throw new Error(
      `Shipping cannot be booked: wholesale payment status is ${order.wholesalePaymentStatus}, not SUCCEEDED.`
    );
  }
  if (order.packages.length === 0) throw new Error("Package dimensions and weight are required before booking.");

  const quote = opts.quoteId
    ? await prisma.shippingQuote.findUnique({ where: { id: opts.quoteId } })
    : await prisma.shippingQuote.findFirst({ where: { orderId, selected: true } });
  if (!quote || quote.orderId !== orderId) throw new Error("Select a shipping service before booking.");
  if (quote.expiresAt && quote.expiresAt < new Date()) {
    throw new Error("The selected quote has expired. Re-quote before booking.");
  }

  // Determine remaining quantities (supports partial shipments).
  const shipped: Record<string, number> = {};
  for (const s of order.shipments) {
    if (s.status === "CANCELLED") continue;
    for (const si of s.items) shipped[si.orderItemId] = (shipped[si.orderItemId] || 0) + si.quantity;
  }
  const toShip = order.items
    .map((i) => {
      const remaining = i.quantity - (shipped[i.id] || 0);
      const requested = opts.quantities?.[i.id];
      const qty = requested === undefined ? remaining : Math.min(requested, remaining);
      return { orderItemId: i.id, quantity: qty };
    })
    .filter((i) => i.quantity > 0);

  const orderQuantity = order.items.reduce((s, i) => s + i.quantity, 0);
  const shipQuantity = toShip.reduce((s, i) => s + i.quantity, 0);

  // Idempotency keyed on the shipping intent (all items, or an explicit partial
  // set). A double-click or timeout reuses the same key and returns the existing
  // shipment instead of purchasing a second label.
  const fingerprint = opts.quantities
    ? Object.entries(opts.quantities)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}x${v}`)
        .join(",")
    : "all";
  const bookingKey = `book:${orderId}:${fingerprint}`;
  const prior = await prisma.shipment.findUnique({ where: { bookingIdempotencyKey: bookingKey } });
  if (prior) {
    return { shipment: prior, sync: { pushed: false, reason: "duplicate_request" } };
  }

  // Checked AFTER the idempotency lookup, deliberately. A repeat of the same
  // request finds every item already shipped, so testing this first would turn
  // the duplicate into an error instead of returning the shipment that request
  // already created — the opposite of what the key above is for.
  if (toShip.length === 0) throw new Error("All items on this order have already been shipped.");

  let shipment;
  try {
    shipment = await prisma.shipment.create({
      data: {
        orderId,
        status: "PENDING",
        provider: "eshipper",
        bookingIdempotencyKey: bookingKey,
        carrier: quote.carrier,
        serviceCode: quote.serviceCode,
        serviceName: quote.serviceName,
        providerQuoteId: quote.providerQuoteId,
        quotedCarrierCost: quote.totalAmount,
        sellerShippingCharge: allocateSellerShippingCharge(order.moonvellaShipping, shipQuantity, orderQuantity),
        packageCount: order.packages.reduce((s, p) => s + p.count, 0),
        items: { create: toShip.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })) },
      },
    });
  } catch {
    const existing = await prisma.shipment.findUnique({ where: { bookingIdempotencyKey: bookingKey } });
    if (existing) return { shipment: existing, sync: { pushed: false, reason: "duplicate_request" } };
    throw new Error("Could not create shipment booking record.");
  }

  return finalizeBooking(shipment.id, orderId, quote, actor);
}

/**
 * Book an existing PENDING packing shipment. Same eligibility and idempotency
 * rules as bookShipmentForOrder, but the parcel was already prepared and its
 * allocations already decided, so nothing is re-derived.
 */
export async function bookPreparedShipment(shipmentId: string, quoteId: string | undefined, actor: Actor) {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { order: { include: { items: true, packages: true } }, items: true },
  });
  if (!shipment) throw new Error("Shipment not found.");
  if (shipment.providerShipmentId) {
    return { shipment, sync: { pushed: false, reason: "already_booked" } };
  }
  if (shipment.status !== "PENDING") throw new Error(`Only a PENDING shipment can be booked (this is ${shipment.status}).`);

  const order = shipment.order;
  if (order.wholesalePaymentStatus !== "SUCCEEDED") {
    throw new Error(
      `Shipping cannot be booked: wholesale payment status is ${order.wholesalePaymentStatus}, not SUCCEEDED.`
    );
  }
  if (order.packages.length === 0) throw new Error("Package dimensions and weight are required before booking.");

  const quote = quoteId
    ? await prisma.shippingQuote.findUnique({ where: { id: quoteId } })
    : await prisma.shippingQuote.findFirst({ where: { orderId: order.id, selected: true } });
  if (!quote || quote.orderId !== order.id) throw new Error("Select a shipping service before booking.");
  if (quote.expiresAt && quote.expiresAt < new Date()) {
    throw new Error("The selected quote has expired. Re-quote before booking.");
  }

  const orderQuantity = order.items.reduce((s, i) => s + i.quantity, 0);
  const shipQuantity = shipment.items.reduce((s, i) => s + i.quantity, 0);

  await prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      carrier: quote.carrier,
      serviceCode: quote.serviceCode,
      serviceName: quote.serviceName,
      providerQuoteId: quote.providerQuoteId,
      quotedCarrierCost: quote.totalAmount,
      sellerShippingCharge:
        shipment.sellerShippingCharge ??
        allocateSellerShippingCharge(order.moonvellaShipping, shipQuantity, orderQuantity),
    },
  });

  return finalizeBooking(shipmentId, order.id, quote, actor);
}

async function finalizeBooking(
  shipmentId: string,
  orderId: string,
  quote: { carrier: string; serviceCode: string; serviceName: string; providerQuoteId: string | null; totalAmount: number },
  actor: Actor
) {
  const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
  // Items are included because the rate request needs the ordered quantity, and
  // a Prisma result only carries relations that were asked for.
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { packages: true, items: true },
  });

  try {
    const booking = await bookShipment({
      quote: {
        carrier: quote.carrier,
        serviceCode: quote.serviceCode,
        serviceName: quote.serviceName,
        providerQuoteId: quote.providerQuoteId,
      },
      rateRequest: buildRateRequest(order, order.packages),
    });

    const updated = await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        providerShipmentId: booking.providerShipmentId,
        carrier: booking.carrier,
        serviceName: booking.serviceName,
        trackingNumber: booking.trackingNumber || null,
        trackingUrl: booking.trackingUrl,
        labelUrl: booking.labelUrl,
        labelDocumentFormat: booking.labelUrl ? "PDF" : null,
        bookedCost: booking.bookedCost || quote.totalAmount,
        trackingStatus: TRACKING_STATE.label_created,
        labelCreatedAt: new Date(),
        billingStatus: "PENDING",
      },
    });

    // Resolved once: this now reads the credential store, and asking twice could
    // in principle straddle a change made between the two calls.
    const shippingMode = await eshipperMode();
    await setIntegrationState("eshipper", {
      status: shippingMode === "real" ? "HEALTHY" : "NOT_CONFIGURED",
      detail:
        shippingMode === "real"
          ? `Booked ${booking.carrier} ${booking.serviceName}.`
          : "Simulated booking (no eShipper credentials). Not a real label purchase.",
    });

    await recordAudit({
      actorType: "ADMIN_USER",
      actorId: actor.actorId,
      actorName: actor.actorName,
      action: "shipping.booked",
      entityType: AUDIT_ENTITY.SHIPMENT,
      entityId: updated.id,
      afterData: {
        providerShipmentId: booking.providerShipmentId,
        trackingNumber: booking.trackingNumber,
        bookedCost: booking.bookedCost,
        quotedCarrierCost: quote.totalAmount,
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    // Tracking is pushed to Shopify separately so a Shopify failure does not
    // lose the booking. A label is NOT reported as shipped.
    const sync = await syncShipmentTracking(updated.id, actor);
    return { shipment: updated, sync };
  } catch (error) {
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: { status: "EXCEPTION", exceptionAt: new Date() },
    });
    await setIntegrationState("eshipper", {
      status: "FAILED",
      error: error instanceof Error ? error.message : "booking failed",
    });
    // Payment remains SUCCEEDED; the order stays eligible for a safe re-book.
    throw new Error(
      `${BOOKING_ERROR}: ${error instanceof Error ? error.message : "unknown"}. ` +
        `The seller has not been charged again — retry booking safely.`
    );
  }
}

export async function syncShipmentTracking(
  shipmentId: string,
  actor: Actor,
  opts?: { notifyCustomer?: boolean }
) {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { order: { include: { seller: true } } },
  });
  if (!shipment) throw new Error("Shipment not found.");
  if (!shipment.order.shopifyFulfillmentOrderId) {
    await setIntegrationState("shopify_fulfillment", {
      status: "NOT_CONFIGURED",
      detail:
        "Tracking is stored locally. Shopify fulfillment sync needs a fulfillment order id (fulfillment-service setup + fulfillment-order scopes).",
    });
    return { pushed: false, reason: "no_fulfillment_order_id" };
  }
  try {
    const { unauthenticated } = await import("~/shopify.server");
    const { admin } = await unauthenticated.admin(shipment.order.seller.shopDomain);
    const res = await admin.graphql(
      `#graphql
        mutation Fulfill($fulfillment: FulfillmentInput!) {
          fulfillmentCreate(fulfillment: $fulfillment) {
            fulfillment { id status trackingInfo { number url company } }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          fulfillment: {
            lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: shipment.order.shopifyFulfillmentOrderId }],
            trackingInfo: {
              number: shipment.trackingNumber,
              url: shipment.trackingUrl,
              company: shipment.carrier,
            },
            notifyCustomer: opts?.notifyCustomer ?? false,
          },
        },
      }
    );
    const json = await res.json();
    const errors = json?.data?.fulfillmentCreate?.userErrors ?? [];
    if (errors.length) throw new Error(errors.map((e: { message: string }) => e.message).join("; "));
    const fid = json?.data?.fulfillmentCreate?.fulfillment?.id ?? null;
    if (fid) await prisma.shipment.update({ where: { id: shipmentId }, data: { shopifyFulfillmentId: fid } });
    await setIntegrationState("shopify_fulfillment", { status: "HEALTHY", detail: `Fulfillment synced (${fid}).` });
    return { pushed: true, shopifyFulfillmentId: fid };
  } catch (error) {
    await setIntegrationState("shopify_fulfillment", {
      status: "FAILED",
      error: error instanceof Error ? error.message : "sync failed",
    });
    return { pushed: false, reason: "exception", message: error instanceof Error ? error.message : "unknown" };
  }
}

/**
 * Cancel a shipment. The provider outcome is recorded in full: the call is
 * requested first, and only a confirmed provider success marks CANCELLED. An
 * unknown outcome leaves a CANCELLING state so nobody treats it as refunded.
 */
export async function voidShipment(shipmentId: string, actor: Actor) {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");
  if (!shipment.providerShipmentId) throw new Error("No provider shipment to cancel.");
  if (shipment.status === "CANCELLED") return { cancelled: true, alreadyCancelled: true };

  await prisma.shipment.update({ where: { id: shipmentId }, data: { status: "PENDING", trackingStatus: "CANCELLING" } });

  let cancelled = false;
  let providerMessage: string | null = null;
  try {
    const result = await cancelShipment(shipment.providerShipmentId);
    cancelled = result.cancelled;
  } catch (error) {
    providerMessage = error instanceof Error ? error.message : "cancel call failed";
  }

  const status = cancelled ? "CANCELLED" : "EXCEPTION";
  await prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      status,
      trackingStatus: cancelled ? TRACKING_STATE.cancelled : "CANCEL_REJECTED",
      cancelledAt: cancelled ? new Date() : null,
      lastTrackingError: providerMessage,
    },
  });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.cancelled",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: { cancelled, providerMessage },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return { cancelled, providerMessage };
}

export async function getShipmentLabel(shipmentId: string, actor: Actor) {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");
  if (!shipment.providerShipmentId) throw new Error("No provider shipment ID.");
  const label = await getLabel(shipment.providerShipmentId);
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.label_viewed",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: { format: label.format },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return label;
}

export async function getShipmentOrderDetails(shipmentId: string, actor: Actor) {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");
  if (!shipment.providerShipmentId) throw new Error("No provider shipment ID.");
  const details = await getOrderDetails(shipment.providerShipmentId);
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.order_details_viewed",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return details;
}

export async function getShipmentCustomsInvoice(shipmentId: string, actor: Actor) {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");
  if (!shipment.providerShipmentId) throw new Error("No provider shipment ID.");
  const invoice = await getCustomsInvoice(shipment.providerShipmentId);
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.customs_invoice_viewed",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return invoice;
}

/**
 * Pull provider tracking and persist it. Older events never overwrite a newer
 * normalized state: the incoming event time is compared with the newest stored
 * event, and a stale snapshot is stored but does not regress the status.
 */
export async function syncTrackingForShipment(shipmentId: string, actor: Actor): Promise<TrackingResult> {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");

  let tracking: TrackingResult;
  try {
    if (shipment.providerShipmentId) {
      tracking = await trackByOrderId(shipment.providerShipmentId);
    } else if (shipment.trackingNumber) {
      tracking = await trackByTrackingNumber(shipment.trackingNumber);
    } else {
      throw new Error("No provider shipment id or tracking number to poll.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "tracking failed";
    await prisma.shipment.update({
      where: { id: shipmentId },
      data: { lastTrackingError: message },
    });
    await setIntegrationState("eshipper", { status: "FAILED", error: message });
    // An API failure is reported as a sync error, never as a delivery exception.
    throw new Error(`Tracking sync failed: ${message}`);
  }

  await persistTrackingEvents(shipmentId, tracking);

  const incomingState = normalizeTrackingState(tracking);
  const current = shipment.trackingStatus ? STATE_ORDER[shipment.trackingStatus] ?? -1 : -1;
  const incoming = STATE_ORDER[incomingState] ?? -1;
  // A return after delivery and a cancellation are meaningful later events that
  // are allowed to win even though their rank is higher; a genuinely older
  // snapshot is lower-ranked and is refused.
  const allowed =
    current < 0 ||
    incoming >= current ||
    incomingState === TRACKING_STATE.returned ||
    incomingState === TRACKING_STATE.cancelled;
  const nextState = allowed && incoming >= 0 ? incomingState : shipment.trackingStatus;
  const nextCoarse = coarseStatusFor(nextState ?? incomingState);

  const updated = await prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      trackingUrl: tracking.trackingUrl || shipment.trackingUrl,
      trackingStatus: nextState,
      status: nextCoarse,
      estimatedDelivery: shipment.estimatedDelivery,
      lastTrackingSyncAt: new Date(),
      lastTrackingError: null,
      labelCreatedAt: shipment.labelCreatedAt ?? (tracking.labelGenerated ? new Date() : null),
      shippedAt:
        nextCoarse === "SHIPPED" || nextCoarse === "DELIVERED"
          ? shipment.shippedAt ?? new Date()
          : shipment.shippedAt,
      inTransitAt: tracking.inTransit || tracking.pickup ? shipment.inTransitAt ?? new Date() : shipment.inTransitAt,
      deliveredAt: tracking.delivered ? shipment.deliveredAt ?? new Date() : shipment.deliveredAt,
      exceptionAt: tracking.exception || tracking.undelivered ? shipment.exceptionAt ?? new Date() : shipment.exceptionAt,
    },
  });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.tracking_synced",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: { trackingStatus: updated.trackingStatus, events: tracking.trackingDetails.length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return tracking;
}

export async function bulkSyncTracking(trackingNumbers: string[], actor: Actor) {
  if (trackingNumbers.length === 0) return { results: [] as TrackingResult[] };
  if (trackingNumbers.length > 20) throw new Error("Bulk tracking is limited to 20 tracking numbers per request.");
  const response = await bulkTrack(trackingNumbers);
  for (const result of response.results) {
    const match = await prisma.shipment.findFirst({ where: { trackingNumber: { in: trackingNumbers } } });
    if (match) await persistTrackingEvents(match.id, result);
  }
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.bulk_tracking_synced",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: "bulk",
    afterData: { count: response.results.length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return response;
}

export async function getReturnQuotesForOrder(orderId: string, actor: Actor) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, packages: true },
  });
  if (!order) throw new Error("Order not found.");

  const built = await buildQuotePackagesForOrder({
    items: order.items.map((i) => ({ sku: i.sku, quantity: i.quantity, variantId: i.variantId })),
    packages: order.packages,
  });
  if (built.missing.length > 0) {
    throw new Error(`Packaging incomplete for return: ${built.missing.join(", ")}`);
  }

  const rates = await getReturnQuote(buildRateRequest(order, built.packages));

  // Return quotes live beside booking quotes but under a distinct provider key,
  // so requesting a return rate can never overwrite the outbound quote the
  // shipment was booked against.
  await prisma.shippingQuote.deleteMany({ where: { orderId, selected: false, provider: "eshipper-return" } });
  await prisma.$transaction(
    rates.map((r) =>
      prisma.shippingQuote.create({
        data: {
          orderId,
          provider: "eshipper-return",
          providerQuoteId: r.providerQuoteId ?? null,
          carrier: r.carrier,
          serviceCode: r.serviceCode,
          serviceName: r.serviceName,
          totalAmount: r.totalAmount,
          currency: r.currency,
          transitDays: r.transitDays,
          estimatedDelivery: r.estimatedDelivery,
          expiresAt: r.expiresAt,
          raw: r.raw ? JSON.stringify(r.raw) : null,
        },
      })
    )
  );

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.return_quotes_requested",
    entityType: AUDIT_ENTITY.ORDER,
    entityId: orderId,
    afterData: { count: rates.length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return prisma.shippingQuote.findMany({ where: { orderId, provider: "eshipper-return" }, orderBy: { totalAmount: "asc" } });
}

/**
 * Create a return as its OWN shipment linked to the original. Returns are not
 * refunds: this creates a label and tracking and stops there. Nothing is
 * refunded, restocked, marked received, or charged to the seller.
 */
export async function bookReturnForOrder(
  orderId: string,
  originalShipmentId: string,
  opts: {
    returnQuoteId: string;
    returnItems: { orderItemId: string; quantity: number }[];
    reason: string;
  },
  actor: Actor
): Promise<ReturnBookingResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, packages: true },
  });
  if (!order) throw new Error("Order not found.");
  const original = await prisma.shipment.findUnique({ where: { id: originalShipmentId } });
  if (!original || original.orderId !== orderId) throw new Error("Original shipment not found for this order.");

  const quote = await prisma.shippingQuote.findUnique({ where: { id: opts.returnQuoteId } });
  if (!quote || quote.orderId !== orderId || quote.provider !== "eshipper-return") {
    throw new Error("Return quote not found. Request return rates first.");
  }

  const built = await buildQuotePackagesForOrder({
    items: order.items.map((i) => ({ sku: i.sku, quantity: i.quantity, variantId: i.variantId })),
    packages: order.packages,
  });

  const returnItems = opts.returnItems
    .map((ri) => {
      const item = order.items.find((i) => i.id === ri.orderItemId);
      return { sku: item?.sku ?? "", quantity: ri.quantity };
    })
    .filter((i) => i.sku);

  const booking = await bookReturn({
    quote: { carrier: quote.carrier, serviceCode: quote.serviceCode, serviceName: quote.serviceName },
    rateRequest: buildRateRequest(order, built.packages),
    returnItems,
    returnAddress: shipFrom(),
  });

  const shipment = await prisma.shipment.create({
    data: {
      orderId,
      status: "PENDING",
      provider: "eshipper",
      carrier: booking.carrier,
      serviceCode: quote.serviceCode,
      serviceName: booking.serviceName,
      trackingNumber: booking.trackingNumber,
      trackingUrl: booking.trackingUrl,
      labelUrl: booking.labelUrl,
      labelDocumentFormat: booking.labelUrl ? "PDF" : null,
      bookedCost: booking.bookedCost,
      quotedCarrierCost: quote.totalAmount,
      packageCount: 1,
      trackingStatus: TRACKING_STATE.label_created,
      labelCreatedAt: new Date(),
      returnOfShipmentId: originalShipmentId,
      returnReason: opts.reason,
      items: { create: opts.returnItems.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })) },
    },
  });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.return_booked",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipment.id,
    afterData: {
      providerReturnId: booking.providerReturnId,
      trackingNumber: booking.trackingNumber,
      cost: booking.bookedCost,
      originalShipmentId,
      refunded: false,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return booking;
}

export async function getReturnDetails(shipmentId: string, actor: Actor): Promise<ReturnDetails | null> {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");
  if (!shipment.providerShipmentId) return null;

  const details = await getReturn(shipment.providerShipmentId);
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.return_details_viewed",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return details;
}

export async function schedulePickupForShipment(
  shipmentId: string,
  data: { pickupDate: string; pickupTimeWindow: string; notes?: string },
  actor: Actor
): Promise<PickupResult> {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");

  const booking = await schedulePickup({
    shipFrom: {
      ...shipFrom(),
      phone: process.env.MOONVELLA_SHIP_FROM_PHONE,
      email: process.env.MOONVELLA_SHIP_FROM_EMAIL,
    },
    pickupDate: data.pickupDate,
    pickupTimeWindow: data.pickupTimeWindow,
    packages: [{ count: shipment.packageCount || 1, weight: 0 }],
    notes: data.notes,
  });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.pickup_scheduled",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: { pickupId: booking.pickupId, scheduledDate: booking.scheduledDate },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return booking;
}

export async function cancelPickupForShipment(shipmentId: string, pickupId: string, actor: Actor) {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");

  const result = await cancelPickup(pickupId);

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.pickup_cancelled",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: { pickupId, cancelled: result.cancelled },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return result;
}

/**
 * The four cost figures, kept apart on purpose.
 *
 * sellerShippingCharge  what the seller paid MoonVella for shipping
 * quotedCarrierCost     what eShipper quoted at booking
 * bookedCarrierCost     what eShipper charged at booking
 * finalBilledCarrierCost what the carrier billed on the supplier invoice
 *
 * margin is seller charge minus the best-known carrier cost, and is explicitly
 * a MoonVella figure: raising the carrier cost never raises the seller charge.
 */
export async function getBillingReconciliation(shipmentId: string) {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");

  const carrierCost = shipment.finalBilledCost ?? shipment.bookedCost ?? shipment.quotedCarrierCost ?? 0;
  return {
    shipmentId: shipment.id,
    providerShipmentId: shipment.providerShipmentId,
    sellerShippingCharge: shipment.sellerShippingCharge,
    quotedCarrierCost: shipment.quotedCarrierCost,
    bookedCarrierCost: shipment.bookedCost,
    finalBilledCarrierCost: shipment.finalBilledCost,
    providerInvoiceNumber: shipment.providerInvoiceNumber,
    margin: shipment.sellerShippingCharge == null ? null : shipment.sellerShippingCharge - carrierCost,
    status: shipment.billingStatus,
  };
}

/**
 * Record a carrier invoice for reconciliation.
 *
 * One supplier invoice may cover many shipments, so the invoice number is the
 * identity: a second shipment citing the same invoice checks by invoiceNumber
 * and charges its own line, it does not produce a duplicate full bill. Only a
 * posted/credited variance changes billingStatus; the seller's charge is never
 * touched.
 */
export async function reconcileCarrierInvoice(
  shipmentId: string,
  input: { invoiceNumber: string; total: number; currency?: string; charges?: unknown; adjustmentReasons?: unknown },
  actor: Actor
) {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");
  if (!input.invoiceNumber) throw new Error("A supplier invoice number is required to reconcile.");

  const existing = await prisma.shipment.findFirst({
    where: { providerInvoiceNumber: input.invoiceNumber, id: { not: shipmentId } },
  });

  const variance =
    shipment.bookedCost == null ? null : input.total - shipment.bookedCost;
  const billingStatus =
    shipment.bookedCost == null ? "NEEDS_RECONCILIATION" : variance === 0 ? "RECONCILED" : "VARIANCE";

  const updated = await prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      providerInvoiceNumber: input.invoiceNumber,
      finalBilledCost: input.total,
      billingInvoices: JSON.stringify({
        invoiceNumber: input.invoiceNumber,
        currency: input.currency ?? "CAD",
        total: input.total,
        charges: input.charges ?? null,
        adjustmentReasons: input.adjustmentReasons ?? null,
        recordedAt: new Date().toISOString(),
        sharedWithShipment: existing?.id ?? null,
      }),
      billingStatus,
    },
  });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.billing_reconciled",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: {
      invoiceNumber: input.invoiceNumber,
      finalBilledCost: input.total,
      variance,
      billingStatus,
      duplicateOfShipment: existing?.id ?? null,
      sellerChargeUnchanged: shipment.sellerShippingCharge,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return {
    billingStatus: updated.billingStatus,
    finalBilledCost: updated.finalBilledCost,
    variance,
    consolidatedWith: existing?.id ?? null,
    sellerShippingCharge: updated.sellerShippingCharge,
  };
}