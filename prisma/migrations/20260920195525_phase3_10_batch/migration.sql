-- AlterTable
ALTER TABLE "MerchantApplication" ADD COLUMN "businessStartDate" DATETIME;

-- AlterTable
ALTER TABLE "Seller" ADD COLUMN "businessStartDate" DATETIME;
ALTER TABLE "Seller" ADD COLUMN "domainRegisteredAt" DATETIME;
ALTER TABLE "Seller" ADD COLUMN "installedAt" DATETIME;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN "exceptionAt" DATETIME;
ALTER TABLE "Shipment" ADD COLUMN "handedToCarrierAt" DATETIME;
ALTER TABLE "Shipment" ADD COLUMN "inTransitAt" DATETIME;
ALTER TABLE "Shipment" ADD COLUMN "labelCreatedAt" DATETIME;
ALTER TABLE "Shipment" ADD COLUMN "packedAt" DATETIME;

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SellerProductVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sellerProductId" TEXT NOT NULL,
    "productVariantId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyInventoryItemId" TEXT,
    "shopifyLocationId" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'NEVER',
    "syncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SellerProductVariant_sellerProductId_fkey" FOREIGN KEY ("sellerProductId") REFERENCES "SellerProduct" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SellerProductVariant_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WholesalePayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerPaymentIntentId" TEXT,
    "providerChargeId" TEXT,
    "clientSecret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUIRES_PAYMENT',
    "failureMessage" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "paidAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WholesalePayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WholesalePayment_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "paymentId" TEXT,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSED',
    "errorMessage" TEXT,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "WholesalePayment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FulfillmentRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "shopifyFulfillmentOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME,
    "rejectedAt" DATETIME,
    "rejectReason" TEXT,
    "closedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FulfillmentRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IntegrationState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "lastSuccessAt" DATETIME,
    "lastErrorAt" DATETIME,
    "lastError" TEXT,
    "detail" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AnalyticsSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "periodStart" DATETIME,
    "periodEnd" DATETIME,
    "coverage" TEXT NOT NULL,
    "metrics" TEXT NOT NULL DEFAULT '{}',
    "lastSyncAt" DATETIME,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sellerId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderName" TEXT NOT NULL,
    "shopifyOrderNumber" INTEGER NOT NULL,
    "customerEmail" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "shippingAddress" TEXT,
    "billingAddress" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "subtotal" INTEGER NOT NULL,
    "totalTax" INTEGER NOT NULL,
    "totalShipping" INTEGER NOT NULL,
    "totalDiscounts" INTEGER NOT NULL,
    "totalPrice" INTEGER NOT NULL,
    "moonvellaSubtotal" INTEGER NOT NULL,
    "moonvellaTax" INTEGER NOT NULL,
    "moonvellaShipping" INTEGER NOT NULL,
    "moonvellaDiscounts" INTEGER NOT NULL,
    "moonvellaTotal" INTEGER NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "fulfillmentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "financialStatus" TEXT,
    "shopifyCreatedAt" DATETIME NOT NULL,
    "shopifyUpdatedAt" DATETIME NOT NULL,
    "processedAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelReason" TEXT,
    "supplierReference" TEXT,
    "shopifyFulfillmentOrderId" TEXT,
    "wholesalePaymentStatus" TEXT NOT NULL DEFAULT 'REQUIRES_PAYMENT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("billingAddress", "cancelReason", "cancelledAt", "createdAt", "currency", "customerEmail", "customerName", "customerPhone", "financialStatus", "fulfillmentStatus", "id", "moonvellaDiscounts", "moonvellaShipping", "moonvellaSubtotal", "moonvellaTax", "moonvellaTotal", "paymentStatus", "processedAt", "sellerId", "shippingAddress", "shopifyCreatedAt", "shopifyOrderId", "shopifyOrderName", "shopifyOrderNumber", "shopifyUpdatedAt", "subtotal", "totalDiscounts", "totalPrice", "totalShipping", "totalTax", "updatedAt") SELECT "billingAddress", "cancelReason", "cancelledAt", "createdAt", "currency", "customerEmail", "customerName", "customerPhone", "financialStatus", "fulfillmentStatus", "id", "moonvellaDiscounts", "moonvellaShipping", "moonvellaSubtotal", "moonvellaTax", "moonvellaTotal", "paymentStatus", "processedAt", "sellerId", "shippingAddress", "shopifyCreatedAt", "shopifyOrderId", "shopifyOrderName", "shopifyOrderNumber", "shopifyUpdatedAt", "subtotal", "totalDiscounts", "totalPrice", "totalShipping", "totalTax", "updatedAt" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE UNIQUE INDEX "Order_supplierReference_key" ON "Order"("supplierReference");
CREATE INDEX "Order_sellerId_idx" ON "Order"("sellerId");
CREATE INDEX "Order_shopifyOrderId_idx" ON "Order"("shopifyOrderId");
CREATE INDEX "Order_shopifyCreatedAt_idx" ON "Order"("shopifyCreatedAt");
CREATE INDEX "Order_processedAt_idx" ON "Order"("processedAt");
CREATE TABLE "new_Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "wholesalePrice" INTEGER NOT NULL,
    "suggestedRetailPrice" INTEGER NOT NULL,
    "costPrice" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "images" TEXT NOT NULL DEFAULT '[]',
    "categoryId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Product" ("category", "categoryId", "costPrice", "createdAt", "description", "id", "images", "isActive", "isArchived", "name", "sku", "suggestedRetailPrice", "updatedAt", "wholesalePrice") SELECT "category", "categoryId", "costPrice", "createdAt", "description", "id", "images", "isActive", "isArchived", "name", "sku", "suggestedRetailPrice", "updatedAt", "wholesalePrice" FROM "Product";
DROP TABLE "Product";
ALTER TABLE "new_Product" RENAME TO "Product";
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");
CREATE INDEX "Product_category_idx" ON "Product"("category");
CREATE INDEX "Product_sku_idx" ON "Product"("sku");
CREATE INDEX "Product_isActive_idx" ON "Product"("isActive");
CREATE TABLE "new_SellerProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shopifyProductId" TEXT,
    "shopifyVariantIds" TEXT NOT NULL DEFAULT '[]',
    "importedAt" DATETIME,
    "importStatus" TEXT NOT NULL DEFAULT 'NEVER',
    "lastImportError" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "customWholesalePrice" INTEGER,
    "customRetailPrice" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SellerProduct_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SellerProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SellerProduct" ("createdAt", "customRetailPrice", "customWholesalePrice", "id", "importedAt", "isActive", "productId", "sellerId", "shopifyProductId", "shopifyVariantIds", "updatedAt") SELECT "createdAt", "customRetailPrice", "customWholesalePrice", "id", "importedAt", "isActive", "productId", "sellerId", "shopifyProductId", "shopifyVariantIds", "updatedAt" FROM "SellerProduct";
DROP TABLE "SellerProduct";
ALTER TABLE "new_SellerProduct" RENAME TO "SellerProduct";
CREATE INDEX "SellerProduct_sellerId_idx" ON "SellerProduct"("sellerId");
CREATE INDEX "SellerProduct_productId_idx" ON "SellerProduct"("productId");
CREATE UNIQUE INDEX "SellerProduct_sellerId_productId_key" ON "SellerProduct"("sellerId", "productId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ProductImage_productId_idx" ON "ProductImage"("productId");

-- CreateIndex
CREATE INDEX "SellerProductVariant_sellerProductId_idx" ON "SellerProductVariant"("sellerProductId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerProductVariant_sellerProductId_productVariantId_key" ON "SellerProductVariant"("sellerProductId", "productVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerProductVariant_shopifyVariantId_key" ON "SellerProductVariant"("shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "WholesalePayment_orderId_key" ON "WholesalePayment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "WholesalePayment_providerPaymentIntentId_key" ON "WholesalePayment"("providerPaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "WholesalePayment_idempotencyKey_key" ON "WholesalePayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WholesalePayment_sellerId_idx" ON "WholesalePayment"("sellerId");

-- CreateIndex
CREATE INDEX "WholesalePayment_status_idx" ON "WholesalePayment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_eventId_key" ON "PaymentEvent"("eventId");

-- CreateIndex
CREATE INDEX "PaymentEvent_paymentId_idx" ON "PaymentEvent"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentEvent_type_idx" ON "PaymentEvent"("type");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentRequest_orderId_key" ON "FulfillmentRequest"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationState_key_key" ON "IntegrationState"("key");

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_shop_idx" ON "AnalyticsSnapshot"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsSnapshot_shop_source_key" ON "AnalyticsSnapshot"("shop", "source");
