-- MoonVella order pipeline: the state machine, delivery-level webhook dedup, and
-- the uniqueness the charging path depends on.
--
-- Additive throughout. Every column is nullable or carries a default, so the
-- deployment's existing rows stay valid and the migration can be applied while
-- the app is running. The four new unique indexes are the exception in spirit —
-- they ADD a constraint the tables did not have — and each one is safe here for
-- a stated reason:
--
--   Order(sellerId, shopifyOrderId)      — the table is empty; no order has ever
--                                          been ingested.
--   OrderItem(orderId, shopifyLineItemId) — follows from the above.
--   Refund(orderId, shopifyRefundId)      — follows from the above.
--   WebhookEvent.shopifyWebhookId         — new column, so every existing row is
--                                          NULL and NULLs do not collide in a
--                                          PostgreSQL unique index.
--
-- They are added now rather than later because the defect they prevent is silent
-- and expensive: an order ingested twice is an order charged twice.
-- CreateEnum
CREATE TYPE "MoonvellaOrderState" AS ENUM ('RECEIVED', 'AWAITING_SELLER_PAYMENT', 'PAYMENT_PROCESSING', 'PAYMENT_ACTION_REQUIRED', 'PAYMENT_FAILED', 'PAID', 'READY_FOR_FULFILLMENT', 'FULFILLMENT_REQUESTED', 'IN_FULFILLMENT', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUND_REVIEW');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "shopifyFulfillmentState" TEXT,
ADD COLUMN     "state" "MoonvellaOrderState" NOT NULL DEFAULT 'RECEIVED',
ADD COLUMN     "stateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "stripeRefundId" TEXT,
ADD COLUMN     "stripeStatus" TEXT;

-- AlterTable
ALTER TABLE "Seller" ADD COLUMN     "fulfillmentLocationCheckedAt" TIMESTAMP(3),
ADD COLUMN     "shopifyFulfillmentLocationId" TEXT,
ADD COLUMN     "shopifyFulfillmentServiceId" TEXT;

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "shopifyWebhookId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'WEBHOOK';

-- AlterTable
ALTER TABLE "WholesalePayment" ADD COLUMN     "paymentVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "priceSnapshot" JSONB;

-- CreateTable
CREATE TABLE "OrderStateTransition" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromState" "MoonvellaOrderState",
    "toState" "MoonvellaOrderState" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderStateTransition_orderId_createdAt_idx" ON "OrderStateTransition"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderStateTransition_toState_idx" ON "OrderStateTransition"("toState");

-- CreateIndex
CREATE INDEX "Order_state_idx" ON "Order"("state");

-- CreateIndex
CREATE UNIQUE INDEX "Order_sellerId_shopifyOrderId_key" ON "Order"("sellerId", "shopifyOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_orderId_shopifyLineItemId_key" ON "OrderItem"("orderId", "shopifyLineItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_stripeRefundId_key" ON "Refund"("stripeRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_orderId_shopifyRefundId_key" ON "Refund"("orderId", "shopifyRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_shopifyWebhookId_key" ON "WebhookEvent"("shopifyWebhookId");

-- AddForeignKey
ALTER TABLE "OrderStateTransition" ADD CONSTRAINT "OrderStateTransition_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
