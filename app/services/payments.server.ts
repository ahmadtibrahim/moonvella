import { createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { setIntegrationState } from "./integrationHealth.server";
import { persistPaymentMethodFromSetupIntent } from "./sellerBilling.server";
import { redactSecrets, stripeSecretKey } from "./credentials.server";
import {
  assertNotDisabled,
  isSimulatedId,
  requireStripeProvider,
  stripeKeyKindProblem,
  stripeMode,
} from "./stripeMode.server";
import { computeSellerCharge } from "./sellerCharge.server";
import { markPaid, transitionOrder, type OrderState } from "./orderState.server";

/**
 * Wholesale payment integration.
 *
 * Real mode uses the Stripe API when a secret key resolves from the encrypted
 * credential store (Settings) or, failing that, the environment. Simulated mode
 * (no key) records clearly-labelled local intents/events so the internal logic
 * can be tested without credentials. Simulated events never represent a real
 * charge.
 */

const STRIPE_API = "https://api.stripe.com/v1";

/**
 * Configured means a secret key resolves from the encrypted store or the
 * environment — nothing more. It is deliberately NOT a claim that the key works:
 * that requires an authenticated call, which is what testStripeAuthentication
 * below performs and what the Settings page reports as Connected.
 *
 * It is also NOT a mode. Whether provider calls are allowed, and whether they
 * would move real money, is answered by `stripeMode()` — see stripeMode.server.ts.
 * Presence alone used to be treated as "real mode", which put a live key on the
 * same path as a sandbox key.
 */
export async function isStripeConfigured(): Promise<boolean> {
  return (await stripeSecretKey()) !== null;
}

/**
 * The explicit mode: disabled | simulated | test | live. Re-exported so existing
 * callers keep one import, but the resolution lives in stripeMode.server.ts where
 * the live-mode gate is.
 */
export { stripeMode, type StripeMode } from "./stripeMode.server";

export interface StripeAuthTest {
  ok: boolean;
  /** Stripe's own answer about the key: false means a test-mode key. */
  livemode: boolean | null;
  reason: string | null;
}

/**
 * Authenticated, read-only probe: GET /v1/balance with the stored secret.
 *
 * This reads a balance. It creates no charge, no customer and no intent, so it
 * is safe to run against any account, and it is the only thing allowed to
 * justify showing "Connected" for Stripe.
 */
export async function testStripeAuthentication(): Promise<StripeAuthTest> {
  const key = await stripeSecretKey();
  if (!key) {
    return { ok: false, livemode: null, reason: "No Stripe secret key is configured." };
  }

  /*
   * A value of the wrong KIND is diagnosed here, without a request. The
   * alternative is what this used to do: send a publishable key as a bearer
   * token, collect Stripe's 401, and report it as an authentication failure —
   * which is true, and tells the operator nothing about the one thing they can
   * fix. Nothing is spent by not asking: no request, no retry, no rate limit.
   */
  const wrongKind = stripeKeyKindProblem(key);
  if (wrongKind) {
    return { ok: false, livemode: null, reason: wrongKind };
  }

  try {
    const res = await fetch(`${STRIPE_API}/balance`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const json = (await res.json().catch(() => ({}))) as {
      livemode?: boolean;
      error?: { message?: string; type?: string };
    };
    if (!res.ok) {
      return {
        ok: false,
        livemode: null,
        // Stripe's message names the problem ("Invalid API Key provided…") and
        // does not echo the key; redaction guards against that changing.
        reason: redactSecrets(json?.error?.message || `Stripe rejected the key (HTTP ${res.status}).`),
      };
    }
    return {
      ok: true,
      livemode: typeof json.livemode === "boolean" ? json.livemode : null,
      reason: null,
    };
  } catch (error) {
    return {
      ok: false,
      livemode: null,
      reason: error instanceof Error ? error.message : "Could not reach Stripe.",
    };
  }
}

/**
 * Ensure the bill for an order exists and says the right number.
 *
 * THIS FUNCTION USED TO CREATE A PAYMENT INTENT, AND THAT WAS THE DEFECT.
 *
 * The intent it made had no `customer` and no `payment_method`, so it could
 * never be confirmed by anyone — and it was not the intent that got charged.
 * The charge that actually happens is the off-session one in
 * `chargeWholesaleOrder`, which creates its own intent and stores its id on
 * this same row. Two intents for one order, one of them unconfirmable, is bad
 * enough on its own; what makes it dangerous is the webhook. A
 * `payment_intent.canceled` or `.requires_payment_method` for the orphan would
 * arrive, resolve to this row by its order metadata, and overwrite the status
 * of the intent that was genuinely charged.
 *
 * So this now does the one thing that is safe to do repeatedly: it prices the
 * bill from the line snapshot and leaves the provider alone. Money moves in
 * exactly one place — `chargeSellerForOrder` — and one order therefore has at
 * most one PaymentIntent for its whole life.
 *
 * The amount comes from `computeSellerCharge`, which reads the recorded
 * wholesale unit price on each line, because that is the price of the goods.
 * It used to read `order.moonvellaTotal`, which adds attributable tax and
 * shipping on top of the goods; the wholesale price a seller is quoted already
 * includes standard shipping, so that figure would have overcharged every
 * order that had either.
 */
export async function createOrReuseWholesalePayment(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { wholesalePayment: true, seller: true, items: true },
  });
  if (!order) throw new Error("Order not found.");

  const computation = computeSellerCharge({
    id: order.id,
    sellerId: order.sellerId,
    currency: order.currency,
    state: order.state as never,
    moonvellaShipping: order.moonvellaShipping,
    moonvellaDiscounts: order.moonvellaDiscounts,
    moonvellaTax: order.moonvellaTax,
    items: order.items.map((item) => ({
      shopifyLineItemId: item.shopifyLineItemId,
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      wholesalePrice: item.wholesalePrice,
    })),
  });

  if (computation.amountMinor <= 0) {
    throw new Error("This order has no MoonVella lines, so there is nothing to charge for.");
  }

  const idempotencyKey = `wholesale:${order.supplierReference ?? order.id}`;
  const mode = await assertNotDisabled("create a wholesale payment");

  /*
   * A bill that has already been charged keeps the amount it was charged at.
   * Re-pricing it here would make the stored total disagree with the seller's
   * statement, which is the one disagreement nobody can resolve from this side.
   */
  const chargedAlready =
    order.wholesalePayment !== null &&
    ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED", "PROCESSING", "REQUIRES_ACTION"].includes(
      order.wholesalePayment.status
    );

  const payment = await prisma.wholesalePayment.upsert({
    where: { orderId },
    create: {
      orderId,
      sellerId: order.sellerId,
      amount: computation.amountMinor,
      subtotal: computation.amountMinor,
      shippingAmount: 0,
      taxAmount: 0,
      currency: order.currency,
      provider: "stripe",
      status: "REQUIRES_PAYMENT",
      idempotencyKey,
      priceSnapshot: computation as never,
    },
    update: chargedAlready
      ? {}
      : {
          amount: computation.amountMinor,
          subtotal: computation.amountMinor,
          // Zero, and recorded as zero rather than left null: shipping is
          // inside the seller's price, so the seller's shipping charge is nil
          // and the auto-pay ceiling on shipping can never be tripped by a
          // number that was never billed.
          shippingAmount: 0,
          taxAmount: 0,
          priceSnapshot: computation as never,
        },
  });

  if (mode === "simulated") {
    await setIntegrationState("stripe", {
      status: "NOT_CONFIGURED",
      detail:
        "Simulated mode: Stripe is in simulated mode, so no provider charge can be made. " +
        "The bill is priced and stored locally only, and is not a real charge.",
    });
  }

  return payment;
}

type StripeEvent = {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, unknown> };
};

function isSetupEvent(type: string, object: Record<string, unknown>): boolean {
  if (type === "setup_intent.succeeded") return true;
  return type === "checkout.session.completed" && String(object.mode ?? "") === "setup";
}

/** Charge/dispute events carry the payment intent on a nested field. */
function resolveIntentId(type: string, object: Record<string, unknown>): string {
  if (type.startsWith("charge.")) return String(object.payment_intent ?? "");
  return String(object.id ?? "");
}

/**
 * Persist a saved payment method from a verified hosted setup event. The event
 * id is recorded so Stripe retries are deduplicated.
 */
async function applySetupEvent(event: StripeEvent, object: Record<string, unknown>) {
  const setupIntentId =
    event.type === "setup_intent.succeeded"
      ? String(object.id ?? "")
      : String(object.setup_intent ?? "");
  const metadata = (object.metadata as Record<string, unknown> | undefined) ?? {};
  const sellerId = String(metadata.sellerId ?? "");
  const customerId = object.customer ? String(object.customer) : null;

  if (!setupIntentId) {
    await prisma.paymentEvent.create({
      data: {
        provider: "stripe",
        eventId: event.id,
        type: event.type,
        payload: JSON.stringify(event),
        status: "UNMATCHED",
        errorMessage: "Setup event has no setup intent id.",
        processedAt: new Date(),
      },
    });
    return { matched: false, reason: "no_setup_intent" };
  }

  if (!sellerId) {
    await prisma.paymentEvent.create({
      data: {
        provider: "stripe",
        eventId: event.id,
        type: event.type,
        payload: JSON.stringify(event),
        status: "UNMATCHED",
        errorMessage: "Setup event is missing sellerId metadata.",
        processedAt: new Date(),
      },
    });
    return { matched: false, reason: "no_seller" };
  }

  /*
   * The setup intent names a seller this database does not have — a sandbox
   * intent created against another database, or a seller deleted after the
   * intent was made. That is not a failure to retry: the only write this event
   * leads to is a payment method owned by that seller, so a foreign key refuses
   * it every time. Throwing would answer Stripe 500, which it redelivers with
   * backoff, and each redelivery would report the integration as FAILED — an
   * outage that is not happening, on the page whose whole job is to be believed
   * when it says something is wrong. The event is recorded with the reason
   * instead, exactly as a missing metadata field already is.
   */
  const seller = await prisma.seller.findUnique({ where: { id: sellerId }, select: { id: true } });
  if (!seller) {
    await prisma.paymentEvent.create({
      data: {
        provider: "stripe",
        eventId: event.id,
        type: event.type,
        payload: JSON.stringify(event),
        status: "UNMATCHED",
        errorMessage: `Setup event names seller ${sellerId}, which this database does not have. Nothing was saved.`,
        processedAt: new Date(),
      },
    });
    return { matched: false, reason: "unknown_seller" };
  }

  const mode = await stripeMode();
  if (mode === "simulated" || mode === "disabled") {
    await prisma.paymentEvent.create({
      data: {
        provider: "stripe",
        eventId: event.id,
        type: event.type,
        payload: JSON.stringify(event),
        status: "NOT_CONFIGURED",
        errorMessage:
          mode === "simulated"
            ? "Stripe is in simulated mode; this event cannot describe a provider payment method, so nothing was saved."
            : "Stripe is disconnected; this setup event is refused rather than simulated.",
        processedAt: new Date(),
      },
    });
    return { matched: false, reason: mode === "simulated" ? "stripe_simulated" : "stripe_disabled" };
  }

  try {
    const method = await persistPaymentMethodFromSetupIntent(setupIntentId, sellerId, customerId, {
      actorId: "stripe",
      actorName: "Stripe",
      actorType: "WEBHOOK",
    });
    await prisma.paymentEvent.create({
      data: {
        provider: "stripe",
        eventId: event.id,
        type: event.type,
        payload: JSON.stringify(event),
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });
    await setIntegrationState("stripe", {
      status: "HEALTHY",
      detail: `Saved payment method ${method.id} from ${event.type}.`,
    });
    return { matched: true, ref: setupIntentId, status: "PROCESSED" };
  } catch (error) {
    // No PaymentEvent row is written, so Stripe can retry the same event id.
    await setIntegrationState("stripe", {
      status: "FAILED",
      error: error instanceof Error ? error.message : "setup event failed",
    });
    throw error;
  }
}

export interface ApplyStripeEventResult {
  matched?: boolean;
  duplicate?: boolean;
  status?: string;
  ref?: string;
  reason?: string;
}

function payoutStatus(eventType: string, objectStatus: unknown): string {
  const supplied = String(objectStatus ?? "").trim().toUpperCase();
  if (supplied) return supplied;
  if (eventType === "payout.paid") return "PAID";
  if (eventType === "payout.failed") return "FAILED";
  if (eventType === "payout.canceled") return "CANCELED";
  return "PENDING";
}

function stripeUnixDate(value: unknown): Date | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/** Record Stripe's bank settlement without pretending one payout is one order. */
async function applyPayoutEvent(event: StripeEvent, object: Record<string, unknown>): Promise<ApplyStripeEventResult> {
  const payoutId = String(object.id ?? "");
  if (!payoutId.startsWith("po_")) {
    await prisma.paymentEvent.create({
      data: {
        provider: "stripe",
        eventId: event.id,
        type: event.type,
        payload: JSON.stringify(event),
        status: "UNMATCHED",
        errorMessage: "Stripe payout event did not contain a payout id.",
        processedAt: new Date(),
      },
    });
    return { matched: false, reason: "missing_payout_id" };
  }

  const amount = Number(object.amount ?? 0);
  const currency = String(object.currency ?? "CAD").toUpperCase();
  const status = payoutStatus(event.type, object.status);
  const arrivalDate = stripeUnixDate(object.arrival_date);
  const paidAt = status === "PAID" ? stripeUnixDate(event.created) ?? new Date() : null;
  const failureCode = String(object.failure_code ?? "") || null;
  const failureMessage = String(object.failure_message ?? "") || null;

  await prisma.$transaction(async (tx) => {
    await tx.stripePayout.upsert({
      where: { providerPayoutId: payoutId },
      create: {
        providerPayoutId: payoutId,
        amount: Number.isFinite(amount) ? amount : 0,
        currency,
        status,
        arrivalDate,
        paidAt,
        failureCode,
        failureMessage,
        lastEventId: event.id,
      },
      update: {
        amount: Number.isFinite(amount) ? amount : 0,
        currency,
        status,
        arrivalDate,
        ...(paidAt ? { paidAt } : {}),
        failureCode,
        failureMessage,
        lastEventId: event.id,
      },
    });
    await tx.paymentEvent.create({
      data: {
        provider: "stripe",
        eventId: event.id,
        type: event.type,
        payload: JSON.stringify(event),
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });
    await recordAudit(
      {
        actorType: "WEBHOOK",
        actorId: "stripe",
        actorName: "Stripe",
        action: `stripe.${event.type}`,
        entityType: AUDIT_ENTITY.PAYMENT,
        entityId: payoutId,
        afterData: { amount, currency, status, arrivalDate, paidAt, failureCode, failureMessage },
      },
      tx as never
    );
  });

  await setIntegrationState("stripe", {
    status: status === "FAILED" ? "FAILED" : "HEALTHY",
    detail: `Processed Stripe ${event.type} for ${payoutId}.`,
  });
  return { matched: true, ref: payoutId, status };
}

/** Apply a verified provider event. Idempotent by provider event id. */
export async function applyStripeEvent(event: StripeEvent): Promise<ApplyStripeEventResult> {
  const existing = await prisma.paymentEvent.findUnique({ where: { eventId: event.id } });
  if (existing) {
    return { duplicate: true, status: existing.status };
  }

  const object = event.data?.object ?? {};

  if (event.type.startsWith("payout.")) {
    return applyPayoutEvent(event, object);
  }

  if (isSetupEvent(event.type, object)) {
    return applySetupEvent(event, object);
  }

  const intentId = resolveIntentId(event.type, object);
  /*
   * BOTH SPELLINGS, AND THE ONE THE CHARGE WRITES COMES FIRST.
   *
   * The charge stamps four keys on every intent it creates — `moonvellaOrderId`,
   * `shopifyOrderId`, `storeId`, `sellerId` — and this read `orderId`, a key
   * nothing has ever written. The lookup below therefore had two ways to find a
   * payment and only ever used one: the stored intent id. That is enough in the
   * ordinary case, because the id is written back the moment Stripe answers.
   *
   * It is not enough in the case the fallback exists for. If the process dies
   * between Stripe creating the intent and the id being stored — the exact
   * crash the charge's own comment says the attempt rows survive — then the
   * order has no intent id, the event carries the only link back to it, and the
   * reader was looking for a key that is not there. `payment_intent.succeeded`
   * would be filed as UNMATCHED, the money would be real, and the order would
   * sit in PAYMENT_PROCESSING with fulfillment locked and nothing to say why.
   *
   * `orderId` is still read second, so any event already recorded under that
   * spelling keeps resolving.
   */
  const metadata = (object.metadata as Record<string, unknown> | undefined) ?? {};
  const metadataOrderId = metadata.moonvellaOrderId ?? metadata.orderId;
  const ref = intentId || String(metadataOrderId ?? "");

  let payment = intentId
    ? await prisma.wholesalePayment.findUnique({ where: { providerPaymentIntentId: intentId } })
    : null;
  if (!payment && metadataOrderId) {
    const byOrder = await prisma.wholesalePayment.findUnique({
      where: { orderId: String(metadataOrderId) },
    });
    /*
     * A STALE INTENT MUST NOT SPEAK FOR THE ORDER.
     *
     * The metadata fallback exists so an event still finds its order if the
     * payment row has not yet stored the intent id — a race of a few
     * milliseconds during the first charge. It must not become a way for an
     * intent that is no longer the order's to write to it: an abandoned intent
     * from an earlier attempt, or one for a different order that happens to
     * carry this order's metadata, would otherwise be able to move the money
     * state of a row it does not own. If the row names an intent and this event
     * is about a different one, the event is recorded as unmatched.
     */
    const ownsIntent =
      byOrder &&
      (!intentId ||
        !byOrder.providerPaymentIntentId ||
        byOrder.providerPaymentIntentId === intentId);
    payment = ownsIntent ? byOrder : null;
    if (byOrder && !ownsIntent) {
      await prisma.paymentEvent.create({
        data: {
          provider: "stripe",
          eventId: event.id,
          type: event.type,
          payload: JSON.stringify(event),
          status: "UNMATCHED",
          errorMessage:
            `Event is about payment intent ${intentId}, but this order's payment is ` +
            `${byOrder.providerPaymentIntentId}. Ignored so a superseded intent cannot change the order.`,
          processedAt: new Date(),
        },
      });
      return { matched: false, reason: "stale_intent" };
    }
  }
  if (!payment) {
    await prisma.paymentEvent.create({
      data: {
        provider: "stripe",
        eventId: event.id,
        type: event.type,
        payload: JSON.stringify(event),
        status: "UNMATCHED",
        processedAt: new Date(),
      },
    });
    return { matched: false };
  }

  let status = payment.status;
  let orderStatus = payment.status;
  let failureMessage: string | null = payment.failureMessage;
  let refundedAmount: number | null = null;
  let chargeId: string | null = null;
  let dispute: { reason: string; amount: number; status: string } | null = null;

  switch (event.type) {
    case "payment_intent.succeeded":
      status = "SUCCEEDED";
      orderStatus = "SUCCEEDED";
      failureMessage = null;
      break;
    case "payment_intent.processing":
      status = "PROCESSING";
      orderStatus = "PROCESSING";
      break;
    case "payment_intent.requires_action":
      status = "REQUIRES_ACTION";
      orderStatus = "REQUIRES_ACTION";
      break;
    case "payment_intent.payment_failed":
      status = "FAILED";
      orderStatus = "FAILED";
      failureMessage = String((object.last_payment_error as { message?: string } | undefined)?.message ?? "Payment failed");
      break;
    case "charge.refunded": {
      // Partial refunds carry amount_refunded; only a full refund is REFUNDED.
      const charged = Number(object.amount ?? payment.amount);
      const refunded = Number(object.amount_refunded ?? 0);
      refundedAmount = Number.isFinite(refunded) ? refunded : 0;
      chargeId = String(object.id ?? "") || null;
      const full = charged > 0 && refundedAmount >= charged;
      status = full ? "REFUNDED" : "PARTIALLY_REFUNDED";
      orderStatus = status;
      break;
    }
    case "charge.dispute.created": {
      const reason = String(object.reason ?? "unknown");
      const amount = Number(object.amount ?? 0);
      chargeId = String(object.charge ?? "") || null;
      dispute = { reason, amount, status: String(object.status ?? "needs_response") };
      status = "FAILED";
      orderStatus = "FAILED";
      failureMessage = `Dispute created (${reason}) for ${amount} ${payment.currency}. Status: ${dispute.status}.`;
      break;
    }
    default:
      status = payment.status;
      orderStatus = payment.status;
  }

  const auditAction = dispute
    ? "payment.disputed"
    : refundedAmount !== null
      ? status === "REFUNDED"
        ? "payment.refunded"
        : "payment.partially_refunded"
      : `payment.${status.toLowerCase()}`;

  await prisma.$transaction(async (tx) => {
    const capturedAt = status === "SUCCEEDED" ? (payment!.capturedAt ?? payment!.paidAt ?? new Date()) : payment!.capturedAt;
    await tx.wholesalePayment.update({
      where: { id: payment!.id },
      data: {
        status: status as never,
        failureMessage,
        capturedAt,
        paidAt: status === "SUCCEEDED" ? (payment!.paidAt ?? capturedAt) : payment!.paidAt,
        ...(refundedAmount !== null ? { refundedAmount } : {}),
        ...(chargeId ? { providerChargeId: chargeId } : {}),
      },
    });
    await tx.order.update({
      where: { id: payment!.orderId },
      data: { wholesalePaymentStatus: orderStatus as never },
    });

    /*
     * THE ORDER'S OWN STATE MOVES HERE, AND ONLY HERE, FOR ANYTHING TO DO WITH
     * MONEY.
     *
     * This handler runs behind a verified signature, which is what makes it the
     * only writer allowed to reach PAID. The synchronous response from the API
     * call that created the intent is a hint about what to display; this event
     * is the fact, and it can arrive minutes later or after the operator has
     * closed the tab.
     *
     * A transition that the graph forbids is recorded and swallowed rather than
     * thrown. The payment row above has been written either way, and the two
     * cases that produce one — an event for an order already cancelled, an
     * event redelivered after a later one — are both cases where the money
     * record is still correct and returning a 500 would only make Stripe
     * redeliver an event that will be refused identically.
     */
    await driveOrderStateFromEvent(tx, payment!.orderId, event.type, status);

    if (dispute) {
      await tx.paymentAttempt.create({
        data: {
          paymentId: payment!.id,
          provider: "stripe",
          providerPaymentIntentId: intentId || payment!.providerPaymentIntentId,
          status: "DISPUTED",
          failureCode: dispute.reason,
          failureMessage,
          amount: dispute.amount,
        },
      });
    }
    await tx.paymentEvent.create({
      data: {
        provider: "stripe",
        eventId: event.id,
        type: event.type,
        paymentId: payment!.id,
        payload: JSON.stringify(event),
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });
    await recordAudit(
      {
        actorType: "WEBHOOK",
        actorId: "stripe",
        actorName: "Stripe",
        action: auditAction,
        entityType: AUDIT_ENTITY.PAYMENT,
        entityId: payment!.id,
        afterData: {
          status,
          orderId: payment!.orderId,
          ...(refundedAmount !== null ? { refundedAmount } : {}),
          ...(dispute ? { dispute } : {}),
        },
      },
      tx as never
    );
  });

  await setIntegrationState("stripe", {
    status: "HEALTHY",
    detail: `Processed Stripe event ${event.type}.`,
  });

  return { matched: true, ref, status };
}

/**
 * Move the order to match a verified provider event.
 *
 * The mapping is deliberately partial. Every event that means "not paid" is
 * mapped to a state that cannot precede fulfilment, and the two events that can
 * mean "the seller's money is gone" — a refund and a dispute — are mapped to
 * REFUND_REVIEW rather than to anything terminal, because what happens to the
 * goods after the money moved is a decision, not a consequence.
 *
 * An illegal move is recorded, not raised. See the note at the call site.
 */
async function driveOrderStateFromEvent(
  tx: Prisma.TransactionClient,
  orderId: string,
  eventType: string,
  paymentStatus: string
) {
  const actor = { actorType: "WEBHOOK" as const, actorId: "stripe", actorName: "Stripe" };
  const attempt = async (to: OrderState, reason: string) => {
    try {
      await transitionOrder({ orderId, to, actor, reason }, tx);
    } catch (error) {
      /*
       * An event for an order that has already moved past the state this event
       * describes. Recorded on the payment row's audit trail by the caller; the
       * money record is unaffected, and Stripe must not be asked to redeliver
       * an event that would be refused identically every time.
       */
      await recordAudit(
        {
          actorType: "WEBHOOK",
          actorId: "stripe",
          actorName: "Stripe",
          action: "order.state_change_refused",
          entityType: AUDIT_ENTITY.ORDER,
          entityId: orderId,
          afterData: {
            eventType,
            attemptedState: to,
            reason: error instanceof Error ? error.message : String(error),
          },
        },
        tx as never
      );
    }
  };

  switch (eventType) {
    case "payment_intent.succeeded": {
      /*
       * PAID, AND ONLY FROM HERE.
       *
       * This is the single write in the system that says the seller's money has
       * arrived, and it sits behind a verified signature. Everything that ships
       * a parcel is downstream of it.
       */
      const paid = await markPaid(
        { orderId, actor, reason: "Stripe reported the charge succeeded." },
        tx
      ).catch(async (error) => {
        await recordAudit(
          {
            actorType: "WEBHOOK",
            actorId: "stripe",
            actorName: "Stripe",
            action: "order.paid_refused",
            entityType: AUDIT_ENTITY.ORDER,
            entityId: orderId,
            afterData: { reason: error instanceof Error ? error.message : String(error) },
          },
          tx as never
        );
        return null;
      });

      /*
       * Then immediately ready to fulfil. The two are separate states because
       * they are separate facts — "the seller paid" is about money and "the
       * warehouse may start" is about work — and keeping them separate is what
       * lets an operator hold an order at PAID without that looking like a
       * payment failure.
       */
      if (paid) await attempt("READY_FOR_FULFILLMENT", "Seller payment cleared.");
      break;
    }
    case "payment_intent.processing":
      await attempt("PAYMENT_PROCESSING", "Stripe is processing the charge.");
      break;
    case "payment_intent.requires_action":
      await attempt(
        "PAYMENT_ACTION_REQUIRED",
        "The card issuer requires the seller to authenticate this payment."
      );
      break;
    case "payment_intent.payment_failed":
      await attempt("PAYMENT_FAILED", "Stripe reported the charge failed.");
      break;
    case "payment_intent.canceled":
      await attempt("PAYMENT_FAILED", "The payment was cancelled before it completed.");
      break;
    case "charge.refunded":
      await attempt(
        "REFUND_REVIEW",
        paymentStatus === "REFUNDED"
          ? "The seller's charge was refunded in full."
          : "The seller's charge was partially refunded."
      );
      break;
    case "charge.dispute.created":
      await attempt("REFUND_REVIEW", "The seller's charge was disputed.");
      break;
    default:
      break;
  }
}

/**
 * Give the seller back money MoonVella charged them.
 *
 * THE GUARD IS THE POINT. `Prevent refunding more than the seller was charged`
 * is enforced here rather than trusted to whichever caller builds the request,
 * because the amount is a number a person types and the ceiling is a fact from
 * the payment row. A refund of the remainder is allowed; a refund of more than
 * the remainder is refused with the arithmetic stated, and nothing is sent to
 * Stripe.
 *
 * This is NOT how a Shopify customer refund is handled. That is the seller's
 * money and the seller's decision, and MoonVella does not mirror it
 * automatically — see `Refund` in the schema and §5 of the work order.
 */
export async function refundSellerCharge(input: {
  orderId: string;
  /** Minor units. Defaults to everything still refundable. */
  amountMinor?: number;
  reason: string;
  actor: { actorType: "ADMIN_USER" | "SYSTEM"; actorId: string; actorName?: string | null };
  /** The Shopify refund this decision was made about, when there is one. */
  shopifyRefundId?: string | null;
}) {
  const payment = await prisma.wholesalePayment.findUnique({
    where: { orderId: input.orderId },
    include: { order: { select: { id: true, currency: true } } },
  });
  if (!payment) throw new Error("This order has no charge to refund.");
  if (payment.status !== "SUCCEEDED" && payment.status !== "PARTIALLY_REFUNDED") {
    throw new Error(
      `Only a charge that succeeded can be refunded; this one is ${payment.status}.`
    );
  }
  if (!payment.providerPaymentIntentId) {
    throw new Error("This charge has no provider payment to refund against.");
  }
  if (isSimulatedId(payment.providerPaymentIntentId)) {
    throw new Error(
      "This is a simulated charge recorded while Stripe was in simulated mode. " +
        "There is no provider payment behind it, so there is nothing to refund."
    );
  }

  const refundable = payment.amount - payment.refundedAmount;
  const requested = input.amountMinor ?? refundable;
  if (requested <= 0) {
    throw new Error("There is nothing left to refund on this charge.");
  }
  if (requested > refundable) {
    throw new Error(
      `Refusing to refund ${requested} when only ${refundable} of the ${payment.amount} charged ` +
        `remains refundable.`
    );
  }

  /*
   * The key is derived from the amount and what is left, so a double-submit of
   * the same refund resolves to one refund at Stripe while a deliberate second
   * partial refund — a different amount — is a genuinely new request.
   */
  const idempotencyKey = `refund:${input.orderId}:${payment.refundedAmount}:${requested}`;
  const params = new URLSearchParams({
    payment_intent: payment.providerPaymentIntentId,
    amount: String(requested),
    "metadata[moonvellaOrderId]": input.orderId,
    "metadata[reason]": input.reason.slice(0, 200),
  });

  const mode = await assertNotDisabled("refund a seller charge");
  if (mode !== "test" && mode !== "live") {
    throw new Error(
      `Stripe is in ${mode} mode, so no refund was sent. A simulated charge has no provider payment to refund.`
    );
  }
  const { key } = await requireStripeProvider("refund a seller charge");
  const res = await fetch(`${STRIPE_API}/refunds`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body: params,
  });
  const json = (await res.json()) as {
    id?: string;
    status?: string;
    amount?: number;
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(redactSecrets(json?.error?.message || `Stripe refused the refund (HTTP ${res.status}).`));
  }

  const refundId = String(json.id ?? "");
  const nextRefunded = payment.refundedAmount + requested;

  await prisma.$transaction(async (tx) => {
    await tx.wholesalePayment.update({
      where: { id: payment.id },
      data: {
        refundedAmount: nextRefunded,
        status: nextRefunded >= payment.amount ? "REFUNDED" : "PARTIALLY_REFUNDED",
      },
    });
    /*
     * The refund row is the MoonVella-side record, kept on the same row as the
     * customer refund when there is one because they are the same event seen
     * from two sides — and created on its own when there is not, because a
     * refund MoonVella decided on for its own reasons is still a refund.
     */
    if (input.shopifyRefundId) {
      await tx.refund.updateMany({
        where: { orderId: input.orderId, shopifyRefundId: input.shopifyRefundId },
        data: {
          stripeRefundId: refundId || null,
          stripeStatus: String(json.status ?? "pending"),
          reviewNote: input.reason,
          reviewedAt: new Date(),
        },
      });
    }
    await recordAudit(
      {
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        actorName: input.actor.actorName ?? null,
        action: "payment.refund_issued",
        entityType: AUDIT_ENTITY.PAYMENT,
        entityId: payment.id,
        afterData: {
          amountMinor: requested,
          refundedTotalMinor: nextRefunded,
          chargedMinor: payment.amount,
          stripeRefundId: refundId,
          stripeStatus: json.status ?? null,
          reason: input.reason,
        },
      },
      tx as never
    );
  });

  await transitionOrder(
    {
      orderId: input.orderId,
      to: "REFUND_REVIEW",
      actor: {
        actorType: input.actor.actorType === "SYSTEM" ? "SYSTEM" : "ADMIN_USER",
        actorId: input.actor.actorId,
        actorName: input.actor.actorName ?? null,
      },
      reason: input.reason,
    },
    undefined
  ).catch(() => undefined);

  return { refundId, status: String(json.status ?? "pending"), amountMinor: requested, refundedTotalMinor: nextRefunded };
}

/**
 * Verify a Stripe webhook signature (t=timestamp,v1=signature) with a 5 minute
 * tolerance. Never trusts the browser success page for payment status.
 */
export function verifyStripeSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string | undefined
): { valid: boolean; reason?: string } {
  if (!secret) return { valid: false, reason: "STRIPE_WEBHOOK_SECRET not configured" };
  if (!signatureHeader) return { valid: false, reason: "Missing Stripe-Signature header" };

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => p.split("=") as [string, string])
  );
  const timestamp = parts["t"];
  const provided = parts["v1"];
  if (!timestamp || !provided) return { valid: false, reason: "Malformed signature header" };

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return { valid: false, reason: "Timestamp outside tolerance" };

  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return { valid: false, reason: "Signature mismatch" };
  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: "Signature mismatch" };
}
