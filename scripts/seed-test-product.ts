/**
 * The controlled test product for the product/variant/media/document/marketing
 * system: MoonVella Premium Cooling Pillow, MV-COOL-PILLOW, in three sizes.
 *
 * WHY IT GOES THROUGH THE SERVICES. Every write here calls the same functions
 * the admin screens call — `createProduct` and `addVariant` — rather than
 * inserting rows with Prisma. That is deliberate: the product code is
 * normalised by the same function, the SKUs are upper-cased by the same
 * function, money is validated as dollars and stored as cents by the same
 * function, measurements are parsed into exact decimals by the same function,
 * the first variant is made the default by the same function, and each write
 * leaves the same audit row it would leave had a person done it. A seed that
 * writes rows directly proves only that Postgres accepts inserts.
 *
 * WHY IT STAYS A DRAFT. Publishing is gated on a product having approved,
 * seller-visible photography with alt text, and there is no such photograph in
 * this repository — inventing one would put a fabricated product image in front
 * of sellers. So the product is created complete in every respect that can be
 * true without media, and is published by a person once real photography is
 * uploaded. Re-running this script prints the existing product instead of
 * creating a second one.
 *
 * WHAT IT DOES NOT DO. It does not contact Odoo, Shopify, Stripe, Plaid or any
 * mail service, does not create orders, does not publish anything to a merchant
 * and stores no file. It writes to the MoonVella database and nothing else.
 */
import { prisma } from "~/db.server";
import { createProduct, addVariant, type CatalogActor } from "~/services/products.server";
import { permissionsFor } from "~/services/permissions";

/**
 * The product code is the directive's, and the variant codes follow the
 * convention the catalogue already uses: family code, then a size suffix.
 */
const PRODUCT_CODE = "MV-COOL-PILLOW";

const PRODUCT = {
  name: "MoonVella Premium Cooling Pillow",
  productCode: PRODUCT_CODE,
  category: "Pillows",
  description:
    "Phase-change cooling pillow that draws heat away from the head and neck, " +
    "with a breathable removable cover. Made for hot sleepers and warm rooms.",
  features:
    "Phase-change cooling gel layer\nBreathable removable cover, machine washable\n" +
    "Hypoallergenic fill\nRetains loft under weight",
  materials: "Cooling gel layer, brushed microfibre cover, hollow-fibre fill",
  careInstructions: "Remove cover and machine wash cold. Do not bleach. Tumble dry low.",
  currency: "CAD",
};

/**
 * Wholesale and suggested retail are stated in dollars, which is what the
 * service validates and what the admin form sends; they are stored as cents.
 * Sizes, weights and stock are the unpacked product, and the measurements are
 * the canonical centimetres and kilograms — the interface may show inches, the
 * database does not store them.
 */
const VARIANTS = [
  {
    name: "Standard",
    skuSuffix: "STD",
    option: "Standard",
    wholesalePrice: 18.99,
    suggestedRetailPrice: 69.0,
    inventory: 40,
    productLengthCm: "66.00",
    productWidthCm: "51.00",
    productHeightCm: "15.00",
    productWeightKg: "1.100",
  },
  {
    name: "Queen",
    skuSuffix: "QN",
    option: "Queen",
    wholesalePrice: 20.99,
    suggestedRetailPrice: 79.0,
    inventory: 36,
    productLengthCm: "76.00",
    productWidthCm: "51.00",
    productHeightCm: "15.00",
    productWeightKg: "1.250",
  },
  {
    name: "King",
    skuSuffix: "KG",
    option: "King",
    wholesalePrice: 22.99,
    suggestedRetailPrice: 89.0,
    inventory: 24,
    productLengthCm: "91.00",
    productWidthCm: "51.00",
    productHeightCm: "15.00",
    productWeightKg: "1.450",
  },
];

/**
 * The actor is the owner, resolved from the policy rather than asserted: the
 * permissions are whatever OWNER holds, so a permission this script does not
 * have is a permission the owner does not have either — and the seed fails
 * loudly here rather than quietly writing a record nobody could have created.
 */
const OWNER: CatalogActor = {
  actorType: "SYSTEM",
  actorId: "seed-test-product",
  actorName: "Test product seed",
  permissions: [...permissionsFor("OWNER")],
};

async function main() {
  const existing = await prisma.product.findUnique({
    where: { productCode: PRODUCT_CODE },
    select: {
      id: true,
      name: true,
      status: true,
      variants: { orderBy: { sortOrder: "asc" }, select: { sku: true, name: true } },
    },
  });

  if (existing) {
    console.log(`${PRODUCT_CODE} is already seeded — nothing written.`);
    console.log(`  ${existing.name} (${existing.id}) — ${existing.status}`);
    for (const variant of existing.variants) {
      console.log(`  ${variant.sku}  ${variant.name}`);
    }
    return;
  }

  const product = await createProduct(PRODUCT, OWNER);
  console.log(`created ${product.productCode} — ${product.name} (${product.id})`);
  console.log(`  status ${product.status} — a draft until real photography is uploaded`);

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
    // The first variant added becomes the default; printing it here makes the
    // rule visible rather than something to be discovered later in the editor.
    console.log(
      `  ${created.sku}  ${created.name}  ${created.isDefault ? "(default)" : ""}  ` +
        `${created.wholesalePrice}c wholesale / ${created.suggestedRetailPrice}c retail`
    );
  }

  console.log("");
  console.log("Next: upload the product photography on the Media tab, approve it, and");
  console.log("press Publish. Nothing is connected to Odoo or to a Shopify merchant.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
