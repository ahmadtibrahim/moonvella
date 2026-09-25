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
import {
  buildQuotePackagesForOrder,
  parcelRowsToQuotePackages,
  resolvePackagesForLines,
  type PackageLineInput,
  type QuotePackage,
  type StoredParcelRow,
} from "./packaging.server";
import {
  carrierShipFrom,
  resolveOriginForLines,
  type CarrierShipFrom,
  type OriginSnapshot,
  type ShipmentOrigin,
} from "./origins.server";
import { normalizeClock } from "~/utils/originFields";
import {
  CARRIER_AVAILABILITY_CAVEAT,
  MAX_PROPOSAL_SCAN,
  proposePickupDates,
  pickupDateReasons,
  scheduleProblem,
  type LocationSchedule,
} from "./holidays";
import { resolveFulfillmentOrders } from "./shopifyFulfillment.server";
import { assertBookingAddressesBookable, assertDeliveryAddressBookable } from "./addressValidation.server";

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

/**
 * Where a return is sent: the return destination, and nothing else.
 *
 * THIS IS NOT A SHIPPING ORIGIN AND MUST NEVER BE USED AS ONE. It used to be the
 * ships-from address for every outbound rate request and every booking, which
 * meant a carrier was told to collect from a placeholder warehouse that existed
 * only as a default in this function. Outbound now resolves the real dock from
 * the item's mapping (`origins.server.ts`) and cannot be given a fallback; what
 * remains here is the one address the work order does say is configured — the
 * place returns go, which may differ from the dock the goods came from.
 *
 * THE DEFAULTS ARE STILL PLACEHOLDERS, deliberately visible as such: a return
 * destination that has not been set is not a real address, and the Phase D
 * return work has to replace this with a configured record rather than inherit
 * "1 Warehouse Way" as though somebody had chosen it.
 */
function configuredReturnAddress() {
  return {
    name: process.env.MOONVELLA_RETURN_NAME || process.env.MOONVELLA_SHIP_FROM_NAME || "MoonVella",
    address: process.env.MOONVELLA_RETURN_ADDRESS || process.env.MOONVELLA_SHIP_FROM_ADDRESS || "",
    city: process.env.MOONVELLA_RETURN_CITY || process.env.MOONVELLA_SHIP_FROM_CITY || "",
    province: process.env.MOONVELLA_RETURN_PROVINCE || process.env.MOONVELLA_SHIP_FROM_PROVINCE || "",
    postalCode: process.env.MOONVELLA_RETURN_POSTAL || process.env.MOONVELLA_SHIP_FROM_POSTAL || "",
    country: process.env.MOONVELLA_RETURN_COUNTRY || process.env.MOONVELLA_SHIP_FROM_COUNTRY || "CA",
  };
}

/**
 * The ships-from address is a PARAMETER, never a default.
 *
 * It used to be assembled from environment variables with plausible stand-ins
 * ("1 Warehouse Way, Toronto"), which meant every rate request and every label
 * priced a dock nobody had chosen. It is now the resolved origin and cannot be
 * omitted — a caller that has not resolved one has nothing honest to send, so
 * the type refuses the call rather than letting a fallback answer for it.
 */
function buildRateRequest(
  order: { shippingAddress: string | null; items: { quantity: number }[]; moonvellaTotal: number; currency: string },
  packages: { count: number; length: number; width: number; height: number; weight: number; units: string }[],
  from: CarrierShipFrom
): RateRequest {
  const to = parseAddress(order.shippingAddress);
  return {
    shipFrom: {
      name: from.name,
      address: from.address,
      city: from.city,
      province: from.province,
      postalCode: from.postalCode,
      country: from.country,
      phone: from.phone,
      email: from.email,
    },
    shipTo: {
      name: to.name,
      address: to.address1 || to.address || "",
      city: to.city,
      province: to.province || to.provinceCode,
      postalCode: to.zip || to.postalCode || "",
      country: to.country || to.countryCode || "CA",
      residential: to.residential === undefined ? true : to.residential !== "false",
      // Only when the stored address carries them: a destination that has no
      // phone number is still a destination, and inventing one puts a wrong
      // number on a label.
      phone: to.phone || to.phoneNumber || null,
      email: to.email || null,
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
  isPartialDelivery,
  partialDeliverySummary,
  trackingDisplay,
  trackingPollPolicy,
  TRACKING_POLL,
  matchFulfillmentLines,
  isFulfillmentMilestone,
  FULFILLMENT_MILESTONE_EVENTS,
  pickupWindowMissed,
  pickupDeadline,
  closingTimeFrom,
  type TrackingPollInput,
  type ShipmentFulfillmentLine,
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
  isPartialDelivery,
  partialDeliverySummary,
  trackingDisplay,
  trackingPollPolicy,
  TRACKING_POLL,
  matchFulfillmentLines,
  isFulfillmentMilestone,
  FULFILLMENT_MILESTONE_EVENTS,
  pickupWindowMissed,
  pickupDeadline,
  closingTimeFrom,
  type TrackingPollInput,
  type ShipmentFulfillmentLine,
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
  for (const ev of tracking.trackingDetails) {
    const eventAt = ev.dateTime ? new Date(ev.dateTime) : new Date();
    const when = Number.isNaN(eventAt.getTime()) ? new Date() : eventAt;
    /*
     * The key is the event's CONTENT, and deliberately not its position in the
     * carrier's array.
     *
     * It used to end in the array index, which made the key change whenever the
     * provider reordered its events — and providers do, because a new event is
     * usually prepended. Every poll then re-inserted every event under a new
     * key: the history grew by a full copy each time, the same "In transit"
     * appeared five times on the shipment page, and "the newest event" was
     * whichever copy happened to sort last. Two events that agree on time,
     * code, wording and place are the same event, and collapsing them is the
     * whole point of the unique constraint.
     */
    const eventKey = `${when.toISOString()}|${ev.carrierEventCode ?? ""}|${ev.statusText ?? ""}|${ev.description ?? ""}|${ev.location ?? ""}`;
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

/**
 * The origin this order's goods are quoted from, resolved from its lines.
 *
 * `originLocationId` names the dock when the caller has one — the case of an
 * order whose items sit at two docks, where the operator quotes each dock in
 * turn. Without it the resolution succeeds only when every line agrees, so an
 * order that ships from one place behaves exactly as it always did, and an order
 * that does not is told to split rather than quietly priced from whichever dock
 * happened to be first.
 */
export async function resolveOrderOrigin(
  orderId: string,
  opts: { originLocationId?: string | null; orderItemIds?: string[] } = {},
): Promise<ShipmentOrigin> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) throw new Error("Order not found.");

  const lines = order.items
    .filter((item) => !opts.orderItemIds || opts.orderItemIds.includes(item.id))
    .map((item) => ({
      orderItemId: item.id,
      variantId: item.variantId,
      sku: item.sku,
      quantity: item.quantity,
    }));

  const origin = await resolveOriginForLines(lines);
  if (!opts.originLocationId || !origin.ready) return origin;

  // The caller named a dock. If the lines do not resolve to it, that is a
  // contradiction worth reporting rather than overriding: either the mapping
  // changed under them or the wrong dock was chosen, and both are cheaper to
  // find now than at a loading bay.
  if (origin.location?.id !== opts.originLocationId) {
    const chosen = await prisma.pickupLocation.findUnique({ where: { id: opts.originLocationId } });
    return {
      ...origin,
      location: null,
      snapshot: null,
      ready: false,
      reason: chosen
        ? `Pickup location "${chosen.name}" (${chosen.code}) was chosen, but these items are not mapped to it. ` +
          `Re-check the mapping before quoting.`
        : "The chosen pickup location no longer exists. Re-check the mapping before quoting.",
    };
  }
  return origin;
}

/**
 * The dock a PREPARED shipment collects from.
 *
 * A shipment carries the lines it holds, so this is the question "where do THESE
 * parcels leave from" rather than "where does the order leave from" — which is
 * the whole reason a two-dock order can be shipped at all. A shipment whose
 * lines span two docks is refused here, with the docks named, because the order
 * splits at preparation time and a parcel cannot be collected from two places.
 */
export async function resolveShipmentOrigin(
  shipment: { id: string; items: readonly { orderItemId: string; quantity: number }[] },
  orderItems: readonly { id: string; variantId: string | null; sku: string; quantity: number }[],
): Promise<ShipmentOrigin> {
  const byId = new Map(orderItems.map((item) => [item.id, item]));
  const lines = [];
  const unknown: string[] = [];
  for (const si of shipment.items) {
    const item = byId.get(si.orderItemId);
    if (!item) {
      unknown.push(si.orderItemId);
      continue;
    }
    lines.push({
      orderItemId: item.id,
      variantId: item.variantId,
      sku: item.sku,
      quantity: si.quantity,
    });
  }
  if (unknown.length > 0) {
    return {
      location: null,
      snapshot: null,
      ready: false,
      missing: [],
      reason:
        "Pickup location required. This shipment holds order lines that no longer exist on " +
        "the order, so what it collects and where from cannot be established. Re-pack it.",
      groups: [],
      split: false,
    };
  }
  return resolveOriginForLines(lines);
}

export async function getQuotesForOrder(
  orderId: string,
  actor: Actor,
  opts: { originLocationId?: string | null; orderItemIds?: string[] } = {},
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, packages: true },
  });
  if (!order) throw new Error("Order not found.");

  const to = parseAddress(order.shippingAddress);
  if (!to.zip && !to.postalCode) {
    throw new Error("Ship-to postal code is missing on this order. Correct the address before quoting.");
  }

  /*
   * The dock comes first, because everything below prices a parcel leaving it.
   * A rate requested without one is a price for a journey that does not exist,
   * and the carrier has no way to know it was asked the wrong question.
   */
  const origin = await resolveOrderOrigin(orderId, opts);
  if (!origin.ready || !origin.snapshot) {
    throw new Error(origin.reason ?? "Pickup location required before quoting.");
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

  const request = buildRateRequest(order, built.packages, carrierShipFrom(origin.snapshot));
  const rates = await getRates(request);

  // Scoped to this dock: quoting the second dock of a split order must not
  // withdraw the first dock's prices, which the operator may already have read.
  await prisma.shippingQuote.deleteMany({
    where: { orderId, originLocationId: origin.location!.id, selected: false, provider: "eshipper" },
  });
  await prisma.$transaction(
    rates.map((r) =>
      prisma.shippingQuote.create({
        data: {
          orderId,
          originLocationId: origin.location!.id,
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
    afterData: {
      count: rates.length,
      mode: await eshipperMode(),
      originLocationId: origin.location!.id,
      originCode: origin.snapshot.code,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return prisma.shippingQuote.findMany({
    where: { orderId, originLocationId: origin.location!.id },
    orderBy: { totalAmount: "asc" },
  });
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

/**
 * The parcels that belong to ONE shipment.
 *
 * WHAT THIS REPLACES, AND WHY IT WAS WRONG. Both booking paths used to send
 * `order.packages` — EVERY parcel row on the order — to the carrier, whatever
 * the shipment actually contained. On a single-shipment order that is the same
 * thing. On a split order it is not: a shipment holding one carton of three was
 * quoted, labelled and customs-declared for goods that were never in the box,
 * and the operator had no way to see that had happened. The seller paid for the
 * wrong thing and the box was described as something it was not.
 *
 * THREE SOURCES, AND THE ORDER THEY ARE TRIED IN IS NOT ARBITRARY:
 *
 *   `linked`  — parcel rows on the order that name THIS shipment. Set when a box
 *               is packed (`createPackingShipment`). This is a person having said
 *               which cartons are in this box, so it wins over everything.
 *
 *   `order`   — the order's own parcel rows, unchanged from the old behaviour.
 *               It is second because it is WHAT THE QUOTE WAS PRICED FROM: the
 *               rate request in `getQuotesForOrder` reads the same order rows,
 *               and a booking that sent a different set would put a label on
 *               goods the price was never about.
 *
 *   `derived` — the shipment's own lines through the resolver, used only when
 *               the order has no parcel rows at all — the same condition under
 *               which quoting derives them. The QUANTITY COMES FROM THE SHIPMENT
 *               ITEM, not the order line: a carrier collects what is in the box,
 *               so a shipment of 2 of 5 units is described as 2.
 *
 * The order that is NOT used here is worth stating: a shipment never prefers
 * derived parcels over a parcel row a person entered, because the person is
 * describing the box they are looking at and the resolver is describing a
 * catalogue entry.
 *
 * `missing` non-empty means REFUSE. It is never partially usable: sending the
 * parcels that could be resolved while another is undecidable is exactly the
 * silent omission this whole module is arranged against.
 */
export interface ShipmentParcelSet {
  packages: QuotePackage[];
  source: "linked" | "derived" | "order";
  notes: string[];
  missing: string[];
}

export async function packagesForShipment(
  /** The shipment, or a pending one that has not been created yet. */
  shipment: { id: string; items: { orderItemId: string; quantity: number }[] },
  order: {
    id: string;
    items: { id: string; sku: string; quantity: number; variantId: string | null }[];
    packages: StoredParcelRow[];
  },
): Promise<ShipmentParcelSet> {
  const notes: string[] = [];

  // 1. Parcels a person put in this box.
  const linked = order.packages.filter((row) => row.shipmentId === shipment.id);
  if (linked.length > 0) {
    const { packages, refused } = parcelRowsToQuotePackages(linked);
    return { packages, source: "linked", notes, missing: refused };
  }

  // 2. The order's own parcel rows — what the quote was priced from.
  if (order.packages.length > 0) {
    const { packages, refused } = parcelRowsToQuotePackages(order.packages);
    const unlinked = order.packages.filter((row) => !row.shipmentId).length;
    if (unlinked === order.packages.length && order.packages.length > 1) {
      /*
       * Said out loud rather than left as an invisible default. On a single
       * shipment this note is noise and is not written; on several it is the
       * fact an operator needs — the cartons on this order have not been
       * divided between the boxes, so every box is being described as all of
       * them. Assigning them on the packing page is the fix, and the note says
       * so where the person who can do it is already looking.
       */
      notes.push(
        `None of this order's ${order.packages.length} cartons is assigned to a box, so every shipment on it ` +
          `is described by the whole list. Assign the cartons to boxes on the packing page.`,
      );
    }
    return { packages, source: "order", notes, missing: refused };
  }

  /*
   * 3. Derived from what is in the box. A line on the shipment that is no longer
   *    on the order cannot be derived, so it is refused by name rather than
   *    skipped, and `resolvePackagesForLines` refuses internally to return a plan
   *    that quietly dropped a line.
   */
  const byId = new Map(order.items.map((item) => [item.id, item]));
  const lines: PackageLineInput[] = [];
  const unknownLines: string[] = [];
  for (const item of shipment.items) {
    const line = byId.get(item.orderItemId);
    if (!line) {
      unknownLines.push(item.orderItemId);
      continue;
    }
    lines.push({
      orderItemId: line.id,
      sku: line.sku,
      quantity: item.quantity,
      variantId: line.variantId,
    });
  }

  const plan = lines.length > 0 ? await resolvePackagesForLines(lines) : null;
  if (plan && plan.missing.length === 0 && plan.packages.length > 0) {
    return { packages: plan.packages, source: "derived", notes, missing: [] };
  }

  const missing = [
    ...(plan?.missing ?? []),
    ...unknownLines.map((id) => `order line ${id} is not on this order`),
  ];
  return {
    packages: [],
    source: "derived",
    notes,
    missing:
      missing.length > 0
        ? missing
        : ["this shipment has no cartons recorded and no lines to derive them from"],
  };
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
  // No "are there any packages" guard here any more. It asked whether the ORDER
  // had parcel rows, which is not the question: cartons derived from the booked
  // lines are just as real, and the resolution below refuses the case where
  // there is genuinely nothing — with the line that is missing, which this could
  // not say.

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

  /*
   * The cartons this booking will describe, resolved before the shipment row
   * exists. `pending` is a shipment id that cannot match a stored row — every
   * id in this database is a cuid — so the linked-carton branch is correctly
   * skipped and the set is the one this booking is about. Doing it here rather
   * than only in `finalizeBooking` means an order whose packaging is incomplete
   * is refused with a reason, instead of leaving behind a shipment record for a
   * purchase that could never have completed.
   */
  const parcels = await packagesForShipment({ id: "pending", items: toShip }, order);
  if (parcels.missing.length > 0) {
    throw new Error(
      `Packaging incomplete for this booking: ${parcels.missing.join("; ")}. Complete the packaging before booking.`,
    );
  }
  if (parcels.packages.length === 0) {
    throw new Error("This order has no cartons to book. Record the parcel dimensions before booking.");
  }

  // The lines being booked decide the dock, and the dock decides which quotes
  // are even eligible. Resolved before the shipment row exists because the
  // operator has to be told "there is no quote from this dock" rather than
  // handed a shipment that then refuses to book.
  const toShipLineIds = new Set(toShip.map((i) => i.orderItemId));
  const origin = await resolveOriginForLines(
    order.items
      .filter((i) => toShipLineIds.has(i.id))
      .map((i) => ({ orderItemId: i.id, variantId: i.variantId, sku: i.sku, quantity: i.quantity })),
  );
  if (!origin.ready || !origin.location) {
    throw new Error(origin.reason ?? "Pickup location required before booking.");
  }

  /*
   * The addresses, before the money. Both ends of the label are checked here —
   * this is the enforcement the booking flow was missing: `addressGate` existed
   * and was rendered on the origins page, but nothing that books ever consulted
   * it, so an address Google had refused (or had never managed to check at all)
   * still produced a label and a charge. It runs before the quote lookup for a
   * blunt reason: a refusal that says "this address has never been checked"
   * tells the operator what to do, and a refusal that says "re-quote" sends them
   * to re-quote an address that will refuse again.
   */
  await assertBookingAddressesBookable({ originLocationId: origin.location.id, orderId });

  const quote = opts.quoteId
    ? await prisma.shippingQuote.findUnique({ where: { id: opts.quoteId } })
    : await prisma.shippingQuote.findFirst({
        where: { orderId, selected: true, originLocationId: origin.location.id },
      });
  if (!quote || quote.orderId !== orderId) {
    // The caller named a quote and it is not there any more. Saying "there is no
    // quote from this dock" would be true and useless: the operator is holding a
    // stale page, and the fact they need is that the price they are looking at
    // has been withdrawn — usually because the parcels changed under it.
    if (opts.quoteId && !quote) {
      throw new Error(
        "That shipping quote no longer exists — it has been withdrawn since this page was loaded. " +
          "Select a shipping service before booking."
      );
    }
    const fromThisDock = await prisma.shippingQuote.count({
      where: { orderId, originLocationId: origin.location.id },
    });
    throw new Error(
      fromThisDock > 0
        ? "Select a shipping service before booking."
        : `There is no quote from ${origin.snapshot?.name ?? "this pickup location"}. ` +
          `Request quotes for this dock before booking.`,
    );
  }
  if (quote.expiresAt && quote.expiresAt < new Date()) {
    throw new Error("The selected quote has expired. Re-quote before booking.");
  }

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
        // The cartons resolved above for THIS booking, not every parcel row on
        // the order. The two are the same number on a one-shipment order and
        // differ on a split one, which is the whole point.
        packageCount: parcels.packages.reduce((s, p) => s + p.count, 0),
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
  /*
   * The selected quote is looked up FOR THIS DOCK. An order with goods at two
   * docks has two sets of quotes, and `selected: true` is not unique across
   * them — reading the first selected row regardless of origin is how a parcel
   * ends up travelling on a price quoted from an address it never visited.
   */
  const origin = await resolveShipmentOrigin(shipment, order.items);
  if (!origin.ready || !origin.location) {
    throw new Error(origin.reason ?? "Pickup location required before booking.");
  }

  // The same address precondition as bookShipmentForOrder, on the same two
  // ends. Booking a prepared parcel is still booking, and it still prints a
  // destination the customer typed.
  await assertBookingAddressesBookable({ originLocationId: origin.location.id, orderId: order.id });

  const quote = quoteId
    ? await prisma.shippingQuote.findUnique({ where: { id: quoteId } })
    : await prisma.shippingQuote.findFirst({
        where: { orderId: order.id, selected: true, originLocationId: origin.location.id },
      });
  if (!quote || quote.orderId !== order.id) {
    // Same distinction as bookShipmentForOrder: a named quote that has gone is a
    // withdrawal, not a missing dock.
    if (quoteId && !quote) {
      throw new Error(
        "That shipping quote no longer exists — it has been withdrawn since this page was loaded. " +
          "Select a shipping service before booking."
      );
    }
    const fromThisDock = await prisma.shippingQuote.count({
      where: { orderId: order.id, originLocationId: origin.location.id },
    });
    throw new Error(
      fromThisDock > 0
        ? "Select a shipping service before booking."
        : `There is no quote from ${origin.snapshot?.name ?? "this pickup location"}. ` +
          `Request quotes for this dock before booking.`,
    );
  }
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
  quote: {
    carrier: string;
    serviceCode: string;
    serviceName: string;
    providerQuoteId: string | null;
    totalAmount: number;
    originLocationId: string | null;
  },
  actor: Actor
) {
  const shipment = await prisma.shipment.findUniqueOrThrow({
    where: { id: shipmentId },
    include: { items: true },
  });
  // Items are included because the rate request needs the ordered quantity, and
  // a Prisma result only carries relations that were asked for. The seller is
  // included for the retry job queued below, which is scoped to their access.
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { packages: true, items: true, seller: { select: { id: true, accessVersion: true } } },
  });

  /*
   * THE DOCK IS SETTLED BEFORE THE CLAIM, AND THE CLAIM IS STILL FIRST TO THE
   * PROVIDER. Where the parcel is collected from is a local read, so deciding it
   * cannot consume the booking attempt; but it must be decided before the
   * shipment is moved into BOOKING, because a refusal after the claim would
   * leave a shipment that looks like a call is out when nothing was sent.
   */
  const origin = await resolveShipmentOrigin(shipment, order.items);
  if (!origin.ready || !origin.snapshot || !origin.location) {
    throw new Error(origin.reason ?? "Pickup location required before booking.");
  }
  if (quote.originLocationId !== origin.location.id) {
    throw new Error(
      quote.originLocationId
        ? `The selected quote was priced from a different pickup location. ` +
          `These items leave from ${origin.snapshot.name} (${origin.snapshot.code}) — quote that dock before booking.`
        : `The selected quote does not name the pickup location these items leave from ` +
          `(${origin.snapshot.name}, ${origin.snapshot.code}), so it cannot be spent on them. Re-quote before booking.`,
    );
  }
  const shipFromAddress = carrierShipFrom(origin.snapshot);

  /*
   * THE PARCELS OF THIS SHIPMENT, NOT OF THE ORDER. Resolved before the claim so
   * a set that cannot be described is refused while the shipment is still
   * untouched — and so the operator is told which line is incomplete rather than
   * discovering it from a carrier error after a label was bought.
   */
  const parcels = await packagesForShipment(shipment, order);
  if (parcels.missing.length > 0) {
    throw new Error(
      `Packaging incomplete for this shipment: ${parcels.missing.join("; ")}. ` +
        `Complete the packaging before booking.`,
    );
  }
  if (parcels.packages.length === 0) {
    throw new Error("This shipment has no cartons to book. Record a parcel before booking it.");
  }

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

  try {
    const booking = await bookShipment({
      quote: {
        carrier: quote.carrier,
        serviceCode: quote.serviceCode,
        serviceName: quote.serviceName,
        providerQuoteId: quote.providerQuoteId,
      },
      rateRequest: buildRateRequest(order, parcels.packages, shipFromAddress),
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
        /*
         * Frozen here, at the moment the carrier is told where to go. The
         * snapshot is what the label, the carrier's own record and the pickup
         * request will all be read from, so an operator tidying up the dock's
         * details next month cannot move a parcel that already shipped. The
         * packages are frozen for the same reason: what was quoted is what was
         * collected.
         */
        originLocationId: origin.location.id,
        originSnapshot: origin.snapshot as never,
        packageSnapshot: parcels.packages.map((p) => ({
          count: p.count,
          length: p.length,
          width: p.width,
          height: p.height,
          weight: p.weight,
          units: p.units,
        })) as never,
        // What the dock's arrangement says should happen next, copied now so a
        // later change at the dock cannot rewrite what this parcel was prepared
        // for. NEEDED unless the location says otherwise.
        pickupMode: origin.location.pickupMode ?? "NEEDED",
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
        /*
         * Which cartons were declared, and where they came from. Written into
         * the audit rather than kept in memory because the interesting case is
         * the one an operator will have to explain later: a shipment described
         * by the whole order's parcel list rather than by its own contents.
         */
        packageSource: parcels.source,
        packages: parcels.packages.length,
        ...(parcels.notes.length > 0 ? { packageNotes: parcels.notes.join(" ") } : {}),
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    /*
     * NOTHING IS PUSHED TO SHOPIFY HERE, AND THAT IS THE POINT.
     *
     * This used to call syncShipmentTracking on the way out of a booking, which
     * told Shopify to fulfill the order before anything had been collected. §8:
     * "label booking alone must not be presented as carrier pickup". A Shopify
     * fulfillment is a dispatch — it consumes the line items, e-mails the
     * customer and cannot be undone — so the push belongs at the moment the
     * parcel actually leaves (see isFulfillmentMilestone, and advanceShipment /
     * addManualShipment for the two call sites).
     *
     * The label itself is real either way: it was bought, it is stored, and the
     * operator can print it. What is withheld is the claim that the goods are on
     * their way.
     */
    return { shipment: updated, sync: { pushed: false, reason: "awaiting_dispatch" as const } };
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

/**
 * Tell Shopify that a shipment has left, for exactly the items it contains.
 *
 * WHAT THIS IS NOT. It is not called when a label is bought. §8: "label booking
 * alone must not be presented as carrier pickup". A `fulfillmentCreate` is a
 * dispatch — it fulfills line items, consumes the remaining quantity other
 * shipments would have used, and (when asked) e-mails the customer that the
 * order is on its way. Calling it at booking time told Shopify and the shopper
 * that a parcel had shipped while the label was still in a drawer, and it took
 * the whole fulfillment order with it, so the second parcel had nothing left to
 * fulfill. The call site is now the dispatch milestone; see
 * isFulfillmentMilestone.
 *
 * THREE GUARDS, IN ORDER.
 *
 * `shopifyFulfillmentId` already set means this shipment has been fulfilled in
 * Shopify. `fulfillmentCreate` is not idempotent — asking twice is an error, or
 * worse, a second fulfillment — so the second ask never leaves here.
 *
 * The line items are NAMED, with quantities. A shipment fulfills its own items,
 * never "everything still outstanding" on the fulfillment order.
 *
 * The customer is notified at most once, ever, per shipment: `notifyCustomer` is
 * downgraded to false once `shopifyNotifiedAt` is set, because Shopify sends the
 * mail on the call and there is no undo for a duplicate.
 */
export async function syncShipmentTracking(
  shipmentId: string,
  actor: Actor,
  opts?: { notifyCustomer?: boolean }
) {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { order: { include: { seller: true, items: true } }, items: true },
  });
  if (!shipment) throw new Error("Shipment not found.");

  // Already fulfilled in Shopify. Nothing to send, and sending it again would
  // be a second fulfillment rather than a no-op.
  if (shipment.shopifyFulfillmentId) {
    return {
      pushed: true,
      alreadyPushed: true,
      reason: "already_fulfilled",
      shopifyFulfillmentId: shipment.shopifyFulfillmentId,
    };
  }

  if (!shipment.trackingNumber) {
    return { pushed: false, reason: "no_tracking_number" };
  }

  if (!shipment.order.shopifyFulfillmentOrderId) {
    await setIntegrationState("shopify_fulfillment", {
      status: "NOT_CONFIGURED",
      detail:
        "Tracking is stored locally. Shopify fulfillment sync needs a fulfillment order id (fulfillment-service setup + fulfillment-order scopes).",
    });
    return { pushed: false, reason: "no_fulfillment_order_id" };
  }

  // What this shipment holds, against what the order knows about the lines.
  const orderItemsById = new Map(shipment.order.items.map((item) => [item.id, item]));
  const shipmentLines: ShipmentFulfillmentLine[] = [];
  const missingItemIds: string[] = [];
  for (const line of shipment.items) {
    const item = orderItemsById.get(line.orderItemId);
    if (!item) {
      missingItemIds.push(line.orderItemId);
      continue;
    }
    shipmentLines.push({
      shopifyLineItemId: item.shopifyLineItemId,
      sku: item.sku,
      quantity: line.quantity,
    });
  }
  if (missingItemIds.length > 0) {
    const message =
      `This shipment holds ${missingItemIds.length} order line(s) that no longer exist on the order, ` +
      `so what it fulfills cannot be established. Re-pack the shipment.`;
    await prisma.shipment.update({ where: { id: shipmentId }, data: { shopifySyncError: message } });
    return { pushed: false, reason: "orphan_lines", message };
  }

  const notifyCustomer = Boolean(opts?.notifyCustomer) && !shipment.shopifyNotifiedAt;

  try {
    const { unauthenticated } = await import("~/shopify.server");
    const { admin } = await unauthenticated.admin(shipment.order.seller.shopDomain);

    /*
     * Read the fulfillment order's lines first, so the quantities sent are ones
     * Shopify will accept rather than ones we hoped for. `resolveFulfillmentOrders`
     * also re-checks the scopes and records the blocker on the integration row
     * when they are missing, so a permission problem is reported as a permission
     * problem rather than as a failed fulfillment.
     */
    const resolved = await resolveFulfillmentOrders(shipment.orderId);
    const group =
      resolved.groups.find((g) => g.fulfillmentOrderId === shipment.order.shopifyFulfillmentOrderId) ??
      resolved.groups[0];
    if (!group) {
      const message =
        "Shopify reports no fulfillment order carrying this order's items, so there is nothing to fulfill. " +
        "The order may already be fulfilled, or its items may not be assigned to a fulfillment location yet.";
      await prisma.shipment.update({ where: { id: shipmentId }, data: { shopifySyncError: message } });
      return { pushed: false, reason: "no_fulfillment_order_lines", message };
    }

    const match = matchFulfillmentLines(
      shipmentLines,
      group.items.map((li) => ({
        fulfillmentOrderLineItemId: li.fulfillmentOrderLineItemId,
        lineItemId: li.lineItemId,
        sku: li.sku,
        remainingQuantity: li.remainingQuantity,
      }))
    );

    if (match.lines.length === 0) {
      const detail = match.unmatched.map((u) => `${u.sku}: ${u.reason}`).join(" ");
      const message =
        `This shipment's items could not be matched to lines on the Shopify fulfillment order, so nothing ` +
        `was fulfilled rather than everything. ${detail}`;
      await prisma.shipment.update({ where: { id: shipmentId }, data: { shopifySyncError: message } });
      await setIntegrationState("shopify_fulfillment", { status: "FAILED", error: message });
      return { pushed: false, reason: "no_matching_lines", message, unmatched: match.unmatched };
    }

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
            lineItemsByFulfillmentOrder: [
              {
                fulfillmentOrderId: shipment.order.shopifyFulfillmentOrderId,
                fulfillmentOrderLineItems: match.lines,
              },
            ],
            trackingInfo: {
              number: shipment.trackingNumber,
              url: shipment.trackingUrl,
              company: shipment.carrier,
            },
            notifyCustomer,
          },
        },
      }
    );
    const json = await res.json();
    const errors = json?.data?.fulfillmentCreate?.userErrors ?? [];
    if (errors.length) throw new Error(errors.map((e: { message: string }) => e.message).join("; "));
    const fid = json?.data?.fulfillmentCreate?.fulfillment?.id ?? null;
    if (!fid) throw new Error("Shopify accepted the fulfillment without returning an id.");

    const now = new Date();
    await prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        shopifyFulfillmentId: fid,
        shopifySyncedAt: now,
        shopifySyncError: null,
        // Only when we actually asked Shopify to send it, and only once.
        ...(notifyCustomer ? { shopifyNotifiedAt: now } : {}),
      },
    });
    await setIntegrationState("shopify_fulfillment", {
      status: "HEALTHY",
      detail:
        `Fulfilled ${match.lines.length} line(s) for shipment ${shipmentId}` +
        (notifyCustomer ? " (customer notified)." : "."),
    });
    await recordAudit({
      actorType: actor.actorType ?? "ADMIN_USER",
      actorId: actor.actorId,
      actorName: actor.actorName,
      action: "shipping.shopify_fulfilled",
      entityType: AUDIT_ENTITY.SHIPMENT,
      entityId: shipmentId,
      afterData: {
        shopifyFulfillmentId: fid,
        lines: match.lines.length,
        notified: notifyCustomer,
        ...(match.shortfall.length ? { shortfall: match.shortfall } : {}),
        ...(match.unmatched.length ? { unmatched: match.unmatched } : {}),
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
    return {
      pushed: true,
      shopifyFulfillmentId: fid,
      lines: match.lines.length,
      notified: notifyCustomer,
      shortfall: match.shortfall,
      unmatched: match.unmatched,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "sync failed";
    // Persisted on the shipment AND on the integration row: the first is what the
    // operator sees next to the parcel, the second is what the settings screen
    // shows for the connection as a whole.
    await prisma.shipment
      .update({ where: { id: shipmentId }, data: { shopifySyncError: message } })
      .catch(() => {});
    await setIntegrationState("shopify_fulfillment", { status: "FAILED", error: message });
    return { pushed: false, reason: "exception", message };
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
    /*
     * A failed refresh records the failure and NOTHING ELSE. It does not clear
     * trackingStatus, does not move the coarse status and does not touch the
     * stored events: a provider outage must not erase the last thing the carrier
     * told us, or a parcel that read "Out for delivery" this morning would read
     * "Unknown" this afternoon because a request timed out.
     *
     * The failure count is what stretches the next attempt's interval, so a
     * provider that is down is asked less often rather than hammered.
     */
    await prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        lastTrackingError: message,
        trackingSyncFailures: { increment: 1 },
        // The attempt was real even though the answer was not: this is what
        // makes the backoff engage on the very first failed poll.
        lastTrackingAttemptAt: new Date(),
      },
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
      /*
       * The carrier's own estimate, and only when it gave one. The quote's
       * transit estimate is a different fact (what was sold) and is kept
       * separate rather than overwritten by a date the carrier did not state.
       */
      estimatedDelivery: tracking.deliveryEstimate ?? shipment.estimatedDelivery,
      lastTrackingSyncAt: new Date(),
      lastTrackingAttemptAt: new Date(),
      lastTrackingError: null,
      // The poll succeeded, so the backoff resets. Left growing, a single bad
      // afternoon would keep a shipment on a twelve-hour cadence for a week.
      trackingSyncFailures: 0,
      labelCreatedAt: shipment.labelCreatedAt ?? (tracking.labelGenerated ? new Date() : null),
      shippedAt:
        nextCoarse === "SHIPPED" || nextCoarse === "DELIVERED"
          ? shipment.shippedAt ?? new Date()
          : shipment.shippedAt,
      inTransitAt:
        tracking.inTransit || tracking.pickup || tracking.outForDelivery
          ? shipment.inTransitAt ?? new Date()
          : shipment.inTransitAt,
      // From the NORMALIZED state, not the raw flag: a partial delivery sets
      // delivered=true and is deliberately not a delivery of the shipment.
      deliveredAt: nextState === "DELIVERED" ? shipment.deliveredAt ?? new Date() : shipment.deliveredAt,
      exceptionAt: tracking.exception || tracking.undelivered ? shipment.exceptionAt ?? new Date() : shipment.exceptionAt,
    },
  });

  await recordAudit({
    actorType: actor.actorType ?? "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.tracking_synced",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: {
      trackingStatus: updated.trackingStatus,
      events: tracking.trackingDetails.length,
      ...(isPartialDelivery(tracking) ? { partialDelivery: partialDeliverySummary(tracking) } : {}),
      ...(tracking.deliveryEstimate ? { deliveryEstimate: tracking.deliveryEstimate.toISOString() } : {}),
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return tracking;
}

/**
 * Flag pickups whose window has closed with no collection.
 *
 * §9: "Flag missed pickup windows and scheduling failures." This is the flagging
 * half of that; scheduling failures are already recorded as `pickupStatus:
 * FAILED` with the provider's reason beside them the moment they happen.
 *
 * WHAT IT DOES NOT DO. It does not cancel the pickup, does not void the label and
 * does not reschedule. A missed window means a person has to ring somebody, and
 * the only useful thing automation can do is make sure nobody believes a truck
 * is still coming. The pickup is left standing with MISSED beside it, and the
 * page says so.
 *
 * The comparison is against the dock's own closing time in the dock's own zone —
 * see pickupDeadline, which is where the arithmetic and its reasons live.
 */
export async function flagMissedPickups(
  options: { now?: Date; limit?: number } = {}
): Promise<{ flagged: number; shipmentIds: string[] }> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 200;

  const candidates = await prisma.shipment.findMany({
    where: {
      pickupStatus: "SCHEDULED",
      pickupScheduledFor: { not: null },
    },
    select: {
      id: true,
      pickupStatus: true,
      pickupScheduledFor: true,
      pickupWindow: true,
      trackingStatus: true,
      originLocation: { select: { timeZone: true, pickupCloseTime: true } },
      // The snapshot is the dock as it was when the pickup was arranged, which is
      // the right zone to judge a promise made then.
      originSnapshot: true,
    },
    // Oldest first: the window that closed longest ago is the one most likely to
    // have been forgotten.
    orderBy: { pickupScheduledFor: "asc" },
    take: limit,
  });

  const flagged: string[] = [];
  for (const candidate of candidates) {
    // The snapshot nests the dock's hours under `pickup` — the shape
    // OriginSnapshot is built in, not a flat copy. Reading them top-level
    // silently judged every booked pickup in UTC.
    const snapshot = candidate.originSnapshot as {
      pickup?: { timeZone?: string | null; closeTime?: string | null } | null;
    } | null;
    const missed = pickupWindowMissed(
      {
        pickupStatus: candidate.pickupStatus,
        pickupScheduledFor: candidate.pickupScheduledFor,
        pickupWindow: candidate.pickupWindow,
        trackingStatus: candidate.trackingStatus,
        timeZone: snapshot?.pickup?.timeZone ?? candidate.originLocation?.timeZone ?? null,
        pickupCloseTime: snapshot?.pickup?.closeTime ?? candidate.originLocation?.pickupCloseTime ?? null,
      },
      now
    );
    if (!missed) continue;

    /*
     * A conditional write, so two sweeps that both decide this window is missed
     * produce one transition. The where-clause re-states the status the decision
     * was made on: if a carrier webhook or an operator has moved the pickup on in
     * the meantime, this matches nothing and the flag is not applied to a state
     * it was not computed for.
     */
    const claimed = await prisma.shipment.updateMany({
      where: { id: candidate.id, pickupStatus: "SCHEDULED" },
      data: { pickupStatus: "MISSED" },
    });
    if (claimed.count === 0) continue;

    flagged.push(candidate.id);
    await recordAudit({
      actorType: "SYSTEM",
      actorId: "tracking-sweep",
      actorName: "Tracking sweep",
      action: "shipping.pickup_missed",
      entityType: AUDIT_ENTITY.SHIPMENT,
      entityId: candidate.id,
      afterData: {
        pickupScheduledFor: candidate.pickupScheduledFor?.toISOString() ?? null,
        pickupWindow: candidate.pickupWindow,
        flaggedAt: now.toISOString(),
      },
    });
  }

  return { flagged: flagged.length, shipmentIds: flagged };
}

/* -------------------------------------------------------------------------- */
/* §7 the scheduled sweep                                                      */
/* -------------------------------------------------------------------------- */

/** How long a sweep's claim on a row survives a sweep that died mid-poll. */
const TRACKING_CLAIM_LEASE_MS = 10 * 60 * 1000;

export interface TrackingSweepSummary {
  /** Rows looked at. */
  considered: number;
  /** Rows actually polled. */
  polled: number;
  /** Polls that moved the shipment to a later stage. */
  advanced: number;
  /** Polls where the provider did not answer. */
  failed: number;
  /** Rows the policy said were not due, or that another sweep held. */
  skipped: number;
  /** One line per failure, for the owner's job detail. */
  errors: { shipmentId: string; error: string }[];
}

/**
 * Poll every shipment whose turn it is, and nothing else.
 *
 * WHY THIS EXISTS AT ALL. Until now tracking moved only when a person opened a
 * shipment and pressed Refresh, which means a parcel's status advanced exactly
 * as often as somebody happened to look at it. The work order is explicit that
 * browser refresh must not be required, and it is right: the customer's "where
 * is my parcel" mail arrives whether or not an operator had the page open.
 *
 * BOUNDED, RATE-LIMITED, AND SLOW WHERE IT SHOULD BE. The candidate query is a
 * single indexed read filtered to the SHORTEST interval any shipment can be on,
 * which makes it a superset of what is due; `trackingPollPolicy` then decides
 * row by row, so nothing is polled early and a shipment that has failed four
 * times in a row waits twelve hours rather than five minutes. At most
 * TRACKING_POLL.batchSize provider calls leave per sweep, so a backlog becomes a
 * queue instead of a burst.
 *
 * THE CLAIM IS WHAT MAKES TWO SWEEPS SAFE. A row is claimed with a conditional
 * update before the provider is called, so the loser of a race sees
 * `count === 0` and leaves it alone. A claim left behind by a sweep that died is
 * treated as expired after the lease and the row becomes available again — the
 * same idiom as the job queue's lease, for the same reason.
 *
 * ONE FAILURE DOES NOT STOP THE SWEEP. A provider that refuses one parcel must
 * not prevent the other twenty-four from being polled, so failures are counted
 * and recorded per shipment and the loop continues.
 */
export async function sweepShipmentTracking(
  options: { limit?: number; now?: Date; shipmentIds?: string[] } = {}
): Promise<TrackingSweepSummary> {
  const now = options.now ?? new Date();
  const limit = Math.min(options.limit ?? TRACKING_POLL.batchSize, TRACKING_POLL.batchSize);

  const summary: TrackingSweepSummary = {
    considered: 0,
    polled: 0,
    advanced: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  // The shortest cadence in the vocabulary, so this read never excludes a row
  // that the per-row policy would have called due.
  const stalenessFloor = new Date(now.getTime() - TRACKING_POLL.activeMs);
  const claimExpiry = new Date(now.getTime() - TRACKING_CLAIM_LEASE_MS);

  const candidates = await prisma.shipment.findMany({
    where: {
      ...(options.shipmentIds ? { id: { in: options.shipmentIds } } : {}),
      OR: [{ providerShipmentId: { not: null } }, { trackingNumber: { not: null } }],
      bookingOutcomeUnknownAt: null,
      AND: [
        { OR: [{ lastTrackingSyncAt: null }, { lastTrackingSyncAt: { lt: stalenessFloor } }] },
        // In flight somewhere else, or in flight here and not yet expired.
        { OR: [{ trackingPollClaimedAt: null }, { trackingPollClaimedAt: { lt: claimExpiry } }] },
      ],
    },
    // Oldest first, so a shipment that has been waiting longest goes first and
    // no row starves behind a steady trickle of newer ones.
    orderBy: [{ lastTrackingSyncAt: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      status: true,
      trackingStatus: true,
      providerShipmentId: true,
      trackingNumber: true,
      lastTrackingSyncAt: true,
      lastTrackingAttemptAt: true,
      trackingSyncFailures: true,
      trackingPollClaimedAt: true,
      bookingOutcomeUnknownAt: true,
      packageCount: true,
    },
    take: limit * 4,
  });

  const actor: Actor = {
    actorId: "tracking-sweep",
    actorName: "Tracking sweep",
    actorType: "SYSTEM",
  };

  for (const candidate of candidates) {
    if (summary.polled >= limit) break;
    summary.considered += 1;

    const decision = trackingPollPolicy(candidate as TrackingPollInput, now);
    if (!decision.due) {
      summary.skipped += 1;
      continue;
    }

    // Claim. `updateMany` with the value we read is the whole guard: if another
    // sweep claimed it between the read and here, this matches nothing.
    const claim = await prisma.shipment.updateMany({
      where: {
        id: candidate.id,
        trackingPollClaimedAt: candidate.trackingPollClaimedAt ?? null,
      },
      data: { trackingPollClaimedAt: new Date() },
    });
    if (claim.count === 0) {
      summary.skipped += 1;
      continue;
    }

    summary.polled += 1;
    const before = candidate.trackingStatus;
    try {
      await syncTrackingForShipment(candidate.id, actor);
      const after = await prisma.shipment.findUniqueOrThrow({
        where: { id: candidate.id },
        select: { trackingStatus: true },
      });
      if (after.trackingStatus !== before) summary.advanced += 1;
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({
        shipmentId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Released either way. A claim is a statement about a poll in progress and
      // there is no poll in progress any more; holding it after a failure would
      // make the next sweep wait for the lease instead of the backoff.
      await prisma.shipment.updateMany({
        where: { id: candidate.id },
        data: { trackingPollClaimedAt: null },
      });
    }
  }

  return summary;
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

  // The return leg's rate request keeps its existing shape — the outbound
  // dock is not where a return is collected, and §11's return destination is
  // Phase D's work. Recorded here so the next phase does not have to rediscover
  // that this call still describes the outbound journey.
  const rates = await getReturnQuote(buildRateRequest(order, built.packages, configuredReturnAddress()));

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

  // The return label's destination is the customer's address, which is the
  // order's shipping address — the same address, under the same subject, as the
  // outbound delivery. It is gated for the same reason the outbound one is: a
  // label is a label, and a return to an address nobody checked is the same
  // risk pointing the other way. Only this end: the ship-from is the configured
  // return address, which has no record to validate (see
  // assertDeliveryAddressBookable).
  await assertDeliveryAddressBookable(orderId, "Return booking");

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
    rateRequest: buildRateRequest(order, built.packages, configuredReturnAddress()),
    returnItems,
    returnAddress: configuredReturnAddress(),
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
 * Read back an origin snapshot stored on a shipment.
 *
 * Stored as JSON, so it is validated on the way out rather than trusted: a
 * snapshot written by an older build, or one whose address block is missing,
 * must send the caller to the live location rather than produce a request with
 * blank fields where a street should be.
 */
function snapshotFromStored(raw: unknown): OriginSnapshot | null {
  const value = raw as Partial<OriginSnapshot> | null;
  if (!value || typeof value !== "object") return null;
  if (!value.address || typeof value.address !== "object") return null;
  if (!value.contact || typeof value.contact !== "object") return null;
  if (!value.pickup || typeof value.pickup !== "object") return null;
  return value as OriginSnapshot;
}

/** The origin for a shipment that predates the snapshot, resolved from its lines. */
async function liveOriginForShipment(shipment: {
  id: string;
  items: readonly { orderItemId: string; quantity: number }[];
  order: { items: readonly { id: string; variantId: string | null; sku: string; quantity: number }[] };
}): Promise<{ snapshot: OriginSnapshot; live: true } | null> {
  const origin = await resolveShipmentOrigin(shipment, shipment.order.items);
  if (!origin.ready || !origin.snapshot) return null;
  return { snapshot: origin.snapshot, live: true };
}

/**
 * The collection window a dock's own opening hours imply.
 *
 * Read from the location rather than defaulted, and refused when the hours are
 * not recorded: a window a person typed is a promise about when the door is
 * open, and inventing "09:00-17:00" for a dock nobody has asked is the same
 * class of guess as inventing its address.
 */
function defaultPickupWindow(snapshot: OriginSnapshot): string {
  const open = snapshot.pickup.openTime;
  const close = snapshot.pickup.closeTime;
  if (!open || !close) {
    throw new Error(
      `Pickup location "${snapshot.name}" (${snapshot.code}) has no opening and closing times, ` +
        `so a collection window cannot be derived from it. Enter a window explicitly.`,
    );
  }
  return `${normalizeClock(open)}-${normalizeClock(close)}`;
}

/**
 * The dock's calendar as it stood when the shipment's origin was frozen.
 *
 * A MISSING KEY IS NOT "NO RESTRICTIONS", and it is not "works no days" either.
 * Every snapshot taken before this build lacks these keys entirely; reading a
 * missing `workingDays` as empty would say the dock never works and refuse every
 * date, while reading a missing cutoff as null — which is what it is — says no
 * deadline was configured. So the week falls back to the column's own default,
 * which is what the dock's schedule WAS when the snapshot was written, and the
 * two cutoffs stay null because null is genuinely their unanswered value.
 */
async function scheduleFromSnapshot(snapshot: OriginSnapshot): Promise<LocationSchedule> {
  const pickup = snapshot.pickup as Partial<OriginSnapshot["pickup"]>;
  /*
   * THE DATED EXCEPTIONS ARE READ LIVE, THE REST IS FROZEN.
   *
   * That looks inconsistent and is deliberate. Working days, lead time and the
   * same-day deadline are the dock's STANDING arrangements — how it normally
   * runs — and those are frozen so changing them next month cannot invalidate a
   * collection arranged under them.
   *
   * A dated exception is the opposite kind of fact: it says what will actually
   * happen on one specific day, and a closure recorded this morning is news
   * about a day that has not happened yet. Freezing exceptions at booking time
   * would mean a dock that closes for a power cut on Thursday still gets a truck
   * sent on Thursday, because the label was bought on Monday.
   */
  const exceptions = await prisma.locationHoliday.findMany({
    where: { locationId: snapshot.locationId },
    select: { date: true, kind: true, name: true, openTime: true, closeTime: true },
  });
  return {
    timeZone: pickup.timeZone ?? null,
    workingDays: pickup.workingDays ?? "1,2,3,4,5",
    leadTimeDays: pickup.leadTimeDays ?? null,
    sameDayDeadline: pickup.sameDayDeadline ?? null,
    exceptions,
  };
}

/** Today's date where the dock is, not where the server is. */
function todayAt(timeZone: string | null): string {
  const now = new Date();
  if (!timeZone) return now.toISOString().slice(0, 10);
  try {
    // en-CA renders ISO-ordered dates, which is the form the field uses.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    // An unparseable zone is not a reason to crash a pickup; the server's own
    // date is the honest fallback and the message names the zone it used.
    return now.toISOString().slice(0, 10);
  }
}

function pickupDateProblem(value: string, timeZone: string | null): string | null {
  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return `Pickup date "${value}" is not a date. Use YYYY-MM-DD, interpreted in the pickup location's time zone.`;
  }
  const today = todayAt(timeZone);
  if (date < today) {
    return (
      `Pickup date ${date} has already passed at ${timeZone ? `the pickup location (${timeZone})` : "the pickup location"}` +
      `, where today is ${today}. Choose a date the carrier can still reach.`
    );
  }
  return null;
}

/**
 * The parcels a pickup request describes, from the shipment's frozen packages.
 *
 * The alternative — one parcel weighing nothing — asks a carrier to send a
 * vehicle for an unknown load. A shipment with no package record at all is
 * refused rather than described inaccurately, because the carrier prices and
 * plans a collection on these numbers.
 */
interface PickupParcel {
  count: number;
  weight: number;
  length?: number;
  width?: number;
  height?: number;
}

function pickupPackages(raw: unknown, packageCount: number | null): PickupParcel[] {
  const rows: unknown[] = Array.isArray(raw) ? raw : [];
  const dimension = (input: unknown): number | undefined => {
    const number = Number(input);
    return Number.isFinite(number) && number > 0 ? number : undefined;
  };

  const parsed: PickupParcel[] = [];
  for (const row of rows) {
    const value = (row ?? {}) as {
      count?: number;
      length?: number;
      width?: number;
      height?: number;
      weight?: number;
    };
    const weight = Number(value.weight);
    // A parcel with no usable weight is dropped rather than sent as zero: the
    // carrier plans a vehicle on these numbers.
    if (!Number.isFinite(weight) || weight <= 0) continue;
    parsed.push({
      count: Math.max(1, Math.floor(Number(value.count) || 1)),
      weight,
      length: dimension(value.length),
      width: dimension(value.width),
      height: dimension(value.height),
    });
  }

  if (parsed.length === 0) {
    throw new Error(
      `This shipment has no package record with weights, so a collection cannot be described to the carrier. ` +
        `A pickup request that says "no parcels" or "zero weight" asks a carrier to send a vehicle for an unknown load. ` +
        `Re-pack the shipment with its parcels before arranging collection` +
        (packageCount ? ` (it currently records ${packageCount} package(s))` : "") +
        `.`,
    );
  }
  return parsed;
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
  data: {
    pickupDate: string;
    pickupTimeWindow?: string;
    notes?: string;
    oneOffAtRegularDock?: boolean;
    /**
     * Step over the dock's own calendar for this one date.
     *
     * Offered for the cases the calendar cannot know — a dock opening specially,
     * or a date the carrier has already agreed. Recorded on the audit entry with
     * the reasons it overrode, so the exception is a fact on the record rather
     * than a rule somebody learned to work around.
     */
    overrideClosedDay?: boolean;
  },
  actor: Actor
): Promise<PickupResult & { pickupStatus: string }> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { items: true, order: { include: { items: true } }, originLocation: true },
  });
  if (!shipment) throw new Error("Shipment not found.");
  if (!shipment.providerShipmentId) {
    throw new Error("Book the shipment before scheduling a pickup — there is nothing for the carrier to collect yet.");
  }

  /*
   * WHERE THE TRUCK GOES, AND WHICH TRUCK. The address comes from the shipment's
   * frozen origin — the one the label was bought against — so a later correction
   * to the dock's record cannot send a driver somewhere the carrier was never
   * told about. A shipment booked before origins reached this path has no
   * snapshot; that case re-resolves the origin from its own lines rather than
   * reaching for a global address, and says so in the audit entry.
   */
  const stored = snapshotFromStored(shipment.originSnapshot);
  const origin = stored
    ? { snapshot: stored, live: false as const }
    : await liveOriginForShipment(shipment);
  if (!origin) {
    throw new Error(
      "Pickup location required. This shipment has no collection address — the label was bought " +
        "before an origin was recorded and its items no longer resolve to one. Map a pickup " +
        "location before arranging collection.",
    );
  }
  const from = carrierShipFrom(origin.snapshot);

  const mode = shipment.pickupMode ?? shipment.originLocation?.pickupMode ?? "NEEDED";
  if (mode === "DROPOFF") {
    throw new Error(
      `${origin.snapshot.name} is a drop-off location: parcels are handed in at the carrier's depot, ` +
        `so there is nothing to collect. Nothing was scheduled — book the collection at the depot instead.`,
    );
  }
  if (mode === "REGULAR" && !data.oneOffAtRegularDock) {
    throw new Error(
      `${origin.snapshot.name} already has a regular collection, so a truck is expected there anyway. ` +
        `Confirm a one-off collection explicitly if this parcel will not be ready for it — booking a ` +
        `second pickup for the same door is how two drivers arrive for one parcel.`,
    );
  }
  if (shipment.pickupStatus === "SCHEDULED" && shipment.providerPickupId) {
    throw new Error(
      `A pickup is already scheduled for this shipment` +
        (shipment.pickupScheduledFor ? ` on ${shipment.pickupScheduledFor.toISOString().slice(0, 10)}` : "") +
        `. Cancel it before scheduling another.`,
    );
  }

  const requestedAt = new Date();
  const window = data.pickupTimeWindow?.trim() || defaultPickupWindow(origin.snapshot);
  const dateProblem = pickupDateProblem(data.pickupDate, origin.snapshot.pickup.timeZone);
  if (dateProblem) throw new Error(dateProblem);

  /*
   * THE DOCK'S OWN CALENDAR, APPLIED BEFORE THE CARRIER IS ASKED.
   *
   * A date is checked against the same proposal the page offers. Refusing a
   * closed day here rather than only hiding it on screen is the point: the form
   * is a convenience and the request is the fact, and a date posted by hand — or
   * by a page open since yesterday — must not put a truck outside a locked gate.
   *
   * THE OVERRIDE EXISTS BECAUSE THE SYSTEM DOES NOT KNOW EVERYTHING. A dock can
   * open specially for one collection, or a carrier can have agreed a date this
   * calendar excludes; refusing that outright would make the rule an obstacle
   * rather than a guard. So the check can be stepped over — deliberately, with
   * the reason recorded on the audit entry — and never silently.
   *
   * The whole schedule is judged from the SHIPMENT'S FROZEN ORIGIN, so a dock
   * whose hours were changed after the label was bought does not retroactively
   * make a legitimate request invalid.
   */
  const schedule = await scheduleFromSnapshot(origin.snapshot);
  const reasons = pickupDateReasons(data.pickupDate, schedule, requestedAt);
  if (reasons.length > 0 && !data.overrideClosedDay) {
    const next = proposePickupDates(schedule, requestedAt, {
      count: 1,
      standing: { open: origin.snapshot.pickup.openTime, close: origin.snapshot.pickup.closeTime },
    });
    throw new Error(
      `${origin.snapshot.name} cannot be collected from on ${data.pickupDate}: ${reasons.join("; ")}. ` +
        `The next date this dock's calendar allows is ${next.days[0]?.date ?? `more than ${MAX_PROPOSAL_SCAN} days away`}. ` +
        `${CARRIER_AVAILABILITY_CAVEAT} ` +
        `If the dock is opening specially for this collection, or the carrier has already agreed the date, ` +
        `confirm it as an exception and the reason will be recorded.`,
    );
  }

  let booking: PickupResult;
  try {
    booking = await schedulePickup({
      shipFrom: {
        name: from.name,
        address: from.address,
        city: from.city,
        province: from.province,
        postalCode: from.postalCode,
        country: from.country,
        ...(from.phone ? { phone: from.phone } : {}),
        ...(from.email ? { email: from.email } : {}),
      },
      pickupDate: data.pickupDate,
      pickupTimeWindow: window,
      // The parcels the label was bought for, with their real weights. A pickup
      // request that says "one parcel, 0 kg" asks a carrier to send a vehicle
      // for an unknown load, which is the kind of detail that comes back as a
      // refused collection rather than as an error.
      packages: pickupPackages(shipment.packageSnapshot, shipment.packageCount),
      notes: [origin.snapshot.pickup.instructions, data.notes].filter(Boolean).join(" — ") || undefined,
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
      /*
       * An override is written down, with what it overrode. A collection on a
       * day this dock's calendar excludes is either a real arrangement or a
       * mistake, and the only way anyone can tell which later is if the reasons
       * the system gave are kept beside the decision to proceed.
       */
      ...(reasons.length > 0
        ? { overrodeCalendar: true, overrodeReasons: reasons.join("; ") }
        : {}),
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return { ...booking, pickupStatus: updated.pickupStatus ?? "SCHEDULED" };
}

export interface ShipmentPickupPlan {
  /** The dock the plan was computed for, or null when the shipment has no origin. */
  origin: { name: string; code: string; timeZone: string | null } | null;
  /** The dates that may be asked for, soonest first. Empty when there is no origin. */
  days: {
    date: string;
    /** The window on that date, from the dock's hours and any special hours. */
    window: { open: string | null; close: string | null } | null;
    /** The earliest instant a carrier may be asked to come. Sent as an ISO string. */
    availableFrom: string;
  }[];
  /** Why each sooner date was not offered, so the page can explain the gap. */
  excluded: { date: string; reasons: string[] }[];
  /** The dock's own local date and time when this was worked out. */
  localNow: { date: string; time: string } | null;
  /** The window this dock's standing hours imply, for pre-filling the field. */
  suggestedWindow: string | null;
  /** Set when the dock could not be proposed to at all, with the reason. */
  problem: string | null;
  caveat: string;
  /** True when the plan came from the shipment's frozen origin rather than the live dock. */
  fromSnapshot: boolean;
}

/**
 * The dates this shipment may actually be collected on, and why not the others.
 *
 * READ BY THE PAGE, ENFORCED BY `schedulePickupForShipment`. Both go through
 * `pickupDateReasons`, so a date offered here is a date the booking accepts;
 * anything else would be a page that invites an action the server then refuses.
 *
 * Nothing here asserts that a CARRIER will come — see `CARRIER_AVAILABILITY_CAVEAT`,
 * which travels with the plan and is printed under it. This is one dock's opening
 * calendar and nothing more.
 */
export async function pickupPlanForShipment(shipmentId: string): Promise<ShipmentPickupPlan> {
  const empty: ShipmentPickupPlan = {
    origin: null,
    days: [],
    excluded: [],
    localNow: null,
    suggestedWindow: null,
    problem: null,
    caveat: CARRIER_AVAILABILITY_CAVEAT,
    fromSnapshot: true,
  };

  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { items: true, order: { include: { items: true } } },
  });
  if (!shipment) return empty;

  const stored = snapshotFromStored(shipment.originSnapshot);
  const origin = stored ? { snapshot: stored, live: false as const } : await liveOriginForShipment(shipment);
  if (!origin) return empty;

  const schedule = await scheduleFromSnapshot(origin.snapshot);
  const standing = { open: origin.snapshot.pickup.openTime, close: origin.snapshot.pickup.closeTime };
  const problem = scheduleProblem(schedule);
  const now = new Date();
  const proposal = proposePickupDates(schedule, now, { count: 8, standing });

  // The window the form starts with. Only when both ends are recorded: half a
  // window is not a window, and the field is left for the operator to fill.
  const suggestedWindow =
    standing.open && standing.close
      ? `${normalizeClock(standing.open)}-${normalizeClock(standing.close)}`
      : null;

  return {
    origin: {
      name: origin.snapshot.name,
      code: origin.snapshot.code,
      timeZone: origin.snapshot.pickup.timeZone ?? null,
    },
    days: proposal.days.map((day) => ({
      date: day.date,
      window: day.window,
      availableFrom: day.availableFrom.toISOString(),
    })),
    excluded: proposal.excluded,
    localNow: proposal.localNow,
    suggestedWindow,
    problem,
    caveat: proposal.caveat,
    fromSnapshot: !origin.live,
  };
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