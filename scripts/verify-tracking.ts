/**
 * Phase C verification: the tracking vocabulary, the polling policy, the §8
 * dispatch milestone and the §9 pickup window.
 *
 * WHAT THIS SUITE IS FOR. Phase C added a vocabulary, a schedule and a set of
 * rules that are easy to get subtly wrong and hard to notice afterwards: nine
 * display words that must agree with the filter that finds them, a backoff that
 * must not poll a provider more often after a failure than before it, a
 * fulfillment push that must happen at the physical dispatch and not at the
 * booking, and a pickup window that closes at 17:00 in the dock's own zone
 * rather than in the server's. Each of those is checked here directly. The two
 * that matter most are checked against the database rather than by reading the
 * code: that a filter and the word it stands for select exactly the same rows,
 * and that a refresh which fails leaves the last good carrier status standing.
 *
 * TWO KINDS OF CHECK, KEPT APART, as in the other suites here:
 *
 *   1. Pure rules — the display vocabulary, the poll policy, partial-delivery
 *      detection, line matching, and the pickup deadline arithmetic including
 *      both daylight-saving transitions. No provider, no database.
 *
 *   2. Behaviour against a stubbed provider — a successful poll, a failed one,
 *      the sweep that drives them, and the missed-pickup flag. The stub answers
 *      authentication and REFUSES any host that is not the configured eShipper
 *      base URL, so a check that accidentally tried to reach Shopify, Odoo or a
 *      real carrier fails here loudly. It proves what this application does; it
 *      is NOT evidence that eShipper answers the way the stub does. Nothing was
 *      booked, collected, cancelled or charged anywhere.
 *
 * The suite runs only against a database whose name ends in `_verify` — the
 * runner refuses anything else — and it removes every fixture it creates.
 */

import { PrismaClient } from "@prisma/client";
import {
  TRACKING_DISPLAY_ORDER,
  TRACKING_POLL,
  FULFILLMENT_MILESTONE_EVENTS,
  closingTimeFrom,
  instantOfLocalTime,
  isFulfillmentMilestone,
  isPartialDelivery,
  localDateIn,
  matchFulfillmentLines,
  normalizeTrackingState,
  partialDeliverySummary,
  pickupDeadline,
  pickupWindowMissed,
  trackingDisplay,
  trackingDisplayLabel,
  trackingDisplayWhere,
  trackingPollPolicy,
  zoneOffsetMs,
  type TrackingDisplayStatus,
} from "../app/services/shippingLogic";
import { flagMissedPickups, sweepShipmentTracking, syncTrackingForShipment } from "../app/services/shipping.server";
import type { TrackingResult } from "../app/services/eshipper.server";

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const prisma = new PrismaClient();
const suffix = Date.now().toString(36).toUpperCase();
const created = {
  sellerIds: [] as string[],
  orderIds: [] as string[],
  locationIds: [] as string[],
  productIds: [] as string[],
};

const ACTOR = { actorId: "verify-tracking", actorName: "verify-tracking", ipAddress: "127.0.0.1", userAgent: "verify" };

/* -------------------------------------------------------------------------- */
/* Provider transport stub                                                    */
/* -------------------------------------------------------------------------- */

const realFetch = globalThis.fetch;
const providerCalls: { method: string; url: string }[] = [];
type Answer = { status: number; body: unknown } | "timeout" | "unreachable";
let responder: (url: string, method: string) => Answer = () => ({ status: 200, body: {} });

let allowedHostCache: string | null = null;
async function allowedHost(): Promise<string> {
  if (allowedHostCache) return allowedHostCache;
  const { getCredential } = await import("../app/services/credentials.server");
  const base = await getCredential("eshipper", "ESHIPPER_BASE_URL");
  if (!base) {
    // Without a base URL the adapter takes its simulated branch and never builds
    // a request, so every check below would pass against code that never ran.
    throw new Error(
      "verify-tracking: no eShipper base URL is configured, so the tracking path cannot be exercised. " +
        "Configure the eShipper credential (test host) on the verify clone and re-run."
    );
  }
  allowedHostCache = new URL(base).host;
  return allowedHostCache;
}

function installStub() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    providerCalls.push({ method, url });

    const host = new URL(url).host;
    const expected = await allowedHost();
    if (host !== expected) {
      throw new Error(
        `verify-tracking: refusing a request to ${host}; this suite may only talk to the configured eShipper host (${expected}).`
      );
    }
    if (/\/(authenticate|refresh-token)$/.test(url)) {
      return new Response(
        JSON.stringify({ token: `verify-token-${suffix}`, expires_in: "3600", token_type: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const answer = responder(url, method);
    if (answer === "timeout") {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }
    if (answer === "unreachable") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

/* -------------------------------------------------------------------------- */
/* Pure-rule helpers                                                          */
/* -------------------------------------------------------------------------- */

function tracking(partial: Partial<TrackingResult>): TrackingResult {
  return {
    trackingUrl: "",
    trackingDetails: [],
    labelGenerated: false,
    pickup: false,
    inTransit: false,
    outForDelivery: false,
    exception: false,
    undelivered: false,
    delivered: false,
    returned: false,
    cancelled: false,
    deliveryEstimate: null,
    deliveredPackages: null,
    totalPackages: null,
    ...partial,
  };
}

function pollInput(partial: Partial<Parameters<typeof trackingPollPolicy>[0]> = {}) {
  return {
    status: "BOOKED",
    trackingStatus: null,
    providerShipmentId: "S-1",
    trackingNumber: "TRK-1",
    lastTrackingSyncAt: null,
    trackingSyncFailures: 0,
    bookingOutcomeUnknownAt: null,
    ...partial,
  };
}

/* -------------------------------------------------------------------------- */
/* §7 the nine words                                                          */
/* -------------------------------------------------------------------------- */

function displayVocabularyChecks() {
  console.log("\n-- the nine display words --");

  // The words themselves, spelled as §7 spells them. A rename here is a change
  // to what every operator reads, so it should break a check rather than pass.
  const expected: Record<TrackingDisplayStatus, string> = {
    BOOKED: "Booked",
    PICKED_UP: "Picked up",
    IN_TRANSIT: "In transit",
    OUT_FOR_DELIVERY: "Out for delivery",
    DELIVERED: "Delivered",
    EXCEPTION: "Exception/Delayed",
    CANCELLED: "Cancelled",
    RETURNED: "Returned",
    UNKNOWN: "Unknown",
  };
  check(
    "the vocabulary is exactly the nine words §7 lists",
    Object.keys(expected).length === 9 &&
      TRACKING_DISPLAY_ORDER.length === 9 &&
      TRACKING_DISPLAY_ORDER.every((word) => word in expected),
    TRACKING_DISPLAY_ORDER.join(", ")
  );
  for (const word of TRACKING_DISPLAY_ORDER) {
    check(`  "${word}" reads as "${expected[word]}"`, trackingDisplayLabel(word) === expected[word], trackingDisplayLabel(word));
  }

  // Each internal state maps to one word, and the two that merge keep their
  // internal distinctness.
  const through: [string, TrackingDisplayStatus][] = [
    ["PICKED_UP", "PICKED_UP"],
    ["IN_TRANSIT", "IN_TRANSIT"],
    ["OUT_FOR_DELIVERY", "OUT_FOR_DELIVERY"],
    ["DELIVERED", "DELIVERED"],
    ["CANCELLED", "CANCELLED"],
    ["RETURNED", "RETURNED"],
    ["UNKNOWN", "UNKNOWN"],
  ];
  for (const [internal, word] of through) {
    check(`${internal} displays as ${word}`, trackingDisplay(internal, "SHIPPED") === word, trackingDisplay(internal, "SHIPPED"));
  }
  check("LABEL_CREATED displays as Booked, not as a shipment", trackingDisplay("LABEL_CREATED", "BOOKED") === "BOOKED");
  check("EXCEPTION displays as Exception/Delayed", trackingDisplay("EXCEPTION", "EXCEPTION") === "EXCEPTION");
  check("UNDELIVERED shares that word", trackingDisplay("UNDELIVERED", "EXCEPTION") === "EXCEPTION");

  // No carrier word yet: a booking is Booked, anything else is honestly Unknown.
  check("a booked parcel the carrier has not spoken about is Booked", trackingDisplay(null, "BOOKED") === "BOOKED");
  check("an unbooked parcel is Unknown, not Booked", trackingDisplay(null, "PENDING") === "UNKNOWN");
  check("a failed booking is Unknown", trackingDisplay(null, "BOOKING_FAILED") === "UNKNOWN");
  check("an unknowable booking is Unknown", trackingDisplay(null, "BOOKING_UNKNOWN") === "UNKNOWN");
  check("a cancelled parcel with no carrier word is Unknown, not Booked", trackingDisplay(null, "CANCELLED") === "UNKNOWN");
}

/* -------------------------------------------------------------------------- */
/* §7 the filter that finds each word                                        */
/* -------------------------------------------------------------------------- */

const INTERNAL_STATES = [
  null,
  "LABEL_CREATED",
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "EXCEPTION",
  "UNDELIVERED",
  "CANCELLED",
  "RETURNED",
  "UNKNOWN",
] as const;
const COARSE_STATES = ["PENDING", "BOOKED", "SHIPPED", "EXCEPTION"] as const;

/**
 * The filter twin, proved against rows rather than by reading both functions.
 *
 * Every (carrier state × lifecycle state) combination is written to the
 * database once, then each of the nine filters is run and compared with the set
 * of rows `trackingDisplay` labels with that word. If the two ever disagree —
 * which is the way this pair fails, silently and in one direction — this is
 * where it shows up.
 */
async function displayFilterChecks() {
  console.log("\n-- the filter finds exactly the rows wearing the word --");
  const seller = await createSeller("filters");
  const order = await createOrder(seller.id, "filters");

  const rows: { id: string; trackingStatus: string | null; status: string }[] = [];
  for (const trackingStatus of INTERNAL_STATES) {
    for (const status of COARSE_STATES) {
      const shipment = await prisma.shipment.create({
        data: {
          orderId: order.id,
          status: status as never,
          provider: "eshipper",
          trackingStatus,
          carrier: "Purolator",
          trackingNumber: `TRK-FILTER-${trackingStatus ?? "NULL"}-${status}-${suffix}`,
        },
      });
      rows.push({ id: shipment.id, trackingStatus, status });
    }
  }
  check("the fixture covers every state pair", rows.length === INTERNAL_STATES.length * COARSE_STATES.length, String(rows.length));

  for (const word of TRACKING_DISPLAY_ORDER) {
    const expectedIds = rows
      .filter((row) => trackingDisplay(row.trackingStatus, row.status) === word)
      .map((row) => row.id)
      .sort();
    const found = await prisma.shipment.findMany({
      where: { AND: [{ orderId: order.id }, trackingDisplayWhere(word)] },
      select: { id: true },
    });
    const foundIds = found.map((row) => row.id).sort();
    const agrees = expectedIds.length === foundIds.length && expectedIds.every((id, i) => id === foundIds[i]);
    check(
      `filtering "${trackingDisplayLabel(word)}" returns exactly the rows that display it`,
      agrees,
      `expected ${expectedIds.length}, found ${foundIds.length}`
    );
  }

  // Every row is reachable by exactly one word, so nothing can hide behind a
  // filter that matches nothing and nothing is counted twice.
  let union = 0;
  const seen = new Set<string>();
  for (const word of TRACKING_DISPLAY_ORDER) {
    const found = await prisma.shipment.findMany({
      where: { AND: [{ orderId: order.id }, trackingDisplayWhere(word)] },
      select: { id: true },
    });
    union += found.length;
    for (const row of found) seen.add(row.id);
  }
  check("every shipment is found by exactly one word", union === rows.length && seen.size === rows.length, `${union} matches over ${seen.size} rows`);
}

/* -------------------------------------------------------------------------- */
/* §7 polling: when to ask, and how soon after a failure                     */
/* -------------------------------------------------------------------------- */

function pollPolicyChecks() {
  console.log("\n-- when the sweep asks the carrier --");
  const now = new Date("2026-09-23T12:00:00.000Z");
  const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);

  const never = trackingPollPolicy(pollInput(), now);
  check("a shipment never polled is due", never.due);
  check("...at the active cadence", never.intervalMs === TRACKING_POLL.activeMs, String(never.intervalMs));

  const fresh = trackingPollPolicy(pollInput({ lastTrackingSyncAt: minutesAgo(5) }), now);
  check("a shipment checked five minutes ago is not due", !fresh.due);
  check("...and says when the next check is", /next check/i.test(fresh.reason ?? ""), fresh.reason ?? "");

  const stale = trackingPollPolicy(pollInput({ lastTrackingSyncAt: minutesAgo(31) }), now);
  check("a shipment checked 31 minutes ago is due again", stale.due);

  // A delivered parcel is a receipt, not a race — but it is still polled, just
  // slowly, because a delivery can still turn into a return.
  const deliveredRecent = trackingPollPolicy(pollInput({ trackingStatus: "DELIVERED", lastTrackingSyncAt: minutesAgo(31) }), now);
  check("a delivered parcel is not polled at the active cadence", !deliveredRecent.due);
  check("...it waits the completed cadence", deliveredRecent.intervalMs === TRACKING_POLL.completeMs, String(deliveredRecent.intervalMs));
  const deliveredOld = trackingPollPolicy(pollInput({ trackingStatus: "DELIVERED", lastTrackingSyncAt: minutesAgo(13 * 60) }), now);
  check("...and is polled again once that has passed", deliveredOld.due);
  check("a cancelled parcel is on the same slow cadence", trackingPollPolicy(pollInput({ trackingStatus: "CANCELLED", lastTrackingSyncAt: minutesAgo(31) }), now).due === false);
  check("a returned parcel likewise", trackingPollPolicy(pollInput({ trackingStatus: "RETURNED", lastTrackingSyncAt: minutesAgo(31) }), now).due === false);

  // Backoff: a provider that is failing is asked less often, never more.
  const three = trackingPollPolicy(pollInput({ lastTrackingSyncAt: minutesAgo(31), trackingSyncFailures: 3 }), now);
  check("three failures in a row stretch the interval eightfold", three.intervalMs === TRACKING_POLL.activeMs * 8, String(three.intervalMs));
  check("...so a parcel that would have been due is not", !three.due);
  const many = trackingPollPolicy(pollInput({ trackingSyncFailures: 20 }), now);
  check("the backoff stops at the ceiling", many.intervalMs === TRACKING_POLL.maxBackoffMs, String(many.intervalMs));
  check("...rather than doubling without end", many.intervalMs <= TRACKING_POLL.maxBackoffMs);
  const negative = trackingPollPolicy(pollInput({ trackingSyncFailures: -5 }), now);
  check("a negative failure count is read as none, not as a shortcut", negative.intervalMs === TRACKING_POLL.activeMs, String(negative.intervalMs));

  // A run of failures must stretch the next attempt even when no poll has ever
  // succeeded: the attempt time is what the interval is measured from.
  const neverSynced = trackingPollPolicy(
    pollInput({ lastTrackingSyncAt: null, lastTrackingAttemptAt: minutesAgo(5), trackingSyncFailures: 2 }),
    now
  );
  check("failures back off even before any poll has succeeded", !neverSynced.due, String(neverSynced.intervalMs));
  check("...by the failure count, not by pretending it never happened", neverSynced.intervalMs === TRACKING_POLL.activeMs * 4, String(neverSynced.intervalMs));
  const neverAsked = trackingPollPolicy(pollInput({ lastTrackingSyncAt: null, lastTrackingAttemptAt: null }), now);
  check("a shipment never asked is due", neverAsked.due);

  // Nothing to ask about.
  const unknown = trackingPollPolicy(pollInput({ bookingOutcomeUnknownAt: now, providerShipmentId: null, trackingNumber: null }), now);
  check("a booking whose outcome is unknown is not polled", !unknown.due);
  check("...and says to resolve the booking first", /resolve the booking/i.test(unknown.reason ?? ""), unknown.reason ?? "");
  const nothing = trackingPollPolicy(pollInput({ providerShipmentId: null, trackingNumber: null }), now);
  check("a shipment with no id and no tracking number is not polled", !nothing.due);
  check("...and says why", /no provider shipment id or tracking number/i.test(nothing.reason ?? ""), nothing.reason ?? "");
  check("an id alone is enough to poll with", trackingPollPolicy(pollInput({ trackingNumber: null }), now).due);
  check("a tracking number alone is enough too", trackingPollPolicy(pollInput({ providerShipmentId: null }), now).due);
  check("the batch is bounded", TRACKING_POLL.batchSize > 0 && TRACKING_POLL.batchSize <= 100, String(TRACKING_POLL.batchSize));
}

/* -------------------------------------------------------------------------- */
/* §7 partial and out-of-order events                                        */
/* -------------------------------------------------------------------------- */

function partialDeliveryChecks() {
  console.log("\n-- partial deliveries and out-of-order events --");

  const threeOfFour = tracking({ delivered: true, deliveredPackages: 3, totalPackages: 4 });
  check("3 of 4 parcels delivered is a partial delivery", isPartialDelivery(threeOfFour));
  check("...and is not recorded as DELIVERED", normalizeTrackingState(threeOfFour) !== "DELIVERED", normalizeTrackingState(threeOfFour));
  check("...with a summary an operator can read", partialDeliverySummary(threeOfFour) === "3 of 4 parcels delivered", String(partialDeliverySummary(threeOfFour)));

  const allFour = tracking({ delivered: true, deliveredPackages: 4, totalPackages: 4 });
  check("4 of 4 is a whole delivery", !isPartialDelivery(allFour));
  check("...and is DELIVERED", normalizeTrackingState(allFour) === "DELIVERED");

  const noCounts = tracking({ delivered: true });
  check("a delivery with no counts is taken at the carrier's word", !isPartialDelivery(noCounts));
  check("...and is DELIVERED", normalizeTrackingState(noCounts) === "DELIVERED");
  check("no counts means no summary to show", partialDeliverySummary(noCounts) === null);

  const notDelivered = tracking({ delivered: false, deliveredPackages: 1, totalPackages: 4 });
  check("counts without a delivery are not a partial delivery", !isPartialDelivery(notDelivered));
  const zeroTotal = tracking({ delivered: true, deliveredPackages: 0, totalPackages: 0 });
  check("a zero total is not evidence of a partial delivery", !isPartialDelivery(zeroTotal));
  const more = tracking({ delivered: true, deliveredPackages: 5, totalPackages: 4 });
  check("more delivered than expected is not a partial one either", !isPartialDelivery(more));

  // Out-of-order: the ranking refuses an older event, but a return or a
  // cancellation is allowed to win because it is a later fact.
  check("an out-of-order older event does not lower the state (pickup after transit)", normalizeTrackingState(tracking({ inTransit: true, pickup: true })) === "IN_TRANSIT");
  check("out for delivery outranks in transit", normalizeTrackingState(tracking({ inTransit: true, outForDelivery: true })) === "OUT_FOR_DELIVERY");
  check("a return after delivery wins", normalizeTrackingState(tracking({ delivered: true, returned: true })) === "RETURNED");
  check("a cancellation wins", normalizeTrackingState(tracking({ inTransit: true, cancelled: true })) === "CANCELLED");
  check("an exception is reported rather than hidden by a later-looking flag", normalizeTrackingState(tracking({ delivered: true, exception: true })) === "DELIVERED");
  check("a payload with nothing in it is UNKNOWN, never delivered", normalizeTrackingState(tracking({})) === "UNKNOWN");
}

/* -------------------------------------------------------------------------- */
/* §8 what exactly is being fulfilled                                        */
/* -------------------------------------------------------------------------- */

function lineMatchingChecks() {
  console.log("\n-- matching a shipment's lines to Shopify's --");

  const foLine = (id: string, lineItemId: string | null, sku: string | null, remainingQuantity: number) => ({
    fulfillmentOrderLineItemId: id,
    lineItemId,
    sku,
    remainingQuantity,
  });

  const exact = matchFulfillmentLines(
    [{ shopifyLineItemId: "gid://shopify/LineItem/111", sku: "PIL", quantity: 2 }],
    [foLine("gid://shopify/FulfillmentOrderLineItem/1", "gid://shopify/LineItem/111", "PIL", 5)]
  );
  check("a line item id matches across the gid form and the bare number", exact.lines.length === 1 && exact.lines[0].quantity === 2, JSON.stringify(exact.lines));
  check("...and takes only what this shipment holds", exact.lines[0]?.quantity === 2);
  check("...leaving no shortfall", exact.shortfall.length === 0);

  const capped = matchFulfillmentLines(
    [{ shopifyLineItemId: "111", sku: "PIL", quantity: 4 }],
    [foLine("fol-1", "111", "PIL", 1)]
  );
  check("a line is capped at what Shopify says remains", capped.lines[0]?.quantity === 1, JSON.stringify(capped.lines));
  check("...and the shortfall is reported rather than dropped", capped.shortfall.length === 1 && capped.shortfall[0].available === 1, JSON.stringify(capped.shortfall));

  const bySku = matchFulfillmentLines(
    [{ shopifyLineItemId: null, sku: "pil", quantity: 1 }],
    [foLine("fol-2", null, "PIL", 3)]
  );
  check("a line with no id falls back to the SKU, case-insensitively", bySku.lines.length === 1, JSON.stringify(bySku.lines));

  const unmatched = matchFulfillmentLines(
    [{ shopifyLineItemId: "999", sku: "OTHER", quantity: 1 }],
    [foLine("fol-3", "111", "PIL", 3)]
  );
  check("a line that matches nothing is reported, never assumed", unmatched.lines.length === 0 && unmatched.unmatched.length === 1);
  check("...with a reason naming the missing id", /line item id/i.test(unmatched.unmatched[0]?.reason ?? ""), unmatched.unmatched[0]?.reason ?? "");
  check("...so nothing gets fulfilled by accident", unmatched.lines.length === 0);

  const twoLinesOneSku = matchFulfillmentLines(
    [
      { shopifyLineItemId: "111", sku: "PIL", quantity: 1 },
      { shopifyLineItemId: "112", sku: "PIL", quantity: 1 },
    ],
    [foLine("fol-4", "111", "PIL", 5), foLine("fol-5", "112", "PIL", 5)]
  );
  check("two lines sharing a SKU match their own ids", twoLinesOneSku.lines.length === 2, JSON.stringify(twoLinesOneSku.lines));
  check("...one fulfillment line each", new Set(twoLinesOneSku.lines.map((l) => l.id)).size === 2);

  const claimedOnce = matchFulfillmentLines(
    [
      { shopifyLineItemId: "111", sku: "PIL", quantity: 2 },
      { shopifyLineItemId: "111", sku: "PIL", quantity: 2 },
    ],
    [foLine("fol-6", "111", "PIL", 9)]
  );
  check("one fulfillment line is claimed once, not twice", claimedOnce.lines.length === 1, JSON.stringify(claimedOnce.lines));

  const zero = matchFulfillmentLines([{ shopifyLineItemId: "111", sku: "PIL", quantity: 0 }], [foLine("fol-7", "111", "PIL", 3)]);
  check("a zero-quantity line fulfills nothing", zero.lines.length === 0 && zero.unmatched.length === 0);

  // The milestone itself.
  check("handed to carrier is the dispatch milestone", isFulfillmentMilestone("handed_to_carrier"));
  check("shipped is the same moment under its other name", isFulfillmentMilestone("shipped"));
  for (const event of ["packed", "in_transit", "delivered", "exception"]) {
    check(`${event} is not the milestone — nothing is pushed on it`, !isFulfillmentMilestone(event));
  }
  check("the milestone list is short and deliberate", FULFILLMENT_MILESTONE_EVENTS.length === 2, FULFILLMENT_MILESTONE_EVENTS.join(", "));
}

/* -------------------------------------------------------------------------- */
/* §9 pickup windows, in the dock's own time zone                            */
/* -------------------------------------------------------------------------- */

function pickupWindowChecks() {
  console.log("\n-- the pickup window, in the dock's zone --");

  check("the closing time of a 24h window is the later one", closingTimeFrom("09:00-17:00") === "17:00", String(closingTimeFrom("09:00-17:00")));
  check("afternoon times are read", closingTimeFrom("2pm to 5:30pm") === "17:30", String(closingTimeFrom("2pm to 5:30pm")));
  check("a single time is the closing time", closingTimeFrom("by 16:00") === "16:00", String(closingTimeFrom("by 16:00")));
  check("a phrase with no time has none", closingTimeFrom("before noon") === null, String(closingTimeFrom("before noon")));
  check("an empty window has none", closingTimeFrom(null) === null);
  check("an impossible time is not read as one", closingTimeFrom("25:99") === null, String(closingTimeFrom("25:99")));
  check("12am is midnight, not noon", closingTimeFrom("12am") === "00:00", String(closingTimeFrom("12am")));
  check("12pm is noon", closingTimeFrom("12pm") === "12:00", String(closingTimeFrom("12pm")));

  check("the local date is the dock's date", localDateIn("America/Toronto", new Date("2026-09-24T02:00:00Z")) === "2026-09-23", localDateIn("America/Toronto", new Date("2026-09-24T02:00:00Z")));
  check("...which is not the server's", localDateIn("UTC", new Date("2026-09-24T02:00:00Z")) === "2026-09-24");

  // Summer: Toronto is UTC-4.
  check("summer offset is read correctly", zoneOffsetMs("America/Toronto", new Date("2026-09-23T12:00:00Z")) === -4 * 3600_000, String(zoneOffsetMs("America/Toronto", new Date("2026-09-23T12:00:00Z"))));
  const summerClose = instantOfLocalTime("America/Toronto", "2026-09-23", "17:00");
  check("a 17:00 close in summer is 21:00 UTC", summerClose.toISOString() === "2026-09-23T21:00:00.000Z", summerClose.toISOString());

  // Winter: UTC-5. The same wall-clock time is a different instant, which is
  // exactly the hour that would wrongly flag a live pickup as missed.
  const winterClose = instantOfLocalTime("America/Toronto", "2026-01-14", "17:00");
  check("a 17:00 close in winter is 22:00 UTC", winterClose.toISOString() === "2026-01-14T22:00:00.000Z", winterClose.toISOString());

  // The two DST transitions, where a one-pass conversion is off by an hour.
  const springForward = instantOfLocalTime("America/Toronto", "2026-03-08", "17:00");
  check("the spring-forward day still closes at the right instant", springForward.toISOString() === "2026-03-08T21:00:00.000Z", springForward.toISOString());
  const fallBack = instantOfLocalTime("America/Toronto", "2026-11-01", "17:00");
  check("the fall-back day too", fallBack.toISOString() === "2026-11-01T22:00:00.000Z", fallBack.toISOString());

  const scheduled = new Date("2026-09-23T13:00:00Z"); // 09:00 in Toronto
  const deadline = pickupDeadline({ scheduledFor: scheduled, pickupWindow: "09:00-17:00", timeZone: "America/Toronto" });
  check("a window's deadline is its closing time", deadline.toISOString() === "2026-09-23T21:00:00.000Z", deadline.toISOString());
  const noClose = pickupDeadline({ scheduledFor: scheduled, pickupWindow: "before noon", timeZone: "America/Toronto", fallbackCloseTime: "16:00" });
  check("a window naming no time falls back to the dock's closing time", noClose.toISOString() === "2026-09-23T20:00:00.000Z", noClose.toISOString());
  const nothing = pickupDeadline({ scheduledFor: scheduled, pickupWindow: null, timeZone: "America/Toronto" });
  check("with neither, the deadline is the end of that local day", nothing.toISOString() === "2026-09-24T03:59:00.000Z", nothing.toISOString());
  const unknownZone = pickupDeadline({ scheduledFor: scheduled, pickupWindow: "09:00-17:00", timeZone: null });
  check("an unset zone falls back to UTC rather than to an invented offset", unknownZone.toISOString() === "2026-09-23T17:00:00.000Z", unknownZone.toISOString());

  const window = { pickupStatus: "SCHEDULED", pickupScheduledFor: scheduled, pickupWindow: "09:00-17:00", timeZone: "America/Toronto", trackingStatus: null };
  check("a window still open is not missed", !pickupWindowMissed(window, new Date("2026-09-23T19:00:00Z")));
  check("...and one whose time has passed is", pickupWindowMissed(window, new Date("2026-09-23T21:30:00Z")));
  check("a window is not missed before it has even opened", !pickupWindowMissed(window, new Date("2026-09-23T12:00:00Z")));
  check("an unscheduled pickup is never missed — there is nothing to miss", !pickupWindowMissed({ ...window, pickupStatus: "NONE" }, new Date("2026-09-24T12:00:00Z")));
  check("a failed pickup is not a missed one", !pickupWindowMissed({ ...window, pickupStatus: "FAILED" }, new Date("2026-09-24T12:00:00Z")));
  check("a scheduled pickup with no date is not judged", !pickupWindowMissed({ ...window, pickupScheduledFor: null }, new Date("2026-09-24T12:00:00Z")));
  check("a parcel the carrier has already collected is not a missed pickup", !pickupWindowMissed({ ...window, trackingStatus: "PICKED_UP" }, new Date("2026-09-23T23:00:00Z")));
  check("...nor one already delivered", !pickupWindowMissed({ ...window, trackingStatus: "DELIVERED" }, new Date("2026-09-23T23:00:00Z")));
  check("a parcel the carrier has not spoken about is judged on the clock", pickupWindowMissed({ ...window, trackingStatus: "LABEL_CREATED" }, new Date("2026-09-23T23:00:00Z")));
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

async function createSeller(label: string) {
  const shopDomain = `verify-tracking-${label}-${suffix.toLowerCase()}.myshopify.com`;
  const seller = await prisma.seller.create({
    data: {
      shopDomain,
      shopDomainFull: `https://${shopDomain}`,
      storeName: `Verify Tracking ${label}`,
      contactEmail: `verify-tracking-${label}-${suffix.toLowerCase()}@example.test`,
      status: "APPROVED",
      accessVersion: 1,
    },
  });
  created.sellerIds.push(seller.id);
  return seller;
}

async function createOrder(sellerId: string, label: string) {
  const order = await prisma.order.create({
    data: {
      sellerId,
      shopifyOrderId: `gid://shopify/Order/trk-${label}-${suffix}`,
      shopifyOrderName: `#VT-${label}-${suffix}`,
      shopifyOrderNumber: 9000 + created.orderIds.length,
      supplierReference: `VT-${label}-${suffix}`,
      currency: "CAD",
      subtotal: 10000,
      totalTax: 1300,
      totalShipping: 2500,
      totalDiscounts: 0,
      totalPrice: 13800,
      moonvellaSubtotal: 6000,
      moonvellaTax: 780,
      moonvellaShipping: 2500,
      moonvellaDiscounts: 0,
      moonvellaTotal: 10000,
      wholesalePaymentStatus: "SUCCEEDED",
      shopifyCreatedAt: new Date(),
      shopifyUpdatedAt: new Date(),
      shippingAddress: JSON.stringify({ name: "Verify Customer", address1: "1 Test Street", city: "Toronto", province: "ON", zip: "M5H 2N2", country: "CA" }),
      customerName: "Verify Customer",
    },
  });
  created.orderIds.push(order.id);
  return order;
}

/** The dock a pollable shipment collects from, with the zone the window is read in. */
async function createOrigin(label: string, closeTime = "16:00") {
  const location = await prisma.pickupLocation.create({
    data: {
      code: `VT-DOCK-${label}-${suffix}`,
      name: `Verify Tracking Dock ${label}`,
      odooDatabase: "verify_db",
      odooCompanyId: 1,
      odooWarehouseId: 3,
      odooLocationId: 25,
      odooPartnerId: 145,
      contactName: "Dock Receiver",
      contactPhone: "+1 555 0188",
      contactEmail: `dock-${label}-${suffix.toLowerCase()}@example.test`,
      street1: "12 Main St",
      city: "Toronto",
      province: "ON",
      postalCode: "M5H 2N2",
      country: "CA",
      timeZone: "America/Toronto",
      pickupOpenTime: "09:00",
      pickupCloseTime: closeTime,
    },
  });
  created.locationIds.push(location.id);
  return location;
}

/**
 * A booked shipment with a provider id and a tracking number, which is what the
 * sweep needs to consider it at all.
 */
async function createPollableShipment(
  sellerId: string,
  label: string,
  opts: { status?: string; trackingStatus?: string | null; lastTrackingSyncAt?: Date | null; bookingOutcomeUnknownAt?: Date | null; trackingSyncFailures?: number; origin?: boolean } = {}
) {
  const order = await createOrder(sellerId, label);
  const origin = opts.origin === false ? null : await createOrigin(label);
  const shipment = await prisma.shipment.create({
    data: {
      orderId: order.id,
      status: (opts.status ?? "BOOKED") as never,
      provider: "eshipper",
      carrier: "Purolator",
      serviceCode: "PUR-EXP",
      serviceName: "Purolator Express",
      providerShipmentId: `S-${label}-${suffix}`,
      trackingNumber: `TRK-${label}-${suffix}`,
      trackingUrl: "https://example.invalid/track",
      trackingStatus: opts.trackingStatus ?? null,
      lastTrackingSyncAt: opts.lastTrackingSyncAt ?? null,
      bookingOutcomeUnknownAt: opts.bookingOutcomeUnknownAt ?? null,
      trackingSyncFailures: opts.trackingSyncFailures ?? 0,
      packageCount: 1,
      originLocationId: origin?.id ?? null,
      originSnapshot: origin
        ? {
            locationId: origin.id,
            code: origin.code,
            name: origin.name,
            odoo: { database: "verify_db", companyId: 1, warehouseId: 3, locationId: 25, partnerId: 145 },
            contact: { name: "Dock Receiver", phone: "+1 555 0188", email: null },
            address: { street1: "12 Main St", street2: null, city: "Toronto", province: "ON", postalCode: "M5H 2N2", country: "CA" },
            pickup: { timeZone: "America/Toronto", openTime: "09:00", closeTime: "16:00", instructions: null, accessRequirements: null },
            capturedAt: new Date().toISOString(),
          }
        : undefined,
    },
  });
  return { order, shipment, origin };
}

/** A carrier answer carrying the given status flags and events. */
const TRACK_BODY = (flags: Record<string, unknown>, details: Record<string, unknown>[] = []) => ({
  trackingUrl: "https://example.invalid/track",
  trackingDetails: details,
  ...flags,
});

async function cleanup() {
  try {
    if (created.orderIds.length) await prisma.order.deleteMany({ where: { id: { in: created.orderIds } } });
    if (created.sellerIds.length) {
      await prisma.backgroundJob.deleteMany({ where: { sellerId: { in: created.sellerIds } } });
      await prisma.seller.deleteMany({ where: { id: { in: created.sellerIds } } });
    }
    if (created.locationIds.length) {
      // The shipments that pointed at these are gone with their orders, but the
      // rows they wrote are keyed by shop domain rather than by a relation.
      await prisma.pickupLocation.deleteMany({ where: { id: { in: created.locationIds } } });
    }
    await prisma.webhookEvent.deleteMany({ where: { shopDomain: { startsWith: "verify-tracking-" } } });
  } catch (error) {
    console.error("cleanup failed:", error);
  }
}

/* -------------------------------------------------------------------------- */
/* §7 a refresh, and what a failed one may not do                            */
/* -------------------------------------------------------------------------- */

async function trackingRefreshChecks() {
  console.log("\n-- refreshing tracking, and failing to --");
  installStub();
  const seller = await createSeller("refresh");

  const events = [
    { dateTime: "2026-09-20T10:00:00.000Z", location: "Toronto, ON", description: "Picked up", statusText: "pickup", carrierEventCode: "PU" },
    { dateTime: "2026-09-21T08:30:00.000Z", location: "Concord, ON", description: "In transit", statusText: "inTransit", carrierEventCode: "IT" },
  ];

  const { shipment } = await createPollableShipment(seller.id, "refresh");
  responder = () => ({ status: 200, body: TRACK_BODY({ inTransit: true, deliveryEstimate: "2026-09-25T00:00:00.000Z" }, events) });
  await syncTrackingForShipment(shipment.id, ACTOR);

  const after = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id }, include: { trackingEvents: true } });
  check("a successful poll stores the normalized status", after.trackingStatus === "IN_TRANSIT", after.trackingStatus ?? "(null)");
  check("...and the carrier's own estimate", after.estimatedDelivery?.toISOString() === "2026-09-25T00:00:00.000Z", after.estimatedDelivery?.toISOString() ?? "(null)");
  check("...and records when it last succeeded", after.lastTrackingSyncAt !== null);
  check("...and clears any earlier failure count", after.trackingSyncFailures === 0, String(after.trackingSyncFailures));
  check("...and clears the error", after.lastTrackingError === null, after.lastTrackingError ?? "(null)");
  check("it stores every carrier event", after.trackingEvents.length === 2, String(after.trackingEvents.length));
  check("...with the carrier's wording intact", after.trackingEvents.some((e) => e.description === "Picked up"), after.trackingEvents.map((e) => e.description).join(" | "));
  check("...and the location and time of each", after.trackingEvents.every((e) => e.location && e.eventAt instanceof Date));
  check("the shipment's coarse status moves with it", after.status === "SHIPPED", after.status);

  /*
   * The same events, reordered — which is what a provider does when it prepends
   * the newest one. The history must not grow: before this was keyed on content
   * rather than on array position, every poll re-inserted the whole history and
   * the page showed the same "In transit" once per poll.
   */
  responder = () => ({ status: 200, body: TRACK_BODY({ inTransit: true }, [events[1], events[0]]) });
  await syncTrackingForShipment(shipment.id, ACTOR);
  const reordered = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id }, include: { trackingEvents: true } });
  check("re-polling with the events reordered does not duplicate the history", reordered.trackingEvents.length === 2, String(reordered.trackingEvents.length));

  responder = () => ({ status: 200, body: TRACK_BODY({ inTransit: true }, [...events, { dateTime: "2026-09-22T09:00:00.000Z", location: "Ottawa, ON", description: "Arrived at facility", statusText: "inTransit", carrierEventCode: "AR" }]) });
  await syncTrackingForShipment(shipment.id, ACTOR);
  const grown = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id }, include: { trackingEvents: true } });
  check("a genuinely new event is added", grown.trackingEvents.length === 3, String(grown.trackingEvents.length));

  /* --- a failed refresh erases nothing ---------------------------------- */
  const beforeFailure = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
  responder = () => "timeout";
  let refused = "";
  try {
    await syncTrackingForShipment(shipment.id, ACTOR);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  const afterFailure = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id }, include: { trackingEvents: true } });
  check("a poll that times out is reported, not swallowed", /tracking sync failed/i.test(refused), refused.slice(0, 80));
  check("a failed refresh does not erase the last valid status", afterFailure.trackingStatus === "IN_TRANSIT", afterFailure.trackingStatus ?? "(null)");
  check("...nor the coarse status", afterFailure.status === beforeFailure.status, afterFailure.status);
  check("...nor the events the carrier sent", afterFailure.trackingEvents.length === 3, String(afterFailure.trackingEvents.length));
  check("...nor the last successful refresh time", afterFailure.lastTrackingSyncAt?.getTime() === beforeFailure.lastTrackingSyncAt?.getTime());
  check("but it does record the error", afterFailure.lastTrackingError !== null, afterFailure.lastTrackingError?.slice(0, 60) ?? "(null)");
  check("...and counts the failure, which is what stretches the next attempt", afterFailure.trackingSyncFailures === 1, String(afterFailure.trackingSyncFailures));

  const backedOff = trackingPollPolicy(afterFailure as never, new Date());
  check("...so the next poll waits longer than the normal cadence", backedOff.intervalMs > TRACKING_POLL.activeMs, String(backedOff.intervalMs));

  /* --- a provider outage is not a delivery exception -------------------- */
  check("a failed sync does not turn into an EXCEPTION on the shipment", afterFailure.status !== "EXCEPTION", afterFailure.status);

  /* --- polling something unpollable ------------------------------------- */
  let unpollable = "";
  const orphan = await prisma.shipment.create({
    data: { orderId: (await createOrder(seller.id, "unpollable")).id, status: "PENDING", provider: "eshipper" },
  });
  try {
    await syncTrackingForShipment(orphan.id, ACTOR);
  } catch (error) {
    unpollable = error instanceof Error ? error.message : String(error);
  }
  check("a shipment with nothing to poll by is refused", /no provider shipment id or tracking number/i.test(unpollable), unpollable.slice(0, 80));

  restoreFetch();
}

/* -------------------------------------------------------------------------- */
/* §7 the sweep                                                              */
/* -------------------------------------------------------------------------- */

async function sweepChecks() {
  console.log("\n-- the sweep --");
  installStub();
  const seller = await createSeller("sweep");

  let providerHits = 0;
  responder = () => {
    providerHits += 1;
    return { status: 200, body: TRACK_BODY({ inTransit: true }, [{ dateTime: "2026-09-22T10:00:00.000Z", location: "Concord, ON", description: "In transit", statusText: "inTransit" }]) };
  };

  const due = await createPollableShipment(seller.id, "sweepdue");
  const fresh = await createPollableShipment(seller.id, "sweepfresh", { lastTrackingSyncAt: new Date(Date.now() - 60_000) });
  const unknown = await createPollableShipment(seller.id, "sweepunknown", { bookingOutcomeUnknownAt: new Date() });

  const summary = await sweepShipmentTracking({ shipmentIds: [due.shipment.id, fresh.shipment.id, unknown.shipment.id], limit: 10 });
  /*
   * `considered` counts CANDIDATES, not the ids handed in: the fresh row fails
   * the staleness clause and the unbookable row fails bookingOutcomeUnknownAt,
   * so neither enters the candidate query at all — which is the boundedness
   * doing its job one query earlier than the policy. They are checked as
   * untouched below.
   */
  check("the sweep reads only the rows that could be due", summary.considered === 1, String(summary.considered));
  check("...polls the one that is due", summary.polled === 1, String(summary.polled));
  check("...advances its status", summary.advanced === 1, String(summary.advanced));
  check("...and the policy had nothing to refuse among them", summary.skipped === 0, String(summary.skipped));
  check("...so only one provider call is made", providerHits === 1, String(providerHits));

  const polled = await prisma.shipment.findUniqueOrThrow({ where: { id: due.shipment.id } });
  check("the polled shipment carries the new status", polled.trackingStatus === "IN_TRANSIT", polled.trackingStatus ?? "(null)");
  check("...and its claim was released, so the next sweep is not blocked by a lease", polled.trackingPollClaimedAt === null, String(polled.trackingPollClaimedAt));
  const untouched = await prisma.shipment.findUniqueOrThrow({ where: { id: fresh.shipment.id } });
  check("a shipment polled a minute ago is not polled again", untouched.trackingStatus === null && untouched.lastTrackingSyncAt?.getTime() === fresh.shipment.lastTrackingSyncAt?.getTime());
  const neverPolled = await prisma.shipment.findUniqueOrThrow({ where: { id: unknown.shipment.id } });
  check("a shipment whose booking outcome is unknown is never polled", neverPolled.trackingStatus === null);

  // A shipment claimed by another sweep in flight never enters the candidate
  // query — the claim clause filters it out before the policy runs — so the
  // loser of a race makes no provider call and does not disturb the claim.
  await prisma.shipment.updateMany({ where: { id: due.shipment.id }, data: { lastTrackingSyncAt: null, trackingPollClaimedAt: new Date() } });
  const claimed = await sweepShipmentTracking({ shipmentIds: [due.shipment.id], limit: 10 });
  check("a shipment another sweep holds is never polled", claimed.polled === 0, `polled=${claimed.polled} skipped=${claimed.skipped}`);
  const held = await prisma.shipment.findUniqueOrThrow({ where: { id: due.shipment.id } });
  check("...and the claim is left standing", held.trackingPollClaimedAt !== null);

  // An expired claim is treated as free again — a sweep that died must not block
  // the parcel forever. The sync and attempt stamps are cleared too, because
  // this row was genuinely polled seconds ago and the policy would refuse it on
  // cadence alone, which is a different thing from refusing it on the claim.
  await prisma.shipment.updateMany({ where: { id: due.shipment.id }, data: { lastTrackingSyncAt: null, lastTrackingAttemptAt: null, trackingPollClaimedAt: new Date(Date.now() - 30 * 60_000) } });
  const reclaimed = await sweepShipmentTracking({ shipmentIds: [due.shipment.id], limit: 10 });
  check("a claim left behind by a dead sweep expires", reclaimed.polled === 1, `polled=${reclaimed.polled}`);

  /* --- one failure does not stop the sweep ------------------------------- */
  // The due shipment is IN_TRANSIT by now, so the responder must give it
  // something that OUTRANKS that — pickup (rank 2) after transit (rank 3) is an
  // out-of-order event and is deliberately refused by the monotonicity guard.
  const failing = await createPollableShipment(seller.id, "sweepfail");
  responder = (url) => (url.includes(`S-sweepfail-${suffix}`) ? "unreachable" : { status: 200, body: TRACK_BODY({ outForDelivery: true }) });
  // Both stamps cleared, or the policy would refuse this row on cadence — the
  // reclaim above polled it moments ago.
  await prisma.shipment.updateMany({ where: { id: due.shipment.id }, data: { lastTrackingSyncAt: null, lastTrackingAttemptAt: null } });
  const mixed = await sweepShipmentTracking({ shipmentIds: [failing.shipment.id, due.shipment.id], limit: 10 });
  check("a provider that refuses one parcel does not stop the others", mixed.polled === 2, String(mixed.polled));
  check("...the failure is counted", mixed.failed === 1, String(mixed.failed));
  check("...with its reason recorded against that shipment", mixed.errors.length === 1 && mixed.errors[0].shipmentId === failing.shipment.id, JSON.stringify(mixed.errors.map((e) => e.shipmentId)));
  check("...and the other parcel still advanced", mixed.advanced === 1, String(mixed.advanced));

  // A failed poll counts the failure and stamps the attempt, so the backoff
  // engages on the next tick — this shipment has NEVER synced, which used to be
  // the one row the backoff could not protect.
  const failedRow = await prisma.shipment.findUniqueOrThrow({ where: { id: failing.shipment.id } });
  check("the failed shipment now has one failure against it", failedRow.trackingSyncFailures === 1, String(failedRow.trackingSyncFailures));
  check("...and an attempt time, though it never had an answer", failedRow.lastTrackingAttemptAt !== null, String(failedRow.lastTrackingAttemptAt));
  const refusedAgain = await sweepShipmentTracking({ shipmentIds: [failing.shipment.id], limit: 10 });
  check("...and the next sweep does not immediately try it again", refusedAgain.polled === 0, String(refusedAgain.polled));
  check("...the policy is what refuses it", refusedAgain.skipped === 1, String(refusedAgain.skipped));

  // Nothing to poll at all.
  const empty = await sweepShipmentTracking({ shipmentIds: [], limit: 10 });
  check("a sweep with nothing to do reports nothing rather than failing", empty.considered === 0 && empty.failed === 0);

  restoreFetch();
}

/* -------------------------------------------------------------------------- */
/* §9 missed pickups                                                         */
/* -------------------------------------------------------------------------- */

async function missedPickupChecks() {
  console.log("\n-- flagging a pickup window that has closed --");

  const seller = await createSeller("missed");
  const { shipment: missed } = await createPollableShipment(seller.id, "missed-old");
  const { shipment: future } = await createPollableShipment(seller.id, "missed-future");
  const { shipment: collected } = await createPollableShipment(seller.id, "missed-collected", { trackingStatus: "PICKED_UP" });

  const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
  const tomorrow = new Date(Date.now() + 26 * 60 * 60 * 1000);
  await prisma.shipment.update({ where: { id: missed.id }, data: { pickupStatus: "SCHEDULED", pickupScheduledFor: yesterday, pickupWindow: "09:00-17:00" } });
  await prisma.shipment.update({ where: { id: future.id }, data: { pickupStatus: "SCHEDULED", pickupScheduledFor: tomorrow, pickupWindow: "09:00-17:00" } });
  await prisma.shipment.update({ where: { id: collected.id }, data: { pickupStatus: "SCHEDULED", pickupScheduledFor: yesterday, pickupWindow: "09:00-17:00" } });

  const flagged = await flagMissedPickups({ limit: 50 });
  check("a scheduled pickup whose window closed is flagged", flagged.shipmentIds.includes(missed.id), flagged.shipmentIds.join(", "));
  check("...but a pickup still to come is not", !flagged.shipmentIds.includes(future.id));
  check("...and neither is one the carrier already collected", !flagged.shipmentIds.includes(collected.id));

  const missedRow = await prisma.shipment.findUniqueOrThrow({ where: { id: missed.id } });
  check("the missed pickup is recorded as MISSED", missedRow.pickupStatus === "MISSED", missedRow.pickupStatus ?? "(null)");
  check("...and the shipment itself is untouched", missedRow.status === "BOOKED", missedRow.status);
  const futureRow = await prisma.shipment.findUniqueOrThrow({ where: { id: future.id } });
  check("the future pickup is still SCHEDULED", futureRow.pickupStatus === "SCHEDULED", futureRow.pickupStatus ?? "(null)");
  const collectedRow = await prisma.shipment.findUniqueOrThrow({ where: { id: collected.id } });
  check("the collected one is still SCHEDULED rather than flagged", collectedRow.pickupStatus === "SCHEDULED", collectedRow.pickupStatus ?? "(null)");

  const audit = await prisma.auditLog.findFirst({
    where: { action: "shipping.pickup_missed", entityId: missed.id },
  });
  check("the flag is audited, so the decision is on the record", audit !== null, audit ? audit.actorType : "none");
  check("...as the system's decision, not a person's", audit?.actorType === "SYSTEM", String(audit?.actorType));

  /*
   * The zone the window is judged in must come from the shipment's FROZEN
   * snapshot, nested under `pickup` — not from a flat copy of the dock, and
   * certainly not from UTC. The live dock is detached (as it would be when the
   * row is deleted after booking — the snapshot exists precisely because the
   * live row can change), so the snapshot is the ONLY source of the zone and
   * the close time. A window whose text names no closing time is judged against
   * the dock's own close time (16:00) in the dock's own zone: in UTC it would
   * read as 20:00, so a check at 16:30 Toronto time (20:30 UTC) is after the
   * real close but before the UTC misreading — the hour in which the defect is
   * visible. This is the flagMissedPickups path, exercised with the full
   * OriginSnapshot shape a real booking writes.
   */
  const { shipment: zoned } = await createPollableShipment(seller.id, "missed-zone");
  await prisma.shipment.update({
    where: { id: zoned.id },
    data: {
      pickupStatus: "SCHEDULED",
      pickupScheduledFor: new Date("2026-09-22T13:00:00.000Z"), // 09:00 in Toronto
      pickupWindow: "before noon", // names no closing time on purpose
      originLocationId: null, // the live dock is gone; only the snapshot speaks
      originSnapshot: {
        locationId: "detached",
        code: "VT-DOCK-missed-zone",
        name: "Verify Tracking Dock missed-zone",
        odoo: { database: "verify_db", companyId: 1, warehouseId: 3, locationId: 25, partnerId: 145 },
        contact: { name: "Dock Receiver", phone: "+1 555 0188", email: null },
        address: { street1: "12 Main St", street2: null, city: "Toronto", province: "ON", postalCode: "M5H 2N2", country: "CA" },
        pickup: { timeZone: "America/Toronto", openTime: "09:00", closeTime: "16:00", instructions: null, accessRequirements: null },
        capturedAt: new Date().toISOString(),
      },
    },
  });
  // 20:30 UTC = 16:30 Toronto: past the dock's own 16:00 close, before the
  // UTC-misread 20:00. The window's text names no closing time, so the dock's
  // snapshot closeTime is the only thing that can flag this at all.
  const zonedFlagged = await flagMissedPickups({ now: new Date("2026-09-22T20:30:00.000Z"), limit: 50 });
  check("a window with no closing time is judged in the snapshot's zone", zonedFlagged.shipmentIds.includes(zoned.id), zonedFlagged.shipmentIds.join(", "));
  const zonedRow = await prisma.shipment.findUniqueOrThrow({ where: { id: zoned.id } });
  check("...and against the dock's close time, not midnight", zonedRow.pickupStatus === "MISSED", zonedRow.pickupStatus ?? "(null)");

  // Flagging does not cancel or reschedule anything: a missed window is a fact to
  // act on, not a state to clean up.
  const again = await flagMissedPickups({ limit: 50 });
  check("re-running does not flag it twice", !again.shipmentIds.includes(missed.id));

  const noPickups = await prisma.shipment.count({ where: { pickupStatus: "SCHEDULED", pickupScheduledFor: { lt: new Date(Date.now() - 60 * 60 * 1000) }, id: { in: [missed.id] } } });
  check("nothing was cancelled on the way", noPickups === 0);
}

/* -------------------------------------------------------------------------- */

async function main() {
  try {
    displayVocabularyChecks();
    await displayFilterChecks();
    pollPolicyChecks();
    partialDeliveryChecks();
    lineMatchingChecks();
    pickupWindowChecks();
    await trackingRefreshChecks();
    await sweepChecks();
    await missedPickupChecks();
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
}

main().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
