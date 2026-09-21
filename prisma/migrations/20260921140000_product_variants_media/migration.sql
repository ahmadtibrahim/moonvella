-- ============================================================================
-- Product / variant / media / marketing
-- ============================================================================
--
-- Replaces the flat product model with a parent Product that describes a family
-- and a ProductVariant that is the physical, sellable and fulfilable unit, and
-- replaces the flat per-product image list with MediaAsset plus a variant
-- assignment table.
--
-- ORDER IS THE POINT OF THIS FILE. `prisma migrate diff` emits the drops first
-- and adds required columns as NOT NULL immediately, which is correct for an
-- empty table and destroys data on a populated one. The statement order here is
-- deliberate and must not be "tidied":
--
--   1. enums and new tables      (additive only)
--   2. new nullable columns      (additive only)
--   3. renames                   (so a rename is a rename, not drop + add)
--   4. BACKFILL from the old columns
--   5. constraints               (only now can they hold)
--   6. drops of the old columns  (only now is the data safe elsewhere)
--
-- PostgreSQL runs each migration inside a transaction, so a failure at any
-- point leaves the database exactly as it was.
--
-- PARTIAL INDEXES: two of the invariants below are partial unique indexes, which
-- the Prisma schema language cannot express. They exist only here. Verified on
-- 2026-09-21 against Prisma 6.19.3: after this migration, `prisma migrate diff`
-- against the live schema reports an empty migration, so the indexes do not
-- register as drift and `migrate deploy` leaves them alone. They were also
-- confirmed to actually reject a duplicate. That is a property of this Prisma
-- version, not a guarantee, so: never accept a generated migration that drops
-- `ProductVariant_one_default_per_product` or
-- `MediaAssetAssignment_primary_per_variant`, and re-run the drift check after
-- any Prisma upgrade.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "MediaCategory" AS ENUM ('WHITE_BACKGROUND_IMAGE', 'LIFESTYLE_IMAGE', 'PRODUCT_VIDEO', 'DOCUMENT', 'MARKETING_CREATIVE', 'EDITABLE_TEMPLATE');
CREATE TYPE "MediaSubtype" AS ENUM ('WHITE_BACKGROUND', 'LIFESTYLE', 'PRODUCT_DEMO', 'LIFESTYLE_VIDEO', 'SOCIAL_CLIP_VERTICAL', 'SOCIAL_CLIP_SQUARE', 'CARE_GUIDE', 'SPECIFICATION_SHEET', 'WARRANTY', 'CERTIFICATION', 'PACKAGING_INSTRUCTIONS', 'MARKETING_PDF', 'OTHER_DOCUMENT', 'SQUARE_POST', 'STORY_REEL', 'BANNER', 'LANDSCAPE_AD', 'SOCIAL_VIDEO', 'EDITABLE_TEMPLATE');
CREATE TYPE "ProcessingStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED');
CREATE TYPE "ApprovalStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED');
CREATE TYPE "DocumentType" AS ENUM ('CARE_GUIDE', 'SPECIFICATION_SHEET', 'WARRANTY', 'CERTIFICATION', 'PACKAGING_INSTRUCTIONS', 'MARKETING_PDF', 'OTHER');

-- ---------------------------------------------------------------------------
-- 2. New tables
-- ---------------------------------------------------------------------------

CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "category" "MediaCategory" NOT NULL,
    "subtype" "MediaSubtype",
    "title" TEXT NOT NULL,
    "altText" TEXT,
    "originalFilename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" INTEGER,
    "aspectRatio" TEXT,
    "processingStatus" "ProcessingStatus" NOT NULL DEFAULT 'UPLOADING',
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "sellerVisible" BOOLEAN NOT NULL DEFAULT false,
    "posterStorageKey" TEXT,
    "documentType" "DocumentType",
    "version" TEXT,
    "effectiveDate" TIMESTAMP(3),
    "language" TEXT,
    "supersedesId" TEXT,
    "downloadAllowed" BOOLEAN NOT NULL DEFAULT true,
    "instructions" TEXT,
    "templateUrl" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MediaAssetAssignment" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "variantId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MediaAssetAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VariantOption" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "VariantOption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalProductMapping" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'SHOPIFY',
    "shopDomain" TEXT NOT NULL,
    "externalProductId" TEXT,
    "importStatus" TEXT NOT NULL DEFAULT 'NOT_IMPORTED',
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExternalProductMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalVariantMapping" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'SHOPIFY',
    "shopDomain" TEXT NOT NULL,
    "externalProductId" TEXT,
    "externalVariantId" TEXT,
    "importStatus" TEXT NOT NULL DEFAULT 'NOT_IMPORTED',
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExternalVariantMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SellerBrandKit" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "storeName" TEXT,
    "logoStorageKey" TEXT,
    "callToAction" TEXT,
    "brandColours" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SellerBrandKit_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 3. New columns — all nullable, or NOT NULL with a default.
--
--    "productCode" is deliberately nullable here and made NOT NULL in step 5,
--    after the backfill has given every row a value.
-- ---------------------------------------------------------------------------

ALTER TABLE "OrderItem"
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "packageHeightCm" DECIMAL(10,2),
  ADD COLUMN "packageLengthCm" DECIMAL(10,2),
  ADD COLUMN "packageWidthCm" DECIMAL(10,2),
  ADD COLUMN "packagedWeightKg" DECIMAL(10,3),
  ADD COLUMN "productCode" TEXT,
  ADD COLUMN "productHeightCm" DECIMAL(10,2),
  ADD COLUMN "productLengthCm" DECIMAL(10,2),
  ADD COLUMN "productWeightKg" DECIMAL(10,3),
  ADD COLUMN "productWidthCm" DECIMAL(10,2),
  ADD COLUMN "selectedOptions" TEXT,
  ADD COLUMN "sellerRetailPrice" INTEGER,
  ADD COLUMN "unitsPerPackage" INTEGER,
  ADD COLUMN "variantName" TEXT;

ALTER TABLE "Product"
  ADD COLUMN "productCode" TEXT,
  ADD COLUMN "careInstructions" TEXT,
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "features" TEXT,
  ADD COLUMN "materials" TEXT,
  ADD COLUMN "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "updatedById" TEXT;

ALTER TABLE "ProductVariant"
  ADD COLUMN "barcode" TEXT,
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'CAD',
  ADD COLUMN "externalInventoryRef" TEXT,
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "productHeightCm" DECIMAL(10,2),
  ADD COLUMN "productLengthCm" DECIMAL(10,2),
  ADD COLUMN "productWeightKg" DECIMAL(10,3),
  ADD COLUMN "productWidthCm" DECIMAL(10,2),
  ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "trackInventory" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "unitsPerPackage" INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- 4. Renames.
--
--    `dimensions` was free text ("60x40x15") on the variant. The migration
--    cannot turn it into three trustworthy numbers — it does not record whether
--    the figures are centimetres or inches, and guessing would invent data. It
--    is RENAMED rather than replaced, so the original string survives verbatim.
-- ---------------------------------------------------------------------------

ALTER TABLE "ProductVariant" RENAME COLUMN "dimensions" TO "legacyDimensions";

-- ---------------------------------------------------------------------------
-- 5. BACKFILL
-- ---------------------------------------------------------------------------

-- 5a. Product Code, from the flat model's product-level SKU.
--
--     Normalised the same way app/utils/productCode.ts normalises new input:
--     trimmed and upper-cased. Characters outside the allowed set are left
--     alone rather than stripped — silently rewriting a code could collide with
--     another row, and the unique index in step 6 is the right place for that
--     to be caught loudly.
UPDATE "Product"
   SET "productCode" = UPPER(BTRIM("sku"))
 WHERE "productCode" IS NULL
   AND "sku" IS NOT NULL;

-- A product that cannot be given a code must stop the migration rather than
-- reach the NOT NULL in step 6 with a confusing error.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Product" WHERE "productCode" IS NULL OR BTRIM("productCode") = '') THEN
    RAISE EXCEPTION
      'Product Code backfill incomplete: % product row(s) have no sku to derive one from. '
      'Give them a code before migrating.',
      (SELECT count(*) FROM "Product" WHERE "productCode" IS NULL OR BTRIM("productCode") = '');
  END IF;
END $$;

-- 5b. Variant weight: the flat model stored grams as an integer; the canonical
--     column is kilograms as a decimal. 900 -> 0.900.
UPDATE "ProductVariant"
   SET "productWeightKg" = ROUND("weight"::numeric / 1000, 3)
 WHERE "weight" IS NOT NULL
   AND "weight" > 0;

-- 5c. The single option pair becomes an ordered option row. The flat model
--     could express one axis; this preserves that axis and nothing is invented.
INSERT INTO "VariantOption" ("id", "variantId", "name", "value", "sortOrder")
SELECT gen_random_uuid()::text, v."id", BTRIM(v."optionName"), BTRIM(v."optionValue"), 0
  FROM "ProductVariant" v
 WHERE v."optionName"  IS NOT NULL AND BTRIM(v."optionName")  <> ''
   AND v."optionValue" IS NOT NULL AND BTRIM(v."optionValue") <> '';

-- 5d. Media from the flat `Product.images` JSON array of URLs.
--
--     The guard `~ '^\s*\['` means a malformed value is skipped rather than
--     aborting the whole migration on a cast error. checksum is a marker, not a
--     hash: these files were never hashed by the old code and there is nothing
--     to recompute from. processingStatus is READY because nothing is
--     processing them; approvalStatus is DRAFT and sellerVisible is false, so
--     none of them can reach a seller until someone approves them.
--
--     The asset id is derived from (product, array position) rather than drawn
--     at random, so the assignment statement below can address exactly the rows
--     this statement created. An image with no assignment row would be an
--     orphan: present in the table, attached to nothing, invisible everywhere.
INSERT INTO "MediaAsset" (
  "id", "productId", "category", "title", "originalFilename", "storageKey",
  "mimeType", "fileSize", "checksum", "sourceUrl", "processingStatus",
  "approvalStatus", "sellerVisible", "createdAt", "updatedAt")
SELECT
  'mvlimg-' || md5(p."id" || ':' || (u.ord - 1)::text),
  p."id",
  'WHITE_BACKGROUND_IMAGE',
  p."name",
  COALESCE(NULLIF(regexp_replace(u.url, '^.*/', ''), ''), 'legacy-image'),
  'legacy/mvlimg-' || md5(p."id" || ':' || (u.ord - 1)::text),
  'image/jpeg',
  0,
  'legacy-unverified',
  BTRIM(u.url),
  'READY', 'DRAFT', false, now(), now()
FROM "Product" p,
     LATERAL jsonb_array_elements_text(p."images"::jsonb) WITH ORDINALITY AS u(url, ord)
WHERE p."images" IS NOT NULL
  AND p."images" ~ '^\s*\['
  AND p."images" <> '[]'
  AND BTRIM(u.url) <> '';

INSERT INTO "MediaAssetAssignment" ("id", "assetId", "variantId", "sortOrder", "isPrimary", "createdAt")
SELECT gen_random_uuid()::text,
       'mvlimg-' || md5(p."id" || ':' || (u.ord - 1)::text),
       NULL, u.ord - 1, false, now()
FROM "Product" p,
     LATERAL jsonb_array_elements_text(p."images"::jsonb) WITH ORDINALITY AS u(url, ord)
WHERE p."images" IS NOT NULL
  AND p."images" ~ '^\s*\['
  AND p."images" <> '[]'
  AND BTRIM(u.url) <> '';

-- 5e. Media from the ProductImage table. The asset keeps the ProductImage id so
--     the two remain traceable to each other after the table is dropped.
INSERT INTO "MediaAsset" (
  "id", "productId", "category", "title", "altText", "originalFilename",
  "storageKey", "mimeType", "fileSize", "checksum", "sourceUrl",
  "processingStatus", "approvalStatus", "sellerVisible", "createdAt", "updatedAt")
SELECT
  pi."id",
  pi."productId",
  'WHITE_BACKGROUND_IMAGE',
  COALESCE(NULLIF(BTRIM(pi."alt"), ''), p."name"),
  NULLIF(BTRIM(pi."alt"), ''),
  COALESCE(NULLIF(regexp_replace(pi."url", '^.*/', ''), ''), 'legacy-image'),
  'legacy/' || pi."id",
  'image/jpeg',
  0,
  'legacy-unverified',
  BTRIM(pi."url"),
  'READY', 'DRAFT', false, now(), now()
FROM "ProductImage" pi
JOIN "Product" p ON p."id" = pi."productId";

-- A shared assignment (variantId NULL) for each: these were product-level
-- images, which is exactly what "shared with every variant" now means.
INSERT INTO "MediaAssetAssignment" ("id", "assetId", "variantId", "sortOrder", "isPrimary", "createdAt")
SELECT gen_random_uuid()::text, pi."id", NULL, pi."sortOrder", false, now()
FROM "ProductImage" pi;

-- 5f. The Default variant.
--
--     Only for a product that has no variants at all — the flat-model shape.
--     A product that already has variants keeps them: they are the sellable
--     units, they already carry their own prices, and manufacturing an extra
--     "Default" alongside them would create a phantom SKU that nothing sells.
--     It is flagged only when it is genuinely the sole variant.
INSERT INTO "ProductVariant" (
  "id", "productId", "sku", "name", "wholesalePrice", "suggestedRetailPrice",
  "costPrice", "inventory", "isDefault", "isActive", "sortOrder", "currency",
  "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text, p."id", BTRIM(p."sku"), 'Default',
  p."wholesalePrice", p."suggestedRetailPrice", p."costPrice",
  0, true, true, 0, COALESCE(p."currency", 'CAD'), now(), now()
FROM "Product" p
WHERE p."sku" IS NOT NULL
  AND BTRIM(p."sku") <> ''
  AND NOT EXISTS (SELECT 1 FROM "ProductVariant" v WHERE v."productId" = p."id");

-- A product whose only variant predates this migration is the default one.
-- Its *name* is left alone: renaming a merchant's variant to "Default" would
-- destroy a real label. Flagging the sole variant is the non-destructive
-- equivalent of the rule, and the unique index below keeps it to one.
UPDATE "ProductVariant" v
   SET "isDefault" = true
 WHERE (SELECT count(*) FROM "ProductVariant" v2 WHERE v2."productId" = v."productId") = 1;

-- 5g. Variant order. The flat model had no variant ordering, so every row
--     carries sortOrder 0 and the display order would fall to whatever the
--     planner happened to return. Give each product's variants a stable order
--     derived from their creation time.
WITH ranked AS (
  SELECT "id",
         row_number() OVER (PARTITION BY "productId" ORDER BY "createdAt", "id") - 1 AS rn
    FROM "ProductVariant"
)
UPDATE "ProductVariant" v SET "sortOrder" = r."rn"
  FROM ranked r WHERE v."id" = r."id" AND v."sortOrder" IS DISTINCT FROM r."rn";

-- 5h. Media order and the shared fallback primary.
--
--     Two sources fed the media table and each numbered its own rows from zero,
--     so a product carrying both would have two images claiming position 0 and
--     two claiming to be primary. Renumber each product's shared assignments
--     contiguously — ProductImage rows first, since they carried an explicit
--     order the merchant set, then the images-array rows — and make exactly the
--     first of them primary. This is the single place that decides both, which
--     is why it runs after every source has inserted.
WITH ranked AS (
  SELECT a."id",
         row_number() OVER (
           PARTITION BY m."productId"
           ORDER BY CASE WHEN a."assetId" LIKE 'mvlimg-%' THEN 1 ELSE 0 END,
                    a."sortOrder", a."id"
         ) - 1 AS rn
    FROM "MediaAssetAssignment" a
    JOIN "MediaAsset" m ON m."id" = a."assetId"
   WHERE a."variantId" IS NULL
)
UPDATE "MediaAssetAssignment" a
   SET "sortOrder" = r."rn", "isPrimary" = (r."rn" = 0)
  FROM ranked r WHERE a."id" = r."id";

-- ---------------------------------------------------------------------------
-- 6. Constraints — only now that every row has been through the backfill.
-- ---------------------------------------------------------------------------

ALTER TABLE "Product" ALTER COLUMN "productCode" SET NOT NULL;
CREATE UNIQUE INDEX "Product_productCode_key" ON "Product"("productCode");

CREATE INDEX "Product_status_idx" ON "Product"("status");
CREATE UNIQUE INDEX "ProductVariant_barcode_key" ON "ProductVariant"("barcode");
CREATE INDEX "ProductVariant_productId_sortOrder_idx" ON "ProductVariant"("productId", "sortOrder");

-- At most one Default variant per product. Enforced in the database because
-- "which variant is the default" must not depend on application code being
-- correct, the same reasoning as the primary-owner index.
CREATE UNIQUE INDEX "ProductVariant_one_default_per_product"
  ON "ProductVariant" ("productId") WHERE "isDefault";

-- At most one primary image per variant. The shared fallback (variantId NULL)
-- is deliberately not covered here: it is scoped to a product rather than a
-- variant, and the product id lives on the asset. The application clears
-- sibling shared primaries in the same transaction; this index is what makes
-- the per-variant rule unbreakable.
CREATE UNIQUE INDEX "MediaAssetAssignment_primary_per_variant"
  ON "MediaAssetAssignment" ("variantId")
  WHERE "isPrimary" AND "variantId" IS NOT NULL;

CREATE UNIQUE INDEX "MediaAsset_storageKey_key" ON "MediaAsset"("storageKey");
CREATE INDEX "MediaAsset_productId_category_idx" ON "MediaAsset"("productId", "category");
CREATE INDEX "MediaAsset_checksum_idx" ON "MediaAsset"("checksum");
CREATE INDEX "MediaAsset_approvalStatus_idx" ON "MediaAsset"("approvalStatus");
CREATE INDEX "MediaAssetAssignment_variantId_sortOrder_idx" ON "MediaAssetAssignment"("variantId", "sortOrder");
CREATE UNIQUE INDEX "MediaAssetAssignment_assetId_variantId_key" ON "MediaAssetAssignment"("assetId", "variantId");
CREATE INDEX "VariantOption_variantId_sortOrder_idx" ON "VariantOption"("variantId", "sortOrder");
CREATE UNIQUE INDEX "VariantOption_variantId_name_key" ON "VariantOption"("variantId", "name");
CREATE INDEX "ExternalProductMapping_shopDomain_idx" ON "ExternalProductMapping"("shopDomain");
CREATE UNIQUE INDEX "ExternalProductMapping_provider_shopDomain_productId_key" ON "ExternalProductMapping"("provider", "shopDomain", "productId");
CREATE INDEX "ExternalVariantMapping_shopDomain_idx" ON "ExternalVariantMapping"("shopDomain");
CREATE UNIQUE INDEX "ExternalVariantMapping_provider_shopDomain_variantId_key" ON "ExternalVariantMapping"("provider", "shopDomain", "variantId");
CREATE UNIQUE INDEX "SellerBrandKit_sellerId_key" ON "SellerBrandKit"("sellerId");

ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MediaAssetAssignment" ADD CONSTRAINT "MediaAssetAssignment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaAssetAssignment" ADD CONSTRAINT "MediaAssetAssignment_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VariantOption" ADD CONSTRAINT "VariantOption_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalProductMapping" ADD CONSTRAINT "ExternalProductMapping_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalVariantMapping" ADD CONSTRAINT "ExternalVariantMapping_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SellerBrandKit" ADD CONSTRAINT "SellerBrandKit_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 7. Drop the old columns. Everything above has already taken what it needs.
-- ---------------------------------------------------------------------------

DROP INDEX "Product_sku_idx";
DROP INDEX "Product_sku_key";

ALTER TABLE "Product"
  DROP COLUMN "costPrice",
  DROP COLUMN "images",
  DROP COLUMN "sku",
  DROP COLUMN "suggestedRetailPrice",
  DROP COLUMN "wholesalePrice";

ALTER TABLE "ProductVariant"
  DROP COLUMN "optionName",
  DROP COLUMN "optionValue",
  DROP COLUMN "weight";

DROP TABLE "ProductImage";
