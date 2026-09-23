/**
 * Phase B verification: quote invalidation, booking outcomes, pickup status and
 * the packing list.
 *
 * WHAT THIS SUITE IS ALLOWED TO TOUCH. It runs only against a database whose
 * name ends in `_verify` (the runner refuses anything else) and it builds every
 * fixture it needs, tearing each one down after. Every provider call goes
 * through a stubbed `fetch` that replaces the global one: the stub answers the
 * authentication endpoint with a token, answers the rest from a responder this
 * file controls, and REFUSES any host that is not the configured eShipper base
 * URL. So a check that accidentally tried to reach Shopify, Odoo or a real
 * carrier fails here loudly rather than booking anything against an account.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT. Each check exercises the code the
 * routes call, so a PASS is evidence about this application's own behaviour:
 * that a refused booking is retryable, that a timeout is not, that a pickup
 * failure leaves the booking and the label alone, that a second click cannot
 * buy a second label, that the packing list states no money and cannot be read
 * across sellers. It is NOT evidence that eShipper answers the way the stub
 * does. No booking, pickup, cancellation or charge was made anywhere.
 *
 * The timeout check is the reason the file exists: the "unknown outcome" path
 * is the one that can produce a second label if it is wrong, and it is
 * exercised here against an error named exactly the way Node names its own
 * abort — the only thing the adapter distinguishes.
 */

import { PrismaClient } from "@prisma/client";
import {
  QUOTE_INVALIDATION,
  bookPreparedShipment,
  cancelPickupForShipment,
  invalidateQuotes,
  reconcileBookingOutcome,
  resolveUnknownBooking,
  schedulePickupForShipment,
} from "../app/services/shipping.server";
import { addOrderPackage, removeOrderPackage } from "../app/services/fulfillment.server";
import { addressMateriallyDiffers } from "../app/services/addressValidation.server";
import { intakeOrder } from "../app/services/orderIntake.server";
import { packingListFor, parseAddressLines, renderPackingList } from "../app/services/packingList.server";
import { eshipperMode } from "../app/services/eshipper.server";
import { JOB_KIND } from "../app/services/jobs.server";

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
};

/* -------------------------------------------------------------------------- */
/* Provider transport stub                                                    */
/* -------------------------------------------------------------------------- */

const realFetch = globalThis.fetch;
let providerCalls: { method: string; url: string }[] = [];

type Answer = { status: number; body: unknown } | "timeout" | "unreachable";
let responder: (url: string, method: string) => Answer = () => ({ status: 200, body: {} });

/** Calls other than authentication, which every booking makes once and caches. */
function apiCalls() {
  return providerCalls.filter((c) => !/\/api\/v2\/(authenticate|refresh-token)$/.test(c.url));
}

let allowedHostCache: string | null = null;
async function allowedHost(): Promise<string> {
  if (allowedHostCache) return allowedHostCache;
  const { getCredential } = await import("../app/services/credentials.server");
  const base = await getCredential("eshipper", "ESHIPPER_BASE_URL");
  if (!base) {
    // Without a configured base URL the adapter takes its simulated branch and
    // never builds a request, so every check below would pass against code that
    // was never run. Refusing is the only honest answer.
    throw new Error(
      "verify-booking: no eShipper base URL is configured, so the request-mapping path cannot be exercised. " +
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
        `verify-booking: refusing a request to ${host}; this suite may only talk to the configured eShipper host (${expected}).`
      );
    }

    // Authentication is not what any check here is about, and every booking
    // makes one call to it before the call under test. Answered directly so the
    // responder below only ever speaks for the operation being examined.
    if (/\/(authenticate|refresh-token)$/.test(url)) {
      return new Response(
        JSON.stringify({ token: `verify-token-${suffix}`, expires_in: "3600", token_type: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const answer = responder(url, method);
    if (answer === "timeout") {
      // Named exactly as Node names its own abort, which is the only thing the
      // adapter reads. Anything else would be testing a private convention.
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }
    if (answer === "unreachable") {
      // A transport failure: the request never reached the provider.
      throw new TypeError("fetch failed");
    }
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
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const ACTOR = { actorId: "verify-booking", actorName: "verify-booking", ipAddress: "127.0.0.1", userAgent: "verify" };

async function createSeller(label: string) {
  const shopDomain = `verify-booking-${label}-${suffix.toLowerCase()}.myshopify.com`;
  const seller = await prisma.seller.create({
    data: {
      shopDomain,
      shopDomainFull: `https://${shopDomain}`,
      storeName: `Verify Booking ${label}`,
      contactEmail: `verify-booking-${label}-${suffix.toLowerCase()}@example.test`,
      status: "APPROVED",
      accessVersion: 1,
      brandKit: { create: { storeName: `Brand ${label}`, brandColours: { primary: "#1b4d3e" } } },
    },
  });
  created.sellerIds.push(seller.id);
  return seller;
}

/**
 * An order that is eligible to be booked: paid, with a parcel and one quote.
 *
 * `fulfillmentOrderId` is only set where a check needs the Shopify sync path to
 * be reachable at all — the job below is queued from booking, and a store with
 * no fulfillment order id has nothing to queue for.
 */
async function createBookableOrder(sellerId: string, label: string, fulfillmentOrderId: string | null = null) {
  const order = await prisma.order.create({
    data: {
      sellerId,
      shopifyOrderId: `gid://shopify/Order/${label}-${suffix}`,
      shopifyOrderName: `#VB-${label}-${suffix}`,
      shopifyOrderNumber: 9000 + created.orderIds.length,
      supplierReference: `VB-${label}-${suffix}`,
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
      // The scalar the Shopify push reads. A store with no fulfillment order id
      // has nothing to push to, which is a case the booking path handles.
      shopifyFulfillmentOrderId: fulfillmentOrderId,
      shippingAddress: JSON.stringify({
        name: "Verify Customer",
        address1: "1 Test Street",
        city: "Toronto",
        province: "ON",
        zip: "M5H 2N2",
        country: "CA",
      }),
      customerName: "Verify Customer",
      items: {
        create: [
          {
            shopifyLineItemId: `line-${label}-${suffix}`,
            name: "TEST PILLOW",
            sku: `VB-PILLOW-${label}`,
            quantity: 2,
            price: 5000,
            wholesalePrice: 3000,
            totalDiscount: 0,
          },
        ],
      },
      packages: { create: [{ count: 1, length: 60, width: 40, height: 30, weight: 4.5, units: "cm_kg" }] },
    },
    include: { items: true },
  });
  created.orderIds.push(order.id);

  const quote = await prisma.shippingQuote.create({
    data: {
      orderId: order.id,
      provider: "eshipper",
      carrier: "Purolator",
      serviceCode: "PUR-EXP",
      serviceName: "Purolator Express",
      providerQuoteId: `Q-${label}-${suffix}`,
      totalAmount: 3200,
      currency: "CAD",
      selected: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      raw: JSON.stringify({ baseCharge: 30, taxes: 2 }),
    },
  });

  const shipment = await prisma.shipment.create({
    data: {
      orderId: order.id,
      status: "PENDING",
      provider: "eshipper",
      carrier: quote.carrier,
      serviceCode: quote.serviceCode,
      serviceName: quote.serviceName,
      providerQuoteId: quote.providerQuoteId,
      quotedCarrierCost: quote.totalAmount,
      sellerShippingCharge: 2500,
      packageCount: 1,
      items: { create: order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })) },
    },
  });

  return { order, quote, shipment };
}

const BOOKED_BODY = (tag: string) => ({
  shipmentId: `S-${tag}-${suffix}`,
  carrier: "Purolator",
  serviceName: "Purolator Express",
  trackingNumber: `TRK-${tag}-${suffix}`,
  trackingUrl: "https://example.invalid/track",
  labelUrl: "https://example.invalid/label.pdf",
  cost: 33.5,
  currency: "CAD",
});

async function cleanup() {
  try {
    // Orders cascade to shipments, quotes, items and packages. The jobs are
    // keyed by seller, since that is how they were queued.
    if (created.orderIds.length) {
      await prisma.order.deleteMany({ where: { id: { in: created.orderIds } } });
    }
    if (created.sellerIds.length) {
      await prisma.backgroundJob.deleteMany({ where: { sellerId: { in: created.sellerIds } } });
      await prisma.seller.deleteMany({ where: { id: { in: created.sellerIds } } });
    }
    // Webhook events are keyed by shop domain, not by a relation, so nothing
    // above reaches them. Every shop this suite writes is named after its
    // seller label; the prefix is what makes them collectable.
    await prisma.webhookEvent.deleteMany({ where: { shopDomain: { startsWith: "verify-booking-" } } });
  } catch (error) {
    console.error("cleanup failed:", error);
  }
}

/* -------------------------------------------------------------------------- */
/* §6 quote selection: withdrawal                                              */
/* -------------------------------------------------------------------------- */

async function quoteInvalidationChecks() {
  console.log("\n-- quote invalidation --");
  const seller = await createSeller("qi");
  const { order, quote } = await createBookableOrder(seller.id, "qi");

  check("the order starts with a quote to withdraw", (await prisma.shippingQuote.count({ where: { orderId: order.id } })) === 1);

  const result = await invalidateQuotes(order.id, "Packages changed after quoting", ACTOR);
  check("invalidation removes the quotes", result.removed === 1, `removed=${result.removed}`);
  check("no quote remains reachable by id", (await prisma.shippingQuote.count({ where: { orderId: order.id } })) === 0);

  const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  check("the order records when its quotes were withdrawn", reloaded.quotesInvalidatedAt !== null);
  check(
    "the withdrawal records why",
    reloaded.quoteInvalidationReason === "Packages changed after quoting",
    reloaded.quoteInvalidationReason ?? "(null)"
  );
  check(
    "the withdrawal is audited",
    Boolean(
      await prisma.auditLog.findFirst({
        where: { entityId: order.id, action: "shipping.quotes_invalidated" },
        orderBy: { createdAt: "desc" },
      })
    )
  );

  const again = await invalidateQuotes(order.id, "nothing left to remove", ACTOR);
  check("a second invalidation reports nothing removed", again.removed === 0, `removed=${again.removed}`);

  // The withdrawn id must not be bookable: a quote that no longer describes the
  // order is a price for something else.
  const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId: order.id } });
  let refused = "";
  try {
    await bookPreparedShipment(shipment.id, quote.id, ACTOR);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  check("a withdrawn quote id cannot be booked", /select a shipping service/i.test(refused), refused.slice(0, 100));
  check(
    "...and the shipment is untouched by the attempt",
    (await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status === "PENDING"
  );
}

/** One quote on an order, in the shape the rate flow stores. */
async function giveQuote(orderId: string, label: string) {
  return prisma.shippingQuote.create({
    data: {
      orderId,
      provider: "eshipper",
      carrier: "Purolator",
      serviceCode: "PUR-EXP",
      serviceName: "Purolator Express",
      providerQuoteId: `Q-${label}-${suffix}`,
      totalAmount: 3200,
      currency: "CAD",
      selected: true,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      raw: JSON.stringify({ baseCharge: 30, taxes: 2 }),
    },
  });
}

/**
 * Withdrawing a quote is only worth anything if the writes that make a quote
 * wrong actually call it. These checks go through the production entry points —
 * the parcel helpers the admin pages call — rather than the function they end
 * up in, because "implemented but never called" is the failure this guards.
 */
async function quoteWithdrawalWiringChecks() {
  console.log("\n-- quote withdrawal is wired to the parcel helpers --");
  const seller = await createSeller("parcel");
  const { order } = await createBookableOrder(seller.id, "parcel");

  const added = await addOrderPackage(order.id, { count: 2, length: 50, width: 40, height: 30, weight: 9 }, ACTOR);
  check(
    "adding a parcel withdraws the order's quotes",
    (await prisma.shippingQuote.count({ where: { orderId: order.id } })) === 0
  );
  const afterAdd = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  check(
    "...and records the parcels as the reason",
    afterAdd.quoteInvalidationReason === QUOTE_INVALIDATION.packagesChanged,
    afterAdd.quoteInvalidationReason ?? "(null)"
  );
  const addAudit = await prisma.auditLog.findFirst({
    where: { entityId: order.id, action: "shipping.quotes_invalidated" },
    orderBy: { createdAt: "desc" },
  });
  check("...and attributes it to the person who added the parcel", addAudit?.actorId === ACTOR.actorId, addAudit?.actorId ?? "(none)");

  await giveQuote(order.id, "parcel-again");
  await removeOrderPackage(order.id, added.id, ACTOR);
  check(
    "removing a parcel withdraws the order's quotes too",
    (await prisma.shippingQuote.count({ where: { orderId: order.id } })) === 0
  );

  // A withdrawn quote is gone, not merely hidden: the booking gate reads the
  // rows, so a remembered id has nothing left to select.
  check(
    "the withdrawn quotes cannot be booked by remembering an id",
    (await prisma.shippingQuote.findMany({ where: { orderId: order.id } })).length === 0
  );
}

/* -------------------------------------------------------------------------- */
/* §6 quote withdrawal on an address change (the webhook path)                */
/* -------------------------------------------------------------------------- */

const ADDRESS_HOME = {
  name: "Verify Customer",
  address1: "1 Test Street",
  address2: null,
  city: "Toronto",
  province: "ON",
  zip: "M5H 2N2",
  country_code: "CA",
};

const ADDRESS_MOVED = { ...ADDRESS_HOME, city: "Ottawa", zip: "K1A 0A6" };

type IntakePayload = Parameters<typeof intakeOrder>[0]["payload"];

/** When the fixture order was placed, so the two webhooks below are ordered. */
const T0 = new Date(Date.now() - 120_000).toISOString();

function webhookPayload(id: number, address: unknown, updatedAt: string): IntakePayload {
  return {
    id,
    name: `#${id}`,
    order_number: id,
    email: "buyer@example.test",
    currency: "CAD",
    financial_status: "paid",
    fulfillment_status: null,
    created_at: T0,
    updated_at: updatedAt,
    customer: { first_name: "Verify", last_name: "Customer" },
    shipping_address: address,
    line_items: [],
    refunds: [],
  } as IntakePayload;
}

/**
 * The address on an order is written by the Shopify webhook, with nobody
 * watching. A quote is a price to a destination, so a customer who moves
 * invalidates every quote on the order — and a webhook that merely repeats the
 * address it already stored must invalidate nothing, or every routine update to
 * an order would empty its quote table.
 *
 * The comparison is checked directly as well, because it is the decision the
 * whole path rests on: an address that cannot be read counts as a change.
 */
async function addressChangeChecks() {
  console.log("\n-- address change through the order webhook --");

  check(
    "an identical address is not a change",
    addressMateriallyDiffers(JSON.stringify(ADDRESS_HOME), ADDRESS_HOME) === false
  );
  check(
    "a re-serialised address is not a change",
    addressMateriallyDiffers(
      JSON.stringify({ ...ADDRESS_HOME, name: undefined, address2: undefined }),
      { ...ADDRESS_HOME }
    ) === false
  );
  check("a moved address is a change", addressMateriallyDiffers(JSON.stringify(ADDRESS_HOME), ADDRESS_MOVED) === true);
  check(
    "a single changed character is a change",
    addressMateriallyDiffers(JSON.stringify(ADDRESS_HOME), { ...ADDRESS_HOME, address1: "1 Test St" }) === true
  );
  check("an unreadable stored address counts as a change", addressMateriallyDiffers("{not json", ADDRESS_HOME) === true);
  check("an absent incoming address counts as a change", addressMateriallyDiffers(JSON.stringify(ADDRESS_HOME), null) === true);

  const seller = await createSeller("addr");
  const shop = seller.shopDomain;
  const payloadId = 770000 + created.orderIds.length;
  const order = await prisma.order.create({
    data: {
      sellerId: seller.id,
      shopifyOrderId: `gid://shopify/Order/${payloadId}`,
      shopifyOrderName: `#ADDR-${suffix}`,
      shopifyOrderNumber: payloadId,
      // The intake path finds an existing order by this reference, so the
      // webhook can only be aimed at this fixture if it is built the same way
      // the create path builds it.
      supplierReference: `${shop}#${payloadId}`,
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
      shippingAddress: JSON.stringify(ADDRESS_HOME),
      customerName: "Verify Customer",
    },
  });
  created.orderIds.push(order.id);
  await giveQuote(order.id, "addr");

  const T1 = new Date(Date.now() - 60_000).toISOString();
  const T2 = new Date(Date.now() - 30_000).toISOString();
  const home = await intakeOrder({
    topic: "ORDERS_UPDATED",
    shop,
    payload: webhookPayload(payloadId, ADDRESS_HOME, T1),
  });
  check("a routine update is accepted", home.ok === true && !home.duplicate, JSON.stringify(home));
  check(
    "...and leaves the order's quotes alone",
    (await prisma.shippingQuote.count({ where: { orderId: order.id } })) === 1
  );
  const afterSame = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  check("...and records no withdrawal", afterSame.quotesInvalidatedAt === null, String(afterSame.quotesInvalidatedAt));

  const moved = await intakeOrder({
    topic: "ORDERS_UPDATED",
    shop,
    payload: webhookPayload(payloadId, ADDRESS_MOVED, T2),
  });
  check("an update that moves the address is accepted", moved.ok === true && !moved.duplicate, JSON.stringify(moved));
  check(
    "...and withdraws the order's quotes",
    (await prisma.shippingQuote.count({ where: { orderId: order.id } })) === 0
  );
  const afterMove = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  check(
    "...and records the address as the reason",
    afterMove.quoteInvalidationReason === QUOTE_INVALIDATION.addressChanged,
    afterMove.quoteInvalidationReason ?? "(null)"
  );
  check("...and records when", afterMove.quotesInvalidatedAt !== null);
  check(
    "...and the order now carries the new address",
    (JSON.parse(afterMove.shippingAddress ?? "{}") as { city?: string }).city === "Ottawa"
  );
  const moveAudit = await prisma.auditLog.findFirst({
    where: { entityId: order.id, action: "shipping.quotes_invalidated" },
    orderBy: { createdAt: "desc" },
  });
  check("...and attributes it to the webhook, not a person", moveAudit?.actorType === "WEBHOOK", moveAudit?.actorType ?? "(none)");
}

/* -------------------------------------------------------------------------- */
/* §6 booking outcomes                                                        */
/* -------------------------------------------------------------------------- */

async function bookingOutcomeChecks() {
  console.log("\n-- booking outcomes --");
  const mode = await eshipperMode();
  const host = await allowedHost();
  console.log(
    `NOTE  eShipper resolves as "${mode}" against ${host}. No call leaves this process: the stub below answers ` +
      `everything, and refuses any other host outright.`
  );
  if (mode !== "real") {
    console.log("NOTE  the provider is NOT configured for real mode, so the checks below are meaningless.");
  }
  installStub();

  const seller = await createSeller("bo");

  /* --- the provider refuses outright ------------------------------------- */
  {
    const { order, shipment, quote } = await createBookableOrder(seller.id, "fail");
    responder = () => ({ status: 500, body: { message: "carrier rejected the shipment" } });
    providerCalls = [];

    let message = "";
    try {
      await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const after = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    check("a provider refusal lands on BOOKING_FAILED", after.status === "BOOKING_FAILED", after.status);
    check("...and is not recorded as an unknown outcome", after.bookingOutcomeUnknownAt === null);
    check("...and is not recorded as an exception", after.status !== "EXCEPTION");
    check("...and stores the provider's reason", Boolean(after.lastBookingError), after.lastBookingError ?? "(none)");
    check("...and tells the operator nothing was purchased", /nothing was purchased/i.test(message), message.slice(0, 120));
    check("the provider was asked exactly once", apiCalls().length === 1, `calls=${apiCalls().length}`);
    check(
      "the order's payment is untouched by a failed booking",
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).wholesalePaymentStatus === "SUCCEEDED"
    );

    // A retry must be allowed, because nothing was bought.
    responder = () => ({ status: 200, body: BOOKED_BODY("RETRY") });
    providerCalls = [];
    await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    const booked = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    check("a retry after a refusal succeeds", booked.status === "BOOKED", booked.status);
    check("...and keeps the provider shipment id", booked.providerShipmentId === `S-RETRY-${suffix}`, booked.providerShipmentId ?? "(null)");
    check("...and keeps the tracking number", booked.trackingNumber === `TRK-RETRY-${suffix}`, booked.trackingNumber ?? "(null)");
    check("...and clears the previous failure reason", booked.lastBookingError === null, booked.lastBookingError ?? "(null)");
    check("...and stamps the label time", booked.labelCreatedAt !== null);
    check("...and leaves the seller's charge alone", booked.sellerShippingCharge === 2500, String(booked.sellerShippingCharge));
    check("...and does not re-ask the provider for a booked shipment", apiCalls().length === 1, `calls=${apiCalls().length}`);

    // Re-booking an already-booked shipment returns what exists; it does not buy.
    providerCalls = [];
    await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    check("booking an already-booked shipment buys nothing", apiCalls().length === 0, `calls=${apiCalls().length}`);
  }

  /* --- the provider does not answer -------------------------------------- */
  {
    const { shipment, quote } = await createBookableOrder(seller.id, "unknown");
    responder = () => "timeout";
    providerCalls = [];

    let message = "";
    try {
      await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const after = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    check("a timeout lands on BOOKING_UNKNOWN", after.status === "BOOKING_UNKNOWN", after.status);
    check("...and records when the outcome became unknown", after.bookingOutcomeUnknownAt !== null);
    check("...and says the outcome is unknown", /outcome unknown/i.test(message), message.slice(0, 140));
    check("...and does not claim nothing was purchased", !/nothing was purchased/i.test(message));
    check("the provider was asked exactly once for the timed-out attempt", apiCalls().length === 1, `calls=${apiCalls().length}`);

    /*
     * The check this whole state exists for. A second attempt here is how an
     * order ends up with two labels, so it must be refused BEFORE the provider
     * is called — not merely warned about afterwards.
     */
    providerCalls = [];
    let refusal = "";
    try {
      await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    check("a second booking is refused while the outcome is unknown", /reconcile/i.test(refusal), refusal.slice(0, 140));
    check("...and the provider is NOT asked a second time", apiCalls().length === 0, `calls=${apiCalls().length}`);
    check(
      "...and the shipment is still unknown afterwards",
      (await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status === "BOOKING_UNKNOWN"
    );

    // Reconciling against a provider that holds nothing.
    responder = () => ({ status: 200, body: {} });
    const notFound = await reconcileBookingOutcome(shipment.id, ACTOR);
    check("reconciling with an empty provider answer adopts nothing", notFound.adopted === false);
    check("...and says an empty answer is not proof", /not proof/i.test(notFound.message), notFound.message.slice(0, 120));
    check(
      "...and leaves the shipment for a person to decide",
      (await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status === "BOOKING_UNKNOWN"
    );

    // Reconciling against a provider that already holds the booking.
    responder = () => ({ status: 200, body: BOOKED_BODY("RECOVERED") });
    const recovered = await reconcileBookingOutcome(shipment.id, ACTOR);
    const recoveredRow = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    check("reconciling adopts a booking the provider already holds", recovered.adopted === true);
    check("...and does not buy a second label", recoveredRow.status === "BOOKED", recoveredRow.status);
    check("...and records the provider's shipment id", recoveredRow.providerShipmentId === `S-RECOVERED-${suffix}`);
    check("...and clears the unknown marker", recoveredRow.bookingOutcomeUnknownAt === null);
  }

  /* --- a person resolves what reconcile could not ------------------------ */
  {
    const { shipment, quote } = await createBookableOrder(seller.id, "resolve");
    responder = () => "timeout";
    await bookPreparedShipment(shipment.id, quote.id, ACTOR).catch(() => {});

    let shortReasonRefused = false;
    try {
      await resolveUnknownBooking(shipment.id, "nothing_purchased", { reason: "checked" }, ACTOR);
    } catch {
      shortReasonRefused = true;
    }
    check("resolving an unknown booking demands a real written reason", shortReasonRefused);

    let missingIdRefused = false;
    try {
      await resolveUnknownBooking(shipment.id, "label_exists", { reason: "Checked the portal, the label is there." }, ACTOR);
    } catch {
      missingIdRefused = true;
    }
    check("recording an existing label without a provider id is refused", missingIdRefused);
    check(
      "...and the shipment is still unknown after both refusals",
      (await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status === "BOOKING_UNKNOWN"
    );

    await resolveUnknownBooking(
      shipment.id,
      "nothing_purchased",
      { reason: "Checked the eShipper portal and the order list; nothing was created." },
      ACTOR
    );
    const resolved = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    check("recording 'nothing purchased' makes the shipment retryable", resolved.status === "BOOKING_FAILED", resolved.status);
    check("...and keeps the person's reason", /portal/i.test(resolved.lastBookingError ?? ""), resolved.lastBookingError ?? "(null)");
    check("...and clears the unknown marker", resolved.bookingOutcomeUnknownAt === null);

    responder = () => ({ status: 200, body: BOOKED_BODY("AFTER") });
    await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    check(
      "a shipment resolved by hand can then be booked",
      (await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status === "BOOKED"
    );
  }

  /* --- a request that never left is a failure, not an unknown ------------ */
  {
    const { shipment, quote } = await createBookableOrder(seller.id, "unreachable");
    responder = () => "unreachable";
    await bookPreparedShipment(shipment.id, quote.id, ACTOR).catch(() => {});
    const after = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    check("a request that never reached the provider is a plain failure", after.status === "BOOKING_FAILED", after.status);
    check("...not an unknown outcome needing a person", after.bookingOutcomeUnknownAt === null);
  }

  /* --- two clicks, one booking ------------------------------------------- */
  {
    const { shipment, quote } = await createBookableOrder(seller.id, "race");
    responder = () => ({ status: 200, body: BOOKED_BODY("RACE") });
    providerCalls = [];
    await Promise.allSettled([
      bookPreparedShipment(shipment.id, quote.id, ACTOR),
      bookPreparedShipment(shipment.id, quote.id, ACTOR),
    ]);
    // The loser may either be refused (it saw BOOKING) or handed the shipment
    // the winner created (it saw BOOKED) — both are correct, and which one
    // happens is a race. What must hold either way is one purchase.
    check("two simultaneous bookings make one provider call", apiCalls().length === 1, `calls=${apiCalls().length}`);
    const raced = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    check("...and one provider shipment id", raced.providerShipmentId === `S-RACE-${suffix}`, raced.providerShipmentId ?? "(null)");
    check("...and one shipment for the order", (await prisma.shipment.count({ where: { orderId: raced.orderId } })) === 1);
  }

  /* --- the Shopify sync is queued when the immediate push fails ---------- */
  {
    const { shipment, quote } = await createBookableOrder(seller.id, "sync", `FO-${suffix}`);
    responder = () => ({ status: 200, body: BOOKED_BODY("SYNC") });
    await bookPreparedShipment(shipment.id, quote.id, ACTOR);

    const job = await prisma.backgroundJob.findFirst({
      where: { kind: JOB_KIND.SHOPIFY_FULFILLMENT_SYNC, sellerId: seller.id },
    });
    check("a booking whose Shopify push failed queues a retry", Boolean(job), job ? `job ${job.id} (${job.status})` : "no job");
    check("...keyed so a second booking cannot queue a second one", Boolean(job?.idempotencyKey.includes(shipment.id)), job?.idempotencyKey ?? "(none)");
    check("...scoped to the seller's access version", job?.sellerAccessVersion === 1, String(job?.sellerAccessVersion));
    check(
      "...and the booking itself is still BOOKED, not failed",
      (await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status === "BOOKED"
    );
  }

  /* --- a shipment with nothing to sync does not queue a job -------------- */
  {
    const { shipment, quote } = await createBookableOrder(seller.id, "nosync");
    responder = () => ({ status: 200, body: BOOKED_BODY("NOSYNC") });
    await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    const job = await prisma.backgroundJob.findFirst({
      where: { kind: JOB_KIND.SHOPIFY_FULFILLMENT_SYNC, payload: { path: ["shipmentId"], equals: shipment.id } },
    });
    check("a booking with no fulfillment order queues nothing", job === null, job ? `unexpected job ${job.id}` : "none");
  }

  restoreFetch();
}

/* -------------------------------------------------------------------------- */
/* §9 pickup                                                                  */
/* -------------------------------------------------------------------------- */

async function pickupChecks() {
  console.log("\n-- pickup --");
  installStub();
  const seller = await createSeller("pickup");

  // Nothing has been bought for this one yet.
  const unbooked = await createBookableOrder(seller.id, "unbooked");
  let refused = "";
  try {
    await schedulePickupForShipment(unbooked.shipment.id, { pickupDate: "2026-10-01", pickupTimeWindow: "09:00-17:00" }, ACTOR);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  check("a pickup cannot be scheduled for an unbooked shipment", /book the shipment/i.test(refused), refused.slice(0, 100));

  const { shipment: target, quote } = await createBookableOrder(seller.id, "booked");
  responder = () => ({ status: 200, body: BOOKED_BODY("PICK") });
  await bookPreparedShipment(target.id, quote.id, ACTOR);
  check(
    "a fresh booking has no pickup",
    (await prisma.shipment.findUniqueOrThrow({ where: { id: target.id } })).pickupStatus === null
  );

  /* --- a failed pickup leaves the booking alone -------------------------- */
  responder = () => ({ status: 500, body: { message: "no capacity that day" } });
  let pickupError = "";
  try {
    await schedulePickupForShipment(target.id, { pickupDate: "2026-10-01", pickupTimeWindow: "09:00-17:00" }, ACTOR);
  } catch (error) {
    pickupError = error instanceof Error ? error.message : String(error);
  }
  const afterFailure = await prisma.shipment.findUniqueOrThrow({ where: { id: target.id } });
  check("a refused pickup is recorded as FAILED", afterFailure.pickupStatus === "FAILED", afterFailure.pickupStatus ?? "(null)");
  check("...and stores the provider's reason", Boolean(afterFailure.pickupLastError));
  check("...and the booking is untouched", afterFailure.status === "BOOKED", afterFailure.status);
  check("...and the label is not lost", Boolean(afterFailure.providerShipmentId));
  check("...and the operator is told to retry only the pickup", /retry the pickup/i.test(pickupError), pickupError.slice(0, 120));

  /* --- a successful pickup ---------------------------------------------- */
  responder = () => ({
    status: 200,
    body: { pickupId: `PU-${suffix}`, scheduledDate: "2026-10-01", status: "SCHEDULED", confirmationNumber: `CONF${suffix}` },
  });
  const scheduled = await schedulePickupForShipment(target.id, { pickupDate: "2026-10-01", pickupTimeWindow: "09:00-17:00" }, ACTOR);
  const afterSchedule = await prisma.shipment.findUniqueOrThrow({ where: { id: target.id } });
  check("a scheduled pickup records its state", afterSchedule.pickupStatus === "SCHEDULED", afterSchedule.pickupStatus ?? "(null)");
  check("...and the provider pickup id, so it can be cancelled later", afterSchedule.providerPickupId === `PU-${suffix}`);
  check("...and the confirmation number", afterSchedule.pickupConfirmation === `CONF${suffix}`);
  check("...and clears the earlier pickup error", afterSchedule.pickupLastError === null);
  check("...and the booking is still BOOKED", afterSchedule.status === "BOOKED");
  check("the state returned to the caller matches what was stored", scheduled.pickupStatus === "SCHEDULED");

  /* --- cancelling uses the stored id ------------------------------------ */
  responder = () => ({ status: 200, body: { cancelled: true } });
  providerCalls = [];
  await cancelPickupForShipment(target.id, undefined, ACTOR);
  const afterCancel = await prisma.shipment.findUniqueOrThrow({ where: { id: target.id } });
  check(
    "cancelling without an id uses the stored pickup id",
    providerCalls.some((c) => c.url.includes(`PU-${suffix}`)),
    providerCalls.map((c) => c.url).join(" ")
  );
  check("a confirmed cancellation is recorded as CANCELLED", afterCancel.pickupStatus === "CANCELLED", afterCancel.pickupStatus ?? "(null)");
  check("...and stamps the cancellation time", afterCancel.pickupCancelledAt !== null);
  check("...and the shipment itself is not cancelled", afterCancel.status === "BOOKED", afterCancel.status);

  /* --- a cancellation the provider refuses ------------------------------ */
  responder = () => ({ status: 200, body: { cancelled: false } });
  await cancelPickupForShipment(target.id, `PU-${suffix}`, ACTOR);
  const afterRefusedCancel = await prisma.shipment.findUniqueOrThrow({ where: { id: target.id } });
  check(
    "a cancellation the provider did not confirm leaves the pickup standing",
    afterRefusedCancel.pickupStatus === "SCHEDULED",
    afterRefusedCancel.pickupStatus ?? "(null)"
  );
  // The provider has just said the pickup stands. A timestamp from the earlier,
  // confirmed cancellation would contradict the status beside it.
  check(
    "...and drops the cancellation time that no longer applies",
    afterRefusedCancel.pickupCancelledAt === null,
    String(afterRefusedCancel.pickupCancelledAt)
  );

  /* --- a cancellation nobody answered ----------------------------------- */
  responder = () => "timeout";
  await cancelPickupForShipment(target.id, `PU-${suffix}`, ACTOR).catch(() => {});
  const afterUnknownCancel = await prisma.shipment.findUniqueOrThrow({ where: { id: target.id } });
  check(
    "an unanswered cancellation is UNKNOWN, not cancelled",
    afterUnknownCancel.pickupStatus === "UNKNOWN",
    afterUnknownCancel.pickupStatus ?? "(null)"
  );
  check(
    "...and leaves no cancellation time claiming otherwise",
    afterUnknownCancel.pickupCancelledAt === null,
    String(afterUnknownCancel.pickupCancelledAt)
  );

  restoreFetch();
}

/* -------------------------------------------------------------------------- */
/* §10 packing list                                                           */
/* -------------------------------------------------------------------------- */

async function packingListChecks() {
  console.log("\n-- packing list --");
  const owner = await createSeller("pl");
  const other = await createSeller("pl-other");
  const { order, shipment, quote } = await createBookableOrder(owner.id, "pl");

  // Give the fixture money, so a document that leaked a price would have one to
  // leak. None of these figures may appear below.
  await prisma.order.update({ where: { id: order.id }, data: { moonvellaTotal: 123456, moonvellaShipping: 7890 } });
  await prisma.shippingQuote.update({ where: { id: quote.id }, data: { totalAmount: 98765 } });

  const list = await packingListFor(shipment.id);
  check("the packing list is found for the shipment", Boolean(list));
  if (!list) return;

  check("it is branded with the seller's store name", list.brandName === "Brand pl", list.brandName);
  check("it uses the brand kit's colour", list.brandColour === "#1b4d3e", list.brandColour);
  check("it lists the ordered item", list.lines.some((l) => l.name === "TEST PILLOW"));
  check("it counts the units being packed", list.totalUnits === 2, String(list.totalUnits));
  check("it carries the parcels", list.packageCount === 1, String(list.packageCount));

  const html = renderPackingList(list);
  const forbidden = ["123456", "7890", "98765", "32.00", "25.00", "$", "CAD", "3000"];
  const leaked = forbidden.filter((needle) => html.includes(needle));
  check("no price, currency, charge or cost appears in the document", leaked.length === 0, leaked.join(" "));
  check("the document says what it is not", /not a carrier document/i.test(html));
  check("...and explicitly that it states no prices", /states no\s+prices/i.test(html));
  check("...and contains no script of its own beyond the print button", !/<script/i.test(html));

  const asOwner = await packingListFor(shipment.id, { sellerId: owner.id });
  const asOther = await packingListFor(shipment.id, { sellerId: other.id });
  check("the seller can read their own shipment's list", Boolean(asOwner));
  check("another seller reading the same shipment gets nothing", asOther === null);
  check("a shipment that does not exist is not invented", (await packingListFor("not-a-shipment")) === null);

  const lines = parseAddressLines(
    JSON.stringify({ name: "A", address1: "1 St", city: "Toronto", province: "ON", zip: "M5H 2N2", country: "CA" })
  );
  check("an address is laid out for a label", lines.join(" | ") === "A | 1 St | Toronto, ON, M5H 2N2 | CA", lines.join(" | "));
  check("a malformed address does not throw", parseAddressLines("{not json").length === 0);
}

async function main() {
  await quoteInvalidationChecks();
  await quoteWithdrawalWiringChecks();
  await addressChangeChecks();
  await bookingOutcomeChecks();
  await pickupChecks();
  await packingListChecks();

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
