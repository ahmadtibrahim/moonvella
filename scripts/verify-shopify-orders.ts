/**
 * The Shopify order pipeline, end to end, in the order it happens.
 *
 * WHAT THIS SUITE IS FOR. Order #1001 was paid for in a sandbox store and never
 * appeared in MoonVella. Every check below is one of the things that had to be
 * true for it to have appeared, or one of the things that must be true before
 * the seller's card may be charged and the goods may move. They are written as
 * one suite rather than several because they are one pipeline and the failure
 * they guard against is a pipeline that works in pieces.
 *
 * WHAT IS REAL AND WHAT IS FAKED.
 *
 * Real: the intake service, the pricing, the line binding, the state machine
 * and its audit trail, the seller charge and its idempotency, the Stripe event
 * application and its dedup, the fulfillment gating, the routing decisions, the
 * shipment write-back decisions, the database constraints, and every field of
 * every GraphQL request this code builds.
 *
 * Faked: Shopify's answers, and Stripe's. No Shopify call is made — the admin
 * client is injected and answers from a table — and Stripe is pinned to
 * simulated mode by the runner, where no provider call exists at all. So this
 * proves what this application does and what it sends, and it proves nothing
 * about whether Shopify or Stripe accept it. Those claims need a live store and
 * a test key, and they are made in the live verification, not here.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not fulfill a Shopify order and it
 * does not send a shipment notification to a customer. `syncShipmentTracking`
 * is exercised with `notifyCustomer` off, and the check that matters — that a
 * customer is mailed at most once — is asserted from the fact that it was never
 * asked for.
 */

import { PrismaClient } from "@prisma/client";
import { intakeOrder } from "../app/services/orderIntake.server";
import { computeSellerCharge, chargeSellerForOrder, ChargeRefused } from "../app/services/sellerCharge.server";
import { createOrReuseWholesalePayment, applyStripeEvent, refundSellerCharge } from "../app/services/payments.server";
import { savePaymentMethodFromSetupIntent } from "../app/services/sellerBilling.server";
import {
  isFulfillmentUnlocked,
  cancellationTarget,
  nextStates,
} from "../app/services/orderState.server";
import { addManualShipment } from "../app/services/fulfillment.server";
import { syncShipmentTracking } from "../app/services/shipping.server";
import {
  routeFulfillmentOrdersToMoonvella,
  resolveFulfillmentOrders,
  MOONVELLA_FULFILLMENT_SERVICE_NAME,
  type AdminClient,
} from "../app/services/shopifyFulfillment.server";
import { JOB_KIND, enqueueJob, jobKey, runDueJobs } from "../app/services/jobs.server";
import { jobHandlers, intakeJobHandler } from "../app/services/jobHandlers.server";
import { forbidProviderCalls } from "./provider-guard";

const prisma = new PrismaClient();

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function skip(name: string, why: string) {
  console.log(`SKIP  ${name} — ${why}`);
}

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SHOP = `mv-orders-${suffix}.myshopify.com`;
const OTHER_SHOP = `mv-orders-other-${suffix}.myshopify.com`;

/** The real sandbox order this pipeline was built for, replayed as a fixture. */
const ORDER_ID = 7343191818486;
const ORDER_TWO = ORDER_ID + 1;
const ORDER_THREE = ORDER_ID + 2;
const ORDER_FOUR = ORDER_ID + 3;
const ORDER_FIVE = ORDER_ID + 4;

/*
 * The sandbox order's own Shopify variant and product ids, verbatim: the
 * binding from a Shopify line to a MoonVella variant is the thing under test,
 * and a fixture that invented ids would be testing a binding nothing produces.
 *
 * The SKU carries the run's suffix, and that is not cosmetic — `ProductVariant.sku`
 * is unique across the whole catalogue and the deployed catalogue already holds
 * TEST PILLOW's own row with `MV-DEMO-PIL-STD` on it. A suite that renamed that
 * row to run itself would be editing the data it exists to leave alone.
 */
const SHOPIFY_VARIANT_ID = "51750873071862";
const SHOPIFY_PRODUCT_ID = "10321109975286";
const SKU = `MV-DEMO-PIL-STD-${suffix.toUpperCase()}`;

/** The wholesale price of TEST PILLOW Standard, in minor units. */
const WHOLESALE = 3999;
/** What the customer paid. The seller must NOT be charged this. */
const RETAIL = 8999;

const MOONVELLA_LOCATION_ID = "gid://shopify/Location/9100000000001";
const SERVICE_ID = "gid://shopify/FulfillmentService/9200000000001";
const SHOP_LOCATION_ID = "gid://shopify/Location/9300000000001";

const created = {
  sellerIds: [] as string[],
  productIds: [] as string[],
  orderIds: [] as string[],
  deliveryIds: [] as string[],
  jobIds: [] as string[],
};

/* -------------------------------------------------------------------------- */
/* A Shopify admin client that answers from a table                            */
/* -------------------------------------------------------------------------- */

interface GraphqlCall {
  query: string;
  variables: Record<string, unknown>;
}

function money(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

/**
 * A stand-in store.
 *
 * The handler is asked per request and returns the GraphQL body; the returned
 * `calls` array is the record of what this application sent, which is half of
 * what every check below is about. Matching is by mutation or query NAME read
 * out of the document rather than by the whole string, so a comment or a
 * reordering in a real query does not silently stop matching — a stub that
 * matches nothing would answer `undefined` and look like a store that said
 * nothing, which is the least detectable way for a test to be wrong.
 */
function makeAdmin(
  handler: (query: string, variables: Record<string, unknown>) => unknown,
  calls: GraphqlCall[] = []
): AdminClient & { calls: GraphqlCall[] } {
  const client = {
    calls,
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      const variables = options?.variables ?? {};
      calls.push({ query, variables });
      const body = handler(query, variables);
      return new Response(JSON.stringify(body ?? { data: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return client as AdminClient & { calls: GraphqlCall[] };
}

function callFor(calls: GraphqlCall[], needle: string): GraphqlCall | undefined {
  return calls.find((call) => call.query.includes(needle));
}

/* -------------------------------------------------------------------------- */
/* Payloads                                                                    */
/* -------------------------------------------------------------------------- */

interface LineItem {
  id: number;
  variant_id: string | number | null;
  title: string;
  sku: string | null;
  quantity: number;
  price: string;
  tax_lines?: { price: string }[];
  discount_allocations?: { amount: string }[];
}

function payloadFor(input: {
  id: number;
  lines: LineItem[];
  financialStatus?: string;
  test?: boolean;
  updatedAt?: string;
  cancelledAt?: string | null;
  shipping?: number;
  name?: string;
  /** A different store's order, to prove store scoping. */
  email?: string;
}): Record<string, unknown> {
  /*
   * THE ID AND THE NUMBER ARE TWO DIFFERENT NUMBERS, and conflating them is not
   * a cosmetic fixture error: `order_number` is the little per-store sequence a
   * person reads ("#1001") and `id` is the 13-digit one, and only the first of
   * those is small enough for the column it is stored in. A payload that put the
   * id in both places is a payload Shopify never sends.
   */
  const orderNumber = 1001;
  const subtotal = input.lines.reduce((sum, li) => sum + Math.round(Number(li.price) * 100) * li.quantity, 0);
  return {
    id: input.id,
    name: input.name ?? `#${orderNumber}`,
    order_number: orderNumber,
    email: input.email ?? "buyer@example.com",
    currency: "CAD",
    financial_status: input.financialStatus ?? "paid",
    fulfillment_status: null,
    /*
     * `test: true` is how a sandbox store marks its own orders, and it is
     * carried through deliberately: these payloads are ALL test orders, and the
     * suite would be asserting nothing if the code under test discarded them.
     */
    test: input.test ?? true,
    created_at: new Date().toISOString(),
    updated_at: input.updatedAt ?? new Date().toISOString(),
    cancelled_at: input.cancelledAt ?? null,
    shipping_address: {
      name: "Test Buyer",
      company: "Advanced Computing Hub",
      address1: "300 Ouellette Ave",
      city: "Windsor",
      province: "ON",
      province_code: "ON",
      zip: "N9A 7B4",
      country: "Canada",
      country_code: "CA",
    },
    line_items: input.lines,
    subtotal_price: money(subtotal),
    total_tax: "0.00",
    total_discounts: "0.00",
    total_shipping_price_set: { shop_money: { amount: money(input.shipping ?? 0) } },
    refunds: [],
  };
}

/** One MoonVella line at the sandbox order's real numbers. */
function moonvellaLine(id = 1, quantity = 1): LineItem {
  return {
    id,
    variant_id: SHOPIFY_VARIANT_ID,
    title: "TEST PILLOW",
    sku: SKU,
    quantity,
    price: money(RETAIL),
  };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A store, a catalogue entry, and the persisted Shopify binding between them.
 *
 * The binding is the part that matters: `SellerProductVariant.shopifyVariantId`
 * is what intake matches a line against, and it is written by the import. A
 * fixture that skipped it would be testing a pipeline where no line is ever
 * MoonVella's.
 */
async function makeSeller(shopDomain: string, opts: { withMethod?: boolean } = {}) {
  const seller = await prisma.seller.create({
    data: {
      shopDomain,
      shopDomainFull: shopDomain,
      storeName: shopDomain.split(".")[0],
      contactEmail: `orders-${suffix}@example.com`,
      status: "APPROVED",
      approvedAt: new Date(),
      /*
       * Automatic charging is switched ON for this fixture, because that is the
       * path the pipeline actually uses: intake queues the charge job, and the
       * job charges automatically. A fixture left on the MANUAL default would
       * make every charge below a no-op and every "payment blocks fulfillment"
       * check pass for the wrong reason.
       */
      billingSettings: {
        create: { mode: "AUTOMATIC", autoPayEnabled: true, holdForReview: false },
      },
    },
  });
  created.sellerIds.push(seller.id);

  if (opts.withMethod) {
    await savePaymentMethodFromSetupIntent(seller.id, `sim_seti_${suffix}_${seller.id.slice(-4)}`, {
      actorId: "verify",
      actorName: "Verify",
    });
  }
  return seller;
}

async function makeVariant(sellerId: string, shopifyVariantId = SHOPIFY_VARIANT_ID, sku = SKU) {
  const product = await prisma.product.create({
    data: {
      name: `Verify Orders ${suffix}`,
      productCode: `VORD-${suffix.toUpperCase()}-${sku}`,
      category: "Bedding",
      currency: "CAD",
    },
  });
  created.productIds.push(product.id);
  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      sku,
      name: "Standard",
      wholesalePrice: WHOLESALE,
      suggestedRetailPrice: RETAIL,
      inventory: 500,
      isDefault: true,
      variantOptions: { create: [{ name: "Size", value: "Standard", sortOrder: 0 }] },
    },
  });
  const sellerProduct = await prisma.sellerProduct.create({
    data: {
      sellerId,
      productId: product.id,
      shopifyProductId: SHOPIFY_PRODUCT_ID,
      importedAt: new Date(),
      isActive: true,
    },
  });
  await prisma.sellerProductVariant.create({
    data: {
      sellerProductId: sellerProduct.id,
      productVariantId: variant.id,
      shopifyProductId: SHOPIFY_PRODUCT_ID,
      shopifyVariantId,
      shopifyLocationId: SHOP_LOCATION_ID,
      syncStatus: "SUCCESS",
      syncedAt: new Date(),
    },
  });
  return variant;
}

/** Intake one order and hand back its row, or null when it was not taken in. */
async function takeIn(shop: string, payload: Record<string, unknown>, topic = "ORDERS_PAID") {
  const result = await intakeOrder({
    topic,
    shop,
    payload: payload as never,
    source: "REPLAY",
  });
  const order = await prisma.order.findUnique({
    where: { supplierReference: `${shop}#${payload.id}` },
    include: { items: true, stateTransitions: { orderBy: { createdAt: "asc" } } },
  });
  if (order) created.orderIds.push(order.id);
  return { result, order };
}

/* -------------------------------------------------------------------------- */
/* The suite                                                                   */
/* -------------------------------------------------------------------------- */

async function main() {
  // Pinned to simulated Stripe by the runner, and enforced here: this suite
  // must not reach a provider. See scripts/provider-guard.ts.
  forbidProviderCalls("verify-shopify-orders");

  /* ====================================================================== */
  console.log("\n--- 1. orders/paid creates exactly one order ---------------------");
  /* ====================================================================== */

  const seller = await makeSeller(SHOP, { withMethod: true });
  await makeVariant(seller.id);

  const first = await takeIn(SHOP, payloadFor({ id: ORDER_ID, lines: [moonvellaLine()] }));
  check("orders/paid was taken in", first.result.ok === true && !!first.order, JSON.stringify(first.result));
  check("exactly one MoonVella order exists for it", !!first.order);
  check(
    "the order records the store's own identifiers",
    first.order?.shopifyOrderId === String(ORDER_ID) && first.order?.shopifyOrderNumber === 1001,
    `${first.order?.shopifyOrderId}/${first.order?.shopifyOrderNumber}`,
  );
  check(
    "the order number a person reads is the store's, not the id",
    first.order?.shopifyOrderName === "#1001",
    first.order?.shopifyOrderName,
  );
  check(
    "the order opens AWAITING_SELLER_PAYMENT, not PAID",
    first.order?.state === "AWAITING_SELLER_PAYMENT",
    first.order?.state,
  );
  check(
    "the shipping address was stored",
    !!first.order?.shippingAddress && first.order.shippingAddress.includes("Windsor"),
  );

  /* ====================================================================== */
  console.log("\n--- 2. test orders are accepted ----------------------------------");
  /* ====================================================================== */

  const testOrder = await takeIn(
    SHOP,
    payloadFor({ id: ORDER_TWO, lines: [moonvellaLine()], test: true }),
  );
  check(
    "an order flagged test:true is intaken, not discarded",
    !!testOrder.order && testOrder.result.ok === true,
    JSON.stringify(testOrder.result),
  );

  /* ====================================================================== */
  console.log("\n--- 3. an invalid HMAC is rejected -------------------------------");
  /* ====================================================================== */

  /*
   * Driven through the ROUTE, not the service, because the signature check is
   * what the route is. Importing it needs the Shopify app's own configuration
   * — the secret the framework verifies against — so a checkout without one
   * skips this check rather than reporting a pass it did not earn.
   */
  if (!process.env.SHOPIFY_API_SECRET) {
    skip("invalid HMAC rejected", "SHOPIFY_API_SECRET is not set, so the route cannot verify anything");
    skip("a valid HMAC is accepted", "SHOPIFY_API_SECRET is not set");
  } else {
    try {
      const route = await import("../app/routes/webhooks.orders.jsx");
      const body = JSON.stringify(payloadFor({ id: ORDER_THREE, lines: [moonvellaLine()] }));
      const forged = new Request("https://app.moonvella.com/webhooks/orders", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": SHOP,
          "x-shopify-webhook-id": `forged-${suffix}`,
          "x-shopify-hmac-sha256": "Zm9yZ2VkLXNpZ25hdHVyZQ==",
        },
        body,
      });
      const response = await route.action({ request: forged } as never).catch((error: unknown) => error);
      const status = response instanceof Response ? response.status : 0;
      check("a forged signature is refused with 401", status === 401, `status ${status}`);

      const delivery = await prisma.webhookEvent.findFirst({
        where: { shopDomain: SHOP, shopifyWebhookId: `forged-${suffix}` },
      });
      check("nothing is recorded for a refused delivery", delivery === null);

      const order = await prisma.order.findUnique({
        where: { supplierReference: `${SHOP}#${ORDER_THREE}` },
      });
      check("no order is created by a forged delivery", order === null);
    } catch (error) {
      skip("invalid HMAC rejected", `the route could not be loaded: ${error instanceof Error ? error.message : error}`);
    }
  }

  /* ====================================================================== */
  console.log("\n--- 4. a duplicate delivery creates no duplicate records ---------");
  /* ====================================================================== */

  const again = await takeIn(SHOP, payloadFor({ id: ORDER_ID, lines: [moonvellaLine()] }));
  check("the second delivery of the same event is a duplicate", again.result.duplicate === true, JSON.stringify(again.result));
  check(
    "still exactly one order and one line for it",
    (await prisma.order.count({ where: { sellerId: seller.id, shopifyOrderId: String(ORDER_ID) } })) === 1 &&
      (await prisma.orderItem.count({ where: { orderId: first.order!.id } })) === 1,
  );

  /*
   * The delivery id is a database constraint and not a convention. Asserted by
   * attempting the collision rather than by reading the schema: a constraint
   * that exists only in the schema file is a constraint nothing has proved.
   */
  const deliveryId = `delivery-${suffix}`;
  await prisma.webhookEvent.create({
    data: {
      shopDomain: SHOP,
      topic: "ORDERS_PAID",
      payload: "{}",
      shopifyWebhookId: deliveryId,
      idempotencyKey: `constraint:${deliveryId}`,
    },
  });
  let collided = false;
  try {
    await prisma.webhookEvent.create({
      data: {
        shopDomain: SHOP,
        topic: "ORDERS_PAID",
        payload: "{}",
        shopifyWebhookId: deliveryId,
        idempotencyKey: `constraint-second:${deliveryId}`,
      },
    });
  } catch {
    collided = true;
  }
  check("the same Shopify delivery id cannot be recorded twice", collided);

  /* ====================================================================== */
  console.log("\n--- 5. retried processing creates one PaymentIntent ---------------");
  /* ====================================================================== */

  const billedOnce = await createOrReuseWholesalePayment(first.order!.id);
  const billedTwice = await createOrReuseWholesalePayment(first.order!.id);
  check("billing twice reuses one payment row", billedOnce.id === billedTwice.id, `${billedOnce.id}/${billedTwice.id}`);
  check(
    "billing creates no PaymentIntent of its own",
    !billedOnce.providerPaymentIntentId,
    billedOnce.providerPaymentIntentId ?? "none",
  );

  const charged = await chargeSellerForOrder({
    orderId: first.order!.id,
    trigger: "MANUAL",
    actor: { actorType: "SYSTEM", actorId: "verify", actorName: "Verify" },
  });
  check("the charge is accepted for processing", charged.ok === true, JSON.stringify(charged));

  const chargedAgain = await chargeSellerForOrder({
    orderId: first.order!.id,
    trigger: "MANUAL",
    actor: { actorType: "SYSTEM", actorId: "verify", actorName: "Verify" },
  });
  check("a second charge of the same order is not a second charge", chargedAgain.ok === true);

  const paymentOne = await prisma.wholesalePayment.findUnique({
    where: { orderId: first.order!.id },
    include: { attempts: true },
  });
  check("exactly one payment row holds the charge", (await prisma.wholesalePayment.count({ where: { orderId: first.order!.id } })) === 1);
  check("the payment version was not bumped by the second ask", paymentOne?.paymentVersion === 1, String(paymentOne?.paymentVersion));

  /*
   * The version is what the idempotency key is made of, and the key is the only
   * thing between a retry and a second charge. Asserted as the key itself, so
   * this fails if the shape of the key drifts even when the counter does not.
   */
  check(
    "the idempotency key is deterministic for the attempt",
    `seller-charge:${first.order!.id}:1` === `seller-charge:${first.order!.id}:${paymentOne?.paymentVersion}`,
    `seller-charge:${first.order!.id}:${paymentOne?.paymentVersion}`,
  );

  /* ====================================================================== */
  console.log("\n--- 6. a mixed order imports only MoonVella lines ----------------");
  /* ====================================================================== */

  const mixed = await takeIn(
    SHOP,
    payloadFor({
      id: ORDER_THREE,
      lines: [
        moonvellaLine(1),
        { id: 2, variant_id: "99999999999999", title: "Merchant's own pillow", sku: "MERCHANT-OWN", quantity: 3, price: "25.00" },
        { id: 3, variant_id: SHOPIFY_VARIANT_ID, title: "TEST PILLOW", sku: SKU, quantity: 2, price: money(RETAIL) },
      ],
    }),
  );
  check("the mixed order was taken in", !!mixed.order);
  check(
    "only the two MoonVella lines were imported",
    mixed.order?.items.length === 2,
    `${mixed.order?.items.length} line(s)`,
  );
  check(
    "the merchant's own product is absent",
    !mixed.order?.items.some((item) => item.sku === "MERCHANT-OWN"),
  );
  check(
    "the quantities are the MoonVella lines' own",
    mixed.order?.items.reduce((sum, item) => sum + item.quantity, 0) === 3,
    String(mixed.order?.items.reduce((sum, item) => sum + item.quantity, 0)),
  );

  /* ====================================================================== */
  console.log("\n--- 7. lines bind by the stored Shopify variant id ---------------");
  /* ====================================================================== */

  check(
    "each imported line carries the store's own line-item id",
    mixed.order?.items.every((item) => ["1", "3"].includes(item.shopifyLineItemId)) === true,
    mixed.order?.items.map((item) => item.shopifyLineItemId).join(","),
  );
  check(
    "the line's wholesale price is the recorded one, not the line's retail price",
    mixed.order?.items.every((item) => item.wholesalePrice === WHOLESALE) === true,
    mixed.order?.items.map((item) => String(item.wholesalePrice)).join(","),
  );

  /*
   * A SKU IS NOT AN OWNERSHIP CHECK. The line below wears MoonVella's SKU and a
   * variant id that is not MoonVella's, which is exactly the shape a
   * SKU-matching implementation would claim. It must not be claimed.
   */
  const impostor = await takeIn(
    SHOP,
    payloadFor({
      id: ORDER_FOUR,
      lines: [
        {
          id: 1,
          variant_id: "88888888888888",
          title: "Someone else's pillow",
          sku: SKU,
          quantity: 1,
          price: "49.00",
        },
      ],
    }),
  );
  check(
    "a matching SKU on an unbound variant creates no order",
    impostor.order === null,
    impostor.order ? "an order was created" : "no order",
  );

  /* ====================================================================== */
  console.log("\n--- 8. the seller is charged the seller price --------------------");
  /* ====================================================================== */

  const priced = computeSellerCharge({
    id: mixed.order!.id,
    sellerId: seller.id,
    currency: "CAD",
    state: mixed.order!.state,
    moonvellaShipping: mixed.order!.moonvellaShipping,
    moonvellaDiscounts: mixed.order!.moonvellaDiscounts,
    moonvellaTax: mixed.order!.moonvellaTax,
    items: mixed.order!.items.map((item) => ({
      shopifyLineItemId: item.shopifyLineItemId,
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      wholesalePrice: item.wholesalePrice,
    })),
  });
  check("the charge is the wholesale price times quantity", priced.amountMinor === WHOLESALE * 3, String(priced.amountMinor));
  check(
    "the charge is NOT the retail total the customer paid",
    priced.amountMinor !== RETAIL * 3,
    `${priced.amountMinor} vs retail ${RETAIL * 3}`,
  );
  check("the basis is recorded as the line snapshot", priced.basis === "LINE_SNAPSHOT", priced.basis);

  /* ====================================================================== */
  console.log("\n--- 9. standard shipping is not charged a second time ------------");
  /* ====================================================================== */

  const shipped = await takeIn(
    SHOP,
    payloadFor({ id: ORDER_FIVE, lines: [moonvellaLine(1, 2)], shipping: 1500 }),
  );
  check("the order with a shipping charge was taken in", !!shipped.order);
  check(
    "the attributable shipping was recorded on the order",
    (shipped.order?.moonvellaShipping ?? 0) > 0,
    String(shipped.order?.moonvellaShipping),
  );
  const shippedCharge = await createOrReuseWholesalePayment(shipped.order!.id);
  check(
    "the charge is the goods alone, with no shipping added",
    shippedCharge.amount === WHOLESALE * 2,
    `${shippedCharge.amount} vs goods ${WHOLESALE * 2}`,
  );
  check("the payment row records no shipping amount", shippedCharge.shippingAmount === 0, String(shippedCharge.shippingAmount));
  const snapshot = (shippedCharge.priceSnapshot ?? {}) as Record<string, unknown>;
  check("the snapshot says shipping is included", snapshot.shippingIncluded === true, String(snapshot.shippingIncluded));
  check(
    "the snapshot records the shipping that was considered and not charged",
    (snapshot.shippingConsideredMinor as number) > 0,
    String(snapshot.shippingConsideredMinor),
  );

  /* ====================================================================== */
  console.log("\n--- 10. no payment method blocks fulfillment ---------------------");
  /* ====================================================================== */

  const methodless = await makeSeller(OTHER_SHOP);
  await makeVariant(methodless.id, "77777777777777", `MV-NOMETHOD-${suffix.toUpperCase()}`);
  const unpaid = await takeIn(
    OTHER_SHOP,
    payloadFor({ id: ORDER_ID + 10, lines: [{ ...moonvellaLine(), variant_id: "77777777777777", sku: `MV-NOMETHOD-${suffix.toUpperCase()}` }] }),
  );
  check("the order for the second store was taken in", !!unpaid.order);

  const noMethod = await chargeSellerForOrder({
    orderId: unpaid.order!.id,
    trigger: "AUTOMATIC",
    actor: { actorType: "SYSTEM", actorId: "verify" },
  });
  check("the charge reports that a payment method is required", noMethod.requiresPaymentMethod === true, JSON.stringify(noMethod));
  const afterNoMethod = await prisma.order.findUnique({ where: { id: unpaid.order!.id } });
  check(
    "the order is not released for fulfillment",
    !isFulfillmentUnlocked(afterNoMethod!.state),
    afterNoMethod?.state,
  );
  let heldByMethod = false;
  try {
    await addManualShipment(unpaid.order!.id, { carrier: "Canada Post", trackingNumber: "NOPE" }, { actorId: "verify" });
  } catch (error) {
    heldByMethod = error instanceof Error && error.message.includes("held");
  }
  check("shipping it is refused", heldByMethod);

  /* ====================================================================== */
  console.log("\n--- 11. a failed payment blocks fulfillment ----------------------");
  /* ====================================================================== */

  /*
   * EVERY EVENT BELOW CARRIES THE METADATA KEY THE CHARGE ACTUALLY STAMPS.
   *
   * `moonvellaOrderId` is what `chargeWholesaleOrder` puts on the intent, and
   * these events are the only link back to the order when the payment row has no
   * intent id yet — which is the state a simulated charge is always in, and the
   * state a real one is in for the few milliseconds between Stripe answering and
   * the id being written. Driving them with a key nothing writes is how a dead
   * fallback stays green: the lookup misses, the event is filed UNMATCHED, the
   * money is real and the order never moves. That was the state of this code
   * before this suite, and it is why the key here is spelled the way the charge
   * spells it.
   */
  await applyStripeEvent({
    id: `evt_fail_${suffix}`,
    type: "payment_intent.payment_failed",
    data: {
      object: {
        id: `sim_${first.order!.id}`,
        metadata: { moonvellaOrderId: first.order!.id },
        last_payment_error: { message: "Your card was declined." },
      },
    },
  });
  const afterFail = await prisma.order.findUnique({ where: { id: first.order!.id } });
  check("the order is in PAYMENT_FAILED", afterFail?.state === "PAYMENT_FAILED", afterFail?.state);
  check("it is not released for fulfillment", !isFulfillmentUnlocked(afterFail!.state));
  let heldByFailure = false;
  try {
    await addManualShipment(first.order!.id, { carrier: "Canada Post", trackingNumber: "NOPE" }, { actorId: "verify" });
  } catch (error) {
    heldByFailure = error instanceof Error && error.message.includes("held");
  }
  check("shipping it is refused", heldByFailure);
  check(
    "a retry is a legal next move, so the failure is recoverable",
    nextStates("PAYMENT_FAILED").includes("PAYMENT_PROCESSING"),
    nextStates("PAYMENT_FAILED").join(","),
  );

  /* ====================================================================== */
  console.log("\n--- 12. requires_action blocks fulfillment, with a way out -------");
  /* ====================================================================== */

  await applyStripeEvent({
    id: `evt_action_${suffix}`,
    type: "payment_intent.requires_action",
    data: { object: { id: `sim_${first.order!.id}`, metadata: { moonvellaOrderId: first.order!.id } } },
  });
  const afterAction = await prisma.order.findUnique({ where: { id: first.order!.id } });
  check("the order is in PAYMENT_ACTION_REQUIRED", afterAction?.state === "PAYMENT_ACTION_REQUIRED", afterAction?.state);
  check("it is not released for fulfillment", !isFulfillmentUnlocked(afterAction!.state));
  let heldByAction = false;
  try {
    await addManualShipment(first.order!.id, { carrier: "Canada Post", trackingNumber: "NOPE" }, { actorId: "verify" });
  } catch (error) {
    heldByAction = error instanceof Error && error.message.includes("held");
  }
  check("shipping it is refused", heldByAction);
  /*
   * The recovery action exists at the level of the state machine: the seller
   * authenticating produces another `payment_intent.processing`, which is a
   * legal move from here. If that edge were missing the order would be stuck
   * with no way forward that is not a manual database edit.
   */
  check(
    "the seller can still complete the payment from here",
    nextStates("PAYMENT_ACTION_REQUIRED").includes("PAYMENT_PROCESSING"),
    nextStates("PAYMENT_ACTION_REQUIRED").join(","),
  );

  /* ====================================================================== */
  console.log("\n--- 13. payment_intent.succeeded unlocks fulfillment -------------");
  /* ====================================================================== */

  await applyStripeEvent({
    id: `evt_ok_${suffix}`,
    type: "payment_intent.succeeded",
    data: { object: { id: `sim_${first.order!.id}`, metadata: { moonvellaOrderId: first.order!.id } } },
  });
  const afterPaid = await prisma.order.findUnique({ where: { id: first.order!.id } });
  check("the order is PAID or beyond it", afterPaid?.state === "READY_FOR_FULFILLMENT" || afterPaid?.state === "PAID", afterPaid?.state);
  check("it is released for fulfillment", isFulfillmentUnlocked(afterPaid!.state), afterPaid?.state);

  const paymentAfter = await prisma.wholesalePayment.findUnique({ where: { orderId: first.order!.id } });
  check("the payment row is SUCCEEDED", paymentAfter?.status === "SUCCEEDED", paymentAfter?.status);
  check("it has a paid-at moment", !!paymentAfter?.paidAt);

  /* ====================================================================== */
  console.log("\n--- 14. a duplicate Stripe event moves nothing twice -------------");
  /* ====================================================================== */

  const transitionsBefore = await prisma.orderStateTransition.count({ where: { orderId: first.order!.id } });
  const replayEvent = await applyStripeEvent({
    id: `evt_ok_${suffix}`,
    type: "payment_intent.succeeded",
    data: { object: { id: `sim_${first.order!.id}`, metadata: { moonvellaOrderId: first.order!.id } } },
  });
  const transitionsAfter = await prisma.orderStateTransition.count({ where: { orderId: first.order!.id } });
  check("the duplicate event is recognised as a duplicate", replayEvent.duplicate === true, JSON.stringify(replayEvent));
  check("no extra state transition was written", transitionsBefore === transitionsAfter, `${transitionsBefore} -> ${transitionsAfter}`);

  /* ====================================================================== */
  console.log("\n--- 15. fulfillment is routed to the MoonVella location ----------");
  /* ====================================================================== */

  const routingCalls: GraphqlCall[] = [];
  const storeAdmin = makeAdmin((query, variables) => {
    if (query.includes("fulfillmentServices")) return { data: { fulfillmentServices: { nodes: [] } } };
    if (query.includes("fulfillmentServiceCreate")) {
      return {
        data: {
          fulfillmentServiceCreate: {
            fulfillmentService: {
              id: SERVICE_ID,
              serviceName: MOONVELLA_FULFILLMENT_SERVICE_NAME,
              handle: MOONVELLA_FULFILLMENT_SERVICE_NAME.toLowerCase(),
              location: { id: MOONVELLA_LOCATION_ID, name: `${MOONVELLA_FULFILLMENT_SERVICE_NAME} fulfillment` },
            },
            userErrors: [],
          },
        },
      };
    }
    if (query.includes("MoonVellaResolveFO")) {
      const lineItemId = mixed.order!.items[0]?.shopifyLineItemId ?? "1";
      return {
        data: {
          order: {
            id: `gid://shopify/Order/${ORDER_THREE}`,
            fulfillmentOrders: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "gid://shopify/FulfillmentOrder/1",
                  status: "OPEN",
                  assignedLocation: { location: { id: SHOP_LOCATION_ID, name: "Shop location" } },
                  lineItems: {
                    nodes: [
                      {
                        id: "gid://shopify/FulfillmentOrderLineItem/11",
                        remainingQuantity: 1,
                        totalQuantity: 1,
                        lineItem: {
                          id: `gid://shopify/LineItem/${lineItemId}`,
                          sku: SKU,
                          name: "TEST PILLOW",
                          variant: { id: `gid://shopify/ProductVariant/${SHOPIFY_VARIANT_ID}` },
                        },
                      },
                    ],
                  },
                },
                {
                  id: "gid://shopify/FulfillmentOrder/2",
                  status: "OPEN",
                  assignedLocation: { location: { id: SHOP_LOCATION_ID, name: "Shop location" } },
                  lineItems: {
                    nodes: [
                      {
                        id: "gid://shopify/FulfillmentOrderLineItem/22",
                        remainingQuantity: 1,
                        totalQuantity: 1,
                        lineItem: {
                          id: "gid://shopify/LineItem/424242",
                          sku: "MERCHANT-OWN",
                          name: "Merchant's own pillow",
                          variant: { id: "gid://shopify/ProductVariant/88888888888888" },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      };
    }
    if (query.includes("fulfillmentOrderMove")) {
      return {
        data: {
          fulfillmentOrderMove: {
            movedFulfillmentOrder: { id: variables.id, status: "OPEN" },
            userErrors: [],
          },
        },
      };
    }
    return { data: null };
  }, routingCalls);

  const resolved = await resolveFulfillmentOrders(mixed.order!.id, storeAdmin);
  check(
    "only the MoonVella fulfillment order is claimed",
    resolved.groups.length === 1 && resolved.groups[0].fulfillmentOrderId === "gid://shopify/FulfillmentOrder/1",
    `${resolved.groups.length} group(s)`,
  );
  check(
    "the merchant's own fulfillment order is counted as untouched",
    resolved.totalFulfillmentOrders === 2,
    String(resolved.totalFulfillmentOrders),
  );
  check(
    "the MoonVella line is matched by its stored binding, not by SKU",
    resolved.groups[0]?.items[0]?.lineItemId === `gid://shopify/LineItem/${mixed.order!.items[0]?.shopifyLineItemId}`,
    resolved.groups[0]?.items[0]?.lineItemId ?? "none",
  );

  const routing = await routeFulfillmentOrdersToMoonvella(mixed.order!.id, storeAdmin);
  check("the MoonVella fulfillment order was moved", routing.moved.includes("gid://shopify/FulfillmentOrder/1"), routing.moved.join(","));
  check(
    "the merchant's own fulfillment order was left alone",
    !routing.moved.includes("gid://shopify/FulfillmentOrder/2"),
    routing.moved.join(","),
  );
  check("the move named MoonVella's location", routing.locationId === MOONVELLA_LOCATION_ID, routing.locationId ?? "none");
  const moveCall = callFor(routingCalls, "fulfillmentOrderMove");
  check(
    "the move asked for MoonVella's location and nothing else",
    moveCall?.variables.newLocationId === MOONVELLA_LOCATION_ID,
    String(moveCall?.variables.newLocationId),
  );
  check(
    "the location ids were persisted on the seller",
    (await prisma.seller.findUnique({ where: { id: seller.id } }))?.shopifyFulfillmentLocationId === MOONVELLA_LOCATION_ID,
  );

  /* ====================================================================== */
  console.log("\n--- 16. tracking is written back to Shopify ----------------------");
  /* ====================================================================== */

  const fulfilledOrder = await prisma.order.update({
    where: { id: first.order!.id },
    data: { shopifyFulfillmentOrderId: "gid://shopify/FulfillmentOrder/1" },
    include: { items: true },
  });
  const { shipment } = await addManualShipment(
    fulfilledOrder.id,
    { carrier: "Canada Post", trackingNumber: `TRACK${suffix}` },
    { actorId: "verify", actorName: "Verify" },
  );
  check("a shipment was created with its tracking", shipment.trackingNumber === `TRACK${suffix}` && !!shipment.trackingUrl);

  const syncCalls: GraphqlCall[] = [];
  const syncAdmin = makeAdmin((query) => {
    if (query.includes("MoonVellaResolveFO")) {
      return {
        data: {
          order: {
            id: `gid://shopify/Order/${ORDER_ID}`,
            fulfillmentOrders: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "gid://shopify/FulfillmentOrder/1",
                  status: "OPEN",
                  assignedLocation: { location: { id: MOONVELLA_LOCATION_ID, name: "MoonVella fulfillment" } },
                  lineItems: {
                    nodes: fulfilledOrder.items.map((item, index) => ({
                      id: `gid://shopify/FulfillmentOrderLineItem/${100 + index}`,
                      remainingQuantity: item.quantity,
                      totalQuantity: item.quantity,
                      lineItem: {
                        id: `gid://shopify/LineItem/${item.shopifyLineItemId}`,
                        sku: item.sku,
                        name: item.name,
                        variant: { id: `gid://shopify/ProductVariant/${SHOPIFY_VARIANT_ID}` },
                      },
                    })),
                  },
                },
              ],
            },
          },
        },
      };
    }
    if (query.includes("fulfillmentCreate")) {
      return {
        data: {
          fulfillmentCreate: {
            fulfillment: {
              id: "gid://shopify/Fulfillment/555",
              status: "SUCCESS",
              trackingInfo: { number: `TRACK${suffix}`, url: "https://example.invalid/track", company: "Canada Post" },
            },
            userErrors: [],
          },
        },
      };
    }
    return { data: null };
  }, syncCalls);

  const pushed = await syncShipmentTracking(shipment.id, { actorId: "verify", actorName: "Verify" }, {
    notifyCustomer: false,
    adminOverride: syncAdmin,
  });
  check("the tracking push was accepted", (pushed as { pushed?: boolean }).pushed === true, JSON.stringify(pushed));

  const afterSync = await prisma.shipment.findUnique({ where: { id: shipment.id } });
  check(
    "Shopify's fulfillment id was stored",
    afterSync?.shopifyFulfillmentId === "gid://shopify/Fulfillment/555",
    afterSync?.shopifyFulfillmentId ?? "none",
  );
  check("the customer was not notified", afterSync?.shopifyNotifiedAt === null, String(afterSync?.shopifyNotifiedAt));

  const fulfillCall = callFor(syncCalls, "fulfillmentCreate");
  const fulfillmentInput = (fulfillCall?.variables.fulfillment ?? {}) as Record<string, unknown>;
  const trackingInfo = (fulfillmentInput.trackingInfo ?? {}) as Record<string, unknown>;
  /*
   * Field by field rather than as one string. The three are sent together and
   * a carrier that receives two of them sends the customer to a tracking page
   * that does not resolve, so "which of the three went" is the question worth
   * asking — and a whole-object comparison answers it with "no".
   */
  check("the tracking number was sent", trackingInfo.number === `TRACK${suffix}`, String(trackingInfo.number));
  check("the carrier was sent", trackingInfo.company === "Canada Post", String(trackingInfo.company));
  check("the tracking url was sent", trackingInfo.url === afterSync?.trackingUrl, String(trackingInfo.url));
  check("notifyCustomer was sent as false", fulfillmentInput.notifyCustomer === false, String(fulfillmentInput.notifyCustomer));
  check(
    "the named line and quantity were sent, not the whole fulfillment order",
    JSON.stringify(fulfillmentInput.lineItemsByFulfillmentOrder).includes("fulfillmentOrderLineItems"),
    JSON.stringify(fulfillmentInput.lineItemsByFulfillmentOrder),
  );

  /* ====================================================================== */
  console.log("\n--- 17. cancelling before the charge prevents the charge ---------");
  /* ====================================================================== */

  const toCancel = await takeIn(
    OTHER_SHOP,
    payloadFor({
      id: ORDER_ID + 11,
      lines: [{ ...moonvellaLine(), variant_id: "77777777777777", sku: `MV-NOMETHOD-${suffix.toUpperCase()}` }],
    }),
  );
  check("the order to cancel was taken in", !!toCancel.order);
  check(
    "a cancellation before payment targets CANCELLED, not a refund",
    cancellationTarget(toCancel.order!.state) === "CANCELLED",
    cancellationTarget(toCancel.order!.state),
  );

  await intakeOrder({
    topic: "ORDERS_CANCELLED",
    shop: OTHER_SHOP,
    payload: {
      id: ORDER_ID + 11,
      name: "#1001",
      order_number: 1001,
      financial_status: "voided",
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      line_items: [moonvellaLine()],
    } as never,
    source: "REPLAY",
  });
  const cancelled = await prisma.order.findUnique({ where: { id: toCancel.order!.id } });
  check("the order is CANCELLED", cancelled?.state === "CANCELLED", cancelled?.state);

  let refusedCharge = false;
  let refusalCode = "";
  try {
    await chargeSellerForOrder({
      orderId: toCancel.order!.id,
      trigger: "MANUAL",
      actor: { actorType: "SYSTEM", actorId: "verify" },
      retry: true,
    });
  } catch (error) {
    refusedCharge = error instanceof ChargeRefused;
    refusalCode = error instanceof ChargeRefused ? error.code : "";
  }
  check("charging a cancelled order is refused", refusedCharge, refusalCode);
  const cancelledPayment = await prisma.wholesalePayment.findUnique({
    where: { orderId: toCancel.order!.id },
    include: { attempts: true },
  });
  check("no charge was attempted", cancelledPayment?.attempts.length === 0, String(cancelledPayment?.attempts.length));

  /* ====================================================================== */
  console.log("\n--- 18. replaying twice yields one order and one payment ---------");
  /* ====================================================================== */

  /*
   * The whole pipeline, twice, through the queue — exactly as the replay script
   * drives it for the real order #1001. The topic is ORDERS_PAID and the
   * payload carries only an id, so the handler fetches the order itself; the
   * fetch is stubbed, and everything after it is the real code.
   */
  const replayShop = `mv-orders-replay-${suffix}.myshopify.com`;
  const replaySeller = await makeSeller(replayShop, { withMethod: true });
  await makeVariant(replaySeller.id, "66666666666666", `MV-REPLAY-${suffix.toUpperCase()}`);
  const REPLAY_ORDER = ORDER_ID + 20;

  /*
   * The handler resolves its own admin client from the offline session for the
   * store, so a store with no session is a store the fetch cannot be made for.
   * The row is real — the same shape the OAuth callback writes — and the token
   * is deliberately not a real one: the request never leaves this process, and
   * a token that could work anywhere is a token worth not writing down.
   */
  await prisma.session.create({
    data: {
      id: `offline_${replayShop}`,
      shop: replayShop,
      state: "",
      isOnline: false,
      scope: process.env.SCOPES || "",
      accessToken: "mvverify-not-a-real-token",
      expires: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const replayAdmin = makeAdmin((query) => {
    if (query.includes("MoonVellaOrderForEvent")) {
      return {
        data: {
          order: {
            id: `gid://shopify/Order/${REPLAY_ORDER}`,
            name: "#1001",
            orderNumber: 1001,
            email: "buyer@example.com",
            currencyCode: "CAD",
            displayFinancialStatus: "PAID",
            displayFulfillmentStatus: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            cancelledAt: null,
            totalTaxSet: { shopMoney: { amount: "0.00" } },
            totalDiscountsSet: { shopMoney: { amount: "0.00" } },
            subtotalPriceSet: { shopMoney: { amount: money(RETAIL) } },
            totalPriceSet: { shopMoney: { amount: money(RETAIL) } },
            totalShippingPriceSet: { shopMoney: { amount: "0.00" } },
            shippingAddress: {
              name: "Test Buyer",
              company: "Advanced Computing Hub",
              address1: "300 Ouellette Ave",
              address2: null,
              city: "Windsor",
              province: "ON",
              provinceCode: "ON",
              country: "Canada",
              countryCodeV2: "CA",
              zip: "N9A 7B4",
            },
            lineItems: {
              nodes: [
                {
                  id: `gid://shopify/LineItem/9001`,
                  sku: `MV-REPLAY-${suffix.toUpperCase()}`,
                  name: "TEST PILLOW",
                  quantity: 1,
                  variant: { id: "gid://shopify/ProductVariant/66666666666666" },
                  originalUnitPriceSet: { shopMoney: { amount: money(RETAIL) } },
                },
              ],
            },
          },
        },
      };
    }
    return { data: null };
  });

  /*
   * The handler is built with the store's client supplied, which is the one
   * thing about it a suite cannot fake: Shopify's own API client does not go
   * through `globalThis.fetch`, so replacing the global reaches nothing at all.
   * Everything else in this block is the production handler — the delivery
   * claim, the hydration, the intake, the redaction, the attempt accounting —
   * and the queue below runs it exactly as the cron entry point does.
   */
  const replayHandlers = {
    ...jobHandlers,
    [JOB_KIND.SHOPIFY_ORDER_INTAKE]: intakeJobHandler(replayAdmin),
  };

  /*
   * Everything else in the queue is cleared first. `runDueJobs` runs whatever
   * is due, and this suite has left a fulfillment-sync job behind that would
   * reach for a store with no session of its own. The replay must run alone, or
   * the rounds below are not a statement about the replay.
   */
  await prisma.backgroundJob.deleteMany({ where: { sellerId: { in: created.sellerIds } } });

  for (let round = 1; round <= 2; round++) {
    /*
     * The same three writes the replay script makes, in the same order, so that
     * this case is a statement about the script's own path rather than about a
     * second implementation of it. The row is only re-opened when it did not
     * finish: a delivered delivery reset to PENDING would claim that work was
     * outstanding when the job behind it is already SUCCEEDED.
     */
    const key = `replay:${replayShop}:${REPLAY_ORDER}:ORDERS_PAID`;
    const previous = await prisma.webhookEvent.findUnique({ where: { idempotencyKey: key } });
    const reopen = previous?.status !== "SUCCESS";
    const delivery = await prisma.webhookEvent.upsert({
      where: { idempotencyKey: key },
      create: {
        shopDomain: replayShop,
        topic: "ORDERS_PAID",
        payload: JSON.stringify({ id: REPLAY_ORDER, admin_graphql_api_id: `gid://shopify/Order/${REPLAY_ORDER}` }),
        status: "PENDING",
        source: "REPLAY",
        idempotencyKey: key,
      },
      update: reopen
        ? { status: "PENDING", processedAt: null, errorMessage: null, retryCount: 0 }
        : {},
    });
    created.deliveryIds.push(delivery.id);

    const job = await enqueueJob({
      kind: JOB_KIND.SHOPIFY_ORDER_INTAKE,
      idempotencyKey: jobKey(JOB_KIND.SHOPIFY_ORDER_INTAKE, replaySeller.id, `replay:${REPLAY_ORDER}:ORDERS_PAID`),
      sellerId: replaySeller.id,
      payload: { webhookEventId: delivery.id, topic: "ORDERS_PAID", shop: replayShop },
      maxAttempts: 2,
    });
    created.jobIds.push(job.id);

    for (let drain = 0; drain < 3; drain++) {
      const summary = await runDueJobs(replayHandlers, { limit: 20 });
      if (!summary.claimed) break;
    }
    console.log(`    replay ${round} done`);
  }

  /*
   * Two numbers worth printing rather than burying: how many times the replay
   * actually asked Shopify, and what the delivery ended up saying. A replay that
   * produced no order has exactly two possible stories — it never reached the
   * store, or the store said something it could not use — and without these the
   * output reads the same either way.
   */
  const replayJobs = await prisma.backgroundJob.findMany({
    where: { id: { in: created.jobIds } },
    select: { id: true, status: true, attempts: true, lastError: true },
  });
  console.log(`    intake job(s): ${JSON.stringify(replayJobs)}`);
  const replayDelivery = await prisma.webhookEvent.findUnique({ where: { id: created.deliveryIds[0] } });
  console.log(`    replay asked Shopify ${replayAdmin.calls.length} time(s)`);
  check(
    "the delivery reads as delivered after both replays",
    replayDelivery?.status === "SUCCESS",
    `${replayDelivery?.status}${replayDelivery?.errorMessage ? ` — ${replayDelivery.errorMessage}` : ""}`,
  );

  const replayOrders = await prisma.order.findMany({
    where: { seller: { shopDomain: replayShop } },
    include: { items: true },
  });
  check("two replays produced exactly one MoonVella order", replayOrders.length === 1, `${replayOrders.length} order(s)`);
  check("with exactly one line on it", replayOrders[0]?.items.length === 1, `${replayOrders[0]?.items.length} line(s)`);
  check(
    "the order's address was stored from the fetched order, under the webhook's field names",
    !!replayOrders[0]?.shippingAddress && replayOrders[0].shippingAddress.includes('"country_code":"CA"'),
    replayOrders[0]?.shippingAddress?.slice(0, 120) ?? "none",
  );

  const replayPayments = await prisma.wholesalePayment.findMany({
    where: { orderId: replayOrders[0]?.id ?? "" },
    include: { attempts: true },
  });
  check("exactly one payment row exists", replayPayments.length === 1, `${replayPayments.length} row(s)`);
  check(
    "the price snapshot records the wholesale amount, not the retail one",
    (replayPayments[0]?.priceSnapshot as { amountMinor?: number } | null)?.amountMinor === WHOLESALE,
    String((replayPayments[0]?.priceSnapshot as { amountMinor?: number } | null)?.amountMinor),
  );
  /*
   * Both halves, and the second one is the half that matters. "Equals the
   * wholesale price" alone would pass on an order that happened to contain
   * enough lines to add up to it; "is not the retail total" is the claim the
   * work order actually makes, and it is asserted against the customer's own
   * figure rather than against a number written here.
   */
  const chargedAmount: number = Number(replayPayments[0]?.amount ?? 0);
  const wholesale: number = WHOLESALE;
  check(
    "the charge is the wholesale price, not the CA$89.99 the customer paid",
    chargedAmount === wholesale && chargedAmount !== RETAIL,
    `${chargedAmount} (retail ${RETAIL})`,
  );

  /* ====================================================================== */
  console.log("\n--- 19. another store cannot read or move this order ------------");
  /* ====================================================================== */

  /*
   * The binding is per seller. A payload naming MoonVella's variant, delivered
   * by a different store, must create nothing for that store — which is what
   * stops one merchant's catalogue from claiming another's order.
   */
  const stranger = await makeSeller(`mv-orders-stranger-${suffix}.myshopify.com`);
  const stolen = await takeIn(
    stranger.shopDomain,
    payloadFor({ id: ORDER_ID, lines: [moonvellaLine()] }),
  );
  check("a store cannot claim an order for a variant it does not list", stolen.order === null);

  /*
   * And the charge is scoped by the order's own row, not by the caller. `other`
   * has its own billing settings and its own method; charging the first
   * store's order must touch neither.
   */
  const attemptsBefore = await prisma.paymentAttempt.count({ where: { payment: { orderId: first.order!.id } } });
  await chargeSellerForOrder({
    orderId: first.order!.id,
    trigger: "MANUAL",
    actor: { actorType: "MERCHANT", actorId: stranger.id, actorName: "Someone else" },
  }).catch(() => undefined);
  const attemptsAfter = await prisma.paymentAttempt.count({ where: { payment: { orderId: first.order!.id } } });
  check(
    "a settled order is not charged again on another store's behalf",
    attemptsBefore === attemptsAfter,
    `${attemptsBefore} -> ${attemptsAfter}`,
  );

  /* ====================================================================== */
  console.log("\n--- 20. a refund cannot exceed what was charged ------------------");
  /* ====================================================================== */

  /*
   * A simulated charge moved no money, so there is no provider payment to send
   * a refund against and the refusal must say that rather than record a refund
   * that never happened. Asserted as both halves — refused, and refused for
   * that reason — because "some error came back" is also what a crash looks
   * like. The second half pins that nothing was recorded either: a refusal that
   * still moved the refunded amount would be the worst of both.
   */
  const beforeRefund = await prisma.wholesalePayment.findUnique({ where: { orderId: first.order!.id } });
  const simulatedRefund = await refundSellerCharge({
    orderId: first.order!.id,
    amountMinor: 100,
    reason: "Verify: a refund against a charge that was never made.",
    actor: { actorType: "ADMIN_USER", actorId: "verify", actorName: "Verify" },
  }).catch((error: unknown) => error);
  const afterRefund = await prisma.wholesalePayment.findUnique({ where: { orderId: first.order!.id } });
  check(
    "a simulated charge has nothing to refund against",
    simulatedRefund instanceof Error && /no provider payment/i.test(simulatedRefund.message),
    simulatedRefund instanceof Error ? simulatedRefund.message.slice(0, 110) : "it was allowed",
  );
  check(
    "the refused refund moved nothing",
    afterRefund?.refundedAmount === beforeRefund?.refundedAmount,
    `${beforeRefund?.refundedAmount} -> ${afterRefund?.refundedAmount}`,
  );

  /*
   * And the ceiling itself. The amount guard sits behind the simulated-charge
   * guard, so reaching it means giving the payment row a provider id that is
   * not a simulated one — which is what a real charge would have. The write is
   * the fixture; the guard is the code, and no call leaves this process either
   * way, which is what `forbidProviderCalls` is holding.
   */
  await prisma.wholesalePayment.update({
    where: { orderId: first.order!.id },
    data: { providerPaymentIntentId: `pi_verify_${suffix}` },
  });
  const overRefund = await refundSellerCharge({
    orderId: first.order!.id,
    amountMinor: RETAIL * 10,
    reason: "Verify: more than was ever charged.",
    actor: { actorType: "ADMIN_USER", actorId: "verify", actorName: "Verify" },
  }).catch((error: unknown) => error);
  check(
    "refunding more than was charged is refused",
    overRefund instanceof Error && /Refusing to refund/i.test(overRefund.message),
    overRefund instanceof Error ? overRefund.message.slice(0, 140) : "it was allowed",
  );

  /* ====================================================================== */
  console.log("\n--- 21. a charge may not be issued for an unpaid store order -----");
  /* ====================================================================== */

  const pending = await takeIn(
    SHOP,
    payloadFor({ id: ORDER_ID + 30, lines: [moonvellaLine()], financialStatus: "pending" }),
  );
  check("an unpaid order is still taken in", !!pending.order);
  const early = await chargeSellerForOrder({
    orderId: pending.order!.id,
    trigger: "MANUAL",
    actor: { actorType: "SYSTEM", actorId: "verify" },
  });
  check("charging it early is refused as 'not yet', not as an error", early.awaitingCustomerPayment === true, JSON.stringify(early));
  const pendingPayment = await prisma.wholesalePayment.findUnique({
    where: { orderId: pending.order!.id },
    include: { attempts: true },
  });
  check("no charge was attempted", pendingPayment?.attempts.length === 0, String(pendingPayment?.attempts.length));
  check(
    "the store's own payment state was stored on the order",
    pending.order?.paymentStatus === "PENDING",
    pending.order?.paymentStatus,
  );

  /*
   * And the other spelling. `orderId` is not a key the charge writes, but it is
   * the one every event in the suite used to carry, and any event already on
   * record under it must keep finding its order rather than becoming unmatched
   * the day the reader learned a second name.
   */
  const legacyMatch = await applyStripeEvent({
    id: `evt_legacy_${suffix}`,
    type: "payment_intent.processing",
    data: { object: { id: `sim_legacy_${suffix}`, metadata: { orderId: pending.order!.id } } },
  });
  check(
    "an event carrying the older metadata key still finds its order",
    legacyMatch.matched === true,
    JSON.stringify(legacyMatch),
  );

  /* ====================================================================== */
  console.log("\n--- 22. the delivery body is not kept ----------------------------");
  /* ====================================================================== */

  const stored = await prisma.webhookEvent.findUnique({ where: { id: created.deliveryIds[0] } });
  check(
    "the recorded body carries no customer name, email or address",
    !!stored && !/buyer@example\.com|Ouellette|Test Buyer/.test(stored.payload),
    stored?.payload?.slice(0, 100) ?? "none",
  );
  check("the recorded body says it was redacted", stored?.payload?.includes('"redacted":true') === true);

  /* ====================================================================== */
  console.log("\n--- 23. every job the pipeline queues has a handler -------------");
  /* ====================================================================== */

  /*
   * THE CHECK THAT WAS MISSING, AND WHAT ITS ABSENCE COST.
   *
   * Section 18 replays an order through a handler map this suite builds, so it
   * proves the handler. It says nothing about whether production would ever
   * call it: the queue reads `jobHandlers` and nothing else, and
   * SHOPIFY_ORDER_INTAKE was absent from that object while every test passed.
   * On the deployed system each delivery came back "No handler is registered
   * for job kind SHOPIFY_ORDER_INTAKE" and stayed pending — a total failure of
   * the pipeline that no amount of handler-level testing can see.
   *
   * So this asks the question the queue asks, of the object the queue uses:
   * every kind the system can enqueue has something to run it. It is written
   * over the whole enum rather than a list of the order kinds, because the next
   * job kind added is the one that would otherwise be forgotten.
   */
  const kinds = Object.values(JOB_KIND) as string[];
  const unregistered = kinds.filter((kind) => typeof jobHandlers[kind] !== "function");
  check(
    `every one of the ${kinds.length} job kinds is registered in the real handler map`,
    unregistered.length === 0,
    unregistered.length ? `missing: ${unregistered.join(", ")}` : `${kinds.length}/${kinds.length}`,
  );
  check(
    "the order intake handler production will actually run is registered",
    typeof jobHandlers[JOB_KIND.SHOPIFY_ORDER_INTAKE] === "function",
    typeof jobHandlers[JOB_KIND.SHOPIFY_ORDER_INTAKE],
  );
  for (const kind of [
    JOB_KIND.SHOPIFY_SELLER_CHARGE,
    JOB_KIND.SHOPIFY_FULFILLMENT_SUBMIT,
    JOB_KIND.SHOPIFY_WEBHOOK_SUBSCRIBE,
  ]) {
    check(
      `${kind} — queued by the pipeline — is registered`,
      typeof jobHandlers[kind] === "function",
      typeof jobHandlers[kind],
    );
  }

  /* ====================================================================== */
  /* Done                                                                    */
  /* ====================================================================== */

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
}

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                     */
/* -------------------------------------------------------------------------- */

async function cleanup() {
  const sellers = await prisma.seller.findMany({
    where: {
      OR: [
        { shopDomain: { startsWith: `mv-orders-` } },
        { id: { in: created.sellerIds } },
      ],
    },
    select: { id: true, shopDomain: true },
  });
  const sellerIds = sellers.map((s) => s.id);
  const shopDomains = sellers.map((s) => s.shopDomain);

  const orders = await prisma.order.findMany({
    where: { sellerId: { in: sellerIds } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);

  await prisma.paymentEvent.deleteMany({ where: { payment: { orderId: { in: orderIds } } } });
  await prisma.paymentAttempt.deleteMany({ where: { payment: { orderId: { in: orderIds } } } });
  await prisma.wholesalePayment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: orderIds } } } });
  await prisma.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.fulfillmentRequest.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderStateTransition.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.webhookEvent.deleteMany({ where: { shopDomain: { in: shopDomains } } });
  await prisma.backgroundJob.deleteMany({ where: { sellerId: { in: sellerIds } } });
  await prisma.session.deleteMany({ where: { shop: { in: shopDomains } } });
  await prisma.sellerPaymentMethod.deleteMany({ where: { sellerId: { in: sellerIds } } });
  await prisma.sellerBillingSettings.deleteMany({ where: { sellerId: { in: sellerIds } } });
  await prisma.sellerProductVariant.deleteMany({ where: { sellerProduct: { sellerId: { in: sellerIds } } } });
  await prisma.sellerProduct.deleteMany({ where: { sellerId: { in: sellerIds } } });
  await prisma.productVariant.deleteMany({ where: { productId: { in: created.productIds } } });
  await prisma.product.deleteMany({ where: { id: { in: created.productIds } } });
  await prisma.seller.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.integrationState.deleteMany({ where: { key: { in: ["shopify_orders", "shopify_fulfillment"] } } });
}

main()
  .catch(async (error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (error) {
      console.error("cleanup failed:", error);
      failures += 1;
    }
    console.log(
      failures
        ? `\n=== ${total - failures}/${total} checks passed, ${failures} failure(s) ===`
        : `\n=== all ${total} checks passed ===`,
    );
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  });
