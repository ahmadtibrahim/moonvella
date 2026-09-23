import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY, type AuditActorType } from "./audit.server";
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
  getShipment,
  isProviderTimeout,
  schedulePickup,
  cancelPickup,
  type RateRequest,
  type TrackingResult,
  type ReturnBookingResult,
  type ReturnDetails,
  type PickupResult,
} from "./eshipper.server";
import { buildQuotePackagesForOrder } from "./packaging.server";
import { enqueueJob, jobKey, JOB_KIND } from "./jobs.server";

/**
 * The states from which a booking may be attempted.
 *
 * PENDING is a shipment nobody has asked the provider about. BOOKING_FAILED is
 * one the provider refused, where nothing was purchased — retrying it is the
 * whole point of recording it separately from a timeout. BOOKING and
 * BOOKING_UNKNOWN are deliberately absent: the first is in flight, and the
 * second may already own a label.
 */
const BOOKABLE_STATES = ["PENDING", "BOOKING_FAILED"] as const;

/**
 * Why a shipment in a given state cannot be booked, in the words the operator
 * needs to decide what to do next.
 *
 * Written once and used by both the guard that runs before anything is sent and
 * the claim that runs at the provider call. Two copies of this sentence drift,
 * and the drift is not cosmetic: an operator told only "this shipment cannot be
 * booked" for a shipment whose booking outcome is UNKNOWN is one retry away from
 * buying a second label, which is the exact failure the state exists to prevent.
 */
function bookingRefusal(status: string): string {
  if (status === "BOOKING") {
    return "A booking attempt for this shipment is already in flight. Wait for it to finish rather than sending a second one.";
  }
  if (status === "BOOKING_UNKNOWN") {
    return (
      "This shipment's booking outcome is unknown — the provider may already have bought a label. " +
      "Reconcile the booking before attempting another one."
    );
  }
  return `This shipment cannot be booked from its current state (${status}).`;
}

interface Actor {
  actorId: string;
  actorName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /**
   * Who this is, for the audit trail. Defaults to an admin user, because that is
   * who calls almost everything here — a webhook says so explicitly rather than
   * being recorded as a person who was not there.
   */
  actorType?: AuditActorType;
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

/**
 * Remove every quote on an order, because they no longer describe it.
 *
 * DELETED, NOT FLAGGED. A flag would leave the row reachable by id, and the
 * booking paths accept a quote by id — so a superseded quote that still exists
 * is a stale price that can still be booked by anyone holding the id. Removing
 * the rows closes that off for every caller at once rather than relying on each
 * of them to check a flag.
 *
 * HISTORY IS NOT LOST BY THIS. A quote is evidence only until it is used; once
 * a shipment is booked, the carrier, service, cost and provider quote id are
 * copied onto the shipment itself, which is what the audit trail and the
 * reconciliation read. What is deleted is the *offer*, not the purchase.
 *
 * Returns how many were removed, so a caller can say "3 quotes withdrawn" rather
 * than reporting a re-quote that was already the state of things.
 */
export async function invalidateQuotes(orderId: string, reason: string, actor: Actor) {
  const removed = await prisma.shippingQuote.deleteMany({ where: { orderId } });
  if (removed.count === 0) return { removed: 0 };

  await prisma.order.update({
    where: { id: orderId },
    data: { quotesInvalidatedAt: new Date(), quoteInvalidationReason: reason },
  });
  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.quotes_invalidated",
    entityType: AUDIT_ENTITY.ORDER,
    entityId: orderId,
    afterData: { removed: removed.count, reason },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return { removed: removed.count };
}

/**
 * The reasons a quote stops describing its order, in one place so the wording
 * (which the operator reads) and the call sites (which decide when) cannot
 * drift apart.
 */
export const QUOTE_INVALIDATION = {
  packagesChanged: "The order's packages changed after these quotes were requested.",
  addressChanged: "The ship-to address changed after these quotes were requested.",
} as const;

/**
 * Take exclusive responsibility for booking one shipment.
 *
 * A conditional UPDATE, so two operators clicking Book at the same moment produce
 * one attempt and one refusal — the loser's update matches nothing. The loser is
 * told what the shipment is doing rather than being handed a generic error,
 * because "already being booked" and "already booked" call for different actions
 * from whoever is holding the second browser tab.
 */
async function claimForBooking(shipmentId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const claim = await prisma.shipment.updateMany({
    where: { id: shipmentId, status: { in: [...BOOKABLE_STATES] }, providerShipmentId: null },
    data: { status: "BOOKING", bookingAttemptedAt: new Date() },
  });
  if (claim.count === 1) return { ok: true };

  const current = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!current) return { ok: false, reason: "Shipment not found." };
  if (current.providerShipmentId) {
    return { ok: false, reason: "already_booked" };
  }
  return { ok: false, reason: bookingRefusal(current.status) };
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
  // BOOKING_FAILED is bookable on purpose: the provider refused and nothing was
  // purchased, so retrying is the correct next action. BOOKING and
  // BOOKING_UNKNOWN are not — see BOOKABLE_STATES.
  if (!(BOOKABLE_STATES as readonly string[]).includes(shipment.status)) {
    throw new Error(bookingRefusal(shipment.status));
  }

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
  /*
   * Claimed before anything is sent, and every path to the provider goes
   * through here, so this is the single place a second booking can be stopped.
   * Two operators with the shipment page open both pressing Book produce one
   * attempt: the loser's conditional UPDATE matches nothing.
   */
  const claim = await claimForBooking(shipmentId);
  if (!claim.ok) {
    if (claim.reason === "already_booked") {
      const existing = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      return { shipment: existing, sync: { pushed: false, reason: "already_booked" } };
    }
    throw new Error(claim.reason);
  }

  const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
  // Items are included because the rate request needs the ordered quantity, and
  // a Prisma result only carries relations that were asked for. The seller is
  // included for the retry job queued below, which is scoped to their access.
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { packages: true, items: true, seller: { select: { id: true, accessVersion: true } } },
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
        // BOOKED, not PENDING: the provider has answered and the label exists.
        // Only a booking that reached this line has one.
        status: "BOOKED",
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
        // A successful booking clears the record of the failures before it, so
        // the page stops reporting a problem that is no longer true.
        lastBookingError: null,
        bookingOutcomeUnknownAt: null,
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

    /*
     * The push above is the attempt; this is the retry.
     *
     * Queued only when there is something to retry — a seller with no
     * fulfillment order id will not grow one, and a job that can only report
     * the same missing id five times is noise in the queue. The job is scoped
     * to the seller's access version, so a store blocked between booking and
     * the retry does not get its fulfillment pushed.
     *
     * A successful push queues nothing: Shopify has already been told, and a
     * second fulfillmentCreate for the same fulfillment order is an error, not
     * a no-op.
     */
    if (!sync.pushed && order.shopifyFulfillmentOrderId) {
      await enqueueJob({
        kind: JOB_KIND.SHOPIFY_FULFILLMENT_SYNC,
        idempotencyKey: jobKey(JOB_KIND.SHOPIFY_FULFILLMENT_SYNC, order.seller.id, updated.id),
        sellerId: order.seller.id,
        sellerAccessVersion: order.seller.accessVersion,
        payload: { shipmentId: updated.id },
      });
    }

    return { shipment: updated, sync };
  } catch (error) {
    const message = error instanceof Error ? error.message : "booking failed";

    /*
     * A timeout is not a failure, and must not be recorded as one.
     *
     * The provider may have bought the label and lost the reply on the way
     * back, which is why the two outcomes get different states. BOOKING_FAILED
     * says nothing was purchased and a retry is safe — a promise we cannot make
     * after a timeout. BOOKING_UNKNOWN says a person has to find out, and the
     * booking path refuses to run again until one has (see claimForBooking).
     * Guessing either way is how an order ends up with two labels.
     */
    const timedOut = isProviderTimeout(error);

    await prisma.shipment.update({
      where: { id: shipment.id },
      data: timedOut
        ? {
            status: "BOOKING_UNKNOWN",
            bookingOutcomeUnknownAt: new Date(),
            lastBookingError: message,
          }
        : { status: "BOOKING_FAILED", lastBookingError: message },
    });
    await setIntegrationState("eshipper", { status: "FAILED", error: message });
    await recordAudit({
      actorType: "ADMIN_USER",
      actorId: actor.actorId,
      actorName: actor.actorName,
      action: timedOut ? "shipping.booking_outcome_unknown" : "shipping.booking_failed",
      entityType: AUDIT_ENTITY.SHIPMENT,
      entityId: shipment.id,
      afterData: { message, providerQuoteId: quote.providerQuoteId, timedOut },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    if (timedOut) {
      throw new Error(
        `Booking outcome unknown: the provider did not answer in time (${message}). ` +
          `It may already hold a label for this shipment, so do not book again — ` +
          `reconcile the booking first. The seller has not been charged a second time.`
      );
    }

    // Payment remains SUCCEEDED; the order stays eligible for a safe re-book.
    throw new Error(
      `${BOOKING_ERROR}: ${message}. ` +
        `Nothing was purchased, and the seller has not been charged again — retry booking safely.`
    );
  }
}

/**
 * Ask the provider whether an interrupted booking actually happened.
 *
 * THE ONLY QUESTION THIS ANSWERS is "does the provider hold a shipment we
 * cannot see". If it does, the booking is adopted from the provider's own copy
 * rather than repeated — that is the whole point of `getShipment`, and the
 * reason its timeout is not retried internally.
 *
 * If it answers with nothing, that is recorded and NOTHING ELSE CHANGES. An
 * empty answer is not proof that no label exists: the lookup is by the quote id
 * the provider was given before the call went quiet, and a provider that
 * indexes nothing under that reference would answer empty whether or not a
 * label was purchased. Turning that into BOOKING_FAILED would hand the operator
 * a re-book button on the strength of a lookup that cannot support the claim,
 * so a person decides through resolveUnknownBooking once they have checked the
 * provider's own portal.
 */
export async function reconcileBookingOutcome(shipmentId: string, actor: Actor) {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");
  if (shipment.status !== "BOOKING_UNKNOWN") {
    throw new Error(
      shipment.status === "BOOKED"
        ? "This shipment is already booked."
        : `Only a shipment awaiting an unknown booking outcome can be reconciled (this is ${shipment.status}).`
    );
  }
  if (!shipment.providerQuoteId) {
    throw new Error(
      "No provider quote id was stored for this booking, so the provider cannot be asked what it holds. " +
        "Check the provider's portal and record the outcome instead."
    );
  }

  const mode = await eshipperMode();
  if (mode !== "real") {
    throw new Error(
      "eShipper is not in real mode, so nothing was purchased and there is nothing to reconcile. " +
        "Record the outcome to clear this shipment."
    );
  }

  const found = await getShipment(shipment.providerQuoteId);
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.booking_reconciled",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: { found: Boolean(found), providerQuoteId: shipment.providerQuoteId },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  if (!found || !found.providerShipmentId) {
    await prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        lastBookingError:
          `Reconciled: the provider returned no shipment for quote ${shipment.providerQuoteId}. ` +
          `This is not proof that no label exists — check the provider's portal.`,
      },
    });
    return {
      adopted: false as const,
      providerQuoteId: shipment.providerQuoteId,
      message:
        "The provider holds no shipment under this quote id. That is not proof nothing was purchased, " +
        "so this shipment stays unknown until someone checks the provider's portal and records the outcome.",
    };
  }

  // The provider has it. Adopt its copy rather than buying a second label.
  const updated = await prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      status: "BOOKED",
      providerShipmentId: found.providerShipmentId,
      carrier: found.carrier || shipment.carrier,
      serviceName: found.serviceName || shipment.serviceName,
      trackingNumber: found.trackingNumber || shipment.trackingNumber,
      trackingUrl: found.trackingUrl,
      labelUrl: found.labelUrl ?? shipment.labelUrl,
      labelDocumentFormat: found.labelUrl ? "PDF" : shipment.labelDocumentFormat,
      bookedCost: found.bookedCost || shipment.quotedCarrierCost,
      trackingStatus: TRACKING_STATE.label_created,
      labelCreatedAt: shipment.labelCreatedAt ?? new Date(),
      bookingOutcomeUnknownAt: null,
      lastBookingError: null,
    },
  });
  await setIntegrationState("eshipper", {
    status: "HEALTHY",
    detail: `Recovered booking ${found.providerShipmentId} for quote ${shipment.providerQuoteId}.`,
  });

  return {
    adopted: true as const,
    shipment: updated,
    message: `The provider already held this booking (${found.providerShipmentId}). It has been recorded locally; no second label was purchased.`,
  };
}

/**
 * Record what a person found when they checked the provider themselves.
 *
 * The escape hatch for the case reconcile cannot settle: a timeout whose quote
 * id the provider will not answer for. Because it can put a shipment back into
 * a bookable state — and because putting it there wrongly is the exact mistake
 * the unknown state exists to prevent — it demands a written reason, which is
 * stored on the shipment and in the audit trail. There is no equivalent of this
 * for the ordinary failure path, because an ordinary failure does not need a
 * person's judgement.
 *
 * `label_exists` requires the provider's own identifiers. Recording "a label
 * exists" without a provider shipment id would leave a BOOKED shipment that
 * cannot be tracked, labelled, cancelled or billed.
 */
export async function resolveUnknownBooking(
  shipmentId: string,
  decision: "nothing_purchased" | "label_exists",
  input: { reason: string; providerShipmentId?: string; trackingNumber?: string },
  actor: Actor
) {
  const reason = input.reason?.trim();
  if (!reason || reason.length < 10) {
    throw new Error(
      "A written reason is required (at least 10 characters): say what was checked and where."
    );
  }

  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");
  if (shipment.status !== "BOOKING_UNKNOWN") {
    throw new Error(`Only a shipment awaiting an unknown booking outcome can be resolved (this is ${shipment.status}).`);
  }

  if (decision === "label_exists") {
    const providerShipmentId = input.providerShipmentId?.trim();
    if (!providerShipmentId) {
      throw new Error("Recording a label as existing requires the provider's shipment id.");
    }
    const updated = await prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        status: "BOOKED",
        providerShipmentId,
        trackingNumber: input.trackingNumber?.trim() || shipment.trackingNumber,
        bookingOutcomeUnknownAt: null,
        lastBookingError: `Resolved by hand: label recorded. ${reason}`,
      },
    });
    await recordAudit({
      actorType: "ADMIN_USER",
      actorId: actor.actorId,
      actorName: actor.actorName,
      action: "shipping.booking_resolved_by_hand",
      entityType: AUDIT_ENTITY.SHIPMENT,
      entityId: shipmentId,
      afterData: { decision, reason, providerShipmentId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return { shipment: updated, decision };
  }

  // nothing_purchased: the shipment becomes ordinary-failed, which is what puts
  // it back in BOOKABLE_STATES and lets the retry button work again.
  const updated = await prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      status: "BOOKING_FAILED",
      bookingOutcomeUnknownAt: null,
      lastBookingError: `Checked by hand and recorded as not purchased: ${reason}`,
    },
  });
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.booking_resolved_by_hand",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: { decision, reason },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return { shipment: updated, decision };
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

/**
 * Schedule the carrier pickup for a shipment.
 *
 * A SEPARATE ACT FROM BOOKING, in both directions. A booked shipment is not a
 * scheduled pickup — the label exists and the carrier has not been told to
 * collect anything — and this does not touch the booking fields at all. That
 * separation is what lets a pickup be retried on its own: if the booking
 * succeeded and this call failed, the shipment keeps its label, its tracking
 * and its BOOKED state, and only `pickupStatus` records the failure. Rebooking
 * to "fix" a pickup would buy a second label.
 *
 * Blocked for a shipment with no provider shipment id, which is the same
 * condition the page already uses to disable the button. There is nothing for
 * a carrier to collect.
 */
export async function schedulePickupForShipment(
  shipmentId: string,
  data: { pickupDate: string; pickupTimeWindow: string; notes?: string },
  actor: Actor
): Promise<PickupResult & { pickupStatus: string }> {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");
  if (!shipment.providerShipmentId) {
    throw new Error("Book the shipment before scheduling a pickup — there is nothing for the carrier to collect yet.");
  }

  const requestedAt = new Date();
  let booking: PickupResult;
  try {
    booking = await schedulePickup({
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "pickup request failed";
    // The booking is deliberately untouched. §9: booking success says nothing
    // about the pickup, and a failed pickup must not cost the shipment its
    // label or read as a failed shipment.
    await prisma.shipment.update({
      where: { id: shipmentId },
      data: { pickupStatus: "FAILED", pickupLastError: message },
    });
    await recordAudit({
      actorType: "ADMIN_USER",
      actorId: actor.actorId,
      actorName: actor.actorName,
      action: "shipping.pickup_failed",
      entityType: AUDIT_ENTITY.SHIPMENT,
      entityId: shipmentId,
      afterData: { message, requestedDate: data.pickupDate, window: data.pickupTimeWindow },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    throw new Error(
      `Pickup could not be scheduled: ${message}. The shipment itself is unaffected — its booking and label are intact, ` +
        `so retry the pickup on its own rather than rebooking.`
    );
  }

  // The provider words its own date; keep the string it sent when it parses and
  // the requested date when it does not, rather than storing an invalid Date.
  const scheduledFor = new Date(booking.scheduledDate);
  const updated = await prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      pickupStatus: "SCHEDULED",
      providerPickupId: booking.pickupId,
      pickupScheduledFor: Number.isNaN(scheduledFor.getTime()) ? null : scheduledFor,
      pickupWindow: data.pickupTimeWindow || null,
      pickupConfirmation: booking.confirmationNumber ?? null,
      pickupLastError: null,
      pickupCancelledAt: null,
    },
  });
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.pickup_scheduled",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: {
      pickupId: booking.pickupId,
      scheduledDate: booking.scheduledDate,
      confirmation: booking.confirmationNumber ?? null,
      requestedAt,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { ...booking, pickupStatus: updated.pickupStatus ?? "SCHEDULED" };
}

/**
 * Cancel a scheduled pickup.
 *
 * Separate from cancelling the shipment, and separate from any refund: this
 * tells the carrier not to collect, and nothing about money. The stored pickup
 * id is used when the caller does not supply one, so the operator does not have
 * to keep a provider identifier on a clipboard to undo their own action.
 */
export async function cancelPickupForShipment(shipmentId: string, pickupId: string | undefined, actor: Actor) {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");

  const target = pickupId?.trim() || shipment.providerPickupId;
  if (!target) throw new Error("There is no scheduled pickup on this shipment to cancel.");

  let result: { cancelled: boolean };
  try {
    result = await cancelPickup(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : "pickup cancellation failed";
    // Not CANCELLED and not FAILED: the request never got an answer, so a truck
    // may still be coming. Recording it as cancelled would stop anyone checking.
    // `pickupCancelledAt` is cleared with it, because that column records a
    // CONFIRMED cancellation and is only true while the pickup is CANCELLED —
    // leaving a timestamp behind on an unresolved pickup is the same record
    // saying two things, which is how a stale one gets believed.
    await prisma.shipment.update({
      where: { id: shipmentId },
      data: { pickupStatus: "UNKNOWN", pickupLastError: message, pickupCancelledAt: null },
    });
    await recordAudit({
      actorType: "ADMIN_USER",
      actorId: actor.actorId,
      actorName: actor.actorName,
      action: "shipping.pickup_cancel_unknown",
      entityType: AUDIT_ENTITY.SHIPMENT,
      entityId: shipmentId,
      afterData: { pickupId: target, message },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    throw new Error(
      `Pickup cancellation outcome unknown: ${message}. The pickup may still be standing — ` +
        `do not assume it was cancelled.`
    );
  }

  /*
   * Three outcomes, recorded as three different things. A confirmed
   * cancellation ends the pickup; a provider that answered "no" leaves it
   * standing, so it stays SCHEDULED; a provider that could not be reached at
   * all leaves an outcome nobody knows, which is UNKNOWN and not CANCELLED —
   * a truck may still be coming.
   */
  const data = result.cancelled
    ? { pickupStatus: "CANCELLED", pickupCancelledAt: new Date(), pickupLastError: null }
    : {
        pickupStatus: shipment.pickupStatus === "FAILED" ? "FAILED" : "SCHEDULED",
        pickupLastError: "The provider did not confirm the cancellation; the pickup still stands.",
        // The provider is the authority on whether a truck is coming, and it
        // has just said the pickup stands. A cancellation timestamp would
        // contradict the status it sits next to.
        pickupCancelledAt: null,
      };

  await prisma.shipment.update({ where: { id: shipmentId }, data });
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.pickup_cancelled",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: { pickupId: target, cancelled: result.cancelled, usedStoredId: !pickupId?.trim() },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { ...result, pickupId: target };
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