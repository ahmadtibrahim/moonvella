import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY, type AuditActorType } from "./audit.server";
import {
  JOB_KIND,
  cancelPendingJobsForSeller,
  enqueueJob,
  jobKey,
} from "./jobs.server";
import { markArchivePending } from "./productArchive.server";
import type { Prisma } from "@prisma/client";

interface ActorInput {
  actorType?: AuditActorType;
  actorId: string;
  actorName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

type Tx = Prisma.TransactionClient;

/**
 * Move a seller's access version, and clear the deferred work that the old
 * version justified.
 *
 * WHY THIS IS ONE FUNCTION. Every status change has the same two obligations:
 * work queued for the previous state must not run (a block must not be followed
 * by the contact sync queued while the store was approved), and the version the
 * job runner checks must move so that anything already claimed is refused. A
 * change that forgot one of them would be a status change that silently
 * honoured the old state, so they are done together, in the transaction that
 * writes the status.
 *
 * Cancelling before enqueueing is what lets the new job reuse the existing row:
 * the queue treats a CANCELLED job as a reason to try again, so re-approving a
 * store revives its pending sync in place rather than leaving a stale row that
 * the version check would reject.
 */
async function shiftAccess(tx: Tx, sellerId: string, reason: string) {
  await cancelPendingJobsForSeller(sellerId, reason, tx);
}

/** Queue the Odoo contact sync for a seller whose access is (again) approved. */
async function queueContactSync(tx: Tx, sellerId: string, accessVersion: number) {
  await enqueueJob({
    kind: JOB_KIND.ODOO_CONTACT_SYNC,
    idempotencyKey: jobKey(JOB_KIND.ODOO_CONTACT_SYNC, sellerId),
    sellerId,
    sellerAccessVersion: accessVersion,
    payload: { sellerId },
    db: tx,
  });
}

function sellerDataFromApplication(application: {
  shopDomain: string;
  storeName: string;
  storeUrl: string | null;
  country: string | null;
  currency: string | null;
  shopifyPlan: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
}) {
  /*
   * A DRAFT IS NOT AN APPLICATION.
   *
   * Opening the application page writes a row holding the imported Shopify
   * profile before the merchant has answered anything, so a row with no contact
   * answers exists for every store that has merely looked at the page. Those
   * columns are the merchant's own answers — `Seller.contactEmail` is who
   * MoonVella writes to — and an approval must not manufacture them from the
   * shop's own name or drop a null into a column that requires a value. So the
   * refusal is here, before the seller record is written, rather than a
   * substitution: there is nothing to approve until the merchant has said who
   * they are.
   */
  if (!application.contactName || !application.email) {
    throw new Error(
      "This store has not submitted its application yet, so there is nothing to approve."
    );
  }
  return {
    storeName: application.storeName,
    shopDomain: application.shopDomain,
    shopDomainFull: application.shopDomain,
    contactEmail: application.email,
    contactName: application.contactName,
    phone: application.phone,
    country: application.country,
    currency: application.currency ?? "CAD",
    shopifyPlan: application.shopifyPlan,
    storeUrl: application.storeUrl,
  };
}

/**
 * Approving an application updates the application, creates/updates the
 * operational Seller, records the reviewer + date + decision and writes an audit
 * event — all in one transaction so partial approval is impossible.
 */
export async function approveApplication(
  applicationId: string,
  actor: ActorInput,
  reason?: string
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.merchantApplication.findUnique({
      where: { id: applicationId },
    });
    if (!before) {
      throw new Error("Application not found");
    }

    const now = new Date();
    const application = await tx.merchantApplication.update({
      where: { id: applicationId },
      data: {
        status: "APPROVED",
        reviewedAt: now,
        reviewedById: actor.actorId,
        rejectionReason: null,
        internalNotes: reason ?? before.internalNotes,
      },
    });

    const seller = await tx.seller.upsert({
      where: { shopDomain: application.shopDomain },
      create: {
        ...sellerDataFromApplication(application),
        applicationId: application.id,
        status: "APPROVED",
        approvedAt: now,
      },
      update: {
        ...sellerDataFromApplication(application),
        applicationId: application.id,
        status: "APPROVED",
        approvedAt: now,
        // Every refusal column is cleared, not just the suspension pair. An
        // approval is the end of whatever the store's previous state was, and a
        // record that still carries a block reason while being approved
        // describes two opposite things at once.
        suspendedAt: null,
        suspensionReason: null,
        blockedAt: null,
        blockReason: null,
        deactivatedAt: null,
        deactivationReason: null,
        accessVersion: { increment: 1 },
      },
    });

    // The seller's access has just changed, so work queued under the old
    // version is cleared and the sync that an approved store needs is queued
    // under the new one — in the same transaction that granted the access, so
    // there is no window in which the store is approved with nothing queued.
    await shiftAccess(tx, seller.id, "The application was approved again.");
    await queueContactSync(tx, seller.id, seller.accessVersion);

    await recordAudit(
      {
        actorType: actor.actorType ?? "ADMIN_USER",
        actorId: actor.actorId,
        actorName: actor.actorName,
        action: "application.approved",
        entityType: AUDIT_ENTITY.APPLICATION,
        entityId: application.id,
        beforeData: { status: before.status },
        afterData: { status: "APPROVED", sellerId: seller.id },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      },
      tx as never
    );

    return { application, seller };
  });
}

export async function rejectApplication(
  applicationId: string,
  actor: ActorInput,
  reason: string
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.merchantApplication.findUnique({
      where: { id: applicationId },
    });
    if (!before) {
      throw new Error("Application not found");
    }

    const now = new Date();
    const application = await tx.merchantApplication.update({
      where: { id: applicationId },
      data: {
        status: "REJECTED",
        reviewedAt: now,
        reviewedById: actor.actorId,
        rejectionReason: reason,
      },
    });

    if (before.shopDomain) {
      const existingSeller = await tx.seller.findUnique({
        where: { shopDomain: before.shopDomain },
      });
      if (existingSeller) {
        const seller = await tx.seller.update({
          where: { id: existingSeller.id },
          data: { status: "REJECTED", accessVersion: { increment: 1 } },
        });
        // A rejection refuses the tools, so anything queued while the store was
        // approved — the contact sync, most of all — is cancelled rather than
        // left to run against a store that has just been turned away.
        await shiftAccess(tx, seller.id, "The application was rejected.");
      }
    }

    await recordAudit(
      {
        actorType: actor.actorType ?? "ADMIN_USER",
        actorId: actor.actorId,
        actorName: actor.actorName,
        action: "application.rejected",
        entityType: AUDIT_ENTITY.APPLICATION,
        entityId: application.id,
        beforeData: { status: before.status },
        afterData: { status: "REJECTED", reason },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      },
      tx as never
    );

    return application;
  });
}

export async function requestInformation(
  applicationId: string,
  actor: ActorInput,
  note: string
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.merchantApplication.findUnique({
      where: { id: applicationId },
    });
    if (!before) {
      throw new Error("Application not found");
    }

    const application = await tx.merchantApplication.update({
      where: { id: applicationId },
      data: { status: "NEEDS_INFO", internalNotes: note },
    });

    await recordAudit(
      {
        actorType: actor.actorType ?? "ADMIN_USER",
        actorId: actor.actorId,
        actorName: actor.actorName,
        action: "application.information_requested",
        entityType: AUDIT_ENTITY.APPLICATION,
        entityId: application.id,
        beforeData: { status: before.status },
        afterData: { status: "NEEDS_INFO", note },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      },
      tx as never
    );

    return application;
  });
}

export async function suspendSeller(
  sellerId: string,
  actor: ActorInput,
  reason: string
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.seller.findUnique({ where: { id: sellerId } });
    if (!before) {
      throw new Error("Seller not found");
    }

    const now = new Date();
    const seller = await tx.seller.update({
      where: { id: sellerId },
      data: {
        status: "SUSPENDED",
        suspendedAt: now,
        suspensionReason: reason,
        accessVersion: { increment: 1 },
      },
    });

    await shiftAccess(tx, seller.id, "The seller was suspended.");

    if (seller.applicationId) {
      await tx.merchantApplication.update({
        where: { id: seller.applicationId },
        data: { status: "SUSPENDED" },
      });
    }

    await recordAudit(
      {
        actorType: actor.actorType ?? "ADMIN_USER",
        actorId: actor.actorId,
        actorName: actor.actorName,
        action: "seller.suspended",
        entityType: AUDIT_ENTITY.SELLER,
        entityId: seller.id,
        beforeData: { status: before.status },
        afterData: { status: "SUSPENDED", reason },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      },
      tx as never
    );

    return seller;
  });
}

/**
 * Block a seller, or a store that never made it through review.
 *
 * Block is not a louder suspension. A suspension pauses a partner; a block
 * refuses one, and the difference is enforced in `ACCESS_RULES` rather than
 * here — this function's job is only to move the record and say so in the
 * audit log. The seller's orders, order lines, products and history are left
 * entirely alone: the store loses the ability to act, not the existence of
 * what it did, and MoonVella staff still see all of it.
 *
 * The suspension columns are cleared. A seller can be suspended and then
 * blocked, and leaving `suspendedAt` set would produce a record that claims two
 * different refusals at once with no way to tell which one is in force. The
 * suspension reason is not lost by this — it is in the audit log, which is
 * append-only.
 */
export async function blockSeller(
  sellerId: string,
  actor: ActorInput,
  reason: string
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.seller.findUnique({ where: { id: sellerId } });
    if (!before) {
      throw new Error("Seller not found");
    }

    const now = new Date();
    const seller = await tx.seller.update({
      where: { id: sellerId },
      data: {
        status: "BLOCKED",
        blockedAt: now,
        blockReason: reason,
        suspendedAt: null,
        suspensionReason: null,
        accessVersion: { increment: 1 },
      },
    });

    await shiftAccess(tx, seller.id, "The store was blocked.");

    // Outstanding work is marked before the job is queued, so the owner's
    // screen shows the catalogue as awaiting archiving from the instant the
    // block is visible — not from whenever a worker first looks at the queue.
    await markArchivePending(seller.id, tx);

    /*
     * Archiving is queued here and performed by the queue, not in this
     * transaction. Two reasons, and both are load-bearing: the block itself
     * must not depend on Shopify being reachable — the store loses access
     * whether or not the catalogue can be reached — and archiving is a
     * per-product operation over the network that can fail for one product and
     * succeed for the rest, which is a job, not a transaction.
     *
     * The mapping rows are marked PENDING for archiving so the owner's screen
     * shows the work as outstanding from the moment the block is committed,
     * rather than only once a worker first looks.
     */
    await enqueueJob({
      kind: JOB_KIND.SHOPIFY_ARCHIVE_PRODUCTS,
      idempotencyKey: jobKey(JOB_KIND.SHOPIFY_ARCHIVE_PRODUCTS, seller.id),
      sellerId: seller.id,
      sellerAccessVersion: seller.accessVersion,
      payload: { sellerId: seller.id },
      db: tx,
    });

    if (seller.applicationId) {
      await tx.merchantApplication.update({
        where: { id: seller.applicationId },
        data: { status: "BLOCKED" },
      });
    }

    await recordAudit(
      {
        actorType: actor.actorType ?? "ADMIN_USER",
        actorId: actor.actorId,
        actorName: actor.actorName,
        action: "seller.blocked",
        entityType: AUDIT_ENTITY.SELLER,
        entityId: seller.id,
        beforeData: { status: before.status },
        afterData: { status: "BLOCKED", reason },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      },
      tx as never
    );

    return seller;
  });
}

/**
 * Lift a block.
 *
 * WHERE THE STORE COMES BACK TO IS NOT ASSUMED. Blocking is offered for
 * approved, pending and needs-info stores, so an unblock that always returned
 * APPROVED would approve a store that review had never passed — an
 * administrative undo quietly granting the access the block was there to
 * withhold. The target is therefore read off the record: a store that had been
 * approved (`approvedAt` is set) goes back to approved, and any other store
 * goes back into the queue as PENDING, where review left it.
 *
 * A store that was NEEDS_INFO before being blocked returns as PENDING rather
 * than NEEDS_INFO. That is deliberate: NEEDS_INFO means MoonVella is waiting on
 * an answer, and this function cannot know whether the question still stands.
 * The reviewer reopens it from the application, which is where that judgement
 * belongs. Nothing is granted by the weaker state.
 *
 * The block columns are cleared, so a store that is blocked twice keeps only
 * the latest reason — the earlier one is in the audit log, which is where a
 * record of what happened belongs.
 */
export async function unblockSeller(sellerId: string, actor: ActorInput) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.seller.findUnique({ where: { id: sellerId } });
    if (!before) {
      throw new Error("Seller not found");
    }

    const restored = before.approvedAt ? "APPROVED" : "PENDING";

    const seller = await tx.seller.update({
      where: { id: sellerId },
      data: {
        status: restored,
        blockedAt: null,
        blockReason: null,
        suspendedAt: null,
        suspensionReason: null,
        accessVersion: { increment: 1 },
      },
    });

    // Cancelling here is what stops a queued archive job from running after the
    // block has been lifted: the job was justified by the block, and the block
    // is gone. Nothing is queued to put the products back — an unblock restores
    // access, and re-publishing the catalogue is the seller's decision, made
    // from their own tools, not something a status change performs.
    await shiftAccess(tx, seller.id, "The store was unblocked.");

    if (restored === "APPROVED") {
      await queueContactSync(tx, seller.id, seller.accessVersion);
    }

    if (seller.applicationId) {
      await tx.merchantApplication.update({
        where: { id: seller.applicationId },
        data: { status: restored },
      });
    }

    await recordAudit(
      {
        actorType: actor.actorType ?? "ADMIN_USER",
        actorId: actor.actorId,
        actorName: actor.actorName,
        action: "seller.unblocked",
        entityType: AUDIT_ENTITY.SELLER,
        entityId: seller.id,
        beforeData: { status: before.status },
        afterData: { status: restored, previousBlockReason: before.blockReason },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      },
      tx as never
    );

    return seller;
  });
}

/**
 * Deactivate a seller: revoke approved access, and invite them to apply again.
 *
 * HOW THIS DIFFERS FROM THE OTHER TWO REFUSALS, in one place because the three
 * are easy to confuse:
 *
 *   suspend    the store keeps its order history, and MoonVella reopens it.
 *              The merchant is not asked to do anything.
 *   deactivate the store keeps its order history, and the STORE reopens it by
 *              applying again. That is why the application is set back to
 *              DEACTIVATED rather than left approved: the application screen
 *              reads that state to decide whether to show itself, and a
 *              deactivated seller who was not shown the form could never come
 *              back.
 *   block      the store sees nothing at all, and nothing here reopens it.
 *
 * NO ARCHIVING. Blocking archives the catalogue because a block removes the
 * store's access outright; a deactivation revokes wholesale access but leaves
 * the accounting and order history readable, and the directive ties archiving
 * to the block. Treating a deactivation as a block would take a merchant's
 * storefront down over an administrative state they are being invited to fix.
 *
 * The order and accounting history is not touched, and neither is anything
 * else: this function moves a status and records why.
 */
export async function deactivateSeller(
  sellerId: string,
  actor: ActorInput,
  reason: string
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.seller.findUnique({ where: { id: sellerId } });
    if (!before) {
      throw new Error("Seller not found");
    }

    const now = new Date();
    const seller = await tx.seller.update({
      where: { id: sellerId },
      data: {
        status: "DEACTIVATED",
        deactivatedAt: now,
        deactivationReason: reason,
        // Suspension and block columns are cleared, so the record states which
        // control is in force rather than accumulating three refusal dates.
        suspendedAt: null,
        suspensionReason: null,
        blockedAt: null,
        blockReason: null,
        accessVersion: { increment: 1 },
      },
    });

    await shiftAccess(tx, seller.id, "The seller was deactivated.");

    if (seller.applicationId) {
      await tx.merchantApplication.update({
        where: { id: seller.applicationId },
        data: { status: "DEACTIVATED" },
      });
    }

    await recordAudit(
      {
        actorType: actor.actorType ?? "ADMIN_USER",
        actorId: actor.actorId,
        actorName: actor.actorName,
        action: "seller.deactivated",
        entityType: AUDIT_ENTITY.SELLER,
        entityId: seller.id,
        beforeData: { status: before.status },
        afterData: { status: "DEACTIVATED", reason, mayReapply: true },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      },
      tx as never
    );

    return seller;
  });
}

/**
 * The merchant has applied again.
 *
 * Called from the application form's submit, inside its own transaction. The
 * seller goes back to PENDING — not to its previous state — because section 4
 * says a reapplication "returns to Pending and requires owner approval", and
 * because a store that was deactivated must not regain access by resubmitting a
 * form: it goes back into the queue where a person decides.
 *
 * The access version moves so that nothing queued before the deactivation can
 * run now, and any job that was waiting is cancelled rather than left to be
 * refused by the version check at claim time.
 */
export async function returnSellerToReview(
  sellerId: string,
  tx: Tx = prisma as unknown as Tx
) {
  const seller = await tx.seller.update({
    where: { id: sellerId },
    data: { status: "PENDING", accessVersion: { increment: 1 } },
  });
  await shiftAccess(tx, seller.id, "The store submitted a new application.");
  return seller;
}

export async function reactivateSeller(sellerId: string, actor: ActorInput) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.seller.findUnique({ where: { id: sellerId } });
    if (!before) {
      throw new Error("Seller not found");
    }

    const seller = await tx.seller.update({
      where: { id: sellerId },
      data: {
        status: "APPROVED",
        suspendedAt: null,
        suspensionReason: null,
        // Cleared for the same reason the suspension columns are: Activate is
        // reachable from the Stores screen whatever the store's status was, and
        // an approved seller carrying a block date is a record that contradicts
        // itself.
        blockedAt: null,
        blockReason: null,
        deactivatedAt: null,
        deactivationReason: null,
        approvedAt: before.approvedAt ?? new Date(),
        accessVersion: { increment: 1 },
      },
    });

    await shiftAccess(tx, seller.id, "The seller was reactivated.");
    await queueContactSync(tx, seller.id, seller.accessVersion);

    if (seller.applicationId) {
      await tx.merchantApplication.update({
        where: { id: seller.applicationId },
        data: { status: "APPROVED" },
      });
    }

    await recordAudit(
      {
        actorType: actor.actorType ?? "ADMIN_USER",
        actorId: actor.actorId,
        actorName: actor.actorName,
        action: "seller.reactivated",
        entityType: AUDIT_ENTITY.SELLER,
        entityId: seller.id,
        beforeData: { status: before.status },
        afterData: { status: "APPROVED" },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
      },
      tx as never
    );

    return seller;
  });
}
