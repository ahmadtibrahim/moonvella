-- Customer accounting: invoices, allocations, credits, supplier bills.
--
-- PURELY ADDITIVE, and deliberately so. Seven new tables, three new enum types,
-- one new sequence table. No existing column is altered, no row is moved, and
-- nothing the deployed image reads or writes is touched — so the image that is
-- running keeps working unchanged for the window between `migrate deploy` and
-- the new container taking traffic, and a rollback to it needs no schema work.
--
-- EXISTING TRANSACTIONS ARE NOT CONVERTED, and that is a decision rather than an
-- omission. Past orders already carry their money on `Order` and their charge on
-- `WholesalePayment`; those rows are the record of what happened and re-writing
-- them into invoices would invent document numbers and issue dates for
-- documents that were never issued. The invoice tables start empty and are
-- populated from the moment this ships; a statement for a period before that
-- reads its opening balance from the orders and payments that already exist.
--
-- WHY `total` IS STORED RATHER THAN COMPUTED. An invoice is a document that has
-- been sent. If its total were derived on read, then correcting a line — even to
-- fix a typo — would silently change a figure somebody has already been given,
-- and the correction would leave no trace. `subtotal`, `adjustments`, `taxTotal`
-- and `total` are written once, at issue, and the lines are copied rather than
-- referenced for the same reason.
--
-- WHY THE ALLOCATION KEY IS UNIQUE. A Stripe webhook is delivered at least once.
-- The only place the "at least" can be made into "exactly one" without a race is
-- the database, so `PaymentAllocation.idempotencyKey` carries a unique index and
-- a replayed delivery violates it rather than allocating a second time.
--
-- WHY THERE IS A SEQUENCE TABLE. `MAX(number) + 1` reads the same maximum from
-- two concurrent issues and hands out the same number twice; the second then
-- fails on the unique index and an operator sees "could not issue invoice" for a
-- reason that has nothing to do with the invoice. The counter is incremented and
-- read in one statement instead.

-- ---------------------------------------------------------------------------
-- 1. Enum types.
-- ---------------------------------------------------------------------------

CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID');
CREATE TYPE "CreditStatus" AS ENUM ('ISSUED', 'APPLIED', 'VOID');
CREATE TYPE "SupplierBillStatus" AS ENUM ('OPEN', 'PARTIAL', 'PAID', 'VOID');
CREATE TYPE "SupplierBillPaymentMethod" AS ENUM ('LOGGED', 'CARD');

-- ---------------------------------------------------------------------------
-- 2. The number counter.
-- ---------------------------------------------------------------------------

CREATE TABLE "NumberSequence" (
  "id"        TEXT NOT NULL,
  "key"       TEXT NOT NULL,
  "nextValue" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NumberSequence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NumberSequence_key_key" ON "NumberSequence" ("key");

-- ---------------------------------------------------------------------------
-- 3. Invoices.
-- ---------------------------------------------------------------------------

CREATE TABLE "Invoice" (
  "id"          TEXT NOT NULL,
  "number"      TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "sellerId"    TEXT NOT NULL,
  "status"      "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
  "currency"    TEXT NOT NULL DEFAULT 'CAD',
  "issuedAt"    TIMESTAMP(3),
  "dueDate"     TIMESTAMP(3),
  "voidedAt"    TIMESTAMP(3),
  "voidReason"  TEXT,
  "subtotal"    INTEGER NOT NULL,
  "adjustments" INTEGER NOT NULL DEFAULT 0,
  "taxTotal"    INTEGER NOT NULL DEFAULT 0,
  "total"       INTEGER NOT NULL,
  "billTo"      JSONB NOT NULL,
  "shipTo"      JSONB,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice" ("number");
-- One invoice per order. An order is billed once; a correction is a credit or a
-- new document, never a second invoice for the same order.
CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice" ("orderId");
CREATE INDEX "Invoice_sellerId_issuedAt_idx" ON "Invoice" ("sellerId", "issuedAt");
CREATE INDEX "Invoice_status_idx" ON "Invoice" ("status");
CREATE INDEX "Invoice_dueDate_idx" ON "Invoice" ("dueDate");

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId")
  REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_sellerId_fkey" FOREIGN KEY ("sellerId")
  REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InvoiceLine" (
  "id"          TEXT NOT NULL,
  "invoiceId"   TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "sku"         TEXT,
  "quantity"    INTEGER NOT NULL,
  "unitAmount"  INTEGER NOT NULL,
  "amount"      INTEGER NOT NULL,
  "sourceType"  TEXT,
  "sourceId"    TEXT,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine" ("invoiceId");

ALTER TABLE "InvoiceLine"
  ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId")
  REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Allocations.
-- ---------------------------------------------------------------------------

CREATE TABLE "PaymentAllocation" (
  "id"             TEXT NOT NULL,
  "paymentId"      TEXT NOT NULL,
  "invoiceId"      TEXT NOT NULL,
  "amount"         INTEGER NOT NULL,
  "currency"       TEXT NOT NULL DEFAULT 'CAD',
  "allocatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "allocatedById"  TEXT,
  "note"           TEXT,
  "idempotencyKey" TEXT NOT NULL,

  CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentAllocation_idempotencyKey_key"
  ON "PaymentAllocation" ("idempotencyKey");
CREATE INDEX "PaymentAllocation_invoiceId_idx" ON "PaymentAllocation" ("invoiceId");
CREATE INDEX "PaymentAllocation_paymentId_idx" ON "PaymentAllocation" ("paymentId");

ALTER TABLE "PaymentAllocation"
  ADD CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId")
  REFERENCES "WholesalePayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentAllocation"
  ADD CONSTRAINT "PaymentAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId")
  REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. Credit notes.
-- ---------------------------------------------------------------------------

CREATE TABLE "CreditNote" (
  "id"             TEXT NOT NULL,
  "number"         TEXT NOT NULL,
  "invoiceId"      TEXT,
  "sellerId"       TEXT NOT NULL,
  "currency"       TEXT NOT NULL DEFAULT 'CAD',
  "amount"         INTEGER NOT NULL,
  "reason"         TEXT NOT NULL,
  "status"         "CreditStatus" NOT NULL DEFAULT 'ISSUED',
  "issuedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "issuedById"     TEXT,
  "appliedAt"      TIMESTAMP(3),
  "stripeRefundId" TEXT,
  "refundId"       TEXT,

  CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreditNote_number_key" ON "CreditNote" ("number");
CREATE INDEX "CreditNote_sellerId_issuedAt_idx" ON "CreditNote" ("sellerId", "issuedAt");
CREATE INDEX "CreditNote_invoiceId_idx" ON "CreditNote" ("invoiceId");
CREATE INDEX "CreditNote_status_idx" ON "CreditNote" ("status");

ALTER TABLE "CreditNote"
  ADD CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId")
  REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreditNote"
  ADD CONSTRAINT "CreditNote_sellerId_fkey" FOREIGN KEY ("sellerId")
  REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditNote"
  ADD CONSTRAINT "CreditNote_refundId_fkey" FOREIGN KEY ("refundId")
  REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. Supplier bills and their payments.
-- ---------------------------------------------------------------------------

CREATE TABLE "SupplierBill" (
  "id"           TEXT NOT NULL,
  "supplier"     TEXT NOT NULL,
  "reference"    TEXT,
  "category"     TEXT NOT NULL,
  "currency"     TEXT NOT NULL DEFAULT 'CAD',
  "total"        INTEGER NOT NULL,
  "issuedOn"     TIMESTAMP(3) NOT NULL,
  "dueDate"      TIMESTAMP(3),
  "status"       "SupplierBillStatus" NOT NULL DEFAULT 'OPEN',
  "notes"        TEXT,
  "shipmentId"   TEXT,
  "documentKey"  TEXT,
  "documentName" TEXT,
  "createdById"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupplierBill_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierBill_status_idx" ON "SupplierBill" ("status");
CREATE INDEX "SupplierBill_dueDate_idx" ON "SupplierBill" ("dueDate");
CREATE INDEX "SupplierBill_supplier_idx" ON "SupplierBill" ("supplier");

ALTER TABLE "SupplierBill"
  ADD CONSTRAINT "SupplierBill_shipmentId_fkey" FOREIGN KEY ("shipmentId")
  REFERENCES "Shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SupplierBillPayment" (
  "id"             TEXT NOT NULL,
  "billId"         TEXT NOT NULL,
  "amount"         INTEGER NOT NULL,
  "currency"       TEXT NOT NULL DEFAULT 'CAD',
  "method"         "SupplierBillPaymentMethod" NOT NULL,
  "reference"      TEXT,
  "paidAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedById"   TEXT,
  "note"           TEXT,
  "idempotencyKey" TEXT,

  CONSTRAINT "SupplierBillPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplierBillPayment_idempotencyKey_key"
  ON "SupplierBillPayment" ("idempotencyKey");
CREATE INDEX "SupplierBillPayment_billId_idx" ON "SupplierBillPayment" ("billId");

ALTER TABLE "SupplierBillPayment"
  ADD CONSTRAINT "SupplierBillPayment_billId_fkey" FOREIGN KEY ("billId")
  REFERENCES "SupplierBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 7. The starting counters.
--
-- Seeded here rather than created lazily by the issuing code, so that two
-- concurrent first-issues cannot both find no row and both insert one.
-- ---------------------------------------------------------------------------

INSERT INTO "NumberSequence" ("id", "key", "nextValue", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'invoice', 1, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'credit', 1, CURRENT_TIMESTAMP);
