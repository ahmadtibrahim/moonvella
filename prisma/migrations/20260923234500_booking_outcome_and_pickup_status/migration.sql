-- Booking outcomes, quote invalidation, and pickup status.
--
-- PHASE B of the shipping/product-import work order: quote selection, booking
-- and documents. The code for most of it already existed; what arrives here is
-- the state it could not previously record.
--
-- ADDITIVE ONLY. Five enum values and eighteen nullable columns. Nothing is
-- altered, dropped, backfilled or made NOT NULL, so the deployed image keeps
-- working against this schema for the window between `prisma migrate deploy` and
-- the new container taking traffic — a shipment with no pickup simply reads as
-- one that has never had a pickup.
--
-- WHY A BOOKING NEEDS MORE THAN PENDING/SHIPPED. Until now a booking that failed,
-- and a booking whose call timed out, both landed on EXCEPTION — one state for
-- two very different facts. The first is safe to retry because nothing was
-- purchased; the second may have purchased a label the provider has not yet told
-- us about, and retrying it is how an order gets two. BOOKING and
-- BOOKING_UNKNOWN separate them, and the reconciliation that follows is what
-- turns the second back into something actionable.
--
-- WHY pickupStatus IS TEXT AND NOT AN ENUM. It mirrors trackingStatus, which is
-- deliberately a string: carrier and provider vocabularies are theirs, not ours,
-- and a pickup state we cannot map is stored as it arrived rather than being
-- forced into a value we guessed. The five we do understand are documented on
-- the field.
--
-- WHY quotesInvalidatedAt IS ON Order. Quotes belong to an order and price the
-- parcels as they were when asked. Changing the packaging or the address makes
-- every quote on the order a price for something else, so they are removed
-- together and the reason is recorded where the operator already is — this is
-- the audit trail for "why did my quotes disappear", which would otherwise be an
-- unexplained empty table.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ShipmentStatus" ADD VALUE 'BOOKING';
ALTER TYPE "ShipmentStatus" ADD VALUE 'BOOKED';
ALTER TYPE "ShipmentStatus" ADD VALUE 'BOOKING_FAILED';
ALTER TYPE "ShipmentStatus" ADD VALUE 'BOOKING_UNKNOWN';
ALTER TYPE "ShipmentStatus" ADD VALUE 'CANCELLING';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "quoteInvalidationReason" TEXT,
ADD COLUMN     "quotesInvalidatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "bookingAttemptedAt" TIMESTAMP(3),
ADD COLUMN     "bookingOutcomeUnknownAt" TIMESTAMP(3),
ADD COLUMN     "lastBookingError" TEXT,
ADD COLUMN     "pickupCancelledAt" TIMESTAMP(3),
ADD COLUMN     "pickupConfirmation" TEXT,
ADD COLUMN     "pickupLastError" TEXT,
ADD COLUMN     "pickupScheduledFor" TIMESTAMP(3),
ADD COLUMN     "pickupStatus" TEXT,
ADD COLUMN     "pickupWindow" TEXT,
ADD COLUMN     "providerPickupId" TEXT;
