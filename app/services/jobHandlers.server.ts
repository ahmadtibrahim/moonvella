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
import { syncShipmentTracking, sweepShipmentTracking, flagMissedPickups } from "./shipping.server";
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
};
