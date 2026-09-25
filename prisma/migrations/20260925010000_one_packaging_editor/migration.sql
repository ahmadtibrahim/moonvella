-- ONE PACKAGING EDITOR PER SELLABLE CONFIGURATION — data migration, forward only.
--
-- THE RULE THIS ENFORCES. A product whose sellers choose between its variants
-- keeps its cartons on those variants: a queen pillow and a king pillow ship in
-- different boxes, and a single product-level box would have to be one of them
-- or a wrong average. A product sold as one thing — no option for a seller to
-- pick — keeps its cartons on the product, even though the database represents
-- it with one internal default variant underneath.
--
-- Before this migration the resolver read variant rows first and fell back to
-- product rows, for every product. Two editors were therefore live at once and
-- only one of them was visible on any given screen, so a carton typed into the
-- hidden one silently decided what a quote used. That is the state this file
-- removes: after it runs, exactly one of the two tables holds rows for any given
-- product, and it is the table the editor for that product draws.
--
-- NOTHING IS DELETED WITHOUT BEING COPIED FIRST, and no row that decides a
-- quote today stops deciding one. The two passes are:
--
--   1. SELECTABLE products (the definition below, and the same one
--      `productHasSelectableVariants` in app/services/packaging.server.ts uses —
--      the migration and the resolver disagreeing is the bug this closes).
--      Their product-level rows are copied onto every ACTIVE variant that has no
--      rows of its own, because those variants are the ones inheriting them
--      today, and only then are the product rows deleted. A variant that already
--      had rows keeps them: it was not inheriting, and the copy skips it.
--
--   2. SIMPLE products with variant rows. Exactly one variant carrying rows is
--      the shape that can be moved up without changing anything — those rows are
--      what a quote reads today, so they become the product's rows and every
--      variant row for that product is removed. TWO OR MORE variants carrying
--      rows CANNOT be collapsed faithfully: each quotes from its own cartons
--      today and one product-level row would quote all of them the same. That
--      case stops the migration with the product named, because the alternative
--      is silently requoting somebody's product.
--
-- The write path refuses the shapes this removes from the other side
-- (`assertOneEditor`), so a row cannot be recreated in the table the editor
-- stopped drawing.
--
-- REHEARSED AGAINST A COPY OF PRODUCTION BEFORE DEPLOY, with the row counts in
-- the NOTICE lines below read by hand. On the catalogue as it stood on
-- 2026-09-25 this migration moves nothing: the one product with packaging is
-- selectable, its three variants each carry their own rows, and there is not a
-- single ProductPackage row in the database.

-- ---------------------------------------------------------------------------
-- 0. The set of products whose sellers choose between variants.
-- ---------------------------------------------------------------------------
-- An ACTIVE variant carrying at least one option whose name and value are both
-- non-blank. A switched-off variant is not something a seller can pick, so a
-- product whose only option-bearing variant is inactive is a simple product for
-- this purpose; a variant with a blank option pair is not a choice either, which
-- is exactly how order intake decides what was selected.
CREATE TEMP TABLE "_selectable_products" ON COMMIT DROP AS
SELECT DISTINCT v."productId" AS "productId"
  FROM "ProductVariant" v
  JOIN "VariantOption" o ON o."variantId" = v."id"
 WHERE v."isActive" = true
   AND BTRIM(o."name") <> ''
   AND BTRIM(o."value") <> '';

-- ---------------------------------------------------------------------------
-- 1. Selectable products: product rows move down onto the variants that use them.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE "_moved_to_variants" ON COMMIT DROP AS
SELECT pp."id" AS "packageId", v."id" AS "variantId"
  FROM "ProductPackage" pp
  JOIN "ProductVariant" v
    ON v."productId" = pp."productId"
   AND v."isActive" = true
 WHERE pp."productId" IN (SELECT "productId" FROM "_selectable_products")
   AND NOT EXISTS (
     SELECT 1 FROM "VariantPackage" vp WHERE vp."variantId" = v."id"
   );

INSERT INTO "VariantPackage" (
  "id", "variantId", "label", "packageType", "presetId",
  "length", "width", "height", "dimensionUnit",
  "grossWeight", "weightUnit", "unitsPerPackage", "packagesPerUnit", "sortOrder",
  "description", "declaredValue", "shipsSeparately", "consolidatable",
  "createdAt", "updatedAt"
)
SELECT gen_random_uuid()::text, m."variantId", pp."label", pp."packageType", pp."presetId",
       pp."length", pp."width", pp."height", pp."dimensionUnit",
       pp."grossWeight", pp."weightUnit", pp."unitsPerPackage", pp."packagesPerUnit",
       pp."sortOrder",
       pp."description", pp."declaredValue", pp."shipsSeparately", pp."consolidatable",
       now(), now()
  FROM "_moved_to_variants" m
  JOIN "ProductPackage" pp ON pp."id" = m."packageId";

DELETE FROM "ProductPackage"
 WHERE "productId" IN (SELECT "productId" FROM "_selectable_products");

-- ---------------------------------------------------------------------------
-- 2. Simple products: one variant's rows move up to the product.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r          RECORD;
  carriers   INTEGER;
  moved      INTEGER := 0;
  discarded  INTEGER := 0;
BEGIN
  FOR r IN
    SELECT v."productId" AS "productId",
           COUNT(DISTINCT vp."variantId") AS "carriers"
      FROM "VariantPackage" vp
      JOIN "ProductVariant" v ON v."id" = vp."variantId"
     WHERE v."productId" NOT IN (SELECT "productId" FROM "_selectable_products")
     GROUP BY v."productId"
  LOOP
    carriers := r."carriers";

    IF carriers > 1 THEN
      RAISE EXCEPTION
        'Product % is not sold in selectable configurations but has % variants with their own packaging. '
        'Each one is quoted from its own cartons today, so collapsing them into one product-level row '
        'would requote the product. Merge them by hand (Shipping tab) before deploying this migration.',
        r."productId", carriers;
    END IF;

    -- The variant rows are what a quote reads today, so the product's own rows —
    -- unreadable from any variant that has its own — go first. Counted, because a
    -- silently discarded carton is the failure this whole file exists to avoid.
    SELECT COUNT(*) INTO discarded
      FROM "ProductPackage" WHERE "productId" = r."productId";
    DELETE FROM "ProductPackage" WHERE "productId" = r."productId";

    INSERT INTO "ProductPackage" (
      "id", "productId", "label", "packageType", "presetId",
      "length", "width", "height", "dimensionUnit",
      "grossWeight", "weightUnit", "unitsPerPackage", "packagesPerUnit", "sortOrder",
      "description", "declaredValue", "shipsSeparately", "consolidatable",
      "createdAt", "updatedAt"
    )
    SELECT gen_random_uuid()::text, r."productId", vp."label", vp."packageType", vp."presetId",
           vp."length", vp."width", vp."height", vp."dimensionUnit",
           vp."grossWeight", vp."weightUnit", vp."unitsPerPackage", vp."packagesPerUnit",
           vp."sortOrder",
           vp."description", vp."declaredValue", vp."shipsSeparately", vp."consolidatable",
           now(), now()
      FROM "VariantPackage" vp
      JOIN "ProductVariant" v ON v."id" = vp."variantId"
     WHERE v."productId" = r."productId";

    moved := moved + 1;
    RAISE NOTICE 'one-packaging-editor: simple product % — % carton(s) moved up, % shadowed product row(s) dropped',
      r."productId", carriers, discarded;
  END LOOP;

  RAISE NOTICE 'one-packaging-editor: % simple product(s) promoted to product-level packaging', moved;
END $$;

-- Every variant row belonging to a simple product goes, whether or not it was
-- moved: a surviving row would shadow the product rows just written, because the
-- resolver still reads variant rows first for a simple product (a shape it must
-- keep reading — see below).
DELETE FROM "VariantPackage"
 WHERE "variantId" IN (
   SELECT v."id"
     FROM "ProductVariant" v
    WHERE v."productId" NOT IN (SELECT "productId" FROM "_selectable_products")
 );

-- ---------------------------------------------------------------------------
-- 3. What must be true when this file finishes. Checked here rather than only
--    in the suite, because a migration that half-applied must not leave the
--    database in a state no editor can describe.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders INTEGER;
BEGIN
  SELECT COUNT(*) INTO offenders
    FROM "ProductPackage" pp
   WHERE pp."productId" IN (SELECT "productId" FROM "_selectable_products");
  IF offenders > 0 THEN
    RAISE EXCEPTION 'one-packaging-editor: % product-level row(s) survive on selectable products', offenders;
  END IF;

  SELECT COUNT(*) INTO offenders
    FROM "VariantPackage" vp
    JOIN "ProductVariant" v ON v."id" = vp."variantId"
   WHERE v."productId" NOT IN (SELECT "productId" FROM "_selectable_products");
  IF offenders > 0 THEN
    RAISE EXCEPTION 'one-packaging-editor: % variant-level row(s) survive on simple products', offenders;
  END IF;

  -- A selectable product must still have packaging for every variant that had it
  -- before. The copy above covers every active variant that had no rows; this
  -- asserts the result rather than trusting the statement that produced it.
  SELECT COUNT(*) INTO offenders
    FROM "ProductVariant" v
   WHERE v."productId" IN (SELECT "productId" FROM "_selectable_products")
     AND v."isActive" = true
     AND NOT EXISTS (SELECT 1 FROM "VariantPackage" vp WHERE vp."variantId" = v."id")
     AND EXISTS (
       SELECT 1 FROM "_moved_to_variants" m WHERE m."variantId" = v."id"
     );
  IF offenders > 0 THEN
    RAISE EXCEPTION 'one-packaging-editor: % variant(s) lost the cartons copied to them', offenders;
  END IF;

  RAISE NOTICE 'one-packaging-editor: % product row(s) copied down, % variant row(s) remaining in total',
    (SELECT COUNT(*) FROM "_moved_to_variants"),
    (SELECT COUNT(*) FROM "VariantPackage");
END $$;
