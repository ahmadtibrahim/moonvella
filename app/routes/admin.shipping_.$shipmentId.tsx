import { Link, Form, useLoaderData, useActionData, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import {
  getQuotesForOrder,
  selectQuote,
  bookPreparedShipment,
  reconcileBookingOutcome,
  resolveUnknownBooking,
  getShipmentLabel,
  getShipmentOrderDetails,
  getShipmentCustomsInvoice,
  syncTrackingForShipment,
  syncShipmentTracking,
  voidShipment,
  getReturnQuotesForOrder,
  bookReturnForOrder,
  schedulePickupForShipment,
  cancelPickupForShipment,
  pickupPlanForShipment,
  getBillingReconciliation,
  reconcileCarrierInvoice,
  packagesForShipment,
  recipientPhoneFor,
  resolveShipmentOrigin,
} from "~/services/shipping.server";
import { orderProgress } from "~/services/orderProgress.server";
import type { ProgressStage } from "~/services/orderProgress.server";
import { BookingConfirmation } from "~/components/BookingConfirmation";
import { ShippingOperationsNav } from "~/components/ShippingOperationsNav";
import type { BookingEnvironment } from "~/components/BookingConfirmation";
import { OrderProgress, stageByKey } from "~/components/OrderProgress";
import { RateSelection } from "~/components/RateSelection";
import { recordAudit, AUDIT_ENTITY } from "~/services/audit.server";
// The window form's rule, from the client-safe module: both ends or neither,
// shaped and in order. Shared with the pickup-location form so the two agree on
// what a window is.
import { readCarrierWindow } from "~/utils/originFields";
// Display-only helpers, imported from the isomorphic module: this route renders
// them, so pulling them from shipping.server would drag server code into the
// client bundle and fail the build.
import {
  trackingLabel,
  trackingDisplay,
  trackingDisplayLabel,
  pickCheapestQuote,
  type TrackingDisplayStatus,
} from "~/services/shippingLogic";
import {
  advanceShipment,
  type ShipmentAdvanceEvent,
} from "~/services/fulfillment.server";
import {
  describeEshipperStatus,
  eshipperStatus,
  RETURN_PURCHASING_ENABLED,
  RETURN_PURCHASING_DISABLED_REASON,
} from "~/services/eshipper.server";
import { getIntegrationState } from "~/services/integrationHealth.server";
import { getUnitsPreference } from "~/services/adminPreferences.server";
import { convertedDisplay, unitsView } from "~/utils/measurementUnits";
import { MAX_PROPOSAL_SCAN } from "~/services/holidays";
import {
  createReturnRequest,
  createShippingClaim,
} from "~/services/shippingOperations.server";
import type { ReturnShippingPayer, ShippingClaimType } from "@prisma/client";

/*
 * THE TWO EVENTS AN OPERATOR CAN WITNESS.
 *
 * Packing a carton and handing it to a driver happen in front of a person, so
 * an operator may record them. Everything after that — the carrier's own scans,
 * delivery, an exception — arrives through tracking sync from the carrier's
 * record, and typing one in by hand would be recording a fact nobody here
 * observed. Both the form and the action check this list, so a hand-made
 * request cannot write a later status either.
 */
const ADVANCE_EVENTS: ShipmentAdvanceEvent[] = ["packed", "handed_to_carrier"];

/*
 * Where the cartons this shipment will be labelled with came from, said the way
 * the card has to say it. The three answers are the three branches of
 * `packagesForShipment`, in its own order, so an operator told "from the order's
 * parcel rows" knows which record to correct.
 */
const SHIPMENT_PARCEL_SOURCE: Record<"linked" | "derived" | "order", string> = {
  linked: "from the cartons assigned to this box on the packing page",
  order: "from the parcel rows recorded for this order in the packing workspace",
  derived: "from the packaging stored on the ordered variants and products",
};

function parseAddress(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** The dock a shipment collects from, flattened for display. */
interface OriginView {
  code: string;
  name: string;
  addressLines: string[];
  contact: string | null;
  /** The dock's own opening hours, in the dock's own words. */
  pickupLine: string | null;
  instructions: string | null;
  /** True when these are the facts frozen at quotation, not today's row. */
  frozen: boolean;
}

function nonEmpty(values: (string | null | undefined)[]): string[] {
  return values.map((v) => (v ?? "").trim()).filter(Boolean);
}

/**
 * Where this parcel collects from, preferring the shipped-with facts.
 *
 * The snapshot wins once it exists: it is what was quoted and booked, and a dock
 * that was edited afterwards must not retroactively rewrite the page for a
 * parcel already on a truck. The live row answers for a shipment that has no
 * snapshot yet. Neither being present returns null, and the caller says
 * "Pickup location required" rather than borrowing an address — §1's rule, and
 * the reason this replaced a card that printed MOONVELLA_SHIP_FROM_* with a
 * "1 Warehouse Way" default under a heading that read like a fact.
 */
function originView(shipment: {
  originSnapshot: unknown;
  originLocation: {
    code: string;
    name: string;
    street1: string | null;
    street2: string | null;
    city: string | null;
    province: string | null;
    postalCode: string | null;
    country: string | null;
    contactName: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    timeZone: string | null;
    pickupOpenTime: string | null;
    pickupCloseTime: string | null;
    instructions: string | null;
  } | null;
}): OriginView | null {
  const snapshot = shipment.originSnapshot as {
    code?: unknown;
    name?: unknown;
    address?: Record<string, unknown>;
    contact?: Record<string, unknown>;
    pickup?: Record<string, unknown>;
  } | null;

  if (snapshot && typeof snapshot === "object" && typeof snapshot.code === "string") {
    const address = (snapshot.address ?? {}) as Record<string, unknown>;
    const contact = (snapshot.contact ?? {}) as Record<string, unknown>;
    const pickup = (snapshot.pickup ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
    const open = text(pickup.openTime);
    const close = text(pickup.closeTime);
    const zone = text(pickup.timeZone);
    return {
      code: snapshot.code,
      name: text(snapshot.name) || snapshot.code,
      addressLines: nonEmpty([
        text(address.street1),
        text(address.street2),
        [text(address.city), text(address.province), text(address.postalCode)].filter(Boolean).join(", "),
        text(address.country),
      ]),
      contact: nonEmpty([text(contact.name), text(contact.phone), text(contact.email)]).join(" · ") || null,
      pickupLine: open && close ? `${open}–${close}${zone ? ` (${zone})` : ""}` : null,
      instructions: text(pickup.instructions) || null,
      frozen: true,
    };
  }

  const live = shipment.originLocation;
  if (!live) return null;
  return {
    code: live.code,
    name: live.name,
    addressLines: nonEmpty([
      live.street1,
      live.street2,
      [live.city, live.province, live.postalCode].filter(Boolean).join(", "),
      live.country,
    ]),
    contact: nonEmpty([live.contactName, live.contactPhone, live.contactEmail]).join(" · ") || null,
    pickupLine: live.pickupOpenTime && live.pickupCloseTime ? `${live.pickupOpenTime}–${live.pickupCloseTime}${live.timeZone ? ` (${live.timeZone})` : ""}` : null,
    instructions: live.instructions,
    frozen: false,
  };
}

/** Colors for the normalized tracking word, matching the shipments list. */
const trackingDisplayColor: Record<TrackingDisplayStatus, string> = {
  BOOKED: "#0369a1",
  PICKED_UP: "#0369a1",
  IN_TRANSIT: "#0369a1",
  OUT_FOR_DELIVERY: "#b45309",
  DELIVERED: "#059669",
  EXCEPTION: "#dc2626",
  CANCELLED: "#64748b",
  RETURNED: "#b45309",
  UNKNOWN: "#64748b",
};

/** How a parcel is meant to leave the dock, in an operator's words. */
const PICKUP_MODE_LABEL: Record<string, string> = {
  NEEDED: "Pickup needed",
  REGULAR: "Regular pickup (standing collection)",
  DROPOFF: "Drop-off at the carrier",
};

const RETURN_PAYERS: ReturnShippingPayer[] = ["UNDECIDED", "MOONVELLA", "SELLER", "CUSTOMER", "CARRIER"];
const CLAIM_TYPES: ShippingClaimType[] = ["LOST", "DAMAGED", "SHORTAGE", "DELIVERY_ISSUE", "OTHER"];

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requirePermission(request, "shipping.view");
  const shipmentId = String(params.shipmentId);
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      items: { include: { orderItem: true } },
      trackingEvents: { orderBy: { eventAt: "desc" }, take: 50 },
      returnRequests: {
        orderBy: { createdAt: "desc" },
        include: { items: { include: { orderItem: true } } },
      },
      shippingClaims: { orderBy: { createdAt: "desc" } },
      // The dock, for the Ship from card. The shipment's own snapshot is read
      // from a scalar column; this is the fallback for a parcel that has not
      // been quoted or booked yet.
      originLocation: true,
      order: {
        include: {
          seller: true,
          items: true,
          packages: { orderBy: { createdAt: "asc" } },
        },
      },
    },
  });
  if (!shipment) throw new Response("Shipment not found", { status: 404 });

  const order = shipment.order;

  // Remaining quantity available to fulfil, counting every other non-cancelled
  // shipment so a partial order cannot be over-shipped.
  const others = await prisma.shipment.findMany({
    where: { orderId: order.id, id: { not: shipment.id }, status: { not: "CANCELLED" } },
    include: { items: true },
  });
  const allocated: Record<string, number> = {};
  for (const s of others) {
    for (const si of s.items) allocated[si.orderItemId] = (allocated[si.orderItemId] || 0) + si.quantity;
  }
  const items = order.items.map((i) => ({
    id: i.id,
    name: i.name,
    sku: i.sku,
    ordered: i.quantity,
    inThisShipment: shipment.items.find((si) => si.orderItemId === i.id)?.quantity ?? 0,
    remaining: i.quantity - (allocated[i.id] || 0),
  }));

  const [quotes, returnQuotes, billing, eshipper, shopifyFulfillment, pickupPlan] = await Promise.all([
    /*
     * The dock comes with the rate, because it is half of what makes it
     * bookable: the selection dialog prints which location priced each line and
     * refuses a rate priced anywhere else.
     */
    prisma.shippingQuote.findMany({
      where: { orderId: order.id, provider: "eshipper" },
      orderBy: { totalAmount: "asc" },
      include: { originLocation: { select: { code: true, name: true } } },
    }),
    prisma.shippingQuote.findMany({ where: { orderId: order.id, provider: "eshipper-return" }, orderBy: { totalAmount: "asc" } }),
    getBillingReconciliation(shipmentId),
    getIntegrationState("eshipper"),
    getIntegrationState("shopify_fulfillment"),
    /*
     * WHICH DATES A TRUCK MAY BE ASKED FOR. Computed here rather than in the
     * component because the component also runs in the browser, where the clock
     * is the reader's and not the dock's — a proposal computed there would offer
     * one person a different set of dates from another, and neither would match
     * what the action accepts.
     */
    pickupPlanForShipment(shipmentId),
  ]);

  /*
   * The environment eShipper calls actually reach, resolved once.
   *
   * A host, not a boolean: `eshipperMode()` collapses a test host and a live one
   * into the same word when a credential is present, and this deployment reads
   * its settings from an encrypted store that can point anywhere.
   */
  const status = await eshipperStatus();

  const selectedQuote = quotes.find((q) => q.selected) ?? null;

  /*
   * WHICH DOCKS A RATE MAY BE PRICED FROM, resolved with the same function the
   * booking gate uses, so the selection dialog refuses exactly the rows the
   * booking would refuse. A shipment holds the lines it holds, so this answers
   * "where do THESE parcels leave from" — the reason a two-dock order can ship
   * at all.
   */
  const resolvedDock = await resolveShipmentOrigin(
    { id: shipment.id, items: shipment.items.map((si) => ({ orderItemId: si.orderItemId, quantity: si.quantity })) },
    order.items.map((i) => ({ id: i.id, variantId: i.variantId, sku: i.sku, quantity: i.quantity })),
  );
  const dockIds = resolvedDock.groups.map((group) => group.locationId).filter((id): id is string => id !== null);

  /*
   * The clock the rate dialog reads expiry against, fixed here rather than in
   * the component: a browser's clock is the reader's, and a rate that reads
   * live on one screen and expired on another is a discrepancy nobody can act
   * on. The service's own check is the authority; this is the same reading.
   */
  const now = Date.now();

  /*
   * The admin's unit preference, for reading a parcel's stored centimetres and
   * kilograms back in the unit the operator is working in. The stored values do
   * not move: this is the same conversion the packaging editors do, on a value
   * whose own unit is fixed.
   */
  const units = unitsView(await getUnitsPreference());

  /*
   * The cartons this booking would actually declare, resolved by the same
   * function the booking itself uses.
   *
   * The confirmation screen's job is to show what is about to be bought, and
   * "the parcels" is the part an operator cannot check anywhere else: the box
   * list on the order is what was QUOTED, and the shipment's own assigned
   * cartons are what will be LABELLED. Resolving here rather than in the
   * component means the screen and the booking cannot disagree, and it is a
   * read — nothing is reserved, created or sent.
   */
  const bookingParcels = await packagesForShipment(
    { id: shipment.id, items: shipment.items.map((si) => ({ orderItemId: si.orderItemId, quantity: si.quantity })) },
    order,
  );

  return {
    units,
    bookingParcels: {
      packages: bookingParcels.packages.map((p) => ({
        count: p.count,
        length: p.length,
        width: p.width,
        height: p.height,
        weight: p.weight,
        units: p.units,
      })),
      source: bookingParcels.source,
      notes: bookingParcels.notes,
      missing: bookingParcels.missing,
    },
    shipment: {
      id: shipment.id,
      reference: shipment.id.slice(0, 8),
      status: shipment.status,
      trackingStatus: shipment.trackingStatus,
      carrier: shipment.carrier,
      serviceCode: shipment.serviceCode,
      serviceName: shipment.serviceName,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl,
      labelUrl: shipment.labelUrl,
      labelDocumentFormat: shipment.labelDocumentFormat,
      providerShipmentId: shipment.providerShipmentId,
      sellerShippingCharge: shipment.sellerShippingCharge,
      quotedCarrierCost: shipment.quotedCarrierCost,
      bookedCost: shipment.bookedCost,
      finalBilledCost: shipment.finalBilledCost,
      billingStatus: shipment.billingStatus,
      providerInvoiceNumber: shipment.providerInvoiceNumber,
      estimatedDelivery: shipment.estimatedDelivery,
      lastTrackingSyncAt: shipment.lastTrackingSyncAt,
      lastTrackingError: shipment.lastTrackingError,
      trackingSyncFailures: shipment.trackingSyncFailures,
      // Kept out of the list page's own wording: these two are what an operator
      // reads to decide whether the Shopify push needs retrying, and they are
      // per-shipment facts that the integration row cannot answer for.
      shopifySyncedAt: shipment.shopifySyncedAt,
      shopifySyncError: shipment.shopifySyncError,
      shopifyNotifiedAt: shipment.shopifyNotifiedAt,
      returnOfShipmentId: shipment.returnOfShipmentId,
      returnReason: shipment.returnReason,
      packageCount: shipment.packageCount,
      createdAt: shipment.createdAt,
      labelCreatedAt: shipment.labelCreatedAt,
      shopifyFulfillmentId: shipment.shopifyFulfillmentId,
      bookingAttemptedAt: shipment.bookingAttemptedAt,
      bookingOutcomeUnknownAt: shipment.bookingOutcomeUnknownAt,
      lastBookingError: shipment.lastBookingError,
      pickupStatus: shipment.pickupStatus,
      pickupMode: shipment.pickupMode,
      /*
       * What the collection gate will actually apply: the shipment's own mode,
       * or the dock's when the shipment predates the mapping — the same
       * fallback `schedulePickupForShipment` uses — or NEEDED when neither
       * exists. The form below has to agree with the gate that refuses it, so
       * it reads the gate's own resolution rather than the raw column.
       */
      resolvedPickupMode: shipment.pickupMode ?? shipment.originLocation?.pickupMode ?? "NEEDED",
      providerPickupId: shipment.providerPickupId,
      pickupScheduledFor: shipment.pickupScheduledFor,
      pickupWindow: shipment.pickupWindow,
      pickupConfirmation: shipment.pickupConfirmation,
      pickupLastError: shipment.pickupLastError,
      // The customer-notification answer given on the confirmation screen, and
      // the default the dispatch push will use. Shown on the dispatch control so
      // the operator can see a choice they made earlier rather than being asked
      // the same question again with no memory of it.
      notifyCustomerOnPush: shipment.notifyCustomerOnPush,
      // The two warehouse facts an operator may witness and record. Everything
      // after them is the carrier's own scan, arriving through tracking sync —
      // which is why the dispatch control offers exactly these two and reads
      // its state from these two timestamps.
      packedAt: shipment.packedAt,
      handedToCarrierAt: shipment.handedToCarrierAt,
      // The note that will print on this box's packing slip, if there is one.
      packingSlipMessage: shipment.packingSlipMessage,
    },
    order: {
      id: order.id,
      shopifyOrderName: order.shopifyOrderName,
      supplierReference: order.supplierReference,
      currency: order.currency,
      wholesalePaymentStatus: order.wholesalePaymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      moonvellaShipping: order.moonvellaShipping,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      quotesInvalidatedAt: order.quotesInvalidatedAt,
      quoteInvalidationReason: order.quoteInvalidationReason,
      /*
       * WHETHER SHOPIFY CAN BE TOLD AT ALL, answered before the label is bought
       * rather than after.
       *
       * The push needs a fulfillment order id, and an order ingested before the
       * fulfillment-service setup has none. If that is the case the confirmation
       * screen has to say so — an operator who buys a label expecting tracking to
       * reach the customer and finds out afterwards that it cannot is being sold
       * something the page already knew was incomplete.
       */
      hasFulfillmentOrder: Boolean(order.shopifyFulfillmentOrderId),
      shipTo: parseAddress(order.shippingAddress),
      /*
       * The phone as the BOOKING GATE sees it, not as the address blob happens to
       * hold it: `recipientPhoneFor` also reads the number recorded on the order,
       * and a confirmation screen that used the narrower source would tell an
       * operator the carrier will refuse a booking the carrier would take —
       * which is how a number that has already been fixed gets typed in twice.
       */
      recipientPhone: recipientPhoneFor(order),
      billingAddress: parseAddress(order.billingAddress),
      seller: { id: order.seller.id, storeName: order.seller.storeName, currency: order.seller.currency },
    },
    items,
    // Where this parcel ships from — the dock's facts, or null when there is no
    // mapping, which the page states in the same words the booking gate uses.
    origin: originView(shipment),
    quotes,
    returnQuotes,
    selectedQuote,
    // The docks a rate may be priced from, and the clock the dialog reads
    // expiry against — both computed in the loader, never in the browser.
    dockIds,
    now,
    billing,
    eshipper: {
      /*
       * The host, not the boolean: see eshipperStatus. The sentence is built
       * here and travels as a string, because `describeEshipperStatus` lives in
       * a `.server` module and React Router strips those from the client bundle
       * — calling one from the component fails the build, not the request.
       */
      ...status,
      description: describeEshipperStatus(status),
      state: eshipper.status,
      detail: eshipper.detail,
    },
    shopifyFulfillment: { state: shopifyFulfillment.status, detail: shopifyFulfillment.detail },
    /*
     * Whether a return LABEL may be bought, and the refusal in the operator's
     * words. Carried from the adapter rather than decided here: the gate that
     * refuses is the adapter's, and a screen that guessed at it could disagree
     * with the call it is about to make. Quoting stays open — it is read-only
     * and costs nothing — so only the purchase is drawn as closed.
     */
    returnPurchasing: { enabled: RETURN_PURCHASING_ENABLED, reason: RETURN_PURCHASING_DISABLED_REASON },
    returnRequests: shipment.returnRequests,
    shippingClaims: shipment.shippingClaims,
    pickupPlan,
    trackingEvents: shipment.trackingEvents,
    // Deciding that a booking which timed out did not happen is a judgement
    // about money and about whether a second label may be bought. It is not a
    // shipping-management permission, so the control is shown only to an owner
    // and the action re-checks the role rather than trusting this flag.
    isOwner: user.role === "OWNER",
    /*
     * THE SAME PROGRESSION THE ORDER PAGE DRAWS, from the same rows and the same
     * function — this page is where the label and the dispatch control live, so
     * it is where an operator comes back to ask why a stage has not moved. Two
     * screens reading one builder cannot disagree about where a parcel is.
     *
     * It is the ORDER's progression because that is what the audit rows and the
     * selected quote belong to; a shipment page shows the strip for its own
     * parcel and ignores the others, which is also what the order page does when
     * it draws one per box.
     */
    progress: shipmentProgressFor(await orderProgress(shipment.orderId), shipment.id),
  };
}

/** This parcel's strip out of the order's, falling back to the first — which is
 *  what exists when the order page is drawing an order with no shipment at all. */
function shipmentProgressFor(
  entries: { shipmentId: string | null; stages: ProgressStage[] }[],
  shipmentId: string
): ProgressStage[] {
  return (entries.find((entry) => entry.shipmentId === shipmentId) ?? entries[0])?.stages ?? [];
}

export async function action({ request, params }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "shipping.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { actorType: "ADMIN_USER" as const, actorId: user.id, actorName: user.name, ipAddress: ip, userAgent };
  const shipmentId = String(params.shipmentId);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const back = `/admin/shipping/${shipmentId}`;

  try {
    const shipment = await prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new Error("Shipment not found.");
    const orderId = shipment.orderId;

    if (intent === "get_quotes") {
      await getQuotesForOrder(orderId, actor);
    } else if (intent === "select_quote") {
      await selectQuote(orderId, String(form.get("quoteId")), actor);
    } else if (intent === "book_shipment") {
      /*
       * The confirmation screen's answer to "will Shopify notify the customer".
       *
       * Read as an explicit boolean rather than defaulted here, because the
       * three states are different: "on", "off", and "the caller did not ask"
       * (which must leave a stored answer alone rather than silently meaning
       * no). The form always sends the field — it is a checkbox in a modal that
       * cannot be submitted without being seen — so `undefined` only arises for
       * a request built by hand, and that one keeps its hands off the column.
       */
      const answered = form.has("notifyCustomer");
      await bookPreparedShipment(shipmentId, String(form.get("quoteId") || "") || undefined, actor, {
        ...(answered ? { notifyCustomerOnPush: form.get("notifyCustomer") === "on" } : {}),
      });
    } else if (intent === "reconcile_booking") {
      const outcome = await reconcileBookingOutcome(shipmentId, actor);
      return redirect(`${back}?notice=${outcome.adopted ? "booking-recovered" : "booking-not-found"}`);
    } else if (intent === "resolve_unknown_booking") {
      // Re-checked here, not just hidden in the page: a form can be posted by
      // anyone who can reach the route, and this is the one control that can
      // put a possibly-purchased label back on the bookable list.
      if (user.role !== "OWNER") {
        throw new Error("Only an owner can record the outcome of an unknown booking.");
      }
      const decision = String(form.get("decision") || "");
      if (decision !== "nothing_purchased" && decision !== "label_exists") {
        throw new Error("Choose what was found before recording the outcome.");
      }
      await resolveUnknownBooking(
        shipmentId,
        decision,
        {
          reason: String(form.get("reason") || ""),
          providerShipmentId: String(form.get("providerShipmentId") || "") || undefined,
          trackingNumber: String(form.get("trackingNumber") || "") || undefined,
        },
        actor
      );
      return redirect(`${back}?notice=booking-resolved`);
    } else if (intent === "get_label") {
      const label = await getShipmentLabel(shipmentId, actor);
      if (!label.labelUrl) throw new Error("The provider did not return a label URL.");
      return redirect(label.labelUrl);
    } else if (intent === "order_details") {
      await getShipmentOrderDetails(shipmentId, actor);
      return redirect(`${back}?notice=shipment-details-fetched`);
    } else if (intent === "customs_invoice") {
      const invoice = await getShipmentCustomsInvoice(shipmentId, actor);
      if (!invoice.customsInvoiceUrl) throw new Error("The provider did not return a customs invoice.");
      return redirect(invoice.customsInvoiceUrl);
    } else if (intent === "sync_tracking") {
      await syncTrackingForShipment(shipmentId, actor);
    } else if (intent === "retry_shopify_sync") {
      /*
       * §6's retry, and it is deliberately the SAME call the dispatch milestone
       * makes. There is no "retry" variant that could book something: this
       * function pushes the tracking number this shipment already holds and
       * returns early when Shopify already has it, so a retry cannot buy a
       * second label, cannot re-number anything, and cannot notify a customer
       * who has already been told.
       */
      const result = await syncShipmentTracking(shipmentId, actor);
      if (!result.pushed && result.reason === "no_fulfillment_order_id") {
        return {
          error:
            "Shopify sync is not possible for this order: it has no fulfillment order to push tracking to. " +
            "The label and the tracking number are unaffected, and nothing was purchased by this attempt.",
        };
      }
      if (!result.pushed && "message" in result && result.message) {
        return { error: String(result.message) };
      }
    } else if (intent === "set_packing_message") {
      /*
       * The note for the slip in THIS box. Recorded with its before and after,
       * because it is printed and put in a carton that ships: whoever typed it
       * should be answerable for what the customer reads.
       */
      const message = String(form.get("message") || "").trim() || null;
      const before = await prisma.shipment.findUnique({
        where: { id: shipmentId },
        select: { packingSlipMessage: true },
      });
      await prisma.shipment.update({ where: { id: shipmentId }, data: { packingSlipMessage: message } });
      await recordAudit({
        actorType: "ADMIN_USER",
        actorId: user.id,
        actorName: user.name,
        action: "shipment.packing_message_set",
        entityType: AUDIT_ENTITY.SHIPMENT,
        entityId: shipmentId,
        beforeData: { packingSlipMessage: before?.packingSlipMessage ?? null },
        afterData: { packingSlipMessage: message },
      });
      return redirect(`${back}?notice=packing-message-saved`);
    } else if (intent === "cancel_shipment") {
      const result = await voidShipment(shipmentId, actor);
      if (!result.cancelled) {
        return { error: `Cancellation outcome is not confirmed${result.providerMessage ? `: ${result.providerMessage}` : "."} The shipment is shown as an exception, not cancelled.` };
      }
    } else if (intent === "advance_shipment") {
      /*
       * The notify answer has three states, not two, exactly as it does on the
       * booking confirmation: "on" asks Shopify to e-mail the customer, "off"
       * refuses, and an absent field means "use the stored preference" — the
       * answer given when the label was bought lives on the shipment, and
       * reading absence as "off" would silently overwrite it. The event list is
       * the two an operator can witness; a hand-made request for a later status
       * is refused here as well as absent from the form.
       */
      const event = String(form.get("event") || "");
      if (!ADVANCE_EVENTS.includes(event as ShipmentAdvanceEvent)) throw new Error("Unknown shipment event.");
      const answered = form.has("notifyCustomer");
      await advanceShipment(shipmentId, event as ShipmentAdvanceEvent, actor, {
        ...(answered ? { notifyCustomer: form.get("notifyCustomer") === "on" } : {}),
      });
    } else if (intent === "create_return_request") {
      const returnItems: { orderItemId: string; quantity: number }[] = [];
      for (const [key, value] of form.entries()) {
        if (!key.startsWith("ret_")) continue;
        const quantity = Number(value);
        if (Number.isInteger(quantity) && quantity > 0) returnItems.push({ orderItemId: key.slice(4), quantity });
      }
      const payer = String(form.get("shippingPayer") || "UNDECIDED") as ReturnShippingPayer;
      if (!RETURN_PAYERS.includes(payer)) throw new Error("Choose who is expected to pay return shipping.");
      await createReturnRequest({ shipmentId, reason: String(form.get("reason") || ""), notes: String(form.get("notes") || ""), shippingPayer: payer, items: returnItems }, actor);
      return redirect(`${back}?notice=return-opened#return`);
    } else if (intent === "create_claim") {
      const type = String(form.get("claimType") || "") as ShippingClaimType;
      if (!CLAIM_TYPES.includes(type)) throw new Error("Choose a claim type.");
      const amountText = String(form.get("amount") || "").trim();
      const amount = amountText ? Math.round(Number(amountText) * 100) : null;
      if (amountText && !Number.isFinite(amount)) throw new Error("Claim amount must be a number.");
      await createShippingClaim({ shipmentId, type, description: String(form.get("description") || ""), amount, currency: String(form.get("currency") || "CAD"), evidenceNotes: String(form.get("evidenceNotes") || "") }, actor);
      return redirect(`${back}?notice=claim-opened#claim`);
    } else if (intent === "return_quotes") {
      await getReturnQuotesForOrder(orderId, actor);
    } else if (intent === "book_return") {
      const returnItems: { orderItemId: string; quantity: number }[] = [];
      for (const [key, value] of form.entries()) {
        if (!key.startsWith("ret_")) continue;
        const qty = Number(value);
        if (qty > 0) returnItems.push({ orderItemId: key.slice(4), quantity: qty });
      }
      if (returnItems.length === 0) throw new Error("Select at least one item quantity to return.");
      await bookReturnForOrder(
        orderId,
        shipmentId,
        {
          returnQuoteId: String(form.get("returnQuoteId") || ""),
          returnItems,
          reason: String(form.get("reason") || "") || "Not specified",
        },
        actor
      );
    } else if (intent === "schedule_pickup") {
      await schedulePickupForShipment(
        shipmentId,
        {
          pickupDate: String(form.get("pickupDate") || ""),
          // The two times are read as one window: both, or neither. Neither is
          // not "no window" — it is "use the dock's own recorded hours", which
          // the service derives and refuses to invent when there are none. See
          // `readCarrierWindow`.
          pickupTimeWindow: readCarrierWindow(
            form.get("pickupWindowOpen"),
            form.get("pickupWindowClose")
          ) ?? "",
          notes: String(form.get("notes") || "") || undefined,
          /*
           * A dock with a standing collection is refused unless the operator
           * confirms this request is a one-off: a second truck for the same door
           * is how two drivers arrive for one carton. Read as present-or-absent,
           * like the calendar override below — an unticked checkbox posts
           * nothing, and nothing means "the standing collection applies", which
           * is the safe answer.
           */
          oneOffAtRegularDock: form.get("oneOffAtRegularDock") === "true",
          // The tick-box that steps over the dock's own calendar. Read as
          // present-or-absent rather than as a value, because an unticked
          // checkbox posts nothing at all.
          overrideClosedDay: form.get("overrideClosedDay") === "true",
        },
        actor
      );
    } else if (intent === "cancel_pickup") {
      await cancelPickupForShipment(shipmentId, String(form.get("pickupId") || ""), actor);
    } else if (intent === "reconcile_billing") {
      const totalCents = Math.round(Number(form.get("total") || "0") * 100);
      await reconcileCarrierInvoice(
        shipmentId,
        {
          invoiceNumber: String(form.get("invoiceNumber") || ""),
          total: totalCents,
          currency: String(form.get("currency") || "CAD"),
        },
        actor
      );
    } else {
      throw new Error("Unknown action.");
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Operation failed." };
  }
  return redirect(back);
}

const input: React.CSSProperties = { padding: "0.4rem 0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.78rem", boxSizing: "border-box" };
const label: React.CSSProperties = { fontSize: "0.68rem", color: "#64748b", display: "block" };
const btn = (color: string): React.CSSProperties => ({ padding: "0.4rem 0.75rem", border: `1px solid ${color}`, borderRadius: 6, background: "white", color, fontSize: "0.72rem", fontWeight: 600, cursor: "pointer" });
/**
 * Pickup states, in the operator's words.
 *
 * Absent means NONE rather than unknown: a shipment that has never had a pickup
 * is a fact, and saying so is what stops a booking being read as one. UNKNOWN is
 * reserved for a provider that did not answer, where nobody knows whether a
 * truck is coming — the one case that needs someone to go and look.
 */
const PICKUP_LABEL: Record<string, string> = {
  NONE: "No pickup has been requested for this shipment.",
  SCHEDULED: "A pickup is scheduled with the carrier.",
  CANCELLED: "The pickup was cancelled.",
  FAILED: "The last pickup request failed — the shipment itself is unaffected, so retry the pickup.",
  MISSED: "The carrier did not collect as scheduled.",
  UNKNOWN: "The pickup's status could not be confirmed — check with the carrier before assuming anything.",
};

const PICKUP_COLOR: Record<string, string> = {
  NONE: "#b45309",
  SCHEDULED: "#059669",
  CANCELLED: "#64748b",
  FAILED: "#dc2626",
  MISSED: "#dc2626",
  UNKNOWN: "#b45309",
};

const th: React.CSSProperties = { padding: "0.4rem", fontSize: "0.68rem", color: "#64748b", textAlign: "left" };
const td: React.CSSProperties = { padding: "0.4rem", fontSize: "0.78rem" };

function money(cents: number | null | undefined, currency = "CAD") {
  if (cents == null) return "—";
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

/**
 * The booking state machine, rendered.
 *
 * One panel rather than a status field somewhere and a button somewhere else,
 * because the states are not interchangeable and the action for each is
 * different: BOOKING is "wait", BOOKING_FAILED is "retry", BOOKING_UNKNOWN is
 * "find out first", BOOKED is "print the label". A single Book button shown
 * against all of them would offer a re-purchase to two states where that is
 * exactly the wrong thing to do.
 */
interface ProcessProps {
  shipment: {
    status: string;
    providerShipmentId: string | null;
    carrier: string | null;
    serviceName: string | null;
    trackingNumber: string | null;
    labelUrl: string | null;
    bookingAttemptedAt: string | Date | null;
    bookingOutcomeUnknownAt: string | Date | null;
    lastBookingError: string | null;
    quotedCarrierCost: number | null;
    pickupStatus: string | null;
  };
  paid: boolean;
  packages: number;
  selectedQuote: {
    id: string;
    carrier: string;
    serviceName: string;
    totalAmount: number;
    currency: string;
    transitDays: number | null;
    quotedAt: string | Date;
    expiresAt: string | Date | null;
  } | null;
  canBook: boolean;
  isOwner: boolean;
  /*
   * The facts the confirmation screen states that are NOT the selected quote.
   * Spelled out rather than derived from the component's props, so adding a
   * field the screen must show is a change the compiler asks this page for
   * rather than one that silently renders as undefined.
   */
  confirmation: {
    environment: BookingEnvironment;
    environmentDetail: string;
    environmentHost: string | null;
    orderName: string;
    shipFrom: { name: string; lines: string[] } | null;
    shipTo: { name: string; lines: string[] } | null;
    shipToPhone: string | null;
    parcels: { count: number; length: number; width: number; height: number; weight: number; units: string }[];
    units: { dimensionUnit: string; weightUnit: string };
    hasFulfillmentOrder: boolean;
  };
}

function ProcessShipment({ shipment, paid, packages, selectedQuote, canBook, isOwner, confirmation }: ProcessProps) {
  const when = (value: string | Date | null) => (value ? new Date(value).toLocaleString() : "—");

  const body = (() => {
    if (shipment.status === "BOOKING") {
      return (
        <>
          <p style={{ fontSize: "0.78rem", color: "#b45309", marginBottom: "0.3rem" }}>
            A booking attempt is in flight (started {when(shipment.bookingAttemptedAt)}).
          </p>
          <p style={{ fontSize: "0.72rem", color: "#64748b" }}>
            Do not start another one — the provider has been asked once and a second request can buy a second label. If this
            does not finish, the shipment will move to an unknown outcome and can be reconciled from there.
          </p>
        </>
      );
    }

    if (shipment.status === "BOOKING_UNKNOWN") {
      return (
        <>
          <p style={{ fontSize: "0.78rem", color: "#b45309", marginBottom: "0.3rem", fontWeight: 600 }}>
            Booking outcome unknown — the provider did not answer in time, on {when(shipment.bookingOutcomeUnknownAt)}.
          </p>
          <p style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: "0.5rem" }}>
            A label may already have been purchased. Booking again while this is unknown is how an order ends up with two, so
            it is blocked. Reconcile first: it asks the provider whether it holds this booking and adopts it if it does.
          </p>
          {shipment.lastBookingError ? (
            <p style={{ fontSize: "0.7rem", color: "#94a3b8", marginBottom: "0.5rem" }}>Provider said: {shipment.lastBookingError}</p>
          ) : null}
          <Form method="post" style={{ marginBottom: "0.6rem" }}>
            <input type="hidden" name="intent" value="reconcile_booking" />
            <button type="submit" style={btn("#0369a1")}>Reconcile with the provider</button>
          </Form>

          {isOwner ? (
            <details style={{ border: "1px dashed #cbd5e1", borderRadius: 8, padding: "0.6rem" }}>
              <summary style={{ fontSize: "0.75rem", fontWeight: 600, color: "#082a4a", cursor: "pointer" }}>
                Record what the provider&apos;s portal shows (owner only)
              </summary>
              <p style={{ fontSize: "0.7rem", color: "#64748b", margin: "0.4rem 0" }}>
                Use this only after reconciling and checking the provider directly. Both options are recorded against your name
                with your reason, and this is the only way a possibly-purchased label is made bookable again.
              </p>
              <Form method="post" style={{ display: "grid", gap: "0.4rem" }}>
                <input type="hidden" name="intent" value="resolve_unknown_booking" />
                <label style={label}>
                  What was found<br />
                  <select name="decision" style={input} defaultValue="nothing_purchased">
                    <option value="nothing_purchased">No label was purchased — safe to book again</option>
                    <option value="label_exists">A label exists — record it instead of buying another</option>
                  </select>
                </label>
                <label style={label}>Provider shipment id (required if a label exists)<br /><input name="providerShipmentId" style={{ ...input, width: "100%" }} /></label>
                <label style={label}>Tracking number (optional)<br /><input name="trackingNumber" style={{ ...input, width: "100%" }} /></label>
                <label style={label}>
                  Reason — what you checked, where, and what it showed<br />
                  <textarea name="reason" rows={3} style={{ ...input, width: "100%" }} placeholder="e.g. Checked the eShipper portal on 24 Sep at 15:10; no shipment under this quote id; confirmed with the account's order list." />
                </label>
                <button type="submit" style={btn("#b45309")}>Record outcome</button>
              </Form>
            </details>
          ) : (
            <p style={{ fontSize: "0.72rem", color: "#64748b" }}>
              Only an owner can record what the provider&apos;s portal shows. Ask one to reconcile and decide.
            </p>
          )}
        </>
      );
    }

    if (shipment.providerShipmentId) {
      return (
        <>
          <p style={{ fontSize: "0.78rem", color: "#059669", marginBottom: "0.3rem" }}>
            Booked: {shipment.carrier} {shipment.serviceName} · provider shipment {shipment.providerShipmentId}
            {shipment.trackingNumber ? ` · tracking ${shipment.trackingNumber}` : ""}
          </p>
          <p style={{ fontSize: "0.72rem", color: "#64748b" }}>
            Printing or retrieving the label does not buy anything again and does not deduct stock a second time.
          </p>
          {/* The distinction §9 turns on, said where someone might otherwise
              assume the carrier has been told to collect. */}
          <p style={{ fontSize: "0.72rem", color: shipment.pickupStatus === "SCHEDULED" ? "#059669" : "#b45309", marginTop: "0.3rem" }}>
            {shipment.pickupStatus === "SCHEDULED"
              ? "A pickup is scheduled for this shipment."
              : "A booking is not a pickup: the carrier has not been asked to collect this shipment."}
          </p>
        </>
      );
    }

    if (!paid) {
      return <p style={{ fontSize: "0.78rem", color: "#b45309" }}>Booking is blocked until the wholesale payment succeeds.</p>;
    }
    if (packages === 0) {
      return <p style={{ fontSize: "0.78rem", color: "#b45309" }}>No cartons could be resolved for this shipment. Complete the packaging on the items — there is no parcel entry form on this page — then request rates.</p>;
    }
    if (!selectedQuote) {
      return <p style={{ fontSize: "0.78rem", color: "#b45309" }}>Select a quote above. Selecting does not book.</p>;
    }

    const retrying = shipment.status === "BOOKING_FAILED";
    return (
      <>
        {/*
          THE FAILURE, STATED AS A LIST OF WHAT IS STILL TRUE. "It failed" leaves
          an operator to work out whether a label exists, whether Shopify knows
          and whether trying again is safe — and the wrong answer to any of those
          costs money. Every line here is a fact the booking path guarantees on
          this state, not a reassurance.
        */}
        {retrying ? (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "0.6rem 0.75rem", marginBottom: "0.6rem" }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#991b1b" }}>The last booking attempt did not succeed.</div>
            <div style={{ fontSize: "0.75rem", color: "#991b1b", marginTop: "0.2rem" }}>
              {shipment.lastBookingError || "The provider did not give a reason."}
            </div>
            <ul style={{ margin: "0.4rem 0 0 1rem", padding: 0, fontSize: "0.72rem", color: "#7f1d1d" }}>
              <li>No label was purchased and no carrier was booked.</li>
              <li>The order is still unfulfilled in Shopify, and no tracking record was created.</li>
              <li>Retrying is safe: it reuses this shipment rather than creating a second one, so a retry cannot produce two labels.</li>
            </ul>
          </div>
        ) : null}
        <p style={{ fontSize: "0.78rem", marginBottom: "0.4rem" }}>
          {retrying ? "Retrying" : "Booking"} <strong>{selectedQuote.carrier} {selectedQuote.serviceName}</strong> at <strong>{money(selectedQuote.totalAmount, selectedQuote.currency)}</strong>.
          {selectedQuote.expiresAt ? ` Quote expires ${new Date(selectedQuote.expiresAt).toLocaleTimeString()}.` : ""}
          {shipment.quotedCarrierCost != null && shipment.quotedCarrierCost !== selectedQuote.totalAmount ? (
            <span style={{ color: "#b45309" }}> The quote changed from {money(shipment.quotedCarrierCost)} since it was prepared.</span>
          ) : null}
        </p>
        <p style={{ fontSize: "0.7rem", color: "#64748b", marginBottom: "0.4rem" }}>
          This purchases a real label when eShipper is configured. The seller&apos;s fixed shipping charge is unchanged.
        </p>
        {/*
          The button opens the confirmation, and only the confirmation books.
          There is deliberately no second path to `book_shipment` on this page:
          one route to a purchase is one place to state what it costs.
        */}
        <BookingConfirmation
          {...confirmation}
          carrier={selectedQuote.carrier}
          serviceName={selectedQuote.serviceName}
          totalCharge={selectedQuote.totalAmount}
          currency={selectedQuote.currency}
          transitDays={selectedQuote.transitDays}
          quotedAt={selectedQuote.quotedAt}
          expiresAt={selectedQuote.expiresAt}
          quoteId={selectedQuote.id}
          canBook={canBook}
          retrying={retrying}
        />
      </>
    );
  })();

  return body;
}

export default function AdminShipmentDetail() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { shipment, order, items, origin, quotes, returnQuotes, selectedQuote, billing, eshipper, shopifyFulfillment, trackingEvents, units, pickupPlan, bookingParcels, returnPurchasing, returnRequests, shippingClaims, isOwner, progress, dockIds, now } = data;
  const display = trackingDisplay(shipment.trackingStatus, shipment.status);
  const addr = order.shipTo;
  const paid = order.wholesalePaymentStatus === "SUCCEEDED";
  const returnCheapest = pickCheapestQuote(returnQuotes);
  const canBook = !shipment.providerShipmentId && paid && bookingParcels.packages.length > 0 && bookingParcels.missing.length === 0;
  /*
   * The dock's own hours, as the two fields start out. `suggestedWindow` is
   * "HH:MM-HH:MM" and is null unless BOTH ends are recorded — half a window is
   * not one, and a field prefilled with half a fact is a field that gets
   * submitted as if it were whole. Nothing is filled in when the dock has no
   * hours: an empty box says the hours are unknown, which is the truth.
   */
  const [standingOpen, standingClose] = (pickupPlan.suggestedWindow ?? "").split("-");
  const standingWindow = { open: standingOpen || "", close: standingClose || "" };
  /*
   * The Shopify stage's own words, rather than a second copy of the rule that
   * decides them. See `stageByKey`.
   */
  const trackingStage = stageByKey(progress, "tracking_sent");

  return (
    <div className="mv-page-wide">
      <ShippingOperationsNav />
      <div className="mv-page-header">
        <div>
          <h1>
            Shipment {shipment.reference}{shipment.returnOfShipmentId ? " (return)" : ""}
          </h1>
          <p className="mv-muted">
            {order.shopifyOrderName} · {order.seller.storeName} · {order.supplierReference} · {trackingLabel(shipment.trackingStatus)} ({shipment.status})
          </p>
        </div>
        <div className="mv-actions">
          <Link to="/admin/shipping" className="mv-button">&larr; All shipments</Link>
          <Link to={`/admin/orders/${order.id}`} className="mv-button">Open order</Link>
        </div>
      </div>

      {/*
        The same six stages the order page draws, from the same rows. This is
        where an operator comes back to ask why a parcel has not moved, so the
        answer belongs above the controls that move it.
      */}
      {progress.length > 0 ? (
        <div className="mv-panel mv-panel-body">
          <OrderProgress title="Progress" stages={progress} />
        </div>
      ) : null}

      {actionData?.error ? (
        <div className="mv-panel mv-panel-body" style={{ background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>{actionData.error}</div>
      ) : null}

      <div className="mv-panel mv-panel-body">
        <h2 className="mv-panel-title">Related order and remaining quantities</h2>
        <div style={{ fontSize: "0.8rem", lineHeight: 1.7, marginBottom: "0.5rem" }}>
          <div>Order: <Link to={`/admin/orders/${order.id}`} style={{ color: "#082a4a" }}>{order.shopifyOrderName}</Link> · Invoice ref: {order.supplierReference}</div>
          <div>Wholesale payment: <strong>{order.wholesalePaymentStatus}</strong> · Fulfillment: {order.fulfillmentStatus}</div>
          {shipment.returnOfShipmentId ? (
            <div style={{ color: "#b45309" }}>This is a return of shipment <Link to={`/admin/shipping/${shipment.returnOfShipmentId}`} style={{ color: "#b45309" }}>{shipment.returnOfShipmentId.slice(0, 8)}</Link>. Reason: {shipment.returnReason || "—"}. A return label is not a refund.</div>
          ) : null}
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr><th style={th}>Item</th><th style={th}>SKU</th><th style={th}>Ordered</th><th style={th}>In this shipment</th><th style={th}>Remaining unshipped</th></tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={td}>{i.name}</td>
                <td style={td}>{i.sku}</td>
                <td style={td}>{i.ordered}</td>
                <td style={td}>{i.inThisShipment}</td>
                <td style={{ ...td, color: i.remaining > 0 ? "#b45309" : "#059669" }}>{i.remaining}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem" }}>
        <div className="mv-panel mv-panel-body">
          <h2 className="mv-panel-title">Ship from</h2>
          {/*
            The dock, or nothing. This card used to print MOONVELLA_SHIP_FROM_*
            with a "1 Warehouse Way" default, which meant the page and the label
            could disagree while both looked authoritative. §1 settles it: a
            missing mapping is stated and booking is blocked, never substituted.
          */}
          {origin ? (
            <div style={{ fontSize: "0.78rem", lineHeight: 1.7 }}>
              <div>
                {origin.name} <span style={{ color: "#94a3b8" }}>({origin.code})</span>
              </div>
              {origin.addressLines.map((line) => (
                <div key={line}>{line}</div>
              ))}
              {origin.contact ? <div>{origin.contact}</div> : null}
              {origin.pickupLine ? <div style={{ color: "#94a3b8" }}>Dock hours {origin.pickupLine}</div> : null}
              {origin.instructions ? <div style={{ color: "#94a3b8" }}>{origin.instructions}</div> : null}
              <div style={{ color: "#94a3b8", marginTop: "0.3rem" }}>
                {origin.frozen ? "Frozen when this shipment was quoted or booked." : "Live dock record — this shipment has no frozen copy yet."}
              </div>
            </div>
          ) : (
            <p style={{ fontSize: "0.8rem", color: "#b45309" }}>
              Pickup location required. This shipment&apos;s items are not mapped to an Odoo warehouse location, so there is no
              address to collect from and booking is blocked. Map the items&apos; origin, then requote.
            </p>
          )}
        </div>
        <div className="mv-panel mv-panel-body">
          <h2 className="mv-panel-title">Ship to</h2>
          <div style={{ fontSize: "0.78rem", lineHeight: 1.7 }}>
            <div>{addr.name || order.customerName || "—"}</div>
            <div>{addr.address1 || addr.address || "—"}{addr.address2 ? `, ${addr.address2}` : ""}</div>
            <div>{[addr.city, addr.province || addr.provinceCode, addr.zip || addr.postalCode].filter(Boolean).join(", ") || "—"}</div>
            <div>{addr.country || addr.countryCode || "—"}</div>
            <div style={{ color: "#94a3b8" }}>{addr.residential === "false" ? "Commercial" : "Residential"} · {order.customerEmail || "no email"}</div>
            {addr.deliveryInstructions ? <div style={{ color: "#94a3b8" }}>Instructions: {addr.deliveryInstructions}</div> : null}
          </div>
        </div>
      </div>

      <div className="mv-panel mv-panel-body">
        <h2 className="mv-panel-title">Packages (packed dimensions and gross shipping weight)</h2>
        {/*
          READ-ONLY, AND RESOLVED THE WAY THE BOOKING RESOLVES THEM.

          These are the cartons this shipment will actually be labelled with,
          from `packagesForShipment` — the same call the quote and the booking
          make — so this card cannot describe a different set of boxes from the
          one the carrier is asked about. Cartons are found in three places, in
          order: the rows assigned to THIS box, then the order's own parcel
          rows, then the packaging stored on the variants and products. There is
          no add or remove control here on purpose: a parcel typed on a booking
          screen is a measurement the catalogue does not hold, so the next order
          for the same item would be quoted without it.
        */}
        {bookingParcels.packages.length === 0 ? (
          <p style={{ fontSize: "0.78rem", color: "#b45309" }}>
            No cartons could be resolved for this shipment, so quoting and booking are blocked
            {bookingParcels.missing.length > 0 ? (
              <>
                {" "}for: <strong>{bookingParcels.missing.join("; ")}</strong>
              </>
            ) : (
              "."
            )}{" "}
            Complete the packaging in the <Link to="/admin/products" style={{ color: "#082a4a" }}>Product Catalog</Link>{" "}
            or the <Link to="/admin/packaging" style={{ color: "#082a4a" }}>Packaging Library</Link>, then request rates.
            Nothing on this page can supply the missing measurements.
          </p>
        ) : (
          <>
            <p style={{ fontSize: "0.78rem", color: "#334155", marginBottom: "0.35rem" }}>
              Quoting and booking will use{" "}
              <strong>
                {bookingParcels.packages.reduce((n, p) => n + p.count, 0)} parcel
                {bookingParcels.packages.reduce((n, p) => n + p.count, 0) === 1 ? "" : "s"}
              </strong>
              , {SHIPMENT_PARCEL_SOURCE[bookingParcels.source]}.
            </p>
            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "0.6rem" }}>
              <thead>
                {/*
                  * The stored columns are centimetres and kilograms — that is what
                  * a carrier is told and it does not change with the preference —
                  * so the heading and the figures are both read in the unit the
                  * operator is working in, converted for display only.
                  */}
                <tr><th style={th}>Count</th><th style={th}>Dimensions ({units.dimensionUnit})</th><th style={th}>Weight ({units.weightUnit})</th><th style={th}>Total weight</th></tr>
              </thead>
              <tbody>
                {bookingParcels.packages.map((p, index) => (
                  <tr key={index} style={{ borderTop: "1px solid #f1f5f9" }}>
                    <td style={td}>{p.count}</td>
                    <td style={td}>{convertedDisplay(p.length, "cm", units.dimensionUnit, "length")} × {convertedDisplay(p.width, "cm", units.dimensionUnit, "length")} × {convertedDisplay(p.height, "cm", units.dimensionUnit, "length")}</td>
                    <td style={td}>{convertedDisplay(p.weight, "kg", units.weightUnit, "weight")}</td>
                    <td style={td}>{convertedDisplay(p.weight * p.count, "kg", units.weightUnit, "weight")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {bookingParcels.notes.map((note) => (
              <p key={note} style={{ fontSize: "0.72rem", color: "#b45309", marginBottom: "0.35rem" }} role="status">
                {note}
              </p>
            ))}
            <p className="mv-readonly-parcel">
              Read-only. The stored parcel record is centimetres and kilograms; these figures are converted to{" "}
              {units.phrase} for display only, and booking always sends the stored values. To change what is sent,
              correct the packaging on the item — there is no parcel entry form on this page.
            </p>
          </>
        )}
        {bookingParcels.missing.length > 0 && bookingParcels.packages.length > 0 ? (
          <p style={{ fontSize: "0.72rem", color: "#b45309", marginTop: "0.5rem" }}>
            These lines have no packaging and would be refused at booking:{" "}
            <strong>{bookingParcels.missing.join("; ")}</strong>. Complete their packaging in the{" "}
            <Link to="/admin/products" style={{ color: "#082a4a" }}>Product Catalog</Link> or the{" "}
            <Link to="/admin/packaging" style={{ color: "#082a4a" }}>Packaging Library</Link>.
          </p>
        ) : null}
      </div>

      <div className="mv-panel mv-panel-body">
        {/* The progression links here so a booking retry reaches the one
            confirmation panel rather than a second form. */}
        <h2 id="book-shipment" className="mv-panel-title">Rate comparison</h2>
        <p style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: "0.5rem" }}>
          eShipper: {eshipper.description} · {eshipper.detail}
        </p>
        <Form method="post" style={{ marginBottom: "0.6rem" }}>
          <button type="submit" name="intent" value="get_quotes" style={btn("#0369a1")} disabled={bookingParcels.packages.length === 0}>Get quotes</button>
        </Form>
        {/* Why the quotes are gone, in the place the operator is standing when
            they ask. Recorded on the order at the moment they were withdrawn,
            because "no quotes yet" and "your quotes were withdrawn because the
            packages changed" call for different next actions. */}
        {order.quotesInvalidatedAt ? (
          <p style={{ fontSize: "0.72rem", color: "#b45309", marginBottom: "0.5rem" }} role="status">
            Earlier quotes were withdrawn on {new Date(order.quotesInvalidatedAt).toLocaleString()}:{" "}
            {order.quoteInvalidationReason || "no reason recorded"}. Request quotes again.
          </p>
        ) : null}
        {quotes.length === 0 ? (
          <p style={{ fontSize: "0.78rem", color: "#64748b" }}>No quotes yet.</p>
        ) : (
          <>
          {/*
            WHEN THESE PRICES WERE ASKED FOR, and when they stop being spendable.
            The two together are what tell an operator "this is the batch I just
            requested" from "this is yesterday's page" without re-quoting to find
            out — and the booking, which replays the quote into the provider's
            save step, is buying the price on this row, not a fresh one.

            The choosing itself is the shared dialog, the same one the order page
            opens, so the two screens cannot price differently: it prints each
            rate's dock and refuses the ones this shipment cannot book, and its
            only two endings are Cancel and Confirm — neither spends money.
          */}
          <p style={{ fontSize: "0.75rem", color: "#475569", marginBottom: "0.4rem" }}>
            {quotes.length} price{quotes.length === 1 ? "" : "s"} from the rate request at{" "}
            <strong>{new Date(quotes.reduce((newest, q) => (new Date(q.quotedAt) > newest ? new Date(q.quotedAt) : newest), new Date(quotes[0].quotedAt))).toLocaleString()}</strong>.
            Requesting quotes again replaces this batch and clears any selection made from it.
          </p>
          <RateSelection quotes={quotes} dockIds={dockIds} now={now} subject="shipment" />
          </>
        )}

      </div>

      <div className="mv-panel mv-panel-body">
        <h2 className="mv-panel-title">Process shipment</h2>
        <ProcessShipment
          shipment={shipment}
          paid={paid}
          packages={bookingParcels.packages.length}
          selectedQuote={selectedQuote}
          canBook={canBook}
          isOwner={isOwner}
          confirmation={{
            environment: eshipper.environment,
            environmentDetail: eshipper.description,
            environmentHost: eshipper.host,
            orderName: order.shopifyOrderName,
            /*
             * Both addresses are stated as they will be PRINTED, from the same
             * two sources the cards above read: the dock (frozen snapshot first,
             * live record second) and the order's own ship-to. The confirmation
             * repeating them is not redundancy — it is the last screen before
             * the label, and the one an operator actually reads.
             */
            shipFrom: origin ? { name: `${origin.name} (${origin.code})`, lines: [...origin.addressLines, ...(origin.contact ? [origin.contact] : [])] } : null,
            shipTo: {
              name: addr.name || order.customerName || "—",
              lines: [
                [addr.address1 || addr.address, addr.address2].filter(Boolean).join(", "),
                [addr.city, addr.province || addr.provinceCode, addr.zip || addr.postalCode].filter(Boolean).join(", "),
                addr.country || addr.countryCode || "",
              ].filter(Boolean),
            },
            shipToPhone: order.recipientPhone,
            parcels: bookingParcels.packages,
            units: { dimensionUnit: units.dimensionUnit, weightUnit: units.weightUnit },
            hasFulfillmentOrder: order.hasFulfillmentOrder,
          }}
        />
      </div>

      <div className="mv-panel mv-panel-body">
        <h2 className="mv-panel-title">Documents</h2>
        {/*
          WHAT THE BOOKING ACTUALLY BOUGHT, stated once and in full.
          Every figure here is read back from the shipment row rather than
          recomputed: the provider's id, the carrier and service it confirmed
          (which need not be the ones quoted), the cost it booked at, the
          tracking number and URL, the document's own format, and when all of
          that was recorded. A "BOOKED" badge on its own tells an operator
          nothing they can act on when the phone rings.
        */}
        {shipment.providerShipmentId ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "0.5rem", marginBottom: "0.8rem" }}>
            {[
              { k: "Provider shipment id", v: shipment.providerShipmentId },
              { k: "Carrier", v: shipment.carrier || "—" },
              { k: "Service", v: shipment.serviceName || "—" },
              // The BOOKED cost, not the quote: a provider may book at a
              // different amount than it priced, and the label is the one that
              // was bought.
              { k: "Booked cost", v: money(shipment.bookedCost ?? shipment.quotedCarrierCost, order.currency) },
              { k: "Tracking number", v: shipment.trackingNumber || "not issued" },
              { k: "Label format", v: shipment.labelDocumentFormat || (shipment.labelUrl ? "not stated by the provider" : "no label") },
              { k: "Booking status", v: shipment.status.replace(/_/g, " ") },
              { k: "Booked at", v: shipment.labelCreatedAt ? new Date(shipment.labelCreatedAt).toLocaleString() : "not recorded" },
            ].map((row) => (
              <div key={row.k} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.45rem 0.5rem" }}>
                <div style={{ fontSize: "0.65rem", color: "#64748b" }}>{row.k}</div>
                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "#082a4a", wordBreak: "break-all" }}>{row.v}</div>
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {/*
            THE LABEL, as two deliberate actions rather than one link. "Download"
            saves the provider's own file without displaying it — which is what
            an operator wants when filing it against a collection — and "Open"
            renders it for printing. They are the same URL; naming them
            separately is the difference between a button that does what the
            label says and one that does what the browser decides.

            Retrieving a label buys nothing and books nothing: it re-reads what
            was already issued. That is why it is offered here beside them.
          */}
          {shipment.labelUrl ? (
            <>
              <a href={shipment.labelUrl} target="_blank" rel="noreferrer" style={{ ...btn("#0369a1"), textDecoration: "none" }}>
                Open shipping label{shipment.labelDocumentFormat ? ` (${shipment.labelDocumentFormat})` : ""}
              </a>
              <a href={shipment.labelUrl} download style={{ ...btn("#0369a1"), textDecoration: "none" }}>
                Download shipping label
              </a>
            </>
          ) : (
            <span style={{ ...btn("#94a3b8"), cursor: "not-allowed" }}>Shipping label (none yet)</span>
          )}
          {/*
            Named for what each one is, because two of them are easy to mistake
            for something else: the packing list is the only one that states no
            prices, and the provider's order-details sheet is a copy of what
            eShipper holds — it is not the carrier's invoice and must not be
            filed as one.
          */}
          <a href={`/admin/packing-list/${shipment.id}?download=1`} style={{ ...btn("#0369a1"), textDecoration: "none" }}>
            Download packing slip
          </a>
          <a href={`/admin/packing-list/${shipment.id}`} target="_blank" rel="noreferrer" style={{ ...btn("#0369a1"), textDecoration: "none" }}>
            Print packing slip
          </a>
          {shipment.providerShipmentId ? (
            <>
              <Form method="post"><button type="submit" name="intent" value="get_label" style={btn("#0369a1")}>Retrieve label (no rebook)</button></Form>
              <Form method="post"><button type="submit" name="intent" value="order_details" style={btn("#082a4a")}>Provider shipment details</button></Form>
              <Form method="post"><button type="submit" name="intent" value="customs_invoice" style={btn("#082a4a")}>Customs invoice</button></Form>
            </>
          ) : null}
          <Link to={`/admin/orders/${order.id}`} style={{ ...btn("#082a4a"), textDecoration: "none" }}>Seller invoice (order)</Link>
        </div>
        <p style={{ fontSize: "0.68rem", color: "#64748b", marginTop: "0.5rem" }}>
          The packing slip is MoonVella&apos;s own document and does not depend on the carrier: it carries no prices, no wholesale
          cost and no supplier detail, and it can be printed from the moment a shipment exists. The provider shipment-details
          sheet is eShipper&apos;s own copy of the order, not the carrier&apos;s invoice. Carrier charges are reconciled from the
          invoice the carrier issues and are recorded under Billing below.
        </p>
        {shipment.lastTrackingError ? (
          <p style={{ fontSize: "0.7rem", color: "#dc2626", marginTop: "0.5rem" }}>Carrier document/tracking error: {shipment.lastTrackingError}</p>
        ) : null}

        {/*
          THE NOTE THAT GOES IN THE BOX, in the operator's own words.

          Optional, and it stays empty when nobody fills it in: the slip prints
          nothing rather than a labelled blank. Recorded on THIS shipment, so a
          split order can say something different in each carton.
        */}
        <Form method="post" style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", marginTop: "0.8rem", borderTop: "1px solid #f1f5f9", paddingTop: "0.7rem" }}>
          <input type="hidden" name="intent" value="set_packing_message" />
          <label style={{ ...label, flex: 1 }}>
            Message on this box&apos;s packing slip (optional, printed as typed)
            <textarea
              name="message"
              rows={2}
              defaultValue={shipment.packingSlipMessage ?? ""}
              placeholder="e.g. Thank you for your order — the second pillow is in a separate carton."
              style={{ ...input, width: "100%", marginTop: "0.2rem" }}
            />
          </label>
          <button type="submit" style={btn("#082a4a")}>Save message</button>
        </Form>
      </div>

      <div className="mv-panel mv-panel-body">
        <h2 className="mv-panel-title">Tracking</h2>
        {/*
          Both words, because they say different things. The bold line is the
          normalized status — one of nine, the set every screen agrees on. The
          line beneath is the internal state, which keeps apart what the nine
          merge (a failed delivery attempt is not a refusal). The carrier's own
          wording is in the event table below, unchanged.
        */}
        <p style={{ fontSize: "0.78rem", marginBottom: "0.4rem" }}>
          <span style={{ color: trackingDisplayColor[display], fontWeight: 600 }}>{trackingDisplayLabel(display)}</span>
          {" · "}
          {shipment.trackingNumber || "no tracking number"} · {trackingLabel(shipment.trackingStatus)} ({shipment.status})
          {shipment.trackingUrl ? <> · <a href={shipment.trackingUrl} target="_blank" rel="noreferrer" style={{ color: "#0369a1" }}>carrier tracking</a></> : null}
        </p>
        {/*
          THE NUMBER IS OURS THE MOMENT THE LABEL IS BOUGHT, and Shopify's is
          not told until the parcel is handed over — because creating the
          fulfillment is what marks the items fulfilled. The two moments are far
          apart and the gap is deliberate, so it is stated here rather than left
          to look like a sync that has not run.
        */}
        {trackingStage && trackingStage.state !== "done" && !shipment.shopifySyncError ? (
          <p
            style={{
              fontSize: "0.72rem",
              fontWeight: 600,
              marginBottom: "0.4rem",
              color: trackingStage.state === "unknown" ? "#b45309" : "#92400e",
            }}
          >
            {trackingStage.detail}
          </p>
        ) : null}
        <p style={{ fontSize: "0.68rem", color: "#64748b", marginBottom: "0.6rem" }}>
          Last successful update: {shipment.lastTrackingSyncAt ? new Date(shipment.lastTrackingSyncAt).toLocaleString() : "never"}
          {shipment.trackingSyncFailures > 0
            ? ` · ${shipment.trackingSyncFailures} failed ${shipment.trackingSyncFailures === 1 ? "attempt" : "attempts"} since (the last good status above is kept)`
            : ""}
        </p>
        <p style={{ fontSize: "0.72rem", marginBottom: "0.4rem" }}>
          {shipment.estimatedDelivery
            ? `Carrier's delivery estimate: ${new Date(shipment.estimatedDelivery).toLocaleDateString()}`
            : "No delivery estimate from the carrier. An estimate is only shown when the carrier gives one — nothing is inferred from elapsed time."}
        </p>
        {shipment.trackingNumber ? (
          <p style={{ fontSize: "0.68rem", color: "#64748b", marginBottom: "0.6rem" }}>
            {shipment.packageCount != null
              ? `${shipment.packageCount} package${shipment.packageCount === 1 ? "" : "s"} on this label`
              : "Package count was not recorded on this shipment."}
          </p>
        ) : null}
        {shipment.providerShipmentId ? (
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
            <Form method="post"><button type="submit" name="intent" value="sync_tracking" style={btn("#0369a1")}>Sync tracking</button></Form>
            {/*
              WHAT AN OPERATOR MAY RECORD HERE, AND NOTHING MORE: this box is
              packed, and this box was handed to the driver. Those are the two
              things somebody at the dock sees happen. "Shipped", "in transit",
              "delivered" and "exception" are the carrier's own scans — they
              arrive through tracking sync — and typing one here would put a
              fact on the record nobody here observed and, on handoff, push
              tracking to Shopify the carrier had not reported.
            */}
            {shipment.status !== "CANCELLED" ? (
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                {!shipment.packedAt ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="advance_shipment" />
                    <input type="hidden" name="event" value="packed" />
                    <button type="submit" style={btn("#082a4a")}>Mark packed</button>
                  </Form>
                ) : (
                  <span style={{ fontSize: "0.72rem", color: "#334155" }}>
                    Packed {new Date(shipment.packedAt).toLocaleString()}
                  </span>
                )}
                {shipment.packedAt && !shipment.handedToCarrierAt ? (
                  <Form method="post" style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
                    <input type="hidden" name="intent" value="advance_shipment" />
                    <input type="hidden" name="event" value="handed_to_carrier" />
                    {/*
                      THREE STATES, NOT A CHECKBOX. The first option is the
                      stored preference — the answer given when the label was
                      bought — and leaving the select alone uses it. An
                      unchecked checkbox would silently mean "no" on every
                      handoff, including the ones where nobody meant to say no;
                      the explicit options exist for the exceptions.
                    */}
                    <select
                      name="notifyCustomer"
                      defaultValue=""
                      style={input}
                      title="Whether Shopify e-mails the customer when this tracking number is pushed"
                    >
                      <option value="">
                        {shipment.notifyCustomerOnPush
                          ? "Notify the customer (as booked)"
                          : "Do not notify the customer (as booked)"}
                      </option>
                      <option value="on">Notify the customer</option>
                      <option value="off">Do not notify the customer</option>
                    </select>
                    <button type="submit" style={btn("#082a4a")}>Hand to carrier</button>
                  </Form>
                ) : shipment.handedToCarrierAt ? (
                  <span style={{ fontSize: "0.72rem", color: "#334155" }}>
                    Handed to the carrier {new Date(shipment.handedToCarrierAt).toLocaleString()}
                    {shipment.shopifyNotifiedAt ? " · Shopify notified" : ""}
                    {shipment.notifyCustomerOnPush === false ? " · customer notification declined" : ""}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {trackingEvents.length === 0 ? (
          <p style={{ fontSize: "0.75rem", color: "#64748b" }}>No carrier events recorded yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>When</th><th style={th}>Location</th><th style={th}>Event</th><th style={th}>Code</th></tr></thead>
            <tbody>
              {trackingEvents.map((ev) => (
                <tr key={ev.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={td}>{new Date(ev.eventAt).toLocaleString()}</td>
                  <td style={td}>{ev.location || "—"}</td>
                  <td style={td}>{ev.description || ev.statusText || "—"}</td>
                  <td style={td}>{ev.carrierEventCode || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div id="pickup" className="mv-panel mv-panel-body">
        <h2 className="mv-panel-title">Pickup</h2>
        {/*
          The current pickup state, stated before the form that changes it. "A
          booked shipment does not prove pickup is scheduled" is only useful to
          an operator who can tell the two apart on the page in front of them.
        */}
        {/*
          How this parcel is meant to leave the dock, before what the provider
          has confirmed about collecting it. §9 keeps the two apart on purpose: a
          dock with a standing collection does not need a one-off request, and a
          one-off request for that dock is how two drivers arrive for one carton.
        */}
        <p style={{ fontSize: "0.78rem", marginBottom: "0.3rem" }}>
          {PICKUP_MODE_LABEL[shipment.resolvedPickupMode] ?? `Pickup mode: ${shipment.resolvedPickupMode}`}
          {!shipment.pickupMode
            ? " (The shipment itself does not record a mode; this is what the collection gate applies.)"
            : ""}
        </p>
        <p style={{ fontSize: "0.78rem", marginBottom: "0.5rem", color: PICKUP_COLOR[shipment.pickupStatus ?? "NONE"] ?? "#64748b" }}>
          {PICKUP_LABEL[shipment.pickupStatus ?? "NONE"] ?? `Pickup state: ${shipment.pickupStatus}`}
          {shipment.pickupScheduledFor ? ` · ${new Date(shipment.pickupScheduledFor).toLocaleDateString()}` : ""}
          {shipment.pickupWindow ? ` · ${shipment.pickupWindow}` : ""}
          {shipment.pickupConfirmation ? ` · confirmation ${shipment.pickupConfirmation}` : ""}
          {shipment.providerPickupId ? ` · provider pickup ${shipment.providerPickupId}` : ""}
        </p>
        {shipment.pickupLastError ? (
          <p style={{ fontSize: "0.7rem", color: "#dc2626", marginBottom: "0.5rem" }}>{shipment.pickupLastError}</p>
        ) : null}
        {/*
          THE DATES THE DOCK CAN ACTUALLY BE COLLECTED FROM, LISTED.

          A bare date field asks the operator to know the dock's week, its
          holidays and its cutoff by heart, and to get it right every time; the
          dates below are that answer worked out, with the reasons the nearer
          dates were left out. It is the same function the action applies, so a
          date offered here is a date the booking accepts.
        */}
        {pickupPlan.problem ? (
          <p style={{ fontSize: "0.72rem", color: "#b45309", marginBottom: "0.5rem" }}>
            {pickupPlan.problem}
          </p>
        ) : pickupPlan.days.length === 0 ? (
          <p style={{ fontSize: "0.72rem", color: "#b45309", marginBottom: "0.5rem" }}>
            {pickupPlan.origin
              ? `No date could be proposed for ${pickupPlan.origin.name} within the next ${MAX_PROPOSAL_SCAN} days. `
              : "This shipment has no collection address recorded, so no date can be proposed. "}
            Enter a date by hand if the dock has arranged something outside its usual calendar.
          </p>
        ) : (
          <fieldset style={{ border: "none", padding: 0, margin: "0 0 0.5rem" }}>
            <legend style={{ ...label, marginBottom: "0.3rem" }}>
              Next available dates for {pickupPlan.origin?.name ?? "this dock"}
              {pickupPlan.localNow ? ` — it is ${pickupPlan.localNow.time} on ${pickupPlan.localNow.date} there` : ""}
            </legend>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
              {pickupPlan.days.map((day, index) => (
                <label key={day.date} style={{ fontSize: "0.75rem", display: "flex", gap: "0.4rem", alignItems: "baseline" }}>
                  <input type="radio" name="pickupDate" value={day.date} defaultChecked={index === 0} />
                  <span style={{ fontWeight: index === 0 ? 600 : 400 }}>
                    {day.date}
                    {index === 0 ? " (soonest)" : ""}
                  </span>
                  {day.window?.open && day.window?.close ? (
                    <span style={{ color: "#64748b" }}>open {day.window.open}–{day.window.close}</span>
                  ) : null}
                </label>
              ))}
            </div>
            {pickupPlan.excluded.length > 0 ? (
              <details style={{ marginTop: "0.35rem" }}>
                <summary style={{ fontSize: "0.7rem", color: "#64748b", cursor: "pointer" }}>
                  Why the {pickupPlan.excluded.length} earlier date(s) were left out
                </summary>
                <ul style={{ margin: "0.25rem 0 0 1rem", padding: 0, fontSize: "0.68rem", color: "#64748b" }}>
                  {pickupPlan.excluded.slice(0, 10).map((day) => (
                    <li key={day.date}>
                      {day.date} — {day.reasons.join("; ")}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </fieldset>
        )}

        <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <input type="hidden" name="intent" value="schedule_pickup" />
          {/*
            A date is still typeable, because a carrier can agree something this
            calendar does not know. When the date falls on a day the dock's own
            calendar excludes the action refuses it and names the reasons, and
            the exception below is what steps over that — deliberately, and on
            the audit entry.
          */}
          <label style={label}>Pickup date<br /><input type="date" name="pickupDate" style={input} required /></label>
          {/*
            TWO TIMES, NOT A SENTENCE.

            The window is what the carrier is told, and it used to be one free
            text box whose placeholder advertised 09:00-17:00 — a window nobody
            had recorded, offered in the place where a fact belongs. These are the
            same time controls the rest of the system uses, and they start from
            the dock's OWN recorded hours when it has both of them, so the
            operator confirms a window rather than inventing one. Left blank,
            the service derives the window from the origin snapshot and refuses
            outright when the dock has no hours on record.
          */}
          <label style={label}>
            Opens at<br />
            <input
              type="time"
              name="pickupWindowOpen"
              style={input}
              defaultValue={standingWindow.open}
            />
          </label>
          <label style={label}>
            Closes at<br />
            <input
              type="time"
              name="pickupWindowClose"
              style={input}
              defaultValue={standingWindow.close}
            />
          </label>
          <label style={label}>Notes<br /><input name="notes" style={input} /></label>
          {shipment.resolvedPickupMode === "REGULAR" ? (
            /*
              THE STANDING COLLECTION, AND THE ONE EXCEPTION TO IT. A dock with a
              regular collection already sees a truck; the service refuses to ask
              for a second one unless this box is explicitly a one-off, because
              two requests for one door is how two drivers arrive for one carton.
              Read as present-or-absent like the calendar override below.
            */
            <label style={{ ...label, maxWidth: 320 }}>
              <input type="checkbox" name="oneOffAtRegularDock" value="true" />{" "}
              This box misses the dock&apos;s regular collection — request a one-off
            </label>
          ) : null}
          <label style={{ ...label, maxWidth: 260 }}>
            <input type="checkbox" name="overrideClosedDay" value="true" />{" "}
            Schedule anyway (confirmed with carrier)
          </label>
          <button
            type="submit"
            style={btn("#0369a1")}
            disabled={!shipment.providerShipmentId || shipment.resolvedPickupMode === "DROPOFF"}
          >
            {shipment.pickupStatus === "SCHEDULED" ? "Schedule another pickup" : "Schedule pickup"}
          </button>
        </Form>
        {shipment.resolvedPickupMode === "DROPOFF" ? (
          <p style={{ fontSize: "0.72rem", color: "#b45309", marginTop: "0.35rem" }}>
            This dock is a drop-off location: parcels are handed in at the carrier&apos;s depot, so
            there is nothing for the carrier to collect and no pickup can be requested.
          </p>
        ) : null}
        <p style={{ fontSize: "0.68rem", color: "#64748b", marginTop: "0.35rem" }}>
          {pickupPlan.caveat}
          {pickupPlan.fromSnapshot
            ? " The dock's hours here are the ones recorded when this shipment's label was bought."
            : ""}
        </p>
        <Form method="post" style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", marginTop: "0.5rem" }}>
          <input type="hidden" name="intent" value="cancel_pickup" />
          <label style={label}>
            Pickup id to cancel{shipment.providerPickupId ? " (defaults to the scheduled one)" : ""}<br />
            <input name="pickupId" style={input} placeholder={shipment.providerPickupId ?? ""} />
          </label>
          <button type="submit" style={btn("#dc2626")} disabled={!shipment.providerPickupId}>Cancel pickup</button>
        </Form>
        <p style={{ fontSize: "0.68rem", color: "#64748b", marginTop: "0.4rem" }}>
          Pickup cancellation is separate from shipment cancellation and from any financial credit. If the provider does not
          answer, the pickup is left unknown rather than cancelled — a carrier may still be coming.
        </p>
      </div>

      {!shipment.returnOfShipmentId ? (
        <div id="return" className="mv-panel mv-panel-body">
          <h2 className="mv-panel-title">Return authorization</h2>
          <p style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: "0.5rem" }}>
            Open and approve the RMA first. This record does not buy a label, refund, restock, mark received, or update Shopify.
          </p>
          {returnRequests.length > 0 ? (
            <div style={{ display: "grid", gap: "0.4rem", marginBottom: "0.75rem" }}>
              {returnRequests.map((request) => (
                <div key={request.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.55rem", fontSize: "0.73rem" }}>
                  <strong>{request.rmaNumber}</strong> · {request.status.replaceAll("_", " ")} · payer {request.shippingPayer.replaceAll("_", " ")}
                  <br /><span style={{ color: "#64748b" }}>{request.items.map((line) => `${line.quantity} × ${line.orderItem.sku}`).join(" · ")} · {request.reason}</span>
                </div>
              ))}
              <Link to="/admin/returns" style={{ fontSize: "0.72rem", color: "#0369a1" }}>Manage return statuses</Link>
            </div>
          ) : null}
          <Form method="post" style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.65rem", marginBottom: "0.8rem" }}>
            <input type="hidden" name="intent" value="create_return_request" />
            <div style={{ marginBottom: "0.5rem" }}>
              <span style={{ ...label, marginBottom: "0.3rem" }}>Items requested</span>
              {items.map((item) => (
                <label key={item.id} style={{ fontSize: "0.72rem", display: "block", marginBottom: "0.2rem" }}>
                  <input type="number" name={`ret_${item.id}`} min={0} max={item.inThisShipment || item.ordered} defaultValue={0} style={{ ...input, width: 60, marginRight: "0.4rem" }} />
                  {item.name} ({item.sku})
                </label>
              ))}
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={label}>Reason<br /><input name="reason" style={{ ...input, width: 260 }} required /></label>
              <label style={label}>Expected return-shipping payer<br /><select name="shippingPayer" defaultValue="UNDECIDED" style={input}>{RETURN_PAYERS.map((payer) => <option key={payer}>{payer}</option>)}</select></label>
              <label style={label}>Internal notes<br /><input name="notes" style={{ ...input, width: 260 }} /></label>
              <button type="submit" style={btn("#082a4a")}>Open return request</button>
            </div>
          </Form>
          <h3 style={{ fontSize: "0.85rem", color: "#082a4a", margin: "0 0 0.35rem" }}>Return shipping rates</h3>
          <p style={{ fontSize: "0.7rem", color: "#64748b", marginBottom: "0.5rem" }}>Rate shopping is read-only. Label purchase remains disabled until the provider return contract is proven.</p>
          <Form method="post" style={{ marginBottom: "0.6rem" }}>
            <button type="submit" name="intent" value="return_quotes" style={btn("#0369a1")}>Get return rates</button>
          </Form>
          {returnQuotes.length > 0 ? (
            <Form method="post">
              <input type="hidden" name="intent" value="book_return" />
              <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "0.5rem" }}>
                <thead><tr><th style={th}>Return</th><th style={th}>Carrier</th><th style={th}>Service</th><th style={th}>Cost</th><th style={th}>Transit</th></tr></thead>
                <tbody>
                  {returnQuotes.map((q) => (
                    <tr key={q.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                      <td style={td}><input type="radio" name="returnQuoteId" value={q.id} defaultChecked={returnCheapest?.id === q.id} /></td>
                      <td style={td}>{q.carrier}</td>
                      <td style={td}>{q.serviceName}</td>
                      <td style={td}>{money(q.totalAmount, q.currency)}</td>
                      <td style={td}>{q.transitDays === null ? "Estimate unavailable" : `${q.transitDays} day(s)`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginBottom: "0.5rem" }}>
                <span style={{ ...label, marginBottom: "0.3rem" }}>Items to return</span>
                {items.map((i) => (
                  <label key={i.id} style={{ fontSize: "0.72rem", display: "block" }}>
                    <input type="number" name={`ret_${i.id}`} min={0} max={i.inThisShipment || i.ordered} defaultValue={0} style={{ ...input, width: 60, marginRight: "0.4rem" }} />
                    {i.name} ({i.sku})
                  </label>
                ))}
              </div>
              <label style={label}>Reason<br /><input name="reason" style={{ ...input, width: 320 }} /></label>
              {/*
                THE PURCHASE, DRAWN AS CLOSED WHERE IT IS CLOSED. The adapter
                refuses this outright, so the button would only ever return the
                refusal — and a control that cannot do the thing it names is
                worse than no control. The rates above stay visible and stay
                usable: pricing a return costs nothing and is worth being able
                to look at while the purchase is off.
              */}
              {returnPurchasing.enabled ? (
                <button type="submit" style={{ ...btn("#082a4a"), marginTop: "0.5rem" }}>Book return label</button>
              ) : (
                <p style={{ fontSize: "0.72rem", color: "#b45309", marginTop: "0.5rem", maxWidth: 560 }}>
                  {returnPurchasing.reason}
                </p>
              )}
            </Form>
          ) : null}
        </div>
      ) : null}

      <div id="claim" className="mv-panel mv-panel-body">
        <h2 className="mv-panel-title">Carrier claim</h2>
        <p style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: "0.6rem" }}>
          Open an internal case for loss, damage, shortage, or a delivery problem. MoonVella does not tell the carrier it was submitted until you record the carrier&apos;s claim number.
        </p>
        {shippingClaims.length > 0 ? <div style={{ display: "grid", gap: "0.4rem", marginBottom: "0.75rem" }}>{shippingClaims.map((claim) => <div key={claim.id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.55rem", fontSize: "0.73rem" }}><strong>{claim.claimNumber}</strong> · {claim.type.replaceAll("_", " ")} · {claim.status.replaceAll("_", " ")}{claim.carrierClaimNumber ? ` · carrier ${claim.carrierClaimNumber}` : ""}<br /><span style={{ color: "#64748b" }}>{claim.description}</span></div>)}<Link to="/admin/claims" style={{ fontSize: "0.72rem", color: "#0369a1" }}>Manage claim statuses</Link></div> : null}
        <Form method="post" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.5rem", alignItems: "end" }}>
          <input type="hidden" name="intent" value="create_claim" />
          <label style={label}>Problem<br /><select name="claimType" style={{ ...input, width: "100%" }}>{CLAIM_TYPES.map((type) => <option key={type}>{type.replaceAll("_", " ")}</option>)}</select></label>
          <label style={label}>Requested amount (optional)<br /><input name="amount" type="number" min="0" step="0.01" style={{ ...input, width: "100%" }} /></label>
          <label style={label}>Currency<br /><input name="currency" defaultValue={order.currency} maxLength={3} style={{ ...input, width: "100%" }} /></label>
          <label style={{ ...label, gridColumn: "1 / -1" }}>What happened<br /><textarea name="description" required rows={3} style={{ ...input, width: "100%", resize: "vertical" }} /></label>
          <label style={{ ...label, gridColumn: "1 / -1" }}>Evidence checklist / links (internal)<br /><textarea name="evidenceNotes" rows={2} style={{ ...input, width: "100%", resize: "vertical" }} /></label>
          <button type="submit" style={btn("#082a4a")} disabled={!shipment.providerShipmentId}>Open claim draft</button>
          {!shipment.providerShipmentId ? <span style={{ fontSize: "0.68rem", color: "#b45309" }}>A claim needs a booked provider shipment.</span> : null}
        </Form>
      </div>

      <div className="mv-panel mv-panel-body">
        <h2 className="mv-panel-title">Carrier billing and reconciliation</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.6rem", marginBottom: "0.6rem" }}>
          {[
            { k: "Seller shipping charge", v: money(billing.sellerShippingCharge, order.currency) },
            { k: "Quoted carrier cost", v: money(billing.quotedCarrierCost, order.currency) },
            { k: "Booked carrier cost", v: money(billing.bookedCarrierCost, order.currency) },
            { k: "Final billed carrier cost", v: billing.finalBilledCarrierCost == null ? "not billed yet" : money(billing.finalBilledCarrierCost, order.currency) },
            { k: "Shipping margin / loss", v: billing.margin == null ? "—" : money(billing.margin, order.currency) },
            { k: "Billing status", v: billing.status.replace(/_/g, " ") },
          ].map((row) => (
            <div key={row.k} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.5rem" }}>
              <div style={{ fontSize: "0.65rem", color: "#64748b" }}>{row.k}</div>
              <div style={{ fontSize: "0.9rem", fontWeight: 600, color: "#082a4a" }}>{row.v}</div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: "0.68rem", color: "#64748b", marginBottom: "0.5rem" }}>
          A carrier adjustment changes MoonVella&apos;s cost only. The seller charge on the order never moves because of it.
        </p>
        <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <input type="hidden" name="intent" value="reconcile_billing" />
          <label style={label}>Supplier invoice #<br /><input name="invoiceNumber" style={input} required /></label>
          <label style={label}>Invoice total<br /><input name="total" type="number" step="0.01" style={input} required /></label>
          <label style={label}>Currency<br /><input name="currency" defaultValue={order.currency} style={{ ...input, width: 70 }} /></label>
          <button type="submit" style={btn("#082a4a")}>Record supplier invoice</button>
        </Form>
        <p style={{ fontSize: "0.68rem", color: "#64748b", marginTop: "0.4rem" }}>
          This records a draft reconciliation only. It does not post an accounting document to Odoo.
        </p>
      </div>

      <div className="mv-panel mv-panel-body">
        <h2 className="mv-panel-title">Cancellation</h2>
        {shipment.status === "CANCELLED" ? (
          <p style={{ fontSize: "0.8rem", color: "#64748b" }}>Cancelled. Cancellation does not by itself guarantee a refund.</p>
        ) : shipment.providerShipmentId ? (
          <Form method="post">
            <input type="hidden" name="intent" value="cancel_shipment" />
            <button type="submit" style={btn("#dc2626")}>Cancel shipment</button>
          </Form>
        ) : (
          <p style={{ fontSize: "0.8rem", color: "#64748b" }}>Not booked, so there is nothing to cancel at the provider.</p>
        )}
        <p style={{ fontSize: "0.68rem", color: "#64748b", marginTop: "0.4rem" }}>
          Cancel requested is shown until the provider confirms. Shipment cancellation does not cancel or refund the whole order.
        </p>
      </div>

      <div className="mv-panel mv-panel-body">
        {/* Where the tracking push is retried from. */}
        <h2 id="shipments" className="mv-panel-title">Order and Shopify links</h2>
        <div style={{ fontSize: "0.78rem", lineHeight: 1.7 }}>
          <div>Shopify fulfillment order: {order.id ? "see order" : "—"}</div>
          <div>Shopify fulfillment id: {shipment.shopifyFulfillmentId || "not pushed"}</div>
          <div>Shopify fulfillment sync: {shopifyFulfillment.state} — {shopifyFulfillment.detail}</div>
          {/*
            The per-shipment answer, which the integration row cannot give. §8
            pushes at the dispatch milestone, so "not pushed" on a booked parcel
            is the designed state and not a fault — saying "awaiting dispatch"
            rather than "failed" is the difference between an operator waiting
            and an operator retrying something that must not be retried early.
          */}
          {/*
            THE TWO OUTCOMES, IN THE WORDS §6 ASKS FOR.

            The distinction the whole card turns on: a booked label is not a
            collected parcel, so "not pushed" on a freshly booked shipment is
            the designed state and not a fault. Only a shipment that SHOULD have
            been pushed and was not is a failure — and that is why the failure
            line names the retry instead of leaving an operator to guess.
          */}
          {shipment.shopifyFulfillmentId ? (
            <div style={{ color: "#059669", fontWeight: 600 }}>
              Tracking pushed to Shopify — successful
              {shipment.shopifySyncedAt ? ` (${new Date(shipment.shopifySyncedAt).toLocaleString()})` : ""}.
            </div>
          ) : shipment.shopifySyncError ? (
            <div style={{ color: "#dc2626", fontWeight: 600 }}>Carrier booked, Shopify synchronization failed — Retry Shopify sync</div>
          ) : (
            <div style={{ color: "#64748b" }}>
              Not pushed yet — the push happens when this parcel is handed to the carrier, not when the label is bought.
            </div>
          )}
          {shipment.shopifySyncError ? (
            <div style={{ color: "#dc2626", marginTop: "0.2rem" }}>Shopify said: {shipment.shopifySyncError}</div>
          ) : null}
          {shipment.shopifyNotifiedAt ? (
            <div style={{ color: "#94a3b8" }}>
              Customer notified through Shopify on {new Date(shipment.shopifyNotifiedAt).toLocaleString()}. A retry does not notify again.
            </div>
          ) : null}
          {/*
            THE RETRY, and what it does not do. It re-sends the tracking number
            this shipment already holds — it does not re-book, does not buy a
            label and does not touch the tracking number. That is a property of
            the call it makes rather than of this button: `syncShipmentTracking`
            returns early when Shopify already holds the fulfillment, so pressing
            this twice cannot produce two.
          */}
          {/*
            Offered ONLY where a push was attempted and failed. A booked parcel
            awaiting collection has no error and deliberately gets no button:
            pushing there would fulfil the order in Shopify before the carrier
            has the box, and waiting is the correct action, not retrying. An
            error means the push was due, ran, and did not land — which is
            exactly the case §6 gives a retry.
          */}
          {!shipment.shopifyFulfillmentId && shipment.shopifySyncError ? (
            <Form method="post" style={{ marginTop: "0.5rem" }}>
              <input type="hidden" name="intent" value="retry_shopify_sync" />
              <button type="submit" style={btn("#0369a1")}>Retry Shopify sync</button>
            </Form>
          ) : null}
          <p style={{ fontSize: "0.68rem", color: "#64748b", marginTop: "0.4rem" }}>
            Retrying re-sends this shipment&apos;s existing tracking number. It never buys another label, never re-numbers the
            parcel, and will not notify the customer a second time.
          </p>
          <div style={{ color: "#94a3b8" }}>Payment, order fulfillment and parcel tracking are separate statuses.</div>
        </div>
      </div>
    </div>
  );
}
