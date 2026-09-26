-- THE SELLER'S OWN PRICE, PER SELLABLE UNIT.
--
-- WHY A NEW TABLE RATHER THAN A COLUMN ON SOMETHING THAT EXISTS.
--
-- A store listing needs one price per variant, and until now the only number a
-- seller could give it was `SellerProduct.customRetailPrice` — one value for the
-- whole family. A three-size product is three prices: a King and a Standard sold
-- at the same figure is a product the seller loses money on at one end and
-- cannot sell at the other. The remaining way to price a family apart was
-- `markupPercent`, applied to every variant at once, which cannot express "the
-- King is ten dollars more" either — it multiplies, so it moves the dearest
-- variant furthest, and it moves all of them away from the catalogue's suggested
-- retail rather than towards the seller's own figure. The owner's instruction is
-- that the suggested retail IS the listed price and that the seller may change
-- it, which leaves no room for a percentage of anything.
--
-- So the price is per variant. The two candidate columns both fail:
--
--   • `SellerProductVariant` is the MAPPING between a MoonVella variant and one
--     the store owns, and it cannot exist before an import — `shopifyVariantId`
--     is not known until the store answers. The seller prices a product on the
--     catalogue card and imports it afterwards, so a price there would be
--     unsettable at the exact moment it is needed. Making the store's variant id
--     nullable to allow a pre-import row would break the test that chooses
--     between creating and re-syncing, which is `variantMappings.length > 0`.
--
--   • `SellerProduct` is the family, and is the one-price-for-three-sizes problem
--     this table exists to solve.
--
-- A row here is therefore keyed on (seller, variant) and is deliberately
-- independent of whether the product has been imported. A price set before an
-- import is not an orphan; it is the number the import will read.
--
-- NAMED `SellerVariantPrice`, NOT `...Override`, because it is not an override
-- of the catalogue figure — it is the price, and the catalogue figure is only
-- what it starts from. `ProductVariant.suggestedRetailPrice` remains the
-- recommendation shown to every seller.
--
-- `retailPrice` IS NOT NULLABLE, unlike the column it replaces. Null meant "no
-- opinion" there and the catalogue figure was used; here the absence of a row
-- means exactly that, which is a state the table can express without a null. A
-- row therefore always carries a real price, and the action that writes one
-- refuses zero — see the note in `unpricedRetailVariants` for why a listed price
-- of zero is refused rather than defaulted away.
--
-- NO BACKFILL, DELIBERATELY. Copying the family's old `customRetailPrice` onto
-- every variant of that family would turn one price into three identical ones
-- and call it a decision the seller made. The family column stays and is still
-- read as the fallback for a variant with no row here, so every store that set a
-- price keeps the price it has.
--
-- ADDITIVE. A new table, no column dropped, no existing row rewritten, and a
-- rollback of the application leaves it unread.
CREATE TABLE "SellerVariantPrice" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "productVariantId" TEXT NOT NULL,
    "retailPrice" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerVariantPrice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SellerVariantPrice_sellerId_productVariantId_key"
  ON "SellerVariantPrice"("sellerId", "productVariantId");

CREATE INDEX "SellerVariantPrice_sellerId_idx" ON "SellerVariantPrice"("sellerId");
CREATE INDEX "SellerVariantPrice_productVariantId_idx" ON "SellerVariantPrice"("productVariantId");

ALTER TABLE "SellerVariantPrice"
  ADD CONSTRAINT "SellerVariantPrice_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SellerVariantPrice"
  ADD CONSTRAINT "SellerVariantPrice_productVariantId_fkey"
  FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
