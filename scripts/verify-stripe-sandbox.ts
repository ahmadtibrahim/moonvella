/**
 * Stripe sandbox verification — the only suite permitted to reach Stripe.
 *
 * Why this is separate from verify-wholesale / verify-payments / verify-e2e
 *
 * Those three test the internal payment logic. They used to decide for
 * themselves whether to simulate, by asking "is a secret key saved?" — so the
 * day a real sandbox key was entered in Settings they stopped simulating, left
 * the simulated branch, and started sending fabricated `sim_seti_…` ids to
 * Stripe. The suites passed or failed according to what an operator had typed
 * into a form. They are now pinned to MOONVELLA_STRIPE_MODE=simulated and make
 * no external call at all.
 *
 * This suite is the opposite trade: it runs in test mode and creates REAL
 * objects at Stripe, using the ids Stripe returns. Nothing here is stubbed, and
 * nothing here is invented.
 *
 * What it deliberately does NOT do
 *
 *   - No live key, ever. `MOONVELLA_STRIPE_MODE=test` plus the mode gate makes a
 *     live charge unreachable from this file even if a live key is later saved.
 *   - No browser. A hosted Checkout session must be completed by a human, so the
 *     session is CREATED and inspected, and the completion path it feeds —
 *     SetupIntent -> saved payment method -> seller — is driven with a real
 *     SetupIntent instead. The report says which half was verified.
 *   - No shipment booking. Booking is never implied by a payment; it has exactly
 *     one caller, an explicit operator action.
 *
 * Runs against the isolated verify database (see deployment/verify-db.sh), so
 * the sandbox objects it creates belong to throwaway sellers.
 */
import { PrismaClient } from "@prisma/client";
import { createHmac } from "node:crypto";
import {
  stripeUrl,
  createSetupSession,
  persistPaymentMethodFromSetupIntent,
  chargeWholesaleOrder,
} from "../app/services/sellerBilling.server";
import {
  createOrReuseWholesalePayment,
  testStripeAuthentication,
  applyStripeEvent,
} from "../app/services/payments.server";
import {
  requireStripeProvider,
  stripeMode,
  classifyStripeKey,
  providerRefusal,
  assertProviderId,
  isSimulatedId,
} from "../app/services/stripeMode.server";
import { stripeWebhookSecret } from "../app/services/credentials.server";
import { action as stripeWebhookAction } from "../app/routes/webhooks.stripe";

const prisma = new PrismaClient();
const SHOP = "stripe-sandbox-test.myshopify.com";
const PAY_SHOP = "stripe-sandbox-pay.myshopify.com";

let failures = 0;
let total = 0;
let skipped = 0;

function check(name: string, pass: boolean, detail = "") {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name: string, why: string) {
  skipped++;
  console.log(`SKIP  ${name} — ${why}`);
}

/** Every Stripe URL this run actually put on the wire. */
const requestUrls: string[] = [];

/**
 * The subset of a Stripe object this suite reads. Stripe returns far more, and
 * typing only what is read keeps a misspelt field (`intent.staus`) a compile
 * error rather than an undefined that quietly fails an assertion.
 */
interface StripeObject {
  id?: string;
  status?: string;
  customer?: string;
  url?: string;
  livemode?: boolean;
  enabled_events?: string[];
  data?: StripeObject[];
  error?: { message?: string };
}

/**
 * A raw sandbox call, used only to build fixtures — the objects Stripe returns
 * are then handed to the application's own functions below.
 *
 * It builds its URL with the application's `stripeUrl`, which is the function
 * under test: a malformed join fails here on the first call rather than showing
 * up as a confusing 404 later.
 */
async function stripe(path: string, params?: Record<string, string>): Promise<StripeObject> {
  const { key, mode } = await requireStripeProvider(`sandbox fixture ${path}`);
  if (mode !== "test") {
    throw new Error(`Refusing: the sandbox suite must run in test mode, but the mode is "${mode}".`);
  }
  const url = stripeUrl(path);
  requestUrls.push(url);
  const res = await fetch(url, {
    method: params ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(params ? { body: new URLSearchParams(params) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as StripeObject;
  if (!res.ok) {
    throw new Error(`Stripe ${res.status} on ${url}: ${json.error?.message ?? "unknown error"}`);
  }
  return json;
}

/** Sign a payload exactly as Stripe does, so the real handler can verify it. */
function signPayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function deliverWebhook(payload: string, secret: string, timestamp?: number) {
  const request = new Request("https://admin.moonvella.com/webhooks/stripe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signPayload(payload, secret, timestamp),
    },
    body: payload,
  });
  return stripeWebhookAction({ request } as never);
}

let seq = 0;
/**
 * Per-run suffix. `createOrReuseWholesalePayment` derives its Stripe
 * Idempotency-Key from `supplierReference`, so a fixture that reuses the same
 * reference across runs replays the previous run's key with different parameters
 * — which Stripe rejects outright rather than treating as a replay. Real
 * references are `${shopDomain}#${orderName}` and unique per order.
 */
const RUN = Date.now().toString(36);

async function makeOrder(sellerId: string, total = 2598) {
  seq++;
  return prisma.order.create({
    data: {
      sellerId,
      shopifyOrderId: `sbx-${seq}`,
      shopifyOrderName: `#SBX${seq}`,
      shopifyOrderNumber: seq,
      currency: "CAD",
      customerName: "Retail Customer",
      shippingAddress: JSON.stringify({
        name: "Retail Customer",
        address1: "500 Queen St W",
        city: "Toronto",
        province: "ON",
        zip: "M5V 2T6",
        country: "CA",
        residential: true,
      }),
      subtotal: total,
      totalTax: 0,
      totalShipping: 0,
      totalDiscounts: 0,
      totalPrice: total,
      moonvellaSubtotal: total,
      moonvellaTax: 0,
      moonvellaShipping: 0,
      moonvellaDiscounts: 0,
      moonvellaTotal: total,
      paymentStatus: "PAID",
      fulfillmentStatus: "PENDING",
      shopifyCreatedAt: new Date(),
      shopifyUpdatedAt: new Date(),
      supplierReference: `${SHOP}#SBX${RUN}-${seq}`,
      items: {
        create: [
          {
            name: "Hotel Pillow",
            sku: "MV-HP-001",
            quantity: 2,
            price: 4900,
            wholesalePrice: 1299,
            totalDiscount: 0,
            shopifyLineItemId: `li${seq}`,
          },
        ],
      },
      packages: {
        create: [{ count: 1, length: 40, width: 30, height: 20, weight: 2.5, units: "cm_kg" }],
      },
      fulfillmentRequest: { create: {} },
    },
  });
}

/**
 * Event ids this run caused to be written. The webhook path creates PaymentEvent
 * rows with no paymentId, so they are not reachable through the seller and have
 * to be deleted by id.
 */
const createdEventIds: string[] = [];

async function cleanupSeller(shopDomain: string) {
  const seller = await prisma.seller.findUnique({ where: { shopDomain } });
  if (!seller) return;
  const orders = await prisma.order.findMany({ where: { sellerId: seller.id }, select: { id: true } });
  const ids = orders.map((o) => o.id);
  await prisma.paymentEvent.deleteMany({ where: { payment: { sellerId: seller.id } } });
  await prisma.paymentAttempt.deleteMany({ where: { payment: { sellerId: seller.id } } });
  await prisma.wholesalePayment.deleteMany({ where: { sellerId: seller.id } });
  await prisma.shippingQuote.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.shipmentItem.deleteMany({ where: { shipment: { orderId: { in: ids } } } });
  await prisma.shipment.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.orderPackage.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.fulfillmentRequest.deleteMany({ where: { orderId: { in: ids } } });
  await prisma.order.deleteMany({ where: { sellerId: seller.id } });
  if (createdEventIds.length) {
    await prisma.paymentEvent.deleteMany({ where: { eventId: { in: createdEventIds } } });
  }
  await prisma.sellerPaymentMethod.deleteMany({ where: { sellerId: seller.id } });
  await prisma.sellerBillingSettings.deleteMany({ where: { sellerId: seller.id } });
  await prisma.seller.delete({ where: { id: seller.id } });
}

async function main() {
  const mode = await stripeMode();
  console.log(`stripe mode: ${mode}`);

  if (mode !== "test") {
    skip("stripe-sandbox", `mode is "${mode}"; a sandbox key (sk_test_…) is required`);
    console.log(`\n=== ${total - failures}/${total} checks passed (${skipped} skipped) ===`);
    process.exit(0);
  }

  // ---------------------------------------------------------------- A. URL join
  console.log("\n-- A. Stripe URL construction ------------------------------------------");

  // The exact paths every call site in sellerBilling.server.ts hands to the
  // join. Each produced `/v1…` before the fix, which Stripe rejects with
  // "Unrecognized request URL".
  const callerPaths = [
    "customers",
    "checkout/sessions",
    "setup_intents/seti_sandbox_probe",
    "payment_methods/pm_sandbox_probe",
    "payment_intents",
  ];
  const built = callerPaths.map((p) => stripeUrl(p));
  check(
    "every caller path joins with exactly one slash",
    built.every((u, i) => u === `https://api.stripe.com/v1/${callerPaths[i]}`),
    built.find((u, i) => u !== `https://api.stripe.com/v1/${callerPaths[i]}`) ?? "all exact"
  );
  check(
    "no doubled slash anywhere after the scheme",
    built.every((u) => !u.replace("https://", "").includes("//")),
    built.find((u) => u.replace("https://", "").includes("//")) ?? "all clean"
  );
  check(
    "a caller supplying its own leading slash is normalised, not doubled",
    stripeUrl("/customers") === "https://api.stripe.com/v1/customers" &&
      stripeUrl("//customers") === "https://api.stripe.com/v1/customers",
    stripeUrl("/customers")
  );
  let emptyRefused = false;
  try {
    stripeUrl("");
  } catch {
    emptyRefused = true;
  }
  check("an empty path is refused rather than sent", emptyRefused);

  // --------------------------------------------------- B. Mode and gate (no I/O)
  console.log("\n-- B. Mode, gates and fabricated ids -----------------------------------");

  check("a sandbox key classifies as test", classifyStripeKey("sk_test_abc") === "test");
  check("a live key classifies as live", classifyStripeKey("sk_live_abc") === "live");
  check("a restricted live key classifies as live", classifyStripeKey("rk_live_abc") === "live");
  check("an absent key classifies as nothing", classifyStripeKey(null) === null);
  check("an unrecognised value is not guessed at", classifyStripeKey("sk_weird_abc") === null);

  // The live refusal is the one decision that cannot be exercised for real
  // without doing the thing it forbids, so the gate is a pure function and every
  // combination is asserted here instead.
  check(
    "live mode without the explicit opt-in is refused",
    providerRefusal("live", "live", false, "charge", "key-prefix") !== null
  );
  check(
    "live mode WITH the explicit opt-in is permitted",
    providerRefusal("live", "live", true, "charge", "key-prefix") === null
  );
  check(
    "test mode with a live key is refused",
    providerRefusal("test", "live", true, "charge", "override") !== null
  );
  check(
    "test mode with a test key is permitted",
    providerRefusal("test", "test", false, "charge", "override") === null
  );
  check(
    "simulated mode refuses every provider call",
    providerRefusal("simulated", null, false, "charge", "no-key") !== null
  );
  check(
    "disabled mode refuses every provider call",
    providerRefusal("disabled", "test", false, "charge", "disconnect-flag") !== null
  );
  check(
    "a test key in simulated mode still does not call out (mode wins over key presence)",
    providerRefusal("simulated", "test", false, "charge", "override") !== null
  );

  check("a fabricated 'sim_seti_x' id is refused", (() => {
    try {
      assertProviderId("sim_seti_x", "setup intent", "save a payment method");
      return false;
    } catch {
      return true;
    }
  })());
  check("a real Stripe id passes through unchanged", assertProviderId("seti_123", "setup intent", "x") === "seti_123");
  check("isSimulatedId recognises our own ids only", isSimulatedId("sim_pm_1") && !isSimulatedId("pm_1"));

  // ----------------------------------------------------- C. API authentication
  console.log("\n-- C. Stripe API authentication ----------------------------------------");

  const auth = await testStripeAuthentication();
  check("authenticated call to Stripe succeeds", auth.ok === true, auth.reason ?? "ok");
  check("Stripe reports the account as test mode", auth.livemode === false, `livemode=${auth.livemode}`);

  // A correctly-signed request we compose ourselves proves the handler verifies
  // signatures. It does NOT prove Stripe will ever send one. That needs an
  // endpoint registered at Stripe pointing at the deployed handler, which is a
  // separate fact and is asserted separately.
  const endpoints = await stripe("webhook_endpoints");
  const registered = endpoints.data ?? [];
  const DEPLOYED_WEBHOOK = "https://admin.moonvella.com/webhooks/stripe";
  const deployed = registered.find((e) => String(e.url) === DEPLOYED_WEBHOOK);
  check(
    "Stripe has an endpoint registered for the deployed handler",
    Boolean(deployed) && deployed?.status === "enabled",
    deployed
      ? `status=${deployed.status} events=${deployed.enabled_events?.length ?? 0}`
      : `${registered.length} endpoint(s), none at ${DEPLOYED_WEBHOOK}`
  );
  check(
    "the registered endpoint is test-mode, so no live event is routed here",
    deployed?.livemode === false,
    `livemode=${deployed?.livemode}`
  );

  // --------------------------------------------- D. Real sandbox objects + seller
  console.log("\n-- D. Hosted setup, real objects, seller association -------------------");

  // Both fixtures are cleared up front, not only at the end. An earlier crashed
  // run leaves its seller behind, and a suite that can only be run once is worse
  // than no suite: the second run fails on a unique constraint that has nothing
  // to do with the code under test.
  await cleanupSeller(SHOP);
  await cleanupSeller(PAY_SHOP);
  const seller = await prisma.seller.create({
    data: {
      shopDomain: SHOP,
      storeName: "Stripe Sandbox Test Seller",
      shopDomainFull: SHOP,
      contactEmail: "sandbox@test.example",
      status: "APPROVED",
      approvedAt: new Date(),
    },
  });

  // Hosted setup: the session is real, the completion is a human step.
  const setup = await createSetupSession(seller.id, "https://admin.moonvella.com/billing/return");
  const setupUrl = "url" in setup ? String(setup.url) : "";
  check(
    "hosted setup is not marked simulated in test mode",
    (setup as { simulated?: boolean }).simulated === false,
    String((setup as { simulated?: boolean }).simulated)
  );
  check(
    "hosted setup returns a real Stripe Checkout session URL",
    /^https:\/\/checkout\.stripe\.com\//.test(setupUrl) && setupUrl.includes("cs_test_"),
    setupUrl ? setupUrl.split("?")[0] : "no url"
  );
  console.log("    note: completing that checkout is a browser step and is NOT verified here.");

  // The user returned from the hosted page in a real flow; here the SetupIntent
  // it would have produced is created directly, so the persistence path is fed a
  // real id rather than a fabricated one.
  const customer = await stripe("customers", { email: "sandbox@test.example" });
  const intent = await stripe("setup_intents", {
    customer: String(customer.id),
    payment_method: "pm_card_visa",
    confirm: "true",
    usage: "off_session",
    // The sandbox account has redirect-based methods enabled, and Stripe refuses
    // a SetupIntent without a return_url unless redirects are explicitly off.
    // Confirming a saved card off-session is exactly the non-redirect case.
    "automatic_payment_methods[enabled]": "true",
    "automatic_payment_methods[allow_redirects]": "never",
    "metadata[sellerId]": seller.id,
  });
  check(
    "Stripe returned a real SetupIntent id",
    typeof intent.id === "string" && intent.id.startsWith("seti_"),
    String(intent.id)
  );
  check("the SetupIntent succeeded", intent.status === "succeeded", String(intent.status));

  const saved = await persistPaymentMethodFromSetupIntent(String(intent.id), null, String(customer.id), {
    actorId: "sandbox",
    actorName: "Sandbox",
    actorType: "WEBHOOK",
  });
  check(
    "the saved method is associated with the correct seller",
    saved.sellerId === seller.id,
    `seller ${saved.sellerId === seller.id ? "matches" : "MISMATCH"}`
  );
  check(
    "the saved method carries Stripe's own payment-method id",
    String(saved.stripePaymentMethodId).startsWith("pm_") && !isSimulatedId(saved.stripePaymentMethodId),
    String(saved.stripePaymentMethodId)
  );
  check(
    "card details come from Stripe, not from us",
    saved.brand === "visa" && saved.last4 === "4242",
    `${saved.brand} ${saved.last4}`
  );

  // Re-saving the same provider object must update, not duplicate.
  await persistPaymentMethodFromSetupIntent(String(intent.id), null, String(customer.id), {
    actorId: "sandbox",
    actorName: "Sandbox",
    actorType: "WEBHOOK",
  });
  const methodRows = await prisma.sellerPaymentMethod.count({ where: { sellerId: seller.id } });
  check("replaying the same setup does not duplicate the saved method", methodRows === 1, `${methodRows} row(s)`);

  // ------------------------------------------------------ E. Signed webhook path
  console.log("\n-- E. Signed webhook delivery to the deployed handler ------------------");

  const webhookSecret = await stripeWebhookSecret();
  if (!webhookSecret) {
    skip("signed webhook delivery", "no STRIPE_WEBHOOK_SECRET resolves");
  } else {
    const eventId = `evt_sandbox_${Date.now()}`;
    createdEventIds.push(eventId);
    const eventPayload = JSON.stringify({
      id: eventId,
      type: "setup_intent.succeeded",
      data: { object: { id: intent.id, customer: customer.id, metadata: { sellerId: seller.id } } },
    });

    // A success page alone must not establish anything: an unsigned delivery is
    // refused before it reaches applyStripeEvent.
    const unsigned = await stripeWebhookAction({
      request: new Request("https://admin.moonvella.com/webhooks/stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: eventPayload,
      }),
    } as never);
    check("an unsigned delivery is refused", unsigned.status === 400, `HTTP ${unsigned.status}`);

    const tampered = await deliverWebhook(eventPayload, "whsec_not_the_real_secret");
    check("a wrongly-signed delivery is refused", tampered.status === 400, `HTTP ${tampered.status}`);

    const stale = await deliverWebhook(eventPayload, webhookSecret, Math.floor(Date.now() / 1000) - 4000);
    check("a correctly-signed but stale delivery is refused", stale.status === 400, `HTTP ${stale.status}`);

    const accepted = await deliverWebhook(eventPayload, webhookSecret);
    const acceptedBody = await accepted.text();
    check("a correctly-signed delivery is accepted", accepted.status === 200, `HTTP ${accepted.status} ${acceptedBody}`);

    const eventRow = await prisma.paymentEvent.findUnique({ where: { eventId } });
    check("the accepted event is recorded", eventRow?.status === "PROCESSED", String(eventRow?.status));

    // ---------------------------------------------- F. Duplicate prevention
    console.log("\n-- F. Duplicate prevention ---------------------------------------------");

    const before = await prisma.paymentEvent.count({ where: { eventId } });
    const replay = await deliverWebhook(eventPayload, webhookSecret);
    const after = await prisma.paymentEvent.count({ where: { eventId } });
    const methodRowsAfter = await prisma.sellerPaymentMethod.count({ where: { sellerId: seller.id } });
    check("a repeated delivery is accepted, not errored", replay.status === 200, `HTTP ${replay.status}`);
    check("a repeated delivery writes no second event row", before === 1 && after === 1, `${before} -> ${after}`);
    check("a repeated delivery writes no second payment method", methodRowsAfter === 1, `${methodRowsAfter} row(s)`);
  }

  // ------------------------------------------- G. Sandbox payment success/failure
  console.log("\n-- G. Sandbox payment success and failure ------------------------------");

  const seller2 = await prisma.seller.create({
    data: {
      shopDomain: PAY_SHOP,
      storeName: "Stripe Sandbox Pay Seller",
      shopDomainFull: PAY_SHOP,
      contactEmail: "sandbox-pay@test.example",
      status: "APPROVED",
      approvedAt: new Date(),
    },
  });

  const cust2 = await stripe("customers", { email: "sandbox-pay@test.example" });

  // --- success
  const okIntent = await stripe("setup_intents", {
    customer: String(cust2.id),
    payment_method: "pm_card_visa",
    confirm: "true",
    usage: "off_session",
    "automatic_payment_methods[enabled]": "true",
    "automatic_payment_methods[allow_redirects]": "never",
    "metadata[sellerId]": seller2.id,
  });
  await persistPaymentMethodFromSetupIntent(String(okIntent.id), null, String(cust2.id), {
    actorId: "sandbox",
    actorName: "Sandbox",
    actorType: "WEBHOOK",
  });

  const okOrder = await makeOrder(seller2.id);
  const created = await createOrReuseWholesalePayment(okOrder.id);
  check(
    "a real PaymentIntent was created with Stripe's id",
    String(created.providerPaymentIntentId ?? "").startsWith("pi_"),
    String(created.providerPaymentIntentId)
  );

  const actor = { actorId: "sandbox", actorName: "Sandbox" };
  const charged = await chargeWholesaleOrder(okOrder.id, { trigger: "MANUAL", actor });
  check("a sandbox charge is accepted", charged.ok === true, charged.error ?? String(charged.status));

  const attempt = await prisma.paymentAttempt.findFirst({
    where: { payment: { orderId: okOrder.id } },
    orderBy: { createdAt: "desc" },
  });
  check(
    "the attempt records Stripe's PaymentIntent id, not a fabricated one",
    String(attempt?.providerPaymentIntentId ?? "").startsWith("pi_") && !isSimulatedId(attempt?.providerPaymentIntentId),
    String(attempt?.providerPaymentIntentId)
  );

  const orderAfterCharge = await prisma.order.findUnique({ where: { id: okOrder.id } });
  check(
    "a charge alone does not mark the order paid",
    orderAfterCharge?.wholesalePaymentStatus !== "SUCCEEDED",
    String(orderAfterCharge?.wholesalePaymentStatus)
  );

  // The same event delivered twice must be applied once. This is the payment
  // path's own dedupe, separate from the webhook-path check in section F.
  const paidEventId = `evt_sandbox_paid_${okOrder.id}`;
  createdEventIds.push(paidEventId);
  const firstApply = await applyStripeEvent({
    id: paidEventId,
    type: "payment_intent.succeeded",
    data: { object: { id: created.providerPaymentIntentId, metadata: { orderId: okOrder.id } } },
  });
  const secondApply = await applyStripeEvent({
    id: paidEventId,
    type: "payment_intent.succeeded",
    data: { object: { id: created.providerPaymentIntentId, metadata: { orderId: okOrder.id } } },
  });
  check(
    "a repeated payment event is reported as a duplicate",
    secondApply.duplicate === true,
    `first=${JSON.stringify(firstApply)} second=${JSON.stringify(secondApply)}`
  );
  const paidEventRows = await prisma.paymentEvent.count({ where: { eventId: paidEventId } });
  check("the repeated payment event is stored once", paidEventRows === 1, `${paidEventRows} row(s)`);

  // --- failure
  // The declining card has to be built from the raw test number rather than
  // Stripe's shared `pm_card_visa_chargeDeclined`: that object is refused the
  // moment it is used at all, including at attach. 4000 0000 0000 0002 is
  // Stripe's generic-decline test number, and creating and attaching a payment
  // method from it is not an authorization — so the card saves cleanly and then
  // declines when it is actually charged. That is the case worth testing.
  // The account has raw-card-data APIs disabled, and Stripe refuses a card
  // number sent directly — which is the right default and not something to work
  // around. `tok_chargeDeclined` is the documented test token for Stripe's
  // generic-decline card, so the number never passes through this process.
  const declinePm = await stripe("payment_methods", {
    type: "card",
    "card[token]": "tok_chargeDeclined",
  });
  check(
    "a declining test card exists as a real Stripe payment method",
    String(declinePm.id ?? "").startsWith("pm_"),
    String(declinePm.id ?? "no id")
  );
  console.log(
    "    note: this card declines on EVERY use, including attach, so it is saved to\n" +
    "    the seller without being attached. Stripe's own rejection is reported below."
  );

  const declineOrder = await makeOrder(seller2.id);
  await createOrReuseWholesalePayment(declineOrder.id);
  // Point the seller's default method at the declining card, which is a real
  // Stripe payment-method id — not a fabricated one.
  await prisma.sellerPaymentMethod.updateMany({ where: { sellerId: seller2.id }, data: { isDefault: false } });
  await prisma.sellerPaymentMethod.create({
    data: {
      sellerId: seller2.id,
      provider: "stripe",
      stripeCustomerId: String(cust2.id),
      stripePaymentMethodId: String(declinePm.id ?? "pm_card_visa_chargeDeclined"),
      brand: "visa",
      last4: "0002",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
      status: "ACTIVE",
      authorizationConsentAt: new Date(),
    },
  });

  let declineMessage = "";
  let declined = false;
  try {
    const result = await chargeWholesaleOrder(declineOrder.id, { trigger: "MANUAL", actor });
    declined = result.ok === false;
    declineMessage = result.error ?? String(result.status);
  } catch (error) {
    declined = true;
    declineMessage = error instanceof Error ? error.message : "threw";
  }
  check("a declined sandbox charge fails rather than reporting success", declined, declineMessage);

  const declineOrderAfter = await prisma.order.findUnique({ where: { id: declineOrder.id } });
  check(
    "a declined charge leaves the order unpaid",
    declineOrderAfter?.wholesalePaymentStatus !== "SUCCEEDED",
    String(declineOrderAfter?.wholesalePaymentStatus)
  );

  const failedAttempt = await prisma.paymentAttempt.findFirst({
    where: { payment: { orderId: declineOrder.id } },
    orderBy: { createdAt: "desc" },
  });
  check(
    "the decline is recorded on the attempt",
    failedAttempt?.status === "FAILED" || failedAttempt?.status === "REQUIRES_ACTION",
    String(failedAttempt?.status)
  );

  // ------------------------------------------------------------- H. Isolation
  console.log("\n-- H. Isolation --------------------------------------------------------");

  const shipmentCount = await prisma.shipment.count({
    where: { orderId: { in: [okOrder.id, declineOrder.id] } },
  });
  check("no shipment was booked by any payment outcome", shipmentCount === 0, `${shipmentCount} shipment(s)`);

  check(
    "every Stripe URL this run used was well formed",
    requestUrls.length > 0 &&
      requestUrls.every((u) => u.startsWith("https://api.stripe.com/v1/") && !u.replace("https://", "").includes("//")),
    `${requestUrls.length} request(s)`
  );
  check(
    "no fabricated id was ever sent to Stripe",
    requestUrls.every((u) => !u.includes("sim_")),
    requestUrls.find((u) => u.includes("sim_")) ?? "none"
  );

  await cleanupSeller(PAY_SHOP);
  await cleanupSeller(SHOP);

  console.log(`\n=== ${total - failures}/${total} checks passed (${skipped} skipped) ===`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
