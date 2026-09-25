import { PrismaClient } from "@prisma/client";
import {
  getBillingSettings,
  updateBillingSettings,
  savePaymentMethodFromSetupIntent,
  chargeWholesaleOrder,
} from "../app/services/sellerBilling.server";
import {
  getQuotesForOrder,
  selectQuote,
  bookShipmentForOrder,
  voidShipment,
} from "../app/services/shipping.server";
import { applyStripeEvent } from "../app/services/payments.server";
import { forbidProviderCalls } from "./provider-guard";
import { installEshipperStub } from "./eshipper-stub";
import { acceptAddress } from "./verify-address-fixtures";

const prisma = new PrismaClient();
const SHOP = "wholesale-test.myshopify.com";
let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const actor = { actorId: "verify", actorName: "Verify" };

async function cleanup() {
  const seller = await prisma.seller.findUnique({ where: { shopDomain: SHOP } });
  if (seller) {
    const orders = await prisma.order.findMany({ where: { sellerId: seller.id }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.paymentEvent.deleteMany({ where: { payment: { sellerId: seller.id } } });
    await prisma.paymentAttempt.deleteMany({ where: { payment: { sellerId: seller.id } } });
    await prisma.wholesalePayment.deleteMany({ where: { sellerId: seller.id } });
    await prisma.shippingQuote.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: ids } } } });
    await prisma.shipment.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderPackage.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.fulfillmentRequest.deleteMany({ where: { orderId: { in: ids } } });
    // The verdicts this suite seeded for those orders, so a re-run does not
    // inherit a decision it did not make.
    await prisma.addressValidation.deleteMany({ where: { subjectId: { in: ids } } });
    await prisma.order.deleteMany({ where: { sellerId: seller.id } });
    await prisma.sellerPaymentMethod.deleteMany({ where: { sellerId: seller.id } });
    await prisma.sellerBillingSettings.deleteMany({ where: { sellerId: seller.id } });
    await prisma.seller.delete({ where: { id: seller.id } });
  }
  await prisma.integrationState.deleteMany({ where: { key: { in: ["eshipper", "shopify_fulfillment", "stripe"] } } });
  // The dock outlives the orders that referenced it, because the orders are
  // deleted above and the foreign keys are SetNull. Remove the variants (they
  // cascade from their product) and the dock itself last.
  if (dock.productIds.length) {
    await prisma.product.deleteMany({ where: { id: { in: dock.productIds } } });
    dock.productIds = [];
  }
  if (dock.locationIds.length) {
    await prisma.addressValidation.deleteMany({ where: { subjectId: { in: dock.locationIds } } });
    await prisma.pickupLocation.deleteMany({ where: { id: { in: dock.locationIds } } });
    dock.locationIds = [];
  }
  dock.id = null;
  dock.variantId = null;
}

let seq = 0;

/**
 * The dock the goods are collected from, created once for the suite.
 *
 * This suite fetches quotes and books shipments, and since Phase C both of those
 * resolve a real pickup location first: a quote is a price for a parcel leaving
 * a named address, and a booking spends one. Before this, the address came from
 * environment variables and the carrier was told whatever the deploy happened to
 * hold. The dock is created here rather than inline in `makeOrder` because every
 * order in this suite ships from the same place.
 */
const dock = {
  locationIds: [] as string[],
  productIds: [] as string[],
  id: null as string | null,
  variantId: null as string | null,
};

async function ensureDock() {
  if (dock.id && dock.variantId) return { locationId: dock.id, variantId: dock.variantId };

  const location = await prisma.pickupLocation.create({
    data: {
      code: `WS-DOCK-${Date.now()}`,
      name: "Wholesale Verify Dock",
      odooDatabase: "verify_db",
      odooCompanyId: 1,
      odooWarehouseId: 3,
      odooLocationId: 25,
      odooPartnerId: 145,
      contactName: "Dock Receiver",
      contactPhone: "+1 555 0177",
      contactEmail: "ws-dock@example.test",
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
  dock.locationIds.push(location.id);

  /*
   * The dock has to be an address booking will accept, or every check below
   * would stop exercising billing and start exercising the address gate. The
   * verdict is seeded through the gate's own hash so it matches by construction
   * — see scripts/verify-address-fixtures.ts. This suite is about money and
   * shipments; the gate has its own suite.
   */
  await acceptAddress(prisma, "PICKUP", location.id);

  const product = await prisma.product.create({
    data: {
      name: "Wholesale Verify Pillow",
      productCode: `WS-P-${Date.now()}`,
      category: "Verification",
      pickupLocationId: location.id,
    },
  });
  dock.productIds.push(product.id);

  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      sku: "MV-HP-001",
      name: "Hotel Pillow",
      wholesalePrice: 1299,
      suggestedRetailPrice: 4900,
      inventory: 100,
      isDefault: true,
    },
  });

  dock.id = location.id;
  dock.variantId = variant.id;
  return { locationId: location.id, variantId: variant.id };
}

async function makeOrder(sellerId: string, total = 2598) {
  seq++;
  const origin = await ensureDock();
  const order = await prisma.order.create({
    data: {
      sellerId,
      shopifyOrderId: `ws-${seq}`,
      shopifyOrderName: `#WS${seq}`,
      shopifyOrderNumber: seq,
      currency: "CAD",
      customerName: "Retail Customer",
      shippingAddress: JSON.stringify({ name: "Retail Customer", address1: "500 Queen St W", city: "Toronto", province: "ON", zip: "M5V 2T6", country: "CA", residential: true }),
      subtotal: total,
      totalTax: 0,
      totalShipping: 0,
      totalDiscounts: 0,
      totalPrice: total,
      moonvellaSubtotal: total,
      moonvellaTax: 0,
      moonvellaShipping: 0,
      moonvellaDiscounts: 0,
      moonvellaTotal: total,
      paymentStatus: "PAID",
      fulfillmentStatus: "PENDING",
      shopifyCreatedAt: new Date(),
      shopifyUpdatedAt: new Date(),
      supplierReference: `${SHOP}#WS${seq}`,
      items: {
        create: [
          {
            name: "Hotel Pillow",
            sku: "MV-HP-001",
            quantity: 2,
            price: 4900,
            wholesalePrice: 1299,
            totalDiscount: 0,
            shopifyLineItemId: `li${seq}`,
            // The gate reads this to find the dock. A line with no mapping is
            // unbookable by design.
            variantId: origin.variantId,
          },
        ],
      },
      packages: { create: [{ count: 1, length: 40, width: 30, height: 20, weight: 2.5, units: "cm_kg" }] },
      wholesalePayment: { create: { sellerId, amount: total, currency: "CAD", provider: "stripe", status: "REQUIRES_PAYMENT", idempotencyKey: `ws:${seq}` } },
      fulfillmentRequest: { create: {} },
    },
  });

  // The delivery end, ditto. Accepted as it stands: this suite is not testing
  // what happens when it is not.
  await acceptAddress(prisma, "DELIVERY", order.id);
  return order;
}

async function main() {
  // Pinned to simulated mode by run-verify.mjs, and enforced here: this suite
  // must not reach a provider. See scripts/provider-guard.ts.
  forbidProviderCalls("verify-wholesale");
  // Order matters: the guard wraps the real fetch first, and the stub then
  // delegates everything that is not an eShipper URL back through it. So Stripe
  // is still refused, eShipper never leaves the process, and a Stripe URL
  // reaching this point is still a hard failure rather than a stub answer.
  //
  // This suite fetches quotes and BOOKS A SHIPMENT. Pointed at the real test
  // host that spent sandbox credit to assert things like "a duplicate booking
  // does not double-purchase" — a property of our code, not of eShipper.
  const eshipper = installEshipperStub();
  await cleanup();
  const seller = await prisma.seller.create({
    data: {
      shopDomain: SHOP,
      storeName: "Wholesale Test Seller",
      shopDomainFull: SHOP,
      contactEmail: "ws@test.example",
      status: "APPROVED",
      approvedAt: new Date(),
    },
  });

  const settings = await getBillingSettings(seller.id);
  check("billing defaults to MANUAL", settings.mode === "MANUAL" && settings.autoPayEnabled === false);

  const method = await savePaymentMethodFromSetupIntent(seller.id, "sim_seti_1");
  check("payment method saved (tokenized, no raw details)", method.stripePaymentMethodId === "sim_pm_sim_seti_1" && method.last4 === "4242");

  const order1 = await makeOrder(seller.id);

  // Quotes
  const quotes = await getQuotesForOrder(order1.id, actor);
  check("quotes returned", quotes.length === 3, `${quotes.length}`);
  check(
    "quotes came from the stub, not the live provider",
    eshipper.calls.some((c) => c.url.includes("/api/v2/quote")),
    `${eshipper.calls.length} stubbed call(s)`
  );
  const cheapest = [...quotes].sort((a, b) => a.totalAmount - b.totalAmount)[0];
  const fastestKnown = quotes.filter((q) => q.transitDays !== null).sort((a, b) => (a.transitDays! - b.transitDays!))[0];
  const unknown = quotes.find((q) => q.transitDays === null);
  check("cheapest computed", cheapest.carrier === "UPS", cheapest.carrier);
  check("fastest with known estimate is Purolator", fastestKnown.carrier === "Purolator", `${fastestKnown.carrier} ${fastestKnown.transitDays}d`);
  check("unknown estimate present and excluded from fastest", !!unknown && unknown.transitDays === null, unknown?.carrier);

  await selectQuote(order1.id, cheapest.id, actor);

  // Booking blocked before payment
  let blocked = false;
  try {
    await bookShipmentForOrder(order1.id, { quoteId: cheapest.id }, actor);
  } catch (error) {
    blocked = error instanceof Error && error.message.includes("not SUCCEEDED");
  }
  check("booking blocked before payment", blocked);

  // Manual charge (simulated) then verified confirmation
  const charge = await chargeWholesaleOrder(order1.id, { trigger: "MANUAL", actor });
  check("manual charge accepted (processing)", charge.ok && charge.status === "PROCESSING", charge.status);
  const payment = await prisma.wholesalePayment.findUnique({ where: { orderId: order1.id } });
  await applyStripeEvent({
    id: `evt_ws_${order1.id}`,
    type: "payment_intent.succeeded",
    data: { object: { id: payment!.providerPaymentIntentId, metadata: { orderId: order1.id } } },
  });
  const paidOrder = await prisma.order.findUnique({ where: { id: order1.id } });
  check("order paid only after verified event", paidOrder?.wholesalePaymentStatus === "SUCCEEDED");

  // Book + duplicate protection
  const booked = await bookShipmentForOrder(order1.id, { quoteId: cheapest.id }, actor);
  check("shipment booked with tracking", !!booked.shipment.trackingNumber, booked.shipment.trackingNumber ?? "");
  const dup = await bookShipmentForOrder(order1.id, { quoteId: cheapest.id }, actor);
  const shipCount = await prisma.shipment.count({ where: { orderId: order1.id } });
  check("duplicate booking does not double-purchase", shipCount === 1 && dup.shipment.id === booked.shipment.id, `${shipCount} shipment(s)`);

  // Expired quote
  const expired = await prisma.shippingQuote.create({
    data: { orderId: order1.id, carrier: "Test", serviceCode: "X", serviceName: "Expired", totalAmount: 100, expiresAt: new Date(Date.now() - 1000) },
  });
  let expiredBlocked = false;
  try {
    await selectQuote(order1.id, expired.id, actor);
  } catch (error) {
    expiredBlocked = error instanceof Error && error.message.includes("expired");
  }
  check("expired quote cannot be selected", expiredBlocked);

  // Automatic payment limits
  await updateBillingSettings(seller.id, { mode: "AUTOMATIC", autoPayEnabled: true, maxAmountPerOrder: 5000, maxShippingCharge: 100000 });
  const order2 = await makeOrder(seller.id, 2598);
  const autoOk = await chargeWholesaleOrder(order2.id, { trigger: "AUTOMATIC", actor });
  check("automatic charge within limits allowed", autoOk.ok === true, autoOk.status);

  const order3 = await makeOrder(seller.id, 900000);
  const autoHeld = await chargeWholesaleOrder(order3.id, { trigger: "AUTOMATIC", actor });
  check("automatic charge over limit held for review", autoHeld.heldForReview === true && autoHeld.ok === false, autoHeld.error ?? "");

  // Auto payment disabled → refused
  await updateBillingSettings(seller.id, { autoPayEnabled: false });
  const order4 = await makeOrder(seller.id, 1000);
  const autoOff = await chargeWholesaleOrder(order4.id, { trigger: "AUTOMATIC", actor });
  check("automatic charge refused when disabled", autoOff.ok === false && /automatic/i.test(autoOff.error ?? ""), autoOff.error ?? "");

  // Void
  const voided = await voidShipment(booked.shipment.id, actor);
  const voidedRow = await prisma.shipment.findUnique({ where: { id: booked.shipment.id } });
  check("shipment void/cancel recorded", voided.cancelled === true && voidedRow?.status === "CANCELLED");

  await cleanup();
  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
