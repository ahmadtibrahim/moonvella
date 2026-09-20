import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";

const STRIPE_API = "https://api.stripe.com/v1";

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

export async function getBillingSettings(sellerId: string) {
  return prisma.sellerBillingSettings.upsert({
    where: { sellerId },
    create: { sellerId },
    update: {},
  });
}

export interface BillingActor {
  actorId: string;
  actorName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function billingSnapshot(row: {
  mode: string;
  autoPayEnabled: boolean;
  maxAmountPerOrder: number | null;
  maxShippingCharge: number | null;
  preferredShippingPolicy: string | null;
  holdForReview: boolean;
  autoBookShipment: boolean;
}) {
  return {
    mode: row.mode,
    autoPayEnabled: row.autoPayEnabled,
    maxAmountPerOrder: row.maxAmountPerOrder,
    maxShippingCharge: row.maxShippingCharge,
    preferredShippingPolicy: row.preferredShippingPolicy,
    holdForReview: row.holdForReview,
    autoBookShipment: row.autoBookShipment,
  };
}

export async function updateBillingSettings(
  sellerId: string,
  input: {
    mode?: "MANUAL" | "AUTOMATIC";
    autoPayEnabled?: boolean;
    maxAmountPerOrder?: number | null;
    maxShippingCharge?: number | null;
    preferredShippingPolicy?: string | null;
    holdForReview?: boolean;
    autoBookShipment?: boolean;
  },
  actor?: BillingActor
) {
  const before = await prisma.sellerBillingSettings.findUnique({ where: { sellerId } });
  const settings = await prisma.sellerBillingSettings.upsert({
    where: { sellerId },
    create: { sellerId, ...input } as never,
    update: input as never,
  });
  await recordAudit({
    actorType: "MERCHANT",
    actorId: actor?.actorId ?? sellerId,
    actorName: actor?.actorName ?? null,
    action: "billing.settings_updated",
    entityType: AUDIT_ENTITY.BILLING_SETTINGS,
    entityId: sellerId,
    beforeData: before ? billingSnapshot(before) : null,
    afterData: billingSnapshot(settings),
    ipAddress: actor?.ipAddress,
    userAgent: actor?.userAgent,
  });
  return settings;
}

/** Mark one payment method as the seller's default and audit the change. */
export async function setDefaultPaymentMethod(
  sellerId: string,
  methodId: string,
  actor?: BillingActor
) {
  const method = await prisma.sellerPaymentMethod.findFirst({ where: { id: methodId, sellerId } });
  if (!method) throw new Error("Payment method not found.");
  await prisma.$transaction([
    prisma.sellerPaymentMethod.updateMany({ where: { sellerId }, data: { isDefault: false } }),
    prisma.sellerPaymentMethod.update({ where: { id: methodId }, data: { isDefault: true } }),
  ]);
  await recordAudit({
    actorType: "MERCHANT",
    actorId: actor?.actorId ?? sellerId,
    actorName: actor?.actorName ?? null,
    action: "payment_method.default_set",
    entityType: AUDIT_ENTITY.PAYMENT_METHOD,
    entityId: methodId,
    beforeData: { isDefault: method.isDefault },
    afterData: { isDefault: true },
    ipAddress: actor?.ipAddress,
    userAgent: actor?.userAgent,
  });
  return { id: methodId, isDefault: true };
}

/** Soft-remove a payment method and audit the change. */
export async function removePaymentMethod(
  sellerId: string,
  methodId: string,
  actor?: BillingActor
) {
  const method = await prisma.sellerPaymentMethod.findFirst({ where: { id: methodId, sellerId } });
  if (!method) throw new Error("Payment method not found.");
  await prisma.sellerPaymentMethod.update({
    where: { id: methodId },
    data: { status: "REMOVED", isDefault: false },
  });
  await recordAudit({
    actorType: "MERCHANT",
    actorId: actor?.actorId ?? sellerId,
    actorName: actor?.actorName ?? null,
    action: "payment_method.removed",
    entityType: AUDIT_ENTITY.PAYMENT_METHOD,
    entityId: methodId,
    beforeData: { status: method.status, isDefault: method.isDefault },
    afterData: { status: "REMOVED", isDefault: false },
    ipAddress: actor?.ipAddress,
    userAgent: actor?.userAgent,
  });
  return { id: methodId, status: "REMOVED" };
}

export async function listPaymentMethods(sellerId: string) {
  return prisma.sellerPaymentMethod.findMany({
    where: { sellerId, status: "ACTIVE" },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
}

export async function getDefaultPaymentMethod(sellerId: string) {
  return prisma.sellerPaymentMethod.findFirst({
    where: { sellerId, status: "ACTIVE" },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
}

async function stripeForm(path: string, params: URLSearchParams, idempotencyKey?: string) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: params,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `Stripe error ${res.status}`);
  return json;
}

/** Read-only Stripe retrieve. Setup intent retrieval is a GET, not a POST. */
async function stripeGet(path: string) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `Stripe error ${res.status}`);
  return json;
}

/** Provider-hosted setup so raw card details never touch our servers. */
export async function createSetupSession(sellerId: string, returnUrl: string) {
  if (!stripeConfigured()) {
    return {
      simulated: true,
      url: `${returnUrl}?simulated_setup=1`,
      detail:
        "Simulated payment-method setup (no STRIPE_SECRET_KEY). In real mode this returns a Stripe Checkout setup URL.",
    };
  }
  const seller = await prisma.seller.findUnique({ where: { id: sellerId } });
  let customerId = (
    await prisma.sellerPaymentMethod.findFirst({ where: { sellerId, stripeCustomerId: { not: null } } })
  )?.stripeCustomerId;

  if (!customerId) {
    const customer = await stripeForm(
      "customers",
      new URLSearchParams({ email: seller?.contactEmail ?? "" }),
      `customer:${sellerId}`
    );
    customerId = customer.id;
  }

  const params = new URLSearchParams({
    mode: "setup",
    "payment_method_types[0]": "card",
    customer: customerId ?? "",
    "metadata[sellerId]": sellerId,
    "setup_intent_data[metadata][sellerId]": sellerId,
    success_url: `${returnUrl}?setup=success`,
    cancel_url: `${returnUrl}?setup=cancelled`,
  });
  const session = await stripeForm("checkout/sessions", params, `setup:${sellerId}:${Date.now()}`);
  return { simulated: false, url: session.url as string, sessionId: session.id as string, customerId };
}

interface PaymentMethodDetails {
  sellerId: string;
  stripeCustomerId: string | null;
  stripePaymentMethodId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/** Make a saved method the seller's default and audit the addition. */
async function upsertPaymentMethod(
  details: PaymentMethodDetails,
  actor: BillingActor | undefined,
  simulated: boolean,
  actorType: "MERCHANT" | "WEBHOOK" = "MERCHANT"
) {
  await prisma.sellerPaymentMethod.updateMany({ where: { sellerId: details.sellerId }, data: { isDefault: false } });
  const method = await prisma.sellerPaymentMethod.upsert({
    where: { stripePaymentMethodId: details.stripePaymentMethodId },
    create: {
      sellerId: details.sellerId,
      provider: "stripe",
      stripeCustomerId: details.stripeCustomerId,
      stripePaymentMethodId: details.stripePaymentMethodId,
      brand: details.brand,
      last4: details.last4,
      expMonth: details.expMonth,
      expYear: details.expYear,
      isDefault: true,
      authorizationConsentAt: new Date(),
    },
    update: { status: "ACTIVE", authorizationConsentAt: new Date(), isDefault: true },
  });
  await auditPaymentMethodAdded(method, details.sellerId, actor, simulated, actorType);
  return method;
}

/** Persist an authorized payment method after the hosted setup completes. */
export async function savePaymentMethodFromSetupIntent(
  sellerId: string,
  setupIntentId: string,
  actor?: BillingActor
) {
  if (!stripeConfigured()) {
    return upsertPaymentMethod(
      {
        sellerId,
        stripeCustomerId: null,
        stripePaymentMethodId: `sim_pm_${setupIntentId}`,
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2030,
      },
      actor,
      true
    );
  }
  const intent = await stripeGet(`setup_intents/${setupIntentId}`);
  const pmId = String(intent.payment_method ?? "");
  if (!pmId) throw new Error("Setup intent has no payment method yet.");
  const pm = await stripeGet(`payment_methods/${pmId}`);

  return upsertPaymentMethod(
    {
      sellerId,
      stripeCustomerId: String(intent.customer ?? "") || null,
      stripePaymentMethodId: pmId,
      brand: pm?.card?.brand ?? null,
      last4: pm?.card?.last4 ?? null,
      expMonth: pm?.card?.exp_month ?? null,
      expYear: pm?.card?.exp_year ?? null,
    },
    actor,
    false
  );
}

/**
 * Persist a saved payment method from a verified Stripe setup event. Resolves
 * the seller from the setup-intent metadata (set by createSetupSession) with a
 * caller-supplied fallback. Used by the setup_intent.succeeded /
 * checkout.session.completed webhook path.
 */
export async function persistPaymentMethodFromSetupIntent(
  setupIntentId: string,
  fallbackSellerId?: string | null,
  fallbackCustomerId?: string | null,
  actor?: BillingActor & { actorType?: "MERCHANT" | "WEBHOOK" }
) {
  if (!stripeConfigured()) throw new Error("Stripe is not configured.");
  const intent = await stripeGet(`setup_intents/${setupIntentId}`);
  const metadata = (intent.metadata ?? {}) as Record<string, unknown>;
  const sellerId = String(metadata.sellerId ?? fallbackSellerId ?? "");
  if (!sellerId) throw new Error("Setup intent is missing sellerId metadata.");
  const pmId = String(intent.payment_method ?? "");
  if (!pmId) throw new Error("Setup intent has no payment method yet.");
  const pm = await stripeGet(`payment_methods/${pmId}`);

  return upsertPaymentMethod(
    {
      sellerId,
      stripeCustomerId: String(intent.customer ?? fallbackCustomerId ?? "") || null,
      stripePaymentMethodId: pmId,
      brand: pm?.card?.brand ?? null,
      last4: pm?.card?.last4 ?? null,
      expMonth: pm?.card?.exp_month ?? null,
      expYear: pm?.card?.exp_year ?? null,
    },
    actor,
    false,
    actor?.actorType ?? "WEBHOOK"
  );
}

async function auditPaymentMethodAdded(
  method: { id: string; brand: string | null; last4: string | null; isDefault: boolean },
  sellerId: string,
  actor: BillingActor | undefined,
  simulated: boolean,
  actorType: "MERCHANT" | "WEBHOOK" = "MERCHANT"
) {
  await recordAudit({
    actorType,
    actorId: actor?.actorId ?? sellerId,
    actorName: actor?.actorName ?? null,
    action: "payment_method.added",
    entityType: AUDIT_ENTITY.PAYMENT_METHOD,
    entityId: method.id,
    afterData: {
      brand: method.brand,
      last4: method.last4,
      isDefault: method.isDefault,
      simulated,
    },
    ipAddress: actor?.ipAddress,
    userAgent: actor?.userAgent,
  });
}

export interface ChargeResult {
  ok: boolean;
  status: string;
  requiresAction?: boolean;
  paymentIntentId?: string;
  error?: string;
  heldForReview?: boolean;
}

/**
 * Charge a wholesale order. Used by BOTH manual (seller-initiated) and automatic
 * modes. Never marks the order paid from the UI — status comes from provider
 * events/reconciliation. Enforces the seller's authorization limits for
 * automatic charges and uses idempotency to prevent duplicate charges.
 */
export async function chargeWholesaleOrder(
  orderId: string,
  opts: { trigger: "MANUAL" | "AUTOMATIC"; actor: { actorId: string; actorName?: string | null } }
): Promise<ChargeResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { wholesalePayment: true, seller: true },
  });
  if (!order) return { ok: false, status: "FAILED", error: "Order not found." };
  if (!order.wholesalePayment) return { ok: false, status: "FAILED", error: "No wholesale payment record." };
  if (order.wholesalePayment.status === "SUCCEEDED") {
    return { ok: true, status: "SUCCEEDED", paymentIntentId: order.wholesalePayment.providerPaymentIntentId ?? undefined };
  }

  const settings = await getBillingSettings(order.sellerId);
  const payment = order.wholesalePayment;

  // Automatic charges must be within the seller's recorded authorization.
  if (opts.trigger === "AUTOMATIC") {
    if (!settings.autoPayEnabled || settings.mode !== "AUTOMATIC") {
      return { ok: false, status: "REQUIRES_PAYMENT", error: "Seller has not enabled automatic payment." };
    }
    if (settings.maxAmountPerOrder && payment.amount > settings.maxAmountPerOrder) {
      await prisma.sellerBillingSettings.update({ where: { sellerId: order.sellerId }, data: { holdForReview: true } });
      return { ok: false, status: "REQUIRES_PAYMENT", heldForReview: true, error: "Order total exceeds the authorized maximum; held for review." };
    }
    if (settings.maxShippingCharge && (payment.shippingAmount ?? 0) > settings.maxShippingCharge) {
      await prisma.sellerBillingSettings.update({ where: { sellerId: order.sellerId }, data: { holdForReview: true } });
      return { ok: false, status: "REQUIRES_PAYMENT", heldForReview: true, error: "Shipping exceeds the authorized maximum; held for review." };
    }
  }

  const method = await getDefaultPaymentMethod(order.sellerId);
  if (!method) {
    return { ok: false, status: "REQUIRES_PAYMENT", error: "No saved payment method. Add one in Billing settings." };
  }

  if (!stripeConfigured()) {
    // Simulated charge: records an attempt and leaves confirmation to a verified event.
    await prisma.paymentAttempt.create({
      data: {
        paymentId: payment.id,
        provider: "stripe",
        providerPaymentIntentId: payment.providerPaymentIntentId,
        status: "PROCESSING",
        amount: payment.amount,
      },
    });
    await prisma.wholesalePayment.update({
      where: { id: payment.id },
      data: { billingMode: opts.trigger, paymentMethodId: method.id, status: "PROCESSING" },
    });
    await recordAudit({
      actorType: "OWNER_USER",
      actorId: opts.actor.actorId,
      actorName: opts.actor.actorName,
      action: "payment.charge_succeeded",
      entityType: AUDIT_ENTITY.PAYMENT,
      entityId: payment.id,
      afterData: { status: "PROCESSING", trigger: opts.trigger, simulated: true },
    });
    return { ok: true, status: "PROCESSING", paymentIntentId: payment.providerPaymentIntentId ?? undefined };
  }

  const params = new URLSearchParams({
    amount: String(payment.amount),
    currency: (payment.currency || "CAD").toLowerCase(),
    customer: method.stripeCustomerId ?? "",
    payment_method: method.stripePaymentMethodId ?? "",
    off_session: "true",
    confirm: "true",
    "metadata[orderId]": orderId,
  });

  try {
    const intent = await stripeForm("payment_intents", params, `charge:${orderId}`);
    const requiresAction = intent.status === "requires_action";
    await prisma.paymentAttempt.create({
      data: {
        paymentId: payment.id,
        provider: "stripe",
        providerPaymentIntentId: intent.id,
        status: requiresAction ? "REQUIRES_ACTION" : String(intent.status).toUpperCase(),
        requiresAction,
        amount: payment.amount,
      },
    });
    await prisma.wholesalePayment.update({
      where: { id: payment.id },
      data: {
        providerPaymentIntentId: intent.id,
        billingMode: opts.trigger,
        paymentMethodId: method.id,
        requiresAction,
        status: requiresAction ? "REQUIRES_ACTION" : "PROCESSING",
      },
    });
    await recordAudit({
      actorType: "OWNER_USER",
      actorId: opts.actor.actorId,
      actorName: opts.actor.actorName,
      action: "payment.charge_succeeded",
      entityType: AUDIT_ENTITY.PAYMENT,
      entityId: payment.id,
      afterData: {
        status: requiresAction ? "REQUIRES_ACTION" : "PROCESSING",
        requiresAction,
        paymentIntentId: intent.id,
        trigger: opts.trigger,
      },
    });
    return { ok: true, status: requiresAction ? "REQUIRES_ACTION" : "PROCESSING", requiresAction, paymentIntentId: intent.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "charge failed";
    await prisma.paymentAttempt.create({
      data: { paymentId: payment.id, provider: "stripe", status: "FAILED", failureMessage: message, amount: payment.amount },
    });
    await prisma.wholesalePayment.update({ where: { id: payment.id }, data: { status: "FAILED", failureMessage: message } });
    await recordAudit({
      actorType: "OWNER_USER",
      actorId: opts.actor.actorId,
      actorName: opts.actor.actorName,
      action: "payment.failed",
      entityType: AUDIT_ENTITY.PAYMENT,
      entityId: payment.id,
      afterData: { message, trigger: opts.trigger },
    });
    return { ok: false, status: "FAILED", error: message };
  }
}
