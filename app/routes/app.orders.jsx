import React from "react";
import { Link, Form, useLoaderData, useActionData, useNavigation } from "react-router";
import {
  BLOCKED_MESSAGE,
  withMerchantAccess,
  requireMerchantAccess,
  AccessError,
} from "../services/seller.server";
import { useCurrency } from "../components/CurrencyDisplay";
import { prisma } from "../db.server";
import {
  chargeSellerForOrder,
  safeFailureReason,
  ChargeRefused,
} from "../services/sellerCharge.server";
import { createSetupSession, getDefaultPaymentMethod } from "../services/sellerBilling.server";
import { shopifyAdminAppUrl } from "../services/shopifyNavigation.server";
import { MONEY_CLEARED, IllegalTransitionError } from "../services/orderState.server";
import { authenticate } from "../shopify.server";
import {
  FULFILLMENT_SCOPES,
  readFulfillmentScopes,
  forgetFulfillmentScopes,
  reauthorizeUrl,
} from "../services/shopifyScopes.server";

/**
 * The seller's own orders: what MoonVella is shipping for them, what it is
 * charging them for it, and what — if anything — they have to do about it.
 *
 * THE LANGUAGE RULE THIS FILE IS BUILT AROUND, AND WHY IT IS A RULE.
 *
 * A seller reads this page to answer three questions: which orders did I sell,
 * what do I owe MoonVella for them, and has the money moved. Every one of those
 * is a question about THEIR business, and none of them is answerable with a
 * provider's vocabulary. So no Stripe payment-intent id, no raw Shopify order
 * id or GID, no webhook payload, no provider exception text and not the word
 * "PaymentIntent" may reach this screen — not as a "technical detail" in small
 * print, because small print is exactly where a card network's identifier ends
 * up in a screenshot that somebody emails to their accountant.
 *
 * The durable way to hold that line is not to remember it while writing JSX.
 * It is to make the seller-facing text a VALUE THE SERVER COMPUTES: the loader
 * maps each order's two payment columns to a label, a sentence and one action,
 * and the page renders those strings without ever seeing a status, an id or a
 * provider message. A page that mapped a status inline would be a second place
 * that decides what a seller is told, and the two would drift the first time a
 * state is added.
 *
 * WHAT IS DELIBERATELY NOT IN THE LOADER'S SELECT. The street address, the
 * customer's email and the customer's phone are not selected at all. The list
 * says where a parcel is going in the only terms a seller needs to recognise
 * the order — city, region, country — and the full delivery is read from the
 * order itself by the surfaces that need it (the packing list, the carrier
 * booking). Filtering fields out in the component would still ship them in the
 * page's own payload; not reading them is the version that cannot leak.
 */

/**
 * The one button each payment state offers. Written as a map rather than as
 * inline conditionals so the three ways a seller can be asked to act — pay,
 * confirm, try again — exist in exactly one place, and "add a payment method"
 * substitutes for any of them when there is no card to charge.
 */
const PAYMENT_ACTION_LABEL = {
  pay: "Pay this order",
  verify: "Complete verification",
  retry: "Try the payment again",
  setup: "Add a payment method",
};

/** The carrier's view of a parcel, in a seller's words. */
const SHIPMENT_LABEL = {
  PENDING: "Label being prepared",
  BOOKING: "Booking with the carrier",
  BOOKED: "Label created — waiting for the carrier",
  BOOKING_FAILED: "Booking failed — MoonVella is looking at it",
  BOOKING_UNKNOWN: "Booking is being confirmed with the carrier",
  CANCELLING: "Cancellation in progress",
  SHIPPED: "In transit",
  DELIVERED: "Delivered",
  EXCEPTION: "The carrier reported a problem",
  CANCELLED: "Cancelled",
};

/**
 * Fulfilment, as the seller's side of it rather than ours.
 *
 * `Order.fulfillmentStatus` is MoonVella's own progress column — it advances
 * when MoonVella ships — and on its own it cannot answer the question a seller
 * actually asks when a customer telephones: "why has this not gone out yet".
 * The answer, for an order that has not been paid for, is the money rule, so
 * the sentence is built from the state machine's verdict as well as the
 * fulfilment column and says so out loud. Hiding that would leave a seller
 * staring at "Pending" and ringing the owner about a delay that is theirs.
 */
const FULFILLMENT_LABEL = {
  PENDING: "Not shipped yet",
  PROCESSING: "Being prepared",
  PARTIAL: "Partly shipped",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

const FULFILLMENT_TONE = {
  PENDING: "pending",
  PROCESSING: "processing",
  PARTIAL: "processing",
  SHIPPED: "paid",
  DELIVERED: "paid",
  CANCELLED: "cancelled",
};

/**
 * City, region and country from the stored delivery address, and nothing else.
 *
 * `Order.shippingAddress` is the JSON Shopify sent, kept verbatim, so it holds
 * a recipient name, a street, a phone number and whatever else the store
 * collects. It is a STRING, not a column set, which is why this has to parse —
 * and why an address that will not parse yields a dash rather than an empty
 * link in a chain of commas. The key pairs are the ones the rest of this
 * application reads (`addressValidation.server`), so a row that spells its
 * province `provinceCode` reads here exactly as it reads there.
 */
function destinationOf(raw) {
  if (!raw) return "—";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "—";
  }
  if (!parsed || typeof parsed !== "object") return "—";
  const parts = [parsed.city, parsed.province || parsed.provinceCode, parsed.country || parsed.countryCode]
    .filter((part) => typeof part === "string" && part.trim());
  return parts.length ? parts.join(", ") : "—";
}

/**
 * What a seller is told about one order's payment, and what they can do next.
 *
 * WHY TWO COLUMNS AND NOT ONE. `Order.state` is the machine — what has been
 * decided — and `WholesalePayment.status` is what the provider last said. Read
 * alone, each misleads: a bill left at `FAILED` under an order that has since
 * been paid is an old attempt, not a failure, and a state of
 * `PAYMENT_ACTION_REQUIRED` on a bill that a later retry moved to `PROCESSING`
 * is a queue, not a question. Reading the pair once, here, is what keeps the
 * badge, the sentence and the button on this page from disagreeing with the
 * order the owner sees on theirs.
 *
 * `failureReason` arrives already passed through `safeFailureReason` — the
 * provider's own words never leave the server — and `requiresAction` is
 * deliberately NOT used as a source of truth: it is a column on the bill that
 * the charge writes, and the state is the record of what was decided.
 */
function sellerPaymentStory({
  state,
  paymentStatus,
  customerPaymentStatus,
  failureReason,
  hasMethod,
}) {
  const story = (label, tone, sentence, action) => {
    const needsMethod = !hasMethod && action !== "none";
    return {
      label,
      tone,
      sentence,
      // A seller with no card on file cannot be asked to pay, confirm or retry:
      // every one of those three actions ends in the same missing card, so the
      // page offers the one action that fixes it and says why.
      action: needsMethod ? "setup" : action,
      actionLabel: PAYMENT_ACTION_LABEL[needsMethod ? "setup" : action] ?? null,
      needsMethod,
    };
  };

  if (MONEY_CLEARED.has(state)) {
    /*
     * A cancellation after the money moved. MoonVella does not refund these
     * automatically — the goods may be with a carrier and the seller may still
     * want them — so the sentence must not say "refunded" and must not offer a
     * payment button. It says what is true: a person is deciding.
     */
    if (state === "REFUND_REVIEW") {
      return story(
        "Refund being reviewed",
        "processing",
        "This order was paid for and then cancelled. MoonVella is reviewing the refund and will contact you — nothing further is due right now.",
        "none"
      );
    }
    return story(
      "Paid",
      "paid",
      "MoonVella has been paid for this order, so nothing further is due on it.",
      "none"
    );
  }

  if (state === "CANCELLED") {
    return story("Cancelled", "cancelled", "This order was cancelled, so nothing is owed on it.", "none");
  }

  /*
   * The customer's money went back before MoonVella took any. Checked before
   * the failure states rather than after, because "try the payment again" is
   * the wrong thing to say about an order nobody is keeping.
   */
  if (
    customerPaymentStatus === "REFUNDED" ||
    customerPaymentStatus === "PARTIALLY_REFUNDED" ||
    customerPaymentStatus === "VOIDED"
  ) {
    return story(
      "Nothing to pay",
      "cancelled",
      "The customer's payment in your store was refunded or cancelled, so MoonVella has not billed you for this order.",
      "none"
    );
  }

  if (state === "PAYMENT_ACTION_REQUIRED" || paymentStatus === "REQUIRES_ACTION") {
    return story(
      "Confirmation needed",
      "processing",
      "Your bank asked you to confirm this payment and has not had an answer yet. The card is not charged until they say yes — complete the verification they sent you, then try the payment again.",
      "verify"
    );
  }

  if (state === "PAYMENT_FAILED" || paymentStatus === "FAILED") {
    return story(
      "Payment failed",
      "failed",
      failureReason || "The payment could not be completed. You can try again.",
      "retry"
    );
  }

  if (state === "PAYMENT_PROCESSING" || paymentStatus === "PROCESSING") {
    return story(
      "Payment processing",
      "processing",
      "MoonVella is taking this payment now. It usually finishes in a moment, and the order updates here as soon as the card network confirms it.",
      "none"
    );
  }

  /*
   * Nothing has been charged yet. Whether that is the seller's turn or the
   * customer's is the one distinction this branch exists for, and it is read
   * from `Order.paymentStatus` — the customer's payment in their store — which
   * is the same column `chargeSellerForOrder` refuses on. A page that offered
   * "Pay this order" on an order the customer had not paid for would be
   * inviting a seller to press a button that can only answer "not yet".
   */
  if (customerPaymentStatus === "PAID") {
    return story(
      "Payment due",
      "pending",
      "The customer has paid you in your store, so MoonVella will take the wholesale amount for the goods it ships.",
      "pay"
    );
  }

  return story(
    "Waiting on the customer",
    "pending",
    "The customer has not paid for this order in your store yet. MoonVella only bills you once that payment clears — there is nothing for you to do.",
    "none"
  );
}

/**
 * What a seller is told about an order's fulfilment.
 *
 * The state is consulted only to answer "has the money cleared", and that
 * question is asked of the state machine's own set rather than of a copy of it
 * kept here: an order that may not ship yet is a fact about the graph in
 * `orderState.server`, and a second list of "states where shipping is allowed"
 * is how a page starts promising a parcel the warehouse has not been asked for.
 */
function sellerFulfillmentStory({ state, status }) {
  const label = FULFILLMENT_LABEL[status] ?? "Not shipped yet";
  const tone = FULFILLMENT_TONE[status] ?? "pending";

  if (status === "CANCELLED") {
    return { label, tone, sentence: "This order will not ship." };
  }
  if (!MONEY_CLEARED.has(state)) {
    return {
      label,
      tone,
      sentence: "MoonVella starts shipping an order once its wholesale payment has cleared.",
    };
  }
  if (status === "DELIVERED") {
    return { label, tone, sentence: "The carrier has delivered this order." };
  }
  if (status === "SHIPPED") {
    return { label, tone, sentence: "This order is on its way; tracking is below." };
  }
  return { label, tone, sentence: "MoonVella is preparing this order for shipment." };
}

/**
 * Order history for any store that is not blocked, and rows only for those the
 * rules table says may read them.
 *
 * The distinction matters: a suspension keeps order history deliberately, so
 * this loader must not refuse a suspended store the page — but a blocked one is
 * refused the route outright. `withMerchantAccess` decides the second question
 * and `canViewOrders` the first, so the page's own empty state and the server's
 * refusal cannot drift apart.
 *
 * `canAct` is the third question the page needs an answer to, and it is the
 * action's own gate read early rather than enforced in the button. The two
 * payment actions below require an approved account — the same `BUSINESS` level
 * Billing's writes require — so a suspended store must be shown its history
 * WITHOUT buttons that could only answer with a refusal. Hiding them is not a
 * weaker check: the action checks again, and it is the action that decides.
 */
export const loader = async ({ request }) =>
  withMerchantAccess(request, "VIEW", async (context) => {
    /*
     * The provider sends the seller back here by URL, so the outcome of a card
     * setup arrives as a query parameter and is turned into a sentence here
     * rather than in the page. `success` is deliberately not "your card has
     * been saved": the method is written by the verified webhook that follows
     * the provider's own event, and a seller told the card exists — while the
     * event is still in flight — would try to pay an order and be refused.
     */
    const setup = new URL(request.url).searchParams.get("setup") || "";
    const setupNotice =
      setup === "success"
        ? "Your card has been saved with our payment provider. If it is not shown yet it is still being confirmed — reload in a moment."
        : setup === "cancelled"
          ? "No card was added. You can start again whenever you are ready."
          : null;

    /*
     * Whether MoonVella is allowed to fulfill, asked of Shopify rather than
     * remembered. Read here, in the page that feels the absence, and NOT in the
     * layout: the layout revalidates on a 30-second timer and a revalidation
     * re-runs this loader too, so anything on this path runs on a schedule for
     * as long as a merchant leaves the tab open. `readFulfillmentScopes` holds
     * the answer briefly for that reason.
     *
     * This authenticates a second time, and that is a deliberate trade rather
     * than an oversight: the scopes API only comes from `authenticate.admin`,
     * and `withMerchantAccess` — which has to run first, because it is what
     * refuses a blocked store — keeps only the shop. The cost is one extra
     * session read on a page load. Routing the admin client out through
     * `SellerContext` to save it would put a live API client into a type that
     * loaders return as data, which is a worse thing to have in the codebase
     * than a repeated indexed lookup.
     */
    const { scopes } = await authenticate.admin(request);
    const fulfillmentScopes = await readFulfillmentScopes(context.shop, scopes);

    if (!context.seller || !context.canViewOrders) {
      return {
        access: context.access,
        canViewOrders: context.canViewOrders,
        blockedMessage: BLOCKED_MESSAGE,
        canAct: false,
        paymentMethod: null,
        setupNotice,
        fulfillmentScopes,
        orders: [],
      };
    }

    const sellerId = context.seller.id;
    const [rows, method] = await Promise.all([
      prisma.order.findMany({
        where: { sellerId },
        orderBy: { shopifyCreatedAt: "desc" },
        take: 100,
        select: {
          id: true,
          shopifyOrderName: true,
          shopifyOrderNumber: true,
          customerName: true,
          shippingAddress: true,
          currency: true,
          paymentStatus: true,
          fulfillmentStatus: true,
          state: true,
          shopifyCreatedAt: true,
          /*
           * The bill is read whole but sent as three fields. `failureMessage`
           * is passed through `safeFailureReason` in the loader, so the
           * provider's own sentence — decline codes, network ids and, on a bad
           * request, the shape of the request — is never in the payload the
           * browser receives. Whatever is not shown here stays on the row.
           */
          wholesalePayment: { select: { amount: true, currency: true, status: true, failureMessage: true } },
          // MoonVella's own lines only: a store can carry products MoonVella
          // has nothing to do with, and a wholesale bill that listed them would
          // price goods this app is not shipping.
          items: {
            where: { isMoonvellaProduct: true },
            // Written in the order Shopify sent them, so reading them back
            // reproduces the customer's own order rather than an alphabetised
            // one that no longer matches what either party is looking at.
            orderBy: { createdAt: "asc" },
            select: { id: true, name: true, sku: true, quantity: true, wholesalePrice: true },
          },
          shipments: {
            select: { id: true, trackingNumber: true, trackingUrl: true, carrier: true, status: true },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
      getDefaultPaymentMethod(sellerId),
    ]);

    const hasMethod = Boolean(method);

    return {
      access: context.access,
      canViewOrders: true,
      blockedMessage: BLOCKED_MESSAGE,
      canAct: context.canStartNewBusiness,
      // Masked identifiers only. The stored row also carries the provider's
      // customer and method ids, which are how this system charges a card and
      // are not something a seller is ever shown or sends back.
      paymentMethod: method ? { brand: method.brand, last4: method.last4 } : null,
      setupNotice,
      /*
       * Only what the banner draws: which of the two are absent. The full grant
       * is not sent — a seller has no use for a list of everything the app may
       * do, and it is one more thing in a payload that a screenshot can carry.
       */
      fulfillmentScopes: { missing: fulfillmentScopes.missing },
      orders: rows.map((order) => ({
        id: order.id,
        // Shopify's own name for the order is "#1001"; the number is the
        // fallback for a row whose name arrived empty.
        name: order.shopifyOrderName || `#${order.shopifyOrderNumber}`,
        placedAt: order.shopifyCreatedAt.toISOString(),
        destination: destinationOf(order.shippingAddress),
        customer: order.customerName || "—",
        lines: order.items.map((item) => ({
          id: item.id,
          name: item.name,
          sku: item.sku,
          quantity: item.quantity,
          unitWholesale: item.wholesalePrice,
          lineWholesale: item.wholesalePrice * item.quantity,
        })),
        // The order's own currency covers the line prices; the bill carries the
        // currency it is denominated in, which is the one that must be printed
        // beside the amount actually charged.
        currency: order.currency,
        charge: order.wholesalePayment
          ? { amount: order.wholesalePayment.amount, currency: order.wholesalePayment.currency }
          : null,
        payment: sellerPaymentStory({
          state: order.state,
          paymentStatus: order.wholesalePayment?.status ?? null,
          customerPaymentStatus: order.paymentStatus,
          failureReason: order.wholesalePayment?.failureMessage
            ? safeFailureReason(order.wholesalePayment.failureMessage)
            : null,
          hasMethod,
        }),
        fulfillment: sellerFulfillmentStory({
          state: order.state,
          status: order.fulfillmentStatus,
        }),
        shipments: order.shipments.map((shipment) => ({
          id: shipment.id,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl,
          carrier: shipment.carrier,
          status: SHIPMENT_LABEL[shipment.status] ?? "Being prepared",
        })),
      })),
    };
  });

/**
 * The sentence a seller reads when a charge attempt did not end in a payment.
 *
 * A provider's refusal is stored on the bill in its own words and reaches the
 * seller only through `safeFailureReason`, which keeps the part a person can act
 * on and drops the identifiers and the request shape. The named outcomes the
 * charge service reports — no card on file, the customer has not paid in the
 * store — are read as flags BEFORE the message, because each is a fact about
 * the order that no provider message could state as plainly.
 */
function chargeOutcomeSentence(outcome) {
  if (outcome.ok) {
    return outcome.requiresAction
      ? "Your bank still needs to confirm this payment. Complete the verification they sent you and try again."
      : "The payment has been submitted. This order shows as paid here as soon as the card network confirms it.";
  }
  if (outcome.requiresPaymentMethod) {
    return "Add a payment method before this order can be paid for.";
  }
  if (outcome.awaitingCustomerPayment) {
    return "The customer has not paid for this order in your store yet, so there is nothing for MoonVella to charge.";
  }
  return safeFailureReason(outcome.message);
}

/**
 * A refusal this action can explain, in the seller UI's own words.
 *
 * The refusal's `message` is written for a person and would be safe to print —
 * but the class is also thrown from paths whose text is not, and the only way
 * to make "no internal exception text reaches a seller" true by construction
 * rather than by review is to print this table and nothing else. An unlisted
 * code falls through to a sentence that is true of every one of them.
 */
const REFUSAL_SENTENCE = {
  ORDER_NOT_FOUND: "We could not find that order in your store.",
  NO_PAYMENT_RECORD: "There is no bill on this order yet, so there is nothing to pay.",
  ORDER_CANCELLED: "This order was cancelled, so nothing is owed on it.",
};

export const action = async ({ request }) => {
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  /*
   * GRANTING A PERMISSION IS NOT SPENDING MONEY, so it sits above the BUSINESS
   * gate rather than behind it, with the `VIEW` floor the loader already uses.
   * The two scopes are what MoonVella needs to ship an order at all; a store
   * whose orders are read-only still owns the decision about what this app may
   * do in its Shopify admin, and a store that is blocked is refused here the
   * same as everywhere else.
   *
   * IT IS THE BUTTON THAT ASKS, NEVER A LOADER. That is the whole reason this
   * is an intent rather than something the page does on render: a page that
   * requested scopes whenever it noticed they were missing would send a
   * merchant to the grant screen again on every load — which is the loop this
   * app has already spent ten hours inside once. Pressing the button is the
   * only thing that starts this, and `scopes.request` is itself guarded: it
   * asks Shopify what is granted and returns without redirecting when the
   * answer is already yes, so a second press is a no-op rather than a second
   * trip through the grant screen.
   */
  if (intent === "grant_fulfillment_scopes") {
    try {
      await requireMerchantAccess(request, "VIEW");
    } catch (error) {
      if (error instanceof AccessError) {
        return Response.json({ ok: false, error: error.message });
      }
      throw error;
    }

    const { scopes, session } = await authenticate.admin(request);
    // Dropped before the ask, because the ask usually ends in a redirect out of
    // the app: whatever the merchant sees when Shopify sends them back must not
    // be a cached "still missing" that outlives the approval.
    forgetFulfillmentScopes(session.shop);

    /*
     * `scopes.request` THROWS WHEN EITHER SCOPE IS ABSENT — a 401 carrying
     * `X-Shopify-API-Request-Failure-Reauthorize-Url`, the url of Shopify's
     * grant screen. That throw is the library's mechanism and it is kept; what
     * is added is the transport, because the throw alone only works for a
     * request that App Bridge's patched `fetch` is on the path of.
     *
     * IT WAS NOT ON THE PATH OF THE MERCHANT'S, and the failure was silent in
     * the worst way: the 401 came back to React Router instead of to App
     * Bridge, React Router did the only thing it can with an error response,
     * and the iframe printed "401 Unauthorized" where the merchant expected
     * Shopify's consent screen. Nothing logged an error, because nothing went
     * wrong — the response simply reached the wrong consumer.
     *
     * So the url is taken out of the throw and handed back as a value the page
     * can act on. The route answers with the url, and the page opens it in the
     * TOP window. A 401 cannot be rendered, because none is ever returned.
     *
     * THERE IS DELIBERATELY ONLY ONE PATH HERE, and the second one was tried and
     * removed. The library's own answer for a document submission is
     * `redirect(grantUrl, { target: "_top" })`, which for an embedded request
     * returns the App Bridge bounce document — an HTML page that loads App
     * Bridge and calls `window.open(<grant url>, "_top")`. That is a 200 whose
     * body is HTML, and React Router 7 does not have a "return this document
     * verbatim" case for an action: a thrown Response that is not a redirect is
     * an ERROR, so React Router routed it to the error boundary and rendered the
     * bounce document's script source as text inside an error card. The merchant
     * would have seen `<script>window.open(...)</script>` printed on the page.
     * It reached the grant screen anyway — the script still ran — but that is
     * luck, not design.
     *
     * The one path covers both transports better than the two did. A submission
     * from the running page is a fetch to `/app/orders.data` and gets this JSON
     * directly. A submission the browser posted itself (scripts not yet running,
     * e.g. a click before hydration) gets the app's document rendered with this
     * same JSON as its action data, and the page's effect opens the grant screen
     * as soon as that document hydrates — same destination, no error card, and
     * no dependence on a bounce document this framework will not serve.
     */
    try {
      await scopes.request([...FULFILLMENT_SCOPES]);
    } catch (thrown) {
      const grantUrl = reauthorizeUrl(thrown);
      if (!grantUrl) throw thrown;

      return Response.json({
        ok: false,
        grantUrl,
        // See the effect in the component: the url alone cannot tell one press
        // from the next, and this is what the page opens the grant screen on.
        grantAsk: Date.now(),
        message: "Shopify needs your approval for two permissions before MoonVella can ship orders.",
      });
    }

    return Response.json({
      ok: true,
      granted: true,
      message: "Shopify has already granted MoonVella both fulfillment permissions.",
    });
  }

  let context;
  try {
    /*
     * `BUSINESS`, not `ORDERS`: both of these actions spend money or hand out a
     * card-setup session, and that is the same level Billing's writes require.
     * A suspended store keeps its history — the loader above still shows it —
     * but it does not start new business, whichever page the button was drawn
     * on.
     */
    context = await requireMerchantAccess(request, "BUSINESS");
  } catch (error) {
    if (error instanceof AccessError) {
      return Response.json({ ok: false, error: error.message });
    }
    throw error;
  }
  if (!context.seller) return Response.json({ ok: false, error: "No seller account." });

  try {
    if (intent === "setup") {
      /*
       * Back to Orders, not to Billing: a seller who was told their order needs
       * a card expects to land on the order they were looking at.
       *
       * The address is an ADMIN one, so that following it re-enters the embedded
       * frame rather than landing on a bare top-level document with no session —
       * see `shopifyAdminAppUrl`. Only the store and this app's own path are in
       * it: the seller's session and the order stay on this side of the provider.
       */
      const returnUrl = shopifyAdminAppUrl(context.shop, "/app/orders", request);
      const session = await createSetupSession(context.seller.id, returnUrl);
      if (session.simulated) {
        // No provider session exists to send anyone to, so the honest answer is
        // the deployment fact, in the service's own words, rather than a
        // redirect to a page that would not exist.
        return Response.json({ ok: false, simulated: true, detail: session.detail });
      }
      /*
       * RETURNED, NOT REDIRECTED, AND THE DIFFERENCE IS THE WHOLE BUG.
       *
       * This was `return redirect(session.url)`. A 302 to Stripe is followed by
       * whatever asked for it — and what asked for it is the IFRAME, because the
       * form was submitted from inside the Shopify admin. Stripe will not render
       * Checkout in a frame ("please redirect to Checkout at the top level"), so
       * the seller watched the app's own panel empty itself. The URL has to
       * travel as DATA, so the browser half can hand it to the top window.
       */
      return Response.json({ ok: true, setupUrl: session.url });
    }

    if (intent === "retry_charge") {
      const orderId = String(form.get("orderId") || "");

      /*
       * THE ORDER IS RESOLVED THROUGH THE SELLER, AND THE SCOPE IS THE POINT.
       *
       * `chargeSellerForOrder` takes an order id and charges THE CARD OF THE
       * SELLER WHO OWNS THAT ORDER. It is written that way on purpose — it is
       * also called from the webhook path and the background queue, which have
       * no session and no seller — which means that a route handing it an id
       * straight from a form would let any signed-in store charge another
       * store's card by posting an id it guessed or read out of a URL. So the
       * id is turned into "one of MY orders" here, in a query, before the
       * charge is asked for; an id that is not this seller's matches no row and
       * reaches the service as nothing.
       */
      const owned = await prisma.order.findFirst({
        where: { id: orderId, sellerId: context.seller.id },
        select: { id: true },
      });
      if (!owned) {
        return Response.json({ ok: false, error: "We could not find that order in your store." });
      }

      const outcome = await chargeSellerForOrder({
        orderId: owned.id,
        trigger: "MANUAL",
        actor: {
          actorType: "MERCHANT",
          actorId: context.seller.id,
          actorName: context.seller.storeName,
        },
        /*
         * `retry: true` unconditionally, and it is not a flourish.
         *
         * A declined card is not something the provider will reconsider under
         * an idempotency key it has already answered, and the key is
         * `seller-charge:<orderId>:<paymentVersion>` — so a seller pressing
         * this button on a failed order with the version unchanged would be
         * handed the stored refusal back and would press it again, forever.
         * Bumping the version is what makes the button a second attempt. On an
         * order that has never been charged the bump is wasted rather than
         * harmful: no key at either version has been used, and the bill is
         * priced from the lines on every attempt.
         */
        retry: true,
        /*
         * An admin address for the same reason the setup action uses one: this
         * URL ends up on a Stripe session the seller follows out of the frame,
         * and whatever they come back to has to put them into it again. The
         * request is passed so the authoritative `host` is preferred where it
         * is present.
         */
        setupReturnUrl: shopifyAdminAppUrl(context.shop, "/app/orders", request),
      });

      return Response.json({
        ok: outcome.ok,
        orderId: owned.id,
        sentence: chargeOutcomeSentence(outcome),
        requiresPaymentMethod: outcome.requiresPaymentMethod ?? false,
        requiresAction: outcome.requiresAction ?? false,
      });
    }

    return Response.json({ ok: false, error: "Unknown action." });
  } catch (error) {
    /*
     * Two refusals are ordinary outcomes of two people acting at once — a
     * cancellation that arrived while the seller was pressing Pay, a charge
     * already in flight — and each has a sentence a seller can read. Anything
     * else is a real fault, and the layout's error boundary is a more honest
     * answer to it than a sentence invented here would be.
     */
    if (error instanceof ChargeRefused) {
      return Response.json({
        ok: false,
        error: REFUSAL_SENTENCE[error.code] ?? "This order cannot be paid for at the moment.",
      });
    }
    if (error instanceof IllegalTransitionError) {
      return Response.json({
        ok: false,
        error: "This order has just been updated, so the payment was not re-attempted. Reload the page and check its current state.",
      });
    }
    throw error;
  }
};

export default function OrdersPage() {
  const {
    access,
    canViewOrders,
    orders,
    blockedMessage,
    canAct,
    paymentMethod,
    setupNotice,
    fulfillmentScopes,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const { format } = useCurrency();

  /*
   * An order's own currency is printed, and only Canadian amounts are converted.
   *
   * Every order this application writes is Canadian — see `utils/money` — but
   * the column exists and a row that said otherwise would be misrepresented by
   * a conversion, so the code the row carries wins for any currency that is not
   * the base one. A USD view is a reading of Canadian prices, not a claim about
   * what some other amount was.
   */
  const money = (cents, code) =>
    !code || code === "CAD" ? format(cents) : `${(cents / 100).toFixed(2)} ${code}`;
  const isBlocked = access === "BLOCKED";

  /*
   * The date is printed in the business's own time zone rather than the
   * reader's, because it is rendered on the server first and hydrated in the
   * browser: a date formatted from the runtime's zone would be one day on the
   * server and another in a seller's browser, and React would resolve that by
   * throwing the tree away and rebuilding it.
   */
  const placedOn = (value) =>
    new Date(value).toLocaleDateString("en-CA", {
      timeZone: "America/Toronto",
      dateStyle: "medium",
    });

  /*
   * Every payment button on the page is disabled while any of them is in
   * flight. A charge is the one action here that spends money, and a
   * double-submit on a slow connection is a second request — the idempotency
   * key makes the second harmless, but a button that invites it is a button
   * that has not been thought about.
   */
  const busy = navigation.state !== "idle";

  /*
   * THE TOP WINDOW, NEVER THIS ONE. Stripe refuses to render Checkout inside an
   * iframe — "Stripe Checkout is not able to run in an iFrame. Please redirect
   * to Checkout at the top level." — so the URL the action returned is handed to
   * `_top` instead of assigned to this frame's location. Navigating the frame is
   * what emptied the panel; `_top` is the one hop out of the frame this app
   * makes, and it is deliberate, because the card is entered on Stripe's page
   * and never on ours.
   *
   * `_top` names a browsing context that already exists, so this is a navigation
   * rather than a new popup, which is not something a popup blocker swallows.
   *
   * Declared above the `canViewOrders` return below because a hook may not sit
   * behind a conditional — a seller who cannot view orders still renders this
   * component on the way to the refusal.
   */
  React.useEffect(() => {
    const url = actionData?.setupUrl;
    if (url) window.open(url, "_top");
  }, [actionData]);

  /*
   * SHOPIFY'S GRANT SCREEN, BY THE SAME HOP AND FOR THE SAME REASON.
   *
   * The grant action cannot answer a script with the 401 that App Bridge reads,
   * because that response is only interpreted by App Bridge's patched `fetch` —
   * and when it is not on the path, React Router renders the 401 into the frame
   * instead of anyone being asked for anything. So the action returns the url
   * and this opens it in the top window: the same navigation the library's own
   * bounce document performs, without depending on a page load to perform it.
   *
   * KEYED ON THE ASK, NOT ON THE URL. The url is the same string every time —
   * same client id, same scopes — so an effect that depended on it would fire
   * once and never again: a merchant who declined and pressed the button a
   * second time would get nothing, which is a worse bug than the one being
   * fixed. Depending on `actionData` instead is the same trap from the other
   * side, because action data outlives a revalidation and the layout polls
   * every thirty seconds. So the action stamps each ask and this fires on the
   * stamp: exactly once per press, never on a poll.
   */
  const grantAsk = actionData?.grantAsk;
  const grantUrl = actionData?.grantUrl;
  React.useEffect(() => {
    if (!grantAsk || !grantUrl) return;
    window.open(grantUrl, "_top");
  }, [grantAsk, grantUrl]);

  if (!canViewOrders) {
    return (
      <s-page heading="Orders">
        <div className="mv-container">
          <div className="mv-page-header">
            <h2 className="mv-page-title">Orders</h2>
            <p className="mv-page-subtitle">
              MoonVella orders appear here after your store is approved and products are imported.
            </p>
          </div>
          <div className="mv-section-card" style={{ textAlign: "center", padding: "4rem 2rem" }}>
            <div style={{ fontSize: "4rem", marginBottom: "1.5rem" }}>📋</div>
            <h2 className="mv-page-title" style={{ marginBottom: "1rem" }}>
              {isBlocked ? "Orders are unavailable" : "Orders will appear here after approval"}
            </h2>
            {/* A blocked store is told what happened to its access, not that it
                should wait for a review that has already been decided. */}
            <p
              className="mv-page-subtitle"
              style={{ maxWidth: "500px", margin: "0 auto 2rem" }}
              role={isBlocked ? "alert" : undefined}
            >
              {isBlocked ? blockedMessage : `Current status: ${access}.`}
            </p>
            <div style={{ display: "flex", gap: "1rem", justifyContent: "center", flexWrap: "wrap" }}>
              <Link className="mv-btn mv-btn-primary" to="/app/status">
                View Application Status
              </Link>
              <Link className="mv-btn mv-btn-secondary" to="/app/application">
                Edit Application
              </Link>
            </div>
          </div>
        </div>
      </s-page>
    );
  }

  const addCardForm = (
    <Form method="post">
      <input type="hidden" name="intent" value="setup" />
      <button type="submit" className="mv-btn mv-btn-primary" disabled={busy}>
        {paymentMethod ? "Change payment method" : "Add a payment method"}
      </button>
    </Form>
  );

  /*
   * THE ONE PLACE THAT ASKS SHOPIFY FOR THE TWO SCOPES.
   *
   * Shown only when the loader has read, from Shopify, that one of them is
   * absent — and shown as a BUTTON rather than performed when the page loads.
   * That is the difference between a permission screen the merchant sees once
   * and the ten-hour loop this app has already been through: a page that asked
   * whenever it noticed the scopes were missing would send them back to the
   * grant screen on every single load, and a merchant who declined would be
   * asked again forever. Nothing else on this page starts this request.
   *
   * The scope handles are named because Shopify's own grant screen names them,
   * and a merchant who is about to read "write_fulfillments" on Shopify's page
   * should have met the word here first rather than in a list of permissions
   * they cannot connect to anything.
   */
  const missingScopes = fulfillmentScopes?.missing ?? [];
  const grantPermissions =
    missingScopes.length > 0 ? (
      <div
        className="mv-section-card"
        style={{ border: "1px solid #fde68a", background: "#fffbeb" }}
        role="status"
      >
        <h3 className="mv-section-title" style={{ color: "#92400e", marginBottom: "0.5rem" }}>
          MoonVella needs two more Shopify permissions
        </h3>
        <p style={{ margin: "0 0 1rem", color: "#92400e" }}>
          This store was installed before MoonVella required the{" "}
          <strong>{missingScopes.join(" and ")}</strong>{" "}
          {missingScopes.length === 1 ? "permission" : "permissions"}, and Shopify does not widen an
          existing grant on its own. Until the newly required permissions are approved, MoonVella
          cannot create the location its stock ships from or send a fulfillment, so orders cannot be
          completed. Shopify will ask you to approve them on its own page.
        </p>
        <Form method="post">
          <input type="hidden" name="intent" value="grant_fulfillment_scopes" />
          <button type="submit" className="mv-btn mv-btn-primary" disabled={busy}>
            Grant fulfillment permissions
          </button>
        </Form>
      </div>
    ) : null;

  /*
   * What the grant action says when it did NOT have to redirect — Shopify
   * already held both. The redirect path never reaches this page at all: the
   * merchant leaves for Shopify's grant screen and comes back through the
   * admin, which is a fresh load of this loader with a fresh read.
   */
  const grantNotice = actionData?.message ? (
    <div className="mv-alert-banner" role="status">
      <p className="mv-alert-text">{actionData.message}</p>
    </div>
  ) : null;

  return (
    <s-page heading="Orders">
      <div className="mv-container">
        <div className="mv-page-header">
          <h2 className="mv-page-title">Orders</h2>
          <p className="mv-page-subtitle">
            MoonVella product orders placed in your store, what MoonVella charges you for them, and
            their fulfillment and tracking. Standard shipping included.
          </p>
        </div>

        {/* First, because it is the one thing on this page that stops the rest
            of it from working. */}
        {grantPermissions}
        {grantNotice}

        {setupNotice ? (
          <div className="mv-alert-banner">
            <p className="mv-alert-text">{setupNotice}</p>
          </div>
        ) : null}

        {actionData?.error ? (
          <div className="mv-alert-banner" role="alert">
            <p className="mv-alert-text">{actionData.error}</p>
          </div>
        ) : null}

        {/* A simulated setup returns the deployment fact instead of a URL; it is
            shown verbatim because it is written for the seller and says exactly
            what did and did not happen. */}
        {actionData?.simulated ? (
          <div className="mv-alert-banner">
            <p className="mv-alert-text">{actionData.detail}</p>
          </div>
        ) : null}

        {actionData?.sentence ? (
          <div
            className="mv-alert-banner"
            style={
              actionData.ok
                ? { background: "#f0fdf4", borderColor: "#bbf7d0" }
                : { background: "#fef2f2", borderColor: "#fecaca" }
            }
            role="status"
          >
            <p className="mv-alert-text" style={actionData.ok ? { color: "#166534" } : { color: "#991b1b" }}>
              {actionData.sentence}
            </p>
          </div>
        ) : null}

        <div className="mv-section-card" style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "240px" }}>
            <h3 className="mv-section-title" style={{ marginBottom: "0.25rem" }}>
              Payment method
            </h3>
            <p className="mv-page-subtitle" style={{ margin: 0 }}>
              {paymentMethod
                ? `Wholesale orders are charged to ${(paymentMethod.brand || "card").toUpperCase()} •••• ${paymentMethod.last4}. Card details never reach MoonVella.`
                : "No card is on file yet, so MoonVella cannot take payment for an order. Add one on the payment provider's secure page."}
            </p>
          </div>
          {/* Hidden for a store that may not start new business: the action
              refuses that store anyway, and a button that can only be refused
              is not an action. */}
          {canAct ? addCardForm : null}
        </div>

        {orders.length === 0 ? (
          <div className="mv-section-card" style={{ textAlign: "center", padding: "3rem" }}>
            <p className="mv-page-subtitle">
              No MoonVella orders yet. Orders appear here once a customer buys an imported
              MoonVella product.
            </p>
          </div>
        ) : (
          orders.map((order) => (
            <div className="mv-section-card" key={order.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", alignItems: "flex-start" }}>
                <div>
                  <h3 className="mv-section-title" style={{ marginBottom: "0.25rem" }}>
                    {order.name}
                  </h3>
                  <p className="mv-page-subtitle" style={{ margin: 0 }}>
                    Ordered {placedOn(order.placedAt)} · Ships to {order.destination} · {order.customer}
                  </p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.4rem" }}>
                  <span className={`mv-badge mv-badge-${order.payment.tone}`}>{order.payment.label}</span>
                  <span className={`mv-badge mv-badge-${order.fulfillment.tone}`}>
                    {order.fulfillment.label}
                  </span>
                </div>
              </div>

              <div className="mv-table-wrapper" style={{ marginBottom: "1rem" }}>
                <table className="mv-table">
                  <thead>
                    <tr>
                      <th>MoonVella item</th>
                      <th>SKU</th>
                      <th>Qty</th>
                      <th>Wholesale each</th>
                      <th>Line total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.lines.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ color: "#64748b" }}>
                          No MoonVella products on this order.
                        </td>
                      </tr>
                    ) : (
                      order.lines.map((line) => (
                        <tr key={line.id}>
                          <td>{line.name}</td>
                          <td style={{ color: "#64748b" }}>{line.sku}</td>
                          <td>{line.quantity}</td>
                          <td>{money(line.unitWholesale, order.currency)}</td>
                          <td>{money(line.lineWholesale, order.currency)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
                <div>
                  <p style={{ fontSize: "0.7rem", color: "#64748b", margin: "0 0 0.25rem", textTransform: "uppercase", letterSpacing: "0.3px" }}>
                    Wholesale amount — payable to MoonVella
                  </p>
                  <p style={{ fontSize: "1.05rem", fontWeight: 600, margin: 0 }}>
                    {order.charge ? money(order.charge.amount, order.charge.currency) : "Not billed yet"}
                  </p>
                  {/* The price a seller is quoted is the whole price. Said
                      beside the amount because this is where somebody will
                      look, later, for a shipping line that is not there. */}
                  <p style={{ fontSize: "0.75rem", color: "#64748b", margin: "0.25rem 0 0" }}>
                    Standard shipping included
                  </p>
                </div>

                <div>
                  <p style={{ fontSize: "0.7rem", color: "#64748b", margin: "0 0 0.25rem", textTransform: "uppercase", letterSpacing: "0.3px" }}>
                    Payment
                  </p>
                  <p style={{ fontSize: "0.82rem", margin: "0 0 0.5rem" }}>{order.payment.sentence}</p>
                  {order.payment.needsMethod ? (
                    <p style={{ fontSize: "0.75rem", color: "#92400e", margin: "0 0 0.5rem" }}>
                      There is no card on file yet, so this order cannot be paid for until one is added.
                    </p>
                  ) : null}
                  {canAct && order.payment.action !== "none" ? (
                    <Form method="post">
                      {/* Which action this button is, is the loader's answer,
                          not the button's: a "setup" state is a missing card,
                          and posting a charge for it would spend a request on
                          a refusal the page already knows the answer to. */}
                      <input
                        type="hidden"
                        name="intent"
                        value={order.payment.action === "setup" ? "setup" : "retry_charge"}
                      />
                      <input type="hidden" name="orderId" value={order.id} />
                      <button
                        type="submit"
                        className={order.payment.action === "setup" ? "mv-btn mv-btn-secondary" : "mv-btn mv-btn-primary"}
                        disabled={busy}
                      >
                        {order.payment.actionLabel}
                      </button>
                    </Form>
                  ) : null}
                </div>

                <div>
                  <p style={{ fontSize: "0.7rem", color: "#64748b", margin: "0 0 0.25rem", textTransform: "uppercase", letterSpacing: "0.3px" }}>
                    Fulfillment
                  </p>
                  <p style={{ fontSize: "0.82rem", margin: "0 0 0.5rem" }}>{order.fulfillment.sentence}</p>
                  <p style={{ fontSize: "0.75rem", color: "#64748b", margin: "0 0 0.5rem" }}>
                    Standard shipping included
                  </p>
                  {/* One row per shipment, each with its own packing list. The
                      link is a plain anchor for the same reason the marketing
                      pack is: the document route authenticates from the
                      session, and a merchant surface reached by URL alone would
                      be the thing this app refuses to have. */}
                  {order.shipments.length === 0 ? (
                    <p style={{ fontSize: "0.78rem", color: "#64748b", margin: 0 }}>No shipment yet.</p>
                  ) : (
                    order.shipments.map((shipment) => (
                      <div key={shipment.id} style={{ fontSize: "0.78rem", marginBottom: "0.4rem" }}>
                        <div>
                          {shipment.status}
                          {shipment.carrier ? ` · ${shipment.carrier}` : ""}
                        </div>
                        <div>
                          {shipment.trackingNumber ? (
                            <>
                              Tracking {shipment.trackingNumber}{" "}
                              {shipment.trackingUrl ? (
                                // The carrier's own page, so it opens outside
                                // the admin frame and cannot take the session
                                // with it.
                                <a href={shipment.trackingUrl} target="_blank" rel="noreferrer noopener">
                                  Track
                                </a>
                              ) : null}
                            </>
                          ) : (
                            "Tracking number not issued yet"
                          )}
                          <a href={`/app/packing-list/${shipment.id}`} style={{ marginLeft: "0.4rem" }}>
                            Packing list
                          </a>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </s-page>
  );
}
