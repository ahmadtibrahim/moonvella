import { Link, Form, useLoaderData, useActionData, useNavigation, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requirePermission, assertSameOrigin, getRequestMeta } from "~/utils/adminAuth.server";
import { prisma } from "~/db.server";
import { advanceShipment, type ShipmentAdvanceEvent } from "~/services/fulfillment.server";
import { syncTrackingForShipment, voidShipment } from "~/services/shipping.server";
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
  TRACKING_DISPLAY_ORDER,
  type TrackingDisplayStatus,
} from "~/services/shippingLogic";
import { maskedEshipperAccount, eshipperMode } from "~/services/eshipper.server";

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

const ADVANCE_EVENTS: ShipmentAdvanceEvent[] = [
  "packed",
  "handed_to_carrier",
  "shipped",
  "in_transit",
  "delivered",
  "exception",
];

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

const PICKUP_STATUS_COLOR: Record<string, string> = {
  SCHEDULED: "#059669",
  FAILED: "#dc2626",
  MISSED: "#b45309",
  CANCELLED: "#64748b",
};

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
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));

  const and: Record<string, unknown>[] = [];
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

  const [shipments, total, delivered, pending, exceptions, sellers, origins, awaitingPrep] = await Promise.all([
    prisma.shipment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        trackingNumber: true,
        trackingUrl: true,
        carrier: true,
        serviceName: true,
        status: true,
        trackingStatus: true,
        // The row gates its cancel control on this, and the search above matches
        // on it; without it in the select the row cannot render that control.
        providerShipmentId: true,
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
  ]);

  return {
    shipments,
    total,
    delivered,
    pending,
    exceptions,
    sellers,
    origins,
    awaitingPrep,
    mode: await eshipperMode(),
    account: await maskedEshipperAccount(),
    filters: { status, carrier, seller: sellerId, billing: billingStatus, q, from, to, origin: originId, destination, tracking, pickup, syncErrors: syncErrors ? "1" : "" },
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

const th: React.CSSProperties = { padding: "0.5rem", fontSize: "0.68rem", color: "#64748b", textAlign: "left" };
const td: React.CSSProperties = { padding: "0.5rem", fontSize: "0.78rem", verticalAlign: "top" };
const input: React.CSSProperties = { padding: "0.4rem 0.5rem", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: "0.75rem", boxSizing: "border-box" };
const smallBtn = (color: string): React.CSSProperties => ({ padding: "0.2rem 0.45rem", border: `1px solid ${color}`, borderRadius: 4, background: "white", color, fontSize: "0.65rem", fontWeight: 600, cursor: "pointer" });

const statusColor: Record<string, string> = {
  PENDING: "#b45309",
  BOOKING: "#0369a1",
  BOOKING_FAILED: "#dc2626",
  BOOKING_UNKNOWN: "#b45309",
  BOOKED: "#059669",
  CANCELLING: "#64748b",
  SHIPPED: "#0369a1",
  DELIVERED: "#059669",
  EXCEPTION: "#dc2626",
  CANCELLED: "#64748b",
};

/**
 * The nine display words are one vocabulary; this is the other half of it, the
 * colors. Colored from the DISPLAY status rather than from the carrier's raw
 * state, so "Undelivered" and "Exception" cannot come out green and red for the
 * same situation on two adjacent rows.
 */
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
 * When neither is there the cell says so, in the same words the booking gate
 * uses, rather than showing a blank an operator would read as "fine".
 */
function originLabel(shipment: {
  originLocation: { code: string; name: string } | null;
  originSnapshot: unknown;
}): string {
  if (shipment.originLocation) return shipment.originLocation.code;
  const snap = shipment.originSnapshot as { code?: unknown } | null;
  if (snap && typeof snap === "object" && typeof snap.code === "string") return snap.code;
  return "Pickup location required";
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
}): { text: string; color: string; title: string | null } {
  if (shipment.shopifyFulfillmentId) {
    const when = shipment.shopifySyncedAt ? new Date(shipment.shopifySyncedAt).toLocaleDateString() : null;
    return {
      text: when ? `Fulfilled ${when}` : "Fulfilled",
      color: "#059669",
      title: `Shopify fulfillment ${shipment.shopifyFulfillmentId}`,
    };
  }
  if (shipment.shopifySyncError) return { text: "Sync failed", color: "#dc2626", title: shipment.shopifySyncError };
  return { text: "Awaiting dispatch", color: "#64748b", title: null };
}

export default function AdminShipping() {
  const { shipments, total, delivered, pending, exceptions, sellers, origins, awaitingPrep, mode, account, filters, page, pageCount } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const loading = navigation.state === "loading";

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, color: "#082a4a", marginBottom: "0.25rem" }}>Shipping</h1>
      <p style={{ color: "#64748b", fontSize: "0.875rem", marginBottom: "1rem" }}>
        One row per shipment, so a split order shows each parcel. Parsing, quoting and booking begin from a parcel.
      </p>
      <p style={{ fontSize: "0.75rem", marginBottom: "1rem" }}>
        <Link to="/admin/orders" style={{ color: "#0369a1", fontWeight: 600 }}>
          {awaitingPrep} order{awaitingPrep === 1 ? "" : "s"} awaiting shipment preparation &rarr;
        </Link>
      </p>

      {actionData?.error ? (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 8, padding: "0.75rem", marginBottom: "1rem", fontSize: "0.82rem" }}>
          {actionData.error}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.75rem", marginBottom: "1.25rem" }}>
        {[
          { label: "Total shipments", value: total, color: "#082a4a" },
          { label: "Awaiting booking", value: pending, color: "#b45309" },
          { label: "Delivered", value: delivered, color: "#059669" },
          { label: "Needs attention", value: exceptions, color: "#dc2626" },
        ].map((c) => (
          <div key={c.label} style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, padding: "1rem" }}>
            <div style={{ fontSize: "0.72rem", color: "#64748b" }}>{c.label}</div>
            <div style={{ fontSize: "1.6rem", fontWeight: 700, color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>

      <Form method="get" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "1rem" }}>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Search
          <br />
          <input name="q" defaultValue={filters.q} placeholder="Order, shipment, tracking, seller" style={{ ...input, width: 240 }} />
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Status
          <br />
          <select name="status" defaultValue={filters.status} style={input}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Carrier / service
          <br />
          <input name="carrier" defaultValue={filters.carrier} placeholder="Any" style={{ ...input, width: 120 }} />
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Seller
          <br />
          <select name="seller" defaultValue={filters.seller} style={input}>
            <option value="">All</option>
            {sellers.map((s) => (
              <option key={s.id} value={s.id}>{s.storeName}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Billing
          <br />
          <select name="billing" defaultValue={filters.billing} style={input}>
            <option value="">All</option>
            {["PENDING", "RECONCILED", "VARIANCE", "NEEDS_RECONCILIATION"].map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Tracking
          <br />
          <select name="tracking" defaultValue={filters.tracking} style={input}>
            <option value="">All</option>
            {/* The nine words, in movement order. The values are the internal
                display statuses; the labels are what the rows show. */}
            {TRACKING_DISPLAY_ORDER.map((s) => (
              <option key={s} value={s}>{trackingDisplayLabel(s)}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Pickup
          <br />
          <select name="pickup" defaultValue={filters.pickup} style={input}>
            <option value="">All</option>
            {PICKUP_FILTERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Origin
          <br />
          <select name="origin" defaultValue={filters.origin} style={input}>
            <option value="">Any</option>
            {origins.map((o) => (
              <option key={o.id} value={o.id}>{o.code} — {o.name}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Destination
          <br />
          <input name="destination" defaultValue={filters.destination} placeholder="City, province or ZIP" style={{ ...input, width: 160 }} />
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          Created from
          <br />
          <input type="date" name="from" defaultValue={filters.from} style={input} />
        </label>
        <label style={{ fontSize: "0.68rem", color: "#64748b" }}>
          to
          <br />
          <input type="date" name="to" defaultValue={filters.to} style={input} />
        </label>
        {/* Unchecked inputs send nothing, which is what "no filter" means; 1 is
            the only value the loader reads. */}
        <label style={{ fontSize: "0.68rem", color: "#64748b", display: "flex", gap: "0.3rem", alignItems: "center", paddingBottom: "0.4rem" }}>
          <input type="checkbox" name="syncErrors" value="1" defaultChecked={filters.syncErrors === "1"} />
          Sync errors
        </label>
        <button type="submit" style={{ ...input, background: "#082a4a", color: "white", border: "none", fontWeight: 600, cursor: "pointer" }}>Filter</button>
        <Link to="/admin/shipping" style={{ fontSize: "0.75rem", color: "#082a4a", paddingBottom: "0.4rem" }}>Reset</Link>
        <span style={{ fontSize: "0.68rem", color: mode === "real" ? "#64748b" : "#b45309", marginLeft: "auto", paddingBottom: "0.4rem" }}>
          eShipper: {mode === "real" ? account ?? "configured" : "not configured (simulated)"}
        </span>
      </Form>

      <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, overflowX: "auto" }}>
        {loading ? (
          <p style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.85rem" }}>Loading shipments…</p>
        ) : shipments.length === 0 ? (
          <p style={{ padding: "2rem", textAlign: "center", color: "#64748b", fontSize: "0.85rem" }}>
            No shipments match. Shipments are created by booking a parcel from an order; none are created to fill this table.
          </p>
        ) : (
          /*
           * Wide on purpose: §7 asks the row to carry packages, tracking, latest
           * provider event, estimate, last refresh, pickup and Shopify sync, and
           * a table that hides half of them behind a click is the table this
           * section was written to replace. The container scrolls.
           */
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1720 }}>
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <th style={th}>Shipment</th>
                <th style={th}>Order / seller</th>
                <th style={th}>From &rarr; to</th>
                <th style={th}>Carrier / service</th>
                <th style={th}>Packages &amp; tracking</th>
                <th style={th}>Status</th>
                <th style={th}>Est. delivery</th>
                <th style={th}>Pickup</th>
                <th style={th}>Shopify</th>
                <th style={th}>Last refresh</th>
                <th style={th}>Seller charge</th>
                <th style={th}>Carrier cost</th>
                <th style={th}>Billing</th>
                <th style={th}>Actions</th>
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
                return (
                  <tr key={s.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={td}>
                      <Link to={`/admin/shipping/${s.id}`} style={{ fontWeight: 600, color: "#082a4a" }}>
                        {s.returnOfShipmentId ? "Return " : ""}{s.id.slice(0, 8)}
                      </Link>
                      <div style={{ fontSize: "0.65rem", color: "#94a3b8" }}>{new Date(s.createdAt).toLocaleDateString()}</div>
                    </td>
                    <td style={td}>
                      <Link to={`/admin/orders/${s.order.id}`} style={{ color: "#082a4a" }}>{s.order.shopifyOrderName}</Link>
                      <div style={{ fontSize: "0.65rem", color: "#94a3b8" }}>{s.order.supplierReference}</div>
                      <div style={{ fontSize: "0.65rem", color: "#94a3b8" }}>{s.order.seller.storeName}</div>
                    </td>
                    <td style={td}>
                      <span style={{ fontSize: "0.72rem" }}>{originLabel(s)}</span>
                      <div style={{ fontSize: "0.65rem", color: "#94a3b8" }}>&rarr; {dest}</div>
                    </td>
                    <td style={td}>
                      {s.carrier || "—"}
                      <div style={{ fontSize: "0.65rem", color: "#94a3b8" }}>{s.serviceName || "—"}</div>
                    </td>
                    <td style={td}>
                      {s.trackingNumber || "—"}
                      <div style={{ fontSize: "0.65rem", color: "#94a3b8" }}>
                        {s.packageCount != null ? `${s.packageCount} package${s.packageCount === 1 ? "" : "s"}` : "packages not recorded"}
                      </div>
                      {s.trackingUrl ? (
                        <div>
                          <a href={s.trackingUrl} target="_blank" rel="noreferrer" style={{ fontSize: "0.65rem", color: "#0369a1" }}>Track</a>
                        </div>
                      ) : null}
                    </td>
                    <td style={td}>
                      {/*
                        The normalized word, then the carrier's own. The second
                        line is the shipment's lifecycle status — BOOKING_FAILED
                        and BOOKED both read as one parcel state or another, and
                        the difference is the whole reason those states exist. The
                        third is the newest raw event, which is where the wording
                        the normalized set flattens survives.
                      */}
                      <span
                        style={{ color: trackingDisplayColor[display], fontWeight: 600 }}
                        // The nine words merge "the carrier tried and failed"
                        // with "the carrier says it cannot be delivered"; the
                        // hover keeps that distinction reachable instead of
                        // dropping it on the way to the screen.
                        title={s.trackingStatus ? trackingLabel(s.trackingStatus) : undefined}
                      >
                        {trackingDisplayLabel(display)}
                      </span>
                      <div style={{ fontSize: "0.62rem", color: statusColor[s.status] || "#94a3b8" }}>{s.status}</div>
                      {latestText ? (
                        <div style={{ fontSize: "0.62rem", color: "#64748b" }} title={latestText}>
                          {latestText.length > 60 ? `${latestText.slice(0, 60)}…` : latestText}
                        </div>
                      ) : null}
                      {latest ? (
                        <div style={{ fontSize: "0.62rem", color: "#94a3b8" }}>
                          {latest.location ? `${latest.location} · ` : ""}
                          {new Date(latest.eventAt).toLocaleString()}
                        </div>
                      ) : null}
                    </td>
                    <td style={td}>{s.estimatedDelivery ? new Date(s.estimatedDelivery).toLocaleDateString() : "—"}</td>
                    <td style={td}>
                      {s.pickupMode ? (
                        <div style={{ fontSize: "0.68rem" }}>{PICKUP_MODE_LABEL[s.pickupMode] ?? s.pickupMode}</div>
                      ) : (
                        <div style={{ fontSize: "0.68rem", color: "#94a3b8" }}>Not recorded</div>
                      )}
                      {s.pickupStatus ? (
                        <div style={{ fontSize: "0.62rem", color: PICKUP_STATUS_COLOR[s.pickupStatus] || "#64748b", fontWeight: 600 }}>
                          {PICKUP_STATUS_LABEL[s.pickupStatus] ?? s.pickupStatus}
                        </div>
                      ) : null}
                      {s.pickupScheduledFor ? (
                        <div style={{ fontSize: "0.62rem", color: "#94a3b8" }}>
                          {new Date(s.pickupScheduledFor).toLocaleString()}
                        </div>
                      ) : null}
                      {s.pickupWindow ? <div style={{ fontSize: "0.62rem", color: "#94a3b8" }}>{s.pickupWindow}</div> : null}
                    </td>
                    <td style={td}>
                      <span style={{ fontSize: "0.68rem", color: sync.color, fontWeight: sync.text === "Sync failed" ? 600 : 400 }} title={sync.title ?? undefined}>
                        {sync.text}
                      </span>
                      {s.shopifyNotifiedAt ? (
                        <div style={{ fontSize: "0.62rem", color: "#94a3b8" }}>customer told {new Date(s.shopifyNotifiedAt).toLocaleDateString()}</div>
                      ) : null}
                    </td>
                    <td style={td}>
                      {s.lastTrackingSyncAt ? new Date(s.lastTrackingSyncAt).toLocaleString() : "—"}
                      {s.trackingSyncFailures > 0 ? (
                        <div style={{ fontSize: "0.62rem", color: "#b45309" }}>
                          {s.trackingSyncFailures} failed {s.trackingSyncFailures === 1 ? "attempt" : "attempts"}
                        </div>
                      ) : null}
                      {s.lastTrackingError ? (
                        <div style={{ fontSize: "0.62rem", color: "#dc2626" }} title={s.lastTrackingError}>sync error</div>
                      ) : null}
                    </td>
                    <td style={td}>{money(s.sellerShippingCharge, s.order.currency)}</td>
                    <td style={td}>
                      {money(carrierCost, s.order.currency)}
                      {s.quotedCarrierCost != null && s.bookedCost != null && s.quotedCarrierCost !== s.bookedCost ? (
                        <div style={{ fontSize: "0.62rem", color: "#b45309" }}>quoted {money(s.quotedCarrierCost)}</div>
                      ) : null}
                    </td>
                    <td style={td}>
                      <span style={{ fontSize: "0.68rem", color: s.billingStatus === "RECONCILED" ? "#059669" : s.billingStatus === "VARIANCE" ? "#b45309" : "#64748b" }}>
                        {s.billingStatus.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                        <Link to={`/admin/shipping/${s.id}`} style={{ ...smallBtn("#082a4a"), textDecoration: "none" }}>Open</Link>
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
                              <button type="submit" style={smallBtn("#0369a1")}>Sync</button>
                            </Form>
                            <Form method="post">
                              <input type="hidden" name="intent" value="cancel_shipment" />
                              <input type="hidden" name="shipmentId" value={s.id} />
                              <button type="submit" style={smallBtn("#dc2626")}>Cancel</button>
                            </Form>
                          </>
                        ) : null}
                        {s.status === "BOOKED" || s.status === "SHIPPED" || s.status === "EXCEPTION" ? (
                          <Form method="post" style={{ display: "flex", gap: "0.2rem", alignItems: "center" }}>
                            <input type="hidden" name="intent" value="advance_shipment" />
                            <input type="hidden" name="shipmentId" value={s.id} />
                            <select name="event" defaultValue="in_transit" style={{ ...input, padding: "0.15rem 0.25rem", fontSize: "0.62rem" }}>
                              {ADVANCE_EVENTS.map((ev) => (
                                <option key={ev} value={ev}>{ev.replace(/_/g, " ")}</option>
                              ))}
                            </select>
                            <button type="submit" style={smallBtn("#082a4a")}>Go</button>
                          </Form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {pageCount > 1 ? (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "1rem", fontSize: "0.78rem" }}>
          {page > 1 ? (
            <Link to={`?${new URLSearchParams({ ...filters, page: String(page - 1) } as Record<string, string>).toString()}`} style={{ color: "#082a4a" }}>&larr; Previous</Link>
          ) : null}
          <span style={{ color: "#64748b" }}>Page {page} of {pageCount}</span>
          {page < pageCount ? (
            <Link to={`?${new URLSearchParams({ ...filters, page: String(page + 1) } as Record<string, string>).toString()}`} style={{ color: "#082a4a" }}>Next &rarr;</Link>
          ) : null}
        </div>
      ) : null}

      <p style={{ marginTop: "1.5rem", fontSize: "0.75rem" }}>
        <Link to="/admin" style={{ color: "#082a4a", fontWeight: 500 }}>&larr; Back to Dashboard</Link>
      </p>
    </div>
  );
}
