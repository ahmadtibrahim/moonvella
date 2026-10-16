-- Admin order cancellation, and the outcome of each side of it.
--
-- ADDITIVE. One new table and four new enum types; no existing column is altered
-- and no row is moved, so the running image keeps working unchanged for the
-- window between `migrate deploy` and the new container taking traffic.
--
-- WHY THE OUTCOMES ARE COLUMNS AND NOT A STATUS. Cancelling an order touches the
-- payment provider, the inventory holds and the invoice ledger, and in the final
-- phase the carrier too. Each of those can be pending, done or failed while the
-- others are in a different condition, and the one combination that must never
-- be reported as finished is "everything cancelled" while a provider operation
-- is outstanding. So the decision (`status`) and the per-system outcomes are
-- separate columns, and `NEEDS_ATTENTION` exists to say a person has to look —
-- it is not an error to be hidden.
--
-- NO SEED, NO BACKFILL. Past cancellations happened before this table existed
-- and their record is the audit log, which is append-only and already holds
-- them. Inventing rows here would claim a workflow ran that did not.

CREATE TYPE "CancellationReason" AS ENUM (
  'OUT_OF_STOCK', 'PRODUCT_UNAVAILABLE', 'SELLER_REQUEST', 'DUPLICATE_ORDER', 'OTHER'
);
CREATE TYPE "CancellationStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'CANCELLED', 'NEEDS_ATTENTION');
CREATE TYPE "ProviderOutcome" AS ENUM ('NOT_APPLICABLE', 'NOT_ATTEMPTED', 'PENDING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "PaymentCancellationAction" AS ENUM ('NONE', 'STOP_PENDING', 'VOID_AUTHORIZATION', 'REFUND_CAPTURED');
CREATE TYPE "ShipmentCancellationOutcome" AS ENUM ('NOT_APPLICABLE', 'REQUIRES_SHIPMENT_CANCELLATION', 'CANCELLED');

CREATE TABLE "OrderCancellation" (
  "id"                TEXT NOT NULL,
  "orderId"           TEXT NOT NULL,
  "sellerId"          TEXT NOT NULL,
  "reason"            "CancellationReason" NOT NULL,
  "explanation"       TEXT,
  "status"            "CancellationStatus" NOT NULL DEFAULT 'REQUESTED',
  "requestedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"       TIMESTAMP(3),
  "requestedById"     TEXT,
  "requestedByName"   TEXT,
  "paymentAction"     "PaymentCancellationAction" NOT NULL DEFAULT 'NONE',
  "paymentOutcome"    "ProviderOutcome" NOT NULL DEFAULT 'NOT_APPLICABLE',
  "stripeRefundId"    TEXT,
  "paymentNote"       TEXT,
  "inventoryOutcome"  "ProviderOutcome" NOT NULL DEFAULT 'NOT_APPLICABLE',
  "shipmentOutcome"   "ShipmentCancellationOutcome" NOT NULL DEFAULT 'NOT_APPLICABLE',
  "invoiceOutcome"    "ProviderOutcome" NOT NULL DEFAULT 'NOT_APPLICABLE',
  "creditNoteId"      TEXT,
  "lastError"         TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OrderCancellation_pkey" PRIMARY KEY ("id")
);

-- One cancellation per order. A second request is the same fact, and the unique
-- index is what makes two concurrent requests converge instead of racing.
CREATE UNIQUE INDEX "OrderCancellation_orderId_key" ON "OrderCancellation" ("orderId");
CREATE INDEX "OrderCancellation_status_idx" ON "OrderCancellation" ("status");
CREATE INDEX "OrderCancellation_sellerId_requestedAt_idx" ON "OrderCancellation" ("sellerId", "requestedAt");
CREATE INDEX "OrderCancellation_orderId_idx" ON "OrderCancellation" ("orderId");

ALTER TABLE "OrderCancellation"
  ADD CONSTRAINT "OrderCancellation_orderId_fkey" FOREIGN KEY ("orderId")
  REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderCancellation"
  ADD CONSTRAINT "OrderCancellation_sellerId_fkey" FOREIGN KEY ("sellerId")
  REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;
