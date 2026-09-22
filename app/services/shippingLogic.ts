import type { TrackingResult } from "./eshipper.server";

/**
 * Pure shipping rules, deliberately free of Prisma and provider I/O.
 *
 * Keeping these here means the correctness of unit conversion, tracking
 * normalization, quote ranking and charge allocation can be tested without a
 * database, a provider or credentials — which is what makes them trustworthy in
 * the places that matter most (a price shown to a seller, a status shown to the
 * order desk).
 */

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
export function allocateSellerShippingCharge(
  orderShippingCharge: number | null | undefined,
  shipmentQuantity: number,
  orderQuantity: number
): number | null {
  if (orderShippingCharge == null || orderShippingCharge <= 0) return null;
  if (orderQuantity <= 0 || shipmentQuantity <= 0) return null;
  return Math.round((orderShippingCharge * shipmentQuantity) / orderQuantity);
}

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
export function trackingLabel(state: string | null | undefined): string {
  switch (state) {
    case "LABEL_CREATED":
      return "Label created";
    case "PICKED_UP":
      return "Picked up";
    case "IN_TRANSIT":
      return "In transit";
    case "OUT_FOR_DELIVERY":
      return "Out for delivery";
    case "DELIVERED":
      return "Delivered";
    case "EXCEPTION":
      return "Delivery exception";
    case "UNDELIVERED":
      return "Undelivered";
    case "RETURNED":
      return "Returned";
    case "CANCELLED":
      return "Cancelled";
    case "CANCELLING":
      return "Cancel requested";
    case "CANCEL_REJECTED":
      return "Cancellation rejected";
    default:
      return "Preparing";
  }
}

/**
 * Map a provider tracking payload to one normalized state.
 *
 * A return after delivery and a cancellation are meaningful later events and
 * are allowed to win; otherwise the ranking is monotonic. A payload with no
 * indicators is UNKNOWN, never "delivered" by default.
 */
export function normalizeTrackingState(tracking: TrackingResult): string {
  if (tracking.cancelled) return TRACKING_STATE.cancelled;
  if (tracking.returned) return TRACKING_STATE.returned;
  if (tracking.delivered) return TRACKING_STATE.delivered;
  if (tracking.undelivered) return TRACKING_STATE.undelivered;
  if (tracking.exception) return TRACKING_STATE.exception;
  if (tracking.pickup) return TRACKING_STATE.picked_up;
  if (tracking.inTransit) return TRACKING_STATE.in_transit;
  if (tracking.labelGenerated) return TRACKING_STATE.label_created;
  return "UNKNOWN";
}

/** Rank of a normalized state, used to refuse an older event overwriting a newer one. */
export const TRACKING_RANK: Record<string, number> = {
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
 * The coarse ShipmentStatus the rest of the app reads. "Label created" is
 * deliberately PENDING: a label is not a shipment, and an estimated delivery
 * date passing is not a delivery.
 */
export function coarseStatusFor(trackingState: string): "PENDING" | "SHIPPED" | "DELIVERED" | "EXCEPTION" | "CANCELLED" {
  switch (trackingState) {
    case "CANCELLED":
      return "CANCELLED";
    case "DELIVERED":
    case "RETURNED":
      return "DELIVERED";
    case "EXCEPTION":
    case "UNDELIVERED":
      return "EXCEPTION";
    case "PICKED_UP":
    case "IN_TRANSIT":
    case "OUT_FOR_DELIVERY":
      return "SHIPPED";
    default:
      return "PENDING";
  }
}

/**
 * The cheapest quote by total, or null when there are none. A null total is
 * never treated as zero: a quote with an unknown amount cannot win on price.
 */
export function pickCheapestQuote<T extends { totalAmount: number | null }>(quotes: T[]): T | null {
  const known = quotes.filter((q) => q.totalAmount != null);
  if (known.length === 0) return null;
  return known.reduce((best, q) => ((q.totalAmount as number) < (best.totalAmount as number) ? q : best));
}

/**
 * The fastest quote, considering ONLY quotes that carry a transit estimate. A
 * missing estimate is not a zero-day delivery, so it is excluded rather than
 * sorted first; when nothing estimates, the result is null and the interface
 * says "estimate unavailable".
 */
export function pickFastestQuote<T extends { transitDays: number | null }>(quotes: T[]): T | null {
  const known = quotes.filter((q) => q.transitDays != null);
  if (known.length === 0) return null;
  return known.reduce((best, q) => ((q.transitDays as number) < (best.transitDays as number) ? q : best));
}
