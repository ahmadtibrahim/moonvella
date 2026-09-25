-- A video that cannot be measured, and a merchant's copy of an asset.
--
-- TWO CHANGES, both additive, both in service of the same complaint: the screen
-- said something was happening when nothing was.
--
-- 1. `MediaAsset.processingError` — WHY PROCESSING DID NOT FINISH.
--
--    A video whose length could not be measured was left in PROCESSING, which
--    was meant to say "not yet" and in practice said "forever": nothing could
--    move it out of that state, no screen explained it, and approval refused
--    the asset while it sat there. The column lets the reason be written down
--    so the tile can say it — and be cleared when a retry is queued, so an old
--    failure cannot sit next to a fresh attempt.
--
--    Nullable, with no default: every row that exists today has no recorded
--    failure, which is the truth, and NULL is how that is written.
--
-- 2. `ShopifyFileTransfer` — ONE ROW PER ASSET PER SELLER PER DESTINATION.
--
--    A merchant taking a video into their own Shopify product, or a document
--    into their store's files, is a request that can fail after the bytes have
--    already left: Shopify accepts an upload and processes it asynchronously,
--    so "did it work" is not answered by the request returning. The merchant
--    will press the button again. The unique key below is what turns the second
--    press into a retry of the same transfer instead of a second copy in their
--    store — without it, every press is a duplicate they must delete by hand.
--
--    ON DELETE CASCADE on both sides: the row records a transfer, and a
--    transfer of a deleted asset is not history worth keeping. The asset it
--    names is already gone.
--
-- Neither change touches an existing row's meaning. No backfill is needed or
-- wanted: there is nothing in the current data that could say why an asset is
-- still processing, and inventing a reason would put a guess on the screen.

-- CreateEnum
CREATE TYPE "ShopifyTransferKind" AS ENUM ('MEDIA', 'FILE');

-- CreateEnum
CREATE TYPE "ShopifyTransferStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "processingError" TEXT;

-- CreateTable
CREATE TABLE "ShopifyFileTransfer" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "kind" "ShopifyTransferKind" NOT NULL,
    "status" "ShopifyTransferStatus" NOT NULL DEFAULT 'PENDING',
    "providerObjectId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyFileTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopifyFileTransfer_sellerId_status_idx" ON "ShopifyFileTransfer"("sellerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyFileTransfer_sellerId_mediaAssetId_kind_key" ON "ShopifyFileTransfer"("sellerId", "mediaAssetId", "kind");

-- AddForeignKey
ALTER TABLE "ShopifyFileTransfer" ADD CONSTRAINT "ShopifyFileTransfer_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyFileTransfer" ADD CONSTRAINT "ShopifyFileTransfer_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
