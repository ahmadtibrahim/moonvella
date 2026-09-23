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
        templates: result.templates.map((item) => ({
          odooTemplateId: item.odooTemplateId,
          productCode: item.productCode,
          outcome: item.outcome,
        })),
      },
    };
  },
};
