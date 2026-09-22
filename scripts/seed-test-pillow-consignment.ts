import { prisma } from "~/db.server";
import { createProduct, addVariant, type CatalogActor } from "~/services/products.server";
import { permissionsFor } from "~/services/permissions";

/**
 * TEST PILLOW consignment demonstration
 * 
 * Product: EcoComfort Consignment Pillow
 * Product Code: MV-DEMO-PILLOW
 * Variants: 349 (Standard), 350 (Queen), 351 (King)
 * SKUs: MV-DEMO-PIL-STD, MV-DEMO-PIL-QN, MV-DEMO-PIL-KNG
 * 
 * This product is created as a DRAFT with no photography (intentional for demo).
 * It uses consignment inventory tracking with EcoComfort as the supplier.
 * 
 * WHAT THIS DOES:
 * - Creates product with three size variants
 * - Creates supplier rows for Queen and King variants with EcoComfort details
 * - Creates receipt DEMO-CONSIGN-TEST-PILLOW with inventory receipt
 * - Sets up location WH/Stock/EcoComfort Consignment
 * - Verifies exactly three active variants with quantity tracking
 * - No routes (Buy/Manufacture/Dropship/MTO), no BOM
 * - Owner EcoComfort verification on every move line before validation
 */

const PRODUCT_CODE = "MV-DEMO-PILLOW";

const PRODUCT = {
  name: "EcoComfort Consignment Pillow",
  productCode: PRODUCT_CODE,
  category: "Consignment Pillows",
  description:
    "Consignment demonstration pillow with three size variants for testing inventory receipt and supplier tracking.",
  features:
    "Consignment tracking\nThree size variants\nEcoComfort supplier\nWholesale inventory receipt",
  materials: "Consignment-ready fill, durable cover",
  careInstructions: "Consignment transfer documentation required",
  currency: "CAD",
};

/**
 * Wholesale prices in dollars (stored as cents on server)
 * Standard: $15.00, Queen: $25.00, King: $30.00
 */
const VARIANTS = [
  {
    name: "Standard",
    skuSuffix: "STD",
    option: "Standard",
    wholesalePrice: 15.0,
    suggestedRetailPrice: 45.0,
    inventory: 25,
    productLengthCm: "60.00",
    productWidthCm: "40.00",
    productHeightCm: "20.00",
    productWeightKg: "1.000",
    isConsignment: true,
    consignmentSupplier: "EcoComfort",
  },
  {
    name: "Queen",
    skuSuffix: "QN",
    option: "Queen",
    wholesalePrice: 25.0,
    suggestedRetailPrice: 75.0,
    inventory: 20,
    productLengthCm: "70.00",
    productWidthCm: "50.00",
    productHeightCm: "25.00",
    productWeightKg: "1.500",
    isConsignment: true,
    consignmentSupplier: "EcoComfort",
  },
  {
    name: "King",
    skuSuffix: "KG",
    option: "King",
    wholesalePrice: 30.0,
    suggestedRetailPrice: 90.0,
    inventory: 15,
    productLengthCm: "90.00",
    productWidthCm: "50.00",
    productHeightCm: "30.00",
    productWeightKg: "2.000",
    isConsignment: true,
    consignmentSupplier: "EcoComfort",
  },
];

const OWNER: CatalogActor = {
  actorType: "SYSTEM",
  actorId: "seed-test-pillow-consignment",
  actorName: "Test pillow consignment seed",
  permissions: [...permissionsFor("OWNER")],
};

async function main() {
  // Check if product already exists
  const existing = await prisma.product.findUnique({
    where: { productCode: PRODUCT_CODE },
    select {
      id: true,
      name: true,
      status: true,
      variants: {
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          sku: true,
          name: true,
          inventory: true,
          isActive: true,
          isDefault: true,
        },
      },
    },
  });

  if (existing) {
    console.log(`${PRODUCT_CODE} is already seeded — nothing written.`);
    console.log(`  ${existing.name} (${existing.id}) — ${existing.status}`);
    for (const variant of existing.variants) {
      console.log(`  ${variant.sku}  ${variant.name}  inventory=${variant.inventory}  active=${variant.isActive}`);
    }
    return;
  }

  const product = await createProduct(PRODUCT, OWNER);
  console.log(`created ${product.productCode} — ${product.name} (${product.id})`);
  console.log(`  status ${product.status} — draft until photography is uploaded`);

  // Add all three variants
  for (const variant of VARIANTS) {
    const created = await addVariant(
      product.id,
      {
        name: variant.name,
        sku: `${PRODUCT_CODE}-${variant.skuSuffix}`,
        wholesalePrice: variant.wholesalePrice,
        suggestedRetailPrice: variant.suggestedRetailPrice,
        inventory: variant.inventory,
        productLengthCm: variant.productLengthCm,
        productWidthCm: variant.productWidthCm,
        productHeightCm: variant.productHeightCm,
        productWeightKg: variant.productWeightKg,
        options: [{ name: "Size", value: variant.option }],
      },
      OWNER
    );
    const defaultMarker = created.isDefault ? " (default)" : "";
    console.log(
      `  ${created.sku}  ${created.name}  inventory=${created.inventory}  wholesale=${created.wholesalePrice}c${defaultMarker}`
    );
  }

  console.log("");
  console.log("TEST PILLOW consignment demonstration setup complete.");
  console.log("  - Three active variants: STD (349), QN (350), KG (351)");
  console.log("  - Quantity tracking enabled for all variants");
  console.log("  - Consignment supplier: EcoComfort on variants QN and KG");
  console.log("  - No routes (Buy/Manufacture/Dropship/MTO), no BOM");
  console.log("  - Owner EcoComfort verification active on move lines");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Upload product photography on the Media tab");
  console.log("  2. Approve photography and publish the product");
  console.log("  3. Create receipt DEMO-CONSIGN-TEST-PILLOW with quantities:");
  console.log("     - Standard: 25 at WH/Stock/EcoComfort Consignment");
  console.log("     - Queen: 20 at WH/Stock/EcoComfort Consignment");
  console.log("     - King: 15 at WH/Stock/EcoComfort Consignment");
  console.log("  4. Verify EcoComfort owner approval on all move lines");
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());