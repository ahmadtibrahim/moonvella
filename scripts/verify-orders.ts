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
// The historical-money section sends several updates to one order, so each
// needs its own `updated_at`: that is the version the webhook dedup keys on.
const T3 = new Date(Date.now() - 45_000).toISOString();
const T4 = new Date(Date.now() - 30_000).toISOString();
const T5 = new Date(Date.now() - 15_000).toISOString();

/**
 * A product of this suite's own, for the checks that reprice a catalogue.
 *
 * Those checks need a wholesale price they can move. Moving one on the shared
 * seed catalogue would reach outside this suite: every other suite leans on
 * that catalogue, and a restore is not a fix — a run killed between the
 * repricing and its cleanup would leave the seed changed, and an UPDATE moves
 * the row in the heap, so even a correct restore has to be done by id rather
 * than by re-finding "the first variant". A product created here has none of
 * that: nothing else refers to it, and `cleanup()` removes it.
 */
const D2_CODE = "MV-OT-D2";
const D2_SKU = "MV-OT-D2-1";
const D2_VARIANT_ID = 222222;

async function cleanup() {
  const seller = await prisma.seller.findUnique({ where: { shopDomain: SHOP } });
  if (seller) {
    const orders = await prisma.order.findMany({ where: { sellerId: seller.id }, select: { id: true } });
    const orderIds = orders.map((o) => o.id);
    /*
     * The order.intaken, order.updated and order.money_updated audit rows are
     * left behind, as they always have been here: AuditLog is append-only by
     * database trigger, so a delete would raise rather than tidy anything. Rows
     * pointing at a removed fixture are the price of a trail that cannot be
     * edited, and this suite pays it rather than asking for an exemption.
     */
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

  /*
   * The repricing fixture, removed rather than reset. Its code is fixed, so a
   * run killed before it could tidy up is swept by the next one's opening
   * cleanup instead of leaving a product behind. Nothing outside this suite
   * refers to it, which is the point: the historical-money checks need a
   * wholesale price they can move, and moving one on the shared seed catalogue
   * would reach into every other suite in the run.
   */
  const d2ProductIds = (
    await prisma.product.findMany({ where: { productCode: D2_CODE }, select: { id: true } })
  ).map((row) => row.id);
  if (d2ProductIds.length > 0) {
    await prisma.sellerProductVariant.deleteMany({ where: { productVariant: { productId: { in: d2ProductIds } } } });
    await prisma.sellerProduct.deleteMany({ where: { productId: { in: d2ProductIds } } });
    await prisma.productVariant.deleteMany({ where: { productId: { in: d2ProductIds } } });
    await prisma.product.deleteMany({ where: { id: { in: d2ProductIds } } });
  }
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
  /*
   * THE SELLER'S BILL SAYS WHAT IT IS MADE OF.
   *
   * These three figures existed as columns and were never written, so a bill was
   * an amount with no parts — and the shipping the seller owed was invisible on
   * the record until the shipment reconciliation happened to show it. The
   * shipping figure is the SELLER'S OWN charge (the Shopify shipping lines scaled
   * to MoonVella's share, the same 1361 the order carries), deliberately not the
   * carrier's cost: what the carrier charges MoonVella is not the seller's bill.
   *
   * `amount` is asserted unchanged alongside them. It is what the seller pays;
   * filling in the breakdown must not move the total.
   */
  check(
    "the seller's bill records its shipping line from the seller's own charge, never the carrier's",
    order?.wholesalePayment?.shippingAmount === order?.moonvellaShipping &&
      order?.wholesalePayment?.shippingAmount === 1361,
    `payment=${order?.wholesalePayment?.shippingAmount} order=${order?.moonvellaShipping}`,
  );
  check(
    "and its subtotal and tax, with the amount it charges unchanged",
    order?.wholesalePayment?.subtotal === order?.moonvellaSubtotal &&
      order?.wholesalePayment?.taxAmount === order?.moonvellaTax &&
      order?.wholesalePayment?.amount === order?.moonvellaSubtotal,
    `subtotal=${order?.wholesalePayment?.subtotal} tax=${order?.wholesalePayment?.taxAmount} amount=${order?.wholesalePayment?.amount}`,
  );
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

  /* ------------------------------------------------------------------------ */
  /* Historical money: a catalogue change does not reach back into an order    */
  /* ------------------------------------------------------------------------ */
  /*
   * What this half proves. The wholesale price on a line is a snapshot of what
   * the seller was charged, so repricing the catalogue must not reprice an
   * order that already exists — while a line that genuinely arrives afterwards
   * does take the price in force now. And once the seller has been charged, the
   * money on the order stops moving altogether: a difference is computed and
   * recorded as unbilled, and nothing is rewritten behind the invoice.
   *
   * The repricing happens on a product created here, never on the seed
   * catalogue — the catalogue is shared with every other suite in the run.
   */
  const d2Product = await prisma.product.create({
    data: {
      name: "Order historical money (verify fixture)",
      productCode: D2_CODE,
      category: "Test",
      currency: "CAD",
      variants: {
        create: [{ name: "One size", sku: D2_SKU, wholesalePrice: 1299, suggestedRetailPrice: 0, isDefault: true }],
      },
    },
    include: { variants: true },
  });
  const d2Variant = d2Product.variants[0];
  const d2Mapping = await prisma.sellerProduct.create({
    data: {
      sellerId: seller.id,
      productId: d2Product.id,
      shopifyProductId: "666666",
      importedAt: new Date(),
      isActive: true,
    },
  });
  await prisma.sellerProductVariant.create({
    data: {
      sellerProductId: d2Mapping.id,
      productVariantId: d2Variant.id,
      shopifyProductId: "666666",
      shopifyVariantId: String(D2_VARIANT_ID),
      shopifyLocationId: "1",
      syncStatus: "SUCCESS",
      syncedAt: new Date(),
    },
  });

  const d2WholesalePrice = d2Variant.wholesalePrice;
  const d2OrderId = await createOrder(seller.id, 9006, D2_VARIANT_ID);
  const d2Line = (id: number, quantity: number) => ({
    id,
    variant_id: D2_VARIANT_ID,
    title: "MoonVella Item",
    sku: D2_SKU,
    quantity,
    price: "49.00",
  });

  const repriced = d2WholesalePrice + 700;
  await prisma.productVariant.update({
    where: { id: d2Variant.id },
    data: { wholesalePrice: repriced },
  });

  await intakeOrder({
    topic: "ORDERS_UPDATED",
    shop: SHOP,
    payload: makePayload(9006, { updated_at: T3, line_items: [d2Line(1, 1), d2Line(5, 2)] }),
  });

  const afterReprice = await prisma.orderItem.findMany({ where: { orderId: d2OrderId } });
  const keptLine = afterReprice.find((i) => i.shopifyLineItemId === "1");
  const newLine = afterReprice.find((i) => i.shopifyLineItemId === "5");
  check(
    "repricing the catalogue does not reprice a line already on the order",
    keptLine?.wholesalePrice === d2WholesalePrice,
    `${keptLine?.wholesalePrice} vs ${d2WholesalePrice} (catalogue now ${repriced})`
  );
  check(
    "a genuinely added line takes the catalogue price in force now",
    newLine?.wholesalePrice === repriced,
    `${newLine?.wholesalePrice} vs ${repriced}`
  );

  const d2Unbilled = await prisma.order.findUnique({ where: { id: d2OrderId } });
  check(
    "an unbilled order's totals follow its lines: the snapshot, plus the new line",
    d2Unbilled?.moonvellaSubtotal === d2WholesalePrice + repriced * 2,
    `${d2Unbilled?.moonvellaSubtotal} vs ${d2WholesalePrice + repriced * 2}`
  );

  const firstMoneyAudit = await prisma.auditLog.findFirst({
    where: { entityType: "Order", entityId: d2OrderId, action: "order.money_updated" },
    orderBy: { createdAt: "desc" },
  });
  const firstMoneyBefore = JSON.parse(firstMoneyAudit?.beforeData ?? "{}");
  const firstMoneyAfter = JSON.parse(firstMoneyAudit?.afterData ?? "{}");
  const origin = (after: { lines?: { id: string; priceSource: string }[] }, id: string) =>
    after.lines?.find((line) => line.id === id)?.priceSource;
  check(
    "the money entry says where each line's price came from",
    firstMoneyAudit !== null &&
      origin(firstMoneyAfter, "1") === "SNAPSHOT" &&
      origin(firstMoneyAfter, "5") === "CATALOGUE",
    `line 1 ${origin(firstMoneyAfter, "1")}, line 5 ${origin(firstMoneyAfter, "5")}`
  );
  check(
    "and it records both sides, so the change can be read without a second query",
    firstMoneyBefore.totals?.moonvellaSubtotal === d2WholesalePrice &&
      firstMoneyAfter.computedTotals?.moonvellaSubtotal === d2WholesalePrice + repriced * 2 &&
      firstMoneyAfter.chargedTotalsKept === false,
    `${firstMoneyBefore.totals?.moonvellaSubtotal} -> ${firstMoneyAfter.computedTotals?.moonvellaSubtotal}`
  );

  /* --- charged: the money stops, the difference is recorded ---------------- */
  await prisma.order.update({
    where: { id: d2OrderId },
    data: { wholesalePaymentStatus: "SUCCEEDED" },
  });
  const chargedBefore = await prisma.order.findUnique({ where: { id: d2OrderId } });

  const repricedAgain = d2WholesalePrice + 1500;
  await prisma.productVariant.update({
    where: { id: d2Variant.id },
    data: { wholesalePrice: repricedAgain },
  });
  await intakeOrder({
    topic: "ORDERS_UPDATED",
    shop: SHOP,
    payload: makePayload(9006, {
      updated_at: T4,
      fulfillment_status: "partial",
      line_items: [d2Line(1, 1), d2Line(5, 2), d2Line(6, 1)],
    }),
  });

  const chargedAfter = await prisma.order.findUnique({
    where: { id: d2OrderId },
    include: { items: true },
  });
  check(
    "a charged order keeps the totals it was charged, though a line was added after it",
    chargedAfter?.moonvellaSubtotal === chargedBefore?.moonvellaSubtotal &&
      chargedAfter?.moonvellaTotal === chargedBefore?.moonvellaTotal,
    `${chargedAfter?.moonvellaTotal} vs charged ${chargedBefore?.moonvellaTotal}`
  );
  check(
    "and everything that is not money still updates, so the order tracks Shopify",
    chargedAfter?.fulfillmentStatus === "PARTIAL" &&
      chargedAfter?.items.length === 3,
    `${chargedAfter?.fulfillmentStatus}, ${chargedAfter?.items.length} items`
  );
  check(
    "the line added after the charge is on the order at the current price, not hidden",
    chargedAfter?.items.find((i) => i.shopifyLineItemId === "6")?.wholesalePrice === repricedAgain,
    `${chargedAfter?.items.find((i) => i.shopifyLineItemId === "6")?.wholesalePrice}`
  );

  const chargedAudit = await prisma.auditLog.findFirst({
    where: { entityType: "Order", entityId: d2OrderId, action: "order.money_updated" },
    orderBy: { createdAt: "desc" },
  });
  const chargedAfter2 = JSON.parse(chargedAudit?.afterData ?? "{}");
  const expectedDifference =
    (chargedAfter2.computedTotals?.moonvellaTotal ?? 0) - (chargedAfter2.totals?.moonvellaTotal ?? 0);
  check(
    "the difference is recorded as unbilled, and equals the gap it reports",
    chargedAudit !== null &&
      chargedAfter2.chargedTotalsKept === true &&
      chargedAfter2.totals?.moonvellaTotal === chargedBefore?.moonvellaTotal &&
      chargedAfter2.unbilledDifference === expectedDifference &&
      expectedDifference > 0,
    `unbilled ${chargedAfter2.unbilledDifference} = ${chargedAfter2.computedTotals?.moonvellaTotal} - ${chargedAfter2.totals?.moonvellaTotal}`
  );
  check(
    "the added line is named, so the difference does not have to be reconstructed",
    chargedAfter2.addedLines?.length === 1 && chargedAfter2.addedLines[0]?.id === "6",
    JSON.stringify(chargedAfter2.addedLines ?? null)
  );

  /* --- and a routine update writes nothing at all -------------------------- */
  const moneyAuditsBefore = await prisma.auditLog.count({
    where: { entityType: "Order", entityId: d2OrderId, action: "order.money_updated" },
  });
  await intakeOrder({
    topic: "ORDERS_UPDATED",
    shop: SHOP,
    payload: makePayload(9006, {
      updated_at: T5,
      financial_status: "paid",
      line_items: [d2Line(1, 1), d2Line(5, 2), d2Line(6, 1)],
    }),
  });
  const moneyAuditsAfter = await prisma.auditLog.count({
    where: { entityType: "Order", entityId: d2OrderId, action: "order.money_updated" },
  });
  check(
    "an update that changes no line and no total writes no money entry",
    moneyAuditsAfter === moneyAuditsBefore,
    `${moneyAuditsBefore} -> ${moneyAuditsAfter}`
  );

  await cleanup();
  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

async function createOrder(sellerId: string, id: number, variantId = 111111): Promise<string> {
  const result = await intakeOrder({
    topic: "ORDERS_CREATE",
    shop: SHOP,
    payload: makePayload(id, {
      line_items: [{ id: 1, variant_id: variantId, title: "MoonVella Item", sku: "MV-TEST", quantity: 1, price: "49.00" }],
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
