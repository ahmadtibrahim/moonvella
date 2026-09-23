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
  // A delivery the carrier counts as PART of the shipment is not a delivery of
  // the shipment. Three of four cartons arriving leaves the fourth still coming,
  // and calling that DELIVERED would stop the polling that is the only way we
  // would ever hear about it.
  if (tracking.delivered && !isPartialDelivery(tracking)) return TRACKING_STATE.delivered;
  if (tracking.undelivered) return TRACKING_STATE.undelivered;
  if (tracking.exception) return TRACKING_STATE.exception;
  if (tracking.outForDelivery) return TRACKING_STATE.out_for_delivery;
  // Transit before pickup, exactly as the ranks order them: a payload carrying
  // both (the provider re-sent its history) is in transit, and reading the
  // pickup flag first would answer an older question and lower the state.
  if (tracking.inTransit) return TRACKING_STATE.in_transit;
  if (tracking.pickup) return TRACKING_STATE.picked_up;
  if (tracking.labelGenerated) return TRACKING_STATE.label_created;
  return "UNKNOWN";
}

/**
 * Whether the carrier says SOME but not all of the shipment arrived.
 *
 * Only answerable when the carrier states both counts. A payload that says
 * "delivered" with no counts is a whole delivery by the carrier's own wording,
 * and it is not our place to reinterpret it into a partial one.
 */
export function isPartialDelivery(tracking: Pick<TrackingResult, "delivered" | "deliveredPackages" | "totalPackages">): boolean {
  if (!tracking.delivered) return false;
  const total = tracking.totalPackages;
  const done = tracking.deliveredPackages;
  if (total == null || done == null) return false;
  if (total <= 0) return false;
  return done < total;
}

/** "3 of 4 parcels delivered", or null when the carrier gave no counts. */
export function partialDeliverySummary(tracking: Pick<TrackingResult, "deliveredPackages" | "totalPackages">): string | null {
  const total = tracking.totalPackages;
  const done = tracking.deliveredPackages;
  if (total == null || done == null || total <= 0) return null;
  return `${done} of ${total} parcels delivered`;
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

/* -------------------------------------------------------------------------- */
/* §7 tracking: what the page says, and when we ask again                      */
/* -------------------------------------------------------------------------- */

/**
 * The vocabulary the tracking page is allowed to use.
 *
 * Nine words, and every one of them is something a carrier said. The stored
 * `trackingStatus` is a coarser internal rank (see TRACKING_RANK) chosen to make
 * "never go backwards" decidable; this is the set a person reads, and the two
 * are deliberately not the same list. `LABEL_CREATED` is shown as "Booked"
 * because that is what happened — a label was bought and nothing has been
 * collected, which is exactly the distinction §8 insists on: booking alone is
 * not a carrier pickup.
 *
 * `EXCEPTION` and `UNDELIVERED` share one word here ("Exception/Delayed")
 * because the operator's next action is the same for both, while the internal
 * states stay distinct so that "the carrier tried and failed" and "the carrier
 * says it cannot be delivered" can still be told apart in the record.
 */
export const TRACKING_DISPLAY = {
  BOOKED: "Booked",
  PICKED_UP: "Picked up",
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  EXCEPTION: "Exception/Delayed",
  CANCELLED: "Cancelled",
  RETURNED: "Returned",
  UNKNOWN: "Unknown",
} as const;

export type TrackingDisplayStatus = keyof typeof TRACKING_DISPLAY;

/** The nine words, in the order a shipment moves through them. */
export const TRACKING_DISPLAY_ORDER: TrackingDisplayStatus[] = [
  "BOOKED",
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "EXCEPTION",
  "CANCELLED",
  "RETURNED",
  "UNKNOWN",
];

/**
 * The word the page shows for a shipment.
 *
 * Two inputs because "no tracking yet" is not the same as "we do not know": a
 * shipment that has been booked has a tracking status of null until the carrier
 * says anything, and calling that "Unknown" would hide the one fact we do have.
 * A shipment whose booking failed or whose outcome is unknown has neither, and
 * is honestly Unknown.
 */
export function trackingDisplay(
  trackingStatus: string | null | undefined,
  shipmentStatus?: string | null
): TrackingDisplayStatus {
  switch (trackingStatus) {
    case "LABEL_CREATED":
      return "BOOKED";
    case "PICKED_UP":
      return "PICKED_UP";
    case "IN_TRANSIT":
      return "IN_TRANSIT";
    case "OUT_FOR_DELIVERY":
      return "OUT_FOR_DELIVERY";
    case "DELIVERED":
      return "DELIVERED";
    case "EXCEPTION":
    case "UNDELIVERED":
      return "EXCEPTION";
    case "CANCELLED":
      return "CANCELLED";
    case "RETURNED":
      return "RETURNED";
    // UNKNOWN is a carrier word, not the absence of one: the carrier answered
    // with nothing we could read. Displaying it as "Booked" because a booking
    // exists would hide that the carrier spoke.
    case "UNKNOWN":
      return "UNKNOWN";
    default:
      break;
  }
  // No carrier word yet. A booking that exists is "Booked"; anything else has
  // nothing to report and says so rather than guessing a stage.
  return shipmentStatus === "BOOKED" ? "BOOKED" : "UNKNOWN";
}

/** The label for a display status. Never claims more than the carrier said. */
export function trackingDisplayLabel(status: TrackingDisplayStatus): string {
  return TRACKING_DISPLAY[status];
}

/**
 * The shipment filter that finds exactly the rows `trackingDisplay` labels with
 * this word.
 *
 * THIS IS THE FILTER TWIN OF trackingDisplay, AND IT LIVES HERE ON PURPOSE. The
 * filter is what an operator asked for; the label is what they saw on the row.
 * Once they drift, a filter for "Booked" quietly omits every parcel whose
 * carrier has not spoken yet, the page shows fewer rows, and nothing says the
 * list is wrong. Keeping the two functions side by side is what makes the drift
 * visible to whoever changes one of them.
 *
 * WHY TWO OF THE NINE ARE NOT AN EQUALITY. "Booked" and "Unknown" are the two
 * words that describe a shipment with NO carrier event: booking bought a label
 * and the carrier has said nothing since, which is Booked; a parcel that has
 * neither a carrier word nor a booking is Unknown. The internal column is null
 * for both, so the difference is the shipment's own lifecycle status, and the
 * filter has to say so explicitly.
 *
 * The remaining seven display words are the internal words, which is not a
 * coincidence — trackingDisplay maps them straight through — but it is still an
 * assumption this function states rather than hides.
 */
export function trackingDisplayWhere(status: TrackingDisplayStatus): Record<string, unknown> {
  switch (status) {
    case "BOOKED":
      return { OR: [{ trackingStatus: "LABEL_CREATED" }, { trackingStatus: null, status: "BOOKED" }] };
    case "EXCEPTION":
      // One word on screen, two states in the record: the carrier tried and
      // failed, versus the carrier says it cannot be delivered. Both send the
      // operator to the same place, and neither is hidden by the filter.
      return { trackingStatus: { in: ["EXCEPTION", "UNDELIVERED"] } };
    case "UNKNOWN":
      return { OR: [{ trackingStatus: "UNKNOWN" }, { trackingStatus: null, NOT: { status: "BOOKED" } }] };
    default:
      return { trackingStatus: status };
  }
}

/**
 * The statuses a shipment can be in after which there is little left to learn.
 *
 * Polling does not stop for these — a delivered parcel can still be returned and
 * a cancellation can still be reversed — it slows down. "Completed" is about
 * cadence, not about being finished with.
 */
export function isTrackingComplete(trackingStatus: string | null | undefined): boolean {
  return trackingStatus === "DELIVERED" || trackingStatus === "RETURNED" || trackingStatus === "CANCELLED";
}

/** How often the sweep asks about a shipment, before failures stretch it. */
export const TRACKING_POLL = {
  /** While the parcel is moving. */
  activeMs: 30 * 60 * 1000,
  /** Once delivered, returned or cancelled: a receipt, not a race. */
  completeMs: 12 * 60 * 60 * 1000,
  /** The ceiling a run of failures backs off to. */
  maxBackoffMs: 12 * 60 * 60 * 1000,
  /** How many shipments one sweep will poll. Bounds the burst on the provider. */
  batchSize: 25,
} as const;

export interface TrackingPollDecision {
  /** Whether the sweep should poll this shipment now. */
  due: boolean;
  /** Why not, in words an operator can read. Null when due. */
  reason: string | null;
  /** What the interval will have stretched to next time, after these failures. */
  intervalMs: number;
}

/** The shipment fields the decision needs, and nothing else. */
export interface TrackingPollInput {
  status: string;
  trackingStatus: string | null;
  providerShipmentId: string | null;
  trackingNumber: string | null;
  lastTrackingSyncAt: Date | null;
  /** Last time the carrier was ASKED, however it answered. Falls back to
   * lastTrackingSyncAt for rows that predate the column. */
  lastTrackingAttemptAt?: Date | null;
  trackingSyncFailures: number;
  bookingOutcomeUnknownAt?: Date | null;
}

/**
 * Whether to poll this shipment, and why not.
 *
 * WHAT THIS REFUSES TO DO.
 *
 * It does not poll a shipment that has nothing to poll by: no provider shipment
 * id AND no tracking number means there is no question to ask, and asking
 * anyway spends a rate-limit slot to learn nothing. A shipment whose booking
 * outcome is unknown is in that group for a different reason — we do not hold an
 * id for it, and it must not be "tracked" into existence.
 *
 * It does not treat elapsed time at the provider as a delivery. Nothing here
 * writes a status; the only thing that advances a parcel is the carrier saying
 * so. `intervalMs` is a schedule, and a schedule is not evidence.
 *
 * Overlap between two concurrent sweeps is not decided here, because this
 * function cannot see it: it is a pure question about one row. The sweep claims
 * the row with a conditional update before polling, the same way the job queue
 * claims a job, and that claim is what makes two runners produce one poll.
 */
export function trackingPollPolicy(input: TrackingPollInput, now: Date): TrackingPollDecision {
  const failures = Math.max(0, input.trackingSyncFailures);

  // The base cadence, stretched by however many times in a row we have failed.
  // A provider that is down should be asked less often, not more.
  const base = isTrackingComplete(input.trackingStatus) ? TRACKING_POLL.completeMs : TRACKING_POLL.activeMs;
  const intervalMs = Math.min(base * 2 ** Math.min(failures, 8), TRACKING_POLL.maxBackoffMs);

  if (input.bookingOutcomeUnknownAt) {
    return {
      due: false,
      reason:
        "The booking outcome is unknown, so there is no provider shipment to poll. " +
        "Resolve the booking before tracking it.",
      intervalMs,
    };
  }
  const pollable = Boolean(input.providerShipmentId || input.trackingNumber);
  if (!pollable) {
    return {
      due: false,
      reason: "No provider shipment id or tracking number to poll yet.",
      intervalMs,
    };
  }
  // The attempt time, not the success time: a run of failures must stretch the
  // next attempt even when the carrier has never answered, which is exactly the
  // row that has no lastTrackingSyncAt.
  const lastAttemptAt = input.lastTrackingAttemptAt ?? input.lastTrackingSyncAt;
  if (lastAttemptAt) {
    const waitUntil = lastAttemptAt.getTime() + intervalMs;
    if (now.getTime() < waitUntil) {
      return {
        due: false,
        reason: `Next check ${new Date(waitUntil).toISOString().slice(0, 16).replace("T", " ")}Z`,
        intervalMs,
      };
    }
  }
  return { due: true, reason: null, intervalMs };
}

/* -------------------------------------------------------------------------- */
/* §9 pickups: when a window has been and gone                                */
/* -------------------------------------------------------------------------- */

/**
 * The instant a pickup window closes, in the dock's own time zone.
 *
 * WHY THIS IS ARITHMETIC AND NOT A GUESS. §9 asks for missed pickup windows to
 * be flagged, and a window is missed when the carrier's own closing time has
 * passed without a collection. The closing time is local to the dock — "17:00"
 * at a Toronto warehouse is 21:00 UTC in summer and 22:00 in winter — so the
 * same wall-clock time is a different instant depending on the date. Getting
 * this wrong by an hour flags pickups as missed while a truck is still coming,
 * which is worse than not flagging them at all.
 *
 * `pickupWindow` is free text because carriers return it that way. The closing
 * time is read from it when the text contains one, and when it does not the
 * deadline is the end of that local day: a window that says "before noon" has no
 * closing time to trust, and inventing one would be the same mistake in the
 * other direction.
 */
export function pickupDeadline(options: {
  scheduledFor: Date;
  pickupWindow?: string | null;
  timeZone?: string | null;
  /** End of the dock's day, used when the window names no closing time. */
  fallbackCloseTime?: string | null;
}): Date {
  const zone = options.timeZone || "UTC";
  const day = localDateIn(zone, options.scheduledFor);
  const close =
    closingTimeFrom(options.pickupWindow ?? null) ??
    closingTimeFrom(options.fallbackCloseTime ?? null) ??
    "23:59";
  return instantOfLocalTime(zone, day, close);
}

/** The last HH:MM in a phrase like "09:00-17:00" or "2pm to 5:30pm". */
export function closingTimeFrom(text: string | null): string | null {
  if (!text) return null;
  const times: string[] = [];
  const twentyFour = /(\d{1,2}):(\d{2})/g;
  let match: RegExpExecArray | null;
  while ((match = twentyFour.exec(text)) !== null) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours < 24 && minutes < 60) times.push(`${String(hours).padStart(2, "0")}:${match[2]}`);
  }
  const twelve = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/gi;
  while ((match = twelve.exec(text)) !== null) {
    let hours = Number(match[1]) % 12;
    if (match[3].toLowerCase() === "p") hours += 12;
    const minutes = Number(match[2] ?? "0");
    if (minutes < 60) times.push(`${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`);
  }
  if (times.length === 0) return null;
  return times[times.length - 1];
}

/** The calendar date (YYYY-MM-DD) it is right now in a zone. */
export function localDateIn(timeZone: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * The instant that a wall-clock time on a wall-clock date in a zone refers to.
 *
 * Two passes, because the zone's offset depends on the instant being computed:
 * the first guess uses the offset at the day's start, and the second re-reads the
 * offset at that guess. One correction is enough for every zone with a one-hour
 * DST step, and a zone with no DST converges on the first pass.
 */
export function instantOfLocalTime(timeZone: string, date: string, time: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  if (!year || !month || !day) return new Date(Date.UTC(1970, 0, 1, hours || 0, minutes || 0));

  const asUtc = Date.UTC(year, month - 1, day, hours || 0, minutes || 0);
  let guess = asUtc - zoneOffsetMs(timeZone, new Date(asUtc));
  guess = asUtc - zoneOffsetMs(timeZone, new Date(guess));
  return new Date(guess);
}

/** The zone's offset from UTC, in milliseconds, at a given instant. */
export function zoneOffsetMs(timeZone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    if (!match) return 0;
    const sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  } catch {
    return 0;
  }
}

/**
 * Whether a scheduled pickup's window has closed without the carrier collecting.
 *
 * Deliberately NOT an inference about delivery: §7 forbids deducing a delivery
 * from elapsed time, and this does the opposite of that — it flags that
 * something which was supposed to happen did not, so a person can look. It never
 * cancels anything; a missed window is a fact to act on, not a state to clean up.
 */
export function pickupWindowMissed(
  pickup: {
    pickupStatus: string | null;
    pickupScheduledFor: Date | null;
    pickupWindow?: string | null;
    trackingStatus?: string | null;
    timeZone?: string | null;
    pickupCloseTime?: string | null;
  },
  now: Date
): boolean {
  if (pickup.pickupStatus !== "SCHEDULED") return false;
  if (!pickup.pickupScheduledFor) return false;
  // If the carrier has already reported a collection, the window was met, no
  // matter what the clock says.
  if (pickup.trackingStatus && ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"].includes(pickup.trackingStatus)) {
    return false;
  }
  const deadline = pickupDeadline({
    scheduledFor: pickup.pickupScheduledFor,
    pickupWindow: pickup.pickupWindow,
    timeZone: pickup.timeZone,
    fallbackCloseTime: pickup.pickupCloseTime,
  });
  return now.getTime() > deadline.getTime();
}

/* -------------------------------------------------------------------------- */
/* §8 Shopify fulfillment: what exactly is being fulfilled                     */
/* -------------------------------------------------------------------------- */

/**
 * THE PHYSICAL DISPATCH MILESTONE.
 *
 * Shopify's `fulfillmentCreate` is not a status update: it fulfills the named
 * line items, sends the customer "your order is on its way" when asked to
 * notify, and consumes the remaining quantity that other shipments were going
 * to use. It means the parcel has LEFT, so it is only ever called at a point
 * where that is true.
 *
 * The milestone is handed-to-carrier (or the equivalent "shipped" stamp). Not
 * the booking, not the label, not the packing: a label in a drawer is not a
 * parcel on a truck, and §8 says so in as many words — "label booking alone must
 * not be presented as carrier pickup".
 *
 * A manually recorded shipment is at the milestone by definition: somebody
 * wrote down a carrier and a tracking number for a parcel that is already away.
 */
export const FULFILLMENT_MILESTONE_EVENTS: readonly string[] = ["handed_to_carrier", "shipped"];

export function isFulfillmentMilestone(event: string): boolean {
  return FULFILLMENT_MILESTONE_EVENTS.includes(event);
}

/** One line of a shipment, as the order records it. */
export interface ShipmentFulfillmentLine {
  shopifyLineItemId: string | null;
  sku: string;
  quantity: number;
}

/** One line of a Shopify fulfillment order, as Shopify reports it. */
export interface FulfillmentOrderLine {
  fulfillmentOrderLineItemId: string;
  lineItemId: string | null;
  sku: string | null;
  remainingQuantity: number;
}

export interface FulfillmentLineMatch {
  /** What goes in `fulfillmentOrderLineItems`, already capped. */
  lines: { id: string; quantity: number }[];
  /** Lines that could not be placed, each with the reason, for the operator. */
  unmatched: { sku: string; quantity: number; reason: string }[];
  /**
   * Quantity that was asked for but cannot be fulfilled because Shopify says
   * less remains. Non-zero means another shipment already consumed it, which is
   * a fact the operator has to see rather than have silently dropped.
   */
  shortfall: { sku: string; requested: number; available: number }[];
}

/**
 * Work out WHICH Shopify line items a shipment fulfills, and how many of each.
 *
 * WHY THIS EXISTS. The push used to send `lineItemsByFulfillmentOrder:
 * [{ fulfillmentOrderId }]` and nothing else, which Shopify reads as "fulfill
 * everything still outstanding on this fulfillment order". An order of five
 * pillows shipped as two parcels was therefore marked fully fulfilled by the
 * first parcel: the customer was told the whole order had gone, the remaining
 * three units were no longer fulfillable, and the second parcel had nothing left
 * to fulfill. §8 forbids exactly that, and the fix is to name the quantities.
 *
 * IDENTITY IS THE LINE ITEM ID, NOT THE SKU. The SKU is a fallback for orders
 * whose items predate the line-item id being stored, and it is deliberately
 * second: a seller may reuse a SKU across variants, and matching on it would
 * fulfill the wrong line. A line that matches nothing is reported, never assumed
 * — assuming is how the whole order gets fulfilled by accident.
 */
export function matchFulfillmentLines(
  shipmentLines: readonly ShipmentFulfillmentLine[],
  fulfillmentOrderLines: readonly FulfillmentOrderLine[]
): FulfillmentLineMatch {
  const result: FulfillmentLineMatch = { lines: [], unmatched: [], shortfall: [] };

  // Shopify sends a global id ("gid://shopify/LineItem/123"); the order stores
  // the bare number. Compare the identifying part so the two can meet.
  const numeric = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const match = /(\d+)\s*$/.exec(value.trim());
    return match ? match[1] : null;
  };

  const claimed = new Set<string>();
  const byNumericId = new Map<string, FulfillmentOrderLine>();
  const bySku = new Map<string, FulfillmentOrderLine>();
  for (const line of fulfillmentOrderLines) {
    const id = numeric(line.lineItemId) ?? numeric(line.fulfillmentOrderLineItemId);
    if (id) byNumericId.set(id, line);
    if (line.sku) bySku.set(line.sku.toUpperCase(), line);
  }

  for (const wanted of shipmentLines) {
    if (wanted.quantity <= 0) continue;

    const wantedId = numeric(wanted.shopifyLineItemId);
    let match = wantedId ? byNumericId.get(wantedId) : undefined;
    if (!match && wanted.sku) match = bySku.get(wanted.sku.toUpperCase());

    if (!match) {
      result.unmatched.push({
        sku: wanted.sku,
        quantity: wanted.quantity,
        reason: wantedId
          ? "No line on the Shopify fulfillment order carries this line item id."
          : "This order line has no Shopify line item id and its SKU matches no line on the fulfillment order.",
      });
      continue;
    }
    if (claimed.has(match.fulfillmentOrderLineItemId)) continue;
    claimed.add(match.fulfillmentOrderLineItemId);

    const available = Math.max(0, match.remainingQuantity);
    const quantity = Math.min(wanted.quantity, available);
    if (quantity < wanted.quantity) {
      result.shortfall.push({ sku: wanted.sku, requested: wanted.quantity, available });
    }
    if (quantity > 0) result.lines.push({ id: match.fulfillmentOrderLineItemId, quantity });
  }

  return result;
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
