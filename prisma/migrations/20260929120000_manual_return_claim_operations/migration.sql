-- Manual return authorizations and carrier-claim case files.
-- Neither table performs provider, Shopify, inventory, or refund side effects.

CREATE TYPE "ReturnRequestStatus" AS ENUM (
  'REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'LABEL_PENDING', 'IN_TRANSIT',
  'RECEIVED', 'INSPECTED', 'RESOLVED', 'REJECTED', 'CANCELLED'
);

CREATE TYPE "ReturnShippingPayer" AS ENUM (
  'UNDECIDED', 'MOONVELLA', 'SELLER', 'CUSTOMER', 'CARRIER'
);

CREATE TYPE "ShippingClaimType" AS ENUM (
  'LOST', 'DAMAGED', 'SHORTAGE', 'DELIVERY_ISSUE', 'OTHER'
);

CREATE TYPE "ShippingClaimStatus" AS ENUM (
  'DRAFT', 'EVIDENCE_REQUIRED', 'READY_TO_SUBMIT', 'SUBMITTED',
  'CARRIER_REVIEW', 'APPROVED', 'DENIED', 'PAID', 'CLOSED', 'CANCELLED'
);

CREATE TABLE "ReturnRequest" (
  "id" TEXT NOT NULL,
  "rmaNumber" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "originalShipmentId" TEXT NOT NULL,
  "returnShipmentId" TEXT,
  "status" "ReturnRequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "reason" TEXT NOT NULL,
  "notes" TEXT,
  "shippingPayer" "ReturnShippingPayer" NOT NULL DEFAULT 'UNDECIDED',
  "approvedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReturnRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReturnRequestItem" (
  "id" TEXT NOT NULL,
  "returnRequestId" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "condition" TEXT,
  "resolution" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReturnRequestItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShippingClaim" (
  "id" TEXT NOT NULL,
  "claimNumber" TEXT NOT NULL,
  "shipmentId" TEXT NOT NULL,
  "type" "ShippingClaimType" NOT NULL,
  "status" "ShippingClaimStatus" NOT NULL DEFAULT 'DRAFT',
  "description" TEXT NOT NULL,
  "amount" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'CAD',
  "carrierClaimNumber" TEXT,
  "evidenceNotes" TEXT,
  "resolutionNotes" TEXT,
  "submittedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "paidAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShippingClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReturnRequest_rmaNumber_key" ON "ReturnRequest"("rmaNumber");
CREATE UNIQUE INDEX "ReturnRequest_returnShipmentId_key" ON "ReturnRequest"("returnShipmentId");
CREATE INDEX "ReturnRequest_orderId_createdAt_idx" ON "ReturnRequest"("orderId", "createdAt");
CREATE INDEX "ReturnRequest_originalShipmentId_idx" ON "ReturnRequest"("originalShipmentId");
CREATE INDEX "ReturnRequest_status_createdAt_idx" ON "ReturnRequest"("status", "createdAt");
CREATE UNIQUE INDEX "ReturnRequestItem_returnRequestId_orderItemId_key" ON "ReturnRequestItem"("returnRequestId", "orderItemId");
CREATE INDEX "ReturnRequestItem_orderItemId_idx" ON "ReturnRequestItem"("orderItemId");
CREATE UNIQUE INDEX "ShippingClaim_claimNumber_key" ON "ShippingClaim"("claimNumber");
CREATE INDEX "ShippingClaim_shipmentId_createdAt_idx" ON "ShippingClaim"("shipmentId", "createdAt");
CREATE INDEX "ShippingClaim_status_createdAt_idx" ON "ShippingClaim"("status", "createdAt");

ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_originalShipmentId_fkey"
  FOREIGN KEY ("originalShipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReturnRequestItem" ADD CONSTRAINT "ReturnRequestItem_returnRequestId_fkey"
  FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReturnRequestItem" ADD CONSTRAINT "ReturnRequestItem_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShippingClaim" ADD CONSTRAINT "ShippingClaim_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
