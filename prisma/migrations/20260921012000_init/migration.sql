-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OwnerRole" AS ENUM ('OWNER', 'OPERATIONS', 'REVIEWER', 'READONLY');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'NEEDS_INFO', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "SellerStatus" AS ENUM ('PENDING', 'APPROVED', 'NEEDS_INFO', 'REJECTED', 'SUSPENDED', 'UNINSTALLED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('NEVER', 'SYNCING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED');

-- CreateEnum
CREATE TYPE "FulfillmentStatus" AS ENUM ('PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'SHIPPED', 'DELIVERED', 'EXCEPTION', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('OWNER_USER', 'SYSTEM', 'MERCHANT', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "WholesalePaymentStatus" AS ENUM ('REQUIRES_PAYMENT', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FulfillmentRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'CLOSED');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONFIGURED', 'NEVER_SYNCED', 'HEALTHY', 'DELAYED', 'FAILED');

-- CreateEnum
CREATE TYPE "BillingMode" AS ENUM ('MANUAL', 'AUTOMATIC');

-- CreateEnum
CREATE TYPE "PaymentMethodStatus" AS ENUM ('ACTIVE', 'REMOVED', 'REQUIRES_ACTION');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "OwnerRole" NOT NULL DEFAULT 'OWNER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "OwnerUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantApplication" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "shopifyPlan" TEXT,
    "storeUrl" TEXT,
    "country" TEXT,
    "currency" TEXT,
    "contactName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "urgentPhone" TEXT,
    "legalBusinessName" TEXT NOT NULL,
    "sellerAddress" TEXT NOT NULL,
    "gstHstNumber" TEXT,
    "productCategory" TEXT NOT NULL,
    "markets" TEXT NOT NULL DEFAULT '[]',
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "rejectionReason" TEXT,
    "internalNotes" TEXT,
    "businessStartDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "shopifyStoreProfile" TEXT DEFAULT '{}',
    "shopifySalesReview" TEXT DEFAULT '{}',
    "merchantContact" TEXT DEFAULT '{}',

    CONSTRAINT "MerchantApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seller" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "storeName" TEXT NOT NULL,
    "shopDomainFull" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "country" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "shopifyPlan" TEXT,
    "storeUrl" TEXT,
    "applicationId" TEXT,
    "status" "SellerStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "suspensionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "installedAt" TIMESTAMP(3),
    "domainRegisteredAt" TIMESTAMP(3),
    "businessStartDate" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'NEVER',

    CONSTRAINT "Seller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerSettings" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "autoSyncInventory" BOOLEAN NOT NULL DEFAULT true,
    "quantityBuffer" INTEGER NOT NULL DEFAULT 5,
    "lowStockAlerts" BOOLEAN NOT NULL DEFAULT true,
    "autoImportOrders" BOOLEAN NOT NULL DEFAULT true,
    "estimatedDeliveryMsg" TEXT NOT NULL DEFAULT 'Typically ships within 2–4 business days.',
    "defaultMarkup" INTEGER NOT NULL DEFAULT 200,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alt" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "parentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackagingPreset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "packageType" TEXT NOT NULL DEFAULT 'carton',
    "length" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "dimensionUnit" TEXT NOT NULL DEFAULT 'cm',
    "emptyWeight" DOUBLE PRECISION,
    "weightUnit" TEXT NOT NULL DEFAULT 'kg',
    "maxWeight" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackagingPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantPackage" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerProduct" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shopifyProductId" TEXT,
    "shopifyVariantIds" TEXT NOT NULL DEFAULT '[]',
    "importedAt" TIMESTAMP(3),
    "importStatus" "SyncStatus" NOT NULL DEFAULT 'NEVER',
    "lastImportError" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "customWholesalePrice" INTEGER,
    "customRetailPrice" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerProductVariant" (
    "id" TEXT NOT NULL,
    "sellerProductId" TEXT NOT NULL,
    "productVariantId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyInventoryItemId" TEXT,
    "shopifyLocationId" TEXT,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'NEVER',
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
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
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "fulfillmentStatus" "FulfillmentStatus" NOT NULL DEFAULT 'PENDING',
    "financialStatus" TEXT,
    "shopifyCreatedAt" TIMESTAMP(3) NOT NULL,
    "shopifyUpdatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "supplierReference" TEXT,
    "shopifyFulfillmentOrderId" TEXT,
    "wholesalePaymentStatus" "WholesalePaymentStatus" NOT NULL DEFAULT 'REQUIRES_PAYMENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "sellerProductId" TEXT,
    "shopifyLineItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "wholesalePrice" INTEGER NOT NULL,
    "totalDiscount" INTEGER NOT NULL,
    "isMoonvellaProduct" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyRefundId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundItem" (
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyFulfillmentId" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "carrier" TEXT,
    "serviceName" TEXT,
    "provider" TEXT,
    "providerShipmentId" TEXT,
    "labelUrl" TEXT,
    "bookedCost" INTEGER,
    "bookingIdempotencyKey" TEXT,
    "packageCount" INTEGER,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "labelCreatedAt" TIMESTAMP(3),
    "packedAt" TIMESTAMP(3),
    "handedToCarrierAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "inTransitAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "exceptionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentItem" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "beforeData" TEXT,
    "afterData" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingZone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "supplierShippingCost" INTEGER NOT NULL,
    "transit" TEXT NOT NULL,
    "freeShippingThreshold" INTEGER NOT NULL,
    "customerDisplay" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShippingZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "processedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WholesalePayment" (
    "id" TEXT NOT NULL,
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
    "status" "WholesalePaymentStatus" NOT NULL DEFAULT 'REQUIRES_PAYMENT',
    "requiresAction" BOOLEAN NOT NULL DEFAULT false,
    "failureMessage" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "authorizedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3),
    "refundedAmount" INTEGER NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WholesalePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerPaymentIntentId" TEXT,
    "status" TEXT NOT NULL,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "requiresAction" BOOLEAN NOT NULL DEFAULT false,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerBillingSettings" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "mode" "BillingMode" NOT NULL DEFAULT 'MANUAL',
    "autoPayEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxAmountPerOrder" INTEGER,
    "maxShippingCharge" INTEGER,
    "preferredShippingPolicy" TEXT,
    "holdForReview" BOOLEAN NOT NULL DEFAULT true,
    "autoBookShipment" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerBillingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerPaymentMethod" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "stripeCustomerId" TEXT,
    "stripePaymentMethodId" TEXT,
    "brand" TEXT,
    "last4" TEXT,
    "expMonth" INTEGER,
    "expYear" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" "PaymentMethodStatus" NOT NULL DEFAULT 'ACTIVE',
    "authorizationConsentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerPaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerBankAccount" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'plaid',
    "plaidItemId" TEXT,
    "encryptedAccessToken" TEXT NOT NULL,
    "institutionName" TEXT,
    "accountName" TEXT,
    "accountMask" TEXT,
    "accountType" TEXT,
    "accountSubtype" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingQuote" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'eshipper',
    "carrier" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "transitDays" INTEGER,
    "estimatedDelivery" TIMESTAMP(3),
    "quotedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "raw" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShippingQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderPackage" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "length" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "units" TEXT NOT NULL DEFAULT 'cm_kg',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "paymentId" TEXT,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSED',
    "errorMessage" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfillmentRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyFulfillmentOrderId" TEXT,
    "status" "FulfillmentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FulfillmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationState" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "detail" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsSnapshot" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "coverage" TEXT NOT NULL,
    "metrics" TEXT NOT NULL DEFAULT '{}',
    "lastSyncAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "resultRef" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnerUser_email_key" ON "OwnerUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerSession_token_key" ON "OwnerSession"("token");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantApplication_shopDomain_key" ON "MerchantApplication"("shopDomain");

-- CreateIndex
CREATE INDEX "MerchantApplication_status_idx" ON "MerchantApplication"("status");

-- CreateIndex
CREATE INDEX "MerchantApplication_shopDomain_idx" ON "MerchantApplication"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "Seller_shopDomain_key" ON "Seller"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "Seller_applicationId_key" ON "Seller"("applicationId");

-- CreateIndex
CREATE INDEX "Seller_status_idx" ON "Seller"("status");

-- CreateIndex
CREATE INDEX "Seller_shopDomain_idx" ON "Seller"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "SellerSettings_sellerId_key" ON "SellerSettings"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE INDEX "Product_category_idx" ON "Product"("category");

-- CreateIndex
CREATE INDEX "Product_sku_idx" ON "Product"("sku");

-- CreateIndex
CREATE INDEX "Product_isActive_idx" ON "Product"("isActive");

-- CreateIndex
CREATE INDEX "ProductImage_productId_idx" ON "ProductImage"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_sku_key" ON "ProductVariant"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "PackagingPreset_name_key" ON "PackagingPreset"("name");

-- CreateIndex
CREATE INDEX "VariantPackage_variantId_idx" ON "VariantPackage"("variantId");

-- CreateIndex
CREATE INDEX "SellerProduct_sellerId_idx" ON "SellerProduct"("sellerId");

-- CreateIndex
CREATE INDEX "SellerProduct_productId_idx" ON "SellerProduct"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerProduct_sellerId_productId_key" ON "SellerProduct"("sellerId", "productId");

-- CreateIndex
CREATE INDEX "SellerProductVariant_sellerProductId_idx" ON "SellerProductVariant"("sellerProductId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerProductVariant_sellerProductId_productVariantId_key" ON "SellerProductVariant"("sellerProductId", "productVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerProductVariant_shopifyVariantId_key" ON "SellerProductVariant"("shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_supplierReference_key" ON "Order"("supplierReference");

-- CreateIndex
CREATE INDEX "Order_sellerId_idx" ON "Order"("sellerId");

-- CreateIndex
CREATE INDEX "Order_shopifyOrderId_idx" ON "Order"("shopifyOrderId");

-- CreateIndex
CREATE INDEX "Order_shopifyCreatedAt_idx" ON "Order"("shopifyCreatedAt");

-- CreateIndex
CREATE INDEX "Order_processedAt_idx" ON "Order"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_bookingIdempotencyKey_key" ON "Shipment"("bookingIdempotencyKey");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_idempotencyKey_key" ON "WebhookEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopDomain_topic_idx" ON "WebhookEvent"("shopDomain", "topic");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_idx" ON "WebhookEvent"("status");

-- CreateIndex
CREATE INDEX "WebhookEvent_idempotencyKey_idx" ON "WebhookEvent"("idempotencyKey");

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
CREATE INDEX "PaymentAttempt_paymentId_idx" ON "PaymentAttempt"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerBillingSettings_sellerId_key" ON "SellerBillingSettings"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerPaymentMethod_stripePaymentMethodId_key" ON "SellerPaymentMethod"("stripePaymentMethodId");

-- CreateIndex
CREATE INDEX "SellerPaymentMethod_sellerId_idx" ON "SellerPaymentMethod"("sellerId");

-- CreateIndex
CREATE INDEX "SellerBankAccount_sellerId_idx" ON "SellerBankAccount"("sellerId");

-- CreateIndex
CREATE INDEX "ShippingQuote_orderId_idx" ON "ShippingQuote"("orderId");

-- CreateIndex
CREATE INDEX "OrderPackage_orderId_idx" ON "OrderPackage"("orderId");

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

-- CreateIndex
CREATE INDEX "LoginAttempt_key_createdAt_idx" ON "LoginAttempt"("key", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_scope_status_idx" ON "IdempotencyKey"("scope", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_scope_key_key" ON "IdempotencyKey"("scope", "key");

-- AddForeignKey
ALTER TABLE "OwnerSession" ADD CONSTRAINT "OwnerSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "OwnerUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantApplication" ADD CONSTRAINT "MerchantApplication_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "OwnerUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seller" ADD CONSTRAINT "Seller_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "MerchantApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerSettings" ADD CONSTRAINT "SellerSettings_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantPackage" ADD CONSTRAINT "VariantPackage_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantPackage" ADD CONSTRAINT "VariantPackage_presetId_fkey" FOREIGN KEY ("presetId") REFERENCES "PackagingPreset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerProduct" ADD CONSTRAINT "SellerProduct_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerProduct" ADD CONSTRAINT "SellerProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerProductVariant" ADD CONSTRAINT "SellerProductVariant_sellerProductId_fkey" FOREIGN KEY ("sellerProductId") REFERENCES "SellerProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerProductVariant" ADD CONSTRAINT "SellerProductVariant_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_sellerProductId_fkey" FOREIGN KEY ("sellerProductId") REFERENCES "SellerProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundItem" ADD CONSTRAINT "RefundItem_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundItem" ADD CONSTRAINT "RefundItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WholesalePayment" ADD CONSTRAINT "WholesalePayment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WholesalePayment" ADD CONSTRAINT "WholesalePayment_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "WholesalePayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerBillingSettings" ADD CONSTRAINT "SellerBillingSettings_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerPaymentMethod" ADD CONSTRAINT "SellerPaymentMethod_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerBankAccount" ADD CONSTRAINT "SellerBankAccount_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingQuote" ADD CONSTRAINT "ShippingQuote_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPackage" ADD CONSTRAINT "OrderPackage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "WholesalePayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FulfillmentRequest" ADD CONSTRAINT "FulfillmentRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

