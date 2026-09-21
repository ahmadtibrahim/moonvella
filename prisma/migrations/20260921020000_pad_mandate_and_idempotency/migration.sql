-- AlterTable
ALTER TABLE "IdempotencyKey" DROP COLUMN "resultRef",
ADD COLUMN     "fingerprint" TEXT NOT NULL,
ADD COLUMN     "result" JSONB;

-- CreateTable
CREATE TABLE "PadMandate" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reference" TEXT,
    "payerName" TEXT NOT NULL,
    "accountLast4" TEXT,
    "institutionNumber" TEXT,
    "transitNumber" TEXT,
    "accountType" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PadMandate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PadMandate_sellerId_idx" ON "PadMandate"("sellerId");

-- CreateIndex
CREATE INDEX "PadMandate_state_idx" ON "PadMandate"("state");

-- CreateIndex
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");

