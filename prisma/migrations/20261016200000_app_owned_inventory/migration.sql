-- MoonVella's inventory becomes its own.
--
-- WHAT THIS CHANGES AND WHY IT IS SAFE TO APPLY BEFORE THE CODE.
--
-- Until now the catalogue's stock was an Odoo mirror: `VariantStockRecord` was
-- keyed by `odooLocationId` / `odooOwnerId` / `odooDatabase`, its quantities
-- were whatever the six-hourly `ODOO_CATALOG_SYNC` last read from `stock.quant`,
-- and a pickup location was not considered usable for booking unless it carried
-- four Odoo ids. MoonVella's own accounting and catalogue are now app-owned, so
-- the stock has to be too.
--
-- EVERY STATEMENT HERE IS ADDITIVE OR WIDENING. No column is dropped, no row is
-- deleted, and both Odoo id columns on `VariantStockRecord` become NULLABLE
-- rather than being removed:
--
--   * ADDITIVE — the three new tables and three new enum types are new objects.
--     The deployed image neither reads nor writes them, so it keeps working
--     against this schema for the window between `migrate deploy` and the new
--     container taking traffic.
--   * WIDENING — `odooLocationId` (Int NOT NULL) and `odooDatabase`
--     (TEXT NOT NULL) become nullable. A NOT NULL constraint that is relaxed
--     cannot break a reader: every existing row keeps its value.
--
-- THE ODOO IDS ARE KEPT, NOT DISCARDED. `odooLocationId`, `odooOwnerId` and
-- `odooDatabase` remain on the row as historical metadata recording where the
-- record came from. Nothing reads them to make a decision. That is the owner's
-- instruction — preserve old Odoo IDs as history — and it is why this migration
-- does not transfer them into comments or a side table: a record that can still
-- name its origin is a record that can be explained.
--
-- NOTHING IS BACKFILLED HERE. The existing rows are migrated by the application
-- (`app/services/inventoryMigration.server.ts`), in a transaction that also
-- records the counts it saw and wrote, because the migration has to reconcile
-- and can only do that where it can compare a before and an after. A SQL-only
-- backfill would have moved the data without leaving the evidence that it
-- moved correctly, which is the part that matters when a figure disagrees
-- later.
--
-- NO `locationId` IS GUESSED. The column is nullable on purpose. A stock row
-- that cannot be attributed to an app-owned dock is reported by the migration
-- rather than assigned to the default one, because attributing goods to the
-- wrong building is how a parcel is collected from a door nobody updated.

-- ---------------------------------------------------------------------------
-- 1. The new enum types.
-- ---------------------------------------------------------------------------

CREATE TYPE "StockMovementReason" AS ENUM (
  'MIGRATION_BASELINE',
  'RECEIPT',
  'ADJUSTMENT',
  'FULFILMENT',
  'CUSTOMER_RETURN',
  'VOID_CORRECTION'
);

CREATE TYPE "ReservationStatus" AS ENUM ('HELD', 'RELEASED', 'FULFILLED');

CREATE TYPE "MigrationStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETE', 'INCOMPLETE', 'FAILED');

-- ---------------------------------------------------------------------------
-- 2. `VariantStockRecord` becomes app-owned.
--
-- The Odoo keys are relaxed to nullable and two app-owned columns are added.
-- The unique index is replaced: it used to bind (variant, odooLocationId,
-- odooOwnerId), which after this change would bind two NULLable columns and
-- therefore stop binding anything for a migrated row. The replacement binds the
-- app-owned pair.
-- ---------------------------------------------------------------------------

ALTER TABLE "VariantStockRecord"
  ALTER COLUMN "odooLocationId" DROP NOT NULL,
  ALTER COLUMN "odooDatabase" DROP NOT NULL;

ALTER TABLE "VariantStockRecord"
  ADD COLUMN "locationId" TEXT,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'APP';

-- Existing rows predate the app-owned model, so they are what came out of the
-- Odoo mirror. Labelling them here is a statement of fact about where they came
-- from, not a decision the application made; the migration re-labels the rows it
-- actually converts.
UPDATE "VariantStockRecord" SET "source" = 'ODOO' WHERE "source" = 'APP';

-- The old index cannot survive the widening: it would allow duplicates among
-- the NULL rows it can no longer distinguish.
DROP INDEX IF EXISTS "VariantStockRecord_variantId_odooLocationId_odooOwnerId_key";

CREATE UNIQUE INDEX "VariantStockRecord_variantId_locationId_ownerName_key"
  ON "VariantStockRecord" ("variantId", "locationId", "ownerName");
CREATE INDEX "VariantStockRecord_locationId_idx"
  ON "VariantStockRecord" ("locationId");

ALTER TABLE "VariantStockRecord"
  ADD CONSTRAINT "VariantStockRecord_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "PickupLocation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. The movement ledger. Append-only by convention and by the application;
--    there is no trigger, because unlike AuditLog these rows belong to a
--    variant and must be removable when the variant is.
-- ---------------------------------------------------------------------------

CREATE TABLE "StockMovement" (
  "id"             TEXT NOT NULL,
  "variantId"      TEXT NOT NULL,
  "delta"          INTEGER NOT NULL,
  "reason"         "StockMovementReason" NOT NULL,
  "refType"        TEXT,
  "refId"          TEXT,
  "note"           TEXT,
  "balanceAfter"   INTEGER NOT NULL,
  "actorType"      "ActorType" NOT NULL DEFAULT 'SYSTEM',
  "actorId"        TEXT,
  "actorName"      TEXT,
  "idempotencyKey" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockMovement_idempotencyKey_key"
  ON "StockMovement" ("idempotencyKey");
CREATE INDEX "StockMovement_variantId_createdAt_idx"
  ON "StockMovement" ("variantId", "createdAt");
CREATE INDEX "StockMovement_refType_refId_idx"
  ON "StockMovement" ("refType", "refId");
CREATE INDEX "StockMovement_reason_idx"
  ON "StockMovement" ("reason");

ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Holds. One row per shipment and variant, which is what makes releasing a
--    cancelled shipment release exactly what that shipment held.
-- ---------------------------------------------------------------------------

CREATE TABLE "StockReservation" (
  "id"             TEXT NOT NULL,
  "variantId"      TEXT NOT NULL,
  "quantity"       INTEGER NOT NULL,
  "status"         "ReservationStatus" NOT NULL DEFAULT 'HELD',
  "shipmentId"     TEXT,
  "orderId"        TEXT,
  "note"           TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "settledAt"      TIMESTAMP(3),

  CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockReservation_idempotencyKey_key"
  ON "StockReservation" ("idempotencyKey");
CREATE INDEX "StockReservation_variantId_status_idx"
  ON "StockReservation" ("variantId", "status");
CREATE INDEX "StockReservation_shipmentId_idx"
  ON "StockReservation" ("shipmentId");
CREATE INDEX "StockReservation_orderId_idx"
  ON "StockReservation" ("orderId");
CREATE INDEX "StockReservation_status_idx"
  ON "StockReservation" ("status");

ALTER TABLE "StockReservation"
  ADD CONSTRAINT "StockReservation_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. The migration record the booking and catalogue gates read.
-- ---------------------------------------------------------------------------

CREATE TABLE "StockMigration" (
  "id"                   TEXT NOT NULL,
  "key"                  TEXT NOT NULL,
  "status"               "MigrationStatus" NOT NULL DEFAULT 'PENDING',
  "variantsSeen"         INTEGER NOT NULL DEFAULT 0,
  "variantsMigrated"     INTEGER NOT NULL DEFAULT 0,
  "stockRecordsSeen"     INTEGER NOT NULL DEFAULT 0,
  "stockRecordsMigrated" INTEGER NOT NULL DEFAULT 0,
  "locationsSeen"        INTEGER NOT NULL DEFAULT 0,
  "locationsMigrated"    INTEGER NOT NULL DEFAULT 0,
  "movementsWritten"     INTEGER NOT NULL DEFAULT 0,
  "problems"             TEXT NOT NULL DEFAULT '[]',
  "startedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"          TIMESTAMP(3),
  "reconciledAt"         TIMESTAMP(3),
  "reconciledBy"         TEXT,
  "notes"                TEXT,

  CONSTRAINT "StockMigration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StockMigration_key_key" ON "StockMigration" ("key");
CREATE INDEX "StockMigration_status_idx" ON "StockMigration" ("status");
