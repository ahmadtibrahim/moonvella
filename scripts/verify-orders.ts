import { PrismaClient } from "@prisma/client";
import { intakeOrder } from "../app/services/orderIntake.server";
import {
  getFulfillmentRequest,
  acceptFulfillmentRequest,
  rejectFulfillmentRequest,
  closeFulfillmentRequest,
  cancelFulfillmentRequest,
} from "../app/services/fulfillmentRequest.server";

const prisma = new PrismaClient();
const SHOP = "order-test.myshopify.com";
const actor = { actorId: "verify", actorName: "Verify" };
let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const T0 = new Date(Date.now() - 3 * 60_000).toISOString();
const T1 = new Date(Date.now() - 2 * 60_000).toISOString();
const T2 = new Date(Date.now() - 60_000).toISOString();

async function cleanup() {
  const seller = await prisma.seller.findUnique({ where: { shopDomain: SHOP } });
  if (seller) {
    const orders = await prisma.order.findMany({ where: { sellerId: seller.id }, select: { id: true } });
    const orderIds = orders.map((o) => o.id);
    await prisma.webhookEvent.deleteMany({ where: { shopDomain: SHOP } });
    await prisma.refundItem.deleteMany({ where: { refund: { orderId: { in: orderIds } } } });
    await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.wholesalePayment.deleteMany({ where: { sellerId: seller.id } });
    await prisma.fulfillmentRequest.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { sellerId: seller.id } });
    await prisma.sellerProductVariant.deleteMany({ where: { sellerProduct: { sellerId: seller.id } } });
    await prisma.sellerProduct.deleteMany({ where: { sellerId: seller.id } });
    await prisma.seller.delete({ where: { id: seller.id } });
  }
  await prisma.integrationState.deleteMany({ where: { key: { in: ["shopify_orders", "shopify_fulfillment"] } } });
}

type Payload = Parameters<typeof intakeOrder>[0]["payload"];

function makePayload(id: number, overrides: Partial<Payload> = {}): Payload {
  return {
    id,
    name: `#${id}`,
    order_number: id,
    email: "buyer@example.com",
    currency: "CAD",
    financial_status: "paid",
    fulfillment_status: null,
    created_at: T0,
    updated_at: T0,
    customer: { first_name: "Test", last_name: "Buyer", phone: "+14165550000" },
    shipping_address: { name: "Test Buyer", address1: "1 Test St", city: "Toronto", province: "ON", zip: "M5V1A1", country: "CA" },
    line_items: [
      {
        id: 1,
        variant_id: 111111,
        title: "MoonVella Item",
        sku: "MV-TEST",
        quantity: 2,
        price: "49.00",
        tax_lines: [{ price: "12.74" }],
        discount_allocations: [{ amount: "9.80" }],
      },
      { id: 2, variant_id: 999999, title: "Unrelated item", sku: "OTHER", quantity: 1, price: "10.00" },
    ],
    subtotal_price: "108.00",
    total_tax: "14.04",
    total_discounts: "9.80",
    total_shipping_price_set: { shop_money: { amount: "15.00" } },
    refunds: [],
    ...overrides,
  } as Payload;
}

async function expectThrow(name: string, fn: () => Promise<unknown>) {
  let message = "";
  try {
    await fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check(name, message.length > 0, message);
}

async function main() {
  await cleanup();

  const product = await prisma.product.findFirst({ include: { variants: true } });
  if (!product || product.variants.length === 0) throw new Error("Seed the catalog first (npm run seed-catalog).");
  const variant = product.variants[0];

  const seller = await prisma.seller.create({
    data: {
      shopDomain: SHOP,
      storeName: "Order Test Seller",
      shopDomainFull: SHOP,
      contactEmail: "orders@test.example",
      status: "APPROVED",
      approvedAt: new Date(),
    },
  });
  const sellerProduct = await prisma.sellerProduct.create({
    data: {
      sellerId: seller.id,
      productId: product.id,
      shopifyProductId: "555555",
      importedAt: new Date(),
      isActive: true,
    },
  });
  await prisma.sellerProductVariant.create({
    data: {
      sellerProductId: sellerProduct.id,
      productVariantId: variant.id,
      shopifyProductId: "555555",
      shopifyVariantId: "111111",
      shopifyLocationId: "1",
      syncStatus: "SUCCESS",
      syncedAt: new Date(),
    },
  });

  const wholesale = variant.wholesalePrice;

  // ---- create + dedup -------------------------------------------------------
  const createPayload = makePayload(9001);
  const first = await intakeOrder({ topic: "ORDERS_CREATE", shop: SHOP, payload: createPayload });
  check("intake created a supplier order", first.ok === true && !first.duplicate, JSON.stringify(first));

  const order = await prisma.order.findFirst({
    where: { sellerId: seller.id },
    include: { items: true, fulfillmentRequest: true, wholesalePayment: true },
  });
  check("only MoonVella item entered the workflow", order?.items.length === 1, `${order?.items.length} item(s)`);
  check(
    "wholesale subtotal uses cost snapshot",
    order?.moonvellaSubtotal === wholesale * 2,
    `${order?.moonvellaSubtotal} vs ${wholesale * 2}`
  );
  check("customer payment status captured", order?.paymentStatus === "PAID", order?.paymentStatus);
  check("fulfillment request created PENDING", order?.fulfillmentRequest?.status === "PENDING");
  check("wholesale payment created REQUIRES_PAYMENT", order?.wholesalePayment?.status === "REQUIRES_PAYMENT");
  check("shipping address persisted", !!order?.shippingAddress, order?.shippingAddress ?? "null");
  check("moonvellaTax from line-level tax allocation", order?.moonvellaTax === 1274, `${order?.moonvellaTax}`);
  check("moonvellaDiscounts from line-level discount", order?.moonvellaDiscounts === 980, `${order?.moonvellaDiscounts}`);
  check("moonvellaShipping allocated proportionally", order?.moonvellaShipping === 1361, `${order?.moonvellaShipping}`);
  check(
    "moonvellaTotal includes adjustments",
    order?.moonvellaTotal === wholesale * 2 - 980 + 1274 + 1361,
    `${order?.moonvellaTotal}`
  );

  const second = await intakeOrder({ topic: "ORDERS_CREATE", shop: SHOP, payload: createPayload });
  const orderCount = await prisma.order.count({ where: { sellerId: seller.id } });
  check("duplicate create does not create a second order", second.duplicate === true && orderCount === 1, `${orderCount} order(s)`);

  // ---- update ---------------------------------------------------------------
  const updatePayload = makePayload(9001, {
    updated_at: T1,
    financial_status: "partially_refunded",
    fulfillment_status: "partial",
    subtotal_price: "157.00",
    total_tax: "21.06",
    line_items: [
      {
        id: 1,
        variant_id: 111111,
        title: "MoonVella Item",
        sku: "MV-TEST",
        quantity: 3,
        price: "49.00",
        tax_lines: [{ price: "19.11" }],
        discount_allocations: [{ amount: "9.80" }],
      },
      { id: 2, variant_id: 999999, title: "Unrelated item", sku: "OTHER", quantity: 1, price: "10.00" },
    ],
    refunds: [
      {
        id: 501,
        created_at: T1,
        note: "damaged",
        refund_line_items: [{ line_item_id: 1, quantity: 1, subtotal: "49.00" }],
      },
    ],
  });

  const updated = await intakeOrder({ topic: "ORDERS_UPDATED", shop: SHOP, payload: updatePayload });
  check("update applied to existing order", updated.ok === true && updated.updated === true, JSON.stringify(updated));
  const orderAfterUpdate = await prisma.order.findUnique({
    where: { id: order!.id },
    include: { items: true, refunds: { include: { items: true } } },
  });
  check("line item quantity updated", orderAfterUpdate?.items[0]?.quantity === 3, `${orderAfterUpdate?.items[0]?.quantity}`);
  check("wholesale subtotal updated", orderAfterUpdate?.moonvellaSubtotal === wholesale * 3, `${orderAfterUpdate?.moonvellaSubtotal}`);
  check("moonvellaTax updated", orderAfterUpdate?.moonvellaTax === 1911, `${orderAfterUpdate?.moonvellaTax}`);
  check("financial status updated", orderAfterUpdate?.paymentStatus === "PARTIALLY_REFUNDED", orderAfterUpdate?.paymentStatus);
  check("fulfillment status updated", orderAfterUpdate?.fulfillmentStatus === "PARTIAL", orderAfterUpdate?.fulfillmentStatus);
  check("refund recorded", orderAfterUpdate?.refunds.length === 1, `${orderAfterUpdate?.refunds.length} refund(s)`);
  check("refund item linked to order item", orderAfterUpdate?.refunds[0]?.items[0]?.quantity === 1);
  check("refund amount in cents", orderAfterUpdate?.refunds[0]?.amount === 4900, `${orderAfterUpdate?.refunds[0]?.amount}`);

  const duplicateUpdate = await intakeOrder({ topic: "ORDERS_UPDATED", shop: SHOP, payload: updatePayload });
  check("duplicate update deduped", duplicateUpdate.duplicate === true);

  // ---- cancel ---------------------------------------------------------------
  const cancelPayload = makePayload(9001, { updated_at: T2, cancelled_at: T2, cancel_reason: "customer" });
  const cancelled = await intakeOrder({ topic: "ORDERS_CANCELLED", shop: SHOP, payload: cancelPayload });
  check("cancel applied", cancelled.ok === true && cancelled.cancelled === 1, JSON.stringify(cancelled));
  const orderAfterCancel = await prisma.order.findUnique({
    where: { id: order!.id },
    include: { items: true, refunds: true, fulfillmentRequest: true },
  });
  check("order marked cancelled", !!orderAfterCancel?.cancelledAt && orderAfterCancel?.fulfillmentStatus === "CANCELLED");
  check("cancel reason stored", orderAfterCancel?.cancelReason === "customer", orderAfterCancel?.cancelReason ?? "null");
  check("open fulfillment request cancelled", orderAfterCancel?.fulfillmentRequest?.status === "CANCELLED", orderAfterCancel?.fulfillmentRequest?.status);
  check("cancel keeps order history", orderAfterCancel?.items.length === 1 && orderAfterCancel?.refunds.length === 1);

  // ---- fulfillment request transitions -------------------------------------
  const acceptOrderId = await createOrder(seller.id, 9002);
  const pending = await getFulfillmentRequest(acceptOrderId);
  check("getFulfillmentRequest returns PENDING", pending?.status === "PENDING");

  const accepted = await acceptFulfillmentRequest(acceptOrderId, actor);
  check("accept sets ACCEPTED + timestamp", accepted.status === "ACCEPTED" && !!accepted.acceptedAt);
  await expectThrow("cannot accept twice", () => acceptFulfillmentRequest(acceptOrderId, actor));
  await expectThrow("cannot reject after accept", () => rejectFulfillmentRequest(acceptOrderId, "late", actor));

  const closed = await closeFulfillmentRequest(acceptOrderId, actor);
  check("close sets CLOSED + timestamp", closed.status === "CLOSED" && !!closed.closedAt);
  await expectThrow("cannot close twice", () => closeFulfillmentRequest(acceptOrderId, actor));
  await expectThrow("cannot cancel after close", () => cancelFulfillmentRequest(acceptOrderId, "too late", actor));

  const rejectOrderId = await createOrder(seller.id, 9003);
  await expectThrow("reject requires a reason", () => rejectFulfillmentRequest(rejectOrderId, "   ", actor));
  const rejected = await rejectFulfillmentRequest(rejectOrderId, "out of stock", actor);
  check(
    "reject sets REJECTED + reason + timestamp",
    rejected.status === "REJECTED" && rejected.rejectReason === "out of stock" && !!rejected.rejectedAt
  );
  await expectThrow("cannot accept after reject", () => acceptFulfillmentRequest(rejectOrderId, actor));

  const cancelOrderId = await createOrder(seller.id, 9004);
  const requestCancelled = await cancelFulfillmentRequest(cancelOrderId, "merchant withdrew", actor);
  check("cancel sets CANCELLED + timestamp", requestCancelled.status === "CANCELLED" && !!requestCancelled.closedAt);
  await expectThrow("cannot accept after cancel", () => acceptFulfillmentRequest(cancelOrderId, actor));

  await expectThrow("missing request throws", () => acceptFulfillmentRequest("does-not-exist", actor));

  // ---- no MoonVella items ---------------------------------------------------
  const noItems = await intakeOrder({
    topic: "ORDERS_CREATE",
    shop: SHOP,
    payload: makePayload(9005, {
      line_items: [{ id: 3, variant_id: 999999, quantity: 1, price: "5.00" }],
    }),
  });
  check("order with no MoonVella items creates no supplier order", noItems.ok === true && noItems.moonvellaItems === 0);

  await cleanup();
  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

async function createOrder(sellerId: string, id: number): Promise<string> {
  const result = await intakeOrder({
    topic: "ORDERS_CREATE",
    shop: SHOP,
    payload: makePayload(id, {
      line_items: [{ id: 1, variant_id: 111111, title: "MoonVella Item", sku: "MV-TEST", quantity: 1, price: "49.00" }],
    }),
  });
  const order = await prisma.order.findFirst({ where: { sellerId, shopifyOrderId: String(id) }, select: { id: true } });
  if (!order) throw new Error(`Order ${id} was not created (${JSON.stringify(result)})`);
  return order.id;
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
