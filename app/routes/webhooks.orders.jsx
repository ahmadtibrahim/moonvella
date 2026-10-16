import { authenticate } from "../shopify.server";
import { prisma } from "../db.server";
import { enqueueJob, JOB_KIND } from "../services/jobs.server";
import http from "node:http";
import { WEBHOOK_TOPICS, orderIdFromDelivery } from "../services/orderIntake.server";

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

  /*
   * ASK THE QUEUE TO RUN NOW, AND DO NOT WAIT FOR THE ANSWER.
   *
   * Recording the delivery is not taking the order in — the row is PENDING and
   * the work happens when `/jobs/run` drains the queue. That endpoint is called
   * by cron every five minutes, and NOTHING ELSE CALLS IT, so an order placed
   * just after a tick sat invisible to both the seller's order list and the
   * owner's queue for the rest of the interval. That is what "the order never
   * appeared" turned out to mean: order #1005's deliveries arrived at 06:12:25
   * and the supplier order was not created until 06:17:02, because the tick
   * before it had already run.
   *
   * So the delivery kicks the queue itself. Three things make this safe:
   *
   *   • it is NOT awaited. Shopify is still answered in microseconds, which is
   *     the whole reason intake is not done inline here, and a slow or absent
   *     runner cannot delay a delivery.
   *   • `/jobs/run` claims each job with a conditional update, so a kick that
   *     overlaps the cron tick (or another delivery's kick) drains the queue
   *     once and the extra caller claims nothing.
   *   • every failure is swallowed. A missing secret, a refused host or a dead
   *     socket leaves the delivery exactly where it was — recorded, PENDING, and
   *     picked up by cron. This is an optimisation of the wait, never a
   *     dependency of correctness.
   */
  kickJobQueue(request);

  return new Response(null, { status: 200 });
};

/**
 * Nudge the queue runner, fire-and-forget.
 *
 * Loops back over the container's own listener with the app's own Host header,
 * because the server refuses any other name with a 421 — the same control that
 * keeps the owner panel from being reached by a different name. `fetch` cannot
 * be used: Host is a forbidden header name and undici silently drops it, so the
 * request would arrive under the wrong name and be refused.
 */
function kickJobQueue(request) {
  const secret = (process.env.MV_JOB_RUNNER_SECRET ?? "").trim();
  if (!secret) return;

  const port = Number(process.env.PORT ?? 3000);
  let host;
  try {
    host = new URL(request.url).host;
  } catch {
    return;
  }

  try {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/jobs/run",
        method: "POST",
        headers: {
          Host: host,
          "Content-Type": "application/json",
          "x-moonvella-job-secret": secret,
        },
      },
      (res) => res.resume()
    );
    req.setTimeout(30_000, () => req.destroy());
    req.on("error", () => {});
    req.end("{}");
  } catch {
    // Nothing to do: cron still drains the queue.
  }
}

/**
 * Which order a delivery is about.
 *
 * This is `orderIdFromDelivery` from `orderIntake.server`, called rather than
 * re-implemented: it was written out again here, slightly differently, and the
 * two copies disagreed about a routing delivery — which is the topic that
 * broke. One definition now, so the delivery key this route composes and the
 * anchor intake files the event against cannot drift apart.
 *
 * It returns null when the payload names no order at all, which is not an
 * error: the delivery id header carries the dedupe for those, and the intake
 * job resolves the order through Shopify.
 */
function resolveOrderId(topic, payload) {
  return orderIdFromDelivery(topic, payload);
}

/** The version of an order payload, matching what `intakeOrder` keys on. */
function versionOf(payload) {
  return payload?.updated_at ?? payload?.cancelled_at ?? payload?.created_at ?? "";
}

/** Prisma's unique-constraint violation, without importing the error class. */
function isUniqueViolation(error) {
  return Boolean(error && typeof error === "object" && error.code === "P2002");
}
