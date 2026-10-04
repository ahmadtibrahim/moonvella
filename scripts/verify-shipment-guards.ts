/**
 * The guard rails around a shipment's milestones and a booking.
 *
 * WHY THIS SUITE EXISTS. Three of the defects it covers were silent by
 * construction, and each one costs money or a customer:
 *
 *   - A stale tab re-posting "handed to carrier" dragged an EXCEPTION back to
 *     SHIPPED, so the carrier's own exception disappeared from the record of a
 *     parcel that was in trouble.
 *   - A double click re-stamped a milestone, so "packed at" became the moment
 *     somebody clicked twice rather than the moment the box was taped. The
 *     packing page's own control was the worst of it: it read the row, decided,
 *     and then wrote unconditionally, so two requests that overlapped both won.
 *     §6 drives that race with two real concurrent calls.
 *   - The order page offered a booking for an order that already had a booked
 *     label. `bookShipmentForOrder` answered with its idempotency record and
 *     retried nothing, so the button looked like a retry and did nothing —
 *     which is how an operator learns to press it harder.
 *
 * The rules that close those are one shared decision module
 * (`app/services/shippingLogic.ts`), and this suite drives it two ways: as a
 * PURE matrix over every status and event, and — for the warehouse's two
 * events — against real rows through `advanceShipment`, because the pure
 * answer and the written row are two different claims and only the second one
 * is the record.
 *
 * WHAT IT IS ALLOWED TO TOUCH. Only a database whose name ends in `_verify`
 * (the runner refuses anything else); every fixture is built here and torn down
 * after. The shipments it creates carry NO tracking number, which is what keeps
 * the dispatch milestone off the network: `syncShipmentTracking` returns
 * `no_tracking_number` before it builds an admin client, so no Shopify call is
 * made, and nothing is booked, fulfilled, cancelled or charged. No eShipper,
 * Shopify or Odoo request is issued from this file.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-shipment-guards.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  availableWarehouseEvents,
  advanceRefusal,
  nextQueueAction,
  orderBookingGate,
  shipmentMayBeBooked,
  type ExistingShipmentFacts,
  type ShipmentMilestoneFacts,
} from "~/services/shippingLogic";
import {
  advanceShipment,
  markShipmentPacked,
  type ShipmentAdvanceEvent,
} from "~/services/fulfillment.server";

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const prisma = new PrismaClient();
const suffix = Date.now().toString(36).toUpperCase();
const created = { sellerIds: [] as string[], orderIds: [] as string[], shipmentIds: [] as string[] };

const ACTOR = {
  actorType: "ADMIN_USER" as const,
  actorId: "verify-shipment-guards",
  actorName: "verify-shipment-guards",
  ipAddress: "127.0.0.1",
  userAgent: "verify",
};

const ALL_STATUSES = [
  "PENDING",
  "BOOKING",
  "BOOKING_FAILED",
  "BOOKING_UNKNOWN",
  "BOOKED",
  "SHIPPED",
  "EXCEPTION",
  "DELIVERED",
  "CANCELLED",
] as const;

const facts = (
  status: string,
  packed = false,
  handed = false,
  providerId: string | null = "PROV-TEST"
): ShipmentMilestoneFacts => ({
  status,
  packedAt: packed ? new Date("2026-01-02T03:04:05Z") : null,
  handedToCarrierAt: handed ? new Date("2026-01-03T03:04:05Z") : null,
  // Present by default, because a BOOKED row in this app is one whose booking
  // returned a provider identifier — the rows that pass null or "" below are
  // the ones proving the packing rule reads it.
  providerShipmentId: providerId,
});

/* -------------------------------------------------------------------------- */
/* §1 The warehouse's two events, as a matrix                                  */
/* -------------------------------------------------------------------------- */

function warehouseMatrixChecks() {
  console.log("\n-- availableWarehouseEvents --");

  /*
   * The full table, written out rather than derived from the implementation.
   * A check that recomputed the expected answer from the same rule it is
   * testing would pass on any rule at all.
   *
   *   [status, packed, handed, providerShipmentId, expected]
   */
  const table: [string, boolean, boolean, string | null, string[]][] = [
    ["PENDING", false, false, null, []],
    ["PENDING", true, false, null, []],
    ["PENDING", false, false, "PROV-TEST", []],
    ["BOOKING", false, false, null, []],
    ["BOOKING", true, false, null, []],
    ["BOOKING_FAILED", false, false, null, []],
    ["BOOKING_FAILED", false, false, "PROV-TEST", []],
    ["BOOKING_FAILED", true, false, "PROV-TEST", []],
    ["BOOKING_UNKNOWN", false, false, null, []],
    ["BOOKING_UNKNOWN", false, false, "PROV-TEST", []],
    ["BOOKING_UNKNOWN", true, false, "PROV-TEST", []],
    ["BOOKED", false, false, "PROV-TEST", ["packed"]],
    ["BOOKED", false, false, null, []],
    ["BOOKED", false, false, "", []],
    ["BOOKED", false, false, "   ", []],
    ["BOOKED", true, false, "PROV-TEST", ["handed_to_carrier"]],
    ["BOOKED", true, true, "PROV-TEST", []],
    ["SHIPPED", true, true, "PROV-TEST", []],
    ["SHIPPED", true, false, "PROV-TEST", []],
    ["EXCEPTION", true, true, "PROV-TEST", []],
    ["EXCEPTION", true, false, "PROV-TEST", []],
    ["DELIVERED", true, true, "PROV-TEST", []],
    ["DELIVERED", true, false, "PROV-TEST", []],
    ["CANCELLED", false, false, null, []],
    ["CANCELLED", true, false, null, []],
  ];

  const wrong = table.filter(([status, packed, handed, provider, expected]) => {
    const got = availableWarehouseEvents(facts(status, packed, handed, provider));
    return JSON.stringify(got) !== JSON.stringify(expected);
  });
  check(
    `the warehouse event matrix is exactly the table, for all ${table.length} rows`,
    wrong.length === 0,
    wrong
      .map(([status, packed, handed, provider, expected]) => {
        const got = availableWarehouseEvents(facts(status, packed, handed, provider));
        return `${status} packed=${packed} handed=${handed} provider=${JSON.stringify(provider)}: got ${got.join("+") || "(none)"} want ${expected.join("+") || "(none)"}`;
      })
      .join("; ")
  );

  check(
    "no later status ever offers a warehouse event",
    ["SHIPPED", "EXCEPTION", "DELIVERED", "CANCELLED"].every(
      (status) =>
        availableWarehouseEvents(facts(status, false, false, null)).length === 0 &&
        availableWarehouseEvents(facts(status, true, false, null)).length === 0
    )
  );

  /*
   * THE SEQUENCE RULE, IN BOTH DIRECTIONS. Packing is offered only for a
   * booked parcel whose booking produced a provider identifier — the order the
   * work order fixes (buy the label, then tape the box) — and the states that
   * bought nothing, or may have bought something still being reconciled, are
   * refused rather than drawn.
   */
  check(
    "packing is offered only for a booked parcel with a provider identifier",
    availableWarehouseEvents(facts("BOOKED", false, false, "PROV-TEST")).includes("packed") &&
      !availableWarehouseEvents(facts("PENDING", false, false, null)).includes("packed") &&
      !availableWarehouseEvents(facts("BOOKING", false, false, null)).includes("packed") &&
      !availableWarehouseEvents(facts("BOOKING_FAILED", false, false, "PROV-TEST")).includes("packed") &&
      !availableWarehouseEvents(facts("BOOKING_UNKNOWN", false, false, "PROV-TEST")).includes("packed")
  );

  check(
    "a booked row with no provider identifier offers nothing at all",
    availableWarehouseEvents(facts("BOOKED", false, false, null)).length === 0 &&
      availableWarehouseEvents(facts("BOOKED", false, false, "")).length === 0 &&
      availableWarehouseEvents(facts("BOOKED", false, false, "   ")).length === 0
  );

  check(
    "a handoff is offered only to a booked AND packed parcel",
    availableWarehouseEvents(facts("BOOKED", false, false, "PROV-TEST")).join() === "packed" &&
      availableWarehouseEvents(facts("BOOKED", true, false, "PROV-TEST")).join() === "handed_to_carrier" &&
      !availableWarehouseEvents(facts("PENDING", true, false, null)).includes("handed_to_carrier")
  );
}

/* -------------------------------------------------------------------------- */
/* §2 Refusals, event by event                                                 */
/* -------------------------------------------------------------------------- */

function refusalChecks() {
  console.log("\n-- advanceRefusal --");

  const refused = (f: ShipmentMilestoneFacts, event: string) => {
    const answer = advanceRefusal(f, event);
    return typeof answer === "string" && answer.length > 0;
  };
  const allowed = (f: ShipmentMilestoneFacts, event: string) => advanceRefusal(f, event) === null;

  /*
   * THE NAMED DEFECT. An EXCEPTION is the carrier saying something went wrong;
   * a later stale post of "shipped" — or of the handoff — must not overwrite it.
   */
  check(
    "an exception is never dragged back to shipped by a later scan or handoff",
    refused(facts("EXCEPTION", true, true), "shipped") &&
      refused(facts("EXCEPTION", true, true), "in_transit") &&
      refused(facts("EXCEPTION", true, false), "handed_to_carrier") &&
      refused(facts("EXCEPTION", true, false), "packed")
  );

  check(
    "a delivered parcel repeats nothing",
    refused(facts("DELIVERED", true, true), "delivered") &&
      refused(facts("DELIVERED", true, true), "shipped") &&
      refused(facts("DELIVERED", true, true), "exception") &&
      refused(facts("DELIVERED", true, true), "packed")
  );

  check(
    "a cancelled shipment accepts no milestone at all",
    ["packed", "handed_to_carrier", "shipped", "in_transit", "delivered", "exception"].every((event) =>
      refused(facts("CANCELLED", false, false), event)
    )
  );

  check(
    "the handoff needs the packing that precedes it",
    refused(facts("BOOKED", false, false), "handed_to_carrier") &&
      allowed(facts("BOOKED", true, false), "handed_to_carrier")
  );

  check(
    "a shipment cannot be handed over, shipped or delivered before a label exists",
    ["PENDING", "BOOKING", "BOOKING_FAILED", "BOOKING_UNKNOWN"].every(
      (status) =>
        refused(facts(status, false, false, null), "handed_to_carrier") &&
        refused(facts(status, false, false, null), "shipped") &&
        refused(facts(status, false, false, null), "delivered") &&
        refused(facts(status, false, false, null), "exception")
    )
  );

  /*
   * THE SEQUENCE RULE. Packing answers to the booking: the label is bought
   * first, so every state that bought nothing — and the two where a label may
   * exist but is being reconciled — is refused, and the refusal names the
   * booking as the missing step. `BOOKED` without a provider identifier is the
   * third case: the status is written by this app, the identifier is the
   * carrier's own record of the purchase, and there is nothing to pack against
   * a purchase nothing can point at.
   */
  check(
    "packing before the label is bought is refused, and says so",
    ["PENDING", "BOOKING_FAILED", "BOOKING_UNKNOWN", "BOOKING"].every((status) => {
      const answer = advanceRefusal(facts(status, false, false, status === "BOOKING_FAILED" ? "PROV-TEST" : null), "packed");
      return typeof answer === "string" && /book the shipment first/.test(answer);
    })
  );

  check(
    "a booked parcel with no provider identifier cannot be packed",
    /reconcile the booking/i.test(String(advanceRefusal(facts("BOOKED", false, false, null), "packed"))) &&
      /reconcile the booking/i.test(String(advanceRefusal(facts("BOOKED", false, false, ""), "packed"))) &&
      allowed(facts("BOOKED", false, false, "PROV-TEST"), "packed")
  );

  check(
    "a milestone cannot be recorded twice",
    refused(facts("BOOKED", true, false), "packed") &&
      refused(facts("BOOKED", true, true), "handed_to_carrier")
  );

  /*
   * The events the carrier's tracking sync still owns. Kept allowed on the
   * states where they are the truth, because refusing them would break the
   * tracking path the same guard rails are meant to protect.
   */
  check(
    "the carrier-side events stay allowed where they are true",
    allowed(facts("SHIPPED", true, true), "delivered") &&
      allowed(facts("SHIPPED", true, true), "exception") &&
      allowed(facts("BOOKED", true, true), "shipped") &&
      allowed(facts("BOOKED", true, true), "in_transit") &&
      allowed(facts("BOOKED", true, true), "delivered")
  );

  check(
    "an unknown event is refused rather than written",
    refused(facts("BOOKED", true, true), "teleported") && refused(facts("PENDING", false, false), "")
  );

  /*
   * The shape of a refusal, not its wording: a sentence, not a code — no id, no
   * provider text, and never an empty string that would render as a blank box
   * where the reason should be.
   */
  check(
    "every refusal is one sentence about this parcel, with no id in it",
    ALL_STATUSES.every((status) =>
      ["packed", "handed_to_carrier", "shipped", "in_transit", "delivered", "exception", ""].every((event) => {
        const answer = advanceRefusal(facts(status, false, false), event);
        if (answer === null) return true;
        return /^[A-Z].*\.$/.test(answer) && answer.length >= 20 && !/[0-9a-f]{16,}/.test(answer);
      })
    )
  );
}

/* -------------------------------------------------------------------------- */
/* §3 Whether a booking may start                                              */
/* -------------------------------------------------------------------------- */

const shipmentFact = (
  status: string,
  opts: { id?: string; createdAt?: string; providerShipmentId?: string | null } = {}
): ExistingShipmentFacts => ({
  id: opts.id ?? `s-${status.toLowerCase()}`,
  createdAt: opts.createdAt ?? "2026-01-01T00:00:00Z",
  status,
  providerShipmentId: opts.providerShipmentId ?? null,
});

function bookingGateChecks() {
  console.log("\n-- orderBookingGate --");

  check(
    "an order with no shipment books the ordinary way",
    orderBookingGate([]).kind === "first_booking"
  );

  check(
    "a cancelled label is not an obstacle — that is exactly when one is replaced",
    orderBookingGate([shipmentFact("CANCELLED")]).kind === "first_booking"
  );

  check(
    "a prepared box routes booking through its own shipment",
    orderBookingGate([shipmentFact("PENDING", { id: "prep-1" })]).kind === "prepared" &&
      (orderBookingGate([shipmentFact("PENDING", { id: "prep-1" })]) as { shipmentId: string }).shipmentId === "prep-1"
  );

  check(
    "a failed attempt is a retry, not a block",
    orderBookingGate([shipmentFact("BOOKING_FAILED", { id: "failed-1" })]).kind === "retry"
  );

  /*
   * THE DEFECT THE WORK ORDER NAMES. BOOKING_UNKNOWN means a label MAY already
   * exist, so there is no retry — the only door is reconciliation, and the gate
   * must never offer the other one.
   */
  const unknown = orderBookingGate([shipmentFact("BOOKING_UNKNOWN", { id: "unknown-1" })]);
  check(
    "an unknown outcome is blocked and points at reconciliation, never a retry",
    unknown.kind === "blocked" &&
      unknown.linkLabel === "Reconcile the booking" &&
      unknown.shipmentId === "unknown-1" &&
      /unknown/i.test(unknown.refusal),
    unknown.kind === "blocked" ? unknown.refusal.slice(0, 60) : unknown.kind
  );

  const inFlight = orderBookingGate([shipmentFact("BOOKING", { id: "in-flight" })]);
  check(
    "a booking already in flight is blocked while it is in flight",
    inFlight.kind === "blocked" && inFlight.linkLabel === "View the booking attempt"
  );

  check(
    "a booked, shipped, excepted or delivered parcel blocks a second booking",
    ["BOOKED", "SHIPPED", "EXCEPTION", "DELIVERED"].every((status) => {
      const gate = orderBookingGate([shipmentFact(status)]);
      return gate.kind === "blocked" && gate.linkLabel === "Open shipment";
    })
  );

  /*
   * A provider id is a label, whatever the local status column says — the two
   * can disagree for exactly as long as the row is being written.
   */
  check(
    "a provider shipment id blocks booking even on a prepared row",
    orderBookingGate([shipmentFact("PENDING", { providerShipmentId: "PROV-1" })]).kind === "blocked" &&
      orderBookingGate([shipmentFact("BOOKING_FAILED", { providerShipmentId: "PROV-1" })]).kind === "blocked"
  );

  check(
    "the gate reads the NEWEST live shipment, not the first row",
    orderBookingGate([
      shipmentFact("BOOKED", { id: "old", createdAt: "2026-01-01T00:00:00Z" }),
      shipmentFact("PENDING", { id: "new", createdAt: "2026-02-01T00:00:00Z" }),
    ]).kind === "prepared" &&
      orderBookingGate([
        shipmentFact("PENDING", { id: "old", createdAt: "2026-01-01T00:00:00Z" }),
        shipmentFact("BOOKED", { id: "new", createdAt: "2026-02-01T00:00:00Z" }),
      ]).kind === "blocked"
  );

  check(
    "a cancelled row beside a live one changes nothing",
    orderBookingGate([
      shipmentFact("CANCELLED", { id: "gone", createdAt: "2026-03-01T00:00:00Z" }),
      shipmentFact("PENDING", { id: "live", createdAt: "2026-01-01T00:00:00Z" }),
    ]).kind === "prepared"
  );

  check(
    "every blocked gate carries the sentence AND the link it is read with",
    ALL_STATUSES.every((status) => {
      const gate = orderBookingGate([shipmentFact(status)]);
      if (gate.kind === "blocked") {
        return gate.refusal.length > 30 && gate.linkLabel.length > 0 && gate.shipmentId.length > 0;
      }
      // CANCELLED is the one status that is not a block (a replacement label is
      // exactly what a voided one is for), and PENDING/BOOKING_FAILED are the
      // two that proceed through the prepared-shipment path.
      return gate.kind === "first_booking" || gate.kind === "prepared" || gate.kind === "retry";
    })
  );

  check(
    "one shipment's own record answers the same question the order-level gate asks",
    shipmentMayBeBooked({ status: "PENDING", providerShipmentId: null }) &&
      shipmentMayBeBooked({ status: "BOOKING_FAILED", providerShipmentId: null }) &&
      !shipmentMayBeBooked({ status: "BOOKING", providerShipmentId: null }) &&
      !shipmentMayBeBooked({ status: "BOOKING_UNKNOWN", providerShipmentId: null }) &&
      !shipmentMayBeBooked({ status: "BOOKED", providerShipmentId: null }) &&
      !shipmentMayBeBooked({ status: "PENDING", providerShipmentId: "PROV-1" })
  );
}

/* -------------------------------------------------------------------------- */
/* §4 What the orders queue says to do next                                    */
/* -------------------------------------------------------------------------- */

function queueActionChecks() {
  console.log("\n-- nextQueueAction --");

  const order = (shipment: Record<string, unknown> | null, opts: { state?: string; paid?: boolean } = {}) =>
    nextQueueAction({
      state: opts.state ?? "IN_FULFILLMENT",
      wholesalePaymentStatus: opts.paid === false ? "PENDING" : "SUCCEEDED",
      shipment: shipment as never,
    });

  check(
    "a cancelled order says so, with no door",
    order(null, { state: "CANCELLED" }).label === "Cancelled" &&
      order(null, { state: "CANCELLED" }).to === undefined
  );

  check(
    "a delivered order says delivered",
    order(null, { state: "DELIVERED" }).label === "Delivered" &&
      order({ status: "DELIVERED", packedAt: null, handedToCarrierAt: null, deliveredAt: new Date() }).label ===
        "Delivered"
  );

  check(
    "an unpaid order asks for the seller's payment first",
    order(null, { paid: false }).label === "Collect seller payment" &&
      order({ status: "PENDING" }, { paid: false }).label === "Collect seller payment"
  );

  /*
   * THE WORK ORDER'S ITEM 4, LABEL BY LABEL. Each of these is a state an
   * operator meets with a different question, and collapsing any two of them
   * into one badge is how somebody is told to book an order that is already
   * booked.
   */
  const noShipment = order(null);
  check(
    "no shipment yet: buy the first label on the order page",
    noShipment.label === "Select rate / book label" && noShipment.to === undefined
  );

  const pending = order({ id: "ship-1", status: "PENDING", packedAt: null, handedToCarrierAt: null });
  check(
    "a prepared box opens its OWN shipment page",
    pending.label === "Select rate / book label" && pending.to === "/admin/shipping/ship-1"
  );

  const booking = order({ id: "ship-2", status: "BOOKING", packedAt: null, handedToCarrierAt: null });
  check(
    "booking in progress is a statement, not a link",
    booking.label === "Booking in progress" && booking.to === undefined && booking.tone === "warning"
  );

  const failed = order({ id: "ship-3", status: "BOOKING_FAILED", packedAt: null, handedToCarrierAt: null });
  check(
    "a failed attempt offers the retry, on the shipment page",
    failed.label === "Retry failed booking" && failed.to === "/admin/shipping/ship-3"
  );

  const unknown = order({ id: "ship-4", status: "BOOKING_UNKNOWN", packedAt: null, handedToCarrierAt: null });
  check(
    "an unknown outcome offers reconciliation and nothing else",
    unknown.label === "Reconcile booking" && unknown.to === "/admin/shipping/ship-4"
  );

  check(
    "a booked parcel asks for packing, then the handoff, then shows tracking",
    order({ id: "s", status: "BOOKED", packedAt: null, handedToCarrierAt: null, providerShipmentId: "PROV-1" })
      .label === "Pack order" &&
      order({
        id: "s",
        status: "BOOKED",
        packedAt: new Date(),
        handedToCarrierAt: null,
        providerShipmentId: "PROV-1",
      }).label === "Hand to carrier" &&
      order({
        id: "s",
        status: "BOOKED",
        packedAt: new Date(),
        handedToCarrierAt: new Date(),
        providerShipmentId: "PROV-1",
      }).label === "Carrier tracking"
  );

  /*
   * A booked row whose provider identifier never landed cannot be packed (the
   * rule above) or handed over, so the queue must not say "Pack order" — it
   * sends the operator to the shipment, where the row's own record is read.
   */
  const noProvider = order({ id: "s6", status: "BOOKED", packedAt: null, handedToCarrierAt: null });
  check(
    "a booked parcel with no provider identifier sends the operator to the shipment, not to packing",
    noProvider.label === "Review the booked shipment" && noProvider.to === "/admin/shipping/s6"
  );

  check(
    "a parcel with the carrier is watched, not re-booked",
    order({ id: "s", status: "SHIPPED", packedAt: null, handedToCarrierAt: null, trackingNumber: "1Z" }).label ===
      "Carrier tracking" &&
      order({ id: "s", status: "EXCEPTION", packedAt: null, handedToCarrierAt: null }).label === "Carrier tracking"
  );

  check(
    "every action is one of the queue's vocabulary, and every link is a shipment page",
    ALL_STATUSES.every((status) => {
      const action = order({
        id: "s",
        status,
        packedAt: null,
        handedToCarrierAt: null,
        providerShipmentId: "PROV-1",
      });
      const known = [
        "Cancelled",
        "Delivered",
        "Collect seller payment",
        "Select rate / book label",
        "Booking in progress",
        "Retry failed booking",
        "Reconcile booking",
        "Review the booked shipment",
        "Pack order",
        "Hand to carrier",
        "Carrier tracking",
      ].includes(action.label);
      return known && (action.to === undefined || action.to === "/admin/shipping/s");
    })
  );
}

/* -------------------------------------------------------------------------- */
/* §5 The rows — advanceShipment against real shipments                        */
/* -------------------------------------------------------------------------- */

async function createShipment(
  status: string,
  providerShipmentId: string | null = status === "BOOKED" ? `PROV-${suffix}` : null
) {
  if (created.sellerIds.length === 0) {
    const shopDomain = `verify-guards-${suffix.toLowerCase()}.myshopify.com`;
    const seller = await prisma.seller.create({
      data: {
        shopDomain,
        shopDomainFull: `https://${shopDomain}`,
        storeName: `Verify Guards ${suffix}`,
        contactEmail: `verify-guards-${suffix.toLowerCase()}@example.test`,
        status: "APPROVED",
        accessVersion: 1,
      },
    });
    created.sellerIds.push(seller.id);
    const order = await prisma.order.create({
      data: {
        sellerId: seller.id,
        shopifyOrderId: `gid://shopify/Order/guards-${suffix}`,
        shopifyOrderName: `#VG-${suffix}`,
        shopifyOrderNumber: 7000,
        supplierReference: `VG-${suffix}`,
        currency: "CAD",
        subtotal: 10000,
        totalTax: 1300,
        totalShipping: 0,
        totalDiscounts: 0,
        totalPrice: 11300,
        moonvellaSubtotal: 6000,
        moonvellaTax: 780,
        moonvellaShipping: 0,
        moonvellaDiscounts: 0,
        moonvellaTotal: 6780,
        wholesalePaymentStatus: "SUCCEEDED",
        shopifyCreatedAt: new Date(),
        shopifyUpdatedAt: new Date(),
        customerName: "Verify Guards Customer",
        shippingAddress: JSON.stringify({ name: "Verify Guards", city: "Toronto", country: "CA" }),
      },
    });
    created.orderIds.push(order.id);
  }

  const orderId = created.orderIds[0];
  const shipment = await prisma.shipment.create({
    data: {
      orderId,
      status: status as never,
      provider: "eshipper",
      // The carrier's own record of the purchase. Present for the BOOKED rows
      // this suite packs, and passable as null to prove the packing refusal.
      providerShipmentId,
      carrier: "Purolator",
      serviceCode: "PUR-EXP",
      serviceName: "Purolator Express",
      /*
       * NO TRACKING NUMBER, deliberately. The dispatch milestone asks Shopify to
       * fulfill, and `syncShipmentTracking` returns before building an admin
       * client when the parcel carries no tracking — so the milestone is
       * exercised for real and the network is never touched.
       */
      packageCount: 1,
    },
  });
  created.shipmentIds.push(shipment.id);
  return shipment;
}

async function reload(shipmentId: string) {
  return prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
}

async function refusalsAgainstRows() {
  console.log("\n-- advanceShipment, against rows --");

  const expectation = async (
    label: string,
    status: string,
    event: ShipmentAdvanceEvent,
    providerShipmentId: string | null = status === "BOOKED" ? `PROV-${suffix}` : null
  ) => {
    const shipment = await createShipment(status, providerShipmentId);
    let message = "";
    try {
      await advanceShipment(shipment.id, event, ACTOR);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const after = await reload(shipment.id);
    check(
      label,
      message.length > 0 && after.status === status && after.packedAt === null && after.handedToCarrierAt === null,
      message ? `refused: ${message.slice(0, 70)}` : "NOT REFUSED"
    );
  };

  await expectation("an EXCEPTION refuses 'shipped' and keeps its exception", "EXCEPTION", "shipped");
  await expectation("a DELIVERED shipment refuses a repeat delivery", "DELIVERED", "delivered");
  await expectation("a CANCELLED shipment refuses the handoff", "CANCELLED", "handed_to_carrier");
  await expectation("a SHIPPED shipment refuses to be packed", "SHIPPED", "packed");
  await expectation("a booking in flight refuses to be packed", "BOOKING", "packed");
  await expectation("an unknown outcome refuses the handoff", "BOOKING_UNKNOWN", "handed_to_carrier");
  await expectation("an unbooked parcel refuses the handoff", "PENDING", "handed_to_carrier");

  /*
   * THE SEQUENCE RULE, AGAINST ROWS. Packing is refused until a label has been
   * bought, and refused for a "booked" row that cannot name the carrier's own
   * record of the purchase — the two ways a manually constructed or stale
   * request could otherwise stamp a milestone nothing was bought for.
   */
  await expectation("an unbooked parcel refuses packing — the label comes first", "PENDING", "packed");
  await expectation("a failed booking refuses packing until a label is bought", "BOOKING_FAILED", "packed");
  await expectation("an unknown outcome refuses packing", "BOOKING_UNKNOWN", "packed");
  await expectation("a booked parcel with no provider identifier refuses packing", "BOOKED", "packed", null);

  /* --- the happy path, in the order the dock actually performs it --------- */
  const booked = await createShipment("BOOKED");
  await advanceShipment(booked.id, "packed", ACTOR);
  const packedRow = await reload(booked.id);
  check(
    "a booked parcel can be packed, and the moment is recorded",
    packedRow.packedAt !== null && packedRow.status === "BOOKED" && packedRow.handedToCarrierAt === null
  );

  /* A second packing is the double click, and it must not re-stamp the moment. */
  let repeatMessage = "";
  try {
    await advanceShipment(booked.id, "packed", ACTOR);
  } catch (error) {
    repeatMessage = error instanceof Error ? error.message : String(error);
  }
  const stillPacked = await reload(booked.id);
  check(
    "a second packing is refused and the recorded moment does not move",
    repeatMessage.length > 0 && stillPacked.packedAt?.getTime() === packedRow.packedAt?.getTime(),
    repeatMessage ? repeatMessage.slice(0, 70) : "NOT REFUSED"
  );

  await advanceShipment(booked.id, "handed_to_carrier", ACTOR);
  const handedRow = await reload(booked.id);
  check(
    "the handoff marks the parcel shipped and stamps its own moment",
    handedRow.status === "SHIPPED" && handedRow.handedToCarrierAt !== null && handedRow.packedAt !== null
  );
  const order = await prisma.order.findUniqueOrThrow({ where: { id: handedRow.orderId } });
  check("...and the order follows to SHIPPED", order.fulfillmentStatus === "SHIPPED", order.fulfillmentStatus);

  let secondHandoff = "";
  try {
    await advanceShipment(booked.id, "handed_to_carrier", ACTOR);
  } catch (error) {
    secondHandoff = error instanceof Error ? error.message : String(error);
  }
  check(
    "a stale re-post of the handoff is refused and cannot move the row again",
    secondHandoff.length > 0 && (await reload(booked.id)).status === "SHIPPED",
    secondHandoff ? secondHandoff.slice(0, 70) : "NOT REFUSED"
  );

  /* --- packing before the label is bought, which is now refused ----------- */
  const prepared = await createShipment("PENDING");
  let earlyPacking = "";
  try {
    await advanceShipment(prepared.id, "packed", ACTOR);
  } catch (error) {
    earlyPacking = error instanceof Error ? error.message : String(error);
  }
  const preparedRow = await reload(prepared.id);
  check(
    "an unbooked box cannot be packed, and the refusal names the booking",
    earlyPacking.length > 0 &&
      preparedRow.packedAt === null &&
      preparedRow.status === "PENDING" &&
      /book the shipment first/.test(earlyPacking),
    earlyPacking ? earlyPacking.slice(0, 90) : "NOT REFUSED"
  );
  let preparedHandoff = "";
  try {
    await advanceShipment(prepared.id, "handed_to_carrier", ACTOR);
  } catch (error) {
    preparedHandoff = error instanceof Error ? error.message : String(error);
  }
  check(
    "...and it cannot be handed over without a label",
    preparedHandoff.length > 0 && (await reload(prepared.id)).status === "PENDING"
  );

  /* --- markShipmentPacked, the packing page's own door -------------------- */
  const shipped = await createShipment("SHIPPED");
  let packingRefusal = "";
  try {
    await markShipmentPacked(shipped.id, ACTOR);
  } catch (error) {
    packingRefusal = error instanceof Error ? error.message : String(error);
  }
  check(
    "the packing page's own control is refused on a parcel already on its way",
    packingRefusal.length > 0 && (await reload(shipped.id)).packedAt === null,
    packingRefusal ? packingRefusal.slice(0, 70) : "NOT REFUSED"
  );
}

/* -------------------------------------------------------------------------- */
/* §6 Two packing requests at once — the race the claim exists for              */
/* -------------------------------------------------------------------------- */

async function concurrentPackingChecks() {
  console.log("\n-- two packing requests at once --");

  /*
   * THE RACE, DRIVEN FOR REAL. Both promises are started before either is
   * awaited, which is what a double submit, or two operators on two screens,
   * looks like from the database. The old implementation — read, decide, write
   * unconditionally — passed both reads and wrote twice; the packing page now
   * goes through `advanceShipment`, whose conditional UPDATE re-checks
   * `packedAt: null` after taking the row lock, so the second writer matches
   * zero rows before it writes or records anything.
   *
   * WHICH REFUSAL THE LOSER GETS IS TIMING, and the check accepts both, because
   * both are correct: if the loser's read happened before the winner's write it
   * fails the claim ("changed while the page was open"), and if it happened after
   * it fails the read ("already recorded"). What is NOT timing — and what the
   * checks below hold to — is that one caller succeeds, the stored moment is the
   * one that caller wrote, and the trail gains a single event.
   */
  /*
   * The fixture is a BOOKED row, because that is the only state the sequence
   * rule lets two callers race over: an unbooked box is refused before the
   * claim is reached, which is a different check (§5) and not this one. A
   * provider identifier is present for the same reason — without it the row is
   * not packable at all.
   */
  const shipment = await createShipment("BOOKED");
  const results = await Promise.allSettled([
    markShipmentPacked(shipment.id, ACTOR),
    markShipmentPacked(shipment.id, ACTOR),
  ]);

  type PackedShipment = Awaited<ReturnType<typeof markShipmentPacked>>;
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<PackedShipment> => result.status === "fulfilled"
  );
  const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  const refusalText = refused.length
    ? refused[0].reason instanceof Error
      ? refused[0].reason.message
      : String(refused[0].reason)
    : "";

  check(
    "exactly one of two concurrent packing requests succeeds",
    fulfilled.length === 1 && refused.length === 1,
    `${fulfilled.length} succeeded, ${refused.length} refused`
  );
  check(
    "the other is refused as a stale or a repeated milestone",
    /changed while the page was open|already recorded/.test(refusalText),
    refusalText ? refusalText.slice(0, 80) : "NOT REFUSED"
  );

  const after = await reload(shipment.id);
  const winnerStamp = fulfilled.length === 1 ? fulfilled[0].value.packedAt : null;
  check(
    "packedAt is written once, and it is the winner's stamp",
    after.packedAt !== null && winnerStamp !== null && after.packedAt.getTime() === winnerStamp.getTime(),
    after.packedAt ? after.packedAt.toISOString() : "not packed"
  );

  const auditRows = await prisma.auditLog.count({
    where: { action: "shipment.packed", entityId: shipment.id },
  });
  check("exactly one packing audit event is recorded", auditRows === 1, `${auditRows} rows`);

  /* A third attempt cannot move the moment or add a second event. */
  let thirdRefusal = "";
  try {
    await markShipmentPacked(shipment.id, ACTOR);
  } catch (error) {
    thirdRefusal = error instanceof Error ? error.message : String(error);
  }
  const settled = await reload(shipment.id);
  const auditAfterThird = await prisma.auditLog.count({
    where: { action: "shipment.packed", entityId: shipment.id },
  });
  check(
    "a later attempt cannot re-stamp a box the race already packed",
    thirdRefusal.length > 0 &&
      settled.packedAt?.getTime() === after.packedAt?.getTime() &&
      auditAfterThird === 1,
    thirdRefusal ? thirdRefusal.slice(0, 70) : "NOT REFUSED"
  );
}

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                     */
/* -------------------------------------------------------------------------- */

async function cleanup() {
  try {
    /*
     * The audit rows are NOT removed, and cannot be: `AuditLog` is append-only
     * at the database level (a trigger refuses DELETE), which is the whole point
     * of an audit trail and not something a test suite gets to relax. The rows
     * this run wrote name shipments that no longer exist, which is how every
     * other suite's fixtures end too.
     */
    if (created.orderIds.length) {
      await prisma.order.deleteMany({ where: { id: { in: created.orderIds } } });
    }
    if (created.sellerIds.length) {
      await prisma.backgroundJob.deleteMany({ where: { sellerId: { in: created.sellerIds } } });
      await prisma.seller.deleteMany({ where: { id: { in: created.sellerIds } } });
    }
  } catch (error) {
    console.error("cleanup failed:", error);
  }
}

/* -------------------------------------------------------------------------- */

async function main() {
  warehouseMatrixChecks();
  refusalChecks();
  bookingGateChecks();
  queueActionChecks();
  await refusalsAgainstRows();
  await concurrentPackingChecks();

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  return failures;
}

main()
  .then(async (failed) => {
    await cleanup();
    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup();
    await prisma.$disconnect();
    process.exit(1);
  });
