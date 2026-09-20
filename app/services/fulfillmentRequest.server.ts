import type { FulfillmentRequest } from "@prisma/client";
import { prisma } from "~/db.server";
import { recordAudit, AUDIT_ENTITY } from "./audit.server";
import type { Actor } from "./products.server";

export type FulfillmentRequestStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "CANCELLED" | "CLOSED";

export async function getFulfillmentRequest(orderId: string) {
  return prisma.fulfillmentRequest.findUnique({ where: { orderId } });
}

async function requireRequest(orderId: string): Promise<FulfillmentRequest> {
  const request = await prisma.fulfillmentRequest.findUnique({ where: { orderId } });
  if (!request) throw new Error(`No fulfillment request exists for order ${orderId}.`);
  return request;
}

function assertStatus(
  request: FulfillmentRequest,
  allowed: FulfillmentRequestStatus[],
  action: string
) {
  if (!allowed.includes(request.status as FulfillmentRequestStatus)) {
    throw new Error(
      `Cannot ${action} the fulfillment request for order ${request.orderId}: ` +
        `status is ${request.status}, expected ${allowed.join(" or ")}.`
    );
  }
}

async function auditTransition(
  before: FulfillmentRequest,
  after: FulfillmentRequest,
  action: string,
  actor: Actor,
  extra: Record<string, unknown> = {}
) {
  await recordAudit({
    actorType: actor.actorType ?? "OWNER_USER",
    actorId: actor.actorId,
    actorName: actor.actorName,
    action,
    entityType: AUDIT_ENTITY.ORDER,
    entityId: after.orderId,
    beforeData: { status: before.status },
    afterData: {
      status: after.status,
      acceptedAt: after.acceptedAt,
      rejectedAt: after.rejectedAt,
      rejectReason: after.rejectReason,
      closedAt: after.closedAt,
      ...extra,
    },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

/** PENDING -> ACCEPTED. */
export async function acceptFulfillmentRequest(orderId: string, actor: Actor): Promise<FulfillmentRequest> {
  const request = await requireRequest(orderId);
  assertStatus(request, ["PENDING"], "accept");
  const updated = await prisma.fulfillmentRequest.update({
    where: { id: request.id },
    data: { status: "ACCEPTED", acceptedAt: new Date() },
  });
  await auditTransition(request, updated, "fulfillment_request.accepted", actor);
  return updated;
}

/** PENDING -> REJECTED. A non-empty reason is required. */
export async function rejectFulfillmentRequest(
  orderId: string,
  reason: string,
  actor: Actor
): Promise<FulfillmentRequest> {
  const trimmed = String(reason ?? "").trim();
  if (!trimmed) throw new Error("A rejection reason is required.");
  const request = await requireRequest(orderId);
  assertStatus(request, ["PENDING"], "reject");
  const updated = await prisma.fulfillmentRequest.update({
    where: { id: request.id },
    data: { status: "REJECTED", rejectedAt: new Date(), rejectReason: trimmed },
  });
  await auditTransition(request, updated, "fulfillment_request.rejected", actor, { reason: trimmed });
  return updated;
}

/** ACCEPTED -> CLOSED (e.g. after the supplier has fulfilled). */
export async function closeFulfillmentRequest(orderId: string, actor: Actor): Promise<FulfillmentRequest> {
  const request = await requireRequest(orderId);
  assertStatus(request, ["ACCEPTED"], "close");
  const updated = await prisma.fulfillmentRequest.update({
    where: { id: request.id },
    data: { status: "CLOSED", closedAt: new Date() },
  });
  await auditTransition(request, updated, "fulfillment_request.closed", actor);
  return updated;
}

/** PENDING or ACCEPTED -> CANCELLED. The reason is recorded in the audit log. */
export async function cancelFulfillmentRequest(
  orderId: string,
  reason: string,
  actor: Actor
): Promise<FulfillmentRequest> {
  const request = await requireRequest(orderId);
  assertStatus(request, ["PENDING", "ACCEPTED"], "cancel");
  const updated = await prisma.fulfillmentRequest.update({
    where: { id: request.id },
    data: { status: "CANCELLED", closedAt: new Date() },
  });
  await auditTransition(request, updated, "fulfillment_request.cancelled", actor, { reason });
  return updated;
}
