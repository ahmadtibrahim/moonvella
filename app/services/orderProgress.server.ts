/**
 * Where a parcel has got to, as a sequence rather than as a status.
 *
 * WHY THIS IS NOT `shipment.status`. The status column answers "what is the
 * parcel doing now" and it is the right answer for machinery. An operator
 * looking at a screen is asking a different question: what has happened, in what
 * order, when, and by whom — and what is the next thing that has to happen. A
 * single word cannot say that, and the six facts it takes to say it are spread
 * across timestamps, an audit log and two failure columns.
 *
 * THE STAGES ARE FIXED AND IN ORDER, and the order is the physical order of the
 * work: a rate is chosen, a label is bought, the box is packed, the box leaves,
 * Shopify is told, the box arrives. Reading them left to right is reading the
 * parcel's life.
 *
 * ONE CORRECTION WORTH KNOWING. Shopify is told at the HANDED-TO-CARRIER
 * milestone and not at the booking, because creating the fulfillment is what
 * marks the items fulfilled in Shopify — a purchased label is not a collected
 * parcel, and an order fulfilled before the carrier has the box is an order that
 * tells the customer it shipped when it did not.
 *
 * THE FUNCTION IS PURE. It takes the rows and returns the stages, so the rules
 * below can be checked without a database and without a page — which matters
 * because the interesting cases (a refused booking, a sync that failed, a
 * shipment with no tracking yet) are each one branch and none of them is
 * reachable by clicking around a working system.
 */

import { prisma } from "~/db.server";

export type ProgressState = "done" | "current" | "pending" | "failed" | "unknown";

export interface ProgressStage {
  key: string;
  label: string;
  state: ProgressState;
  /** When it happened, ISO. Null while it has not. */
  at: string | null;
  /** Who did it, as the audit row named them. Null when nobody did. */
  actor: string | null;
  /** What it produced, in the operator's words. Never invented. */
  detail: string | null;
  /**
   * What can be done about this stage, when something can.
   *
   * `kind` names WHICH action rather than where it is, so this module stays a
   * statement about shipping and not about a page. The caller decides what a
   * "booking" action is on its own screen — and on both screens that is a link
   * to the one confirmation panel, never a second form, because a booking retry
   * that is its own form is a second way to spend money without being asked.
   *
   * A stage with `kind: "reconcile"` gets no button at all. There is no safe
   * automatic answer to an unanswered booking, and offering one would be
   * offering the second label this whole branch exists to prevent.
   */
  retry: { kind: "booking" | "shopify_sync" | "reconcile"; label: string; note: string } | null;
}

export interface ProgressEvent {
  action: string;
  at: Date;
  actorName: string | null;
  entityId: string;
}

export interface ProgressShipment {
  id: string;
  status: string;
  trackingNumber: string | null;
  carrier: string | null;
  serviceName: string | null;
  labelCreatedAt: Date | null;
  packedAt: Date | null;
  handedToCarrierAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  shopifySyncedAt: Date | null;
  shopifyFulfillmentId: string | null;
  shopifySyncError: string | null;
  lastBookingError: string | null;
  bookingOutcomeUnknownAt: Date | null;
}

export interface ProgressInput {
  /** Null for an order that has no shipment yet — the stages still apply. */
  shipment: ProgressShipment | null;
  /** The order's selected quote, if one is selected. */
  selectedQuote: { carrier: string; serviceName: string } | null;
  /** Whether Shopify can be told at all. */
  hasFulfillmentOrder: boolean;
  /** Audit rows for this order and its shipments, in any order. */
  events: ProgressEvent[];
}

const STAGE_LABELS: [string, string][] = [
  ["rate_selected", "Rate selected"],
  ["label_booked", "Label booked"],
  ["packed", "Packed"],
  ["handed_to_carrier", "Handed to carrier"],
  ["tracking_sent", "Tracking sent to Shopify"],
  ["delivered", "Delivered"],
];

/** The actor on the newest matching audit row, or null if it was never audited. */
function actorOf(events: ProgressEvent[], action: string, entityId?: string): string | null {
  let best: ProgressEvent | null = null;
  for (const event of events) {
    if (event.action !== action) continue;
    if (entityId && event.entityId !== entityId) continue;
    if (!best || event.at > best.at) best = event;
  }
  return best?.actorName?.trim() || null;
}

/** When the newest matching audit row was written. Used only to date a stage
 *  whose own column is missing — never to claim a stage happened. */
function atOf(events: ProgressEvent[], action: string, entityId?: string): Date | null {
  let best: Date | null = null;
  for (const event of events) {
    if (event.action !== action) continue;
    if (entityId && event.entityId !== entityId) continue;
    if (!best || event.at > best) best = event.at;
  }
  return best;
}

export function shipmentProgress(input: ProgressInput): ProgressStage[] {
  const { shipment, selectedQuote, hasFulfillmentOrder, events } = input;
  const stages: ProgressStage[] = STAGE_LABELS.map(([key, label]) => ({
    key,
    label,
    state: "pending" as ProgressState,
    at: null,
    actor: null,
    detail: null,
    retry: null,
  }));
  const by = new Map(stages.map((stage) => [stage.key, stage]));

  /* --- rate selected ------------------------------------------------------ */
  const rate = by.get("rate_selected")!;
  if (selectedQuote) {
    rate.state = "done";
    rate.detail = `${selectedQuote.carrier} ${selectedQuote.serviceName}`.trim();
    const at = atOf(events, "shipping.quote_selected");
    rate.at = at?.toISOString() ?? null;
    rate.actor = actorOf(events, "shipping.quote_selected");
  }

  /* --- label booked ------------------------------------------------------- */
  const booked = by.get("label_booked")!;
  if (shipment?.labelCreatedAt) {
    booked.state = "done";
    booked.at = shipment.labelCreatedAt.toISOString();
    booked.actor = actorOf(events, "shipping.booked", shipment.id);
    booked.detail = [shipment.carrier, shipment.serviceName].filter(Boolean).join(" ") || null;
  } else if (shipment?.status === "BOOKING_FAILED") {
    /*
     * A refusal is the one failure that is SAFE TO RETRY, because the provider
     * said no and nothing was bought. The stage says so rather than leaving the
     * operator to infer it from a status word.
     */
    booked.state = "failed";
    booked.at = shipment.lastBookingError ? (atOf(events, "shipping.booked", shipment.id)?.toISOString() ?? null) : null;
    booked.detail = shipment.lastBookingError;
    booked.retry = {
      kind: "booking",
      label: "Retry booking",
      note: "The carrier refused and nothing was purchased, so booking again cannot buy a second label.",
    };
  } else if (shipment?.status === "BOOKING_UNKNOWN" || shipment?.bookingOutcomeUnknownAt) {
    /*
     * The provider was asked and never answered. Deliberately NOT offered as a
     * retry: a second booking could buy a second label for a parcel that already
     * has one.
     */
    booked.state = "unknown";
    booked.at = shipment.bookingOutcomeUnknownAt?.toISOString() ?? null;
    booked.detail =
      "The carrier did not answer, so whether a label exists is unknown. Reconcile before booking anything.";
    booked.retry = {
      kind: "reconcile",
      label: "Reconcile with the carrier",
      note: "Do not retry: a booking that was never answered may already have been purchased.",
    };
  }

  /* --- packed ------------------------------------------------------------- */
  const packed = by.get("packed")!;
  if (shipment?.packedAt) {
    packed.state = "done";
    packed.at = shipment.packedAt.toISOString();
    packed.actor = actorOf(events, "shipment.packed", shipment.id);
  }

  /* --- handed to carrier -------------------------------------------------- */
  const handed = by.get("handed_to_carrier")!;
  /*
   * `shippedAt` counts. An operator recording "shipped" straight from packed is
   * describing the same physical event, and a progression that refused to
   * advance because they used the other word would be asking them to go back and
   * press the first button.
   */
  const handoff = shipment?.handedToCarrierAt ?? shipment?.shippedAt ?? null;
  if (handoff) {
    handed.state = "done";
    handed.at = handoff.toISOString();
    handed.actor =
      actorOf(events, "shipment.handed_to_carrier", shipment!.id) ?? actorOf(events, "shipment.shipped", shipment!.id);
  }

  /* --- tracking sent to Shopify ------------------------------------------- */
  const sent = by.get("tracking_sent")!;
  if (shipment?.shopifyFulfillmentId) {
    sent.state = "done";
    sent.at = shipment.shopifySyncedAt?.toISOString() ?? null;
    sent.actor = actorOf(events, "shipping.shopify_fulfilled", shipment.id);
    sent.detail = "Shopify holds the fulfillment for this parcel.";
  } else if (shipment?.shopifySyncError) {
    sent.state = "failed";
    sent.detail = shipment.shopifySyncError;
    sent.retry = {
      kind: "shopify_sync",
      label: "Retry Shopify sync",
      note: "This reuses the shipment and its tracking. It does not buy another label.",
    };
  } else if (shipment?.trackingNumber && !hasFulfillmentOrder) {
    /*
     * Not a failure and not a wait: this order can never be pushed to, and
     * saying "waiting" about something that will never happen is how an operator
     * keeps checking a page instead of fixing the order.
     */
    sent.state = "unknown";
    sent.detail = "This order has no Shopify fulfillment order, so its tracking cannot be pushed.";
  } else if (shipment?.trackingNumber) {
    /*
     * THE WAIT THAT MATTERS (§2). The label is bought and the tracking number is
     * recorded here already; Shopify is told when the parcel is handed over, so
     * between those two moments this is what the stage is waiting for — and
     * saying so is the difference between "nothing has happened" and "the next
     * thing has not happened yet".
     *
     * UNLESS THE PARCEL HAS ALREADY GONE. Past the handover this is no longer a
     * wait, it is an outstanding push — and saying "waiting for dispatch" about a
     * box that left yesterday would send an operator to look at the dock instead
     * of at the sync. The two cases are told apart by the same timestamp the
     * stage above uses.
     */
    const handedOver = Boolean(shipment.handedToCarrierAt ?? shipment.shippedAt);
    sent.detail = handedOver
      ? "This parcel has been handed to the carrier and Shopify has no fulfillment for it. Push the tracking again."
      : `Waiting for dispatch. Tracking ${shipment.trackingNumber} is recorded here and will be sent to Shopify when this parcel is handed to the carrier.`;
    if (handedOver) {
      sent.retry = {
        kind: "shopify_sync",
        label: "Send tracking to Shopify",
        note: "This reuses the shipment and its tracking. It does not buy another label.",
      };
    }
  }

  /* --- delivered ---------------------------------------------------------- */
  const delivered = by.get("delivered")!;
  if (shipment?.deliveredAt) {
    delivered.state = "done";
    delivered.at = shipment.deliveredAt.toISOString();
    delivered.actor = actorOf(events, "shipment.delivered", shipment.id);
  }

  /*
   * THE CURSOR. The first stage that has not happened is where the parcel is,
   * and everything after it is still ahead. A stage that FAILED is where the
   * parcel is too — it is stuck there until somebody acts — so it stops the
   * cursor as well rather than letting a later stage claim to be current.
   */
  let cursor = false;
  for (const stage of stages) {
    if (stage.state === "done") continue;
    if (!cursor && stage.state === "pending") {
      stage.state = "current";
    }
    cursor = true;
  }

  return stages;
}

/* -------------------------------------------------------------------------- */
/* Reading it back out of the database                                        */
/* -------------------------------------------------------------------------- */

/*
 * Everything the builder needs, and nothing else. Written as an explicit
 * `select` rather than an `include` for the usual reason and one more: the
 * progression is drawn on a page that already loads a great deal, and a select
 * keeps it honest about how much it costs to know where a parcel is.
 */
const SHIPMENT_COLUMNS = {
  id: true,
  status: true,
  trackingNumber: true,
  carrier: true,
  serviceName: true,
  labelCreatedAt: true,
  packedAt: true,
  handedToCarrierAt: true,
  shippedAt: true,
  deliveredAt: true,
  shopifySyncedAt: true,
  shopifyFulfillmentId: true,
  shopifySyncError: true,
  lastBookingError: true,
  bookingOutcomeUnknownAt: true,
} as const;

/**
 * Where every parcel on this order has got to.
 *
 * ONE PROGRESSION PER SHIPMENT, because a split order is two parcels on two
 * journeys and a single bar would have to lie about one of them. The order-level
 * facts — the rate that was chosen, whether Shopify can be told at all — are
 * passed into each, so an order with no shipment yet still draws the six stages
 * with the first of them complete.
 *
 * The audit rows are read once for the whole order and matched by entity id,
 * which is how a stage gets an actor: the timestamps say WHEN, and only the log
 * says WHO.
 */
export async function orderProgress(orderId: string): Promise<{ shipmentId: string | null; stages: ProgressStage[] }[]> {
  const [order, shipments] = await Promise.all([
    prisma.order.findUnique({
      where: { id: orderId },
      select: {
        shopifyFulfillmentOrderId: true,
        shippingQuotes: { where: { selected: true }, select: { carrier: true, serviceName: true }, take: 1 },
      },
    }),
    prisma.shipment.findMany({
      where: { orderId },
      select: SHIPMENT_COLUMNS,
      orderBy: { createdAt: "asc" },
    }),
  ]);

  if (!order) return [];

  const events = await prisma.auditLog.findMany({
    where: {
      /*
       * Both spellings of "about this order". The order's own rows carry the
       * order id and the shipment's rows carry the shipment id, and a stage can
       * be dated by either — the six stages are not all recorded against the
       * same entity.
       */
      OR: [
        { entityType: "ORDER", entityId: orderId },
        { entityType: "SHIPMENT", entityId: { in: shipments.map((shipment) => shipment.id) } },
      ],
    },
    // Newest first, and capped: the builder wants the newest row per action, and
    // a shipment that has been polled for a year has thousands of tracking rows
    // that say nothing about these six stages.
    orderBy: { createdAt: "desc" },
    take: 400,
    select: { action: true, createdAt: true, actorName: true, entityId: true },
  });

  const progressEvents: ProgressEvent[] = events.map((event) => ({
    action: event.action,
    at: event.createdAt,
    actorName: event.actorName,
    entityId: event.entityId,
  }));

  const selectedQuote = order.shippingQuotes[0] ?? null;
  const hasFulfillmentOrder = Boolean(order.shopifyFulfillmentOrderId);

  /*
   * With no shipment yet, the stages are still drawn once — from the order
   * alone. That is the state an operator is in for most of an order's life, and
   * "no parcels yet" would be a worse answer than showing how far the order got.
   */
  if (shipments.length === 0) {
    return [{ shipmentId: null, stages: shipmentProgress({ shipment: null, selectedQuote, hasFulfillmentOrder, events: progressEvents }) }];
  }

  return shipments.map((shipment) => ({
    shipmentId: shipment.id,
    stages: shipmentProgress({ shipment, selectedQuote, hasFulfillmentOrder, events: progressEvents }),
  }));
}
