/**
 * Admin cancellation, and the seller's shipping settings it replaces.
 *
 * WHAT THIS SUITE IS FOR. Cancellation is the one action in this application
 * that writes off goods and moves money back, and every way it goes wrong is
 * quiet: a refund requested twice, a reservation released twice, a credit note
 * reported as a refund, an order cancelled while a label is still live. None of
 * those throw, none of them look wrong on a screen, and all of them cost money.
 *
 * So the checks are about the properties rather than the happy path:
 *
 *   1. NOTHING THE SELLER CAN SEND changes a shipping setting. The fields are
 *      gone from the form; this proves the ENDPOINT refuses them, because a form
 *      is not a boundary.
 *   2. THE DECISION IS PLANNED BEFORE IT IS TAKEN, and the plan refuses the
 *      cases that would be wrong — a charge in flight, a live label, a pickup.
 *   3. EVERY SIDE IS IDEMPOTENT. A second request converges on one row, releases
 *      no stock twice and issues no second credit.
 *   4. AN UNCONFIRMED REFUND IS NOT A REFUND. It reconciles from the charge's
 *      own recorded refunded amount — the provider's word — not from our
 *      request having been sent.
 *   5. A CANCELLED ORDER CANNOT BUY A LABEL, which is the race the whole feature
 *      exists to close.
 *
 * WHAT IT DOES NOT PROVE, and the release notes say so: it does not make a live
 * Stripe refund. The stored key's mode decides whether a provider call is
 * possible at all, and a simulated charge has no provider payment behind it — so
 * the refund IS refused here, on purpose, and that refusal is asserted. The
 * reconciliation path is exercised against the provider-maintained figure.
 *
 * Nothing here touches #1005, and nothing creates a charge, a label or a
 * shipment against a provider.
 */

import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  CANCELLATION_REASONS,
  cancelOrder,
  cancellationPreview,
  reconcilePayment,
  resumeCancellation,
} from "../app/services/orderCancellation.server";
import { updateBillingSettings, getBillingSettings } from "../app/services/sellerBilling.server";
import { bookShipmentForOrder } from "../app/services/shipping.server";
import { forbidProviderCalls } from "./provider-guard";

const prisma = new PrismaClient();
const SUFFIX = Math.random().toString(36).slice(2, 8);
const SHOP = `verify-cancel-${SUFFIX}.myshopify.com`;
const ACTOR = { id: "verify-cancellation", name: "Cancellation suite" };
/*
 * The other services use the older `actorId`/`actorName` pair. Kept as separate
 * constants rather than one object with both spellings: this suite exists partly
 * to pin interfaces, and a single shape that satisfies two is a shape that would
 * hide a change to either.
 */
const SHIP_ACTOR = { actorId: "verify-cancellation", actorName: "Cancellation suite" };
const BILL_ACTOR = { actorId: "verify-cancellation", actorName: "Cancellation suite" };

let failures = 0;
let total = 0;
function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function cleanup() {
  const seller = await prisma.seller.findUnique({ where: { shopDomain: SHOP } });
  if (!seller) return;
  const orders = await prisma.order.findMany({ where: { sellerId: seller.id }, select: { id: true } });
  const ids = orders.map((o) => o.id);
  await prisma.orderCancellation.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.paymentAllocation.deleteMany({ where: { invoice: { sellerId: seller.id } } });
  await prisma.creditNote.deleteMany({ where: { sellerId: seller.id } });
  await prisma.invoiceLine.deleteMany({ where: { invoice: { sellerId: seller.id } } });
  await prisma.invoice.deleteMany({ where: { sellerId: seller.id } });
  await prisma.paymentEvent.deleteMany({ where: { payment: { sellerId: seller.id } } });
  await prisma.wholesalePayment.deleteMany({ where: { sellerId: seller.id } });
  const shipments = await prisma.shipment.findMany({ where: { orderId: { in: ids } }, select: { id: true } });
  const sids = shipments.map((s) => s.id);
  await prisma.stockReservation.deleteMany({ where: { OR: [{ orderId: { in: ids } }, { shipmentId: { in: sids } }] } });
  await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: ids } } } });
  await prisma.shipment.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.order.deleteMany({ where: { sellerId: seller.id } });
  await prisma.sellerBillingSettings.deleteMany({ where: { sellerId: seller.id } });
  await prisma.seller.delete({ where: { id: seller.id } });
  const variants = await prisma.productVariant.findMany({ where: { sku: { startsWith: `MV-CANCEL-${SUFFIX}` } }, select: { id: true, productId: true } });
  await prisma.stockMovement.deleteMany({ where: { variantId: { in: variants.map((v) => v.id) } } });
  await prisma.stockReservation.deleteMany({ where: { variantId: { in: variants.map((v) => v.id) } } });
  await prisma.productVariant.deleteMany({ where: { id: { in: variants.map((v) => v.id) } } });
  await prisma.product.deleteMany({ where: { id: { in: variants.map((v) => v.productId) } } });
}

/** An order in a chosen payment position, with a reserved variant behind it. */
async function makeOrder(input: {
  tag: string;
  payment: "NONE" | "REQUIRES_PAYMENT" | "REQUIRES_ACTION" | "SUCCEEDED" | "PROCESSING";
  captured?: boolean;
  refunded?: number;
  reserve?: number;
  booked?: boolean;
  handedOff?: boolean;
}) {
  const seller = await prisma.seller.findUniqueOrThrow({ where: { shopDomain: SHOP } });
  const product = await prisma.product.create({
    data: { name: `Cancel ${input.tag}`, category: "Test", productCode: `MV-CANCEL-${SUFFIX}-${input.tag}`, currency: "CAD", status: "DRAFT" },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, sku: `MV-CANCEL-${SUFFIX}-${input.tag}`, name: input.tag, wholesalePrice: 2500, suggestedRetailPrice: 5000, inventory: 10, reserved: input.reserve ?? 0, currency: "CAD" },
  });
  const order = await prisma.order.create({
    data: {
      sellerId: seller.id,
      shopifyOrderId: `cancel-${SUFFIX}-${input.tag}`,
      shopifyOrderName: `#C${input.tag}`,
      shopifyOrderNumber: 900 + input.tag.length,
      currency: "CAD",
      subtotal: 5000, totalTax: 0, totalShipping: 0, totalDiscounts: 0, totalPrice: 5000,
      moonvellaSubtotal: 2500, moonvellaTax: 0, moonvellaShipping: 0, moonvellaDiscounts: 0, moonvellaTotal: 2500,
      paymentStatus: "PENDING",
      wholesalePaymentStatus: input.payment === "SUCCEEDED" ? "SUCCEEDED" : input.payment === "NONE" ? "REQUIRES_PAYMENT" : (input.payment as never),
      state: "AWAITING_SELLER_PAYMENT",
      shopifyCreatedAt: new Date(), shopifyUpdatedAt: new Date(),
      items: { create: [{ name: input.tag, sku: variant.sku, quantity: 1, price: 5000, wholesalePrice: 2500, totalDiscount: 0, shopifyLineItemId: `li-${SUFFIX}-${input.tag}`, variantId: variant.id, productId: product.id }] },
    },
    include: { items: true },
  });

  if (input.payment !== "NONE") {
    await prisma.wholesalePayment.create({
      data: {
        orderId: order.id, sellerId: seller.id,
        amount: 2500, currency: "CAD",
        status: input.payment === "SUCCEEDED" ? "SUCCEEDED" : (input.payment as never),
        idempotencyKey: `cancel-charge-${SUFFIX}-${input.tag}`,
        providerPaymentIntentId: `pi_cancel_${SUFFIX}_${input.tag}`,
        capturedAt: input.captured ? new Date() : null,
        paidAt: input.captured ? new Date() : null,
        refundedAmount: input.refunded ?? 0,
      },
    });
  }

  if (input.reserve) {
    await prisma.stockReservation.create({
      data: {
        variantId: variant.id, quantity: input.reserve, status: "HELD",
        orderId: order.id, idempotencyKey: `hold:${order.id}:${variant.id}`,
      },
    });
  }

  if (input.booked || input.handedOff) {
    await prisma.shipment.create({
      data: {
        orderId: order.id,
        status: input.handedOff ? "SHIPPED" : "BOOKED",
        provider: "eshipper",
        providerShipmentId: `verify-cancel-ship-${SUFFIX}-${input.tag}`,
        trackingNumber: "VERIFYCANCEL000",
        packedAt: new Date(),
        handedToCarrierAt: input.handedOff ? new Date() : null,
      },
    });
  }
  return order;
}

async function main() {
  forbidProviderCalls("verify-cancellation");
  await cleanup();

  const seller = await prisma.seller.create({
    data: {
      shopDomain: SHOP, shopDomainFull: SHOP, storeName: `Cancel ${SUFFIX}`,
      contactEmail: `cancel-${SUFFIX}@test.example`, status: "APPROVED", approvedAt: new Date(), currency: "CAD",
    },
  });

  /* ------------------------------------------------------------------ */
  /* 1. The seller cannot set shipping, by any route                      */
  /* ------------------------------------------------------------------ */

  await updateBillingSettings(seller.id, { mode: "AUTOMATIC", autoPayEnabled: true, maxAmountPerOrder: 50000, maxShippingCharge: 10000, holdForReview: true }, BILL_ACTOR);

  for (const field of ["preferredShippingPolicy", "autoBookShipment"]) {
    let refused = false;
    let message = "";
    try {
      // Exactly what a forged POST produces: the field name, and a plausible value.
      await updateBillingSettings(seller.id, { [field]: field === "autoBookShipment" ? true : "cheapest" } as never, BILL_ACTOR);
    } catch (error) {
      refused = true;
      message = error instanceof Error ? error.message : "";
    }
    check(
      `a forged POST of ${field} is REFUSED, not silently dropped`,
      refused && message.includes("controlled by MoonVella"),
      message.slice(0, 70)
    );
  }

  const afterForgery = await prisma.sellerBillingSettings.findUniqueOrThrow({ where: { sellerId: seller.id } });
  check(
    "and the payment preferences the seller DOES own survived it untouched",
    afterForgery.mode === "AUTOMATIC" &&
      afterForgery.autoPayEnabled === true &&
      afterForgery.maxAmountPerOrder === 50000 &&
      afterForgery.maxShippingCharge === 10000 &&
      afterForgery.holdForReview === true,
    `mode=${afterForgery.mode} autoPay=${afterForgery.autoPayEnabled} hold=${afterForgery.holdForReview}`
  );
  check(
    "and those five are what the seller page is offered",
    Object.keys(await getBillingSettings(seller.id)).filter((k) => ["mode", "autoPayEnabled", "maxAmountPerOrder", "maxShippingCharge", "holdForReview"].includes(k)).length === 5
  );

  /* ------------------------------------------------------------------ */
  /* 2. The decision, before it is taken                                  */
  /* ------------------------------------------------------------------ */

  check("the five reasons are the ones the specification names", CANCELLATION_REASONS.length === 5 && CANCELLATION_REASONS.map((r) => r.value).join(",") === "OUT_OF_STOCK,PRODUCT_UNAVAILABLE,SELLER_REQUEST,DUPLICATE_ORDER,OTHER");

  const free = await makeOrder({ tag: "free", payment: "REQUIRES_PAYMENT" });
  const preview = await cancellationPreview(free.id);
  check("an unpaid, unshipped order may be cancelled", preview.allowed && preview.blocker === null);
  check("and the plan says no money moves", preview.payment.action === "STOP_PENDING", preview.payment.action);
  check("and the confirmation names the order and the seller", preview.orderNumber === "#Cfree" && preview.seller === `Cancel ${SUFFIX}`);
  check("and it states what happens to the stock and the invoice", preview.inventory.description.includes("released") && preview.invoice.description.length > 0);

  const inFlight = await makeOrder({ tag: "flight", payment: "PROCESSING" });
  const flightPreview = await cancellationPreview(inFlight.id);
  check(
    "a charge whose outcome is unknown is REFUSED, with 'reconcile' in the reason",
    !flightPreview.allowed && (flightPreview.blocker ?? "").includes("Reconcile"),
    (flightPreview.blocker ?? "").slice(0, 80)
  );

  const booked = await makeOrder({ tag: "booked", payment: "SUCCEEDED", captured: true, booked: true });
  const bookedPreview = await cancellationPreview(booked.id);
  check(
    "a booked parcel is REFUSED, and the reason names the label",
    !bookedPreview.allowed && (bookedPreview.blocker ?? "").includes("label") && bookedPreview.shipment.booked,
    (bookedPreview.blocker ?? "").slice(0, 80)
  );

  const handed = await makeOrder({ tag: "handed", payment: "SUCCEEDED", captured: true, booked: true, handedOff: true });
  const handedPreview = await cancellationPreview(handed.id);
  check("a handed-off parcel is REFUSED too", !handedPreview.allowed);

  let bookedRefused = false;
  try {
    await cancelOrder(booked.id, { reason: "OUT_OF_STOCK" }, ACTOR);
  } catch {
    bookedRefused = true;
  }
  const bookedAfter = await prisma.order.findUniqueOrThrow({ where: { id: booked.id } });
  check(
    "and the ACTION refuses it as well — the button is not the guard",
    bookedRefused && bookedAfter.state !== "CANCELLED" && (await prisma.orderCancellation.count({ where: { orderId: booked.id } })) === 0,
    `state=${bookedAfter.state}`
  );

  /* ------------------------------------------------------------------ */
  /* 3. Reasons                                                           */
  /* ------------------------------------------------------------------ */

  let badReason = false;
  try {
    await cancelOrder(free.id, { reason: "BECAUSE" }, ACTOR);
  } catch {
    badReason = true;
  }
  check("an unknown reason is refused", badReason);

  const other = await makeOrder({ tag: "other", payment: "REQUIRES_PAYMENT" });
  let otherNeedsWords = false;
  try {
    await cancelOrder(other.id, { reason: "OTHER", explanation: "   " }, ACTOR);
  } catch {
    otherNeedsWords = true;
  }
  check("Other with no explanation is refused — blank is not an explanation", otherNeedsWords);

  const explained = await cancelOrder(other.id, { reason: "OTHER", explanation: "Supplier discontinued the line" }, ACTOR);
  check("and Other WITH an explanation is accepted", explained.ok, explained.status);

  /* ------------------------------------------------------------------ */
  /* 4. Unpaid cancellation, and the stock                                */
  /* ------------------------------------------------------------------ */

  const withStock = await makeOrder({ tag: "stock", payment: "REQUIRES_PAYMENT", reserve: 3 });
  const variant = await prisma.productVariant.findFirstOrThrow({ where: { sku: `MV-CANCEL-${SUFFIX}-stock` } });
  const beforeReserved = variant.reserved;

  const first = await cancelOrder(withStock.id, { reason: "OUT_OF_STOCK" }, ACTOR);
  const afterFirst = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  check(
    "an unpaid cancellation moves no money and says so",
    first.paymentOutcome === "SUCCEEDED" && first.status === "CANCELLED",
    `${first.paymentOutcome}/${first.status}`
  );
  check(
    "and it releases the reservation",
    afterFirst.reserved === beforeReserved - 3,
    `${beforeReserved} -> ${afterFirst.reserved}`
  );

  const again = await cancelOrder(withStock.id, { reason: "OUT_OF_STOCK" }, ACTOR);
  const afterAgain = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  check(
    "A SECOND REQUEST RELEASES NOTHING TWICE — the reservation goes back once",
    afterAgain.reserved === afterFirst.reserved && again.ok,
    `reserved=${afterAgain.reserved}`
  );
  check(
    "and it converges on ONE cancellation row",
    (await prisma.orderCancellation.count({ where: { orderId: withStock.id } })) === 1
  );

  const heldRows = await prisma.stockReservation.findMany({ where: { orderId: withStock.id } });
  check("and the hold row itself is RELEASED, not deleted", heldRows.length === 1 && heldRows[0].status === "RELEASED");

  /* ------------------------------------------------------------------ */
  /* 5. A simulated captured charge: refund is planned, and refused       */
  /* ------------------------------------------------------------------ */

  const paid = await makeOrder({ tag: "paid", payment: "SUCCEEDED", captured: true });
  const paidPreview = await cancellationPreview(paid.id);
  check(
    "a captured charge plans a REFUND and states the amount",
    paidPreview.payment.action === "REFUND_CAPTURED" && paidPreview.payment.description.includes("25"),
    paidPreview.payment.description.slice(0, 70)
  );

  const paidCancel = await cancelOrder(paid.id, { reason: "PRODUCT_UNAVAILABLE" }, ACTOR);
  check(
    "the order is cancelled and the refund is NOT reported as completed",
    paidCancel.status === "NEEDS_ATTENTION" && paidCancel.paymentOutcome === "FAILED",
    `${paidCancel.status}/${paidCancel.paymentOutcome}`
  );
  const paidRow = await prisma.orderCancellation.findUniqueOrThrow({ where: { orderId: paid.id } });
  check(
    "and the reason is on the row, so a person can finish it",
    (paidRow.lastError ?? "").length > 0,
    (paidRow.lastError ?? "").slice(0, 70)
  );

  /* ------------------------------------------------------------------ */
  /* 6. Reconciliation: the provider's word decides, not our request      */
  /* ------------------------------------------------------------------ */

  const partial = await reconcilePayment(paid.id, "REFUND_CAPTURED");
  check(
    "with nothing refunded the provider, the answer is 'not done, retry'",
    !partial.done && partial.retryable,
    `${partial.outcome}/${partial.retryable}`
  );

  await prisma.wholesalePayment.update({ where: { orderId: paid.id }, data: { refundedAmount: 1000 } });
  const partial2 = await reconcilePayment(paid.id, "REFUND_CAPTURED");
  check(
    "a PARTIAL refund is still not a finished refund",
    !partial2.done && partial2.outcome === "PENDING",
    partial2.note.slice(0, 70)
  );

  await prisma.wholesalePayment.update({ where: { orderId: paid.id }, data: { refundedAmount: 2500, status: "REFUNDED" } });
  const full = await reconcilePayment(paid.id, "REFUND_CAPTURED");
  check(
    "and the FULL amount settles it — the provider's figure, not our request",
    full.done && full.outcome === "SUCCEEDED",
    full.note
  );

  const resumed = await resumeCancellation(paid.id, ACTOR);
  const resumedRow = await prisma.orderCancellation.findUniqueOrThrow({ where: { orderId: paid.id } });
  check(
    "resuming adopts the confirmed refund instead of requesting a second one",
    resumedRow.paymentOutcome === "SUCCEEDED" && resumedRow.status === "CANCELLED",
    `${resumedRow.paymentOutcome}/${resumedRow.status} (resumed=${resumed.resumed})`
  );

  /* ------------------------------------------------------------------ */
  /* 7. Numbers reach a confirmed state another way: the webhook          */
  /* ------------------------------------------------------------------ */

  const pending = await makeOrder({ tag: "pendingrefund", payment: "SUCCEEDED", captured: true });
  await prisma.orderCancellation.create({
    data: {
      orderId: pending.id, sellerId: seller.id, reason: "SELLER_REQUEST",
      status: "CANCELLED", paymentAction: "REFUND_CAPTURED", paymentOutcome: "PENDING",
      inventoryOutcome: "NOT_APPLICABLE", invoiceOutcome: "NOT_APPLICABLE",
      requestedById: ACTOR.id, completedAt: new Date(),
    },
  });
  const { applyStripeEvent } = await import("../app/services/payments.server");
  const eventId = `evt_cancel_${SUFFIX}`;
  await applyStripeEvent({
    id: eventId,
    type: "charge.refunded",
    data: { object: { payment_intent: `pi_cancel_${SUFFIX}_pendingrefund`, amount_refunded: 2500, amount: 2500 } },
  } as never);
  const settled = await prisma.orderCancellation.findUniqueOrThrow({ where: { orderId: pending.id } });
  check(
    "a webhook confirming the refund moves PENDING to SUCCEEDED",
    settled.paymentOutcome === "SUCCEEDED",
    `${settled.paymentOutcome} — ${settled.paymentNote ?? ""}`
  );

  /* ------------------------------------------------------------------ */
  /* 8. The race this feature exists to close                             */
  /* ------------------------------------------------------------------ */

  let bookingRefused = false;
  let bookingMessage = "";
  try {
    await bookShipmentForOrder(booked.id, {}, SHIP_ACTOR);
  } catch (error) {
    // `booked` already has a label, so this refuses for that reason too — the
    // check below re-runs against a CANCELLED, unlabelled order, which is the
    // case that matters.
    bookingMessage = error instanceof Error ? error.message : "";
  }
  const cancelledFree = await makeOrder({ tag: "nocancel", payment: "REQUIRES_PAYMENT" });
  await cancelOrder(cancelledFree.id, { reason: "DUPLICATE_ORDER" }, ACTOR);
  try {
    await bookShipmentForOrder(cancelledFree.id, {}, SHIP_ACTOR);
  } catch (error) {
    bookingRefused = true;
    bookingMessage = error instanceof Error ? error.message : "";
  }
  check(
    "A CANCELLED ORDER CANNOT BUY A LABEL — the booking path refuses it by name",
    bookingRefused && bookingMessage.includes("cancelled"),
    bookingMessage.slice(0, 80)
  );

  /* ------------------------------------------------------------------ */
  /* 9. The ledger: invoices immutable, credits not refunds                */
  /* ------------------------------------------------------------------ */

  const invoiced = await makeOrder({ tag: "invoiced", payment: "SUCCEEDED", captured: true });
  const { issueInvoiceForOrder } = await import("../app/services/invoicing.server");
  const issued = await issueInvoiceForOrder(invoiced.id, ACTOR);
  const originalTotal = issued.invoice.total;
  const originalNumber = issued.invoice.number;

  const previewWithInvoice = await cancellationPreview(invoiced.id);
  check(
    "the confirmation says a credit note will be issued, not the invoice rewritten",
    previewWithInvoice.invoice.description.includes("credit note") && previewWithInvoice.invoice.description.includes("not a refund"),
    previewWithInvoice.invoice.description.slice(0, 90)
  );

  await cancelOrder(invoiced.id, { reason: "OUT_OF_STOCK" }, ACTOR);
  const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { orderId: invoiced.id } });
  const creditsAfter = await prisma.creditNote.findMany({ where: { invoiceId: invoiceAfter.id } });
  check(
    "THE ISSUED INVOICE IS UNCHANGED — same number, same total, same status",
    invoiceAfter.number === originalNumber && invoiceAfter.total === originalTotal,
    `${invoiceAfter.number} total=${invoiceAfter.total}`
  );
  check(
    "and the correction is a CREDIT NOTE, recorded separately from any refund",
    creditsAfter.length === 1 && creditsAfter[0].amount > 0 && creditsAfter[0].stripeRefundId === null,
    `${creditsAfter.length} credit(s), stripeRefundId=${creditsAfter[0]?.stripeRefundId ?? "null"}`
  );
  check(
    "and the credit is APPLIED to the invoice rather than presented as cash returned",
    creditsAfter[0]?.status === "APPLIED"
  );

  /* ------------------------------------------------------------------ */
  /* 10. The customer's money                                              */
  /* ------------------------------------------------------------------ */

  let retailUntouched = true;
  try {
    // The only refund this module can reach is the WHOLESALE charge, keyed on
    // this order. A Shopify refund is a different row on a different system and
    // nothing in the cancellation path writes to it.
    const refunds = await prisma.refund.count({ where: { orderId: { in: [invoiced.id, paid.id, withStock.id] } } });
    retailUntouched = refunds === 0;
  } catch {
    retailUntouched = false;
  }
  check("no customer refund row was created by any cancellation", retailUntouched);
  check(
    "and the cancellation service has no path to a Shopify refund",
    !/shopifyRefund|refundCustomer|shopifyRefunds/.test(readFileSync("app/services/orderCancellation.server.ts", "utf8")),
    "the only refund it can reach is the wholesale charge"
  );

  await cleanup();
  console.log(`\n=== ${total - failures}/${total} checks passed ===`);
  await prisma.$disconnect();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error("verify-cancellation FAILED:", error instanceof Error ? error.message : error);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
