import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { setIntegrationState } from "./integrationHealth.server";
import { persistPaymentMethodFromSetupIntent } from "./sellerBilling.server";
import { redactSecrets, stripeSecretKey } from "./credentials.server";
import { assertNotDisabled, stripeKeyKindProblem, stripeMode } from "./stripeMode.server";

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

function mapStripeStatus(status: string): string {
  switch (status) {
    case "requires_payment_method":
      return "REQUIRES_PAYMENT";
    case "requires_action":
    case "requires_confirmation":
      return "REQUIRES_ACTION";
    case "processing":
      return "PROCESSING";
    case "succeeded":
      return "SUCCEEDED";
    case "canceled":
      return "CANCELLED";
    default:
      return "REQUIRES_PAYMENT";
  }
}

interface StripeIntent {
  id: string;
  client_secret?: string;
  status: string;
}

async function createStripeIntent(
  amount: number,
  currency: string,
  orderId: string,
  idempotencyKey: string
): Promise<StripeIntent> {
  const key = await stripeSecretKey();
  if (!key) throw new Error("Stripe is not configured; no secret key resolves.");

  const params = new URLSearchParams({
    amount: String(amount),
    currency: currency.toLowerCase(),
    "metadata[orderId]": orderId,
    "automatic_payment_methods[enabled]": "true",
  });
  const res = await fetch(`${STRIPE_API}/payment_intents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body: params,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error?.message || `Stripe error ${res.status}`);
  }
  return json as StripeIntent;
}

/**
 * Create (or reuse) the wholesale payment for an order. Idempotent: the row is
 * keyed by order and carries a stable provider idempotency key so retries never
 * double-charge.
 */
export async function createOrReuseWholesalePayment(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { wholesalePayment: true, seller: true },
  });
  if (!order) throw new Error("Order not found.");
  if (order.moonvellaTotal <= 0) throw new Error("Order has no MoonVella amount.");
  if (order.wholesalePayment?.status === "SUCCEEDED") {
    return order.wholesalePayment;
  }

  const idempotencyKey = `wholesale:${order.supplierReference ?? order.id}`;

  const mode = await assertNotDisabled("create a wholesale payment");
  if (mode === "simulated") {
    const payment = await prisma.wholesalePayment.upsert({
      where: { orderId },
      create: {
        orderId,
        sellerId: order.sellerId,
        amount: order.moonvellaTotal,
        currency: order.currency,
        provider: "stripe",
        providerPaymentIntentId: `sim_${order.id}`,
        clientSecret: `sim_secret_${order.id}`,
        status: "REQUIRES_PAYMENT",
        idempotencyKey,
      },
      update: {
        provider: "stripe",
        providerPaymentIntentId: `sim_${order.id}`,
        clientSecret: `sim_secret_${order.id}`,
        status:
          order.wholesalePayment &&
          order.wholesalePayment.status !== "FAILED" &&
          order.wholesalePayment.status !== "CANCELLED"
            ? order.wholesalePayment.status
            : "REQUIRES_PAYMENT",
      },
    });
    await setIntegrationState("stripe", {
      status: "NOT_CONFIGURED",
      detail:
        "Simulated mode: Stripe is in simulated mode, so no provider intent was created. Payment records are local simulations only, are not real charges, and are not bookable as shipments.",
    });
    return payment;
  }

  const intent = await createStripeIntent(
    order.moonvellaTotal,
    order.currency,
    order.id,
    idempotencyKey
  );

  const payment = await prisma.wholesalePayment.upsert({
    where: { orderId },
    create: {
      orderId,
      sellerId: order.sellerId,
      amount: order.moonvellaTotal,
      currency: order.currency,
      provider: "stripe",
      providerPaymentIntentId: intent.id,
      clientSecret: intent.client_secret ?? null,
      status: mapStripeStatus(intent.status) as never,
      idempotencyKey,
    },
    update: {
      providerPaymentIntentId: intent.id,
      clientSecret: intent.client_secret ?? null,
      status: mapStripeStatus(intent.status) as never,
    },
  });

  await setIntegrationState("stripe", {
    status: "HEALTHY",
    detail: `Stripe ${mode} mode accepted an authenticated request. Payment intent ${intent.id}.`,
  });

  return payment;
}

type StripeEvent = {
  id: string;
  type: string;
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

/** Apply a verified provider event. Idempotent by provider event id. */
export async function applyStripeEvent(event: StripeEvent): Promise<ApplyStripeEventResult> {
  const existing = await prisma.paymentEvent.findUnique({ where: { eventId: event.id } });
  if (existing) {
    return { duplicate: true, status: existing.status };
  }

  const object = event.data?.object ?? {};

  if (isSetupEvent(event.type, object)) {
    return applySetupEvent(event, object);
  }

  const intentId = resolveIntentId(event.type, object);
  const metadataOrderId = (object.metadata as Record<string, unknown> | undefined)?.orderId;
  const ref = intentId || String(metadataOrderId ?? "");

  let payment = intentId
    ? await prisma.wholesalePayment.findUnique({ where: { providerPaymentIntentId: intentId } })
    : null;
  if (!payment && metadataOrderId) {
    payment = await prisma.wholesalePayment.findUnique({ where: { orderId: String(metadataOrderId) } });
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
    await tx.wholesalePayment.update({
      where: { id: payment!.id },
      data: {
        status: status as never,
        failureMessage,
        paidAt: status === "SUCCEEDED" ? (payment!.paidAt ?? new Date()) : payment!.paidAt,
        ...(refundedAmount !== null ? { refundedAmount } : {}),
        ...(chargeId ? { providerChargeId: chargeId } : {}),
      },
    });
    await tx.order.update({
      where: { id: payment!.orderId },
      data: { wholesalePaymentStatus: orderStatus as never },
    });
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
