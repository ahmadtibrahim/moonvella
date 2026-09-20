-- CreateTable
CREATE TABLE "SellerBankAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SellerBankAccount_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SellerBankAccount_sellerId_idx" ON "SellerBankAccount"("sellerId");
