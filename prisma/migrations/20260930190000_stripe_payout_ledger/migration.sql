CREATE TABLE "StripePayout" (
    "id" TEXT NOT NULL,
    "providerPayoutId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "arrivalDate" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "lastEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripePayout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StripePayout_providerPayoutId_key" ON "StripePayout"("providerPayoutId");
CREATE INDEX "StripePayout_status_idx" ON "StripePayout"("status");
CREATE INDEX "StripePayout_arrivalDate_idx" ON "StripePayout"("arrivalDate");
