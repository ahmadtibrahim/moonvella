-- Origin mappings, packaging profiles, address validation and image selection.
--
-- PHASE A of the shipping/product-import work order. Four things arrive here,
-- and they arrive together because they are one idea: what is being shipped,
-- from where, packed how, and which pictures of it are allowed across.
--
-- ADDITIVE ONLY. Every statement below either creates a new table or adds a
-- nullable column, with two exceptions that add a NOT NULL column WITH a
-- default (VariantPackage.consolidatable/shipsSeparately), which PostgreSQL
-- fills for existing rows without a rewrite of the table's data. No existing
-- column is altered or dropped, so the currently deployed image keeps working
-- against this schema during the window between `prisma migrate deploy` and the
-- new container taking traffic.
--
-- WHY PickupLocation EXISTS AT ALL. The work order forbids copying address text
-- onto every product and forbids inferring a pickup point from a supplier's
-- billing address. Both rules point the same way: the collection address has to
-- be one row that many products reference, carrying the Odoo identifiers that
-- tie it to a real warehouse/location, and a product that references none is
-- reported as "pickup location required" rather than quietly collecting from
-- somewhere plausible.
--
-- WHY Shipment GAINS originSnapshot AND packageSnapshot. PickupLocation is the
-- live source of truth for anything new; these are the frozen facts of a
-- shipment that has already been quoted or booked. Without them, correcting a
-- dock's postal code would retroactively rewrite where a parcel that shipped
-- last week was collected from, and the label, the carrier's record and our own
-- history would stop agreeing.
--
-- WHY AddressValidation DOES NOT STORE THE GOOGLE RESPONSE. Retaining a
-- validation payload indefinitely is not something Google's terms permit. The
-- table keeps the verdict, the normalised suggestion, the component-level
-- differences a reviewer actually needs, and the place id — plus inputHash,
-- which is how an unchanged address reuses its verdict instead of paying for
-- the same billable call on every render.
--
-- NOTE ON "overridden": an address an owner has accepted despite Google is
-- stored with verdict OVERRIDDEN, never ACCEPTED. The distinction is the whole
-- point of the column — an override that reads as a validation is a lie the
-- interface would then repeat.

-- CreateEnum
CREATE TYPE "AddressVerdict" AS ENUM ('UNVALIDATED', 'ACCEPTED', 'CONFIRMATION_REQUIRED', 'CORRECTION_REQUIRED', 'UNAVAILABLE', 'OVERRIDDEN');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "pickupLocationId" TEXT;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "pickupLocationId" TEXT;

-- AlterTable
ALTER TABLE "VariantPackage" ADD COLUMN     "consolidatable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "declaredValue" INTEGER,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "shipsSeparately" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "originLocationId" TEXT,
ADD COLUMN     "originSnapshot" JSONB,
ADD COLUMN     "packageSnapshot" JSONB;

-- CreateTable
CREATE TABLE "ProductPackage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "label" TEXT,
    "packageType" TEXT NOT NULL DEFAULT 'carton',
    "presetId" TEXT,
    "length" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "dimensionUnit" TEXT NOT NULL DEFAULT 'cm',
    "grossWeight" DOUBLE PRECISION NOT NULL,
    "weightUnit" TEXT NOT NULL DEFAULT 'kg',
    "unitsPerPackage" INTEGER NOT NULL DEFAULT 1,
    "packagesPerUnit" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "declaredValue" INTEGER,
    "shipsSeparately" BOOLEAN NOT NULL DEFAULT false,
    "consolidatable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickupLocation" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "odooDatabase" TEXT,
    "odooCompanyId" INTEGER,
    "odooWarehouseId" INTEGER,
    "odooLocationId" INTEGER,
    "odooPartnerId" INTEGER,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "street1" TEXT,
    "street2" TEXT,
    "city" TEXT,
    "province" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "timeZone" TEXT,
    "pickupOpenTime" TEXT,
    "pickupCloseTime" TEXT,
    "instructions" TEXT,
    "accessRequirements" TEXT,
    "addressVerdict" "AddressVerdict" NOT NULL DEFAULT 'UNVALIDATED',
    "addressCheckedAt" TIMESTAMP(3),
    "addressOverridden" BOOLEAN NOT NULL DEFAULT false,
    "addressOverrideReason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PickupLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddressValidation" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "verdict" "AddressVerdict" NOT NULL,
    "originalAddress" JSONB NOT NULL,
    "suggestedAddress" JSONB,
    "differences" JSONB,
    "granularity" TEXT,
    "placeId" TEXT,
    "unavailableReason" TEXT,
    "overriddenById" TEXT,
    "overriddenByName" TEXT,
    "overrideReason" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddressValidation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportMediaSelection" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "isMain" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "uploadStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "providerMediaId" TEXT,
    "uploadAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastUploadError" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportMediaSelection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductPackage_productId_idx" ON "ProductPackage"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "PickupLocation_code_key" ON "PickupLocation"("code");

-- CreateIndex
CREATE INDEX "PickupLocation_isActive_idx" ON "PickupLocation"("isActive");

-- CreateIndex
CREATE INDEX "PickupLocation_odooDatabase_odooLocationId_idx" ON "PickupLocation"("odooDatabase", "odooLocationId");

-- CreateIndex
CREATE INDEX "AddressValidation_subjectType_subjectId_idx" ON "AddressValidation"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "AddressValidation_inputHash_idx" ON "AddressValidation"("inputHash");

-- CreateIndex
CREATE INDEX "ImportMediaSelection_sellerId_productId_idx" ON "ImportMediaSelection"("sellerId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportMediaSelection_sellerId_productId_mediaAssetId_key" ON "ImportMediaSelection"("sellerId", "productId", "mediaAssetId");

-- CreateIndex
CREATE INDEX "Shipment_originLocationId_idx" ON "Shipment"("originLocationId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_pickupLocationId_fkey" FOREIGN KEY ("pickupLocationId") REFERENCES "PickupLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_pickupLocationId_fkey" FOREIGN KEY ("pickupLocationId") REFERENCES "PickupLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPackage" ADD CONSTRAINT "ProductPackage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPackage" ADD CONSTRAINT "ProductPackage_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "PackagingPreset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_originLocationId_fkey" FOREIGN KEY ("originLocationId") REFERENCES "PickupLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

