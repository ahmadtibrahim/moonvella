-- ============================================================================
-- Reverse of migration.sql in this directory.
-- ============================================================================
--
-- Prisma reads only `migration.sql` from a migration directory, so this file is
-- inert to `prisma migrate deploy`. It exists so the reverse is reviewable and
-- versioned alongside the forward migration rather than living only in prose.
--
-- WHEN THIS IS SAFE
--
-- This restores the flat model, which has nowhere to put an asset that was
-- uploaded through the new storage pipeline: the old ProductImage table held a
-- URL and nothing else. So this reverses cleanly ONLY while every MediaAsset
-- still has a sourceUrl, i.e. while nothing has been uploaded since the
-- migration. The file asserts that precondition and aborts if it is violated.
--
-- If the system has been used for real uploads, the correct rollback is to
-- restore the pre-migration backup, not to run this. See
-- deployment/rollback-plan.txt.
--
-- WHAT CANNOT BE RESTORED EXACTLY
--
--   * Product.sku comes back from the variant that inherited it, so a sku that
--     was space-padded returns trimmed. Where no variant inherited it, it comes
--     from Product.productCode, which is additionally upper-cased. Case is
--     otherwise preserved: the forward migration normalises the code, not the
--     variant sku.
--   * ProductVariant.weight comes back from productWeightKg * 1000, rounded to
--     whole grams. The forward migration turned a NULL or zero weight into NULL,
--     so a stored 0 returns as NULL. No non-zero weight changes.
--   * OrderItem snapshot columns added by the forward migration are dropped.
--     Nothing wrote them before this rollback, so they are empty by
--     construction; if that is no longer true, do not run this.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Refuse to run if the world has moved on.
-- ---------------------------------------------------------------------------

DO $$
DECLARE orphan_count integer;
BEGIN
  SELECT count(*) INTO orphan_count FROM "MediaAsset" WHERE "sourceUrl" IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Cannot reverse: % media asset(s) were uploaded through the new pipeline and have '
      'no legacy URL to restore. Restore the pre-migration backup instead.',
      orphan_count;
  END IF;

  IF EXISTS (SELECT 1 FROM "MediaAssetAssignment" WHERE "variantId" IS NOT NULL) THEN
    RAISE EXCEPTION
      'Cannot reverse: variant-scoped media assignments exist. The flat model has no '
      'equivalent. Restore the pre-migration backup instead.';
  END IF;

  IF EXISTS (SELECT 1 FROM "ExternalProductMapping")
     OR EXISTS (SELECT 1 FROM "ExternalVariantMapping") THEN
    RAISE EXCEPTION
      'Cannot reverse: Shopify mapping rows exist. Restore the pre-migration backup instead.';
  END IF;

  IF EXISTS (SELECT 1 FROM "SellerBrandKit") THEN
    RAISE EXCEPTION
      'Cannot reverse: seller brand kits exist. Restore the pre-migration backup instead.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Rebuild the ProductImage table.
-- ---------------------------------------------------------------------------

CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- Assets whose id is not a generated 'mvlimg-' key came from ProductImage, and
-- the forward migration kept their ids precisely so this maps back one to one.
INSERT INTO "ProductImage" ("id", "productId", "url", "alt", "sortOrder", "createdAt")
SELECT m."id", m."productId", m."sourceUrl", m."altText",
       COALESCE(a."sortOrder", 0), m."createdAt"
FROM "MediaAsset" m
LEFT JOIN "MediaAssetAssignment" a ON a."assetId" = m."id" AND a."variantId" IS NULL
WHERE m."id" NOT LIKE 'mvlimg-%';

-- Rebuild the old JSON URL array from the assets that came from it, in the
-- order their assignments preserved. A product with no such assets returns to
-- the empty array the old column defaulted to.
ALTER TABLE "Product" ADD COLUMN "images" TEXT NOT NULL DEFAULT '[]';

UPDATE "Product" p
   SET "images" = COALESCE((
         SELECT '[' || string_agg(to_json(m."sourceUrl")::text, ',' ORDER BY a."sortOrder", m."id") || ']'
           FROM "MediaAsset" m
           JOIN "MediaAssetAssignment" a ON a."assetId" = m."id" AND a."variantId" IS NULL
          WHERE m."productId" = p."id" AND m."id" LIKE 'mvlimg-%'
       ), '[]');

-- ---------------------------------------------------------------------------
-- 2. Rebuild the flat Product columns.
-- ---------------------------------------------------------------------------

-- Commercial values came from the product and were copied to the variant that
-- inherited them, so they are read back from that variant. Prefer the Default
-- variant; fall back to the lowest-sorted one for products that had variants
-- before the migration and so never gained a Default.
ALTER TABLE "Product" ADD COLUMN "sku" TEXT;
ALTER TABLE "Product" ADD COLUMN "wholesalePrice" INTEGER;
ALTER TABLE "Product" ADD COLUMN "suggestedRetailPrice" INTEGER;
ALTER TABLE "Product" ADD COLUMN "costPrice" INTEGER;

UPDATE "Product" p
   SET "sku"                  = COALESCE(v.sku, p."productCode"),
       "wholesalePrice"       = COALESCE(v."wholesalePrice", 0),
       "suggestedRetailPrice" = COALESCE(v."suggestedRetailPrice", 0),
       "costPrice"            = v."costPrice"
  FROM (
    SELECT DISTINCT ON ("productId") "productId", sku, "wholesalePrice",
                                      "suggestedRetailPrice", "costPrice"
      FROM "ProductVariant"
     ORDER BY "productId", "isDefault" DESC, "sortOrder", "id"
  ) v
 WHERE v."productId" = p."id";

-- A product that somehow has no variant at all keeps its code as the sku.
UPDATE "Product" SET "sku" = "productCode" WHERE "sku" IS NULL;

ALTER TABLE "Product" ALTER COLUMN "sku" SET NOT NULL;
ALTER TABLE "Product" ALTER COLUMN "wholesalePrice" SET NOT NULL;
ALTER TABLE "Product" ALTER COLUMN "suggestedRetailPrice" SET NOT NULL;

CREATE INDEX "Product_sku_idx" ON "Product"("sku");
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- ---------------------------------------------------------------------------
-- 3. Rebuild the flat ProductVariant columns.
-- ---------------------------------------------------------------------------

ALTER TABLE "ProductVariant" ADD COLUMN "optionName" TEXT;
ALTER TABLE "ProductVariant" ADD COLUMN "optionValue" TEXT;
ALTER TABLE "ProductVariant" ADD COLUMN "weight" INTEGER;

UPDATE "ProductVariant" v
   SET "optionName"  = o.name,
       "optionValue" = o.value
  FROM (SELECT DISTINCT ON ("variantId") "variantId", name, value
          FROM "VariantOption" ORDER BY "variantId", "sortOrder", name) o
 WHERE o."variantId" = v."id";

UPDATE "ProductVariant"
   SET "weight" = ROUND("productWeightKg" * 1000)::int
 WHERE "productWeightKg" IS NOT NULL;

ALTER TABLE "ProductVariant" RENAME COLUMN "legacyDimensions" TO "dimensions";

-- The manufactured Default variant has no counterpart in the flat model, where
-- the product itself carried the commercial values. It is removed, but only
-- once its values have been read back into the product above.
--
-- The id-shape test is what makes this safe to run unattended. Everything
-- Prisma creates has a cuid; everything this migration manufactured was created
-- with gen_random_uuid() and so is a UUID. Requiring both shapes to be absent
-- means the delete can only ever reach a row the forward migration itself
-- inserted — a real merchant variant would have to carry a UUID id, the exact
-- name "Default", and no options, packages, orders or seller listings.
DELETE FROM "ProductVariant"
 WHERE "isDefault"
   AND name = 'Default'
   AND "id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND NOT EXISTS (SELECT 1 FROM "VariantOption" o WHERE o."variantId" = "ProductVariant"."id")
   AND NOT EXISTS (SELECT 1 FROM "VariantPackage" k WHERE k."variantId" = "ProductVariant"."id")
   AND NOT EXISTS (SELECT 1 FROM "OrderItem" i WHERE i."variantId" = "ProductVariant"."id")
   AND NOT EXISTS (SELECT 1 FROM "SellerProductVariant" s WHERE s."productVariantId" = "ProductVariant"."id");

-- ---------------------------------------------------------------------------
-- 4. Drop what the forward migration added.
-- ---------------------------------------------------------------------------

ALTER TABLE "OrderItem"
  DROP COLUMN "currency",
  DROP COLUMN "packageHeightCm",
  DROP COLUMN "packageLengthCm",
  DROP COLUMN "packageWidthCm",
  DROP COLUMN "packagedWeightKg",
  DROP COLUMN "productCode",
  DROP COLUMN "productHeightCm",
  DROP COLUMN "productLengthCm",
  DROP COLUMN "productWeightKg",
  DROP COLUMN "productWidthCm",
  DROP COLUMN "selectedOptions",
  DROP COLUMN "sellerRetailPrice",
  DROP COLUMN "unitsPerPackage",
  DROP COLUMN "variantName";

ALTER TABLE "ProductVariant"
  DROP COLUMN "barcode",
  DROP COLUMN "currency",
  DROP COLUMN "externalInventoryRef",
  DROP COLUMN "isDefault",
  DROP COLUMN "productHeightCm",
  DROP COLUMN "productLengthCm",
  DROP COLUMN "productWeightKg",
  DROP COLUMN "productWidthCm",
  DROP COLUMN "sortOrder",
  DROP COLUMN "trackInventory",
  DROP COLUMN "unitsPerPackage";

ALTER TABLE "Product"
  DROP COLUMN "productCode",
  DROP COLUMN "careInstructions",
  DROP COLUMN "createdById",
  DROP COLUMN "features",
  DROP COLUMN "materials",
  DROP COLUMN "status",
  DROP COLUMN "updatedById";

DROP TABLE "SellerBrandKit";
DROP TABLE "ExternalVariantMapping";
DROP TABLE "ExternalProductMapping";
DROP TABLE "VariantOption";
DROP TABLE "MediaAssetAssignment";
DROP TABLE "MediaAsset";

DROP TYPE "DocumentType";
DROP TYPE "ApprovalStatus";
DROP TYPE "ProcessingStatus";
DROP TYPE "MediaSubtype";
DROP TYPE "MediaCategory";
DROP TYPE "ProductStatus";

COMMIT;
