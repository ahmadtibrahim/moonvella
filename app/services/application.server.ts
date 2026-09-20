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
        actorType: actor.actorType ?? "OWNER_USER",
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
        actorType: actor.actorType ?? "OWNER_USER",
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
        actorType: actor.actorType ?? "OWNER_USER",
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
        actorType: actor.actorType ?? "OWNER_USER",
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
        actorType: actor.actorType ?? "OWNER_USER",
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
