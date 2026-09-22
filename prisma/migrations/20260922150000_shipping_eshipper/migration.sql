-- ============================================================================
-- Shipping: sender-side shipment financials, tracking detail and returns
-- ============================================================================
--
-- Additive only. Every new Shipment column is nullable or carries a default, so
-- no existing row is rewritten and no existing shipment changes meaning. The
-- one default ("billingStatus" = 'PENDING') is correct for rows that predate it:
-- an old shipment has not been reconciled against a carrier invoice either.
--
-- The separation this migration creates is the point. A shipment now records:
--   * the seller's fixed charge allocation   -> "sellerShippingCharge"
--   * the carrier cost as quoted             -> "quotedCarrierCost"
--   * the carrier cost as booked             -> "bookedCost" (existing column)
--   * the carrier cost as finally billed      -> "finalBilledCost"
-- They are four different numbers belonging to two different parties. Collapsing
-- any pair would make a margin report lie. "finalBilledCost" stays NULL until a
-- supplier invoice actually arrives; a NULL is "not known yet", never zero.
--
-- "ShipmentTrackingEvent" is append-only in effect: a unique (shipmentId,
-- eventKey) means a redelivered poll inserts nothing, and the interface decides
-- recency by "eventAt" so a late-arriving older event cannot advance state.
--
-- The enum "ShipmentStatus" is deliberately NOT altered: the normalized carrier
-- state lives in the free-text "trackingStatus" column, because the friendly
-- vocabulary (label_created, picked_up, in_transit, ...) will keep growing and
-- an enum would need a migration for every carrier wording we learn.
-- ============================================================================

-- 1. Shipment: sender-side financials and tracking metadata.
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "serviceCode" TEXT;
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "providerQuoteId" TEXT;
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "labelDocumentFormat" TEXT;
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "sellerShippingCharge" INTEGER;
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "quotedCarrierCost" INTEGER;
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "finalBilledCost" INTEGER;
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "billingStatus" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "providerInvoiceNumber" TEXT;
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "billingInvoices" TEXT;
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "trackingStatus" TEXT;
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "estimatedDelivery" TIMESTAMP(3);
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "lastTrackingSyncAt" TIMESTAMP(3);
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "lastTrackingError" TEXT;
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "returnOfShipmentId" TEXT;
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "returnReason" TEXT;
ALTER TABLE "Shipment" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);

-- 2. ShippingQuote: the provider's quote id, needed to book by id.
ALTER TABLE "ShippingQuote" ADD COLUMN IF NOT EXISTS "providerQuoteId" TEXT;

-- 3. Raw provider tracking events, append-only by unique key.
CREATE TABLE IF NOT EXISTS "ShipmentTrackingEvent" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "description" TEXT,
    "carrierEventCode" TEXT,
    "statusText" TEXT,
    "proofOfDelivery" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShipmentTrackingEvent_pkey" PRIMARY KEY ("id")
);

-- 4. Indexes. IF NOT EXISTS keeps the migration safe to re-run.
CREATE INDEX IF NOT EXISTS "Shipment_orderId_idx" ON "Shipment"("orderId");
CREATE INDEX IF NOT EXISTS "Shipment_trackingNumber_idx" ON "Shipment"("trackingNumber");
CREATE INDEX IF NOT EXISTS "Shipment_status_idx" ON "Shipment"("status");
CREATE INDEX IF NOT EXISTS "Shipment_returnOfShipmentId_idx" ON "Shipment"("returnOfShipmentId");
CREATE UNIQUE INDEX IF NOT EXISTS "ShipmentTrackingEvent_shipmentId_eventKey_key" ON "ShipmentTrackingEvent"("shipmentId", "eventKey");
CREATE INDEX IF NOT EXISTS "ShipmentTrackingEvent_shipmentId_eventAt_idx" ON "ShipmentTrackingEvent"("shipmentId", "eventAt");

-- 5. Foreign key. Guarded so a re-run does not raise.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ShipmentTrackingEvent_shipmentId_fkey'
    ) THEN
        ALTER TABLE "ShipmentTrackingEvent"
            ADD CONSTRAINT "ShipmentTrackingEvent_shipmentId_fkey"
            FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
