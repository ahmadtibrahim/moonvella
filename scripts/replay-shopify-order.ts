/**
 * Take one Shopify order in, on purpose.
 *
 * WHY THIS EXISTS. Order #1001 was paid for in the sandbox store and never
 * appeared in MoonVella, because no webhook subscription had ever been
 * registered and nothing was listening. Fixing the subscription fixes every
 * FUTURE order; it does not bring that one in. This script does — and it is the
 * only way to prove, end to end against the real system, that the pipeline the
 * work order describes actually runs.
 *
 * WHAT "REPLAY" MEANS HERE, AND WHAT IT DELIBERATELY IS NOT.
 *
 * It is NOT a backfill with its own code path. A second implementation of
 * ingestion would be a second place for the pricing, the line binding and the
 * dedup to be subtly different, and the difference would only ever show up on
 * the orders that went through it. Instead this script does exactly what the
 * webhook route does — writes a delivery row and enqueues the same job with the
 * same key — and then lets the queue run it. The only things it changes are the
 * two facts that are honestly different: the source is recorded as REPLAY, and
 * the payload carries an order id rather than a captured body, so the handler
 * fetches the order from Shopify exactly as it already does for a refund.
 *
 * It is NOT a special case for order #1001 either. The order is an argument;
 * any order id works, and the same protections apply to all of them.
 *
 * SAFETY, IN ORDER OF HOW BADLY IT WOULD GO WRONG.
 *
 *   1. No live charge. The script refuses to run when Stripe resolves to live
 *      mode. A sandbox order must be a test charge, and a replay that turned
 *      into a real charge would take a real seller's money for a test.
 *   2. No double charge on a second run. Stripe's idempotency key is
 *      `seller-charge:<order>:<version>` and the order is unique per
 *      (seller, shopifyOrderId), so running this twice produces one MoonVella
 *      order and one PaymentIntent. `--times 2` exists to demonstrate that
 *      rather than assert it.
 *   3. Nothing is fulfilled. The Shopify order is left unfulfilled and no
 *      shipment notification is sent; that final step is the owner's to
 *      authorise, not this script's.
 *
 * Usage — through the runner, which bundles TypeScript:
 *
 *   node scripts/run-verify.mjs scripts/replay-shopify-order.ts \
 *     --shop moonvilla-sandbox.myshopify.com \
 *     --gid gid://shopify/Order/7343191818486
 *
 *   --times N   replay N times (default 1) to demonstrate idempotency
 *   --no-drain  record the delivery and stop; do not run the queue
 */

import { PrismaClient } from "@prisma/client";
import { enqueueJob, jobKey, JOB_KIND, runDueJobs } from "../app/services/jobs.server";
import { jobHandlers } from "../app/services/jobHandlers.server";
import { stripeModeDetail } from "../app/services/stripeMode.server";
import { computeSellerCharge } from "../app/services/sellerCharge.server";

const prisma = new PrismaClient();

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Shopify's GID for an order, from either spelling a person might paste. */
function toGid(value: string): string {
  const raw = value.trim();
  if (raw.startsWith("gid://")) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/Order/${raw}`;
  throw new Error(`"${raw}" is neither a Shopify order id nor a gid:// order URL.`);
}

function numericId(gid: string): string {
  const tail = gid.split("/").pop() ?? "";
  if (!/^\d+$/.test(tail)) throw new Error(`Could not read an order id out of ${gid}.`);
  return tail;
}

function line(label: string, value: string | number | null | undefined) {
  console.log(`  ${label.padEnd(26)} ${value ?? "—"}`);
}

async function main() {
  const gid = toGid(arg("gid") || "gid://shopify/Order/7343191818486");
  const orderId = numericId(gid);
  const times = Math.max(1, Number(arg("times") || "1") || 1);
  const drain = !flag("no-drain");

  const database = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "(unset)";

  console.log("\n=== Replaying a Shopify order into MoonVella ===\n");
  line("Shopify order", gid);

  /*
   * THE MODE GATE COMES FIRST, before anything is read or written.
   *
   * A replay is the one operation in this system that acts on an order that
   * arrived while nobody was watching, and on a sandbox store the corresponding
   * charge MUST be a test charge. Checking the mode before doing any work means
   * a misconfigured deployment cannot get as far as creating a delivery row for
   * an order it is not allowed to charge for.
   */
  const { mode, source } = await stripeModeDetail();
  line("Stripe mode", `${mode} (from ${source})`);
  line("Database", database);

  if (mode === "live") {
    console.error(
      "\nREFUSED: Stripe resolves to LIVE mode. A replayed sandbox order must be charged in test mode.\n" +
        "          Set MOONVELLA_STRIPE_MODE=test with a sandbox key, or unset the live key, and re-run.\n"
    );
    process.exitCode = 2;
    return;
  }
  if (mode === "disabled") {
    console.warn(
      "\nWARNING: Stripe is disconnected. The order will be taken in and priced, and the charge will be\n" +
        "         refused by the mode gate — which is the correct behaviour and will be reported below.\n"
    );
  }

  const shopDomain =
    arg("shop") ||
    (
      await prisma.seller.findFirst({
        orderBy: { createdAt: "asc" },
        select: { shopDomain: true },
      })
    )?.shopDomain;
  if (!shopDomain) {
    console.error("No seller exists, so there is no store to replay an order for.");
    process.exitCode = 2;
    return;
  }
  line("Store", shopDomain);

  const seller = await prisma.seller.findUnique({ where: { shopDomain } });
  if (!seller) {
    console.error(`No MoonVella seller is registered for ${shopDomain}.`);
    process.exitCode = 2;
    return;
  }

  /* ---------------------------------------------------------------------- */
  /* The replay itself.                                                     */
  /* ---------------------------------------------------------------------- */

  for (let attempt = 1; attempt <= times; attempt++) {
    console.log(`\n--- replay ${attempt} of ${times} ---`);

    /*
     * The delivery row, written exactly as the route writes one. The topic is
     * ORDERS_PAID and not ORDERS_CREATE because this is a paid order: replaying
     * it as a create would describe a state the store was never in, and the
     * seller's charge is triggered by payment.
     *
     * The idempotency key is derived from the order and the topic and NOT from
     * the attempt number, so the second replay is the same delivery as the
     * first in every respect the system dedups on. That is the whole point: if
     * this key carried the attempt, a second run would look like a new event
     * and would prove nothing.
     */
    const now = new Date();
    const topic = "ORDERS_PAID";
    /*
     * A replay that is run again after a successful one reuses the SAME
     * delivery rather than making a new one. The intake job below is idempotent
     * regardless, but keeping one row per order keeps the delivery log a record
     * of what was replayed rather than of how many times.
     *
     * The row is only re-opened when it did not finish. Resetting a delivered
     * one back to PENDING achieves nothing — the job it belongs to is already
     * SUCCEEDED, so nothing runs and the row is left claiming work that was done
     * is outstanding, which is the one reading the delivery log must never give.
     * A row that failed is a different matter: that one SHOULD be re-opened, and
     * the enqueue below revives its job in place.
     */
    const key = `replay:${shopDomain}:${orderId}:${topic}`;
    const previous = await prisma.webhookEvent.findUnique({ where: { idempotencyKey: key } });
    const reopen = previous?.status !== "SUCCESS";
    const delivery = await prisma.webhookEvent.upsert({
      where: { idempotencyKey: key },
      create: {
        shopDomain,
        topic,
        payload: JSON.stringify({ id: orderId, admin_graphql_api_id: gid }),
        status: "PENDING",
        source: "REPLAY",
        idempotencyKey: key,
      },
      update: reopen
        ? { status: "PENDING", processedAt: null, errorMessage: null, retryCount: 0 }
        : {},
    });
    line("Delivery row", delivery.id);

    const job = await enqueueJob({
      kind: JOB_KIND.SHOPIFY_ORDER_INTAKE,
      idempotencyKey: jobKey(JOB_KIND.SHOPIFY_ORDER_INTAKE, seller.id, `replay:${orderId}:${topic}`),
      sellerId: seller.id,
      payload: { webhookEventId: delivery.id, topic, shop: shopDomain },
      maxAttempts: 3,
      runAt: now,
    });
    line("Intake job", `${job.id} (${job.status})`);

    if (!drain) {
      console.log("  --no-drain: the delivery is recorded and the queue was not run.");
      continue;
    }

    /*
     * The queue is run rather than the handler being called directly, so the
     * work goes through the same claim, lease and attempt machinery that the
     * cron entry point uses. Calling the handler here would skip the claim and
     * would be a second way to run a job — which is the thing this script is
     * written to avoid.
     *
     * Three rounds: intake enqueues the seller's charge, and the charge can
     * enqueue a fulfillment submit. Anything beyond that is a loop, and the
     * report below says what actually happened rather than assuming.
     */
    for (let round = 0; round < 3; round++) {
      const summary = await runDueJobs(jobHandlers, { limit: 20 });
      if (!summary.claimed) break;
    }

    /*
     * THE JOB IS READ BACK, NOT ASSUMED.
     *
     * A delivery row stays PENDING whether the work is still queued, still
     * retrying, or has failed for a reason that will never change — and the
     * reason lives on the job and nowhere else. Printing only the delivery is
     * how "No handler is registered for job kind SHOPIFY_ORDER_INTAKE" stayed
     * invisible while the row said PENDING, which reads like work in progress.
     */
    const jobAfter = await prisma.backgroundJob.findUnique({
      where: { id: job.id },
      select: { status: true, attempts: true, maxAttempts: true, lastError: true },
    });
    line("Intake job after", `${jobAfter?.status ?? "?"} (attempt ${jobAfter?.attempts ?? 0}/${jobAfter?.maxAttempts ?? 0})`);
    if (jobAfter?.lastError) line("Intake job error", jobAfter.lastError);

    const after = await prisma.webhookEvent.findUnique({ where: { id: delivery.id } });
    line("Delivery status", `${after?.status ?? "?"}${after?.errorMessage ? ` — ${after.errorMessage}` : ""}`);
  }

  /* ---------------------------------------------------------------------- */
  /* What is now true.                                                      */
  /* ---------------------------------------------------------------------- */

  const order = await prisma.order.findUnique({
    where: { supplierReference: `${shopDomain}#${orderId}` },
    include: {
      items: true,
      stateTransitions: { orderBy: { createdAt: "asc" } },
    },
  });

  console.log("\n=== Result ===\n");

  if (!order) {
    /*
     * Reported as a failure rather than dressed up. The two things that
     * legitimately produce no order are a store this app is not approved to
     * read orders from, and a seller MoonVella has not approved — and both say
     * so on the delivery row above. Saying "no order was created" without that
     * sentence is how a blocked store looks like a broken script.
     */
    console.error(
      "No MoonVella order exists for this Shopify order. Read the delivery status above: it carries\n" +
        "Shopify's or intake's own reason, which names the fix."
    );
    process.exitCode = 1;
    return;
  }

  line("MoonVella order", order.id);
  line("State", `${order.state} (since ${order.stateChangedAt.toISOString()})`);
  line("Shopify order name", order.shopifyOrderName);
  line("Shipping included", "yes — the wholesale price carries standard shipping");
  line("Fulfillment status", order.fulfillmentStatus);
  line("Shopify fulfillment state", order.shopifyFulfillmentState);

  const whys = await prisma.wholesalePayment.findUnique({
    where: { orderId: order.id },
    select: { status: true, amount: true, currency: true, providerPaymentIntentId: true, paymentVersion: true },
  });
  line("Seller charge", whys ? `${whys.status} ${whys.currency} ${(whys.amount / 100).toFixed(2)}` : "none");
  line("Payment version", whys?.paymentVersion);
  line("PaymentIntent", whys?.providerPaymentIntentId ?? "none created");

  /*
   * THE NUMBER THAT MATTERS, COMPUTED INDEPENDENTLY OF THE CHARGE.
   *
   * The charge reads the snapshot; this reads the order's own lines and prices
   * them from the catalogue again. They agreeing is what makes "the seller was
   * charged the wholesale price and not the CA$89.99 the customer paid" a
   * statement about the data rather than about one code path's arithmetic.
   */
  const expected = computeSellerCharge({
    id: order.id,
    sellerId: order.sellerId,
    currency: order.currency,
    state: order.state,
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
  line("Wholesale lines total", `${expected.currency} ${(expected.amountMinor / 100).toFixed(2)}`);
  line("Customer paid (retail)", `${order.currency} ${(order.totalPrice / 100).toFixed(2)}`);
  if (order.totalPrice !== expected.amountMinor) {
    console.log(
      `  note                      the customer's ${(order.totalPrice / 100).toFixed(2)} is the RETAIL price; ` +
        `the seller is charged the wholesale ${(expected.amountMinor / 100).toFixed(2)}.`
    );
  }

  console.log("\n  MoonVella lines:");
  for (const item of order.items) {
    console.log(
      `    ${item.sku.padEnd(20)} x${String(item.quantity).padEnd(3)} ` +
        `@ ${(item.wholesalePrice / 100).toFixed(2)} = ${((item.wholesalePrice * item.quantity) / 100).toFixed(2)}`
    );
  }

  console.log("\n  State history:");
  for (const move of order.stateTransitions) {
    console.log(
      `    ${move.createdAt.toISOString()}  ${String(move.fromState ?? "—").padEnd(24)} -> ${move.toState.padEnd(24)} ` +
        `${move.actorType}/${move.actorId}${move.reason ? ` — ${move.reason}` : ""}`
    );
  }

  const payments = await prisma.wholesalePayment.findMany({
    where: { orderId: order.id },
    select: { id: true, providerPaymentIntentId: true, attempts: { select: { id: true, status: true } } },
  });
  line("Payment rows", payments.length);
  line("Payment attempts", payments.reduce((n, p) => n + p.attempts.length, 0));

  if (times > 1) {
    console.log(
      `\n  Replayed ${times} times. One MoonVella order and ${payments.length} payment row above is the\n` +
        "  idempotency proof: a second replay of the same delivery must add nothing."
    );
  }

  console.log(
    "\n  Nothing was fulfilled and no customer notification was sent. That is a separate,\n" +
      "  owner-authorised step.\n"
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
