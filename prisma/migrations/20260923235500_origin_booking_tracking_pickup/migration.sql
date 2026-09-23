-- The origin reaches the carrier; pickup mode; tracking poll state; notify once.
--
-- PHASE C of the shipping/product-import work order: tracking, Shopify
-- fulfillment sync and pickups.
--
-- ADDITIVE ONLY. Four nullable columns, two columns with a default, one foreign
-- key. Nothing is altered, dropped, backfilled or made NOT NULL, so the image
-- already running keeps working against this schema for the window between
-- `prisma migrate deploy` and the new container taking traffic.
--
-- WHY A QUOTE NEEDS AN ORIGIN. A shipping price is a price for a parcel leaving
-- a particular address. Until now every quote was asked for from one address
-- assembled out of environment variables, which meant a carrier's answer priced
-- a dock that may not be the one the goods are sitting on — and booking spent
-- that price. An order whose items live at two docks therefore needs two sets of
-- quotes, and the booking gate refuses a quote that names the other dock.
-- Nullable, because quotes written before this migration have no origin to name;
-- the gate treats those as "unknown dock" and refuses them rather than assuming
-- the only one.
--
-- WHY pickupMode IS ON BOTH THE LOCATION AND THE SHIPMENT. The location holds
-- the default (a dock with a standing collection should not get a second truck
-- booked for the same door). The shipment holds the answer it was prepared
-- under, because the dock's arrangement can change after a parcel is packed and
-- a prepared parcel must keep the fact it was prepared with. Text, not an enum,
-- for the same reason as pickupStatus: it is a small vocabulary we may extend
-- (a dock that is drop-off on Fridays, say) and an enum migration is a table
-- rewrite for a value the code already handles as an unknown.
--
-- WHY trackingSyncFailures IS A COLUMN. The poll interval backs off after a
-- failure, and "this shipment has been unreachable four times" has to be a fact
-- on the row rather than something reconstructed from a log. It is reset the
-- moment a poll succeeds, and a failed poll never clears the last good status —
-- a shipment that read "In transit" yesterday still reads that after a provider
-- outage today.
--
-- WHY shopifySyncedAt AND shopifySyncError ARE ON THE SHIPMENT. §8 requires the
-- synchronization result to be persisted and failures retried without
-- duplicates. `shopifyFulfillmentId` already records WHICH Shopify fulfillment a
-- push created, and its presence is what makes a re-push a no-op rather than a
-- second fulfillment. These two add WHEN it last succeeded and WHY it last
-- failed, per parcel: the integration row holds one status for the whole
-- connection, so an operator looking at one shipment that did not reach Shopify
-- would have to read a global row to find out why.
--
-- WHY trackingPollClaimedAt EXISTS. Two sweeps must not poll the same parcel at
-- once: overlap turns a slow provider into duplicate requests and, worse, into
-- two writers racing on the same status. The sweep claims a row with a
-- conditional update before calling out, and clears the claim when it finishes
-- either way; a claim older than the lease belonged to a sweep that died and is
-- free again. It is a separate column from lastTrackingSyncAt because that one
-- means "the carrier last answered" — overloading it would make a crashed sweep
-- look like a successful refresh, and §7 requires the page to show the last
-- SUCCESSFUL refresh.
--
-- WHY shopifyNotifiedAt IS RECORDED. Shopify sends the customer e-mail on the
-- call, so a retry, a second push or a re-run of the sweep must be able to ask
-- "have we already told them" and get an answer that outlives the process.
-- There is no undo for a duplicate notification.

-- AlterTable
ALTER TABLE "PickupLocation" ADD COLUMN     "pickupMode" TEXT NOT NULL DEFAULT 'NEEDED';

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "pickupMode" TEXT,
ADD COLUMN     "shopifyNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "shopifySyncError" TEXT,
ADD COLUMN     "shopifySyncedAt" TIMESTAMP(3),
ADD COLUMN     "trackingPollClaimedAt" TIMESTAMP(3),
ADD COLUMN     "trackingSyncFailures" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ShippingQuote" ADD COLUMN     "originLocationId" TEXT;

-- AddForeignKey
ALTER TABLE "ShippingQuote" ADD CONSTRAINT "ShippingQuote_originLocationId_fkey" FOREIGN KEY ("originLocationId") REFERENCES "PickupLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
