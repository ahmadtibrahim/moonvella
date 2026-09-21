/**
 * Phase 11 — end-to-end acceptance test.
 *
 * Exercises the real SQLite dev DB through the service layer (no HTTP server,
 * no live providers). Every row created here is removed in `cleanup()`, which
 * runs even when an assertion or the scenario itself fails.
 *
 * Provider-bound paths are exercised only in their clearly-labelled simulated
 * mode (Stripe without STRIPE_SECRET_KEY, eShipper without credentials). No
 * Shopify Admin call, no live charge and no live label purchase is performed.
 */
import { PrismaClient } from "@prisma/client";
import { approveApplication } from "../app/services/application.server";
import { createProduct, addVariant } from "../app/services/products.server";
import { saveVariantPackages, validateVariantPackaging } from "../app/services/packaging.server";
import { intakeOrder } from "../app/services/orderIntake.server";
import {
  getFulfillmentRequest,
  acceptFulfillmentRequest,
  closeFulfillmentRequest,
} from "../app/services/fulfillmentRequest.server";
import {
  createPackingShipment,
  markShipmentPacked,
  addOrderPackage,
  addManualShipment,
  advanceShipment,
} from "../app/services/fulfillment.server";
import { createOrReuseWholesalePayment, applyStripeEvent } from "../app/services/payments.server";
import {
  getBillingSettings,
  savePaymentMethodFromSetupIntent,
  chargeWholesaleOrder,
} from "../app/services/sellerBilling.server";
import { computeRankings } from "../app/services/rankings.server";

const prisma = new PrismaClient();

const suffix = Date.now().toString(36);
const SHOP = `e2e-${suffix}.myshopify.com`;
const OWNER_EMAIL = `e2e-owner-${suffix}@example.com`;
const PRODUCT_SKU = `E2E-${suffix}`;
const SHOPIFY_VARIANT_ID = String(Date.now());
const SHOPIFY_PRODUCT_ID = String(Date.now() + 1);
const ORDER_ID = 800000 + (Date.now() % 100000);

const WHOLESALE = 1299;
const RETAIL = 4900;
const QTY = 2;
const LINE_TAX = 1274;
const LINE_DISCOUNT = 980;
const ORDER_SHIPPING = 1500;
const ORDER_SUBTOTAL = 10800;
const EXPECTED_SUBTOTAL = WHOLESALE * QTY; // 2598
const EXPECTED_SHIPPING = Math.round((ORDER_SHIPPING * RETAIL * QTY) / ORDER_SUBTOTAL); // 1361
const EXPECTED_TOTAL = EXPECTED_SUBTOTAL - LINE_DISCOUNT + LINE_TAX + EXPECTED_SHIPPING; // 4253

const actor = { actorId: "e2e-verify", actorName: "E2E Verify", actorType: "ADMIN_USER" as const };

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

type Payload = Parameters<typeof intakeOrder>[0]["payload"];

function makePayload(): Payload {
  return {
    id: ORDER_ID,
    name: `#E2E${ORDER_ID}`,
    order_number: ORDER_ID,
    email: "e2e-buyer@example.com",
    currency: "CAD",
    financial_status: "paid",
    fulfillment_status: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    customer: { first_name: "E2E", last_name: "Buyer", phone: "+14165550000" },
    shipping_address: {
      name: "E2E Buyer",
      address1: "1 Acceptance Way",
      city: "Toronto",
      province: "ON",
      zip: "M5V1A1",
      country: "CA",
    },
    line_items: [
      {
        id: 1,
        variant_id: SHOPIFY_VARIANT_ID,
        title: "E2E Verify Product",
        sku: PRODUCT_SKU,
        quantity: QTY,
        price: (RETAIL / 100).toFixed(2),
        tax_lines: [{ price: (LINE_TAX / 100).toFixed(2) }],
        discount_allocations: [{ amount: (LINE_DISCOUNT / 100).toFixed(2) }],
      },
      { id: 2, variant_id: "unrelated-variant", title: "Unrelated item", sku: "OTHER", quantity: 1, price: "10.00" },
    ],
    subtotal_price: (ORDER_SUBTOTAL / 100).toFixed(2),
    total_tax: (LINE_TAX / 100).toFixed(2),
    total_discounts: (LINE_DISCOUNT / 100).toFixed(2),
    total_shipping_price_set: { shop_money: { amount: (ORDER_SHIPPING / 100).toFixed(2) } },
    refunds: [],
  } as Payload;
}

async function auditCount(action: string, entityId: string): Promise<number> {
  return prisma.auditLog.count({ where: { action, entityId } });
}

async function cleanup() {
  const seller = await prisma.seller.findUnique({ where: { shopDomain: SHOP }, select: { id: true } });
  const sellerId = seller?.id ?? null;
  const orders = await prisma.order.findMany({
    where: { seller: { shopDomain: SHOP } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  const payments = await prisma.wholesalePayment.findMany({
    where: { seller: { shopDomain: SHOP } },
    select: { id: true },
  });
  const paymentIds = payments.map((p) => p.id);
  const product = await prisma.product.findUnique({ where: { sku: PRODUCT_SKU }, select: { id: true } });
  const application = await prisma.merchantApplication.findUnique({
    where: { shopDomain: SHOP },
    select: { id: true },
  });

  if (paymentIds.length) {
    await prisma.paymentEvent.deleteMany({ where: { paymentId: { in: paymentIds } } });
    await prisma.paymentAttempt.deleteMany({ where: { paymentId: { in: paymentIds } } });
  }
  if (sellerId) {
    await prisma.wholesalePayment.deleteMany({ where: { sellerId } });
    await prisma.sellerPaymentMethod.deleteMany({ where: { sellerId } });
    await prisma.sellerBillingSettings.deleteMany({ where: { sellerId } });
    await prisma.sellerBankAccount.deleteMany({ where: { sellerId } });
  }
  if (orderIds.length) {
    await prisma.shippingQuote.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.refundItem.deleteMany({ where: { refund: { orderId: { in: orderIds } } } });
    await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: orderIds } } } });
    await prisma.shipment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderPackage.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.fulfillmentRequest.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  if (sellerId) {
    await prisma.sellerProductVariant.deleteMany({ where: { sellerProduct: { sellerId } } });
    await prisma.sellerProduct.deleteMany({ where: { sellerId } });
    await prisma.seller.deleteMany({ where: { id: sellerId } });
  }
  if (application?.id) {
    await prisma.merchantApplication.deleteMany({ where: { id: application.id } });
  }
  await prisma.adminUser.deleteMany({ where: { email: OWNER_EMAIL } });
  await prisma.webhookEvent.deleteMany({ where: { shopDomain: SHOP } });
  if (product?.id) {
    await prisma.product.deleteMany({ where: { id: product.id } });
  }

  // Audit rows are deliberately NOT deleted, and could not be: the AuditLog
  // table is append-only at the database level, enforced by the trigger
  // AuditLog_append_only, which raises restrict_violation on any DELETE or
  // UPDATE. This harness therefore leaves its audit rows behind. That is the
  // intended behaviour of the table, not a leak: the rows carry the test
  // entity ids and are attributable to this run.
  await prisma.integrationState.deleteMany({
    where: { key: { in: ["shopify_orders", "stripe", "shopify_fulfillment"] } },
  });
}

async function main() {
  // ---- (a) application approval -------------------------------------------
  const owner = await prisma.adminUser.create({
    data: { email: OWNER_EMAIL, passwordHash: "e2e-not-a-real-hash", name: "E2E Owner", role: "OWNER", isActive: true },
  });
  const application = await prisma.merchantApplication.create({
    data: {
      shopDomain: SHOP,
      storeName: "E2E Verify Seller",
      contactName: "E2E Contact",
      email: `contact-${suffix}@example.com`,
      legalBusinessName: "E2E Verify Inc.",
      sellerAddress: "1 Acceptance Way, Toronto, ON",
      productCategory: "Bedding",
      markets: JSON.stringify(["Ontario"]),
      status: "PENDING",
      submittedAt: new Date(),
    },
  });

  const approved = await approveApplication(application.id, {
    actorType: "ADMIN_USER",
    actorId: owner.id,
    actorName: "E2E Owner",
  });
  const appRow = await prisma.merchantApplication.findUnique({ where: { id: application.id } });
  check(
    "application APPROVED with reviewer + timestamp",
    appRow?.status === "APPROVED" && !!appRow?.reviewedAt && appRow?.reviewedById === owner.id,
    `${appRow?.status}`
  );
  check(
    "seller created APPROVED and linked to application",
    approved.seller.status === "APPROVED" && approved.seller.applicationId === application.id,
    approved.seller.status
  );
  check(
    "audit row for application.approved",
    (await auditCount("application.approved", application.id)) >= 1
  );
  const seller = approved.seller;

  // ---- (b) product + variant + packaging ----------------------------------
  const product = await createProduct(
    {
      name: "E2E Verify Product",
      description: "Created by verify-e2e",
      category: "Bedding",
      sku: PRODUCT_SKU,
      wholesalePrice: WHOLESALE / 100,
      suggestedRetailPrice: RETAIL / 100,
      costPrice: 8,
    },
    actor
  );
  const variant = await addVariant(
    product.id,
    {
      name: "Standard",
      sku: `${PRODUCT_SKU}-STD`,
      wholesalePrice: WHOLESALE / 100,
      suggestedRetailPrice: RETAIL / 100,
      costPrice: 8,
      inventory: 50,
      weight: 900,
    },
    actor
  );
  await saveVariantPackages(variant.id, [
    {
      label: "Carton",
      packageType: "carton",
      length: 40,
      width: 30,
      height: 20,
      dimensionUnit: "cm",
      grossWeight: 2.5,
      weightUnit: "kg",
      unitsPerPackage: 1,
      packagesPerUnit: 1,
    },
  ]);

  const productRow = await prisma.product.findUnique({ where: { id: product.id } });
  const variantRow = await prisma.productVariant.findUnique({ where: { id: variant.id } });
  const packaging = await validateVariantPackaging(variant.id);
  check("product persisted with expected price", productRow?.wholesalePrice === WHOLESALE, String(productRow?.wholesalePrice));
  check("variant persisted", variantRow?.sku === `${PRODUCT_SKU}-STD`, variantRow?.sku);
  check("variant packaging persisted + complete", packaging.complete && packaging.packageCount === 1, JSON.stringify(packaging.missing));
  check("audit row for product.created", (await auditCount("product.created", product.id)) >= 1);
  check("audit row for product.variant_added", (await auditCount("product.variant_added", product.id)) >= 1);

  // ---- (c) order webhook intake -------------------------------------------
  const sellerProduct = await prisma.sellerProduct.create({
    data: {
      sellerId: seller.id,
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
      shopifyVariantId: SHOPIFY_VARIANT_ID,
      shopifyLocationId: "1",
      syncStatus: "SUCCESS",
      syncedAt: new Date(),
    },
  });

  const intake = await intakeOrder({ topic: "ORDERS_CREATE", shop: SHOP, payload: makePayload() });
  check("intake created a supplier order", intake.ok === true && !!intake.orderId, JSON.stringify(intake));

  const order = await prisma.order.findUnique({
    where: { supplierReference: `${SHOP}#${ORDER_ID}` },
    include: { items: true, fulfillmentRequest: true, wholesalePayment: true },
  });
  check("Order + single MoonVella OrderItem created", order?.items.length === 1, `${order?.items.length} item(s)`);
  check("Order money computed from cost snapshot", order?.moonvellaSubtotal === EXPECTED_SUBTOTAL, String(order?.moonvellaSubtotal));
  check("Order shipping/tax/discount allocated", order?.moonvellaShipping === EXPECTED_SHIPPING && order?.moonvellaTax === LINE_TAX && order?.moonvellaDiscounts === LINE_DISCOUNT, `${order?.moonvellaShipping}/${order?.moonvellaTax}/${order?.moonvellaDiscounts}`);
  check("Order moonvellaTotal computed", order?.moonvellaTotal === EXPECTED_TOTAL, `${order?.moonvellaTotal} vs ${EXPECTED_TOTAL}`);
  check("FulfillmentRequest created PENDING", order?.fulfillmentRequest?.status === "PENDING", order?.fulfillmentRequest?.status ?? "null");
  check("WholesalePayment created REQUIRES_PAYMENT", order?.wholesalePayment?.status === "REQUIRES_PAYMENT", order?.wholesalePayment?.status ?? "null");
  check("audit row for order.intaken", !!order && (await auditCount("order.intaken", order.id)) >= 1);
  const webhook = await prisma.webhookEvent.findFirst({ where: { shopDomain: SHOP, topic: "ORDERS_CREATE" } });
  check("WebhookEvent recorded SUCCESS", webhook?.status === "SUCCESS", webhook?.status ?? "null");
  if (!order) throw new Error("Order was not created; cannot continue.");

  // ---- (d) fulfillment request transitions --------------------------------
  const pending = await getFulfillmentRequest(order.id);
  check("getFulfillmentRequest returns PENDING", pending?.status === "PENDING", pending?.status ?? "null");
  const accepted = await acceptFulfillmentRequest(order.id, actor);
  check("fulfillment request ACCEPTED with timestamp", accepted.status === "ACCEPTED" && !!accepted.acceptedAt);
  const closed = await closeFulfillmentRequest(order.id, actor);
  check("fulfillment request CLOSED with timestamp", closed.status === "CLOSED" && !!closed.closedAt);
  check("audit rows for accept + close", (await auditCount("fulfillment_request.accepted", order.id)) >= 1 && (await auditCount("fulfillment_request.closed", order.id)) >= 1);

  // ---- (e, part 1) packing ------------------------------------------------
  const orderItem = order.items[0];
  const packing = await createPackingShipment(order.id, [{ orderItemId: orderItem.id, quantity: QTY }], actor);
  check("packing Shipment created PENDING", packing.status === "PENDING", packing.status);
  check("packing ShipmentItem allocated", (await prisma.shipmentItem.count({ where: { shipmentId: packing.id } })) === 1);
  const packed = await markShipmentPacked(packing.id, actor);
  check("packing Shipment packedAt stamped", !!packed.packedAt);
  const orderPackage = await addOrderPackage(order.id, { count: 1, length: 40, width: 30, height: 20, weight: 2.5 }, actor);
  check("OrderPackage row recorded", orderPackage.length === 40 && orderPackage.weight === 2.5, `${orderPackage.length}/${orderPackage.weight}`);
  check("audit rows for packing mutations", (await auditCount("shipment.packing_created", packing.id)) >= 1 && (await auditCount("shipment.packed", packing.id)) >= 1 && (await auditCount("order.package_added", order.id)) >= 1);

  // ---- (f) simulated payment ----------------------------------------------
  const settings = await getBillingSettings(seller.id);
  check("billing settings default MANUAL", settings.mode === "MANUAL" && settings.autoPayEnabled === false);
  const method = await savePaymentMethodFromSetupIntent(seller.id, `sim_seti_${suffix}`, { actorId: "e2e", actorName: "E2E" });
  check("simulated payment method saved (tokenized)", method.last4 === "4242" && method.stripePaymentMethodId === `sim_pm_sim_seti_${suffix}`, method.stripePaymentMethodId ?? "null");
  const reused = await createOrReuseWholesalePayment(order.id);
  check("createOrReuseWholesalePayment (simulated) returns invoice", reused.amount === EXPECTED_SUBTOTAL && reused.status === "REQUIRES_PAYMENT", `${reused.amount}/${reused.status}`);
  const charge = await chargeWholesaleOrder(order.id, { trigger: "MANUAL", actor });
  check("manual simulated charge accepted PROCESSING", charge.ok === true && charge.status === "PROCESSING", `${charge.status}${charge.error ? ` (${charge.error})` : ""}`);
  const afterCharge = await prisma.wholesalePayment.findUnique({ where: { orderId: order.id } });
  check("WholesalePayment PROCESSING after charge", afterCharge?.status === "PROCESSING", afterCharge?.status ?? "null");
  check("PaymentAttempt recorded", afterCharge ? (await prisma.paymentAttempt.count({ where: { paymentId: afterCharge.id } })) === 1 : false);
  check("audit row for payment.charge_succeeded", afterCharge ? (await auditCount("payment.charge_succeeded", afterCharge.id)) >= 1 : false);

  const applied = await applyStripeEvent({
    id: `evt_e2e_${suffix}`,
    type: "payment_intent.succeeded",
    data: { object: { id: afterCharge?.providerPaymentIntentId ?? `sim_${order.id}`, metadata: { orderId: order.id } } },
  });
  check("simulated Stripe event applied", applied.matched === true && applied.status === "SUCCEEDED", JSON.stringify(applied));
  const afterPay = await prisma.wholesalePayment.findUnique({ where: { orderId: order.id } });
  const orderPaid = await prisma.order.findUnique({ where: { id: order.id } });
  check("WholesalePayment SUCCEEDED with paidAt", afterPay?.status === "SUCCEEDED" && !!afterPay?.paidAt, afterPay?.status ?? "null");
  check("Order wholesalePaymentStatus SUCCEEDED", orderPaid?.wholesalePaymentStatus === "SUCCEEDED", orderPaid?.wholesalePaymentStatus ?? "null");
  check("audit row for payment.succeeded", afterPay ? (await auditCount("payment.succeeded", afterPay.id)) >= 1 : false);

  // ---- (e, part 2) manual shipment + status advance -----------------------
  const manual = await addManualShipment(
    order.id,
    { carrier: "Canada Post", trackingNumber: `E2E-${suffix}` },
    actor
  );
  check("manual Shipment created SHIPPED with tracking", manual.shipment.status === "SHIPPED" && !!manual.shipment.trackingNumber, manual.shipment.trackingNumber ?? "null");
  check("manual Shipment packedAt stamped", !!manual.shipment.packedAt);
  check("manual ShipmentItem allocated", (await prisma.shipmentItem.count({ where: { shipmentId: manual.shipment.id } })) === 1);
  const advanced = await advanceShipment(manual.shipment.id, "delivered", actor);
  check("Shipment advanced to DELIVERED", advanced.status === "DELIVERED" && !!advanced.deliveredAt, advanced.status);
  const orderDelivered = await prisma.order.findUnique({ where: { id: order.id } });
  check("Order fulfillmentStatus DELIVERED", orderDelivered?.fulfillmentStatus === "DELIVERED", orderDelivered?.fulfillmentStatus ?? "null");
  check("audit rows for shipment.created + shipment.delivered", (await auditCount("shipment.created", manual.shipment.id)) >= 1 && (await auditCount("shipment.delivered", manual.shipment.id)) >= 1);

  // ---- (g) rankings --------------------------------------------------------
  const from = new Date(Date.now() - 30 * 86400000);
  const to = new Date(Date.now() + 60000);
  const rankings = await computeRankings(from, to, "CAD", { all: true });
  const row = rankings.rows.find((r) => r.sellerId === seller.id);
  check("seller appears in rankings", !!row);
  check("ranking retail sales = 9800", row?.retailSales === RETAIL * QTY, String(row?.retailSales));
  check("ranking wholesale revenue = 2598", row?.wholesaleRevenue === EXPECTED_SUBTOTAL, String(row?.wholesaleRevenue));
  check("ranking paid orders = 1", row?.paidOrders === 1, String(row?.paidOrders));
  check("ranking units sold = 2", row?.unitsSold === QTY, String(row?.unitsSold));
  check("ranking hasHistory set", row?.hasHistory === true);

  // ---- (h) integration state ----------------------------------------------
  const ordersState = await prisma.integrationState.findUnique({ where: { key: "shopify_orders" } });
  const stripeState = await prisma.integrationState.findUnique({ where: { key: "stripe" } });
  const fulfillmentState = await prisma.integrationState.findUnique({ where: { key: "shopify_fulfillment" } });
  check("IntegrationState shopify_orders HEALTHY", ordersState?.status === "HEALTHY", ordersState?.status ?? "null");
  check("IntegrationState stripe HEALTHY", stripeState?.status === "HEALTHY", stripeState?.status ?? "null");
  check("IntegrationState shopify_fulfillment recorded (local-only)", fulfillmentState?.status === "NOT_CONFIGURED", fulfillmentState?.status ?? "null");
}

main()
  .catch((error) => {
    check("scenario completed without throwing", false, error instanceof Error ? error.message : String(error));
    console.error(error);
  })
  .finally(async () => {
    try {
      await cleanup();
    } catch (error) {
      console.error("cleanup failed:", error);
    }
    console.log(`\n=== ${total - failures}/${total} checks passed ===`);
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  });
