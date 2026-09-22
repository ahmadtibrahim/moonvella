/**
 * BLOCKED, as a real seller status.
 *
 * WHAT THIS SUITE IS FOR. Blocking is not a louder deactivation, and the whole
 * risk of adding it is that it quietly becomes one: a status that reads as a
 * refusal while the store still sees prices, still imports, still syncs, still
 * takes orders. Every check below aims at that gap, and they are grouped by the
 * promise each one tests rather than by the function it calls.
 *
 * WHY IT ASSERTS ON FOUR BOOLEANS. `resolveSellerContext` is the single place
 * the merchant application asks what a store may do — every merchant route
 * reads `canViewWholesale`, `canImport`, `canViewOrders` and
 * `canStartNewBusiness` and decides from those four values alone. Asserting the
 * four flags for a blocked store is therefore asserting pricing, importing,
 * order history and product sync at once, at the point every screen reads them,
 * rather than screen by screen at a level this suite cannot reach (the merchant
 * routes need a live Shopify session to sign in with).
 *
 * WHAT IT DOES NOT DO. It contacts no external service, and it does not test
 * the admin interface — that is `verify-stores-ui.ts`, over HTTP. The order
 * fixture here goes straight to `intakeOrder`, which is the same function the
 * webhook calls, minus the delivery.
 *
 * IT CREATES ROWS. Everything it makes goes in `cleanup()`, which runs even
 * when a check throws. Its audit rows are not removed: AuditLog is append-only
 * at the database level and this suite does not ask for an exemption.
 *
 * Usage, inside the app image:
 *   node scripts/run-verify.mjs scripts/verify-seller-block.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  BLOCKED_MESSAGE,
  getSellerDetail,
  resolveSellerContext,
} from "~/services/seller.server";
import {
  blockSeller,
  suspendSeller,
  unblockSeller,
} from "~/services/application.server";
import { intakeOrder } from "~/services/orderIntake.server";

const prisma = new PrismaClient();

const suffix = Date.now().toString(36).toUpperCase();
const CODE = `VSB-${suffix}`;
const STAMP = Date.now();
const SHOP_VARIANT_ID = String(STAMP);

const SHOP_APPROVED = `vsb-approved-${suffix.toLowerCase()}.myshopify.com`;
const SHOP_PENDING = `vsb-pending-${suffix.toLowerCase()}.myshopify.com`;
const SHOP_SUSPENDED = `vsb-suspended-${suffix.toLowerCase()}.myshopify.com`;
const SHOP_UNINSTALLED = `vsb-uninstalled-${suffix.toLowerCase()}.myshopify.com`;
const SHOPS = [SHOP_APPROVED, SHOP_PENDING, SHOP_SUSPENDED, SHOP_UNINSTALLED];

// Three distinct order ids. The intake path dedupes on
// (shop, topic, order, payload version), so reusing one id for the refused
// attempt and the accepted one afterwards would return "duplicate" without
// running, and the check would pass or fail for a reason unrelated to blocking.
const REFUSED_ORDER_ID = 700000 + (STAMP % 90000);
const PRE_BLOCK_ORDER_ID = REFUSED_ORDER_ID + 1;
const SUSPENDED_ORDER_ID = REFUSED_ORDER_ID + 2;

const actor = {
  actorId: "vsb-verify",
  actorName: "Seller Block Verify",
  actorType: "ADMIN_USER" as const,
};

let failures = 0;
let total = 0;
let expected = 0;

/**
 * AuditLog stores beforeData/afterData as serialized strings, not as JSON
 * columns — so a check that reads them has to parse. Reading `.status` off the
 * raw column yields undefined and the assertion fails while the record it is
 * complaining about is perfectly correct.
 */
function auditData(column: string | null | undefined): Record<string, unknown> {
  if (!column) return {};
  try {
    const parsed: unknown = JSON.parse(column);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Numbered, and the numbering is enforced: a dropped check fails the suite. */
function check(number: number, name: string, pass: boolean, detail = "") {
  expected += 1;
  total += 1;
  if (number !== expected) {
    failures += 1;
    console.log(`FAIL  check #${number} arrived out of order (expected #${expected})`);
    return;
  }
  if (!pass) failures += 1;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${String(number).padStart(2)}. ${name}${detail ? ` — ${detail}` : ""}`
  );
}

async function main() {
  /* -------------------------------------------------------------------- */
  /* The fixture                                                           */
  /* -------------------------------------------------------------------- */
  const application = await prisma.merchantApplication.create({
    data: {
      shopDomain: SHOP_APPROVED,
      storeName: "VSB Approved Store",
      contactName: "VSB Contact",
      email: "vsb-approved@example.invalid",
      legalBusinessName: "VSB Approved Ltd",
      sellerAddress: "1 Verify Way",
      productCategory: "Home",
      status: "APPROVED",
    },
  });

  const approved = await prisma.seller.create({
    data: {
      shopDomain: SHOP_APPROVED,
      shopDomainFull: SHOP_APPROVED,
      storeName: "VSB Approved Store",
      contactEmail: "vsb-approved@example.invalid",
      currency: "CAD",
      status: "APPROVED",
      approvedAt: new Date(),
      applicationId: application.id,
    },
  });

  const pending = await prisma.seller.create({
    data: {
      shopDomain: SHOP_PENDING,
      shopDomainFull: SHOP_PENDING,
      storeName: "VSB Pending Store",
      contactEmail: "vsb-pending@example.invalid",
      currency: "CAD",
      status: "PENDING",
    },
  });

  const suspended = await prisma.seller.create({
    data: {
      shopDomain: SHOP_SUSPENDED,
      shopDomainFull: SHOP_SUSPENDED,
      storeName: "VSB Suspended Store",
      contactEmail: "vsb-suspended@example.invalid",
      currency: "CAD",
      status: "APPROVED",
      approvedAt: new Date(),
    },
  });
  // Through the real service, not a direct write: suspension is the control the
  // new status table is most likely to have broken.
  await suspendSeller(suspended.id, actor, "paused for review");

  // A store the app was uninstalled from. The browser build maps it onto the
  // recoverable state on purpose, and the new status must not disturb that.
  await prisma.seller.create({
    data: {
      shopDomain: SHOP_UNINSTALLED,
      shopDomainFull: SHOP_UNINSTALLED,
      storeName: "VSB Uninstalled Store",
      contactEmail: "vsb-uninstalled@example.invalid",
      currency: "CAD",
      status: "UNINSTALLED",
      approvedAt: new Date(),
    },
  });

  // A real mapping, so the order fixture is one the intake path would genuinely
  // accept. Without it `buildItems` returns nothing, no order is created for
  // anybody, and "a blocked store gets no orders" would pass for a reason that
  // has nothing to do with blocking.
  const product = await prisma.product.create({
    data: {
      name: "VSB Block Family",
      productCode: CODE,
      category: "Home",
      currency: "CAD",
      variants: {
        create: [
          {
            name: "One size",
            sku: `${CODE}-1`,
            wholesalePrice: 1200,
            suggestedRetailPrice: 2900,
            isDefault: true,
          },
        ],
      },
    },
    include: { variants: true },
  });
  const variant = product.variants[0];

  /** Maps a variant to a seller at a given Shopify variant id. */
  async function mapTo(sellerId: string, shopifyVariantId: string, sequence: number) {
    const sellerProduct = await prisma.sellerProduct.create({
      data: {
        sellerId,
        productId: product.id,
        shopifyProductId: String(STAMP + sequence),
        importedAt: new Date(),
        isActive: true,
      },
    });
    await prisma.sellerProductVariant.create({
      data: {
        sellerProductId: sellerProduct.id,
        productVariantId: variant.id,
        shopifyProductId: String(STAMP + sequence),
        shopifyVariantId,
        syncStatus: "SUCCESS",
        syncedAt: new Date(),
      },
    });
  }
  await mapTo(approved.id, SHOP_VARIANT_ID, 7);

  type Payload = Parameters<typeof intakeOrder>[0]["payload"];
  const lineItem = {
    id: 1,
    variant_id: SHOP_VARIANT_ID,
    title: "VSB Block Family",
    sku: `${CODE}-1`,
    quantity: 2,
    price: "29.00",
    tax_lines: [{ price: "7.54" }],
    discount_allocations: [{ amount: "0.00" }],
  };
  const orderFor = (id: number, item = lineItem) =>
    ({
      id,
      name: `#VSB${id}`,
      order_number: id,
      email: "vsb-buyer@example.invalid",
      currency: "CAD",
      financial_status: "paid",
      fulfillment_status: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      customer: { first_name: "Verify", last_name: "Buyer", phone: "+14165550001" },
      shipping_address: {
        name: "Verify Buyer",
        address1: "1 Verify Way",
        city: "Toronto",
        province: "ON",
        zip: "M5V1A1",
        country: "CA",
      },
      line_items: [item],
      subtotal_price: "58.00",
      total_tax: "7.54",
      total_discounts: "0.00",
      total_shipping_price_set: { shop_money: { amount: "15.00" } },
      refunds: [],
    }) as Payload;

  try {
    /* ------------------------------------------------------------------ */
    /* The control: an approved store can do everything                     */
    /* ------------------------------------------------------------------ */
    const before = await resolveSellerContext(SHOP_APPROVED);
    check(
      1,
      "An approved store is the control: all four permissions are granted",
      before.access === "APPROVED" &&
        before.canViewWholesale &&
        before.canImport &&
        before.canViewOrders &&
        before.canStartNewBusiness,
      `${before.access} wholesale=${before.canViewWholesale} import=${before.canImport} orders=${before.canViewOrders} newBusiness=${before.canStartNewBusiness}`
    );

    /* ------------------------------------------------------------------ */
    /* Blocking the record                                                  */
    /* ------------------------------------------------------------------ */
    const blocked = await blockSeller(approved.id, actor, "unpaid invoices");
    check(
      2,
      "Blocking moves the seller to BLOCKED and stamps the date and the reason",
      blocked.status === "BLOCKED" &&
        blocked.blockedAt instanceof Date &&
        blocked.blockReason === "unpaid invoices",
      `${blocked.status} / ${blocked.blockReason}`
    );

    const blockedApp = await prisma.merchantApplication.findUnique({
      where: { id: application.id },
    });
    check(
      3,
      "The linked application is blocked too, so the review queue agrees with the store",
      blockedApp?.status === "BLOCKED",
      `application status ${blockedApp?.status}`
    );

    const blockAudit = await prisma.auditLog.findFirst({
      where: { entityType: "Seller", entityId: approved.id, action: "seller.blocked" },
      orderBy: { createdAt: "desc" },
    });
    const blockBefore = auditData(blockAudit?.beforeData);
    const blockAfter = auditData(blockAudit?.afterData);
    check(
      4,
      "The block is recorded in the audit log, with what it was before and after",
      blockBefore.status === "APPROVED" &&
        blockAfter.status === "BLOCKED" &&
        blockAfter.reason === "unpaid invoices",
      `${JSON.stringify(blockBefore)} -> ${JSON.stringify(blockAfter)}`
    );

    /* ------------------------------------------------------------------ */
    /* What a blocked store may do: nothing                                 */
    /* ------------------------------------------------------------------ */
    const after = await resolveSellerContext(SHOP_APPROVED);
    check(5, "A blocked store resolves to BLOCKED", after.access === "BLOCKED", after.access);
    check(
      6,
      "It is not shown wholesale pricing",
      after.canViewWholesale === false,
      `canViewWholesale=${after.canViewWholesale}`
    );
    check(7, "It cannot import products", after.canImport === false, `canImport=${after.canImport}`);
    check(
      8,
      "It cannot start new business, which is what gates product sync and billing",
      after.canStartNewBusiness === false,
      `canStartNewBusiness=${after.canStartNewBusiness}`
    );
    check(
      9,
      "And it cannot read its order history either — the difference from suspension",
      after.canViewOrders === false,
      `canViewOrders=${after.canViewOrders}`
    );

    check(
      10,
      "The message the store is shown is exactly the one the owner specified",
      BLOCKED_MESSAGE ===
        "Your MoonVella partner access has been blocked. Contact MoonVella support.",
      JSON.stringify(BLOCKED_MESSAGE)
    );

    /* ------------------------------------------------------------------ */
    /* The two states the new table must not have disturbed                 */
    /* ------------------------------------------------------------------ */
    const suspendedContext = await resolveSellerContext(SHOP_SUSPENDED);
    check(
      11,
      "A suspended store still reads its order history, as it did before Block existed",
      suspendedContext.access === "SUSPENDED" &&
        suspendedContext.canViewOrders === true &&
        suspendedContext.canViewWholesale === false &&
        suspendedContext.canStartNewBusiness === false,
      `${suspendedContext.access} orders=${suspendedContext.canViewOrders} wholesale=${suspendedContext.canViewWholesale}`
    );

    const uninstalledContext = await resolveSellerContext(SHOP_UNINSTALLED);
    check(
      12,
      "An uninstalled store still maps to the recoverable state, not to blocked",
      uninstalledContext.access === "SUSPENDED" && uninstalledContext.canViewOrders === true,
      `${uninstalledContext.access} orders=${uninstalledContext.canViewOrders}`
    );

    /* ------------------------------------------------------------------ */
    /* Orders: refused for new business, maintained for existing business    */
    /* ------------------------------------------------------------------ */
    const refusedOrder = await intakeOrder({
      topic: "ORDERS_CREATE",
      shop: SHOP_APPROVED,
      payload: orderFor(REFUSED_ORDER_ID),
    });
    const created = await prisma.order.findUnique({
      where: { supplierReference: `${SHOP_APPROVED}#${REFUSED_ORDER_ID}` },
    });
    check(
      13,
      "A blocked store cannot create a new order",
      refusedOrder.ok === false && refusedOrder.reason === "seller blocked",
      `ok=${refusedOrder.ok} reason=${refusedOrder.reason}`
    );
    check(14, "And no order row was written for it", created === null, created ? "row exists" : "no row");

    const refusalEvent = await prisma.webhookEvent.findFirst({
      where: { shopDomain: SHOP_APPROVED, topic: "ORDERS_CREATE" },
      orderBy: { createdAt: "desc" },
    });
    check(
      15,
      "The refusal is recorded rather than dropped, naming the reason and the order",
      refusalEvent?.status === "FAILED" &&
        (refusalEvent.errorMessage ?? "").includes("blocked") &&
        (refusalEvent.errorMessage ?? "").includes("unpaid invoices") &&
        (refusalEvent.errorMessage ?? "").includes(`#VSB${REFUSED_ORDER_ID}`),
      refusalEvent?.errorMessage ?? "no event"
    );

    // The control for the fixture itself. If a suspended store also failed to
    // create an order, check 13 would be proving nothing about blocking.
    await mapTo(suspended.id, String(STAMP + 1000), 11);
    const suspendedIntake = await intakeOrder({
      topic: "ORDERS_CREATE",
      shop: SHOP_SUSPENDED,
      payload: orderFor(SUSPENDED_ORDER_ID, {
        ...lineItem,
        variant_id: String(STAMP + 1000),
      }),
    });
    const suspendedOrder = await prisma.order.findUnique({
      where: { supplierReference: `${SHOP_SUSPENDED}#${SUSPENDED_ORDER_ID}` },
    });
    check(
      16,
      "The same fixture through a suspended store does create an order, so the gate is Block's",
      suspendedIntake.ok === true && suspendedOrder !== null,
      `ok=${suspendedIntake.ok} ${suspendedOrder ? "order created" : "no order"}`
    );

    // Now let the blocked store take a real order the way a store does — by
    // being approved when it arrives — and then block it, to check that a block
    // does not abandon work already in flight.
    await prisma.seller.update({ where: { id: approved.id }, data: { status: "APPROVED" } });
    const preBlockIntake = await intakeOrder({
      topic: "ORDERS_CREATE",
      shop: SHOP_APPROVED,
      payload: orderFor(PRE_BLOCK_ORDER_ID),
    });
    const realOrder = await prisma.order.findUnique({
      where: { supplierReference: `${SHOP_APPROVED}#${PRE_BLOCK_ORDER_ID}` },
    });
    await blockSeller(approved.id, actor, "blocked while the order was open");

    const cancelled = await intakeOrder({
      topic: "ORDERS_CANCELLED",
      shop: SHOP_APPROVED,
      payload: {
        ...orderFor(PRE_BLOCK_ORDER_ID),
        cancelled_at: new Date().toISOString(),
        cancel_reason: "customer",
      } as Payload,
    });
    const afterCancel = await prisma.order.findUnique({
      where: { supplierReference: `${SHOP_APPROVED}#${PRE_BLOCK_ORDER_ID}` },
    });
    check(
      17,
      "An order taken before the block is not abandoned: its cancellation still arrives",
      preBlockIntake.ok === true &&
        realOrder !== null &&
        cancelled.ok === true &&
        afterCancel?.cancelledAt instanceof Date,
      cancelled.ok === true
        ? `accepted before the block, cancellation processed (${afterCancel?.cancelledAt?.toISOString()})`
        : `cancellation refused (${cancelled.reason})`
    );

    /* ------------------------------------------------------------------ */
    /* MoonVella keeps everything                                           */
    /* ------------------------------------------------------------------ */
    const detail = await getSellerDetail(approved.id);
    check(
      18,
      "MoonVella staff still see the blocked store's orders and wholesale value",
      detail !== null && detail.orderCount >= 1 && (detail.wholesaleRevenue ?? 0) > 0,
      `${detail?.orderCount} order(s), ${detail?.wholesaleRevenue} cents`
    );
    check(
      19,
      "And the block date and reason are on the record they are reading",
      detail?.seller.blockedAt instanceof Date &&
        detail?.seller.blockReason === "blocked while the order was open",
      `${detail?.seller.blockReason}`
    );

    const itemsStillThere = await prisma.orderItem.count({
      where: { order: { sellerId: approved.id } },
    });
    check(
      20,
      "Blocking deleted nothing: the order lines are all still there",
      itemsStillThere >= 1,
      `${itemsStillThere} line(s)`
    );

    // The same shape the admin roster loader runs — no status filter, which is
    // the thing check 21 is really asking about: a blocked store must not be
    // filtered out of the list an operator works from.
    const roster = await prisma.seller.findMany({
      select: { id: true, status: true, blockReason: true },
      orderBy: { createdAt: "desc" },
    });
    check(
      21,
      "The blocked store still comes back from the roster query the admin list runs",
      roster.some((row) => row.id === approved.id && row.status === "BLOCKED"),
      `${roster.length} store(s) returned`
    );

    /* ------------------------------------------------------------------ */
    /* Unblocking: back to where it was, not to approved                     */
    /* ------------------------------------------------------------------ */
    const unblocked = await unblockSeller(approved.id, actor);
    const unblockAudit = await prisma.auditLog.findFirst({
      where: { entityType: "Seller", entityId: approved.id, action: "seller.unblocked" },
      orderBy: { createdAt: "desc" },
    });
    check(
      22,
      "Unblocking a store that had been approved returns it to approved",
      unblocked.status === "APPROVED",
      unblocked.status
    );
    check(
      23,
      "And clears the block, so the record cannot claim a refusal that is over",
      unblocked.blockedAt === null && unblocked.blockReason === null,
      `blockedAt=${unblocked.blockedAt} reason=${unblocked.blockReason}`
    );
    const liftBefore = auditData(unblockAudit?.beforeData);
    const liftAfter = auditData(unblockAudit?.afterData);
    check(
      24,
      "The lift is audited, and keeps what the block was for",
      liftBefore.status === "BLOCKED" &&
        liftAfter.status === "APPROVED" &&
        liftAfter.previousBlockReason === "blocked while the order was open",
      JSON.stringify(liftAfter)
    );

    const restored = await resolveSellerContext(SHOP_APPROVED);
    check(
      25,
      "The store can see pricing and order again",
      restored.access === "APPROVED" &&
        restored.canViewWholesale &&
        restored.canImport &&
        restored.canStartNewBusiness,
      `${restored.access} wholesale=${restored.canViewWholesale}`
    );

    // The one that matters most: a store that review never passed must not be
    // approved by the act of lifting a block.
    await blockSeller(pending.id, actor, "suspected fraud");
    const pendingUnblocked = await unblockSeller(pending.id, actor);
    const pendingContext = await resolveSellerContext(SHOP_PENDING);
    check(
      26,
      "Unblocking a store that was never approved returns it to pending, not approved",
      pendingUnblocked.status === "PENDING" &&
        pendingContext.access === "PENDING" &&
        pendingContext.canViewWholesale === false &&
        pendingContext.canStartNewBusiness === false,
      `${pendingUnblocked.status} / access ${pendingContext.access}`
    );

    const reBlocked = await blockSeller(pending.id, actor, "second refusal");
    check(
      27,
      "A store can be blocked again after a block is lifted",
      reBlocked.status === "BLOCKED" && reBlocked.blockReason === "second refusal",
      `${reBlocked.status} / ${reBlocked.blockReason}`
    );

    /* ------------------------------------------------------------------ */
    /* Block and suspend are different states, and the row says which        */
    /* ------------------------------------------------------------------ */
    const suspendedThenBlocked = await blockSeller(suspended.id, actor, "escalated to a block");
    check(
      28,
      "Blocking a suspended store clears the suspension, so one row cannot claim two refusals",
      suspendedThenBlocked.status === "BLOCKED" &&
        suspendedThenBlocked.suspendedAt === null &&
        suspendedThenBlocked.suspensionReason === null &&
        suspendedThenBlocked.blockReason === "escalated to a block",
      `${suspendedThenBlocked.status} suspendedAt=${suspendedThenBlocked.suspendedAt} blockReason=${suspendedThenBlocked.blockReason}`
    );
  } finally {
    await cleanup();
  }

  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

async function cleanup() {
  const sellers = await prisma.seller.findMany({
    where: { shopDomain: { in: SHOPS } },
    select: { id: true },
  });
  const sellerIds = sellers.map((seller) => seller.id);
  if (sellerIds.length) {
    const orders = await prisma.order.findMany({
      where: { sellerId: { in: sellerIds } },
      select: { id: true },
    });
    const orderIds = orders.map((order) => order.id);
    if (orderIds.length) {
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.fulfillmentRequest.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    await prisma.sellerProductVariant.deleteMany({
      where: { sellerProduct: { sellerId: { in: sellerIds } } },
    });
    await prisma.sellerProduct.deleteMany({ where: { sellerId: { in: sellerIds } } });
    // Before the applications: a seller points at one, and the row has to go
    // first for the reference to be released.
    await prisma.seller.deleteMany({ where: { id: { in: sellerIds } } });
  }
  await prisma.webhookEvent.deleteMany({ where: { shopDomain: { in: SHOPS } } });
  await prisma.merchantApplication.deleteMany({ where: { shopDomain: { in: SHOPS } } });

  const products = await prisma.product.findMany({
    where: { productCode: CODE },
    select: { variants: { select: { id: true } } },
  });
  const variantIds = products.flatMap((product) => product.variants.map((v) => v.id));
  if (variantIds.length) {
    await prisma.variantPackage.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
  }
  await prisma.product.deleteMany({ where: { productCode: CODE } });
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
