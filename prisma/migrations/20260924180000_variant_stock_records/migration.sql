-- Where a variant's stock actually is, and whose it is.
--
-- The catalogue sync used to count one consignment location for one consignment
-- owner, so a single number was enough: there was only ever one shelf and one
-- owner to describe. The sync now counts everything inside the configured
-- fulfillment warehouse, which can be several locations and several owners at
-- once — the company's own stock and each vendor's consignment stock side by
-- side. A total alone can no longer say what it is made of, so each record the
-- read returns is kept.
--
-- ADDITIVE ONLY. Nothing is dropped, rewritten or backfilled: the table starts
-- empty, and the next catalogue sync fills it from the same Odoo read that
-- produces the inventory figure it belongs to. A variant with no rows has no
-- recorded breakdown, which is true — not a zero, and not a claim about Odoo.
--
-- Ownership is `stock.quant.owner_id`, i.e. whose goods these are. It is
-- deliberately NOT the product's supplier: the supplier is who MoonVella buys
-- from, and this is who owns what is on the shelf.

CREATE TABLE "VariantStockRecord" (
  "id"               TEXT NOT NULL,
  "variantId"        TEXT NOT NULL,
  "odooLocationId"   INTEGER NOT NULL,
  "locationName"     TEXT NOT NULL,
  "odooOwnerId"      INTEGER,
  "ownerName"        TEXT,
  "quantity"         INTEGER NOT NULL,
  "reservedQuantity" INTEGER NOT NULL,
  "odooDatabase"     TEXT NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "VariantStockRecord_pkey" PRIMARY KEY ("id")
);

-- One row per location and owner. PostgreSQL treats NULLs as distinct, so this
-- binds the owned rows; company-owned rows (NULL owner) are kept single by the
-- sync replacing the whole set rather than appending to it.
CREATE UNIQUE INDEX "VariantStockRecord_variantId_odooLocationId_odooOwnerId_key"
  ON "VariantStockRecord"("variantId", "odooLocationId", "odooOwnerId");

CREATE INDEX "VariantStockRecord_variantId_idx" ON "VariantStockRecord"("variantId");

-- A stock record without its variant is not a record of anything.
ALTER TABLE "VariantStockRecord"
  ADD CONSTRAINT "VariantStockRecord_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
