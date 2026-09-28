import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";
import { enqueueJob, JOB_KIND } from "../services/jobs.server";
import { WEBHOOK_TOPICS } from "../services/orderIntake.server";

/**
 * The Shopify order webhook endpoint: POST /webhooks/orders
 *
 * WHAT WENT WRONG HERE, BECAUSE IT IS THE REASON THIS FILE LOOKS LIKE THIS.
 *
 * The store's orders never appeared because nothing was ever subscribed to
 * them: `shopify.app.toml` had this subscription block commented out, so
 * Shopify had no delivery to make, and the app had no way to learn that an
 * order existed. The route below was never called, and would not have coped if
 * it had been — it did the whole intake inline, and any slow step in it would
 * have been answered with a timeout Shopify counts as a failed delivery.
 *
 * WHAT THIS ROUTE DOES NOW: authenticates, records the delivery, queues the
 * work, and answers 200. Nothing else.
 *
 * WHY THE WORK IS NOT DONE HERE. Shopify expects an answer in a few seconds and
 * retries what it does not get one for. Intake reads the seller, resolves the
 * line bindings, prices every line, writes the order, its items, its bill and
 * its first state transition — a dozen round trips, any of which can be slow
 * when the database is busy. Doing that inside the delivery turns a busy
 * database into lost orders. So the route's only job is to make the delivery
 * durable and get out of the way; `SHOPIFY_ORDER_INTAKE` does the rest, and
 * being slow there costs nobody a delivery.
 *
 * WHY 200 AND NOT 500 ON A PROCESSING FAILURE. The delivery has been recorded,
 * and the record is what the queue works from. Returning 500 would ask Shopify
 * to send the same event again, and the second copy would be recorded as a
 * duplicate and enqueue nothing — so the retry would achieve nothing except
 * noise, while the original job is still there and still retrying under its own
 * backoff. A genuine failure to RECORD the delivery is different and does
 * return 500: that one has left no trace, and a redelivery is exactly the right
 * response to it.
 */
export const action = async ({ request }) => {
  /*
   * The official helper, used for what it is: it reads the raw body and checks
   * the HMAC over it before anything parses a byte. It throws a 401 for a bad
   * signature and a 400 for a malformed delivery, which is why a request that
   * fails verification never reaches a line below.
   *
   * The shop comes from this call and from nowhere else. A shop domain read out
   * of the payload would be attacker-controlled — the payload is only as
   * trustworthy as the signature over it, and the signature is over the body,
   * not over the header that claims which store sent it.
   */
  const { topic, shop, payload, webhookId } = await authenticate.webhook(request);

  if (!WEBHOOK_TOPICS.has(topic)) {
    // Subscribed to something this deployment does not act on. Answered, not
    // recorded: an event with no handler is not an event worth keeping.
    return new Response(null, { status: 200 });
  }

  const orderId = resolveOrderId(topic, payload);

  /*
   * THE DELIVERY ID IS THE DEDUPE KEY, AND IT IS SHOPIFY'S OWN.
   *
   * Shopify sends the same event more than once — a slow answer, a deploy, an
   * at-least-once redelivery — and every copy carries the same
   * X-Shopify-Webhook-Id. Recording that id makes a redelivery a duplicate
   * rather than a second order. The unique index on the column is what enforces
   * it: two copies arriving at the same instant race on the index, one wins,
   * and the loser gets a constraint violation rather than a second order.
   *
   * When the header is absent the delivery falls back to a key composed from
   * the event's own identity — the topic, the order and the moment Shopify says
   * the order last changed. That is the same key `intakeOrder` dedupes on, so
   * the two agree about what "the same event" means.
   */
  const deliveryKey = webhookId || `${shop}:${topic}:${orderId}:${versionOf(payload)}`;

  let event;
  try {
    event = await prisma.webhookEvent.create({
      data: {
        shopDomain: shop,
        topic,
        // Held only until the queue has processed the delivery; cleared to a
        // redacted summary afterwards. See `finishDelivery` in orderIntake.
        payload: JSON.stringify(payload),
        status: "PROCESSING",
        shopifyWebhookId: webhookId || null,
        source: "WEBHOOK",
        idempotencyKey: deliveryKey,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Seen this delivery already. Answering 200 is the correct response: the
      // work is either done or queued, and a redelivery must not create a
      // second order.
      return new Response(null, { status: 200 });
    }
    /*
     * The delivery could not be recorded, so it has left no trace. This is the
     * one case where asking for a redelivery is right.
     */
    return new Response("Could not record delivery", { status: 500 });
  }

  try {
    await enqueueJob({
      kind: JOB_KIND.SHOPIFY_ORDER_INTAKE,
      // Keyed by the delivery, so two different events about the same order are
      // two jobs, and one event delivered twice is one.
      idempotencyKey: `shopify-order-intake:${deliveryKey}`,
      // Carries the event ROW, not the payload: the payload is on the row, and
      // a job payload is long-lived and shown to operators.
      payload: { webhookEventId: event.id, topic, shop },
      maxAttempts: 6,
    });
  } catch {
    /*
     * The delivery is recorded and PENDING, so it is not lost — the sweep in
     * `ensureRecurringJobs` will queue anything left unprocessed. Answering 200
     * keeps Shopify from sending a copy that would be dropped as a duplicate.
     */
    return new Response(null, { status: 200 });
  }

  return new Response(null, { status: 200 });
};

/**
 * Which order a delivery is about.
 *
 * Orders carry their own id. A refund carries the order it belongs to under
 * `order_id`, and a fulfillment-order routing event carries a fulfillment order
 * whose order has to be fetched — which the intake job does, because it is the
 * only place with an authenticated client. Returns null when the payload has no
 * order in it at all, which is not an error: the job resolves it.
 */
function resolveOrderId(topic, payload) {
  if (payload?.order_id) return String(payload.order_id);
  if (payload?.id && topic !== "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE") return String(payload.id);
  return null;
}

/** The version of an order payload, matching what `intakeOrder` keys on. */
function versionOf(payload) {
  return payload?.updated_at ?? payload?.cancelled_at ?? payload?.created_at ?? "";
}

/** Prisma's unique-constraint violation, without importing the error class. */
function isUniqueViolation(error) {
  return Boolean(error && typeof error === "object" && error.code === "P2002");
}
