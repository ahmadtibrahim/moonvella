import { Link, Form, useLoaderData, useActionData, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { toCm, toKg } from "~/services/packaging.server";
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
  voidShipment,
  getReturnQuotesForOrder,
  bookReturnForOrder,
  schedulePickupForShipment,
  cancelPickupForShipment,
  getBillingReconciliation,
  reconcileCarrierInvoice,
} from "~/services/shipping.server";
// Display-only helpers, imported from the isomorphic module: this route renders
// them, so pulling them from shipping.server would drag server code into the
// client bundle and fail the build.
import {
  trackingLabel,
  trackingDisplay,
  trackingDisplayLabel,
  pickCheapestQuote,
  pickFastestQuote,
  type TrackingDisplayStatus,
} from "~/services/shippingLogic";
import {
  advanceShipment,
  addOrderPackage,
  removeOrderPackage,
  type ShipmentAdvanceEvent,
} from "~/services/fulfillment.server";
import { maskedEshipperAccount, eshipperMode } from "~/services/eshipper.server";
import { getIntegrationState } from "~/services/integrationHealth.server";
import { getUnitsPreference } from "~/services/adminPreferences.server";
import { convertedDisplay, isUnitPreference, unitsView } from "~/utils/measurementUnits";

const ADVANCE_EVENTS: ShipmentAdvanceEvent[] = [
  "packed",
  "handed_to_carrier",
  "shipped",
  "in_transit",
  "delivered",
  "exception",
];

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

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requirePermission(request, "shipping.view");
  const shipmentId = String(params.shipmentId);
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      items: { include: { orderItem: true } },
      trackingEvents: { orderBy: { eventAt: "desc" }, take: 50 },
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

  const [quotes, returnQuotes, billing, eshipper, shopifyFulfillment] = await Promise.all([
    prisma.shippingQuote.findMany({ where: { orderId: order.id, provider: "eshipper" }, orderBy: { totalAmount: "asc" } }),
    prisma.shippingQuote.findMany({ where: { orderId: order.id, provider: "eshipper-return" }, orderBy: { totalAmount: "asc" } }),
    getBillingReconciliation(shipmentId),
    getIntegrationState("eshipper"),
    getIntegrationState("shopify_fulfillment"),
  ]);

  const selectedQuote = quotes.find((q) => q.selected) ?? null;

  /*
   * The admin's unit preference, for reading a parcel's stored centimetres and
   * kilograms back in the unit the operator is working in. The stored values do
   * not move: this is the same conversion the packaging editors do, on a value
   * whose own unit is fixed.
   */
  const units = unitsView(await getUnitsPreference());

  return {
    units,
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
      providerPickupId: shipment.providerPickupId,
      pickupScheduledFor: shipment.pickupScheduledFor,
      pickupWindow: shipment.pickupWindow,
      pickupConfirmation: shipment.pickupConfirmation,
      pickupLastError: shipment.pickupLastError,
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
      shipTo: parseAddress(order.shippingAddress),
      billingAddress: parseAddress(order.billingAddress),
      seller: { id: order.seller.id, storeName: order.seller.storeName, currency: order.seller.currency },
    },
    items,
    // Where this parcel ships from — the dock's facts, or null when there is no
    // mapping, which the page states in the same words the booking gate uses.
    origin: originView(shipment),
    packages: order.packages,
    quotes,
    returnQuotes,
    selectedQuote,
    billing,
    eshipper: {
      mode: await eshipperMode(),
      account: await maskedEshipperAccount(),
      state: eshipper.status,
      detail: eshipper.detail,
    },
    shopifyFulfillment: { state: shopifyFulfillment.status, detail: shopifyFulfillment.detail },
    trackingEvents: shipment.trackingEvents,
    // Deciding that a booking which timed out did not happen is a judgement
    // about money and about whether a second label may be bought. It is not a
    // shipping-management permission, so the control is shown only to an owner
    // and the action re-checks the role rather than trusting this flag.
    isOwner: user.role === "OWNER",
  };
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

    if (intent === "add_package") {
      /*
       * The unit the form was drawn in — the admin's, not a per-parcel choice.
       * There is one unit setting for the whole admin and this form reads it
       * like every other: an operator who set centimetres should not have to
       * remember to also change a dropdown before typing a parcel.
       *
       * The value the form carried back wins over the stored preference, for the
       * same reason it does everywhere else: a preference changed in another tab
       * while this page sat open must not reinterpret a number somebody typed
       * while looking at a label in the old unit. A hand-made request with
       * neither falls back to the stored preference rather than guessing.
       */
      const submitted = form.get("units");
      const preference = isUnitPreference(submitted) ? submitted : await getUnitsPreference();
      const dimensionUnit = unitsView(preference).dimensionUnit;
      const weightUnit = unitsView(preference).weightUnit;
      const length = Number(form.get("length"));
      const width = Number(form.get("width"));
      const height = Number(form.get("height"));
      const weight = Number(form.get("weight"));
      if (!(length > 0) || !(width > 0) || !(height > 0)) {
        throw new Error("Length, width and height must all be greater than zero.");
      }
      if (!(weight > 0)) throw new Error("Gross shipping weight must be greater than zero.");
      // Written through the shared helper rather than here, so the audit row and
      // the quote withdrawal travel with the write instead of depending on this
      // page remembering both.
      await addOrderPackage(
        orderId,
        {
          count: Math.max(1, Math.floor(Number(form.get("count") || 1))),
          length: Number(toCm(length, dimensionUnit).toFixed(2)),
          width: Number(toCm(width, dimensionUnit).toFixed(2)),
          height: Number(toCm(height, dimensionUnit).toFixed(2)),
          weight: Number(toKg(weight, weightUnit).toFixed(3)),
        },
        actor
      );
    } else if (intent === "remove_package") {
      await removeOrderPackage(orderId, String(form.get("packageId")), actor);
    } else if (intent === "get_quotes") {
      await getQuotesForOrder(orderId, actor);
    } else if (intent === "select_quote") {
      await selectQuote(orderId, String(form.get("quoteId")), actor);
    } else if (intent === "book_shipment") {
      await bookPreparedShipment(shipmentId, String(form.get("quoteId") || "") || undefined, actor);
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
    } else if (intent === "cancel_shipment") {
      const result = await voidShipment(shipmentId, actor);
      if (!result.cancelled) {
        return { error: `Cancellation outcome is not confirmed${result.providerMessage ? `: ${result.providerMessage}` : "."} The shipment is shown as an exception, not cancelled.` };
      }
    } else if (intent === "advance_shipment") {
      const event = String(form.get("event") || "");
      if (!ADVANCE_EVENTS.includes(event as ShipmentAdvanceEvent)) throw new Error("Unknown shipment event.");
      await advanceShipment(shipmentId, event as ShipmentAdvanceEvent, actor, {
        notifyCustomer: form.get("notifyCustomer") === "on",
      });
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
          pickupTimeWindow: String(form.get("pickupTimeWindow") || ""),
          notes: String(form.get("notes") || "") || undefined,
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

const card: React.CSSProperties = { background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1.25rem", marginBottom: "1.25rem" };
const h2: React.CSSProperties = { fontSize: "0.95rem", fontWeight: 600, color: "#082a4a", marginBottom: "0.6rem" };
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
  selectedQuote: { id: string; carrier: string; serviceName: string; totalAmount: number; currency: string; expiresAt: string | Date | null } | null;
  canBook: boolean;
  isOwner: boolean;
}

function ProcessShipment({ shipment, paid, packages, selectedQuote, canBook, isOwner }: ProcessProps) {
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
      return <p style={{ fontSize: "0.78rem", color: "#b45309" }}>Add the packed dimensions and gross weight before booking.</p>;
    }
    if (!selectedQuote) {
      return <p style={{ fontSize: "0.78rem", color: "#b45309" }}>Select a quote above. Selecting does not book.</p>;
    }

    const retrying = shipment.status === "BOOKING_FAILED";
    return (
      <>
        {retrying ? (
          <p style={{ fontSize: "0.78rem", color: "#dc2626", marginBottom: "0.4rem" }}>
            The last attempt failed and nothing was purchased: {shipment.lastBookingError || "no reason recorded"}.
          </p>
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
        <Form method="post">
          <input type="hidden" name="intent" value="book_shipment" />
          <input type="hidden" name="quoteId" value={selectedQuote.id} />
          <button type="submit" style={btn("#059669")} disabled={!canBook}>{retrying ? "Retry booking" : "Book shipment"}</button>
        </Form>
      </>
    );
  })();

  return body;
}

export default function AdminShipmentDetail() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { shipment, order, items, origin, packages, quotes, returnQuotes, selectedQuote, billing, eshipper, shopifyFulfillment, trackingEvents, units } = data;
  const display = trackingDisplay(shipment.trackingStatus, shipment.status);
  const addr = order.shipTo;
  const paid = order.wholesalePaymentStatus === "SUCCEEDED";
  const cheapest = pickCheapestQuote(quotes);
  const fastest = pickFastestQuote(quotes);
  const returnCheapest = pickCheapestQuote(returnQuotes);
  const canBook = !shipment.providerShipmentId && paid && packages.length > 0;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <p style={{ fontSize: "0.75rem", marginBottom: "0.5rem" }}>
        <Link to="/admin/shipping" style={{ color: "#082a4a" }}>&larr; All shipments</Link>
      </p>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>
        Shipment {shipment.reference}{shipment.returnOfShipmentId ? " (return)" : ""}
      </h1>
      <p style={{ color: "#64748b", fontSize: "0.8rem", marginBottom: "1.25rem" }}>
        {order.shopifyOrderName} · {order.seller.storeName} · {order.supplierReference} · {trackingLabel(shipment.trackingStatus)} ({shipment.status})
      </p>

      {actionData?.error ? (
        <div style={{ ...card, background: "#fef2f2", borderColor: "#fecaca", color: "#991b1b" }}>{actionData.error}</div>
      ) : null}

      <div style={card}>
        <h2 style={h2}>Related order and remaining quantities</h2>
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
        <div style={card}>
          <h2 style={h2}>Ship from</h2>
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
        <div style={card}>
          <h2 style={h2}>Ship to</h2>
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

      <div style={card}>
        <h2 style={h2}>Packages (packed dimensions and gross shipping weight)</h2>
        {packages.length === 0 ? (
          <p style={{ fontSize: "0.78rem", color: "#b45309" }}>No parcel dimensions recorded. Quoting is blocked until every parcel has length, width, height and gross shipping weight.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "0.6rem" }}>
            <thead>
              {/*
                * The stored columns are centimetres and kilograms — that is what
                * a carrier is told and it does not change with the preference —
                * so the heading and the figures are both read in the unit the
                * operator is working in, converted for display only.
                */}
              <tr><th style={th}>Count</th><th style={th}>Dimensions ({units.dimensionUnit})</th><th style={th}>Weight ({units.weightUnit})</th><th style={th}>Total weight</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {packages.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={td}>{p.count}</td>
                  <td style={td}>{convertedDisplay(p.length, "cm", units.dimensionUnit, "length")} × {convertedDisplay(p.width, "cm", units.dimensionUnit, "length")} × {convertedDisplay(p.height, "cm", units.dimensionUnit, "length")}</td>
                  <td style={td}>{convertedDisplay(p.weight, "kg", units.weightUnit, "weight")}</td>
                  <td style={td}>{convertedDisplay(p.weight * p.count, "kg", units.weightUnit, "weight")}</td>
                  <td style={td}>
                    {!shipment.providerShipmentId ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="remove_package" />
                        <input type="hidden" name="packageId" value={p.id} />
                        <button type="submit" style={btn("#dc2626")}>Remove</button>
                      </Form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!shipment.providerShipmentId ? (
          <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
            <input type="hidden" name="intent" value="add_package" />
            {/* The unit this form was drawn in. There is no selector beside the
                fields: the admin has one unit setting and it is on the
                Settings page, where it says that it applies everywhere. */}
            <input type="hidden" name="units" value={units.preference} />
            <label style={label}>Count<br /><input style={{ ...input, width: 70 }} name="count" type="number" defaultValue={1} min={1} /></label>
            <label style={label}>Length ({units.dimensionUnit})<br /><input style={{ ...input, width: 80 }} name="length" type="number" step="0.01" required /></label>
            <label style={label}>Width ({units.dimensionUnit})<br /><input style={{ ...input, width: 80 }} name="width" type="number" step="0.01" required /></label>
            <label style={label}>Height ({units.dimensionUnit})<br /><input style={{ ...input, width: 80 }} name="height" type="number" step="0.01" required /></label>
            <label style={label}>Gross weight ({units.weightUnit})<br /><input style={{ ...input, width: 90 }} name="weight" type="number" step="0.01" required /></label>
            <button type="submit" style={btn("#0369a1")}>Add parcel</button>
          </Form>
        ) : null}
      </div>

      <div style={card}>
        <h2 style={h2}>Rate comparison</h2>
        <p style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: "0.5rem" }}>
          eShipper: {eshipper.mode === "real" ? `configured (${eshipper.account ?? "account"})` : "not configured — quotes are simulated"} · {eshipper.detail}
        </p>
        <Form method="post" style={{ marginBottom: "0.6rem" }}>
          <button type="submit" name="intent" value="get_quotes" style={btn("#0369a1")} disabled={packages.length === 0}>Get quotes</button>
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
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr><th style={th}>Carrier</th><th style={th}>Service</th><th style={th}>Total</th><th style={th}>Base / surcharge / tax</th><th style={th}>Transit</th><th style={th}></th></tr>
            </thead>
            <tbody>
              {quotes.map((q) => {
                const raw = q.raw ? (JSON.parse(q.raw) as Record<string, unknown>) : {};
                return (
                  <tr key={q.id} style={{ borderTop: "1px solid #f1f5f9", background: q.selected ? "#f0fdf4" : undefined }}>
                    <td style={td}>{q.carrier}</td>
                    <td style={td}>
                      {q.serviceName}
                      {cheapest?.id === q.id ? " · cheapest" : ""}
                      {fastest?.id === q.id && q.transitDays !== null ? " · fastest" : ""}
                    </td>
                    <td style={td}>{money(q.totalAmount, q.currency)}</td>
                    <td style={{ ...td, color: "#94a3b8", fontSize: "0.68rem" }}>
                      {raw.baseCharge != null ? `base ${raw.baseCharge}` : "base n/a"}
                      {raw.surcharges != null ? ` · surcharges` : ""}
                      {raw.taxes != null ? ` · taxes` : ""}
                    </td>
                    <td style={td}>{q.transitDays === null ? "Estimate unavailable" : `${q.transitDays} day(s)`}</td>
                    <td style={td}>
                      <Form method="post">
                        <input type="hidden" name="intent" value="select_quote" />
                        <input type="hidden" name="quoteId" value={q.id} />
                        <button type="submit" style={btn("#082a4a")}>Select</button>
                      </Form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

      </div>

      <div style={card}>
        <h2 style={h2}>Process shipment</h2>
        <ProcessShipment
          shipment={shipment}
          paid={paid}
          packages={packages.length}
          selectedQuote={selectedQuote}
          canBook={canBook}
          isOwner={data.isOwner}
        />
      </div>

      <div style={card}>
        <h2 style={h2}>Documents</h2>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {shipment.labelUrl ? (
            <a href={shipment.labelUrl} target="_blank" rel="noreferrer" style={btn("#0369a1")}>Shipping label</a>
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
          <Link to={`/admin/packing-list/${shipment.id}`} style={{ ...btn("#0369a1"), textDecoration: "none" }}>
            Packing list (print, no prices)
          </Link>
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
          The provider shipment-details sheet is eShipper&apos;s own copy of the order, not the carrier&apos;s invoice. Carrier charges
          are reconciled from the invoice the carrier issues and are recorded under Billing below.
        </p>
        {shipment.lastTrackingError ? (
          <p style={{ fontSize: "0.7rem", color: "#dc2626", marginTop: "0.5rem" }}>Carrier document/tracking error: {shipment.lastTrackingError}</p>
        ) : null}
      </div>

      <div style={card}>
        <h2 style={h2}>Tracking</h2>
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
            {shipment.status !== "CANCELLED" && shipment.status !== "DELIVERED" ? (
              <Form method="post" style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
                <input type="hidden" name="intent" value="advance_shipment" />
                <select name="event" defaultValue="in_transit" style={input}>
                  {ADVANCE_EVENTS.map((ev) => (
                    <option key={ev} value={ev}>{ev.replace(/_/g, " ")}</option>
                  ))}
                </select>
                <label style={{ fontSize: "0.68rem", color: "#64748b" }}><input type="checkbox" name="notifyCustomer" /> notify</label>
                <button type="submit" style={btn("#082a4a")}>Record</button>
              </Form>
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

      <div style={card}>
        <h2 style={h2}>Pickup</h2>
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
          {shipment.pickupMode
            ? PICKUP_MODE_LABEL[shipment.pickupMode] ?? `Pickup mode: ${shipment.pickupMode}`
            : "Pickup mode not recorded — this shipment predates the origin mapping, so confirm with the dock before relying on the state below."}
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
        <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <input type="hidden" name="intent" value="schedule_pickup" />
          <label style={label}>Pickup date<br /><input type="date" name="pickupDate" style={input} required /></label>
          <label style={label}>Time window<br /><input name="pickupTimeWindow" placeholder="09:00-17:00" style={input} /></label>
          <label style={label}>Notes<br /><input name="notes" style={input} /></label>
          <button type="submit" style={btn("#0369a1")} disabled={!shipment.providerShipmentId}>
            {shipment.pickupStatus === "SCHEDULED" ? "Schedule another pickup" : "Schedule pickup"}
          </button>
        </Form>
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
        <div style={card}>
          <h2 style={h2}>Return</h2>
          <p style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: "0.5rem" }}>
            A return is a new shipment linked to this one. It does not refund, restock, mark received, or charge the seller.
          </p>
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
              <button type="submit" style={{ ...btn("#082a4a"), marginTop: "0.5rem" }}>Book return label</button>
            </Form>
          ) : null}
        </div>
      ) : null}

      <div style={card}>
        <h2 style={h2}>Carrier billing and reconciliation</h2>
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

      <div style={card}>
        <h2 style={h2}>Cancellation</h2>
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

      <div style={card}>
        <h2 style={h2}>Order and Shopify links</h2>
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
          <div style={{ color: shipment.shopifySyncError ? "#dc2626" : "#64748b" }}>
            {shipment.shopifyFulfillmentId
              ? `Pushed to Shopify${shipment.shopifySyncedAt ? ` on ${new Date(shipment.shopifySyncedAt).toLocaleString()}` : ""}.`
              : shipment.shopifySyncError
                ? `Last push failed: ${shipment.shopifySyncError}`
                : "Not pushed yet — the push happens when this parcel is handed to the carrier, not when the label is bought."}
          </div>
          {shipment.shopifyNotifiedAt ? (
            <div style={{ color: "#94a3b8" }}>
              Customer notified through Shopify on {new Date(shipment.shopifyNotifiedAt).toLocaleString()}. A retry does not notify again.
            </div>
          ) : null}
          <div style={{ color: "#94a3b8" }}>Payment, order fulfillment and parcel tracking are separate statuses.</div>
        </div>
      </div>
    </div>
  );
}
