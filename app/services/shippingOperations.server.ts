import { randomUUID } from "node:crypto";
import type {
  ReturnRequestStatus,
  ReturnShippingPayer,
  ShippingClaimStatus,
  ShippingClaimType,
} from "@prisma/client";
import { prisma } from "~/db.server";
import { AUDIT_ENTITY, recordAudit, type AuditActorType } from "~/services/audit.server";
import { CLAIM_NEXT, RETURN_NEXT } from "~/services/shippingOperations";

export interface OperationsActor {
  actorType: AuditActorType;
  actorId: string;
  actorName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function reference(prefix: string): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}-${day}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

function text(value: unknown, label: string, max = 2000): string {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required.`);
  if (result.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return result;
}

export async function createReturnRequest(input: {
  shipmentId: string;
  reason: string;
  notes?: string;
  shippingPayer: ReturnShippingPayer;
  items: { orderItemId: string; quantity: number }[];
}, actor: OperationsActor) {
  const reason = text(input.reason, "Return reason", 500);
  const notes = String(input.notes ?? "").trim().slice(0, 4000) || null;
  const shipment = await prisma.shipment.findUnique({
    where: { id: input.shipmentId },
    include: { items: true },
  });
  if (!shipment) throw new Error("Shipment not found.");
  if (shipment.returnOfShipmentId) throw new Error("A return cannot be opened from another return shipment.");
  if (shipment.status === "CANCELLED") throw new Error("A cancelled shipment cannot be returned.");

  const shipped = new Map(shipment.items.map((item) => [item.orderItemId, item.quantity]));
  const items = input.items.filter((item) => Number.isInteger(item.quantity) && item.quantity > 0);
  if (items.length === 0) throw new Error("Select at least one item to return.");
  for (const item of items) {
    const maximum = shipped.get(item.orderItemId) ?? 0;
    if (item.quantity > maximum) throw new Error("A return quantity exceeds the quantity in this shipment.");
  }

  return prisma.$transaction(async (tx) => {
    const request = await tx.returnRequest.create({
      data: {
        rmaNumber: reference("RMA"),
        orderId: shipment.orderId,
        originalShipmentId: shipment.id,
        reason,
        notes,
        shippingPayer: input.shippingPayer,
        createdById: actor.actorId,
        createdByName: actor.actorName ?? null,
        items: { create: items },
      },
      include: { items: true },
    });
    await recordAudit({
      ...actor,
      action: "return.requested",
      entityType: AUDIT_ENTITY.RETURN_REQUEST,
      entityId: request.id,
      afterData: { rmaNumber: request.rmaNumber, shipmentId: shipment.id, reason, shippingPayer: input.shippingPayer, items },
    }, tx as unknown as Parameters<typeof recordAudit>[1]);
    return request;
  });
}

export async function advanceReturnRequest(id: string, status: ReturnRequestStatus, actor: OperationsActor) {
  const current = await prisma.returnRequest.findUnique({ where: { id } });
  if (!current) throw new Error("Return request not found.");
  if (!RETURN_NEXT[current.status].includes(status)) throw new Error(`A return cannot move from ${current.status} to ${status}.`);
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.returnRequest.update({
      where: { id },
      data: {
        status,
        ...(status === "APPROVED" ? { approvedAt: now } : {}),
        ...(status === "RECEIVED" ? { receivedAt: now } : {}),
        ...(status === "RESOLVED" ? { resolvedAt: now } : {}),
      },
    });
    await recordAudit({ ...actor, action: "return.status_changed", entityType: AUDIT_ENTITY.RETURN_REQUEST, entityId: id, beforeData: { status: current.status }, afterData: { status } }, tx as unknown as Parameters<typeof recordAudit>[1]);
    return updated;
  });
}

export async function createShippingClaim(input: {
  shipmentId: string;
  type: ShippingClaimType;
  description: string;
  amount?: number | null;
  currency: string;
  evidenceNotes?: string;
}, actor: OperationsActor) {
  const description = text(input.description, "Claim description", 2000);
  const shipment = await prisma.shipment.findUnique({ where: { id: input.shipmentId } });
  if (!shipment) throw new Error("Shipment not found.");
  if (!shipment.providerShipmentId) throw new Error("A carrier claim needs a booked provider shipment.");
  const amount = input.amount == null ? null : Math.round(input.amount);
  if (amount != null && (!Number.isSafeInteger(amount) || amount < 0)) throw new Error("Claim amount must be a valid non-negative value.");
  return prisma.$transaction(async (tx) => {
    const claim = await tx.shippingClaim.create({
      data: {
        claimNumber: reference("CLM"),
        shipmentId: shipment.id,
        type: input.type,
        description,
        amount,
        currency: input.currency.trim().toUpperCase().slice(0, 3) || "CAD",
        evidenceNotes: String(input.evidenceNotes ?? "").trim().slice(0, 4000) || null,
        createdById: actor.actorId,
        createdByName: actor.actorName ?? null,
      },
    });
    await recordAudit({ ...actor, action: "claim.created", entityType: AUDIT_ENTITY.SHIPPING_CLAIM, entityId: claim.id, afterData: { claimNumber: claim.claimNumber, shipmentId: shipment.id, type: claim.type, amount: claim.amount, currency: claim.currency } }, tx as unknown as Parameters<typeof recordAudit>[1]);
    return claim;
  });
}

export async function advanceShippingClaim(input: {
  id: string;
  status: ShippingClaimStatus;
  carrierClaimNumber?: string;
  resolutionNotes?: string;
}, actor: OperationsActor) {
  const current = await prisma.shippingClaim.findUnique({ where: { id: input.id } });
  if (!current) throw new Error("Claim not found.");
  if (!CLAIM_NEXT[current.status].includes(input.status)) throw new Error(`A claim cannot move from ${current.status} to ${input.status}.`);
  const carrierClaimNumber = String(input.carrierClaimNumber ?? "").trim().slice(0, 200) || current.carrierClaimNumber;
  if (input.status === "SUBMITTED" && !carrierClaimNumber) throw new Error("Record the carrier claim number before marking the claim submitted.");
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.shippingClaim.update({
      where: { id: input.id },
      data: {
        status: input.status,
        carrierClaimNumber,
        resolutionNotes: String(input.resolutionNotes ?? "").trim().slice(0, 4000) || current.resolutionNotes,
        ...(input.status === "SUBMITTED" ? { submittedAt: now } : {}),
        ...(["APPROVED", "DENIED", "CLOSED"].includes(input.status) ? { resolvedAt: now } : {}),
        ...(input.status === "PAID" ? { paidAt: now } : {}),
      },
    });
    await recordAudit({ ...actor, action: "claim.status_changed", entityType: AUDIT_ENTITY.SHIPPING_CLAIM, entityId: input.id, beforeData: { status: current.status }, afterData: { status: input.status, carrierClaimNumber } }, tx as unknown as Parameters<typeof recordAudit>[1]);
    return updated;
  });
}
