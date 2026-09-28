/**
 * What the queue knows how to run.
 *
 * Kept in one file so the set of jobs a deployment can execute is readable at a
 * glance. Every handler is idempotent, because at-least-once delivery means a
 * job can run twice — once when a worker dies holding a lease, and once after a
 * retry. Each one therefore states, in its own terms, what makes a second run
 * harmless.
 */

import { JOB_KIND, PermanentJobError, type JobHandler } from "./jobs.server";
import { runContactSyncJob } from "./odooContacts.server";
import { archiveSellerProducts } from "./productArchive.server";
import { importOdooProducts } from "./odooImport.server";
import { syncOdooCatalog } from "./odooSync.server";
import { probeVideoAsset, sweepVideoProbes } from "./mediaProbe.server";
import { pushVariantInventory } from "./inventoryPush.server";
import { syncShipmentTracking, sweepShipmentTracking, flagMissedPickups } from "./shipping.server";
import { intakeOrder } from "./orderIntake.server";
import { chargeSellerForOrder } from "./sellerCharge.server";
import {
  routeFulfillmentOrdersToMoonvella,
  numericId,
  type AdminClient,
} from "./shopifyFulfillment.server";
import { ensureOrderWebhookSubscriptions } from "./shopifyWebhooks.server";
import { transitionOrder, MONEY_CLEARED } from "./orderState.server";
import { prisma } from "~/db.server";
import type { BackgroundJob } from "@prisma/client";

/** The seller a job belongs to: the column, or the payload as a fallback. */
function sellerIdFor(job: BackgroundJob): string {
  const fromPayload = (job.payload as { sellerId?: unknown } | null)?.sellerId;
  const sellerId = job.sellerId ?? (typeof fromPayload === "string" ? fromPayload : null);
  if (!sellerId) {
    // Nothing a retry can do: the job was written without a seller and there is
    // no way to guess one.
    throw new PermanentJobError(
      `Job ${job.id} (${job.kind}) carries no seller, so it cannot be run.`,
    );
  }
  return sellerId;
}

export const jobHandlers: Record<string, JobHandler> = {
  /**
   * Write the approved seller's company and contacts into Odoo.
   *
   * Idempotent twice over: the `ExternalContactMapping` rows hold the partner
   * ids written the first time, so a second run updates those records rather
   * than deciding identity again; and each payload's fingerprint is compared
   * with the last one written, so an unchanged re-run issues no write at all.
   */
  [JOB_KIND.ODOO_CONTACT_SYNC]: async (job) => {
    const sellerId = sellerIdFor(job);
    // A failure that needs a person arrives as a ContactSyncBlockedError, which
    // the runner recognises as final: the reason it carries is stored on the job
    // and shown to the owner, so the queue is never the only place it exists.
    const result = await runContactSyncJob(sellerId);
    return {
      summary:
        `Odoo contact ${result.companyOutcome.toLowerCase()} (partner ${result.companyPartnerId})` +
        (result.contactPartnerId ? `, contact ${result.contactPartnerId}` : ", no contact person") +
        (result.urgentPartnerId ? `, urgent contact ${result.urgentPartnerId}` : ""),
      detail: {
        companyPartnerId: result.companyPartnerId,
        companyOutcome: result.companyOutcome,
        contactPartnerId: result.contactPartnerId,
        urgentPartnerId: result.urgentPartnerId,
        tagId: result.tagId,
        unresolved: result.unresolved,
      },
    };
  },

  /**
   * Archive a blocked store's imported products in Shopify.
   *
   * Idempotent because each product's outcome is recorded on its mapping row
   * and an already-archived row is skipped: a re-run continues from what is
   * left rather than starting over, and archiving an archived product is a
   * no-op in Shopify anyway.
   */
  [JOB_KIND.SHOPIFY_ARCHIVE_PRODUCTS]: async (job) => {
    const sellerId = sellerIdFor(job);
    const result = await archiveSellerProducts(sellerId);
    return {
      summary:
        `${result.archived} product(s) archived` +
        (result.failed ? `, ${result.failed} failed` : "") +
        (result.pending ? `, ${result.pending} still not archived` : ""),
      detail: {
        total: result.total,
        archived: result.archived,
        failed: result.failed,
        skipped: result.skipped,
        stillPending: result.pending,
        errors: result.errors.slice(0, 20),
      },
    };
  },

  /**
   * Import (or re-import) the tagged Odoo templates as MoonVella drafts.
   *
   * Idempotent through the external mappings: the same Odoo template and
   * variant ids always resolve to the same MoonVella rows, so a second run
   * updates them instead of creating a second copy of the catalogue.
   */
  [JOB_KIND.ODOO_PRODUCT_IMPORT]: async () => {
    // A job always imports for real; the preview is the owner's step, not the
    // queue's. Running a job that quietly did nothing would look like success.
    const outcome = await importOdooProducts({ confirm: true });
    if (!("result" in outcome)) {
      throw new Error("The Odoo import returned a preview while running as a job.");
    }
    const { result } = outcome;
    return {
      summary: `${result.created} product(s) created, ${result.updated} updated, ${result.variantsWritten} variant(s) written`,
      detail: {
        created: result.created,
        updated: result.updated,
        variants: result.variantsWritten,
        blocked: result.blocked,
        templates: result.templates.map((item) => ({
          odooTemplateId: item.odooTemplateId,
          productCode: item.productCode,
          outcome: item.outcome,
        })),
      },
    };
  },

  /**
   * The whole Odoo catalogue sync, on its six-hour clock.
   *
   * Idempotent for the same reason the import is — the external mappings make a
   * second read an update rather than a second catalogue — and the withdrawal
   * pass is idempotent on top of that: it skips a product that is already
   * archived, so a run that repeats does not re-date every withdrawal.
   */
  [JOB_KIND.ODOO_CATALOG_SYNC]: async () => {
    return syncOdooCatalog();
  },

  /**
   * Push a booked shipment's tracking into Shopify, when the booking's own
   * attempt did not get through.
   *
   * Idempotent through `shopifyFulfillmentId`: once a fulfillment id is stored,
   * the push happened and a re-run returns without calling Shopify again. That
   * guard is the whole point — `fulfillmentCreate` is not idempotent, and a
   * second call for the same fulfillment order is an error rather than a
   * no-op, so a retry that did not check would fail forever on a job that had
   * already succeeded.
   *
   * Pushing tracking is not marking the order shipped. The fulfillment carries
   * tracking info for the items in this shipment only; nothing here tells
   * Shopify the order left the building, and the customer is not notified —
   * that happens when the carrier is recorded as having collected.
   */
  /**
   * Poll the carriers for every shipment that is due a check.
   *
   * Idempotent by construction: the sweep is a read-modify-write over rows whose
   * own policy decides whether they are due, and a second run in the same minute
   * finds every shipment either not yet due or already claimed. Re-running it
   * cannot advance a status that the carrier has not stated — nothing in the
   * path infers progress from the clock.
   *
   * A failure here is not fatal to the tick: a provider that refuses one parcel
   * must not stop the other twenty-four from being polled, so the sweep collects
   * errors and reports them. It throws only when the sweep itself could not run,
   * which the runner retries.
   */
  [JOB_KIND.SHIPMENT_TRACKING_SWEEP]: async (job) => {
    const flagged = await flagMissedPickups();
    const summary = await sweepShipmentTracking();
    return {
      summary:
        `Polled ${summary.polled} shipment(s): ${summary.advanced} advanced` +
        (summary.failed ? `, ${summary.failed} failed` : "") +
        (summary.skipped ? `, ${summary.skipped} not due` : "") +
        (flagged.flagged ? `; flagged ${flagged.flagged} missed pickup(s)` : ""),
      detail: {
        bucket: (job.payload as { bucket?: unknown } | null)?.bucket ?? null,
        considered: summary.considered,
        polled: summary.polled,
        advanced: summary.advanced,
        failed: summary.failed,
        skipped: summary.skipped,
        errors: summary.errors,
        missedPickups: flagged.flagged,
      },
    };
  },

  /**
   * Measure one video.
   *
   * The handler never throws for a video it cannot measure. A file ffprobe
   * cannot decode would fail identically on all five attempts, so the answer is
   * recorded on the asset — FAILED, with the reason — and the job reports
   * success at having reached that answer. Retrying is then a decision a person
   * makes by pressing Retry, which is the only thing that re-queues a failed
   * probe.
   */
  [JOB_KIND.MEDIA_VIDEO_PROBE]: async (job) => {
    const assetId = (job.payload as { assetId?: unknown } | null)?.assetId;
    if (typeof assetId !== "string" || !assetId) {
      throw new PermanentJobError(
        `Job ${job.id} (${job.kind}) carries no assetId, so there is no video to measure.`,
      );
    }

    const outcome = await probeVideoAsset(assetId);
    const summary =
      outcome.status === "READY"
        ? `Measured video ${assetId} (${outcome.seconds}s).`
        : outcome.status === "FAILED"
          ? `Video ${assetId} could not be measured: ${outcome.reason}.`
          : `Video ${assetId} was not probed: ${outcome.reason}.`;
    return { summary, detail: { ...outcome } };
  },

  /**
   * The sweep that rescues videos left PROCESSING.
   *
   * Idempotent through the per-asset key: a second sweep before the first
   * probe has run finds each job already queued and adds nothing, and an asset
   * that has since reached READY or FAILED is out of scope. A probe that could
   * not be queued is reported rather than thrown, so one bad row does not stop
   * the rest of the catalogue from being measured.
   */
  [JOB_KIND.MEDIA_VIDEO_PROBE_SWEEP]: async (job) => {
    const swept = await sweepVideoProbes();
    return {
      summary:
        `${swept.considered} video(s) still processing: ${swept.enqueued} probe(s) queued` +
        (swept.alreadyQueued ? `, ${swept.alreadyQueued} already queued` : "") +
        (swept.errors.length ? `, ${swept.errors.length} could not be queued` : ""),
      detail: {
        bucket: (job.payload as { bucket?: unknown } | null)?.bucket ?? null,
        ...swept,
      },
    };
  },

  /**
   * Push a variant's quantity to the stores that list it.
   *
   * Idempotent in the way that matters here: the payload names a variant, not a
   * quantity, and the handler reads the current number when it runs. So the
   * third queued retry of one edit pushes the same value as the first and
   * leaves the store showing what the catalogue shows — running this job twice
   * is indistinguishable from running it once.
   */
  [JOB_KIND.INVENTORY_PUSH]: async (job) => {
    const productVariantId = (job.payload as { productVariantId?: unknown } | null)
      ?.productVariantId;
    if (typeof productVariantId !== "string" || !productVariantId) {
      throw new PermanentJobError(
        `Job ${job.id} (${job.kind}) carries no productVariantId, so there is no quantity to push.`,
      );
    }

    const outcome = await pushVariantInventory(productVariantId);
    const failed = outcome.failures.length > 0;
    const named = outcome.quantities[0];
    const summary =
      `${named ? `${named.sku}: ${named.quantity}` : productVariantId} sent to ${outcome.pushed} listing(s)` +
      (outcome.skipped ? `, ${outcome.skipped} skipped` : "") +
      (outcome.disabled ? ", nothing sent: the inventory push is switched off in this process" : "") +
      (failed ? `, ${outcome.failures.length} store(s) could not be reached` : "");

    // Throwing on a store that could not be reached is what makes this a retry
    // rather than a silently-dropped update. A permanent answer — a store that
    // is not approved, a variant that no longer exists — comes back as zero
    // failures and zero pushes, and ends the job quietly, which is correct:
    // there is nothing left to try.
    if (failed) throw new Error(summary);
    return { summary, detail: { ...outcome } };
  },

  [JOB_KIND.SHOPIFY_FULFILLMENT_SYNC]: async (job) => {
    const shipmentId = (job.payload as { shipmentId?: unknown } | null)?.shipmentId;
    if (typeof shipmentId !== "string" || !shipmentId) {
      throw new PermanentJobError(
        `Job ${job.id} (${job.kind}) carries no shipmentId, so there is nothing to sync.`,
      );
    }

    const shipment = await prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: {
        id: true,
        shopifyFulfillmentId: true,
        trackingNumber: true,
        providerShipmentId: true,
        order: { select: { shopifyFulfillmentOrderId: true } },
      },
    });
    if (!shipment) {
      throw new PermanentJobError(`Shipment ${shipmentId} no longer exists.`);
    }
    if (shipment.shopifyFulfillmentId) {
      return {
        summary: `Already synced (fulfillment ${shipment.shopifyFulfillmentId}); nothing sent.`,
        detail: { shipmentId, shopifyFulfillmentId: shipment.shopifyFulfillmentId, skipped: true },
      };
    }
    if (!shipment.order.shopifyFulfillmentOrderId) {
      throw new PermanentJobError(
        `Shipment ${shipmentId} has no Shopify fulfillment order id; there is nothing to fulfill against.`,
      );
    }
    if (!shipment.trackingNumber) {
      // Retryable rather than permanent: a label issued before the carrier
      // assigned a number gains one once tracking is synced, and pushing a
      // fulfillment with no tracking number would only have to be redone.
      throw new Error(
        `Shipment ${shipmentId} has no tracking number yet; will retry after tracking is synced.`,
      );
    }

    const result = await syncShipmentTracking(
      shipmentId,
      { actorId: `job:${job.id}`, actorName: "Background job (Shopify fulfillment sync)" },
      { notifyCustomer: false },
    );
    if (!result.pushed) {
      // A refusal the handler can describe but not fix: the runner retries it
      // and, if it keeps refusing, the reason is on the job for a person.
      throw new Error(
        `Shopify did not accept the fulfillment (${result.reason}${"message" in result && result.message ? `: ${result.message}` : ""}).`,
      );
    }
    return {
      summary: `Tracking pushed to Shopify (fulfillment ${result.shopifyFulfillmentId}).`,
      detail: { shipmentId, shopifyFulfillmentId: result.shopifyFulfillmentId },
    };
  },

  /**
   * Charge the seller's card for a MoonVella order.
   *
   * Three outcomes, and the difference between them is what makes this job
   * safe to have queued before the customer has paid:
   *
   *   * Charged, or already charged — done, and the order is on its way.
   *   * Nothing to do YET (the store has not been paid, or the charge needs the
   *     seller to authenticate, or the seller's settings do not authorise an
   *     automatic charge) — finished cleanly. The event that changes the answer
   *     enqueues this same key again, which revives this row.
   *   * Failed for a reason worth retrying — raised, so the queue backs off and
   *     tries again.
   *
   * A transaction that goes through `chargeSellerForOrder` twice produces one
   * PaymentIntent: the idempotency key is derived from the order and the
   * payment version, both of which are read from the database.
   */
  [JOB_KIND.SHOPIFY_SELLER_CHARGE]: async (job) => {
    const orderId = (job.payload as { orderId?: unknown } | null)?.orderId;
    if (typeof orderId !== "string" || !orderId) {
      throw new PermanentJobError(
        `Job ${job.id} (${job.kind}) carries no orderId, so there is nothing to charge for.`,
      );
    }

    const outcome = await chargeSellerForOrder({
      orderId,
      trigger: "AUTOMATIC",
      actor: { actorType: "SYSTEM", actorId: `job:${job.id}`, actorName: "Background job (seller charge)" },
    });

    if (outcome.ok) {
      return {
        summary: `Seller charged ${formatMinor(outcome.amountMinor, outcome.currency)} (${outcome.status}).`,
        detail: { ...outcome },
      };
    }

    if (outcome.awaitingCustomerPayment) {
      return {
        summary: "Waiting for the store to be paid; nothing charged.",
        detail: { ...outcome },
      };
    }
    if (outcome.requiresPaymentMethod) {
      return {
        summary: "The seller has no saved payment method; the order is held until they add one.",
        detail: { ...outcome },
      };
    }
    if (outcome.requiresAction) {
      return {
        summary: "The card issuer requires authentication; the order is held until the seller completes it.",
        detail: { ...outcome },
      };
    }

    /*
     * A decline. Not permanent — the seller may add another card and the retry
     * path bumps the payment version — but not worth burning five attempts on
     * either, because nothing changes until a person acts. The job finishes
     * with the reason recorded and the order sitting in PAYMENT_FAILED, which
     * is what the seller's page and the admin queue both read.
     */
    return {
      summary: `Charge failed: ${outcome.message ?? "no reason given"}`,
      detail: { ...outcome },
    };
  },

  /**
   * Hand a paid order to the warehouse: route its MoonVella lines to MoonVella's
   * location and open the fulfillment request.
   *
   * THE PAYMENT GATE IS RE-CHECKED HERE, not assumed from the fact that this job
   * was queued. A job in the queue is a message, and a message can be wrong —
   * queued by an older version of the code, by a manual replay, by a bug. The
   * state is read from the order and the handler refuses unless the money has
   * cleared, which is the same question the shipping code asks before it sends
   * a fulfillment to Shopify. Two checks in the same shape, both reading the
   * order rather than a flag somebody passed.
   */
  [JOB_KIND.SHOPIFY_FULFILLMENT_SUBMIT]: async (job) => {
    const orderId = (job.payload as { orderId?: unknown } | null)?.orderId;
    if (typeof orderId !== "string" || !orderId) {
      throw new PermanentJobError(
        `Job ${job.id} (${job.kind}) carries no orderId, so there is nothing to route.`,
      );
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, state: true, wholesalePaymentStatus: true },
    });
    if (!order) throw new PermanentJobError(`Order ${orderId} no longer exists.`);

    if (!MONEY_CLEARED.has(order.state as never)) {
      throw new PermanentJobError(
        `Refusing to prepare order ${orderId} for fulfillment: it is ${order.state} and the seller's ` +
          `charge is ${order.wholesalePaymentStatus}. Goods are never picked for an order that has not been paid for.`,
      );
    }

    const routing = await routeFulfillmentOrdersToMoonvella(orderId);

    await prisma.fulfillmentRequest.upsert({
      where: { orderId },
      create: { orderId, status: "PENDING" },
      update: {},
    });

    if (order.state === "READY_FOR_FULFILLMENT") {
      await transitionOrder(
        {
          orderId,
          to: "FULFILLMENT_REQUESTED",
          actor: { actorType: "SYSTEM", actorId: `job:${job.id}`, actorName: "Background job (fulfillment)" },
          reason: "Routed to the MoonVella location and queued for the warehouse.",
        },
        undefined,
      ).catch(() => undefined);
    }

    /*
     * A routing refusal is raised, not swallowed: the order is paid for and the
     * goods are owed, and an order whose lines are still assigned to the
     * merchant's shelf cannot be shipped. Someone has to see it.
     */
    if (routing.refused.length) {
      throw new Error(
        `Order ${orderId} is paid but ${routing.refused.length} fulfillment order(s) could not be moved to ` +
          `MoonVella's location: ${routing.refused.map((r) => `${r.fulfillmentOrderId} (${r.reason})`).join("; ")}`,
      );
    }

    return {
      summary:
        `Routed to MoonVella location ${routing.locationId}: ` +
        `${routing.moved.length} moved, ${routing.alreadyRouted.length} already there, ` +
        `${routing.untouched} unrelated fulfillment order(s) left alone.`,
      detail: { ...routing },
    };
  },

  /**
   * Ask Shopify to deliver this app's order events.
   *
   * IDEMPOTENT BY READING FIRST: the registrar lists the existing subscriptions
   * and creates only the topics that are absent, so a beat that runs while the
   * previous beat is still in flight cannot double-subscribe a topic — which
   * would make Shopify deliver every event twice.
   *
   * A REFUSAL IS NOT A JOB FAILURE. Until the app is approved for Protected
   * Customer Data, this call is refused every single time, and failing the job
   * would fill the queue with retries of something no retry can fix and bury
   * the failures that matter. The refusal is recorded on the integration row
   * and in the audit log — where it is visible — and the job succeeds.
   *
   * Sellers with no session are skipped rather than attempted: a store that
   * uninstalled the app leaves a Seller row behind, and calling `admin` for it
   * throws for a reason that is not worth storing every fifteen minutes.
   */
  [JOB_KIND.SHOPIFY_WEBHOOK_SUBSCRIBE]: async (job) => {
    const sessions = await prisma.session.findMany({ select: { shop: true } });
    const shops = new Set(sessions.map((s) => s.shop));
    const sellers = await prisma.seller.findMany({
      where: { shopDomain: { in: [...shops] } },
      select: { id: true, shopDomain: true },
    });

    if (!sellers.length) {
      return { summary: "No store has a usable session, so there is nothing to subscribe." };
    }

    const results: {
      shopDomain: string;
      registered: number;
      alreadyPresent: number;
      refused: string[];
      blockedBy: string | null;
    }[] = [];

    for (const seller of sellers) {
      try {
        const outcome = await ensureOrderWebhookSubscriptions(seller.id);
        results.push({
          shopDomain: seller.shopDomain,
          registered: outcome.registered.length,
          alreadyPresent: outcome.alreadyPresent.length,
          refused: outcome.refused.map((r) => r.topic),
          blockedBy: outcome.blockedBy ?? null,
        });
      } catch (error) {
        /*
         * A throw here is not the ordinary refusal — that is returned, not
         * raised — so it is a genuinely unexpected failure for this one store.
         * Recorded against the store and the sweep continues, because one
         * broken store must not stop the others from being registered.
         */
        results.push({
          shopDomain: seller.shopDomain,
          registered: 0,
          alreadyPresent: 0,
          refused: [],
          blockedBy: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const blocked = results.filter((r) => r.blockedBy).length;
    return {
      summary:
        `${results.length} store(s) checked; ` +
        `${results.reduce((n, r) => n + r.registered, 0)} topic(s) newly registered, ` +
        `${blocked} store(s) still blocked.`,
      detail: { results, jobId: job.id },
    };
  },

  /**
   * Take one Shopify order event in.
   *
   * REGISTERED HERE, AND THAT IS THE LINE THAT MATTERS. This handler was once
   * left out of the map on the reasoning that a factory taking an optional
   * client is somehow not an entry — and the cost was total: every intake job
   * the webhook route queued came back with "No handler is registered for job
   * kind SHOPIFY_ORDER_INTAKE", the delivery stayed pending, and no order was
   * ever taken in. The suite did not catch it because the replay check built
   * its own handler map, which is a map the queue never sees. `verify-shopify-orders`
   * now asserts every kind the pipeline enqueues is registered in THIS object,
   * and that check is the one that would have failed.
   *
   * A factory is a way to BUILD this handler, never a reason to leave it out.
   * Production calls it with no argument, below.
   */
  [JOB_KIND.SHOPIFY_ORDER_INTAKE]: intakeJobHandler(),
};

/**
 * Take one Shopify order event in.
 *
 * Idempotent three times over, which is what it takes to be safe here. The
 * delivery row is claimed by `intakeOrder` and a delivery that is already
 * SUCCESS returns immediately; `intakeOrder`'s own dedupe key is
 * (shop, topic, order, payload version), so a redelivery with a new delivery
 * id but identical content is still a duplicate; and the order table's unique
 * (seller, shopifyOrderId) index is the last line of defence, which turns a
 * race between two workers into a constraint violation rather than a second
 * order.
 *
 * The payload is read back off the delivery row rather than carried on the
 * job, and the row is rewritten with a redacted summary once the work is done
 * — see `finishEvent`. That is what keeps a customer's address from living
 * forever in a table nothing prunes.
 *
 * WHY THIS IS A FACTORY. The handler above all others needs a live Shopify
 * client: a replay, a refund or a routing event arrives without the order on
 * it, and the order has to be fetched before there is anything to take in.
 * That client is the one thing about this handler a test cannot fake —
 * Shopify's own API client does not go through `globalThis.fetch`, so stubbing
 * the global reaches nothing — and the behaviour most worth pinning is exactly
 * the part that needs it: that a replay run twice creates one order and one
 * payment.
 *
 * So the client is a parameter. Production calls this with none and gets the
 * store's own authenticated client, unchanged; a harness passes one that
 * answers from a table and gets the whole handler — the delivery claim, the
 * hydration, the intake, the redaction, the queue's own attempt accounting —
 * with only the network replaced. The alternative, testing the pieces either
 * side of the fetch, is how a pipeline passes its tests and fails on the
 * first real order.
 */
export function intakeJobHandler(adminOverride?: AdminClient): JobHandler {
  return async (job) => {
    const payload = job.payload as {
      webhookEventId?: unknown;
      topic?: unknown;
      shop?: unknown;
    } | null;
    const webhookEventId = payload?.webhookEventId;
    const topic = payload?.topic;
    const shop = payload?.shop;
    if (typeof webhookEventId !== "string" || typeof topic !== "string" || typeof shop !== "string") {
      throw new PermanentJobError(
        `Job ${job.id} (${job.kind}) is missing webhookEventId, topic or shop, so there is nothing to take in.`,
      );
    }

    const delivery = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!delivery) {
      throw new PermanentJobError(`Delivery ${webhookEventId} no longer exists.`);
    }
    if (delivery.status === "SUCCESS") {
      return {
        summary: "Already taken in; nothing done.",
        detail: { webhookEventId, duplicate: true },
      };
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(delivery.payload) as Record<string, unknown>;
    } catch {
      /*
       * The body was already replaced by its summary, which means a previous
       * run finished the work and the status write was lost. Re-running the
       * summary would be intake on a payload that is not an order. The delivery
       * is marked finished rather than retried forever over a body that cannot
       * come back.
       */
      await prisma.webhookEvent.update({
        where: { id: delivery.id },
        data: {
          status: "SUCCESS",
          processedAt: new Date(),
          errorMessage: "Body had already been redacted; treated as processed.",
        },
      });
      return { summary: "Body already redacted; nothing done.", detail: { webhookEventId } };
    }

    /*
     * A `refunds/create` or a routing event does not carry the order, and this
     * handler is where the authenticated client lives. The order is fetched
     * from Shopify so the rest of the pipeline sees the same shape it sees for
     * an `orders/*` delivery — which is the whole reason the fetch is here and
     * not inside `intakeOrder`: intake stays a pure function of its payload,
     * and the one thing that needs a network call happens once, above it.
     */
    const hydrated = await hydrateOrderPayload({ topic, shop, payload: body, adminOverride });
    const result = await intakeOrder({
      topic,
      shop,
      payload: hydrated.payload as never,
      /*
       * The reason the order could not be read travels with it, so intake can
       * end the delivery honestly instead of filing an unreadable order as one
       * with nothing on it. See `hydrateOrderPayload`.
       */
      orderUnavailable: hydrated.failure,
      source: delivery.source === "REPLAY" ? "REPLAY" : "WEBHOOK",
      eventId: delivery.id,
    });

    if (!result.ok) {
      // `intakeOrder` has already recorded the refusal on the delivery with its
      // reason. Raising it here would make the queue retry something that will
      // be refused identically — a blocked seller, a payload with no order id.
      return { summary: `Not taken in: ${result.reason ?? "no reason given"}.`, detail: { ...result } };
    }

    return {
      summary: result.duplicate
        ? "Delivery was a duplicate of one already taken in."
        : `Order taken in with ${result.moonvellaItems ?? 0} MoonVella line(s)` +
          (result.updated ? " (updated an existing order)." : "."),
      detail: { ...result },
    };
  };
}

/**
 * Give a non-order event the order it is about.
 *
 * `refunds/create` carries a refund and `fulfillment_orders/order_routing_complete`
 * carries a fulfillment order. Intake, though, is written against orders — that
 * is the shape it has always taken and the shape its arithmetic is expressed
 * in — so the order is fetched here, once, with an authenticated client, rather
 * than teaching every branch of intake to accept three payload shapes.
 *
 * A FETCH THAT FAILS COMES BACK WITH ITS REASON, AND THAT IS NOT THE SAME AS AN
 * EMPTY ORDER. The first version of this returned the original payload and let
 * intake decide what to do with it — and what intake decided was "No MoonVella
 * items", because a payload with no line items is indistinguishable from an
 * order with no MoonVella lines. So a delivery the app was not permitted to
 * read was recorded as SUCCESS, was never retried, and read to an operator as
 * a fact about the order rather than a fact about the app's access to it.
 *
 * That is exactly what happened on the first live replay: the store refuses to
 * let this app read the Order object until it is approved for protected
 * customer data, and the delivery log said the order had no MoonVella items.
 * Both statements describe the same run; only one of them names the fix.
 *
 * So the failure travels with the payload. The caller records it against the
 * delivery and the delivery ends FAILED — the truth, and a state that does not
 * claim work is outstanding.
 */
async function hydrateOrderPayload(input: {
  topic: string;
  shop: string;
  payload: Record<string, unknown>;
  /** The store's client, when the caller already has one. See `intakeJobHandler`. */
  adminOverride?: AdminClient;
}): Promise<{ payload: Record<string, unknown>; failure: string | null }> {
  const { topic, shop, payload } = input;
  /*
   * TWO REASONS TO GO AND FETCH THE ORDER.
   *
   * A `refunds/create` or a routing event does not carry the order at all, so
   * there is nothing to take in until Shopify is asked. That was the original
   * condition.
   *
   * The second reason is a REPLAY. A replay is a delivery this app mints for
   * itself — it says "treat this order as though it had just arrived" — and its
   * payload is an order id and nothing more, because a replayed order is by
   * definition not a payload that was captured and kept. The condition is
   * written as "the payload does not carry line items" rather than as "the
   * topic is a replay", so that a genuine `orders/create` that somehow arrived
   * without line items is repaired the same way instead of being intaken as an
   * order with nothing on it.
   */
  const isRefundOrRouting =
    topic === "REFUNDS_CREATE" || topic === "FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE";
  const carriesTheOrder = Array.isArray(payload.line_items);
  if (!isRefundOrRouting && carriesTheOrder) return { payload, failure: null };

  const orderId = isRefundOrRouting ? payload.order_id : (payload.id ?? payload.order_id);
  if (orderId === undefined || orderId === null) return { payload, failure: null };

  try {
    const seller = await prisma.seller.findUnique({ where: { shopDomain: shop } });
    if (!seller) return { payload, failure: null };
    const admin =
      input.adminOverride ??
      (await (async () => {
        const { unauthenticated } = await import("~/shopify.server");
        return (await unauthenticated.admin(seller.shopDomain)).admin as unknown as AdminClient;
      })());

    /*
     * THE ORDER NUMBER IS `number`, AND ASKING FOR `orderNumber` BROKE EVERY
     * HYDRATION. The deployment answered "Field 'orderNumber' doesn't exist on
     * type 'Order'" — this is the fetch every replay, refund and routing event
     * goes through, so all of them failed. The suite could not see it: its store
     * is a stub that answers whatever the fixture says, so a field name the real
     * schema does not have is a field name the stub happily returns. Found by
     * running the replay against the deployed system; the field list was then
     * read off the live schema by introspection, which is where `number`,
     * `confirmationNumber` and `poNumber` come from and why `orderNumber` does
     * not.
     */
    const res = await admin.graphql(
      `#graphql
        query MoonVellaOrderForEvent($id: ID!) {
          order(id: $id) {
            id
            name
            # The order number is "number" on this API version. See the note
            # above the request: "orderNumber" does not exist on Order and
            # asking for it failed every hydration.
            number
            email
            currencyCode
            displayFinancialStatus
            displayFulfillmentStatus
            createdAt
            updatedAt
            cancelledAt
            totalTaxSet { shopMoney { amount } }
            totalDiscountsSet { shopMoney { amount } }
            subtotalPriceSet { shopMoney { amount } }
            totalPriceSet { shopMoney { amount } }
            totalShippingPriceSet { shopMoney { amount } }
            shippingAddress {
              name
              company
              address1
              address2
              city
              province
              provinceCode
              country
              countryCodeV2
              zip
            }
            lineItems(first: 250) {
              nodes {
                id
                sku
                name
                quantity
                variant { id }
                originalUnitPriceSet { shopMoney { amount } }
              }
            }
          }
        }`,
      { variables: { id: `gid://shopify/Order/${orderId}` } },
    );
    const json: {
      data?: { order?: Record<string, unknown> | null };
      errors?: { message: string }[];
    } = await res.json();
    if (Array.isArray(json?.errors) && json.errors.length) {
      return { payload, failure: json.errors.map((e) => e.message).join("; ") };
    }

    const order = json?.data?.order;
    if (!order) {
      return { payload, failure: `Shopify returned no order for id ${orderId}.` };
    }

    // Reshaped into the same field names the webhook payload uses, so intake
    // has exactly one payload shape to understand.
    const money = (set: unknown) =>
      (set as { shopMoney?: { amount?: string } } | null)?.shopMoney?.amount ?? null;

    return {
      payload: {
      ...payload,
      id: numericId(String(order.id)),
      order_id: numericId(String(order.id)),
      name: order.name,
      order_number: order.number,
      email: order.email,
      currency: order.currencyCode,
      financial_status: String(order.displayFinancialStatus ?? "").toLowerCase() || undefined,
      fulfillment_status: order.displayFulfillmentStatus
        ? String(order.displayFulfillmentStatus).toLowerCase()
        : null,
      created_at: order.createdAt,
      updated_at: order.updatedAt,
      cancelled_at: order.cancelledAt ?? null,
      total_tax: money(order.totalTaxSet) ?? undefined,
      total_discounts: money(order.totalDiscountsSet) ?? undefined,
      subtotal_price: money(order.subtotalPriceSet) ?? undefined,
      total_price: money(order.totalPriceSet) ?? undefined,
      total_shipping_price_set: { shop_money: { amount: money(order.totalShippingPriceSet) } },
      /*
       * THE ADDRESS IS RESHAPED, NOT STORED AS RETURNED.
       *
       * Order.shippingAddress holds a JSON blob that was written from a webhook,
       * so it wears the webhook's field names — `country_code`, not
       * `countryCodeV2` — and the screens that read it look for those names.
       * A fetched order written through unchanged would store `countryCodeV2`
       * and every address gathered this way would render with no country on it.
       * Two spellings of the same fact is exactly the kind of difference that
       * shows up as a blank line on a shipping label rather than as an error.
       */
      shipping_address: order.shippingAddress
        ? {
            name: (order.shippingAddress as Record<string, unknown>).name ?? null,
            company: (order.shippingAddress as Record<string, unknown>).company ?? null,
            address1: (order.shippingAddress as Record<string, unknown>).address1 ?? null,
            address2: (order.shippingAddress as Record<string, unknown>).address2 ?? null,
            city: (order.shippingAddress as Record<string, unknown>).city ?? null,
            province: (order.shippingAddress as Record<string, unknown>).province ?? null,
            province_code: (order.shippingAddress as Record<string, unknown>).provinceCode ?? null,
            country: (order.shippingAddress as Record<string, unknown>).country ?? null,
            country_code: (order.shippingAddress as Record<string, unknown>).countryCodeV2 ?? null,
            zip: (order.shippingAddress as Record<string, unknown>).zip ?? null,
          }
        : null,
      line_items: ((order.lineItems as { nodes?: Record<string, unknown>[] } | null)?.nodes ?? []).map(
        (li) => ({
          id: numericId(String(li.id)),
          variant_id: li.variant ? numericId(String((li.variant as { id: string }).id)) : null,
          title: li.name,
          sku: li.sku,
          quantity: li.quantity,
          price: money(li.originalUnitPriceSet) ?? "0",
        }),
      ),
      },
      failure: null,
    };
  } catch (error) {
    /*
     * The client itself failed — no session, a revoked token, a network error.
     * That is a different reason from a refusal and it is reported as itself
     * rather than folded into "no items".
     */
    return { payload, failure: error instanceof Error ? error.message : String(error) };
  }
}

/** Minor units to something a person reads, without a currency library. */
function formatMinor(amount: number, currency: string): string {
  const value = (amount / 100).toFixed(2);
  return `${currency} ${value}`;
}
