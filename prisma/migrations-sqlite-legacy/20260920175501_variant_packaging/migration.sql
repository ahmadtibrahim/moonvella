-- CreateTable
CREATE TABLE "PackagingPreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "packageType" TEXT NOT NULL DEFAULT 'carton',
    "length" REAL NOT NULL,
    "width" REAL NOT NULL,
    "height" REAL NOT NULL,
    "dimensionUnit" TEXT NOT NULL DEFAULT 'cm',
    "emptyWeight" REAL,
    "weightUnit" TEXT NOT NULL DEFAULT 'kg',
    "maxWeight" REAL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "VariantPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "variantId" TEXT NOT NULL,
    "label" TEXT,
    "packageType" TEXT NOT NULL DEFAULT 'carton',
    "presetId" TEXT,
    "length" REAL NOT NULL,
    "width" REAL NOT NULL,
    "height" REAL NOT NULL,
    "dimensionUnit" TEXT NOT NULL DEFAULT 'cm',
    "grossWeight" REAL NOT NULL,
    "weightUnit" TEXT NOT NULL DEFAULT 'kg',
    "unitsPerPackage" INTEGER NOT NULL DEFAULT 1,
    "packagesPerUnit" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VariantPackage_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VariantPackage_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "PackagingPreset" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ProductVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "wholesalePrice" INTEGER NOT NULL,
    "suggestedRetailPrice" INTEGER NOT NULL,
    "costPrice" INTEGER,
    "inventory" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 5,
    "optionName" TEXT,
    "optionValue" TEXT,
    "variantImageUrl" TEXT,
    "shipsSeparately" BOOLEAN NOT NULL DEFAULT false,
    "packingInstructions" TEXT,
    "shippingDescription" TEXT,
    "declaredValueDefault" INTEGER,
    "weight" INTEGER,
    "dimensions" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ProductVariant" ("costPrice", "createdAt", "dimensions", "id", "inventory", "isActive", "name", "productId", "sku", "suggestedRetailPrice", "updatedAt", "weight", "wholesalePrice") SELECT "costPrice", "createdAt", "dimensions", "id", "inventory", "isActive", "name", "productId", "sku", "suggestedRetailPrice", "updatedAt", "weight", "wholesalePrice" FROM "ProductVariant";
DROP TABLE "ProductVariant";
ALTER TABLE "new_ProductVariant" RENAME TO "ProductVariant";
CREATE UNIQUE INDEX "ProductVariant_sku_key" ON "ProductVariant"("sku");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PackagingPreset_name_key" ON "PackagingPreset"("name");

-- CreateIndex
CREATE INDEX "VariantPackage_variantId_idx" ON "VariantPackage"("variantId");
