-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN "bookedCost" INTEGER;
ALTER TABLE "Shipment" ADD COLUMN "bookingIdempotencyKey" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "labelUrl" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "packageCount" INTEGER;
ALTER TABLE "Shipment" ADD COLUMN "provider" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "providerShipmentId" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "serviceName" TEXT;

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paymentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerPaymentIntentId" TEXT,
    "status" TEXT NOT NULL,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "requiresAction" BOOLEAN NOT NULL DEFAULT false,
    "amount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentAttempt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "WholesalePayment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SellerBillingSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sellerId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'MANUAL',
    "autoPayEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxAmountPerOrder" INTEGER,
    "maxShippingCharge" INTEGER,
    "preferredShippingPolicy" TEXT,
    "holdForReview" BOOLEAN NOT NULL DEFAULT true,
    "autoBookShipment" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SellerBillingSettings_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SellerPaymentMethod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sellerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "stripeCustomerId" TEXT,
    "stripePaymentMethodId" TEXT,
    "brand" TEXT,
    "last4" TEXT,
    "expMonth" INTEGER,
    "expYear" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "authorizationConsentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SellerPaymentMethod_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ShippingQuote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'eshipper',
    "carrier" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "transitDays" INTEGER,
    "estimatedDelivery" DATETIME,
    "quotedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "raw" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShippingQuote_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrderPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "length" REAL NOT NULL,
    "width" REAL NOT NULL,
    "height" REAL NOT NULL,
    "weight" REAL NOT NULL,
    "units" TEXT NOT NULL DEFAULT 'cm_kg',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderPackage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WholesalePayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerPaymentIntentId" TEXT,
    "providerChargeId" TEXT,
    "clientSecret" TEXT,
    "paymentMethodId" TEXT,
    "billingMode" TEXT,
    "subtotal" INTEGER,
    "shippingAmount" INTEGER,
    "taxAmount" INTEGER,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "status" TEXT NOT NULL DEFAULT 'REQUIRES_PAYMENT',
    "requiresAction" BOOLEAN NOT NULL DEFAULT false,
    "failureMessage" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "authorizedAt" DATETIME,
    "capturedAt" DATETIME,
    "refundedAmount" INTEGER NOT NULL DEFAULT 0,
    "paidAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WholesalePayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WholesalePayment_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WholesalePayment" ("amount", "clientSecret", "createdAt", "currency", "failureMessage", "id", "idempotencyKey", "orderId", "paidAt", "provider", "providerChargeId", "providerPaymentIntentId", "sellerId", "status", "updatedAt") SELECT "amount", "clientSecret", "createdAt", "currency", "failureMessage", "id", "idempotencyKey", "orderId", "paidAt", "provider", "providerChargeId", "providerPaymentIntentId", "sellerId", "status", "updatedAt" FROM "WholesalePayment";
DROP TABLE "WholesalePayment";
ALTER TABLE "new_WholesalePayment" RENAME TO "WholesalePayment";
CREATE UNIQUE INDEX "WholesalePayment_orderId_key" ON "WholesalePayment"("orderId");
CREATE UNIQUE INDEX "WholesalePayment_providerPaymentIntentId_key" ON "WholesalePayment"("providerPaymentIntentId");
CREATE UNIQUE INDEX "WholesalePayment_idempotencyKey_key" ON "WholesalePayment"("idempotencyKey");
CREATE INDEX "WholesalePayment_sellerId_idx" ON "WholesalePayment"("sellerId");
CREATE INDEX "WholesalePayment_status_idx" ON "WholesalePayment"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PaymentAttempt_paymentId_idx" ON "PaymentAttempt"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerBillingSettings_sellerId_key" ON "SellerBillingSettings"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerPaymentMethod_stripePaymentMethodId_key" ON "SellerPaymentMethod"("stripePaymentMethodId");

-- CreateIndex
CREATE INDEX "SellerPaymentMethod_sellerId_idx" ON "SellerPaymentMethod"("sellerId");

-- CreateIndex
CREATE INDEX "ShippingQuote_orderId_idx" ON "ShippingQuote"("orderId");

-- CreateIndex
CREATE INDEX "OrderPackage_orderId_idx" ON "OrderPackage"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_bookingIdempotencyKey_key" ON "Shipment"("bookingIdempotencyKey");

