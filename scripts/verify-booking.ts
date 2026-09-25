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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
import { addOrderPackage, advanceShipment, removeOrderPackage } from "../app/services/fulfillment.server";
import {
  addressGate,
  addressMateriallyDiffers,
  addressStatus,
  bookingAddressGate,
  loadSubjectAddress,
  outcomeFromResponse,
  recordAddressOverride,
  recordValidation,
} from "../app/services/addressValidation.server";
import { acceptBookingAddresses, recordVerdict } from "./verify-address-fixtures";
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
  locationIds: [] as string[],
  productIds: [] as string[],
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
/**
 * A complete pickup location, and a product whose default variant is mapped to
 * it.
 *
 * PHASE C MADE THIS NECESSARY, AND THAT IS THE POINT. Booking now refuses to
 * send a carrier to an address nobody chose, so an order that is eligible to be
 * booked must say where its goods are collected from. The fixtures below were
 * quietly booking against a placeholder assembled out of environment variables;
 * they now have a real dock, and `originGateChecks` proves the gate refuses when
 * they do not.
 */
async function createOrigin(label: string) {
  const location = await prisma.pickupLocation.create({
    data: {
      code: `VB-DOCK-${label}-${suffix}`,
      name: `Verify Dock ${label}`,
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
      pickupCloseTime: "16:00",
    },
  });
  created.locationIds.push(location.id);

  const product = await prisma.product.create({
    data: {
      name: `Verify Booking Product ${label} ${suffix}`,
      productCode: `VB-P-${label}-${suffix}`,
      category: "Verification",
      pickupLocationId: location.id,
    },
  });
  created.productIds.push(product.id);

  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      sku: `VB-PILLOW-${label}`,
      name: "TEST PILLOW",
      wholesalePrice: 3000,
      suggestedRetailPrice: 5000,
      inventory: 50,
      isDefault: true,
    },
  });
  return { location, product, variant };
}

async function createBookableOrder(
  sellerId: string,
  label: string,
  fulfillmentOrderId: string | null = null,
  opts: { withOrigin?: boolean } = {},
) {
  const withOrigin = opts.withOrigin ?? true;
  const origin = withOrigin ? await createOrigin(label) : null;
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
            // The mapping the booking gate reads. Without it the item resolves
            // to no dock and no label can be bought for it.
            variantId: origin?.variant.id ?? null,
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
      // The dock this price is for. A quote that names no dock cannot be spent
      // on a shipment, which is what the gate is for.
      originLocationId: origin?.location.id ?? null,
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

  /*
   * ACCEPTED VERDICTS, BOTH ENDS — the precondition booking now has.
   *
   * Added when the address gate was wired in. Without it every check below
   * would be refused for an address nobody checked, and the suite would report
   * a wall of failures that say nothing about the behaviour it exists to
   * examine. The verdicts are seeded through the same hash the gate computes,
   * so they are accepted for the right reason rather than by a shortcut the
   * product does not have.
   */
  await acceptBookingAddresses(prisma, {
    originLocationId: origin?.location.id ?? null,
    orderId: order.id,
  });

  return { order, quote, shipment, origin };
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
    // Variants cascade from their product; the dock is referenced by quotes with
    // ON DELETE SET NULL and by shipments with SetNull as well, so it is removed
    // last and only after the orders that point at it.
    if (created.productIds.length) {
      await prisma.product.deleteMany({ where: { id: { in: created.productIds } } });
    }
    // Verdicts are keyed by a subject id rather than by a relation — a verdict
    // can belong to a dock or to an order — so nothing above reaches them and
    // they are removed by the ids this run created.
    const subjects = [...created.orderIds, ...created.locationIds];
    if (subjects.length) {
      await prisma.addressValidation.deleteMany({ where: { subjectId: { in: subjects } } });
    }
    if (created.locationIds.length) {
      await prisma.pickupLocation.deleteMany({ where: { id: { in: created.locationIds } } });
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

  /*
   * --- WHERE SHOPIFY IS TOLD: THE DISPATCH MILESTONE, NOT THE BOOKING ------
   *
   * This block used to assert the opposite — that a booking pushed to Shopify
   * and queued a retry when the push failed. §8 changed the rule: booking buys
   * a label, and a label is not a collected parcel, so pushing at booking told
   * the customer their goods had shipped when nothing had been handed over. The
   * push now happens at `handed_to_carrier` / `shipped`, and the checks below
   * are the two halves of that: a booking pushes nothing, a dispatch pushes.
   */
  {
    const { shipment, quote } = await createBookableOrder(seller.id, "sync", `FO-${suffix}`);
    responder = () => ({ status: 200, body: BOOKED_BODY("SYNC") });
    await bookPreparedShipment(shipment.id, quote.id, ACTOR);

    const job = await prisma.backgroundJob.findFirst({
      where: { kind: JOB_KIND.SHOPIFY_FULFILLMENT_SYNC, sellerId: seller.id },
    });
    check("a booking queues no Shopify push", job === null, job ? `unexpected job ${job.id}` : "none");
    const booked = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    check("...and tells Shopify nothing about it", booked.shopifyFulfillmentId === null, booked.shopifyFulfillmentId ?? "(null)");
    check("...and does not claim the customer was notified", booked.shopifyNotifiedAt === null);

    /* --- the dispatch tries the push ------------------------------------- */
    await advanceShipment(shipment.id, "handed_to_carrier", ACTOR);
    const dispatched = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    const retry = await prisma.backgroundJob.findFirst({
      where: { kind: JOB_KIND.SHOPIFY_FULFILLMENT_SYNC, payload: { path: ["shipmentId"], equals: shipment.id } },
    });
    check("handing the parcel over is what tries the Shopify push", dispatched.status === "SHIPPED", dispatched.status);
    check(
      "...and a push that could not go through queues exactly one retry",
      Boolean(retry),
      retry ? `job ${retry.id} (${retry.status})` : "no job"
    );
    check("...keyed on the shipment, so a second dispatch cannot queue a second one", Boolean(retry?.idempotencyKey.includes(shipment.id)), retry?.idempotencyKey ?? "(none)");
    check("...scoped to the seller's access version", retry?.sellerAccessVersion === 1, String(retry?.sellerAccessVersion));
    check(
      "...with Shopify's own refusal recorded against the shipment",
      Boolean(dispatched.shopifySyncError),
      dispatched.shopifySyncError?.slice(0, 80) ?? "(none)"
    );
    check("...and nothing pretending the customer was told", dispatched.shopifyNotifiedAt === null);

    /* --- an event before the milestone does not push --------------------- */
    const second = await createBookableOrder(seller.id, "premilestone", `FO-PRE-${suffix}`);
    responder = () => ({ status: 200, body: BOOKED_BODY("PRE") });
    await bookPreparedShipment(second.shipment.id, second.quote.id, ACTOR);
    await advanceShipment(second.shipment.id, "packed", ACTOR);
    const packedJob = await prisma.backgroundJob.findFirst({
      where: { kind: JOB_KIND.SHOPIFY_FULFILLMENT_SYNC, payload: { path: ["shipmentId"], equals: second.shipment.id } },
    });
    check("packing the parcel queues nothing — packing is not dispatch", packedJob === null, packedJob ? `unexpected job ${packedJob.id}` : "none");
    check(
      "...and leaves the fulfillment id empty",
      (await prisma.shipment.findUniqueOrThrow({ where: { id: second.shipment.id } })).shopifyFulfillmentId === null
    );
  }

  /* --- a dispatch with nothing to push queues nothing -------------------- */
  {
    const { shipment, quote } = await createBookableOrder(seller.id, "nosync");
    responder = () => ({ status: 200, body: BOOKED_BODY("NOSYNC") });
    await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    await advanceShipment(shipment.id, "handed_to_carrier", ACTOR);
    const job = await prisma.backgroundJob.findFirst({
      where: { kind: JOB_KIND.SHOPIFY_FULFILLMENT_SYNC, payload: { path: ["shipmentId"], equals: shipment.id } },
    });
    check("an order with no fulfillment order queues nothing, even at dispatch", job === null, job ? `unexpected job ${job.id}` : "none");
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

/* -------------------------------------------------------------------------- */
/* §1 the gate: no dock, no label                                             */
/* -------------------------------------------------------------------------- */

/**
 * The work order is explicit: "Do not silently fall back to a global address
 * when a mapping is missing. Show 'Pickup location required' and block booking."
 *
 * Everything above books against a fixture that names a dock, because that is
 * now the only kind of order that can be booked. This group is the control: it
 * proves the gate is real and that the refusal happens before any money moves.
 */
async function originGateChecks() {
  console.log("\n-- the pickup-location gate --");

  const seller = await createSeller("gate");

  /* --- an order whose lines map to no dock ------------------------------- */
  {
    const { order, shipment, quote } = await createBookableOrder(seller.id, "gate-nodock", null, { withOrigin: false });
    responder = () => ({ status: 200, body: BOOKED_BODY("GATE") });
    providerCalls = [];

    let message = "";
    try {
      await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    const after = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    check("booking refuses an order whose lines map to no dock", /pickup location required/i.test(message), message.slice(0, 140));
    check("...and the shipment is left exactly where it was", after.status === "PENDING", after.status);
    check("...and the carrier is never called", apiCalls().length === 0, `calls=${apiCalls().length}`);
    check("...and no label time is stamped", after.labelCreatedAt === null);
    check("...and nothing is recorded as purchased", after.providerShipmentId === null, after.providerShipmentId ?? "(null)");

    const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    check("...and the seller's money is untouched", paid.wholesalePaymentStatus === "SUCCEEDED", paid.wholesalePaymentStatus);

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: "Shipment", entityId: shipment.id, action: { contains: "booking" } },
      orderBy: { createdAt: "desc" },
    });
    check("the refusal says why, and says it without naming an address", !/1 Warehouse Way/i.test(message), message.slice(0, 60));
    check("...and is not attributed to a person acting", audit === null, audit?.actorType ?? "(no booking audit, as expected)");
  }

  /* --- a quote that names no dock --------------------------------------- */
  {
    const { shipment, quote } = await createBookableOrder(seller.id, "gate-noquote");
    await prisma.shippingQuote.update({ where: { id: quote.id }, data: { originLocationId: null } });
    providerCalls = [];

    let message = "";
    try {
      await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check(
      "a quote that names no dock cannot be spent on a shipment",
      /quote/i.test(message) && /dock|origin|pickup location/i.test(message),
      message.slice(0, 140)
    );
    check("...and the carrier is still never called", apiCalls().length === 0, `calls=${apiCalls().length}`);
  }

  /* --- two docks in one order ------------------------------------------- */
  {
    const { order, shipment, quote, origin } = await createBookableOrder(seller.id, "gate-split");
    if (!origin) throw new Error("fixture expected an origin");

    // A second dock, and a second line that lives there. One order, two places
    // the goods are: no single carrier call can collect it.
    const second = await createOrigin("gate-split-2");
    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        shopifyLineItemId: `line-gate-split-2-${suffix}`,
        name: "TEST PILLOW",
        sku: `VB-PILLOW-gate-split-2`,
        quantity: 1,
        price: 5000,
        wholesalePrice: 3000,
        totalDiscount: 0,
        variantId: second.variant.id,
      },
    });
    await prisma.shipmentItem.create({ data: { shipmentId: shipment.id, orderItemId: (await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id, variantId: second.variant.id } })).id, quantity: 1 } });

    providerCalls = [];
    let message = "";
    try {
      await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check(
      "an order whose goods sit at two docks is refused, not merged",
      /split/i.test(message) || /two|different/i.test(message),
      message.slice(0, 160)
    );
    check("...and names both docks so the operator can act", /Verify Dock/i.test(message), message.slice(0, 160));
    check("...and tells the operator what to do about it", /one shipment per dock/i.test(message), message.slice(0, 200));
    check("the carrier is not called for a split order", apiCalls().length === 0, `calls=${apiCalls().length}`);

    /*
     * And the split must not cost the seller anything. The work order: "Do not
     * charge the seller extra automatically because of the split." A refused
     * booking that had already taken a second shipping charge would be exactly
     * that, so the charge is asserted here rather than assumed.
     */
    const charged = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    check(
      "splitting an order does not add a second charge to the seller",
      charged.sellerShippingCharge === 2500,
      String(charged.sellerShippingCharge)
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The booking address gate                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Booking must refuse an address that is not accepted, and an unavailable
 * validator is not an acceptance.
 *
 * THE DEFECT THIS EXISTS FOR. `addressGate` was written long before this suite
 * and rendered on the Pickup locations page, but nothing that books ever called
 * it: an operator could check a dock, watch Google refuse it, and then book
 * from it anyway, because the check was advice. The checks below are the
 * requirement stated as behaviour — a refusal, with a reason, before any money
 * or any carrier call — on the code path the routes call.
 *
 * Every provider call is stubbed and every address here is a fixture. Nothing
 * was checked against Google, no label was bought, and no real address is
 * recorded in this suite: the verdicts are the ones the service itself would
 * have stored, replayed through `recordValidation` so the storage path is the
 * real one.
 */
async function addressGateChecks() {
  console.log("\n-- the booking address gate --");
  /*
   * The stub is installed for the whole group, including the checks that expect
   * a refusal. Most of them assert the carrier was never called, which needs a
   * stubbed transport to be meaningful — but one check at the end books
   * successfully, and without the stub that one reaches the REAL test API with a
   * fixture quote id. It did, once: the provider answered 400 and bought nothing,
   * and the check failed for a reason that had nothing to do with overrides.
   */
  installStub();
  const seller = await createSeller("agate");

  /* --- nothing has ever been checked ------------------------------------- */
  {
    const { order, shipment, quote, origin } = await createBookableOrder(seller.id, "agate-never");
    if (!origin) throw new Error("fixture expected an origin");
    // The fixture seeds accepted verdicts so the OTHER checks exercise booking.
    // This one is about the unvalidated case, so it removes them.
    await prisma.addressValidation.deleteMany({
      where: { subjectId: { in: [order.id, origin.location.id] } },
    });

    responder = () => ({ status: 200, body: BOOKED_BODY("ADDR-NEVER") });
    providerCalls = [];
    let message = "";
    try {
      await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const after = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    check(
      "booking refuses an address that has never been checked",
      /never been checked/i.test(message),
      message.slice(0, 180)
    );
    check(
      "...and says which address it means",
      /pickup address/i.test(message) && /delivery address/i.test(message),
      message.slice(0, 180)
    );
    check("...and the refusal offers a way out", /override|accept/i.test(message), message.slice(0, 200));
    check("...and the carrier is never called", apiCalls().length === 0, `calls=${apiCalls().length}`);
    check("...and the shipment is left exactly where it was", after.status === "PENDING", after.status);
    check("...and nothing is recorded as purchased", after.providerShipmentId === null);
    check("...and no label time is stamped", after.labelCreatedAt === null);
  }

  /* --- the validator could not be reached -------------------------------- */
  {
    const { shipment, quote, origin } = await createBookableOrder(seller.id, "agate-unavail");
    if (!origin) throw new Error("fixture expected an origin");

    /*
     * Stored through the product's own path: the outcome Google's silence
     * produces, handed to the same `recordValidation` a real check would call.
     * The pickup end is set unavailable and the delivery end left accepted, so a
     * pass or a refusal here is attributable to the pickup end alone.
     */
    const address = await loadSubjectAddress("PICKUP", origin.location.id);
    if (!address) throw new Error("fixture expected a pickup address");
    const outcome = outcomeFromResponse(address, {});
    check("an unanswered check is an UNAVAILABLE verdict", outcome.verdict === "UNAVAILABLE", outcome.verdict);
    await recordValidation({ subjectType: "PICKUP", subjectId: origin.location.id, outcome });

    const gate = await addressGate("PICKUP", origin.location.id);
    check("the validator being unreachable does not pass the gate", gate.allowed === false, gate.label);
    check(
      "...and the gate repeats what went wrong, not that a timer ran out",
      /could not be checked|no verdict|unavailable/i.test(gate.blockers.join(" ")),
      gate.blockers.join(" ").slice(0, 160)
    );
    check("...and an override is offered as the way through", gate.canOverride === true);

    responder = () => ({ status: 200, body: BOOKED_BODY("ADDR-UNAVAIL") });
    providerCalls = [];
    let message = "";
    try {
      await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check(
      "an unavailable validator does not silently permit booking",
      /pickup address/i.test(message) && /unavailable/i.test(message),
      message.slice(0, 200)
    );
    check("...and the carrier is never called for it", apiCalls().length === 0, `calls=${apiCalls().length}`);
    check(
      "...and the shipment is untouched",
      (await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status === "PENDING"
    );
  }

  /* --- the address was edited after it was checked ----------------------- */
  {
    const { order, quote, origin } = await createBookableOrder(seller.id, "agate-edited");
    if (!origin) throw new Error("fixture expected an origin");
    // An accepted verdict whose hash was computed for a DIFFERENT address — the
    // state a dock lands in when someone edits the address and the old
    // acceptance is still on file.
    await prisma.addressValidation.deleteMany({ where: { subjectId: origin.location.id } });
    await recordVerdict(prisma, {
      subjectType: "PICKUP",
      subjectId: origin.location.id,
      verdict: "ACCEPTED",
      inputHash: "hash-for-an-address-that-is-no-longer-there",
    });

    const gate = await addressGate("PICKUP", origin.location.id);
    check("an address edited since its check is not accepted", gate.allowed === false, gate.label);
    check(
      "...and the reason is that it changed, not that it was never checked",
      /changed since it was last checked/i.test(gate.blockers.join(" ")),
      gate.blockers.join(" ").slice(0, 160)
    );
    check("...and the gate will not vouch for it", gate.googleValidated === false);

    // And the booking path agrees with the gate, rather than having its own idea.
    responder = () => ({ status: 200, body: BOOKED_BODY("ADDR-EDITED") });
    providerCalls = [];
    let message = "";
    try {
      await bookPreparedShipment(
        (await prisma.shipment.findFirstOrThrow({ where: { orderId: order.id } })).id,
        quote.id,
        ACTOR
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check("...and booking is refused", /changed since it was last checked/i.test(message), message.slice(0, 180));
    check("...with no carrier call", apiCalls().length === 0, `calls=${apiCalls().length}`);
  }

  /* --- the two verdicts that ask for a person ---------------------------- */
  for (const verdict of ["CONFIRMATION_REQUIRED", "CORRECTION_REQUIRED"] as const) {
    const { shipment, quote, origin } = await createBookableOrder(seller.id, `agate-${verdict.toLowerCase()}`);
    if (!origin) throw new Error("fixture expected an origin");
    await prisma.addressValidation.deleteMany({ where: { subjectId: origin.location.id } });
    await recordVerdict(prisma, { subjectType: "PICKUP", subjectId: origin.location.id, verdict });

    const gate = await addressGate("PICKUP", origin.location.id);
    check(`${verdict} does not pass the gate`, gate.allowed === false, gate.label);
    check(`...and ${verdict} is distinguishable from never having checked`, gate.verdict === verdict, gate.verdict);

    responder = () => ({ status: 200, body: BOOKED_BODY(`ADDR-${verdict}`) });
    providerCalls = [];
    let message = "";
    try {
      await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check(`booking is refused while the pickup address is ${verdict}`, message.length > 0, message.slice(0, 140));
    check(`...and the carrier is not called for ${verdict}`, apiCalls().length === 0);
  }

  /* --- the destination is gated too, not just the dock ------------------- */
  {
    const { order, shipment, quote, origin } = await createBookableOrder(seller.id, "agate-delivery");
    if (!origin) throw new Error("fixture expected an origin");
    await prisma.addressValidation.deleteMany({ where: { subjectId: order.id } });

    responder = () => ({ status: 200, body: BOOKED_BODY("ADDR-DELIVERY") });
    providerCalls = [];
    let message = "";
    try {
      await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check(
      "a dock that is accepted does not carry an unchecked destination",
      /delivery address/i.test(message) && /never been checked/i.test(message),
      message.slice(0, 200)
    );
    check("...and no label is bought for it", apiCalls().length === 0, `calls=${apiCalls().length}`);
    const gate = await bookingAddressGate({ originLocationId: origin.location.id, orderId: order.id });
    check(
      "...and the gate is shut on one end only",
      gate.allowed === false && gate.pickup?.allowed === true && gate.delivery.allowed === false,
      `pickup=${gate.pickup?.allowed} delivery=${gate.delivery.allowed}`
    );
  }

  /* --- an owner's override, on the record -------------------------------- */
  {
    const { shipment, quote, origin } = await createBookableOrder(seller.id, "agate-override");
    if (!origin) throw new Error("fixture expected an origin");
    await prisma.addressValidation.deleteMany({ where: { subjectId: origin.location.id } });

    // Who may override is decided against the STORED account, so the check is
    // made with a real one: an operations user, who can book and can check an
    // address but is not an owner.
    const staff = await prisma.adminUser.create({
      data: {
        email: `verify-addr-ops-${suffix.toLowerCase()}@example.test`,
        name: "Verify Operations",
        role: "OPERATIONS",
        isActive: true,
      },
    });

    let refused = "";
    try {
      await recordAddressOverride({
        subjectType: "PICKUP",
        subjectId: origin.location.id,
        actorId: staff.id,
        reason: "This address is correct, I have been there many times.",
      });
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    check("a non-owner cannot override an address", /only an owner/i.test(refused), refused.slice(0, 120));

    const short = await recordAddressOverride({
      subjectType: "PICKUP",
      subjectId: origin.location.id,
      actorId: staff.id,
      reason: "fine",
    });
    check(
      "an override with no real reason is refused",
      short.ok === false && /10 characters/i.test(short.error),
      short.ok ? "(accepted)" : short.error
    );

    const owner = await prisma.adminUser.create({
      data: {
        email: `verify-addr-owner-${suffix.toLowerCase()}@example.test`,
        name: "Verify Owner",
        role: "OWNER",
        isActive: true,
      },
    });
    const overridden = await recordAddressOverride({
      subjectType: "PICKUP",
      subjectId: origin.location.id,
      actorId: owner.id,
      reason: "Checked against the landlord's lease; the address is right and the postcode is the one the carrier uses.",
    });
    check("an owner can override with a reason", overridden.ok === true, overridden.ok ? "" : overridden.error);

    const gate = await addressGate("PICKUP", origin.location.id);
    check("an overridden address is allowed through", gate.allowed === true, gate.label);
    check(
      "...and is NEVER described as validated by Google",
      gate.googleValidated === false && /owner/i.test(gate.label),
      gate.label
    );

    // And the money moves only once the gate is open — the same booking that was
    // refused a moment ago now goes through, with the override carrying it.
    responder = () => ({ status: 200, body: BOOKED_BODY("ADDR-OVERRIDE") });
    providerCalls = [];
    let message = "";
    let booked = false;
    try {
      await bookPreparedShipment(shipment.id, quote.id, ACTOR);
      booked = true;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check("the booking proceeds on an owner's override", booked, message.slice(0, 180));
    check("...and the carrier IS called once it is open", apiCalls().length > 0, `calls=${apiCalls().length}`);

    // The entry is keyed on the validation row it created (`entityId`), and the
    // address it is about is in `afterData` — stored as a JSON string, so it is
    // parsed here rather than queried by path. Asserting on the subject is the
    // stronger statement: it proves the record says WHICH address was
    // overridden, not merely that some override happened.
    const overrideEntries = await prisma.auditLog.findMany({
      where: { action: "address.override_recorded" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const audit = overrideEntries.find((entry) => {
      try {
        return JSON.parse(entry.afterData ?? "{}").subjectId === origin.location.id;
      } catch {
        return false;
      }
    });
    check("the override is audited", audit !== undefined, `${overrideEntries.length} override entr(ies) in the log`);
    check(
      "...with the owner's name on it",
      audit?.actorId === owner.id,
      audit?.actorName ?? audit?.actorId ?? "(none)"
    );

    /*
     * The override's audit entries stay. They are append-only by design — a
     * DELETE is refused by the database itself, and arranging a way around that
     * would be arranging to weaken the guarantee this check just proved. What
     * can go is the fixture accounts; the log keeps their names in `actorName`,
     * which is the point of copying the name onto the row.
     *
     * So this group leaves audit rows behind, one per run. That is the intended
     * behaviour of an append-only log, not a leak: it is why `actorId` carries
     * no foreign key, and why the fixture accounts use a per-run address.
     */
    await prisma.adminUser.deleteMany({ where: { id: { in: [staff.id, owner.id] } } });
  }

  /* --- Unit 7A and a postal code Google disagrees with ------------------- */
  {
    /*
     * The case the owner asked to preserve: an address with a unit in its own
     * field, and a postal code Google would change.
     *
     * Two things are asserted. That a disagreement is FLAGGED — the difference
     * is stored, shown, and blocks a booking. And that nothing is APPLIED: the
     * unit stays in street2, the postal code stays as the customer entered it,
     * and no screen or service writes Google's suggestion over either.
     */
    const seller7a = await createSeller("agate-7a");
    const { order, origin } = await createBookableOrder(seller7a.id, "agate-7a");
    if (!origin) throw new Error("fixture expected an origin");
    await prisma.order.update({
      where: { id: order.id },
      data: {
        shippingAddress: JSON.stringify({
          name: "Verify Customer",
          address1: "500 Queen St W",
          address2: "Unit 7A",
          city: "Toronto",
          province: "ON",
          zip: "M5V 2T6",
          country: "CA",
        }),
      },
    });
    // The fixture's accepted verdict was computed for the earlier blob, so it is
    // cleared the way an edit would invalidate it.
    await prisma.addressValidation.deleteMany({ where: { subjectId: order.id } });

    const entered = await loadSubjectAddress("DELIVERY", order.id);
    if (!entered) throw new Error("fixture expected a delivery address");
    check("the unit is read as its own field, not folded into the street", entered.street2 === "Unit 7A", String(entered.street2));

    // Google's answer, in its own shape: the unit confirmed, the postal code
    // replaced with a different one.
    const outcome = outcomeFromResponse(entered, {
      result: {
        verdict: {
          validationGranularity: "SUB_PREMISE",
          addressComplete: true,
          hasReplacedComponents: true,
        },
        address: {
          formattedAddress: "500 Queen St W Unit 7A, Toronto, ON M5V 3A8, Canada",
          addressComponents: [
            { componentType: "street_number", componentName: { text: "500" } },
            { componentType: "route", componentName: { text: "Queen St W" } },
            { componentType: "subpremise", componentName: { text: "Unit 7A" } },
            { componentType: "locality", componentName: { text: "Toronto" } },
            {
              componentType: "administrative_area_level_1",
              componentName: { text: "ON" },
            },
            {
              componentType: "postal_code",
              componentName: { text: "M5V 3A8" },
              confirmationLevel: "CONFIRMED",
              replaced: true,
            },
            { componentType: "country", componentName: { text: "CA" } },
          ],
        },
        geocode: { placeId: "verify-place-7a" },
      },
    });
    check(
      "a replaced postal code is CORRECTION_REQUIRED, not a pass",
      outcome.verdict === "CORRECTION_REQUIRED",
      outcome.verdict
    );
    check(
      "...and the unit is not among the differences",
      !outcome.differences.some((d) => d.component === "street2"),
      outcome.differences.map((d) => d.component).join(",") || "(none)"
    );
    const postal = outcome.differences.find((d) => d.component === "postalCode");
    check(
      "...and the postal-code discrepancy is recorded for review",
      postal?.entered === "M5V 2T6" && postal?.suggested === "M5V 3A8",
      JSON.stringify(postal ?? {})
    );

    await recordValidation({ subjectType: "DELIVERY", subjectId: order.id, outcome });

    // Nothing applied. The order still carries what the customer typed, and the
    // module still reads it that way.
    const stored = JSON.parse((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).shippingAddress ?? "{}");
    check("the postal code on the order is unchanged by Google's answer", stored.zip === "M5V 2T6", String(stored.zip));
    check("the unit on the order is unchanged", stored.address2 === "Unit 7A", String(stored.address2));
    const reread = await loadSubjectAddress("DELIVERY", order.id);
    check(
      "...and the gate still reads the entered address, not the suggestion",
      reread?.postalCode === "M5V 2T6" && reread?.street2 === "Unit 7A",
      `${reread?.street2} / ${reread?.postalCode}`
    );

    const status = await addressStatus("DELIVERY", order.id);
    check(
      "the discrepancy is visible to the person deciding",
      status.differences.some((d) => d.component === "postalCode"),
      status.differences.map((d) => d.component).join(",") || "(none)"
    );
    check("...and the gate is shut on it", status.allowed === false, status.label);

    const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId: order.id } });
    const quote = await prisma.shippingQuote.findFirstOrThrow({ where: { orderId: order.id } });
    responder = () => ({ status: 200, body: BOOKED_BODY("ADDR-7A") });
    providerCalls = [];
    let message = "";
    try {
      await bookPreparedShipment(shipment.id, quote.id, ACTOR);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    check("booking is refused while the postal code is disputed", message.length > 0, message.slice(0, 160));
    check("...and nothing is bought", apiCalls().length === 0, `calls=${apiCalls().length}`);

    // The source of the last write is checked too: no code path copies a
    // suggestion onto a stored address. If one ever does, this pin fails and
    // points at the line.
    const writes = sourceLinesMatching(/shippingAddress:\s*(JSON\.stringify\()?\s*(outcome|suggested)/);
    check(
      "no code writes a validation suggestion over a stored address",
      writes.length === 0,
      writes.join(" | ").slice(0, 160)
    );
  }

  /* --- the scopes this suite's orders are NOT bought with ---------------- */
  {
    /*
     * The owner's instruction was explicit: do not add write_orders or
     * write_draft_orders to create a test order, and buy through the storefront
     * as a customer instead. A scope is a capability the whole app carries
     * afterwards, so the pin is a check rather than a promise.
     */
    const writesOrderScope = (text: string) => {
      const found = text.match(/\bwrite_(draft_)?orders\b/g) ?? [];
      return found.length > 0;
    };

    // The declaration of record, when the repository is in view. The harness
    // mounts app/ and prisma/ but not the repository root, so this one is
    // checked where it exists and skipped where it does not — skipping loudly,
    // because a check that passes because it read nothing is the kind of pass
    // this file exists to avoid.
    const tomlPath = join(process.cwd(), "shopify.app.toml");
    if (existsSync(tomlPath)) {
      const declared = readFileSync(tomlPath, "utf8")
        .split("\n")
        .filter((line) => /^\s*scopes\s*=/.test(line))
        .join("\n");
      check(
        "shopify.app.toml asks for no order-writing scope",
        declared.length > 0 && !writesOrderScope(declared),
        declared.length === 0 ? "(no scopes line found — check is vacuous)" : writesOrderScope(declared) ? "write_orders present" : "clean"
      );
    } else {
      console.log("SKIP  shopify.app.toml is not mounted here; the runtime scope list below is checked instead");
    }

    // What the running app actually asks Shopify for. In the harness this is the
    // deployment's own value, read from the environment the suites already run
    // with — so it says something about the deployed app, not just the tree.
    const envScopes = process.env.SCOPES ?? "";
    check(
      "the configured scope list carries no order-writing scope",
      envScopes.length > 0 && !writesOrderScope(envScopes),
      envScopes.length === 0 ? "(SCOPES is unset — check is vacuous)" : writesOrderScope(envScopes) ? "write_orders present" : `clean, ${envScopes.split(",").length} scopes`
    );

    // And the one place a scope list is assembled in code.
    const shopifyConfig = readFileSync(join(process.cwd(), "app", "shopify.server.js"), "utf8");
    const scopeLines = shopifyConfig
      .split("\n")
      .filter((line) => /scopes/i.test(line))
      .join("\n");
    check(
      "app/shopify.server.js passes the scope list through untouched",
      !writesOrderScope(scopeLines),
      scopeLines.trim().slice(0, 160)
    );
  }

  restoreFetch();
}

/**
 * Source lines under app/ matching a pattern — for pins about what must NOT be
 * there. A behavioural check can only speak for the paths it exercises; a pin
 * speaks for the whole file tree, which is what "no code does this" needs.
 */
function sourceLinesMatching(pattern: RegExp): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = `${dir}/${entry}`;
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry)) continue;
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (pattern.test(line)) hits.push(`${path}:${index + 1}`);
        });
    }
  };
  walk(join(process.cwd(), "app"));
  return hits;
}

async function main() {
  await quoteInvalidationChecks();
  await quoteWithdrawalWiringChecks();
  await addressChangeChecks();
  await bookingOutcomeChecks();
  await originGateChecks();
  await addressGateChecks();
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
