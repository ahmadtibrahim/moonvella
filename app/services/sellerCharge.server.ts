/**
 * Charging the seller for a MoonVella order.
 *
 * WHAT THIS FILE DECIDES, AND WHY IT IS NOT DECIDED ANYWHERE ELSE.
 *
 * When a customer buys from a seller's Shopify store, the seller has been paid
 * the RETAIL price. MoonVella has been paid nothing. The seller owes MoonVella
 * the WHOLESALE price of the goods MoonVella is about to ship, and MoonVella
 * charges the seller's saved card for it. This file is where "how much" is
 * answered, and it answers it from one place only: the wholesale price recorded
 * on each order line when the order was taken in.
 *
 * THE RETAIL PRICE IS NEVER AN INPUT. Not the customer's total, not the
 * Shopify subtotal, not the line's `price`. Those describe a different
 * transaction between two other parties. A charge computed from them would look
 * plausible — the numbers are all in the same currency and the same order — and
 * would be wrong by the entire margin, in the seller's disfavour, on every
 * order. So the only figures this file reads are `OrderItem.wholesalePrice`,
 * which is the snapshot, and `OrderItem.quantity`.
 *
 * SHIPPING IS INSIDE THE PRICE. The wholesale price a seller is quoted includes
 * standard shipping; it is not a separate line to be added afterwards. The
 * order pipeline computes an attributable shipping figure
 * (`Order.moonvellaShipping`) because the shipment reconciliation needs it, and
 * that figure is deliberately NOT added here. It is recorded in the snapshot as
 * a number that was considered and not charged, so the decision is visible to
 * whoever reconciles the order in six months and wonders why a bill with
 * shipping in it has no shipping on it.
 *
 * WHERE THE MONEY ACTUALLY MOVES. Not here. This module decides the amount,
 * records the snapshot it decided from, and hands the charge to
 * `chargeWholesaleOrder`, which is the only code in the app that talks to
 * Stripe about money. Nothing in this file treats "a PaymentIntent was created"
 * as "the seller has paid" — the state only reaches PAID from the verified
 * Stripe event handler.
 */

import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { chargeWholesaleOrder, getDefaultPaymentMethod, type ChargeResult } from "./sellerBilling.server";
import { transitionOrder, MONEY_CLEARED, type OrderState, type StateActor } from "./orderState.server";
import { createSetupSession } from "./sellerBilling.server";

/** A line of the bill, as it was priced at the moment of charging. */
export interface ChargeLineSnapshot {
  shopifyLineItemId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface ChargeComputation {
  /** What the seller's card is charged, in minor units. */
  amountMinor: number;
  currency: string;
  lines: ChargeLineSnapshot[];
  /** Always true. Recorded as a fact on the snapshot, not as a default. */
  shippingIncluded: true;
  /** The attributable shipping figure that was computed and NOT charged. */
  shippingConsideredMinor: number;
  /** The MoonVella-side discount figure that was computed and NOT applied. */
  discountsConsideredMinor: number;
  /** The MoonVella-side tax figure that was computed and NOT added. */
  taxConsideredMinor: number;
  /** Why shipping, discounts and tax are absent from the total. */
  treatment: {
    shipping: "INCLUDED_IN_SELLER_PRICE";
    discounts: "NOT_APPLIED_TO_WHOLESALE";
    tax: "NOT_ADDED_TO_WHOLESALE";
  };
  /** The catalogue price each line came from. Always the recorded snapshot. */
  basis: "LINE_SNAPSHOT";
  computedAt: string;
}

export class ChargeRefused extends Error {
  readonly permanent: boolean;
  readonly code: string;
  constructor(code: string, message: string, permanent = true) {
    super(message);
    this.name = "ChargeRefused";
    this.code = code;
    this.permanent = permanent;
  }
}

interface OrderForCharge {
  id: string;
  sellerId: string;
  currency: string;
  state: OrderState;
  moonvellaShipping: number;
  moonvellaDiscounts: number;
  moonvellaTax: number;
  items: {
    shopifyLineItemId: string;
    sku: string;
    name: string;
    quantity: number;
    wholesalePrice: number;
  }[];
}

/**
 * What the seller owes, computed from the recorded line prices and nothing else.
 *
 * Pure, so it can be asserted directly: a test that says "an order whose line
 * prices are 3999 is charged 3999, and an order the customer paid 8999 for is
 * still charged 3999" needs to be able to call the arithmetic without a
 * database, a Stripe key or a seller.
 */
export function computeSellerCharge(order: OrderForCharge): ChargeComputation {
  const lines: ChargeLineSnapshot[] = order.items.map((item) => ({
    shopifyLineItemId: item.shopifyLineItemId,
    sku: item.sku,
    name: item.name,
    quantity: item.quantity,
    unitPriceMinor: item.wholesalePrice,
    lineTotalMinor: item.wholesalePrice * item.quantity,
  }));

  /*
   * The whole sum. No shipping term, no tax term, no discount term — each for
   * the reason recorded in `treatment` below. Written as an explicit reduce over
   * the line totals rather than as a stored column, because a stored
   * `moonvellaSubtotal` could have been written by an older version of the
   * intake and this must agree with the LINES being charged.
   */
  const amountMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);

  return {
    amountMinor,
    currency: order.currency || "CAD",
    lines,
    shippingIncluded: true,
    shippingConsideredMinor: order.moonvellaShipping,
    discountsConsideredMinor: order.moonvellaDiscounts,
    taxConsideredMinor: order.moonvellaTax,
    treatment: {
      shipping: "INCLUDED_IN_SELLER_PRICE",
      discounts: "NOT_APPLIED_TO_WHOLESALE",
      tax: "NOT_ADDED_TO_WHOLESALE",
    },
    basis: "LINE_SNAPSHOT",
    computedAt: new Date().toISOString(),
  };
}

export interface SellerChargeOutcome {
  ok: boolean;
  /** The payment row's status after the attempt. */
  status: string;
  /** The order's state after the attempt. */
  state: OrderState;
  requiresAction?: boolean;
  /** True when the seller has no reusable saved method and must add one. */
  requiresPaymentMethod?: boolean;
  /** True when the store has not been paid yet, so there is nothing to charge. */
  awaitingCustomerPayment?: boolean;
  /** Where the seller goes to add one. Null unless `requiresPaymentMethod`. */
  setupUrl?: string | null;
  paymentIntentId?: string;
  amountMinor: number;
  currency: string;
  /** Safe to show the seller. Never a raw provider exception. */
  message?: string;
}

/**
 * Charge the seller for one MoonVella order.
 *
 * Idempotent at three levels, because it is called from a webhook, from a
 * background job and from a button, and all three can fire more than once:
 *   1. An order whose money has already cleared is never charged again — the
 *      state machine is asked, not the payment row, because REFUND_REVIEW also
 *      means money moved.
 *   2. A payment already SUCCEEDED returns immediately.
 *   3. The Stripe idempotency key is `seller-charge:<orderId>:<paymentVersion>`,
 *      so even two concurrent callers that both get past (1) and (2) produce one
 *      PaymentIntent at Stripe.
 *
 * `retry: true` is the only thing that changes the key, and it exists because a
 * declined card is not something Stripe will reconsider under the same key. It
 * bumps `paymentVersion`, which makes the next attempt a genuinely new charge
 * rather than a replay of the refusal.
 */
export async function chargeSellerForOrder(input: {
  orderId: string;
  trigger: "MANUAL" | "AUTOMATIC";
  actor: StateActor;
  /** A deliberate retry after a failure. Changes the idempotency key. */
  retry?: boolean;
  /** Where the seller returns to after adding a payment method. */
  setupReturnUrl?: string;
}): Promise<SellerChargeOutcome> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { wholesalePayment: { include: { attempts: true } }, items: true, seller: true },
  });
  if (!order) throw new ChargeRefused("ORDER_NOT_FOUND", "That order does not exist.");

  const state = order.state as OrderState;
  const payment = order.wholesalePayment;
  if (!payment) throw new ChargeRefused("NO_PAYMENT_RECORD", "This order has no bill to charge.");

  const computation = computeSellerCharge({ ...order, state });

  // (1) Money already moved. Not an error — an at-least-once caller asking twice.
  if (MONEY_CLEARED.has(state) || payment.status === "SUCCEEDED") {
    return {
      ok: true,
      status: payment.status,
      state,
      paymentIntentId: payment.providerPaymentIntentId ?? undefined,
      amountMinor: computation.amountMinor,
      currency: computation.currency,
      message: "This order has already been paid for.",
    };
  }

  if (state === "CANCELLED") {
    throw new ChargeRefused("ORDER_CANCELLED", "This order was cancelled, so nothing is owed on it.");
  }

  /*
   * MOONVELLA CHARGES THE SELLER FOR AN ORDER THE CUSTOMER HAS PAID FOR.
   *
   * Not before. An order can exist in Shopify for days before its money
   * arrives — a bank transfer, a manual capture, a gateway that confirms
   * later — and charging the seller's card the moment the order row appears
   * would take MoonVella's money for a sale that may never complete. The
   * customer's payment is the seller's receipt; it is what MoonVella's own
   * charge is a claim on.
   *
   * This is a "not yet", not a "no". It is reported rather than thrown so the
   * queue records a clean outcome, and the event that changes the answer —
   * `orders/paid`, or an update carrying `financial_status: paid` — enqueues
   * this same job again under the same key, which revives the finished row.
   */
  if (order.paymentStatus !== "PAID") {
    return {
      ok: false,
      status: payment.status,
      state,
      awaitingCustomerPayment: true,
      amountMinor: computation.amountMinor,
      currency: computation.currency,
      message: "This order has not been paid for in the store yet.",
    };
  }

  /*
   * The bill and its snapshot are written BEFORE the charge is attempted, and
   * the amount is taken from the computation rather than from whatever the row
   * held. The row's amount was written at intake from the same line prices, so
   * the two should agree; where they do not, the lines win, because the lines
   * are what is being shipped and a bill that disagrees with the goods is the
   * defect this ordering prevents.
   */
  /*
   * A RETRY ONLY MOVES THE VERSION IF SOMETHING WAS ALREADY ATTEMPTED.
   *
   * The version exists so that a second charge after a declined card gets a NEW
   * Stripe idempotency key — Stripe will not reconsider a refusal under the key
   * it refused — while a second ask for the SAME attempt gets the same key and
   * therefore the same PaymentIntent.
   *
   * Bumping it unconditionally on `retry` broke that second half, and broke it
   * in the direction that costs money. "Try again" is a button a seller can
   * press at any moment, including while the automatic charge is still on its
   * way and including on an order that has never been charged at all. On an
   * order with no attempt behind it, that press is not a retry of anything —
   * but it would mint version 2 while the automatic path was using version 1,
   * and two different keys are two different PaymentIntents against one order.
   *
   * "Was anything attempted" is read from the two facts that record it: an
   * intent the provider minted, or an attempt row. Both survive a crash between
   * the call and the write, which a bare counter would not.
   */
  const attempted = Boolean(payment.providerPaymentIntentId) || payment.attempts.length > 0;
  const version = input.retry && attempted ? payment.paymentVersion + 1 : payment.paymentVersion;
  await prisma.wholesalePayment.update({
    where: { id: payment.id },
    data: { amount: computation.amountMinor, priceSnapshot: computation as never, paymentVersion: version },
  });
  await recordAudit(
    {
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      actorName: input.actor.actorName ?? null,
      action: "payment.charge_priced",
      entityType: AUDIT_ENTITY.PAYMENT,
      entityId: payment.id,
      afterData: {
        amountMinor: computation.amountMinor,
        currency: computation.currency,
        basis: computation.basis,
        lineCount: computation.lines.length,
        shippingIncluded: computation.shippingIncluded,
        shippingConsideredMinor: computation.shippingConsideredMinor,
        discountsConsideredMinor: computation.discountsConsideredMinor,
        taxConsideredMinor: computation.taxConsideredMinor,
        paymentVersion: version,
        trigger: input.trigger,
      },
    },
    prisma as never
  );

  /*
   * NO REUSABLE METHOD IS A STATE, NOT AN EXCEPTION.
   *
   * The order is legitimate, the amount is settled, and the only thing missing
   * is something only the seller can supply. That is the one condition this
   * function cannot retry its way out of, so it reports it as a named outcome
   * with an action attached rather than as a failure — a failure would be
   * retried by the queue until it burned its attempts and then read as a system
   * fault. Nothing is fulfilled in this state, and nothing is charged.
   */
  const method = await getDefaultPaymentMethod(order.sellerId);
  if (!method) {
    const setup = input.setupReturnUrl
      ? await createSetupSession(order.sellerId, input.setupReturnUrl).catch(() => null)
      : null;
    return {
      ok: false,
      status: payment.status,
      state,
      requiresPaymentMethod: true,
      setupUrl: setup && "url" in setup ? (setup.url as string) : null,
      amountMinor: computation.amountMinor,
      currency: computation.currency,
      message: "Add a payment method to pay for this order.",
    };
  }

  /*
   * Into PAYMENT_PROCESSING before the provider is called, so an operator
   * looking at the order while Stripe is thinking sees "we are charging this"
   * rather than "we have not started". If the transition is illegal the order
   * is somewhere that must not be charged, and the refusal is the correct
   * answer rather than something to work around.
   */
  await transitionOrder(
    { orderId: order.id, to: "PAYMENT_PROCESSING", actor: input.actor, reason: `Charge attempt (${input.trigger.toLowerCase()})` },
    undefined
  );

  const result: ChargeResult = await chargeWholesaleOrder(order.id, {
    trigger: input.trigger,
    actor: { actorId: input.actor.actorId, actorName: input.actor.actorName ?? null },
  });

  const next = await applyChargeResult(order.id, result, input.actor);
  return {
    ok: result.ok,
    status: result.status,
    state: next,
    requiresAction: result.requiresAction,
    paymentIntentId: result.paymentIntentId,
    amountMinor: computation.amountMinor,
    currency: computation.currency,
    // The provider's own words are stored on the payment row for an operator.
    // What the seller is shown is written by the seller UI, from the state.
    message: result.error,
  };
}

/**
 * Move the order to match what the provider said.
 *
 * A PaymentIntent that is merely created is NOT payment. `PROCESSING` and
 * `REQUIRES_ACTION` both leave the order short of PAID, and only
 * `payment_intent.succeeded` — verified by signature, in the webhook handler —
 * is allowed to move it there. That asymmetry is the point: the synchronous
 * answer from the API call is a hint about what to display, and the
 * asynchronous signed event is the fact about money.
 */
async function applyChargeResult(
  orderId: string,
  result: ChargeResult,
  actor: StateActor
): Promise<OrderState> {
  if (result.status === "SUCCEEDED") {
    // Only the Stripe event handler may write PAID; this leaves the order in
    // PROCESSING until that event arrives, which is normally within seconds.
    return "PAYMENT_PROCESSING";
  }
  if (result.requiresAction) {
    const moved = await transitionOrder({
      orderId,
      to: "PAYMENT_ACTION_REQUIRED",
      actor,
      reason: "The card issuer requires the seller to authenticate this payment.",
    });
    return moved.moved ? moved.to : moved.from;
  }
  if (!result.ok) {
    const moved = await transitionOrder({
      orderId,
      to: "PAYMENT_FAILED",
      actor,
      reason: result.error ?? "The charge was refused.",
    });
    return moved.moved ? moved.to : moved.from;
  }
  return "PAYMENT_PROCESSING";
}

/**
 * The safe sentence a seller reads when a charge failed, in their language.
 *
 * Stripe's own message is written for a developer: it names decline codes,
 * network ids and, on a bad request, the shape of the request. None of that
 * belongs on a seller's screen, and some of it is an invitation to fish. What is
 * kept is the part a person can act on — whether to try another card, whether to
 * wait, or whether to ask their bank — and the full text stays on the payment
 * row where an operator can read it.
 */
export function safeFailureReason(message: string | null | undefined): string {
  const text = String(message ?? "").toLowerCase();
  if (!text) return "The payment could not be completed. You can try again.";
  if (text.includes("insufficient")) return "The card was declined for insufficient funds. Try another card.";
  if (text.includes("expired")) return "That card has expired. Add a card that is still valid.";
  if (text.includes("cvc") || text.includes("security code"))
    return "The card's security code was rejected. Try again or use another card.";
  if (text.includes("declined") || text.includes("do not honor") || text.includes("generic_decline"))
    return "The card was declined by the issuer. Try another card, or ask your bank.";
  if (text.includes("authentication") || text.includes("requires_action"))
    return "Your bank needs to confirm this payment. Complete the verification to continue.";
  if (text.includes("no saved payment method")) return "Add a payment method to pay for this order.";
  return "The payment could not be completed. You can try again.";
}
