import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { setIntegrationState } from "./integrationHealth.server";
import { getRates, bookShipment, cancelShipment, eshipperMode, type RateRequest, trackByOrderId, trackByTrackingNumber, bulkTrack, getLabel, getOrderDetails, getCustomsInvoice, getReturnQuote, bookReturn, getReturn, schedulePickup, cancelPickup, type TrackingResult, type ReturnQuote, type ReturnBookingResult, type ReturnDetails, type PickupResult } from "./eshipper.server";
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

  await prisma.shippingQuote.deleteMany({ where: { orderId, selected: false } });
  await prisma.$transaction(
    rates.map((r) =>
      prisma.shippingQuote.create({
        data: {
          orderId,
          provider: "eshipper",
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
    afterData: { count: rates.length, mode: eshipperMode() },
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

/**
 * Book a shipment. Blocked until wholesale payment has SUCCEEDED. Idempotent:
 * a booking key prevents a second purchase on double-click/timeouts, and an
 * existing shipment with a provider id is returned instead of re-booking.
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
    for (const si of s.items) {
      shipped[si.orderItemId] = (shipped[si.orderItemId] || 0) + si.quantity;
    }
  }
  const toShip = order.items
    .map((i) => {
      const remaining = i.quantity - (shipped[i.id] || 0);
      const requested = opts.quantities?.[i.id];
      const qty = requested === undefined ? remaining : Math.min(requested, remaining);
      return { orderItemId: i.id, quantity: qty };
    })
    .filter((i) => i.quantity > 0);

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
        serviceName: quote.serviceName,
        bookedCost: quote.totalAmount,
        packageCount: order.packages.reduce((s, p) => s + p.count, 0),
        items: { create: toShip.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })) },
      },
    });
  } catch {
    const existing = await prisma.shipment.findUnique({ where: { bookingIdempotencyKey: bookingKey } });
    if (existing) return { shipment: existing, sync: { pushed: false, reason: "duplicate_request" } };
    throw new Error("Could not create shipment booking record.");
  }

  try {
    const booking = await bookShipment({
      quote: { carrier: quote.carrier, serviceCode: quote.serviceCode, serviceName: quote.serviceName },
      rateRequest: buildRateRequest(order, order.packages),
    });

    const updated = await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        providerShipmentId: booking.providerShipmentId,
        carrier: booking.carrier,
        serviceName: booking.serviceName,
        trackingNumber: booking.trackingNumber,
        trackingUrl: booking.trackingUrl,
        labelUrl: booking.labelUrl,
        bookedCost: booking.bookedCost || quote.totalAmount,
        labelCreatedAt: new Date(),
      },
    });

    await setIntegrationState("eshipper", {
      status: eshipperMode() === "real" ? "HEALTHY" : "NOT_CONFIGURED",
      detail:
        eshipperMode() === "real"
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
        cost: booking.bookedCost,
        carrierCost: quote.totalAmount,
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });

    // Tracking is synced separately so a Shopify failure does not lose the booking.
    const sync = await syncShipmentTracking(updated.id, actor);
    return { shipment: updated, sync };
  } catch (error) {
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        status: "EXCEPTION",
        exceptionAt: new Date(),
      },
    });
    await setIntegrationState("eshipper", {
      status: "FAILED",
      error: error instanceof Error ? error.message : "booking failed",
    });
    // Payment remains SUCCEEDED; the order stays eligible for a safe re-book.
    throw new Error(
      `Booking failed after payment: ${error instanceof Error ? error.message : "unknown"}. ` +
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

export async function voidShipment(shipmentId: string, actor: Actor) {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");
  if (!shipment.providerShipmentId) throw new Error("No provider shipment to cancel.");
  const result = await cancelShipment(shipment.providerShipmentId);
  await prisma.shipment.update({
    where: { id: shipmentId },
    data: { status: "CANCELLED" },
  });
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.cancelled",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: { cancelled: result.cancelled },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return result;
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
    afterData: { labelUrl: label.labelUrl },
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
    afterData: { customsInvoiceUrl: invoice.customsInvoiceUrl },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return invoice;
}

export async function syncTrackingByOrderId(shipmentId: string, actor: Actor): Promise<TrackingResult> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { order: { include: { seller: true } } },
  });
  if (!shipment) throw new Error("Shipment not found.");
  if (!shipment.providerShipmentId) throw new Error("No provider shipment ID.");

  const tracking = await trackByOrderId(shipment.providerShipmentId);

  await prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      trackingNumber: tracking.trackingDetails[0]?.description?.includes("tracking") ? shipment.trackingNumber : shipment.trackingNumber,
      trackingUrl: tracking.trackingUrl,
      status: tracking.delivered ? "DELIVERED" : tracking.exception ? "EXCEPTION" : tracking.inTransit ? "SHIPPED" : tracking.pickup ? "SHIPPED" : "PENDING",
    },
  });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.tracking_synced",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: { trackingUrl: tracking.trackingUrl, events: tracking.trackingDetails.length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return tracking;
}

export async function syncTrackingByTrackingNumber(shipmentId: string, trackingNumber: string, actor: Actor): Promise<TrackingResult> {
  const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");

  const tracking = await trackByTrackingNumber(trackingNumber);

  await prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      trackingNumber,
      trackingUrl: tracking.trackingUrl,
      status: tracking.delivered ? "DELIVERED" : tracking.exception ? "EXCEPTION" : tracking.inTransit ? "SHIPPED" : tracking.pickup ? "SHIPPED" : "PENDING",
    },
  });

  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.tracking_synced",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: shipmentId,
    afterData: { trackingUrl: tracking.trackingUrl, events: tracking.trackingDetails.length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return tracking;
}

export async function bulkSyncTracking(trackingNumbers: string[], actor: Actor): Promise<{ results: TrackingResult[] }> {
  const results = await bulkTrack(trackingNumbers);
  await recordAudit({
    actorType: "ADMIN_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action: "shipping.bulk_tracking_synced",
    entityType: AUDIT_ENTITY.SHIPMENT,
    entityId: "bulk",
    afterData: { count: results.results.length },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
  return results;
}

export async function getReturnQuotesForOrder(orderId: string, actor: Actor): Promise<ReturnQuote[]> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, packages: true },
  });
  if (!order) throw new Error("Order not found.");

  const { buildQuotePackagesForOrder } = await import("./packaging.server");
  const built = await buildQuotePackagesForOrder({
    items: order.items.map((i) => ({ sku: i.sku, quantity: i.quantity, variantId: i.variantId })),
    packages: order.packages,
  });
  if (built.missing.length > 0) {
    throw new Error(`Packaging incomplete for return: ${built.missing.join(", ")}`);
  }

  const request = buildRateRequest(order, built.packages);
  const rates = await getReturnQuote(request);

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

  return rates;
}

export async function bookReturnForOrder(
  orderId: string,
  opts: { quoteId: string; returnItems: { orderItemId: string; quantity: number }[]; returnAddress: { name: string; address: string; city: string; province: string; postalCode: string; country: string } },
  actor: Actor
): Promise<ReturnBookingResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, packages: true, shipments: { include: { items: true } } },
  });
  if (!order) throw new Error("Order not found.");

  const quote = await prisma.shippingQuote.findUnique({ where: { id: opts.quoteId } });
  if (!quote) throw new Error("Return quote not found.");

  const { buildQuotePackagesForOrder } = await import("./packaging.server");
  const built = await buildQuotePackagesForOrder({
    items: order.items.map((i) => ({ sku: i.sku, quantity: i.quantity, variantId: i.variantId })),
    packages: order.packages,
  });

  const request = buildRateRequest(order, built.packages);
  const returnItems = opts.returnItems.map((ri) => {
    const item = order.items.find((i) => i.id === ri.orderItemId);
    return { sku: item?.sku ?? "", quantity: ri.quantity };
  });

  const booking = await bookReturn({
    quote: { carrier: quote.carrier, serviceCode: quote.serviceCode, serviceName: quote.serviceName },
    rateRequest: request,
    returnItems,
    returnAddress: opts.returnAddress,
  });

  const shipment = await prisma.shipment.create({
    data: {
      orderId,
      status: "PENDING",
      provider: "eshipper",
      carrier: booking.carrier,
      serviceName: booking.serviceName,
      trackingNumber: booking.trackingNumber,
      trackingUrl: booking.trackingUrl,
      labelUrl: booking.labelUrl,
      bookedCost: booking.bookedCost,
      packageCount: 1,
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
    afterData: { providerReturnId: booking.providerReturnId, trackingNumber: booking.trackingNumber, cost: booking.bookedCost },
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
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { order: { include: { seller: true } } },
  });
  if (!shipment) throw new Error("Shipment not found.");

  const shipFrom = {
    name: process.env.MOONVELLA_SHIP_FROM_NAME || "MoonVella",
    address: process.env.MOONVELLA_SHIP_FROM_ADDRESS || "1 Warehouse Way",
    city: process.env.MOONVELLA_SHIP_FROM_CITY || "Toronto",
    province: process.env.MOONVELLA_SHIP_FROM_PROVINCE || "ON",
    postalCode: process.env.MOONVELLA_SHIP_FROM_POSTAL || "M5H 2N2",
    country: process.env.MOONVELLA_SHIP_FROM_COUNTRY || "CA",
    phone: process.env.MOONVELLA_SHIP_FROM_PHONE,
    email: process.env.MOONVELLA_SHIP_FROM_EMAIL,
  };

  const booking = await schedulePickup({
    shipFrom,
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

export async function cancelPickupForShipment(shipmentId: string, pickupId: string, actor: Actor): Promise<{ cancelled: boolean }> {
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

export async function getBillingReconciliation(shipmentId: string) {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { order: { include: { seller: true } } },
  });
  if (!shipment) throw new Error("Shipment not found.");

  const quotes = await prisma.shippingQuote.findMany({ where: { orderId: shipment.orderId } });
  const selectedQuote = quotes.find((q) => q.selected) ?? quotes[0];

  return {
    shipmentId: shipment.id,
    providerShipmentId: shipment.providerShipmentId,
    sellerShippingCharge: shipment.order.moonvellaShipping,
    quotedCarrierCost: selectedQuote?.totalAmount ?? 0,
    bookedCarrierCost: shipment.bookedCost ?? 0,
    finalBilledCarrierCost: null,
    margin: (shipment.order.moonvellaShipping || 0) - (shipment.bookedCost ?? 0),
    status: "pending",
  };
}
