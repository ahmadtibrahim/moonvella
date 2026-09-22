import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY, type AuditActorType } from "./audit.server";

interface ActorInput {
  actorType?: AuditActorType;
  actorId: string;
  actorName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function sellerDataFromApplication(application: {
  shopDomain: string;
  storeName: string;
  storeUrl: string | null;
  country: string | null;
  currency: string | null;
  shopifyPlan: string | null;
  contactName: string;
  email: string;
  phone: string | null;
}) {
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
        suspendedAt: null,
        suspensionReason: null,
      },
    });

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
        await tx.seller.update({
          where: { id: existingSeller.id },
          data: { status: "REJECTED" },
        });
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
      data: { status: "SUSPENDED", suspendedAt: now, suspensionReason: reason },
    });

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
      },
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
      },
    });

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
        approvedAt: before.approvedAt ?? new Date(),
      },
    });

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
