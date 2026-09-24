import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import { assertNotDisabled, assertProviderId, requireStripeProvider } from "./stripeMode.server";

const STRIPE_API = "https://api.stripe.com/v1";

/**
 * Exactly one slash between the API base URL and the endpoint path, whatever the
 * caller passes.
 *
 * This join used to be `${STRIPE_API}${path}`, which reads correctly and is
 * wrong: the base carries no trailing slash and no caller supplies a leading
 * one, so every request went out as `/v1customers`, `/v1checkout/sessions`,
 * `/v1setup_intents/…`. Stripe answers those with `Unrecognized request URL`,
 * which is easy to misread as a bad key or a missing object.
 *
 * `payments.server.ts` was unaffected only because it hardcodes the slash into
 * each template literal — which is precisely why Stripe authentication passed
 * while these paths were dead, and why the defect survived so long.
 *
 * Normalising here rather than at each call site means a future caller cannot
 * reintroduce it. The assertion afterwards is deliberate belt-and-braces: the
 * failure mode is silent and misdiagnosable, so a malformed URL should stop the
 * request loudly rather than produce a confusing response.
 */
export function stripeUrl(path: string): string {
  const base = STRIPE_API.replace(/\/+$/, "");
  const suffix = String(path ?? "").replace(/^\/+/, "");
  if (!suffix) throw new Error("Stripe request path is empty.");
  const url = `${base}/${suffix}`;
  if (!url.startsWith("https://api.stripe.com/v1/")) {
    throw new Error(`Refusing to send a malformed Stripe URL: ${url}`);
  }
  return url;
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

/**
 * The one place a request leaves this module for Stripe. Both helpers below go
 * through it, so neither the mode gate nor the URL join can be bypassed by a
 * future caller.
 *
 * The mode gate is checked HERE rather than at each call site on purpose: a call
 * site is a place someone can forget, and forgetting it means a real HTTP request
 * to a live account. `requireStripeProvider` returns the key only when the mode
 * permits the call, so there is no path that reads the key and skips the check.
 */
async function stripeRequest(
  method: "GET" | "POST",
  path: string,
  options: { params?: URLSearchParams; idempotencyKey?: string } = {}
) {
  const { params, idempotencyKey } = options;
  const { key } = await requireStripeProvider(`${method} /v1/${String(path).replace(/^\/+/, "")}`);
  const res = await fetch(stripeUrl(path), {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(params ? { body: params } : {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || `Stripe error ${res.status}`);
  return json;
}

async function stripeForm(path: string, params: URLSearchParams, idempotencyKey?: string) {
  return stripeRequest("POST", path, { params, idempotencyKey });
}

/** Read-only Stripe retrieve. Setup intent retrieval is a GET, not a POST. */
async function stripeGet(path: string) {
  return stripeRequest("GET", path);
}

/** Provider-hosted setup so raw card details never touch our servers. */
export async function createSetupSession(sellerId: string, returnUrl: string) {
  const mode = await assertNotDisabled("create a payment-method setup session");
  if (mode === "simulated") {
    return {
      simulated: true,
      mode,
      url: `${returnUrl}?simulated_setup=1`,
      detail:
        "Simulated payment-method setup: Stripe is in simulated mode (no secret key resolves), so no " +
        "provider session exists. In test mode this returns a real Stripe Checkout setup URL.",
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
  const mode = await assertNotDisabled("save a payment method from a setup intent");
  if (mode === "simulated") {
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
  // A simulated id here means a simulated setup leaked into a provider call.
  // Stripe would answer 404 and it would read like a missing object.
  const intentId = assertProviderId(setupIntentId, "setup intent", "save a payment method");
  const intent = await stripeGet(`setup_intents/${intentId}`);
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
  const intentId = assertProviderId(
    setupIntentId,
    "setup intent",
    "persist a payment method from a webhook event"
  );
  const intent = await stripeGet(`setup_intents/${intentId}`);
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
    /*
     * THIS GUARD NOW ACTUALLY RUNS, AND IT DID NOT BEFORE.
     *
     * `shippingAmount` used to be null on every payment row, so this compared 0
     * against the limit and let everything through — a seller who set a maximum
     * shipping charge had a limit that could never be reached and never held
     * anything. The column is now written when the bill is made (see
     * `orderIntake.server.ts`), so an order whose seller shipping charge is over
     * the seller's own limit is HELD FOR REVIEW instead of charged automatically.
     *
     * Holding is the safe direction and the one the setting asks for: nothing is
     * charged, an operator is told why, and a person decides. The seller can
     * still pay it manually.
     *
     * Rows written before the column was populated keep their null and read as
     * zero here, exactly as they did — an old order is not retroactively held
     * for a limit it was never measured against.
     */
    if (settings.maxShippingCharge && (payment.shippingAmount ?? 0) > settings.maxShippingCharge) {
      await prisma.sellerBillingSettings.update({ where: { sellerId: order.sellerId }, data: { holdForReview: true } });
      return { ok: false, status: "REQUIRES_PAYMENT", heldForReview: true, error: "Shipping exceeds the authorized maximum; held for review." };
    }
  }

  const method = await getDefaultPaymentMethod(order.sellerId);
  if (!method) {
    return { ok: false, status: "REQUIRES_PAYMENT", error: "No saved payment method. Add one in Billing settings." };
  }

  const mode = await assertNotDisabled("charge a wholesale order");
  if (mode === "simulated") {
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
      actorType: "ADMIN_USER",
      actorId: opts.actor.actorId,
      actorName: opts.actor.actorName,
      action: "payment.charge_succeeded",
      entityType: AUDIT_ENTITY.PAYMENT,
      entityId: payment.id,
      afterData: { status: "PROCESSING", trigger: opts.trigger, simulated: true },
    });
    return { ok: true, status: "PROCESSING", paymentIntentId: payment.providerPaymentIntentId ?? undefined };
  }

  // Both ids must be Stripe's own. A `sim_pm_…` reaching this line would mean a
  // simulated method was used to attempt a real charge against a live account.
  const customerId = assertProviderId(
    method.stripeCustomerId ?? "",
    "customer",
    "charge a wholesale order"
  );
  const paymentMethodId = assertProviderId(
    method.stripePaymentMethodId ?? "",
    "payment method",
    "charge a wholesale order"
  );

  const params = new URLSearchParams({
    amount: String(payment.amount),
    currency: (payment.currency || "CAD").toLowerCase(),
    customer: customerId,
    payment_method: paymentMethodId,
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
      actorType: "ADMIN_USER",
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
      actorType: "ADMIN_USER",
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
