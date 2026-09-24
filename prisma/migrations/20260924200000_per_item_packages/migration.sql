-- Each item has its own box.
--
-- Two changes, both additive, plus one repair of a contradiction that already
-- exists in the data.
--
-- 1. A package on an order can now belong to a SHIPMENT. Until now every
--    booking sent the whole order's package list to the carrier, so a split
--    order told the carrier about parcels that were not in the box being
--    booked — a price, a label and a customs declaration for goods that were
--    not there. The column is nullable and ON DELETE SET NULL: rows that were
--    never linked (everything that exists today) keep working, and unlinking
--    is a NULL rather than a lost parcel.
--
-- 2. NEW packaging rows default to "this box travels on its own". The old
--    default was the opposite — every new carton silently claimed it could be
--    merged with any other — which is the wrong default for the way this
--    catalogue ships.
--
--    SET DEFAULT changes what a future INSERT does when it does not name the
--    column. It does NOT touch a single existing row: every carton already
--    recorded keeps the flags it was saved with.
--
-- 3. THE CONTRADICTION, REPAIRED AND THEN MADE IMPOSSIBLE. A row that both
--    ships separately and may be consolidated says two opposite things: the
--    first tells the packer not to combine this box with anything, the second
--    invites exactly that. The pair was reachable — "ships separately" and
--    "may consolidate" were independent checkboxes and the second one was
--    checked by default — so rows in that state may already exist, and the
--    constraint below would refuse to install over them.
--
--    The repair keeps the STRONGER flag: a box that must travel alone is set
--    to travel alone, and only the "may be merged" permission is withdrawn.
--    Nothing is deleted, no measurement moves, and the row's meaning (one
--    item, its own box) is the one it already asserted. The notice below
--    reports how many rows this touched, so the deploy log says it out loud
--    rather than leaving a silent edit behind.
--
-- After that the combination is unrepresentable: the application refuses it on
-- every write path, and the CHECK refuses it to a hand-run UPDATE.

ALTER TABLE "OrderPackage" ADD COLUMN "shipmentId" TEXT;

DO $$
DECLARE
  fixed_variant INT;
  fixed_product INT;
BEGIN
  UPDATE "VariantPackage" SET "consolidatable" = false
   WHERE "shipsSeparately" = true AND "consolidatable" = true;
  GET DIAGNOSTICS fixed_variant = ROW_COUNT;

  UPDATE "ProductPackage" SET "consolidatable" = false
   WHERE "shipsSeparately" = true AND "consolidatable" = true;
  GET DIAGNOSTICS fixed_product = ROW_COUNT;

  RAISE NOTICE 'per_item_packages: resolved contradictory rows — % variant package(s), % product package(s) set to travel alone',
    fixed_variant, fixed_product;
END $$;

ALTER TABLE "VariantPackage" ALTER COLUMN "shipsSeparately" SET DEFAULT true;
ALTER TABLE "VariantPackage" ALTER COLUMN "consolidatable"  SET DEFAULT false;

ALTER TABLE "ProductPackage" ALTER COLUMN "shipsSeparately" SET DEFAULT true;
ALTER TABLE "ProductPackage" ALTER COLUMN "consolidatable"  SET DEFAULT false;

ALTER TABLE "VariantPackage"
  ADD CONSTRAINT "VariantPackage_not_contradictory"
  CHECK (NOT ("shipsSeparately" AND "consolidatable"));

ALTER TABLE "ProductPackage"
  ADD CONSTRAINT "ProductPackage_not_contradictory"
  CHECK (NOT ("shipsSeparately" AND "consolidatable"));

CREATE INDEX "OrderPackage_shipmentId_idx" ON "OrderPackage"("shipmentId");

ALTER TABLE "OrderPackage"
  ADD CONSTRAINT "OrderPackage_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
