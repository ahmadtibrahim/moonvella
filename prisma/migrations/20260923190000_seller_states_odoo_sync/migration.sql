-- Seller lifecycle, structured application data, and the deferred work queue.
--
-- Generated with `prisma migrate diff --from-migrations … --to-schema-datamodel`
-- against a scratch database, then reviewed. Three things were checked by hand
-- because the generator cannot know them:
--
--   1. `ALTER TYPE … ADD VALUE` runs inside this migration's transaction. That
--      is allowed on PostgreSQL 12+, but the new value may not be USED in the
--      same transaction — so no statement below writes 'DEACTIVATED'. The
--      previous migration (20260922120000_seller_blocked) relies on the same
--      behaviour and applied cleanly on PG 16.
--   2. Columns are additive only. `MerchantApplication.sellerAddress` keeps its
--      data and loses only its NOT NULL, because a free-text address box was
--      replaced by structured columns and destroying what merchants already
--      typed would be a migration deciding it knows better.
--   3. Every new NOT NULL column has a DEFAULT, so the existing Seller row and
--      any product mappings are backfilled by the table rewrite rather than
--      failing the migration.

-- CreateEnum
CREATE TYPE "ContactRole" AS ENUM ('COMPANY', 'CONTACT', 'URGENT_CONTACT');

-- CreateEnum
CREATE TYPE "ContactSyncStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "ProductArchiveStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'ARCHIVED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "ApplicationStatus" ADD VALUE IF NOT EXISTS 'DEACTIVATED';

-- AlterEnum
ALTER TYPE "SellerStatus" ADD VALUE IF NOT EXISTS 'DEACTIVATED';

-- AlterTable
ALTER TABLE "ExternalProductMapping" ADD COLUMN     "archiveAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "archiveLastError" TEXT,
ADD COLUMN     "archiveStatus" "ProductArchiveStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MerchantApplication" ADD COLUMN     "addressCity" TEXT,
ADD COLUMN     "addressCountryCode" TEXT,
ADD COLUMN     "addressLine1" TEXT,
ADD COLUMN     "addressLine2" TEXT,
ADD COLUMN     "addressPostalCode" TEXT,
ADD COLUMN     "addressProvinceCode" TEXT,
ADD COLUMN     "profileFieldSources" JSONB DEFAULT '{}',
ADD COLUMN     "profileRefreshError" TEXT,
ADD COLUMN     "profileRefreshedAt" TIMESTAMP(3),
ADD COLUMN     "shopifyProfileJson" JSONB DEFAULT '{}',
ADD COLUMN     "shopifyShopId" TEXT,
ADD COLUMN     "storeContactEmail" TEXT,
ADD COLUMN     "storeOwnerEmail" TEXT,
ADD COLUMN     "urgentContactName" TEXT,
ALTER COLUMN "sellerAddress" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Seller" ADD COLUMN     "accessVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "deactivationReason" TEXT;

-- CreateTable
CREATE TABLE "ExternalContactMapping" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "role" "ContactRole" NOT NULL,
    "odooPartnerId" INTEGER,
    "odooName" TEXT,
    "status" "ContactSyncStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3),
    "payloadFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalContactMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sellerId" TEXT,
    "payload" JSONB,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastError" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "sellerAccessVersion" INTEGER,
    "result" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalContactMapping_status_idx" ON "ExternalContactMapping"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalContactMapping_sellerId_role_key" ON "ExternalContactMapping"("sellerId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundJob_idempotencyKey_key" ON "BackgroundJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BackgroundJob_status_runAt_idx" ON "BackgroundJob"("status", "runAt");

-- CreateIndex
CREATE INDEX "BackgroundJob_kind_status_idx" ON "BackgroundJob"("kind", "status");

-- CreateIndex
CREATE INDEX "BackgroundJob_sellerId_idx" ON "BackgroundJob"("sellerId");

-- CreateIndex
CREATE INDEX "ExternalProductMapping_archiveStatus_idx" ON "ExternalProductMapping"("archiveStatus");

-- AddForeignKey
ALTER TABLE "ExternalContactMapping" ADD CONSTRAINT "ExternalContactMapping_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE SET NULL ON UPDATE CASCADE;

