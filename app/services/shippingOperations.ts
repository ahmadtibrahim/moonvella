import type { ReturnRequestStatus, ShippingClaimStatus } from "@prisma/client";

/** Allowed manual transitions. Kept client-safe so controls and services agree. */
export const RETURN_NEXT: Record<ReturnRequestStatus, readonly ReturnRequestStatus[]> = {
  REQUESTED: ["UNDER_REVIEW", "APPROVED", "REJECTED", "CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["LABEL_PENDING", "IN_TRANSIT", "CANCELLED"],
  LABEL_PENDING: ["IN_TRANSIT", "CANCELLED"],
  IN_TRANSIT: ["RECEIVED"],
  RECEIVED: ["INSPECTED"],
  INSPECTED: ["RESOLVED"],
  RESOLVED: [],
  REJECTED: [],
  CANCELLED: [],
};

export const CLAIM_NEXT: Record<ShippingClaimStatus, readonly ShippingClaimStatus[]> = {
  DRAFT: ["EVIDENCE_REQUIRED", "READY_TO_SUBMIT", "CANCELLED"],
  EVIDENCE_REQUIRED: ["READY_TO_SUBMIT", "CANCELLED"],
  READY_TO_SUBMIT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["CARRIER_REVIEW", "APPROVED", "DENIED"],
  CARRIER_REVIEW: ["APPROVED", "DENIED"],
  APPROVED: ["PAID", "CLOSED"],
  DENIED: ["CLOSED"],
  PAID: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};
