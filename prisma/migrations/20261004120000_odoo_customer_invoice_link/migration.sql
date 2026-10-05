-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "odooInvoiceEmailSentAt" TIMESTAMP(3),
ADD COLUMN     "odooInvoiceError" TEXT,
ADD COLUMN     "odooInvoiceId" INTEGER,
ADD COLUMN     "odooInvoiceName" TEXT,
ADD COLUMN     "odooInvoiceSyncedAt" TIMESTAMP(3),
ADD COLUMN     "odooSaleOrderId" INTEGER;

-- CreateIndex
CREATE INDEX "Order_odooInvoiceId_idx" ON "Order"("odooInvoiceId");
