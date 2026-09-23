import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  createOrReuseWholesalePayment,
  applyStripeEvent,
  verifyStripeSignature,
} from "../app/services/payments.server";
import { addManualShipment, advanceShipment } from "../app/services/fulfillment.server";
import { forbidProviderCalls } from "./provider-guard";

const prisma = new PrismaClient();
const SHOP = "pay-test.myshopify.com";
let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function cleanup() {
  const seller = await prisma.seller.findUnique({ where: { shopDomain: SHOP } });
  if (seller) {
    const orders = await prisma.order.findMany({ where: { sellerId: seller.id }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await prisma.paymentEvent.deleteMany({ where: { payment: { sellerId: seller.id } } });
    await prisma.wholesalePayment.deleteMany({ where: { sellerId: seller.id } });
    await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: ids } } } });
    await prisma.shipment.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
    await prisma.order.deleteMany({ where: { sellerId: seller.id } });
    await prisma.seller.delete({ where: { id: seller.id } });
  }
  await prisma.integrationState.deleteMany({ where: { key: { in: ["stripe", "shopify_fulfillment"] } } });
}

async function main() {
  // Pinned to simulated mode by run-verify.mjs, and enforced here: this suite
  // must not reach a provider. See scripts/provider-guard.ts.
  forbidProviderCalls("verify-payments");
  await cleanup();
  const seller = await prisma.seller.create({
    data: {
      shopDomain: SHOP,
      storeName: "Pay Test Seller",
      shopDomainFull: SHOP,
      contactEmail: "pay@test.example",
      status: "APPROVED",
      approvedAt: new Date(),
    },
  });
  const order = await prisma.order.create({
    data: {
      sellerId: seller.id,
      shopifyOrderId: "pay-1",
      shopifyOrderName: "#PAY1",
      shopifyOrderNumber: 1,
      currency: "CAD",
      subtotal: 9800,
      totalTax: 0,
      totalShipping: 0,
      totalDiscounts: 0,
      totalPrice: 9800,
      moonvellaSubtotal: 2598,
      moonvellaTax: 0,
      moonvellaShipping: 0,
      moonvellaDiscounts: 0,
      moonvellaTotal: 2598,
      paymentStatus: "PAID",
      fulfillmentStatus: "PENDING",
      shopifyCreatedAt: new Date(),
      shopifyUpdatedAt: new Date(),
      supplierReference: `${SHOP}#PAY1`,
      items: {
        create: [{ name: "Pillow", sku: "MV-HP-001", quantity: 2, price: 4900, wholesalePrice: 1299, totalDiscount: 0, shopifyLineItemId: "li1" }],
      },
    },
  });

  const payment = await createOrReuseWholesalePayment(order.id);
  check("created wholesale payment (simulated)", payment.status === "REQUIRES_PAYMENT", payment.status);

  // Fulfillment held before payment
  let held = false;
  try {
    await addManualShipment(order.id, { carrier: "Canada Post", trackingNumber: "T1" }, { actorId: "test" });
  } catch (error) {
    held = error instanceof Error && error.message.includes("held");
  }
  check("fulfillment held before wholesale payment", held);

  // Simulated success event
  const eventId = "evt_pay_test_1";
  const applied = await applyStripeEvent({
    id: eventId,
    type: "payment_intent.succeeded",
    data: { object: { id: payment.providerPaymentIntentId, metadata: { orderId: order.id } } },
  });
  const afterPay = await prisma.order.findUnique({ where: { id: order.id } });
  check("payment event applied", applied.matched === true && applied.status === "SUCCEEDED");
  check("order wholesale status SUCCEEDED", afterPay?.wholesalePaymentStatus === "SUCCEEDED", afterPay?.wholesalePaymentStatus);

  // Duplicate charge protection
  const dup = await applyStripeEvent({
    id: eventId,
    type: "payment_intent.succeeded",
    data: { object: { id: payment.providerPaymentIntentId, metadata: { orderId: order.id } } },
  });
  const eventCount = await prisma.paymentEvent.count({ where: { eventId } });
  check("duplicate payment event deduped", dup.duplicate === true && eventCount === 1, `${eventCount} event(s)`);

  // Shipment after payment
  const { shipment } = await addManualShipment(
    order.id,
    { carrier: "Canada Post", trackingNumber: "TRACK123" },
    { actorId: "test", actorName: "Test" }
  );
  const orderShipped = await prisma.order.findUnique({ where: { id: order.id } });
  check("shipment created with tracking", shipment.trackingNumber === "TRACK123" && !!shipment.trackingUrl, shipment.trackingUrl ?? "");
  check("order marked SHIPPED", orderShipped?.fulfillmentStatus === "SHIPPED", orderShipped?.fulfillmentStatus);

  await advanceShipment(shipment.id, "delivered", { actorId: "test" });
  const orderDelivered = await prisma.order.findUnique({ where: { id: order.id } });
  const shipDelivered = await prisma.shipment.findUnique({ where: { id: shipment.id } });
  check("delivery is a separate event", shipDelivered?.status === "DELIVERED" && !!shipDelivered?.deliveredAt && orderDelivered?.fulfillmentStatus === "DELIVERED");

  // Signature verification
  const secret = "whsec_test_secret";
  const payload = JSON.stringify({ id: "evt_sig", type: "payment_intent.succeeded" });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  check("valid Stripe signature accepted", verifyStripeSignature(payload, `t=${t},v1=${sig}`, secret).valid === true);
  check("tampered Stripe signature rejected", verifyStripeSignature(payload + "x", `t=${t},v1=${sig}`, secret).valid === false);
  check("missing secret rejected", verifyStripeSignature(payload, `t=${t},v1=${sig}`, undefined).valid === false);

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
