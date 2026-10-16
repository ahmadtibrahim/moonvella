import { Link, Form, useLoaderData, useActionData, useNavigation, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { advanceShipment, type ShipmentAdvanceEvent } from "~/services/fulfillment.server";
import { syncTrackingForShipment, voidShipment } from "~/services/shipping.server";
import { CALENDAR_DATE_TIME_ZONE, formatDate, formatDateTime } from "~/utils/dates";
// The tracking vocabulary is rendered by the component below, so it must come
// from the isomorphic module — importing it from shipping.server would pull
// server-only code into the client bundle, which React Router refuses at build
// time. trackingDisplayWhere is used by the loader for the same reason: it is
// the filter twin of the word the row shows, and the two are kept in one file
// so they cannot drift apart.
import {
  trackingLabel,
  trackingDisplay,
  trackingDisplayLabel,
  trackingDisplayWhere,
  availableWarehouseEvents,
  TRACKING_DISPLAY_ORDER,
  type TrackingDisplayStatus,
} from "~/services/shippingLogic";
import { describeEshipperStatus, eshipperStatus } from "~/services/eshipper.server";
// The region table the address validator already keeps, so "Ontario" and "ON"
// are one value in the Destination column and there is only one such table.
import { regionCodeFor } from "~/services/addressValidation.server";
import { ShippingOperationsNav } from "~/components/ShippingOperationsNav";

/**
 * Every state a shipment can be in, in the order an operator meets them.
 *
 * The booking states sit between PENDING and SHIPPED because that is where they
 * happen. They are separate entries and not folded into EXCEPTION because each
 * one asks for something different: BOOKING is wait, BOOKING_FAILED is retry,
 * BOOKING_UNKNOWN is "find out before touching it". A single "problem" bucket
 * would offer the same button to all three, and for one of them it is wrong.
 */
const STATUSES = [
  "PENDING",
  "BOOKING",
  "BOOKING_FAILED",
  "BOOKING_UNKNOWN",
  "BOOKED",
  "CANCELLING",
  "SHIPPED",
  "DELIVERED",
  "EXCEPTION",
  "CANCELLED",
] as const;
const PAGE_SIZE = 25;

/*
 * Manual advancement stops at the handover. Everything past it — shipped, in
 * transit, delivered, exception — is the carrier's own scan, and typing those
 * in by hand would let this screen disagree with the tracking that is the
 * record of what actually happened.
 */
const ADVANCE_EVENTS: ShipmentAdvanceEvent[] = ["packed", "handed_to_carrier"];

/**
 * The pickup filter's own vocabulary, which is not the column's.
 *
 * A shipment's pickup has two halves — how it is meant to leave the dock
 * (`pickupMode`) and what the provider has confirmed (`pickupStatus`) — and an
 * operator asking a question asks it about the pair. "Required" is the one that
 * earns its keep: a parcel that needs a truck and does not have a scheduled
 * collection is the parcel that sits on a dock until somebody notices.
 */
const PICKUP_FILTERS = [
  { value: "required", label: "Required, not scheduled" },
  { value: "scheduled", label: "Scheduled" },
  { value: "failed", label: "Failed / missed" },
  { value: "not_required", label: "Regular or drop-off" },
] as const;

/**
 * The tabs, which are the questions an operator actually arrives with.
 *
 * THEY ARE NOT A SECOND STATUS FILTER. "Needs booking" is not a status — it is
 * "no label exists yet", which spans PENDING, BOOKING_FAILED and
 * BOOKING_UNKNOWN. "Waiting for pickup" is "a label exists and the box is taped
 * and the carrier has not collected it", which is a fact about two milestones
 * and one status. Modelling them as tabs over those combinations is what makes
 * the counts on the tabs add up to something a person can act on; a tab per
 * enum value would be a schema with a nicer font.
 *
 * `needs_attention` is deliberately the union of everything that has gone wrong
 * rather than a status of its own, because the question "what is stuck" has one
 * answer regardless of which subsystem failed.
 */
const TABS = [
  { value: "all", label: "All" },
  { value: "needs_booking", label: "Needs booking" },
  { value: "waiting_pickup", label: "Waiting for pickup" },
  { value: "in_transit", label: "In transit" },
  { value: "delivered", label: "Delivered" },
  { value: "needs_attention", label: "Needs attention" },
] as const;
type TabValue = (typeof TABS)[number]["value"];

/**
 * A tab, as a WHERE clause.
 *
 * Written as a function so the TAB and the row's own affordances cannot drift:
 * the same predicate that puts a parcel in "Needs booking" is what decides
 * whether its Shipping label cell offers "Book shipping".
 */
function tabWhere(tab: TabValue): Record<string, unknown> | null {
  switch (tab) {
    case "all":
      return null;
    case "needs_booking":
      // No provider identifier means no label, whatever the status word says.
      // The status list is there because BOOKING_FAILED and BOOKING_UNKNOWN are
      // the states a label-less parcel reaches after a try.
      return {
        providerShipmentId: null,
        status: { in: ["PENDING", "BOOKING", "BOOKING_FAILED", "BOOKING_UNKNOWN"] },
      };
    case "waiting_pickup":
      return {
        status: "BOOKED",
        packedAt: { not: null },
        handedToCarrierAt: null,
      };
    case "in_transit":
      return {
        OR: [
          { status: "SHIPPED" },
          { trackingStatus: { in: ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY"] } },
        ],
      };
    case "delivered":
      return { OR: [{ status: "DELIVERED" }, { trackingStatus: "DELIVERED" }] };
    case "needs_attention":
      return {
        OR: [
          { status: "EXCEPTION" },
          { status: "BOOKING_FAILED" },
          { status: "BOOKING_UNKNOWN" },
          { trackingStatus: "EXCEPTION" },
          { lastTrackingError: { not: null } },
          { shopifySyncError: { not: null } },
          { trackingSyncFailures: { gte: 3 } },
        ],
      };
    default:
      return null;
  }
}

/** How a parcel is meant to leave the dock, in an operator's words. */
const PICKUP_MODE_LABEL: Record<string, string> = {
  NEEDED: "Pickup needed",
  REGULAR: "Regular pickup",
  DROPOFF: "Drop-off",
};

/** What the provider has confirmed about the collection. */
const PICKUP_STATUS_LABEL: Record<string, string> = {
  NONE: "None arranged",
  SCHEDULED: "Scheduled",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
  MISSED: "Missed",
  UNKNOWN: "Unknown",
};

const PICKUP_STATUS_BADGE: Record<string, string> = {
  SCHEDULED: "mv-badge-success",
  FAILED: "mv-badge-danger",
  MISSED: "mv-badge-warning",
  CANCELLED: "",
};

/**
 * "Ottawa, ON" — a city and a TWO-LETTER province or state, which is what the
 * work order asks the Destination column to show.
 *
 * THE FOLDING IS THE POINT. A Shopify address stores "Ontario" and a depot form
 * stores "ON", and the same place arriving two ways in one column is a column
 * nobody can filter or scan. `regionCodeFor` is the table the address validator
 * already uses for exactly this reason, reused rather than re-typed.
 *
 * IT FALLS BACK RATHER THAN GUESSING. An unrecognised region keeps the text that
 * was stored rather than becoming blank — a country this deployment does not
 * ship to is no worse off, it simply gets no folding. A city with no region
 * shows the city; neither shows an em dash. Joining a missing half as an empty
 * string would produce "Ottawa, ", and deriving one from a postcode would be a
 * claim about a place nobody stated.
 *
 * COMPUTED IN THE LOADER, not in the render: the region table lives in a server
 * module, and the render would otherwise pull several hundred place names into
 * the browser bundle to draw one line of a table cell.
 */
function shortDestination(addr: Record<string, string>): string {
  const city = (addr.city || "").trim();
  const raw = (addr.province || addr.provinceCode || "").trim();
  const region = raw ? regionCodeFor(raw) || raw : "";
  const joined = [city, region].filter(Boolean).join(", ");
  return joined || "—";
}

function parseAddress(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePermission(request, "shipping.view");
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const carrier = url.searchParams.get("carrier") || "";
  const sellerId = url.searchParams.get("seller") || "";
  const billingStatus = url.searchParams.get("billing") || "";
  const q = (url.searchParams.get("q") || "").trim();
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const originId = url.searchParams.get("origin") || "";
  const destination = (url.searchParams.get("destination") || "").trim();
  const tracking = url.searchParams.get("tracking") || "";
  const pickup = url.searchParams.get("pickup") || "";
  const syncErrors = url.searchParams.get("syncErrors") === "1";
  const tabParam = url.searchParams.get("tab") || "all";
  const tab: TabValue = (TABS.some((entry) => entry.value === tabParam) ? tabParam : "all") as TabValue;
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));

  const and: Record<string, unknown>[] = [];
  // The tab is applied FIRST, so every count and every filter below is read in
  // the context the operator chose rather than against the whole table.
  const tabClause = tabWhere(tab);
  if (tabClause) and.push(tabClause);
  if (STATUSES.includes(status as (typeof STATUSES)[number])) and.push({ status: status as never });
  // "Carrier/service" as one field, because an operator looking for a parcel
  // knows either the name on the truck ("UPS") or the product they bought
  // ("Ground"), and asking them which column it lives in is asking them to know
  // our schema.
  if (carrier) and.push({ OR: [{ carrier: { contains: carrier, mode: "insensitive" } }, { serviceName: { contains: carrier, mode: "insensitive" } }] });
  if (billingStatus) and.push({ billingStatus });
  if (sellerId) and.push({ order: { sellerId } });
  if (originId) and.push({ originLocationId: originId });
  if (destination) and.push({ order: { shippingAddress: { contains: destination, mode: "insensitive" } } });
  if (tracking && TRACKING_DISPLAY_ORDER.includes(tracking as TrackingDisplayStatus)) {
    and.push(trackingDisplayWhere(tracking as TrackingDisplayStatus));
  }
  if (pickup === "required") {
    and.push({
      OR: [
        {
          pickupMode: "NEEDED",
          OR: [{ pickupStatus: null }, { pickupStatus: { in: ["NONE", "FAILED", "MISSED", "CANCELLED"] } }],
        },
        // A booked parcel with no mode recorded is one we cannot say is
        // covered, and "cannot say" belongs in the list a person checks rather
        // than out of it.
        { pickupMode: null, status: { in: ["BOOKED", "SHIPPED", "EXCEPTION"] } },
      ],
    });
  } else if (pickup === "scheduled") {
    and.push({ pickupStatus: "SCHEDULED" });
  } else if (pickup === "failed") {
    and.push({ pickupStatus: { in: ["FAILED", "MISSED"] } });
  } else if (pickup === "not_required") {
    and.push({ pickupMode: { in: ["REGULAR", "DROPOFF"] } });
  }
  // Both syncs, because "why has nobody heard anything about this parcel" does
  // not care which direction the failure is in.
  if (syncErrors) and.push({ OR: [{ lastTrackingError: { not: null } }, { shopifySyncError: { not: null } }] });
  /*
   * A date range, inclusive of both days the operator named.
   *
   * The bounds are built from local midnights and the last millisecond of the
   * closing day, not by parsing the bare "YYYY-MM-DD" the date input sends —
   * that form is read as UTC midnight, which is 8pm the previous evening here,
   * and a filter labelled "from the 23rd" that quietly includes the 22nd is a
   * filter nobody can trust. The whole day is included at the far end for the
   * same reason: picking the 23rd and getting nothing created that afternoon
   * would be a puzzle, not a feature.
   */
  const range: Record<string, Date> = {};
  if (from) {
    const start = new Date(`${from}T00:00:00.000`);
    if (!Number.isNaN(start.getTime())) range.gte = start;
  }
  if (to) {
    const end = new Date(`${to}T23:59:59.999`);
    if (!Number.isNaN(end.getTime())) range.lte = end;
  }
  if (Object.keys(range).length) and.push({ createdAt: range });
  if (q) {
    and.push({
      OR: [
        { trackingNumber: { contains: q, mode: "insensitive" } },
        { providerShipmentId: { contains: q, mode: "insensitive" } },
        { order: { shopifyOrderName: { contains: q, mode: "insensitive" } } },
        { order: { supplierReference: { contains: q, mode: "insensitive" } } },
        { order: { seller: { storeName: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }
  const where = and.length ? { AND: and } : {};

  const [shipments, total, delivered, pending, exceptions, sellers, origins, awaitingPrep, eshipper, tabCountRows] = await Promise.all([
    prisma.shipment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        trackingNumber: true,
        trackingUrl: true,
        // The provider's label document, so "Print label" is a real link rather
        // than a second trip through the detail page.
        labelUrl: true,
        carrier: true,
        serviceName: true,
        status: true,
        trackingStatus: true,
        // The row gates its cancel control on this, and the search above matches
        // on it; without it in the select the row cannot render that control.
        providerShipmentId: true,
        // The warehouse milestones, so the row can draw the same two controls
        // `availableWarehouseEvents` allows — and no others. Without these two
        // columns the row cannot tell a packed box from an unpacked one and
        // would have to offer both events on faith.
        packedAt: true,
        handedToCarrierAt: true,
        sellerShippingCharge: true,
        quotedCarrierCost: true,
        bookedCost: true,
        finalBilledCost: true,
        billingStatus: true,
        estimatedDelivery: true,
        lastTrackingSyncAt: true,
        lastTrackingError: true,
        trackingSyncFailures: true,
        returnOfShipmentId: true,
        createdAt: true,
        // §7 asks the row to carry packages, pickup status and Shopify sync
        // status. All three are columns on this table; the point of selecting
        // them is that the operator does not have to open each parcel to find
        // the one that never reached Shopify.
        packageCount: true,
        pickupStatus: true,
        pickupMode: true,
        pickupScheduledFor: true,
        pickupWindow: true,
        shopifyFulfillmentId: true,
        shopifySyncedAt: true,
        shopifySyncError: true,
        shopifyNotifiedAt: true,
        // Where the parcel is collected from: the live dock for its name and
        // code, and the frozen copy for shipments booked before a dock was
        // renamed. §1's rule that a missing mapping is shown and not papered
        // over is visible here too — a shipment with neither says so.
        originLocationId: true,
        originLocation: { select: { code: true, name: true } },
        originSnapshot: true,
        /*
         * The latest provider event, for the carrier's own wording.
         *
         * §7 asks for normalized statuses that PRESERVE the carrier's words,
         * and the normalized set is deliberately lossy — "Exception/Delayed"
         * covers a failed attempt and a refusal. The raw event is where the
         * difference survives, so the row shows the newest one rather than only
         * the word we derived from it.
         */
        trackingEvents: {
          orderBy: { eventAt: "desc" },
          take: 1,
          select: { eventAt: true, location: true, description: true, statusText: true, carrierEventCode: true },
        },
        order: {
          select: {
            id: true,
            shopifyOrderName: true,
            supplierReference: true,
            shippingAddress: true,
            currency: true,
            seller: { select: { id: true, storeName: true } },
          },
        },
      },
    }),
    prisma.shipment.count({ where }),
    prisma.shipment.count({ where: { ...where, status: "DELIVERED" } }),
    prisma.shipment.count({ where: { ...where, status: "PENDING" } }),
    /*
     * What needs a person, not just what is failing.
     *
     * A failed booking and a booking nobody can account for are both things
     * somebody has to act on, and neither is an EXCEPTION — the states are kept
     * apart precisely so they are not buried in the same count as a carrier
     * exception. A failed pickup belongs here too: the shipment is fine but
     * nobody is coming to collect it.
     */
    prisma.shipment.count({
      where: {
        ...where,
        OR: [
          { status: "EXCEPTION" },
          { status: { in: ["BOOKING_FAILED", "BOOKING_UNKNOWN"] } },
          // A failed pickup and a missed pickup window are the same problem a
          // day apart: nobody came, and nobody has called one since. Only the
          // first was counted here, which made the card go quiet exactly when
          // the parcel had been waiting longest. A transient tracking failure is
          // NOT in this count — the sweep retries it on a backoff, and a card
          // that counts retries in progress teaches people to ignore the card.
          { pickupStatus: { in: ["FAILED", "MISSED"] } },
        ],
      },
    }),
    prisma.seller.findMany({ select: { id: true, storeName: true }, orderBy: { storeName: "asc" } }),
    // Every dock, not just the ones currently shipping: the filter is used to
    // ask "what goes out of here", and an origin that has gone quiet is exactly
    // the one somebody is looking for.
    prisma.pickupLocation.findMany({ select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }),
    prisma.order.count({ where: { wholesalePaymentStatus: "SUCCEEDED", fulfillmentStatus: { in: ["PENDING", "PROCESSING", "PARTIAL"] } } }),
    // The host, not the boolean: see eshipperStatus.
    eshipperStatus(),
    Promise.all(
      TABS.map(async (entry) => {
        const clause = tabWhere(entry.value);
        return [entry.value, await prisma.shipment.count({ where: clause ?? {} })] as const;
      })
    ),
  ]);

  const tabCounts = Object.fromEntries(tabCountRows) as Record<TabValue, number>;

  /*
   * "Shipment 2 of 3", for the ORDER rather than for the page.
   *
   * One extra query for the whole page: every shipment of every order that
   * appears on it, oldest first. Derived from that list rather than from the
   * page's own rows, because a split order whose second parcel is on a later
   * page would otherwise read "1 of 1" — a claim about the order that is simply
   * wrong, and wrong in the direction that makes an operator stop looking.
   *
   * Cancelled shipments are counted, not skipped: the customer's order really
   * did have three parcels, one of which was voided, and hiding it would make
   * the remaining two renumber themselves between two visits to this page.
   */
  const orderIds = [...new Set(shipments.map((row) => row.order.id))];
  const siblingRows = orderIds.length
    ? await prisma.shipment.findMany({
        where: { orderId: { in: orderIds } },
        select: { id: true, orderId: true },
        orderBy: { createdAt: "asc" },
      })
    : [];
  /*
   * One destination string per row, folded to a two-letter region here rather
   * than in the render. See `shortDestination`.
   */
  const destinations: Record<string, string> = {};
  for (const row of shipments) {
    destinations[row.id] = shortDestination(parseAddress(row.order.shippingAddress));
  }

  const shipmentNumber = new Map<string, { index: number; total: number }>();
  for (const orderId of orderIds) {
    const siblings = siblingRows.filter((row) => row.orderId === orderId);
    siblings.forEach((row, position) => {
      shipmentNumber.set(row.id, { index: position + 1, total: siblings.length });
    });
  }

  return {
    shipments,
    total,
    delivered,
    pending,
    exceptions,
    sellers,
    origins,
    awaitingPrep,
    /*
     * The host, not the boolean: see eshipperStatus.
     *
     * The sentence is built HERE and travels as a string. `describeEshipperStatus`
     * lives in a `.server` module, and React Router strips those from the client
     * bundle — a component that calls one fails the build rather than the
     * request, which is how this was found.
     */
    eshipper: { ...eshipper, description: describeEshipperStatus(eshipper) },
    filters: { status, carrier, seller: sellerId, billing: billingStatus, q, from, to, origin: originId, destination, tracking, pickup, syncErrors: syncErrors ? "1" : "", tab },
    tab,
    /*
     * ONE COUNT PER TAB, computed from the tab's own predicate rather than from
     * the filtered set. A tab that says "Needs booking (4)" and then shows two
     * rows is worse than no count at all: it teaches the operator that the
     * numbers on this page are decorative.
     *
     * These are counts over the WHOLE table, not the current filter. A badge
     * that shrank when you typed into the search box would be answering a
     * different question from the one its label asks.
     */
    tabCounts: tabCounts,
    /*
     * The index travels as a plain record rather than as a Map: a Map does not
     * survive the loader's serialization to the browser, and a row that silently
     * read `undefined` would print "Shipment NaN of 3".
     */
    shipmentNumber: Object.fromEntries(shipmentNumber),
    destinations,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  const user = await requirePermission(request, "shipping.manage");
  const { ip, userAgent } = getRequestMeta(request);
  const actor = { actorType: "ADMIN_USER" as const, actorId: user.id, actorName: user.name, ipAddress: ip, userAgent };
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  const shipmentId = String(form.get("shipmentId") || "");

  try {
    if (intent === "advance_shipment") {
      const event = String(form.get("event") || "");
      if (!ADVANCE_EVENTS.includes(event as ShipmentAdvanceEvent)) throw new Error("Unknown shipment event.");
      await advanceShipment(shipmentId, event as ShipmentAdvanceEvent, actor);
    } else if (intent === "sync_tracking") {
      await syncTrackingForShipment(shipmentId, actor);
    } else if (intent === "cancel_shipment") {
      const result = await voidShipment(shipmentId, actor);
      if (!result.cancelled) {
        return { error: `Cancellation was not confirmed${result.providerMessage ? `: ${result.providerMessage}` : "."}` };
      }
    } else {
      throw new Error("Unknown action.");
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Operation failed." };
  }
  return redirect(request.url);
}

const statusBadge: Record<string, string> = {
  PENDING: "mv-badge-warning",
  BOOKING: "mv-badge-brand",
  BOOKING_FAILED: "mv-badge-danger",
  BOOKING_UNKNOWN: "mv-badge-warning",
  BOOKED: "mv-badge-success",
  CANCELLING: "",
  SHIPPED: "mv-badge-brand",
  DELIVERED: "mv-badge-success",
  EXCEPTION: "mv-badge-danger",
  CANCELLED: "",
};

/**
 * The nine display words are one vocabulary; this is the other half of it, the
 * badge tone. Chosen from the DISPLAY status rather than from the carrier's raw
 * state, so "Undelivered" and "Exception" cannot come out green and red for the
 * same situation on two adjacent rows.
 */
const trackingDisplayBadge: Record<TrackingDisplayStatus, string> = {
  BOOKED: "mv-badge-brand",
  PICKED_UP: "mv-badge-brand",
  IN_TRANSIT: "mv-badge-brand",
  OUT_FOR_DELIVERY: "mv-badge-warning",
  DELIVERED: "mv-badge-success",
  EXCEPTION: "mv-badge-danger",
  CANCELLED: "",
  RETURNED: "mv-badge-warning",
  UNKNOWN: "",
};

function money(cents: number | null, currency = "CAD") {
  if (cents == null) return "—";
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

/**
 * Which dock this parcel is collected from, as the row names it.
 *
 * The live location answers first, because that is where a truck would be sent
 * today. The frozen copy answers for a shipment booked under a code that has
 * since been renamed or retired — §1's snapshot, doing the job it exists for.
 *
 * The third answer is about THIS ROW, not about the mapping: a shipment that has
 * neither was never quoted or booked, and the dock for its items is resolved
 * from those items at quote and booking time. It deliberately does not say
 * "Pickup location required", which would report a mapping fault the item
 * resolution may not have — a list page cannot afford one resolution per row,
 * and a wrong fault is worse than a narrow statement.
 */
function originLabel(shipment: {
  originLocation: { code: string; name: string } | null;
  originSnapshot: unknown;
}): string {
  if (shipment.originLocation) return shipment.originLocation.code;
  const snap = shipment.originSnapshot as { code?: unknown } | null;
  if (snap && typeof snap === "object" && typeof snap.code === "string") return snap.code;
  return "No dock recorded";
}

/**
 * The carrier's own words for its newest event.
 *
 * §7 asks for normalized statuses that preserve what the carrier said. The
 * normalized word is lossy by design; this is where the loss is recoverable, so
 * it reads the provider's text and falls back through status text and the raw
 * event code rather than substituting a description of our own.
 */
function carrierEventText(
  event: { description: string | null; statusText: string | null; carrierEventCode: string | null } | undefined
): string | null {
  if (!event) return null;
  const text = event.description?.trim() || event.statusText?.trim() || event.carrierEventCode?.trim();
  return text || null;
}

/**
 * What Shopify knows about this parcel.
 *
 * The three states are deliberately distinct. "Awaiting dispatch" is not a
 * failure — §8 defines the push as happening at the dispatch milestone, so a
 * label bought and not yet handed over SHOULD be unpushed. "Sync failed" is a
 * failure and carries Shopify's own message. "Fulfilled" is a fact with a date,
 * because the date is what tells an operator whether to believe it.
 */
function shopifySync(shipment: {
  shopifyFulfillmentId: string | null;
  shopifySyncedAt: Date | string | null;
  shopifySyncError: string | null;
}): { text: string; badge: string; title: string | null } {
  if (shipment.shopifyFulfillmentId) {
    const when = shipment.shopifySyncedAt ? formatDate(shipment.shopifySyncedAt) : null;
    return {
      text: when ? `Fulfilled ${when}` : "Fulfilled",
      badge: "mv-badge-success",
      title: `Shopify fulfillment ${shipment.shopifyFulfillmentId}`,
    };
  }
  if (shipment.shopifySyncError) return { text: "Sync failed", badge: "mv-badge-danger", title: shipment.shopifySyncError };
  return { text: "Awaiting dispatch", badge: "", title: null };
}

export default function AdminShipping() {
  const {
    shipments,
    total,
    delivered,
    pending,
    exceptions,
    sellers,
    origins,
    awaitingPrep,
    eshipper,
    filters,
    tab,
    tabCounts,
    shipmentNumber,
    destinations,
    page,
    pageCount,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const loading = navigation.state === "loading";

  /*
   * The list's own query string, minus the page number, carried on every link
   * out of a row and back. The work order asks for filters to survive a trip
   * through a detail page, and the way that actually works is for the list to
   * hand its state to the detail rather than for the detail to guess it.
   */
  /*
   * Whether anything is narrowing this table. Used to tell an empty result apart
   * from an empty queue — see the panel below. The tab counts as a narrowing
   * only when it is not "all", because "All" is the absence of a choice rather
   * than a choice.
   */
  const hasFilters =
    tab !== "all" ||
    Object.entries(filters).some(([key, value]) => key !== "tab" && Boolean(value));

  const listQuery = new URLSearchParams(
    Object.entries(filters).filter(([key, value]) => Boolean(value) && key !== "page") as [string, string][]
  ).toString();

  return (
    <div className="mv-page-wide">
      <ShippingOperationsNav />

      <div className="mv-page-header">
        <div>
          <h1>Shipments</h1>
          <p>One row per shipment, so a split order shows each parcel. Parsing, quoting and booking begin from a parcel.</p>
          <p style={{ marginTop: "0.4rem", fontSize: "0.75rem" }}>
            <Link to="/admin/orders">
              {awaitingPrep} order{awaitingPrep === 1 ? "" : "s"} awaiting shipment preparation &rarr;
            </Link>
          </p>
        </div>
      </div>

      {actionData?.error ? (
        <div style={{ background: "#fff0ee", border: "1px solid #fecaca", color: "#b42318", borderRadius: 12, padding: "0.75rem 1rem", marginBottom: "1rem", fontSize: "0.82rem" }}>
          {actionData.error}
        </div>
      ) : null}

      <div className="mv-stat-grid">
        <div className="mv-stat"><span>Total shipments</span><strong>{total}</strong></div>
        <div className="mv-stat"><span>Awaiting booking</span><strong>{pending}</strong></div>
        <div className="mv-stat"><span>Delivered</span><strong>{delivered}</strong></div>
        <div className="mv-stat"><span>Needs attention</span><strong>{exceptions}</strong></div>
      </div>

      {/*
        THE TABS, EACH A LINK RATHER THAN A BUTTON IN THE FORM BELOW.

        A tab is a different question about the same table, so it belongs in the
        URL where it can be shared, bookmarked and returned to — which is also
        what "preserve filters when returning from details" needs: the detail
        page links back to the exact query string that produced the row.

        Each tab carries its count over the WHOLE table, not over the currently
        filtered set. A badge that shrank as you typed into the search box would
        be answering a different question from the one its label asks.
      */}
      <nav className="mv-workspace-nav" aria-label="Shipment queues">
        {TABS.map((entry) => {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(filters)) {
            if (value && key !== "tab" && key !== "page") params.set(key, String(value));
          }
          if (entry.value !== "all") params.set("tab", entry.value);
          const search = params.toString();
          return (
            <Link
              key={entry.value}
              to={`/admin/shipping${search ? `?${search}` : ""}`}
              className={tab === entry.value ? "is-active" : ""}
              aria-current={tab === entry.value ? "page" : undefined}
            >
              {entry.label} ({tabCounts[entry.value] ?? 0})
            </Link>
          );
        })}
      </nav>

      <Form method="get" className="mv-filter-bar">
        {/* The tab survives a filter submit, so refining a tab keeps you in it. */}
        <input type="hidden" name="tab" value={tab} />
        <label className="mv-field">
          Search
          <input className="mv-input" name="q" defaultValue={filters.q} placeholder="Order, shipment, tracking, seller" style={{ width: 240 }} />
        </label>
        <label className="mv-field">
          Status
          <select className="mv-input" name="status" defaultValue={filters.status}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="mv-field">
          Carrier / service
          <input className="mv-input" name="carrier" defaultValue={filters.carrier} placeholder="Any" style={{ width: 120 }} />
        </label>
        <label className="mv-field">
          Seller
          <select className="mv-input" name="seller" defaultValue={filters.seller}>
            <option value="">All</option>
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>{s.storeName}</option>
            ))}
          </select>
        </label>
        <label className="mv-field">
          Billing
          <select className="mv-input" name="billing" defaultValue={filters.billing}>
            <option value="">All</option>
            {["PENDING", "RECONCILED", "VARIANCE", "NEEDS_RECONCILIATION"].map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>
        <label className="mv-field">
          Tracking
          <select className="mv-input" name="tracking" defaultValue={filters.tracking}>
            <option value="">All</option>
            {/* The nine words, in movement order. The values are the internal
                display statuses; the labels are what the rows show. */}
            {TRACKING_DISPLAY_ORDER.map((s) => (
              <option key={s} value={s}>{trackingDisplayLabel(s)}</option>
            ))}
          </select>
        </label>
        <label className="mv-field">
          Pickup
          <select className="mv-input" name="pickup" defaultValue={filters.pickup}>
            <option value="">All</option>
            {PICKUP_FILTERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>
        <label className="mv-field">
          Origin
          <select className="mv-input" name="origin" defaultValue={filters.origin}>
            <option value="">Any</option>
            {origins.map((o) => (
              <option key={o.id} value={o.id}>{o.code} — {o.name}</option>
            ))}
          </select>
        </label>
        <label className="mv-field">
          Destination
          <input className="mv-input" name="destination" defaultValue={filters.destination} placeholder="City, province or ZIP" style={{ width: 160 }} />
        </label>
        <label className="mv-field">
          Created from
          <input className="mv-input" type="date" name="from" defaultValue={filters.from} />
        </label>
        <label className="mv-field">
          to
          <input className="mv-input" type="date" name="to" defaultValue={filters.to} />
        </label>
        {/* Unchecked inputs send nothing, which is what "no filter" means; 1 is
            the only value the loader reads. */}
        <label className="mv-field" style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "0.35rem", paddingBottom: "0.4rem" }}>
          <input type="checkbox" name="syncErrors" value="1" defaultChecked={filters.syncErrors === "1"} />
          Sync errors
        </label>
        <button type="submit" className="mv-button mv-button-dark">Filter</button>
        <Link to="/admin/shipping" className="mv-button">Reset</Link>
        {/*
          A test host and a live host both used to render as "configured" here.
          The environment and its hostname are the fact; see eshipperStatus.
        */}
        <span
          style={{
            fontSize: "0.68rem",
            color: eshipper.environment === "production" ? "#b91c1c" : eshipper.environment === "test" ? "#b45309" : "#64748b",
            marginLeft: "auto",
            paddingBottom: "0.4rem",
          }}
        >
          eShipper: {eshipper.description}
        </span>
      </Form>

      <section className="mv-panel">
        <div className="mv-panel-header">
          <div><h2>Shipment queue</h2><p>{total} shipments</p></div>
          <span className="mv-badge">Page {page} of {pageCount}</span>
        </div>
        {/*
          FIVE STATES, AND THEY ARE NOT THE SAME STATE.

          "Nothing matches your filters" and "there are no shipments at all" look
          identical in an empty table and mean opposite things: the first is a
          search to widen, the second is a queue that has never had anything in
          it — and telling somebody to clear filters that are already clear is
          how a page teaches them to ignore its messages. Loading is its own
          sentence so a slow query does not read as an empty result.
        */}
        {loading ? (
          <p className="mv-panel-body mv-muted" role="status" aria-live="polite">
            Loading shipments…
          </p>
        ) : actionData && "error" in actionData && actionData.error ? (
          <p className="mv-panel-body" role="alert" style={{ color: "#B91C1C" }}>
            {actionData.error}
          </p>
        ) : shipments.length === 0 && hasFilters ? (
          <div className="mv-panel-body mv-muted">
            <p style={{ marginBottom: "0.5rem" }}>
              No shipments match these filters{tab !== "all" ? ` in “${TABS.find((entry) => entry.value === tab)?.label}”` : ""}.
            </p>
            <Link to="/admin/shipping" className="mv-button">Clear all filters</Link>
          </div>
        ) : shipments.length === 0 ? (
          <p className="mv-panel-body mv-muted">
            No shipments yet. A shipment is created by booking a parcel from an order; nothing is
            created to fill this table.
          </p>
        ) : (
          /*
           * Wide on purpose: §7 asks the row to carry packages, tracking, latest
           * provider event, estimate, last refresh, pickup and Shopify sync, and
           * a table that hides half of them behind a click is the table this
           * section was written to replace. The container scrolls.
           */
          <div className="mv-table-wrap">
            <table className="mv-table" style={{ minWidth: 1720 }}>
            <thead>
              <tr>
                {/*
                  THE EIGHT THE WORK ORDER NAMES, IN ITS ORDER, AND THEN THE
                  OPERATIONAL COLUMNS THIS DEPLOYMENT ALREADY RELIED ON.

                  The eight lead because that is the required reading order — a
                  person scanning this table is asking what was ordered, who is
                  carrying it, where it is going, what has been bought for it and
                  what is left to do. The columns after them are the ones an
                  operator here uses daily (which dock, whether Shopify has been
                  told, what the carrier billed); they are kept rather than
                  deleted, because removing a working surface to satisfy a
                  column order would cost real information, and the order the
                  work order specifies is preserved at the front where it matters.
                */}
                <th>Order #</th>
                <th>Courier</th>
                <th>Tracking #</th>
                <th>Destination</th>
                <th>Shipping label</th>
                <th>Packing list</th>
                <th>Status</th>
                <th>Report</th>
                <th>Est. delivery</th>
                <th>Pickup</th>
                <th>Shopify</th>
                <th>Last refresh</th>
                <th>Seller charge</th>
                <th>Carrier cost</th>
                <th>Billing</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shipments.map((s) => {
                const addr = parseAddress(s.order.shippingAddress);
                const dest = [addr.city, addr.province || addr.provinceCode, addr.zip || addr.postalCode].filter(Boolean).join(", ") || "—";
                const carrierCost = s.finalBilledCost ?? s.bookedCost;
                const display = trackingDisplay(s.trackingStatus, s.status);
                const latest = s.trackingEvents[0];
                const latestText = carrierEventText(latest);
                const sync = shopifySync(s);
                const numbering = shipmentNumber[s.id];
                const shipmentIndex = numbering?.index ?? 1;
                const shipmentTotal = numbering?.total ?? 1;
                /*
                 * The words the work order asks the Status column to carry.
                 *
                 * These are NOT a second status vocabulary — they are the
                 * operator's answer to "what is the one thing left to do", read
                 * from facts the shipment already holds. `packedAt` and
                 * `handedToCarrierAt` are the warehouse's own milestones, and
                 * the label half is the provider's identifier, which is the only
                 * thing that proves a label was actually bought.
                 */
                const packingWord = !s.providerShipmentId
                  ? "Not booked"
                  : !s.packedAt
                    ? "Label created — needs packing"
                    : !s.handedToCarrierAt
                      ? "Waiting for pickup"
                      : null;
                /*
                 * LATE IS A STORED DEADLINE OR A CARRIER EXCEPTION, never
                 * elapsed time. The work order is explicit, and it is the right
                 * rule: a parcel three days into a five-day ground service is
                 * not late, and a table that paints it red teaches people to
                 * ignore red. An estimated delivery in the past is the deadline
                 * we actually have; a carrier exception is the other.
                 */
                const isLate =
                  display === "EXCEPTION" ||
                  (s.estimatedDelivery != null &&
                    s.estimatedDelivery.getTime() < Date.now() &&
                    display !== "DELIVERED" &&
                    s.status !== "CANCELLED");
                return (
                  <tr key={s.id}>
                    {/*
                      ORDER # — a real link, and it names WHICH shipment of the
                      order this row is.

                      `shipmentIndex` is the order's own shipment number and
                      `shipmentTotal` its count, both computed in the loader from
                      the order's shipments ordered by creation — so "Shipment 2
                      of 3" is a fact about the order, not about the page. A
                      split order whose second parcel is on page 4 still reads
                      "2 of 3" rather than "1 of 2".
                    */}
                    <td>
                      <Link to={`/admin/orders/${s.order.id}`}>{s.order.shopifyOrderName}</Link>
                      {shipmentTotal > 1 ? (
                        <div className="mv-muted">Shipment {shipmentIndex} of {shipmentTotal}</div>
                      ) : null}
                      <div className="mv-muted">
                        <Link to={`/admin/shipping/${s.id}?${listQuery}`}>
                          {s.returnOfShipmentId ? "Return " : ""}{s.id.slice(0, 8)}
                        </Link>
                        {" · "}{formatDate(s.createdAt)}
                      </div>
                      <div className="mv-muted">{s.order.supplierReference}</div>
                      <div className="mv-muted">{s.order.seller.storeName}</div>
                    </td>
                    <td>
                      {s.carrier || "—"}
                      <div className="mv-muted">{s.serviceName || "—"}</div>
                    </td>
                    <td>
                      {s.trackingNumber || "—"}
                      {s.trackingUrl ? (
                        <div>
                          <a href={s.trackingUrl} target="_blank" rel="noreferrer">Track</a>
                        </div>
                      ) : null}
                    </td>
                    {/*
                      DESTINATION — city and the two-letter province or state, as
                      the work order specifies. The full address is on the detail
                      page; a table cell is not where anybody reads a street.
                    */}
                    <td>{destinations[s.id] ?? "—"}</td>
                    {/*
                      SHIPPING LABEL — the cell that says what has been bought.

                      Three states, and the difference between them is the
                      difference between "nothing exists yet", "something is
                      happening" and "a label exists". The middle one is why this
                      is not a boolean: a booking in flight must not offer a
                      second Book button, and a browser-side disable is not
                      enough — the server refuses the duplicate by idempotency
                      key, and this is only what the operator sees while it does.
                    */}
                    <td>
                      {s.providerShipmentId ? (
                        s.labelUrl ? (
                          <a href={s.labelUrl} target="_blank" rel="noreferrer" className="mv-button">
                            Print label
                          </a>
                        ) : (
                          <Link to={`/admin/shipping/${s.id}`} className="mv-button">Label</Link>
                        )
                      ) : s.status === "BOOKING" ? (
                        <button type="button" className="mv-button" disabled title="A booking is in progress for this parcel.">
                          Booking…
                        </button>
                      ) : (
                        <Link to={`/admin/orders/${s.order.id}`} className="mv-button mv-button-dark">
                          Book shipping
                        </Link>
                      )}
                    </td>
                    {/*
                      PACKING LIST — printable as soon as the shipment's contents
                      are defined, which is BEFORE a label is bought. The work
                      order is explicit that these are separate rights: a packer
                      can print what goes in the box while somebody else decides
                      who carries it.
                    */}
                    <td>
                      <a href={`/admin/packing-list/${s.id}?download=1`} className="mv-button">
                        Print packing list
                      </a>
                    </td>
                    <td>
                      {/*
                        The normalized word, then the carrier's own. The second
                        line is the shipment's lifecycle status — BOOKING_FAILED
                        and BOOKED both read as one parcel state or another, and
                        the difference is the whole reason those states exist. The
                        third is the newest raw event, which is where the wording
                        the normalized set flattens survives.
                      */}
                      <span
                        className={`mv-badge ${trackingDisplayBadge[display] ?? ""}`}
                        // The nine words merge "the carrier tried and failed"
                        // with "the carrier says it cannot be delivered"; the
                        // hover keeps that distinction reachable instead of
                        // dropping it on the way to the screen.
                        title={s.trackingStatus ? trackingLabel(s.trackingStatus) : undefined}
                      >
                        {trackingDisplayLabel(display)}
                      </span>
                      <div style={{ marginTop: "0.25rem" }}>
                        <span className={`mv-badge ${statusBadge[s.status] ?? ""}`}>{s.status}</span>
                      </div>
                      {latestText ? (
                        <div className="mv-muted" title={latestText}>
                          {latestText.length > 60 ? `${latestText.slice(0, 60)}…` : latestText}
                        </div>
                      ) : null}
                      {latest ? (
                        <div className="mv-muted">
                          {latest.location ? `${latest.location} · ` : ""}
                          {formatDateTime(latest.eventAt)}
                        </div>
                      ) : null}
                      {/*
                        The warehouse half of the answer, alongside the carrier's
                        half. "Delivered" and "still on the dock" are both true of
                        different parcels with the same tracking word, and this is
                        the line that tells them apart without opening the row.
                      */}
                      {packingWord ? <div className="mv-muted">{packingWord}</div> : null}
                      {/*
                        LATE SITS BESIDE THE TRUE STATUS, NEVER INSTEAD OF IT.
                        The carrier's own word stays visible; this is a warning
                        layered on it, because replacing "In transit" with "Late"
                        would lose the fact that the carrier has it at all.
                      */}
                      {isLate ? (
                        <div style={{ marginTop: "0.2rem" }}>
                          <span className="mv-badge mv-badge-danger" title={display === "EXCEPTION" ? "The carrier reported a problem with this parcel." : `The estimated delivery date (${formatDate(s.estimatedDelivery!)}) has passed.`}>
                            Late
                          </span>
                        </div>
                      ) : null}
                    </td>
                    {/*
                      REPORT — visible on EVERY row, and disabled.

                      It is drawn rather than omitted because its absence is
                      indistinguishable from a bug, and it is DISABLED with a
                      reason rather than made a link to nothing because a control
                      that appears to work and does not is how a page loses its
                      credibility. Nothing is submitted and nothing is claimed.
                    */}
                    <td>
                      <button
                        type="button"
                        className="mv-button"
                        disabled
                        title="Reporting is not built yet. Nothing has been submitted."
                        aria-describedby={`report-soon-${s.id}`}
                      >
                        Report
                      </button>
                      <div className="mv-muted" id={`report-soon-${s.id}`} style={{ fontSize: "0.68rem" }}>
                        Coming soon
                      </div>
                    </td>
                    {/* The carrier states a calendar date, parsed as midnight UTC: read in a
                        western zone it would print the day before. */}
                    <td>{s.estimatedDelivery ? formatDate(s.estimatedDelivery, { timeZone: CALENDAR_DATE_TIME_ZONE }) : "—"}</td>
                    <td>
                      {s.pickupMode ? (
                        <div>{PICKUP_MODE_LABEL[s.pickupMode] ?? s.pickupMode}</div>
                      ) : (
                        <div className="mv-muted">Not recorded</div>
                      )}
                      {s.pickupStatus ? (
                        <div style={{ marginTop: "0.2rem" }}>
                          <span className={`mv-badge ${PICKUP_STATUS_BADGE[s.pickupStatus] ?? ""}`}>
                            {PICKUP_STATUS_LABEL[s.pickupStatus] ?? s.pickupStatus}
                          </span>
                        </div>
                      ) : null}
                      {s.pickupScheduledFor ? (
                        <div className="mv-muted">{formatDateTime(s.pickupScheduledFor)}</div>
                      ) : null}
                      {s.pickupWindow ? <div className="mv-muted">{s.pickupWindow}</div> : null}
                    </td>
                    <td>
                      <span className={`mv-badge ${sync.badge}`} title={sync.title ?? undefined}>{sync.text}</span>
                      {s.shopifyNotifiedAt ? (
                        <div className="mv-muted">customer told {formatDate(s.shopifyNotifiedAt)}</div>
                      ) : null}
                    </td>
                    <td>
                      {s.lastTrackingSyncAt ? formatDateTime(s.lastTrackingSyncAt) : "—"}
                      {s.trackingSyncFailures > 0 ? (
                        <div style={{ marginTop: "0.2rem" }}>
                          <span className="mv-badge mv-badge-warning">
                            {s.trackingSyncFailures} failed {s.trackingSyncFailures === 1 ? "attempt" : "attempts"}
                          </span>
                        </div>
                      ) : null}
                      {s.lastTrackingError ? (
                        <div style={{ marginTop: "0.2rem" }}>
                          <span className="mv-badge mv-badge-danger" title={s.lastTrackingError}>sync error</span>
                        </div>
                      ) : null}
                    </td>
                    <td>{money(s.sellerShippingCharge, s.order.currency)}</td>
                    <td>
                      {money(carrierCost, s.order.currency)}
                      {s.quotedCarrierCost != null && s.bookedCost != null && s.quotedCarrierCost !== s.bookedCost ? (
                        <div className="mv-muted">quoted {money(s.quotedCarrierCost)}</div>
                      ) : null}
                    </td>
                    <td>
                      <span className={`mv-badge ${s.billingStatus === "RECONCILED" ? "mv-badge-success" : s.billingStatus === "VARIANCE" ? "mv-badge-warning" : ""}`}>
                        {s.billingStatus.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td>
                      <div className="mv-actions" style={{ gap: "0.25rem" }}>
                        <Link to={`/admin/shipping/${s.id}`} className="mv-button">Open</Link>
                        {/*
                          Keyed on the provider shipment id, which is what these
                          two actions actually need, rather than on PENDING.
                          Before bookings landed on BOOKED, "PENDING with a
                          provider id" was the booked-not-yet-shipped state; now
                          that state has a name of its own, and leaving the old
                          test here would hide Sync and Cancel on every booked
                          shipment.
                        */}
                        {s.providerShipmentId && ["BOOKED", "SHIPPED", "EXCEPTION", "CANCELLING"].includes(s.status) ? (
                          <>
                            <Form method="post">
                              <input type="hidden" name="intent" value="sync_tracking" />
                              <input type="hidden" name="shipmentId" value={s.id} />
                              <button type="submit" className="mv-button">Sync</button>
                            </Form>
                            <Form method="post">
                              <input type="hidden" name="intent" value="cancel_shipment" />
                              <input type="hidden" name="shipmentId" value={s.id} />
                              <button type="submit" className="mv-button mv-button-danger">Cancel</button>
                            </Form>
                          </>
                        ) : null}
                        {/*
                          ONLY WHAT THE SHIPMENT'S OWN RECORD ALLOWS. The old
                          guard offered both events on BOOKED, SHIPPED and
                          EXCEPTION rows — so a shipped or exception parcel
                          still showed "handed to carrier", which the service
                          now refuses and which would have regressed the
                          carrier's own status. The options come from the same
                          function the server validates with, so a listed event
                          is an accepted one, and a row with nothing to record
                          shows no control at all.
                        */}
                        {availableWarehouseEvents(s).length > 0 ? (
                          <Form method="post" className="mv-actions" style={{ gap: "0.25rem" }}>
                            <input type="hidden" name="intent" value="advance_shipment" />
                            <input type="hidden" name="shipmentId" value={s.id} />
                            <select name="event" defaultValue={availableWarehouseEvents(s)[0]} className="mv-input" style={{ padding: "0.15rem 0.25rem", fontSize: "0.62rem", minHeight: "auto" }}>
                              {availableWarehouseEvents(s).map((ev) => (
                                <option key={ev} value={ev}>{ev.replace(/_/g, " ")}</option>
                              ))}
                            </select>
                            <button type="submit" className="mv-button mv-button-dark">Go</button>
                          </Form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
        )}
      </section>

      {pageCount > 1 ? (
        <div className="mv-actions" style={{ marginTop: "1rem" }}>
          {page > 1 ? (
            <Link to={`?${new URLSearchParams({ ...filters, page: String(page - 1) } as Record<string, string>).toString()}`} className="mv-button">&larr; Previous</Link>
          ) : null}
          <span className="mv-muted" style={{ fontSize: "0.78rem" }}>Page {page} of {pageCount}</span>
          {page < pageCount ? (
            <Link to={`?${new URLSearchParams({ ...filters, page: String(page + 1) } as Record<string, string>).toString()}`} className="mv-button">Next &rarr;</Link>
          ) : null}
        </div>
      ) : null}

      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem" }}>
        <Link to="/admin" style={{ color: "#082a4a", fontWeight: 500 }}>&larr; Back to Dashboard</Link>
      </p>
    </div>
  );
}
